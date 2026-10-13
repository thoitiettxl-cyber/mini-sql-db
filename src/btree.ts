// B+tree on disk pages (via the PageStore interface).
//
// Page layout (PAGE_SIZE bytes):
//   0:     u8  flags (bit0 = 1 => leaf)
//   1:     u16 number of cells
//   3:     u32 parent page (0 = none/root)
//   7:     u32 right pointer (internal: rightmost child; leaf: next leaf, 0=none)
//   11:    u16 content area start (cells grow downward from end of page)
//   13..15: reserved
//   16..:  u16 cell offsets, one per cell, sorted by key
// Leaf cell:     [u16 keyLen][u16 valLen][key][value]
// Internal cell: [u16 keyLen][u32 child][key]
//
// Internal separator convention: cell i = (k_i, c_i); c_0 holds keys < k_0,
// c_i holds keys in [k_{i-1}, k_i), right pointer holds keys >= k_{n-1}.
import type { PageStore } from './pager.js';

export interface ScanBound {
  key: Buffer;
  inclusive: boolean;
}

export interface ScanOpts {
  from?: ScanBound | null;
  to?: ScanBound | null;
}

const HDR_SIZE = 16;
const LEAF_FLAG = 1;

function isLeaf(p: Buffer): boolean {
  return (p[0] & LEAF_FLAG) !== 0;
}
function numCells(p: Buffer): number {
  return p.readUInt16BE(1);
}
function setNumCells(p: Buffer, n: number): void {
  p.writeUInt16BE(n, 1);
}
function parent(p: Buffer): number {
  return p.readUInt32BE(3);
}
function setParent(p: Buffer, pg: number): void {
  p.writeUInt32BE(pg, 3);
}
function rightPtr(p: Buffer): number {
  return p.readUInt32BE(7);
}
function setRightPtr(p: Buffer, pg: number): void {
  p.writeUInt32BE(pg, 7);
}
function contentStart(p: Buffer): number {
  return p.readUInt16BE(11);
}
function setContentStart(p: Buffer, off: number): void {
  p.writeUInt16BE(off, 11);
}
function cellOff(p: Buffer, i: number): number {
  return p.readUInt16BE(HDR_SIZE + i * 2);
}
function setCellOff(p: Buffer, i: number, off: number): void {
  p.writeUInt16BE(off, HDR_SIZE + i * 2);
}

interface LeafCell {
  key: Buffer;
  value: Buffer;
  off: number;
  total: number;
}
interface InternalCell {
  key: Buffer;
  child: number;
  off: number;
  total: number;
}

function readLeafCell(p: Buffer, i: number): LeafCell {
  const off = cellOff(p, i);
  const keyLen = p.readUInt16BE(off);
  const valLen = p.readUInt16BE(off + 2);
  return {
    key: p.subarray(off + 4, off + 4 + keyLen),
    value: p.subarray(off + 4 + keyLen, off + 4 + keyLen + valLen),
    off,
    total: 4 + keyLen + valLen,
  };
}

function readInternalCell(p: Buffer, i: number): InternalCell {
  const off = cellOff(p, i);
  const keyLen = p.readUInt16BE(off);
  const child = p.readUInt32BE(off + 2);
  return {
    key: p.subarray(off + 6, off + 6 + keyLen),
    child,
    off,
    total: 6 + keyLen,
  };
}

function cmpKey(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

export class BTree {
  /** Current root page; may change on splits (caller persists it). */
  root: number;
  constructor(private store: PageStore, root: number) {
    this.root = root;
  }

  /** Create a new empty B-tree; returns the tree (root page allocated). */
  static async create(store: PageStore): Promise<BTree> {
    const root = await store.allocPage();
    const p = await store.getPage(root);
    p.fill(0);
    p[0] = LEAF_FLAG;
    setNumCells(p, 0);
    setContentStart(p, store.pageSize);
    store.dirty(root);
    return new BTree(store, root);
  }

  private async load(pageNo: number): Promise<Buffer> {
    return this.store.getPage(pageNo);
  }

  /** Binary search: first index with cell.key >= key (leaf) or > key (internal). */
  private searchLeaf(p: Buffer, key: Buffer): number {
    let lo = 0;
    let hi = numCells(p);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = readLeafCell(p, mid);
      if (cmpKey(c.key, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private searchInternal(p: Buffer, key: Buffer): number {
    // first index with cell.key > key
    let lo = 0;
    let hi = numCells(p);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = readInternalCell(p, mid);
      if (cmpKey(c.key, key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Walk from root to the leaf that should contain key. */
  private async findLeaf(key: Buffer): Promise<{ page: Buffer; pageNo: number }> {
    let pageNo = this.root;
    for (;;) {
      const p = await this.load(pageNo);
      if (isLeaf(p)) return { page: p, pageNo };
      const idx = this.searchInternal(p, key);
      if (idx === 0) pageNo = readInternalCell(p, 0).child;
      else if (idx < numCells(p)) pageNo = readInternalCell(p, idx).child;
      else pageNo = rightPtr(p);
    }
  }

  async get(key: Buffer): Promise<Buffer | null> {
    const { page } = await this.findLeaf(key);
    const idx = this.searchLeaf(page, key);
    if (idx < numCells(page)) {
      const c = readLeafCell(page, idx);
      if (cmpKey(c.key, key) === 0) return Buffer.from(c.value);
    }
    return null;
  }

  /** Insert or replace. Simple delete+insert for replacements. */
  async put(key: Buffer, value: Buffer): Promise<void> {
    const existing = await this.get(key);
    if (existing) await this.delete(key);
    await this.insert(key, value);
  }

  private async insert(key: Buffer, value: Buffer): Promise<void> {
    const cellSize = 4 + key.length + value.length;
    if (cellSize + 2 > this.store.pageSize - HDR_SIZE) {
      throw new Error('key/value too large for a page');
    }
    let found = await this.findLeaf(key);
    this.store.dirty(found.pageNo);
    const n = numCells(found.page);
    if (contentStart(found.page) - cellSize < HDR_SIZE + (n + 1) * 2) {
      // Page is full: split first, then re-locate (the key may belong to
      // either half). A single cell always fits in an empty page, so the
      // split always frees enough space.
      await this.splitLeaf(found.page, found.pageNo);
      found = await this.findLeaf(key);
      this.store.dirty(found.pageNo);
    }
    this.insertIntoLeaf(found.page, found.pageNo, key, value);
  }

  private isOverfull(p: Buffer): boolean {
    return contentStart(p) < HDR_SIZE + numCells(p) * 2;
  }

  private insertIntoLeaf(page: Buffer, pageNo: number, key: Buffer, value: Buffer): void {
    const n = numCells(page);
    const idx = this.searchLeaf(page, key);
    const need = 4 + key.length + value.length + 2;
    let start = contentStart(page) - (4 + key.length + value.length);
    if (start < HDR_SIZE + (n + 1) * 2) {
      throw new Error('key/value too large for a page');
    }
    // shift cell pointers to make room at idx
    for (let i = n; i > idx; i--) setCellOff(page, i, cellOff(page, i - 1));
    setCellOff(page, idx, start);
    page.writeUInt16BE(key.length, start);
    page.writeUInt16BE(value.length, start + 2);
    key.copy(page, start + 4);
    value.copy(page, start + 4 + key.length);
    setNumCells(page, n + 1);
    setContentStart(page, start);
    this.store.dirty(pageNo);
    void need;
  }

  private async splitLeaf(page: Buffer, pageNo: number): Promise<void> {
    const n = numCells(page);
    // n==1: move the single cell to the new page (left page becomes empty).
    const mid = n === 1 ? 0 : Math.ceil(n / 2);
    const newPageNo = await this.store.allocPage();
    const np = await this.load(newPageNo);
    np.fill(0);
    np[0] = LEAF_FLAG;
    setParent(np, parent(page));
    setRightPtr(np, rightPtr(page));
    setRightPtr(page, newPageNo);
    // move upper half to the new page (copy: repackLeaf rewrites this buffer)
    const moved: LeafCell[] = [];
    for (let i = mid; i < n; i++) {
      const c = readLeafCell(page, i);
      moved.push({ key: Buffer.from(c.key), value: Buffer.from(c.value), off: 0, total: 0 });
    }
    setNumCells(page, mid);
    this.repackLeaf(page);
    setNumCells(np, 0);
    setContentStart(np, this.store.pageSize);
    for (const c of moved) this.appendLeafCell(np, c.key, c.value);
    this.store.dirty(pageNo);
    this.store.dirty(newPageNo);
    // promote copy of first key of new page
    const sepKey = Buffer.from(readLeafCell(np, 0).key);
    await this.insertIntoParent(pageNo, sepKey, newPageNo);
  }

  /** Rewrite a leaf's cells compactly (used after split/delete). */
  private repackLeaf(page: Buffer): void {
    const n = numCells(page);
    const cells: LeafCell[] = [];
    for (let i = 0; i < n; i++) {
      const c = readLeafCell(page, i);
      cells.push({ key: Buffer.from(c.key), value: Buffer.from(c.value), off: 0, total: 0 });
    }
    setNumCells(page, 0);
    setContentStart(page, this.store.pageSize);
    for (const c of cells) this.appendLeafCell(page, c.key, c.value);
  }

  private appendLeafCell(page: Buffer, key: Buffer, value: Buffer): void {
    const n = numCells(page);
    const start = contentStart(page) - (4 + key.length + value.length);
    setCellOff(page, n, start);
    page.writeUInt16BE(key.length, start);
    page.writeUInt16BE(value.length, start + 2);
    key.copy(page, start + 4);
    value.copy(page, start + 4 + key.length);
    setNumCells(page, n + 1);
    setContentStart(page, start);
  }

  private async insertIntoParent(leftNo: number, key: Buffer, rightNo: number): Promise<void> {
    const left = await this.load(leftNo);
    const parNo = parent(left);
    if (parNo === 0) {
      // split the root: new root with one separator
      const newRootNo = await this.store.allocPage();
      const nr = await this.load(newRootNo);
      nr.fill(0);
      setParent(nr, 0);
      setNumCells(nr, 0);
      setContentStart(nr, this.store.pageSize);
      this.appendInternalCell(nr, key, leftNo);
      setRightPtr(nr, rightNo);
      setParent(left, newRootNo);
      const rp = await this.load(rightNo);
      setParent(rp, newRootNo);
      this.store.dirty(newRootNo);
      this.store.dirty(leftNo);
      this.store.dirty(rightNo);
      this.root = newRootNo;
      return;
    }
    const par = await this.load(parNo);
    this.store.dirty(parNo);
    const n = numCells(par);
    const idx = this.searchInternal(par, key);
    // Net effect of the insertion below is exactly one extra cell.
    const need = 6 + key.length + 2;
    if (contentStart(par) - need < HDR_SIZE + (n + 1) * 2) {
      await this.splitInternal(par, parNo);
      await this.insertIntoParent(leftNo, key, rightNo);
      return;
    }
    // Rebuild the cell array: insert (key, leftNo) at idx and rewire the
    // following child to rightNo (separator convention: c_i covers
    // [k_{i-1}, k_i), right pointer covers >= k_{n-1}).
    await this.reinsertParentCell(par, parNo, idx, key, leftNo, rightNo);
    if (this.isOverfull(par)) await this.splitInternal(par, parNo);
  }

  /** Rebuild parent cells around an insertion (keeps separator semantics exact). */
  private async reinsertParentCell(
    par: Buffer, parNo: number, idx: number,
    key: Buffer, leftNo: number, rightNo: number,
  ): Promise<void> {
    const n = numCells(par);
    const cells: InternalCell[] = [];
    for (let i = 0; i < n; i++) {
      const c = readInternalCell(par, i);
      cells.push({ key: Buffer.from(c.key), child: c.child, off: 0, total: 0 });
    }
    const oldRight = rightPtr(par);
    // Build new sequence: for the split at idx, the child that followed the
    // insertion point (old cells[idx].child or oldRight) covered keys >= key.
    // After inserting leftNo/rightNo, order becomes:
    //   cells[0..idx-1], (key, leftNo), then a synthetic separator is NOT needed:
    //   rightNo becomes the child for [key, nextKey), i.e. it takes the place
    //   of old cells[idx].child, and old cells[idx].child shifts right.
    // Implementation: newCells = cells[0..idx-1] + (key,leftNo) + (cells[idx].key, rightNo) + cells[idx+1..]
    //   and if idx == n: right pointer becomes rightNo... wait no.
    const newCells: { key: Buffer; child: number }[] = [];
    let newRight = oldRight;
    for (let i = 0; i < idx; i++) newCells.push(cells[i]);
    newCells.push({ key: Buffer.from(key), child: leftNo });
    if (idx < n) {
      // old cells[idx] = (k_old, c_old): c_old covered [k_prev, k_old).
      // Now rightNo covers [key, k_old): insert (k_old, rightNo).
      newCells.push({ key: cells[idx].key, child: rightNo });
      for (let i = idx + 1; i < n; i++) newCells.push(cells[i]);
    } else {
      // insertion at the end: oldRight covered [k_{n-1}, inf).
      // Now rightNo covers [key, inf): it becomes the new right pointer,
      // and oldRight is unreachable -> BUG. Instead: newCells gets (key,leftNo)
      // and rightNo becomes right pointer only if oldRight's range is [key,inf),
      // which is wrong because oldRight also held [key, inf) BEFORE the split...
      // Actually when splitting the rightmost leaf, oldRight was the leaf's
      // right sibling (unrelated). The correct action: new right pointer = rightNo.
      newRight = rightNo;
    }
    setNumCells(par, 0);
    setContentStart(par, this.store.pageSize);
    for (const c of newCells) this.appendInternalCell(par, c.key, c.child);
    setRightPtr(par, newRight);
    this.store.dirty(parNo);
  }

  private appendInternalCell(page: Buffer, key: Buffer, child: number): void {
    const n = numCells(page);
    const start = contentStart(page) - (6 + key.length);
    setCellOff(page, n, start);
    page.writeUInt16BE(key.length, start);
    page.writeUInt32BE(child, start + 2);
    key.copy(page, start + 6);
    setNumCells(page, n + 1);
    setContentStart(page, start);
  }

  private async splitInternal(page: Buffer, pageNo: number): Promise<void> {
    const n = numCells(page);
    const mid = Math.floor(n / 2);
    // copy the separator key NOW: the page buffer is rewritten below
    const midCell = readInternalCell(page, mid);
    const sepKey = Buffer.from(midCell.key);
    const midChild = midCell.child;
    const newPageNo = await this.store.allocPage();
    const np = await this.load(newPageNo);
    np.fill(0);
    setParent(np, parent(page));
    setNumCells(np, 0);
    setContentStart(np, this.store.pageSize);
    // new page gets cells (mid+1..n-1), right pointer stays
    for (let i = mid + 1; i < n; i++) {
      const c = readInternalCell(page, i);
      this.appendInternalCell(np, c.key, c.child);
      const ch = await this.load(c.child);
      setParent(ch, newPageNo);
      this.store.dirty(c.child);
    }
    setRightPtr(np, rightPtr(page));
    const rp = await this.load(rightPtr(page));
    setParent(rp, newPageNo);
    this.store.dirty(rightPtr(page));
    // left page keeps cells (0..mid-1), right pointer = mid's child
    const leftCells: InternalCell[] = [];
    for (let i = 0; i < mid; i++) {
      const c = readInternalCell(page, i);
      leftCells.push({ key: Buffer.from(c.key), child: c.child, off: 0, total: 0 });
    }
    setNumCells(page, 0);
    setContentStart(page, this.store.pageSize);
    for (const c of leftCells) this.appendInternalCell(page, c.key, c.child);
    setRightPtr(page, midChild);
    this.store.dirty(pageNo);
    this.store.dirty(newPageNo);
    await this.insertIntoParent(pageNo, sepKey, newPageNo);
  }

  /** Delete a key (no rebalancing; pages are not merged). */
  async delete(key: Buffer): Promise<void> {
    const { page, pageNo } = await this.findLeaf(key);
    const n = numCells(page);
    const idx = this.searchLeaf(page, key);
    if (idx >= n) return;
    const c = readLeafCell(page, idx);
    if (cmpKey(c.key, key) !== 0) return;
    this.store.dirty(pageNo);
    // compact: rebuild cells without idx
    const kept: { key: Buffer; value: Buffer }[] = [];
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      const cc = readLeafCell(page, i);
      kept.push({ key: Buffer.from(cc.key), value: Buffer.from(cc.value) });
    }
    setNumCells(page, 0);
    setContentStart(page, this.store.pageSize);
    for (const k of kept) this.appendLeafCell(page, k.key, k.value);
  }

  /** Ordered scan with optional bounds. */
  async *scan(opts: ScanOpts = {}): AsyncGenerator<{ key: Buffer; value: Buffer }> {
    const from = opts.from || null;
    const to = opts.to || null;
    let pageNo: number;
    let startIdx: number;
    if (from) {
      const found = await this.findLeaf(from.key);
      pageNo = found.pageNo;
      startIdx = this.searchLeaf(found.page, from.key);
      if (!from.inclusive) {
        // skip keys equal to the bound
        const pg = found.page;
        while (startIdx < numCells(pg) &&
               cmpKey(readLeafCell(pg, startIdx).key, from.key) === 0) startIdx++;
      }
    } else {
      // leftmost leaf
      pageNo = this.root;
      for (;;) {
        const p = await this.load(pageNo);
        if (isLeaf(p)) break;
        pageNo = numCells(p) > 0 ? readInternalCell(p, 0).child : rightPtr(p);
      }
      startIdx = 0;
    }
    for (;;) {
      const p = await this.load(pageNo);
      const n = numCells(p);
      for (let i = startIdx; i < n; i++) {
        const c = readLeafCell(p, i);
        if (to) {
          const cmp = cmpKey(c.key, to.key);
          if (cmp > 0 || (cmp === 0 && !to.inclusive)) return;
        }
        yield { key: Buffer.from(c.key), value: Buffer.from(c.value) };
      }
      const next = rightPtr(p);
      if (next === 0) return;
      pageNo = next;
      startIdx = 0;
    }
  }

  /** Exact cell count (full leaf walk; used for table statistics). */
  async count(): Promise<number> {
    let total = 0;
    for await (const _ of this.scan()) total++;
    return total;
  }
}
