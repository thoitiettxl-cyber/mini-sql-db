// Write-ahead log with physical page images.
//
// Protocol (single writer):
//   - txn writes mutate cached pages; pager tracks the dirty set.
//   - commit: append PAGE records (full image per dirty page) + COMMIT, fsync.
//   - abort: dirty pages are rolled back from clean images; nothing is logged.
//   - checkpoint (only when no write txn is active): flush dirty pages to the
//     data file, fsync, append CHECKPOINT, fsync, truncate the WAL.
// Recovery replays PAGE records of committed txns after the last checkpoint.
//
// Record framing: [u32 len][u64 lsn][u64 txnId][u8 type][payload][u32 crc32]
// len covers everything after itself. crc covers lsn..payload.
import { open, FileHandle } from 'node:fs/promises';
import { crc32 } from './value.js';

export const enum WalType {
  Begin = 1,
  Page = 2,
  Commit = 3,
  Abort = 4,
  Checkpoint = 5,
}

export interface WalRecord {
  lsn: bigint;
  txnId: bigint;
  type: WalType;
  pageNo: number;
  image: Buffer | null;
}

const WAL_MAGIC = 'MINIWAL1';
const HEADER_LEN = 64;

export class Wal {
  private fh: FileHandle;
  private path: string;
  private pageSize: number;
  nextLsn = 1n;
  checkpointLsn = 0n;

  private constructor(fh: FileHandle, path: string, pageSize: number) {
    this.fh = fh;
    this.path = path;
    this.pageSize = pageSize;
  }

  static async open(path: string, pageSize: number): Promise<Wal> {
    const fh = await open(path, 'a+');
    const w = new Wal(fh, path, pageSize);
    const stat = await fh.stat();
    if (stat.size === 0) {
      await w.writeHeader();
      await fh.sync();
    } else {
      const h = Buffer.alloc(HEADER_LEN);
      await fh.read(h, 0, HEADER_LEN, 0);
      if (h.toString('ascii', 0, 8) !== WAL_MAGIC) throw new Error('bad WAL magic');
      w.checkpointLsn = h.readBigUInt64BE(16);
      w.nextLsn = h.readBigUInt64BE(24);
      if (w.nextLsn < 1n) w.nextLsn = 1n;
    }
    return w;
  }

  private async writeHeader(): Promise<void> {
    const h = Buffer.alloc(HEADER_LEN);
    h.write(WAL_MAGIC, 0, 8, 'ascii');
    h.writeUInt32BE(this.pageSize, 8);
    h.writeBigUInt64BE(this.checkpointLsn, 16);
    h.writeBigUInt64BE(this.nextLsn, 24);
    await this.fh.write(h, 0, HEADER_LEN, 0);
  }

  private encodeRecord(txnId: bigint, type: WalType, payload: Buffer): Buffer {
    const lsn = this.nextLsn++;
    const bodyLen = 8 + 8 + 1 + payload.length;
    const rec = Buffer.alloc(4 + bodyLen + 4);
    rec.writeUInt32BE(bodyLen, 0);
    rec.writeBigUInt64BE(lsn, 4);
    rec.writeBigUInt64BE(txnId, 12);
    rec.writeUInt8(type, 20);
    payload.copy(rec, 21);
    rec.writeUInt32BE(crc32(rec, 4, 21 + payload.length), 21 + payload.length);
    return rec;
  }

  private async appendRaw(rec: Buffer): Promise<void> {
    const stat = await this.fh.stat();
    await this.fh.write(rec, 0, rec.length, stat.size);
  }

  async appendBegin(txnId: bigint): Promise<void> {
    await this.appendRaw(this.encodeRecord(txnId, WalType.Begin, Buffer.alloc(0)));
  }

  async appendPage(txnId: bigint, pageNo: number, image: Buffer): Promise<void> {
    const payload = Buffer.alloc(4 + image.length);
    payload.writeUInt32BE(pageNo, 0);
    image.copy(payload, 4);
    await this.appendRaw(this.encodeRecord(txnId, WalType.Page, payload));
  }

  async appendCommit(txnId: bigint): Promise<void> {
    await this.appendRaw(this.encodeRecord(txnId, WalType.Commit, Buffer.alloc(0)));
    await this.fh.sync();
  }

  async appendAbort(txnId: bigint): Promise<void> {
    await this.appendRaw(this.encodeRecord(txnId, WalType.Abort, Buffer.alloc(0)));
  }

  async sync(): Promise<void> {
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  /** Iterate records with lsn > afterLsn. Stops at the first torn/corrupt record. */
  async *readRecords(afterLsn: bigint): AsyncGenerator<WalRecord> {
    const stat = await this.fh.stat();
    let off = HEADER_LEN;
    const size = stat.size;
    while (off + 4 <= size) {
      const lenBuf = Buffer.alloc(4);
      const r1 = await this.fh.read(lenBuf, 0, 4, off);
      if (r1.bytesRead < 4) break;
      const bodyLen = lenBuf.readUInt32BE(0);
      if (bodyLen > 64 * 1024 * 1024 || off + 4 + bodyLen + 4 > size) break; // torn tail
      const rec = Buffer.alloc(4 + bodyLen + 4);
      lenBuf.copy(rec, 0);
      const r2 = await this.fh.read(rec, 4, bodyLen + 4, off + 4);
      if (r2.bytesRead < bodyLen + 4) break;
      const crc = rec.readUInt32BE(4 + bodyLen);
      if (crc32(rec, 4, 4 + bodyLen) !== crc) break; // torn write: stop
      const lsn = rec.readBigUInt64BE(4);
      const txnId = rec.readBigUInt64BE(12);
      const type = rec.readUInt8(20) as WalType;
      let pageNo = 0;
      let image: Buffer | null = null;
      if (type === WalType.Page) {
        pageNo = rec.readUInt32BE(21);
        image = Buffer.from(rec.subarray(25, 4 + bodyLen));
      }
      off += 4 + bodyLen + 4;
      if (lsn > afterLsn) yield { lsn, txnId, type, pageNo, image };
    }
  }

  /**
   * Redo recovery: replay committed txns' page images after the checkpoint.
   * Returns the set of page images to apply (pageNo -> image).
   */
  async recover(): Promise<Map<number, Buffer>> {
    const committed = new Set<bigint>();
    const txnPages = new Map<bigint, { lsn: bigint; pageNo: number; image: Buffer }[]>();
    for await (const rec of this.readRecords(this.checkpointLsn)) {
      if (rec.type === WalType.Begin) {
        if (!txnPages.has(rec.txnId)) txnPages.set(rec.txnId, []);
      } else if (rec.type === WalType.Page && rec.image) {
        let arr = txnPages.get(rec.txnId);
        if (!arr) { arr = []; txnPages.set(rec.txnId, arr); }
        arr.push({ lsn: rec.lsn, pageNo: rec.pageNo, image: rec.image });
      } else if (rec.type === WalType.Commit) {
        committed.add(rec.txnId);
      }
    }
    // apply in global LSN order
    const all: { lsn: bigint; pageNo: number; image: Buffer }[] = [];
    for (const txnId of committed) all.push(...(txnPages.get(txnId) || []));
    all.sort((a, b) => (a.lsn < b.lsn ? -1 : a.lsn > b.lsn ? 1 : 0));
    const out = new Map<number, Buffer>();
    for (const p of all) out.set(p.pageNo, p.image);
    return out;
  }

  /** Write a checkpoint record, fsync, then truncate the log. */
  async checkpoint(): Promise<void> {
    this.checkpointLsn = this.nextLsn;
    const rec = this.encodeRecord(0n, WalType.Checkpoint, Buffer.alloc(0));
    await this.appendRaw(rec);
    await this.fh.sync();
    await this.fh.truncate(0);
    this.nextLsn = this.checkpointLsn;
    await this.writeHeader();
    await this.fh.sync();
  }
}
