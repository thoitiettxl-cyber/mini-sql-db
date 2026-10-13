// Row-level MVCC operations over the table and index B-trees.
// Rowids are B-tree keys; each leaf value is a version chain (newest first).
import type { Database, Transaction } from './db.js';
import type { TableInfo, IndexInfo } from './catalog.js';
import {
  SqlValue, RowVersion, deserializeChain, serializeChain,
  encodeRowIdKey, decodeRowIdKey, encodeOrderKey, compareValues,
} from './value.js';
import type { ScanBound } from './btree.js';

export interface RowRef {
  rowid: number;
  values: SqlValue[];
}

/** Newest visible version in the chain, or null. */
export function pickVisible(db: Database, txn: Transaction, chain: RowVersion[]): RowVersion | null {
  for (const ver of chain) {
    if (db.isVisible(ver.xmin, ver.xmax, txn)) return ver;
  }
  return null;
}

/** Full ordered scan of a table's visible rows. */
export async function* scanTable(
  db: Database, txn: Transaction, table: TableInfo,
): AsyncGenerator<RowRef> {
  const bt = db.tableTree(table);
  for await (const { key, value } of bt.scan()) {
    const rowid = decodeRowIdKey(key);
    const ver = pickVisible(db, txn, deserializeChain(value));
    if (ver) yield { rowid, values: ver.values };
  }
}

/** Visible version of one rowid, or null. */
export async function getRow(
  db: Database, txn: Transaction, table: TableInfo, rowid: number,
): Promise<RowVersion | null> {
  const raw = await db.tableTree(table).get(encodeRowIdKey(rowid));
  if (!raw) return null;
  return pickVisible(db, txn, deserializeChain(raw));
}

/** Index key: order-preserving column values + rowid suffix (for uniqueness). */
export function indexKey(ix: IndexInfo, values: SqlValue[], rowid: number): Buffer {
  return Buffer.concat([
    encodeOrderKey(ix.columns.map(ci => values[ci])),
    encodeRowIdKey(rowid),
  ]);
}

function keyPrefix(ix: IndexInfo, keyVals: SqlValue[]): Buffer {
  return encodeOrderKey(keyVals);
}

/** Index range scan with column-prefix bounds; yields visible rows. */
export async function* scanIndex(
  db: Database,
  txn: Transaction,
  table: TableInfo,
  ix: IndexInfo,
  lo: SqlValue[] | null,
  loInclusive: boolean,
  hi: SqlValue[] | null,
  hiInclusive: boolean,
): AsyncGenerator<RowRef> {
  const bt = db.indexTree(ix);
  const FFS = Buffer.alloc(8, 0xff);
  let from: ScanBound | null = null;
  let to: ScanBound | null = null;
  if (lo) {
    const enc = keyPrefix(ix, lo);
    from = loInclusive
      ? { key: enc, inclusive: true }
      : { key: Buffer.concat([enc, FFS]), inclusive: true };
  }
  if (hi) {
    const enc = keyPrefix(ix, hi);
    to = hiInclusive
      ? { key: Buffer.concat([enc, FFS]), inclusive: true }
      : { key: enc, inclusive: true };
  }
  const tbt = db.tableTree(table);
  for await (const { key } of bt.scan({ from, to })) {
    const rowid = decodeRowIdKey(key.subarray(key.length - 8));
    const raw = await tbt.get(encodeRowIdKey(rowid));
    if (!raw) continue;
    const ver = pickVisible(db, txn, deserializeChain(raw));
    if (ver) yield { rowid, values: ver.values };
  }
}

/** True when a visible row (other than excludeRowid) carries the indexed key. */
export async function hasVisibleKey(
  db: Database,
  txn: Transaction,
  table: TableInfo,
  ix: IndexInfo,
  keyVals: SqlValue[],
  excludeRowid?: number,
): Promise<boolean> {
  const prefix = keyPrefix(ix, keyVals);
  const bt = db.indexTree(ix);
  const tbt = db.tableTree(table);
  for await (const { key } of bt.scan({ from: { key: prefix, inclusive: true } })) {
    if (key.length < prefix.length || !key.subarray(0, prefix.length).equals(prefix)) break;
    const rowid = decodeRowIdKey(key.subarray(key.length - 8));
    if (excludeRowid !== undefined && rowid === excludeRowid) continue;
    const raw = await tbt.get(encodeRowIdKey(rowid));
    if (!raw) continue;
    if (pickVisible(db, txn, deserializeChain(raw))) return true;
  }
  return false;
}

export function keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (compareValues(a[i], b[i]) !== 0) return false;
  }
  return true;
}

function checkWrite(txn: Transaction): void {
  if (txn.readOnly) throw new Error('cannot write in a read-only transaction');
  if (txn.state !== 'active') throw new Error('transaction is not active');
}

async function checkUnique(
  db: Database, txn: Transaction, table: TableInfo,
  values: SqlValue[], excludeRowid?: number,
): Promise<void> {
  for (const ix of db.catalog.indexesForTable(table.id)) {
    if (!ix.unique) continue;
    const keyVals = ix.columns.map(ci => values[ci]);
    if (keyVals.some(v => v === null)) continue; // SQLite: NULLs never conflict
    if (await hasVisibleKey(db, txn, table, ix, keyVals, excludeRowid)) {
      throw new Error('UNIQUE constraint failed: ' + table.name + '.' +
        ix.columns.map(ci => table.columns[ci].name).join(', '));
    }
  }
}

async function addIndexEntries(
  db: Database, table: TableInfo, values: SqlValue[], rowid: number,
): Promise<void> {
  for (const ix of db.catalog.indexesForTable(table.id)) {
    await db.indexTree(ix).put(indexKey(ix, values, rowid), encodeRowIdKey(rowid));
  }
}

async function removeIndexEntries(
  db: Database, table: TableInfo, values: SqlValue[], rowid: number,
): Promise<void> {
  for (const ix of db.catalog.indexesForTable(table.id)) {
    await db.indexTree(ix).delete(indexKey(ix, values, rowid));
  }
}

/** Insert a row; returns the assigned rowid. */
export async function insertRow(
  db: Database, txn: Transaction, table: TableInfo, values: SqlValue[],
): Promise<number> {
  checkWrite(txn);
  const bt = db.tableTree(table);
  let rowid: number;
  const pkCol = table.rowidPkCol;
  if (pkCol >= 0) {
    const v = values[pkCol];
    if (v === null || v === undefined) {
      rowid = table.maxRowid + 1;
      values[pkCol] = rowid;
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      rowid = v;
    } else {
      throw new Error('INTEGER PRIMARY KEY must be an integer');
    }
  } else {
    rowid = table.maxRowid + 1;
  }
  if (rowid > table.maxRowid) table.maxRowid = rowid;
  await checkUnique(db, txn, table, values);
  const key = encodeRowIdKey(rowid);
  const existing = await bt.get(key);
  let chain: RowVersion[];
  if (existing) {
    const old = deserializeChain(existing);
    if (pickVisible(db, txn, old)) throw new Error('PRIMARY KEY must be unique');
    // Rowid reuse: prepend so concurrent readers still see their versions.
    old.unshift({ xmin: txn.id, xmax: 0n, values });
    chain = old;
  } else {
    chain = [{ xmin: txn.id, xmax: 0n, values }];
  }
  await bt.put(key, serializeChain(chain));
  await addIndexEntries(db, table, values, rowid);
  table.rowCount++;
  return rowid;
}

/** Update a visible row (first-committer-wins on conflicts). */
export async function updateRow(
  db: Database, txn: Transaction, table: TableInfo,
  rowid: number, newValues: SqlValue[],
): Promise<void> {
  checkWrite(txn);
  // INTEGER PRIMARY KEY change => the rowid itself moves: delete + reinsert.
  const pkCol = table.rowidPkCol;
  const bt = db.tableTree(table);
  const key = encodeRowIdKey(rowid);
  const raw = await bt.get(key);
  if (!raw) throw new Error('row not found');
  const chain = deserializeChain(raw);
  const ver = pickVisible(db, txn, chain);
  if (!ver) throw new Error('row not visible');
  if (ver.xmax !== 0n) throw new Error('write-write conflict: row was modified concurrently');
  if (pkCol >= 0 && newValues[pkCol] !== ver.values[pkCol]) {
    await deleteRow(db, txn, table, rowid);
    await insertRow(db, txn, table, newValues);
    return;
  }
  await checkUnique(db, txn, table, newValues, rowid);
  const oldValues = ver.values;
  ver.xmax = txn.id;
  chain.unshift({ xmin: txn.id, xmax: 0n, values: newValues });
  await bt.put(key, serializeChain(chain));
  for (const ix of db.catalog.indexesForTable(table.id)) {
    const a = ix.columns.map(ci => oldValues[ci]);
    const b = ix.columns.map(ci => newValues[ci]);
    if (!keysEqual(a, b)) {
      const ibt = db.indexTree(ix);
      await ibt.delete(indexKey(ix, oldValues, rowid));
      await ibt.put(indexKey(ix, newValues, rowid), encodeRowIdKey(rowid));
    }
  }
}

/** Delete a visible row (sets xmax; first-committer-wins). */
export async function deleteRow(
  db: Database, txn: Transaction, table: TableInfo, rowid: number,
): Promise<void> {
  checkWrite(txn);
  const bt = db.tableTree(table);
  const key = encodeRowIdKey(rowid);
  const raw = await bt.get(key);
  if (!raw) return;
  const chain = deserializeChain(raw);
  const ver = pickVisible(db, txn, chain);
  if (!ver) return;
  if (ver.xmax !== 0n) throw new Error('write-write conflict: row was modified concurrently');
  ver.xmax = txn.id;
  await bt.put(key, serializeChain(chain));
  await removeIndexEntries(db, table, ver.values, rowid);
  table.rowCount--;
}
