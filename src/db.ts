// Database: MVCC snapshot isolation over the B-tree + WAL storage engine.
//
// Concurrency model: a single writer at a time (writers queue on a mutex),
// any number of concurrent readers. Each txn gets a snapshot id; a row
// version is visible when its xmin committed before the snapshot and its
// xmax did not (first-committer-wins on write-write conflicts).
//
// Durability: dirty pages are WAL-logged (full images) at commit and fsync'd
// before commit returns. The data file is only written at checkpoints, which
// run when no write txn is active.
import { Pager, PAGE_SIZE } from './pager.js';
import { Wal } from './wal.js';
import { BTree } from './btree.js';
import { Catalog, TableInfo, IndexInfo, loadCatalog, saveCatalog } from './catalog.js';
import { SqlValue } from './value.js';
import { parseAll, parseOne } from './parser.js';
import type { Stmt } from './ast.js';
import { runSelect, runWrite, runDdl, runExplain } from './executor.js';

export class Transaction {
  state: 'active' | 'committed' | 'aborted' = 'active';
  /** release function for the writer mutex (write txns only) */
  _release: (() => void) | null = null;
  constructor(
    readonly db: Database,
    readonly id: bigint,
    readonly snapXid: bigint,
    readonly readOnly: boolean,
  ) {}
  async commit(): Promise<void> {
    await this.db.commitTxn(this);
  }
  async rollback(): Promise<void> {
    await this.db.rollbackTxn(this);
  }
}

export class Database {
  pager!: Pager;
  wal!: Wal;
  catalog!: Catalog;
  /** xids below committedXid are committed (or aborted); single-writer => ordered */
  committedXid = 1n;
  aborted = new Set<bigint>();
  private writer: Transaction | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private trees = new Map<number, BTree>(); // tableId/indexId -> BTree
  private explicitTxn: Transaction | null = null;
  private commitsSinceCheckpoint = 0;

  private constructor() {}

  static async open(path: string): Promise<Database> {
    const db = new Database();
    db.pager = await Pager.open(path);
    db.wal = await Wal.open(path + '-wal', PAGE_SIZE);
    // --- crash recovery: replay committed page images ---
    const images = await db.wal.recover();
    for (const [pageNo, img] of images) {
      const cur = await db.pager.getPage(pageNo);
      img.copy(cur);
      db.pager.needsFlush.add(pageNo);
    }
    if (images.has(0)) {
      // header was replayed; re-read in-memory fields is done lazily via
      // getPage(0) below
      const h = await db.pager.getPage(0);
      db.pager.pageCount = h.readUInt32BE(12);
      db.pager.freelistHead = h.readUInt32BE(16);
      db.pager.nextXid = h.readBigUInt64BE(20);
    }
    db.catalog = await loadCatalog(db.pager);
    db.committedXid = db.pager.nextXid;
    return db;
  }

  /** Get (or create) the B-tree for a table or index id. */
  btreeFor(id: number, rootPage: number): BTree {
    let t = this.trees.get(id);
    if (!t) {
      t = new BTree(this.pager, rootPage);
      this.trees.set(id, t);
    }
    return t;
  }

  tableTree(t: TableInfo): BTree {
    return this.btreeFor(t.id, t.rootPage);
  }

  indexTree(ix: IndexInfo): BTree {
    // index ids are offset to avoid collision with table ids
    return this.btreeFor(-ix.id, ix.rootPage);
  }

  forgetTree(id: number): void {
    this.trees.delete(id);
    this.trees.delete(-id);
  }

  /** Begin a write txn (waits if another writer is active). */
  async beginWrite(): Promise<Transaction> {
    let release!: () => void;
    const prev = this.writeQueue;
    this.writeQueue = new Promise<void>(res => { release = res; });
    await prev;
    const id = this.pager.nextXid++;
    const txn = new Transaction(this, id, this.pager.nextXid, false);
    txn._release = release;
    this.writer = txn;
    await this.wal.appendBegin(id);
    return txn;
  }

  /** Begin a read-only txn with a fresh snapshot. */
  beginRead(): Transaction {
    return new Transaction(this, 0n, this.pager.nextXid, true);
  }

  /** MVCC visibility test for a row version. */
  isVisible(xmin: bigint, xmax: bigint, txn: Transaction): boolean {
    const snap = txn.snapXid;
    const my = txn.id;
    const xminOk = xmin === my || (xmin < snap && xmin < this.committedXid && !this.aborted.has(xmin));
    if (!xminOk) return false;
    if (xmax === 0n) return true;
    if (xmax === my) return false;
    const xmaxOk = xmax < snap && xmax < this.committedXid && !this.aborted.has(xmax);
    return !xmaxOk;
  }

  /** Persist any B-tree root changes from splits into the catalog. */
  private async syncRoots(): Promise<void> {
    let changed = false;
    for (const t of this.catalog.tablesById.values()) {
      const tree = this.trees.get(t.id);
      if (tree && tree.root !== t.rootPage) {
        t.rootPage = tree.root;
        changed = true;
      }
    }
    for (const ix of this.catalog.indexesById.values()) {
      const tree = this.trees.get(-ix.id);
      if (tree && tree.root !== ix.rootPage) {
        ix.rootPage = tree.root;
        changed = true;
      }
    }
    if (changed) await saveCatalog(this.pager, this.catalog);
  }

  async commitTxn(txn: Transaction): Promise<void> {
    if (txn.state !== 'active') throw new Error('transaction is not active');
    if (txn.readOnly) {
      txn.state = 'committed';
      if (this.explicitTxn === txn) this.explicitTxn = null;
      return;
    }
    if (this.writer !== txn) throw new Error('not the active write transaction');
    try {
      await this.syncRoots();
      for (const pg of this.pager.dirtySet) {
        const buf = await this.pager.getPage(pg);
        await this.wal.appendPage(txn.id, pg, buf);
      }
      await this.wal.appendCommit(txn.id); // fsyncs
      this.pager.afterCommit();
      this.committedXid = txn.id + 1n;
      txn.state = 'committed';
    } finally {
      this.writer = null;
      if (this.explicitTxn === txn) this.explicitTxn = null;
      const rel = txn._release;
      txn._release = null;
      if (rel) rel();
    }
    this.commitsSinceCheckpoint++;
    if (this.commitsSinceCheckpoint >= 50) {
      this.commitsSinceCheckpoint = 0;
      await this.checkpoint();
    }
  }

  async rollbackTxn(txn: Transaction): Promise<void> {
    if (txn.state !== 'active') throw new Error('transaction is not active');
    if (txn.readOnly) {
      txn.state = 'aborted';
      if (this.explicitTxn === txn) this.explicitTxn = null;
      return;
    }
    if (this.writer !== txn) throw new Error('not the active write transaction');
    try {
      await this.wal.appendAbort(txn.id);
      this.pager.afterAbort();
      this.aborted.add(txn.id);
      // drop cached trees: roots may have been reset by the abort
      this.trees.clear();
      // reload catalog (it may have been modified by this txn)
      this.catalog = await loadCatalog(this.pager);
      txn.state = 'aborted';
    } finally {
      this.writer = null;
      if (this.explicitTxn === txn) this.explicitTxn = null;
      const rel = txn._release;
      txn._release = null;
      if (rel) rel();
    }
  }

  /** Flush dirty pages to the data file and truncate the WAL. */
  async checkpoint(): Promise<void> {
    if (this.writer) throw new Error('cannot checkpoint with an active write transaction');
    const images = this.pager.flushImages();
    if (images.size > 0) {
      await this.pager.writePages(images);
      await this.pager.sync();
    }
    await this.wal.checkpoint();
    this.pager.clearNeedsFlush();
  }

  async close(): Promise<void> {
    if (this.writer) await this.rollbackTxn(this.writer);
    if (this.explicitTxn && this.explicitTxn.state === 'active') {
      await this.rollbackTxn(this.explicitTxn);
    }
    await this.checkpoint();
    await this.wal.close();
    await this.pager.close();
  }

  // ------------------------------------------------------------------
  // Statement execution
  // ------------------------------------------------------------------

  /** Execute one or more statements; returns per-statement results. */
  async exec(sql: string): Promise<StmtResult[]> {
    const stmts = parseAll(sql);
    const out: StmtResult[] = [];
    for (const stmt of stmts) out.push(await this.runOne(stmt));
    return out;
  }

  /** Convenience: run a single SELECT and return its rows. */
  async query(sql: string): Promise<QueryResult> {
    const stmt = parseOne(sql);
    if (stmt.kind !== 'select') throw new Error('query() requires a SELECT statement');
    const r = await this.runOne(stmt);
    return r as QueryResult;
  }

  /** Convenience: run a single INSERT/UPDATE/DELETE. */
  async run(sql: string): Promise<WriteResult> {
    const stmt = parseOne(sql);
    if (stmt.kind !== 'insert' && stmt.kind !== 'update' && stmt.kind !== 'delete') {
      throw new Error('run() requires INSERT, UPDATE or DELETE');
    }
    return (await this.runOne(stmt)) as WriteResult;
  }

  private async runOne(stmt: Stmt): Promise<StmtResult> {
    switch (stmt.kind) {
      case 'begin':
        if (this.explicitTxn) throw new Error('a transaction is already active');
        this.explicitTxn = await this.beginWrite();
        return { ok: true };
      case 'commit':
        if (!this.explicitTxn) throw new Error('no transaction is active');
        await this.explicitTxn.commit();
        return { ok: true };
      case 'rollback':
        if (!this.explicitTxn) throw new Error('no transaction is active');
        await this.explicitTxn.rollback();
        return { ok: true };
      case 'select': {
        const owned = !this.explicitTxn;
        const txn = this.explicitTxn || this.beginRead();
        try {
          const r = await runSelect(this, txn, stmt);
          if (owned) await txn.commit();
          return r;
        } catch (e) {
          if (owned) await txn.rollback();
          throw e;
        }
      }
      case 'insert':
      case 'update':
      case 'delete': {
        const owned = !this.explicitTxn;
        const txn = this.explicitTxn || (await this.beginWrite());
        try {
          const r = await runWrite(this, txn, stmt);
          if (owned) await txn.commit();
          return r;
        } catch (e) {
          if (owned) await txn.rollback();
          throw e;
        }
      }
      case 'createTable':
      case 'dropTable':
      case 'createIndex':
      case 'dropIndex': {
        const owned = !this.explicitTxn;
        const txn = this.explicitTxn || (await this.beginWrite());
        try {
          await runDdl(this, txn, stmt);
          if (owned) await txn.commit();
          return { ok: true };
        } catch (e) {
          if (owned) await txn.rollback();
          throw e;
        }
      }
      case 'explain': {
        const owned = !this.explicitTxn;
        const txn = this.explicitTxn || this.beginRead();
        try {
          const r = await runExplain(this, txn, stmt.stmt);
          if (owned) await txn.commit();
          return r;
        } catch (e) {
          if (owned) await txn.rollback();
          throw e;
        }
      }
      default:
        throw new Error('unsupported statement');
    }
  }
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

export interface WriteResult {
  changes: number;
  lastRowid: number | null;
}

export type StmtResult = QueryResult | WriteResult | { ok: true };

