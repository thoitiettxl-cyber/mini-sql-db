// Pager: fixed-size page file with an LRU page cache, free-page list,
// and per-transaction dirty-page tracking (clean images kept for abort).
// All durability goes through the WAL; the data file is only written
// at checkpoints (see wal.ts).
import { open, FileHandle } from 'node:fs/promises';

export const PAGE_SIZE = 4096;
const MAGIC = 'MINISQL!';
const MAX_CACHE_PAGES = 2048;

/** Minimal interface the B-tree needs from page storage. */
export interface PageStore {
  readonly pageSize: number;
  getPage(pageNo: number): Promise<Buffer>;
  dirty(pageNo: number): void;
  allocPage(): Promise<number>;
  freePage(pageNo: number): void;
}

export class Pager implements PageStore {
  readonly pageSize = PAGE_SIZE;
  pageCount = 0;
  freelistHead = 0;
  nextXid = 1n;
  readonly dirtySet = new Set<number>();
  readonly needsFlush = new Set<number>();
  private cleanImages = new Map<number, Buffer | null>();
  private cache = new Map<number, Buffer>();
  private fh: FileHandle;
  private path: string;

  private constructor(fh: FileHandle, path: string) {
    this.fh = fh;
    this.path = path;
  }

  static async open(path: string): Promise<Pager> {
    const fh = await open(path, 'a+');
    const p = new Pager(fh, path);
    const stat = await fh.stat();
    if (stat.size === 0) {
      // fresh database: page 0 = header, page 1 = catalog
      p.pageCount = 2;
      p.freelistHead = 0;
      p.nextXid = 1n;
      const h = Buffer.alloc(PAGE_SIZE);
      p.writeHeaderInto(h);
      const c = Buffer.alloc(PAGE_SIZE);
      p.cache.set(0, h);
      p.cache.set(1, c);
      await fh.write(h, 0, PAGE_SIZE, 0);
      await fh.write(c, 0, PAGE_SIZE, PAGE_SIZE);
      await fh.sync();
    } else {
      if (stat.size % PAGE_SIZE !== 0) throw new Error('database file size is not a multiple of page size');
      p.pageCount = Math.floor(stat.size / PAGE_SIZE);
      const h = Buffer.alloc(PAGE_SIZE);
      await fh.read(h, 0, PAGE_SIZE, 0);
      p.readHeaderFrom(h);
    }
    return p;
  }

  private writeHeaderInto(h: Buffer): void {
    h.write(MAGIC, 0, 8, 'ascii');
    h.writeUInt32BE(this.pageSize, 8);
    h.writeUInt32BE(this.pageCount, 12);
    h.writeUInt32BE(this.freelistHead, 16);
    h.writeBigUInt64BE(this.nextXid, 20);
    h.writeUInt32BE(1, 28); // catalog starts at page 1
  }

  private readHeaderFrom(h: Buffer): void {
    if (h.toString('ascii', 0, 8) !== MAGIC) throw new Error('not a mini-sql-db file (bad magic)');
    const ps = h.readUInt32BE(8);
    if (ps !== PAGE_SIZE) throw new Error('unsupported page size ' + ps);
    this.pageCount = h.readUInt32BE(12);
    this.freelistHead = h.readUInt32BE(16);
    this.nextXid = h.readBigUInt64BE(20);
  }

  private touchHeader(): void {
    const h = this.cache.get(0);
    if (h) this.writeHeaderInto(h);
    this.markDirty(0);
  }

  /** Get a page image (mutable cached copy). Never returns a dirty-evicted page. */
  async getPage(pageNo: number): Promise<Buffer> {
    if (pageNo < 0 || !Number.isInteger(pageNo)) throw new Error('bad page number ' + pageNo);
    let buf = this.cache.get(pageNo);
    if (buf) {
      // refresh LRU position
      this.cache.delete(pageNo);
      this.cache.set(pageNo, buf);
      return buf;
    }
    buf = Buffer.alloc(PAGE_SIZE);
    if (pageNo < this.pageCount) {
      const { bytesRead } = await this.fh.read(buf, 0, PAGE_SIZE, pageNo * PAGE_SIZE);
      if (bytesRead !== PAGE_SIZE) throw new Error('short read on page ' + pageNo);
    }
    this.cache.set(pageNo, buf);
    this.evictIfNeeded();
    return buf;
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHE_PAGES) {
      const oldest = this.cache.keys().next().value as number;
      if (this.dirtySet.has(oldest)) {
        // move dirty pages to the back; give up if everything is dirty
        const b = this.cache.get(oldest)!;
        this.cache.delete(oldest);
        this.cache.set(oldest, b);
        break;
      }
      this.cache.delete(oldest);
    }
  }

  /** Mark a page dirty in the current write txn (snapshots the clean image once). */
  dirty(pageNo: number): void {
    this.markDirty(pageNo);
  }

  markDirty(pageNo: number): void {
    if (this.dirtySet.has(pageNo)) return;
    this.dirtySet.add(pageNo);
    if (!this.cleanImages.has(pageNo)) {
      const cur = this.cache.get(pageNo);
      this.cleanImages.set(pageNo, cur ? Buffer.from(cur) : null);
    }
  }

  /** Allocate a page: reuse from freelist or extend the file. Returns zeroed page. */
  async allocPage(): Promise<number> {
    let pageNo: number;
    if (this.freelistHead !== 0) {
      pageNo = this.freelistHead;
      const pg = await this.getPage(pageNo);
      this.markDirty(pageNo);
      this.freelistHead = pg.readUInt32BE(0);
      pg.fill(0);
    } else {
      pageNo = this.pageCount;
      this.pageCount++;
      const pg = Buffer.alloc(PAGE_SIZE);
      this.cache.set(pageNo, pg);
      this.markDirty(pageNo);
    }
    this.touchHeader();
    return pageNo;
  }

  /** Return a page to the freelist. */
  async freePage(pageNo: number): Promise<void> {
    if (pageNo <= 1) throw new Error('cannot free page ' + pageNo);
    const pg = await this.getPage(pageNo);
    this.markDirty(pageNo);
    pg.fill(0);
    pg.writeUInt32BE(this.freelistHead, 0);
    this.freelistHead = pageNo;
    this.touchHeader();
  }

  /** Write page images straight to the data file (checkpoint path). */
  async writePages(pages: Map<number, Buffer>): Promise<void> {
    for (const [pageNo, buf] of pages) {
      await this.fh.write(buf, 0, PAGE_SIZE, pageNo * PAGE_SIZE);
    }
  }

  async sync(): Promise<void> {
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  /** Called after a txn commits (its dirty pages were WAL-logged). */
  afterCommit(): void {
    for (const pg of this.dirtySet) this.needsFlush.add(pg);
    this.dirtySet.clear();
    this.cleanImages.clear();
  }

  /** Called after a txn aborts: roll back dirty pages to their clean images. */
  afterAbort(): void {
    const keepXid = this.nextXid;
    for (const [pg, img] of this.cleanImages) {
      if (img) this.cache.set(pg, img);
      else this.cache.delete(pg);
    }
    this.dirtySet.clear();
    this.cleanImages.clear();
    const h = this.cache.get(0);
    if (h) this.readHeaderFrom(h);
    if (this.nextXid < keepXid) this.nextXid = keepXid; // never reuse xids
  }

  /** Images of all pages that need flushing at checkpoint. */
  flushImages(): Map<number, Buffer> {
    const out = new Map<number, Buffer>();
    for (const pg of this.needsFlush) {
      const buf = this.cache.get(pg);
      if (buf) out.set(pg, buf);
    }
    return out;
  }

  clearNeedsFlush(): void {
    this.needsFlush.clear();
  }
}
