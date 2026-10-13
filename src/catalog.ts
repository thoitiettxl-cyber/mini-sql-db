// Catalog: tables, columns, and indexes. Persisted as JSON in a chain of
// pages starting at page 1: [u32 totalLen][u32 nextPage][payload...].
import type { PageStore } from './pager.js';
import { Affinity, SqlValue, affinityOf } from './value.js';

export interface ColumnInfo {
  name: string;
  type: string;
  affinity: Affinity;
  notNull: boolean;
  unique: boolean;
  pk: boolean;
  hasDefault: boolean;
  default: SqlValue | null;
}

export interface TableInfo {
  id: number;
  name: string;
  rootPage: number;
  columns: ColumnInfo[];
  /** single INTEGER PRIMARY KEY column acts as the rowid alias */
  rowidPkCol: number; // -1 when none
  maxRowid: number;
  rowCount: number; // planner statistic
}

export interface IndexInfo {
  id: number;
  name: string;
  tableId: number;
  rootPage: number;
  columns: number[]; // table column indexes
  unique: boolean;
  implicit: boolean; // auto-created for UNIQUE/PK constraints
}

function encodeValue(v: SqlValue): unknown {
  if (v instanceof Uint8Array) return { __blob: Buffer.from(v).toString('hex') };
  return v;
}

function decodeValue(v: unknown): SqlValue {
  if (v !== null && typeof v === 'object' && '__blob' in (v as object)) {
    return new Uint8Array(Buffer.from((v as { __blob: string }).__blob, 'hex'));
  }
  return v as SqlValue;
}

export class Catalog {
  tables = new Map<string, TableInfo>();
  tablesById = new Map<number, TableInfo>();
  indexes = new Map<string, IndexInfo>();
  indexesById = new Map<number, IndexInfo>();
  nextTableId = 1;
  nextIndexId = 1;

  getTable(name: string): TableInfo | undefined {
    return this.tables.get(name.toLowerCase());
  }

  requireTable(name: string): TableInfo {
    const t = this.getTable(name);
    if (!t) throw new Error('no such table: ' + name);
    return t;
  }

  addTable(t: TableInfo): void {
    const key = t.name.toLowerCase();
    if (this.tables.has(key)) throw new Error('table ' + t.name + ' already exists');
    this.tables.set(key, t);
    this.tablesById.set(t.id, t);
    if (t.id >= this.nextTableId) this.nextTableId = t.id + 1;
  }

  dropTable(name: string): TableInfo {
    const key = name.toLowerCase();
    const t = this.tables.get(key);
    if (!t) throw new Error('no such table: ' + name);
    this.tables.delete(key);
    this.tablesById.delete(t.id);
    for (const ix of this.indexesForTable(t.id)) {
      this.indexes.delete(ix.name.toLowerCase());
      this.indexesById.delete(ix.id);
    }
    return t;
  }

  getIndex(name: string): IndexInfo | undefined {
    return this.indexes.get(name.toLowerCase());
  }

  addIndex(ix: IndexInfo): void {
    const key = ix.name.toLowerCase();
    if (this.indexes.has(key)) throw new Error('index ' + ix.name + ' already exists');
    this.indexes.set(key, ix);
    this.indexesById.set(ix.id, ix);
    if (ix.id >= this.nextIndexId) this.nextIndexId = ix.id + 1;
  }

  dropIndex(name: string): IndexInfo {
    const key = name.toLowerCase();
    const ix = this.indexes.get(key);
    if (!ix) throw new Error('no such index: ' + name);
    this.indexes.delete(key);
    this.indexesById.delete(ix.id);
    return ix;
  }

  indexesForTable(tableId: number): IndexInfo[] {
    const out: IndexInfo[] = [];
    for (const ix of this.indexesById.values()) {
      if (ix.tableId === tableId) out.push(ix);
    }
    return out;
  }

  columnIndex(table: TableInfo, colName: string): number {
    const idx = table.columns.findIndex(c => c.name.toLowerCase() === colName.toLowerCase());
    return idx;
  }

  toJSON(): unknown {
    return {
      nextTableId: this.nextTableId,
      nextIndexId: this.nextIndexId,
      tables: [...this.tablesById.values()].map(t => ({
        ...t,
        columns: t.columns.map(c => ({ ...c, default: encodeValue(c.default) })),
      })),
      indexes: [...this.indexesById.values()],
    };
  }

  static fromJSON(j: {
    nextTableId: number; nextIndexId: number;
    tables: TableInfo[]; indexes: IndexInfo[];
  }): Catalog {
    const c = new Catalog();
    c.nextTableId = j.nextTableId;
    c.nextIndexId = j.nextIndexId;
    for (const t of j.tables) {
      t.columns = t.columns.map(col => ({ ...col, default: decodeValue(col.default as unknown) }));
      c.tables.set(t.name.toLowerCase(), t);
      c.tablesById.set(t.id, t);
    }
    for (const ix of j.indexes) {
      c.indexes.set(ix.name.toLowerCase(), ix);
      c.indexesById.set(ix.id, ix);
    }
    return c;
  }
}

export function makeColumn(name: string, type: string): ColumnInfo {
  return {
    name, type,
    affinity: affinityOf(type),
    notNull: false, unique: false, pk: false,
    hasDefault: false, default: null,
  };
}

const CATALOG_PAGE = 1;
const CHAIN_HDR = 8; // [u32 totalLen][u32 nextPage]

async function readChain(store: PageStore): Promise<{ pages: number[]; data: Buffer }> {
  const pages: number[] = [];
  const parts: Buffer[] = [];
  let pageNo = CATALOG_PAGE;
  let totalLen = -1;
  let got = 0;
  for (;;) {
    const pg = await store.getPage(pageNo);
    pages.push(pageNo);
    if (totalLen < 0) totalLen = pg.readUInt32BE(0);
    const next = pg.readUInt32BE(4);
    const avail = store.pageSize - CHAIN_HDR;
    const want = Math.min(avail, totalLen - got);
    parts.push(Buffer.from(pg.subarray(CHAIN_HDR, CHAIN_HDR + want)));
    got += want;
    if (next === 0) break;
    pageNo = next;
    if (pages.length > 1024) throw new Error('catalog chain too long');
  }
  return { pages, data: Buffer.concat(parts) };
}

/** Load the catalog from its page chain. */
export async function loadCatalog(store: PageStore): Promise<Catalog> {
  const { data } = await readChain(store);
  if (data.length === 0) return new Catalog();
  const j = JSON.parse(data.toString('utf8'));
  return Catalog.fromJSON(j);
}

/** Persist the catalog, freeing surplus overflow pages. */
export async function saveCatalog(store: PageStore, catalog: Catalog): Promise<void> {
  const { pages: oldPages } = await readChain(store);
  const data = Buffer.from(JSON.stringify(catalog.toJSON()), 'utf8');
  const avail = store.pageSize - CHAIN_HDR;
  let pageNo = CATALOG_PAGE;
  let off = 0;
  let idx = 0;
  for (;;) {
    const pg = await store.getPage(pageNo);
    store.dirty(pageNo);
    const chunk = Math.min(avail, data.length - off);
    pg.writeUInt32BE(data.length, 0);
    if (off + chunk < data.length) {
      let next: number;
      if (idx + 1 < oldPages.length) {
        next = oldPages[idx + 1];
      } else {
        next = await store.allocPage();
      }
      pg.writeUInt32BE(next, 4);
      data.copy(pg, CHAIN_HDR, off, off + chunk);
      off += chunk;
      pageNo = next;
      idx++;
    } else {
      pg.writeUInt32BE(0, 4);
      data.copy(pg, CHAIN_HDR, off, off + chunk);
      // free surplus old pages
      for (let k = idx + 1; k < oldPages.length; k++) {
        await store.freePage(oldPages[k]);
      }
      break;
    }
  }
}
