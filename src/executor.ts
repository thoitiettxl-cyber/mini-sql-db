// Executor: interprets the planner's plan tree.
// Rows are plain objects with lowercased keys (qualified `alias.column` for
// table scans, bare aliases for computed outputs). Project nodes pass input
// keys through so ORDER BY can reference non-projected columns; the final
// result is trimmed to the declared output columns.
import type { Database, Transaction } from './db.js';
import { planSelect, Plan, PlannedQuery, SubPlan, outputColumnsOf } from './planner.js';
import { evalExpr, Row, EvalCtx, SubqueryResult } from './expr.js';
import * as ast from './ast.js';
import type { Expr, SelectStmt, Stmt } from './ast.js';
import {
  SqlValue, compareValues, isTruthy, Affinity, applyAffinity, encodeRowIdKey,
} from './value.js';
import { scanTable, scanIndex, insertRow, updateRow, deleteRow, indexKey, hasVisibleKey } from './rows.js';
import { saveCatalog, makeColumn } from './catalog.js';
import { BTree } from './btree.js';
import type { QueryResult, WriteResult } from './db.js';

export interface Batch {
  columns: string[];
  rows: Row[];
}

function lc(s: string): string {
  return s.toLowerCase();
}

class Executor {
  private subPlans = new Map<SelectStmt, SubPlan>();
  private subCache = new Map<SelectStmt, SubqueryResult>();

  constructor(
    private db: Database,
    private txn: Transaction,
    private pq: PlannedQuery,
  ) {
    for (const s of pq.subs) this.subPlans.set(s.node, s);
  }

  private makeCtx(scopes: Row[]): EvalCtx {
    return {
      db: this.db,
      txn: this.txn,
      scopes,
      affinities: this.pq.affinities,
      subCache: new Map(),
      execSubquery: (sub, outer) => this.execSubquery(sub, outer),
    };
  }

  async execSubquery(sub: SelectStmt, outerScopes: Row[]): Promise<SubqueryResult> {
    const sp = this.subPlans.get(sub);
    if (!sp) throw new Error('subquery was not planned');
    if (!sp.correlated) {
      const hit = this.subCache.get(sub);
      if (hit) return hit;
      const res = this.trim(await this.execute(sp.plan, []), sp.plan);
      this.subCache.set(sub, res);
      return res;
    }
    return this.trim(await this.execute(sp.plan, outerScopes), sp.plan);
  }

  /** Trim a batch to the plan's declared output columns (lowercased). */
  private trim(batch: Batch, plan: Plan): SubqueryResult {
    const cols = outputColumnsOf(plan).map(lc);
    return {
      columns: cols,
      rows: batch.rows.map(r => {
        const out: Row = {};
        for (const c of cols) out[c] = c in r ? r[c] : null;
        return out;
      }),
    };
  }

  async execute(plan: Plan, outerScopes: Row[]): Promise<Batch> {
    switch (plan.kind) {
      case 'scan': return this.execScan(plan);
      case 'filter': return this.execFilter(plan, outerScopes);
      case 'project': return this.execProject(plan, outerScopes);
      case 'join': return this.execJoin(plan, outerScopes);
      case 'hashjoin': return this.execHashJoin(plan, outerScopes);
      case 'aggregate': return this.execAggregate(plan, outerScopes);
      case 'sort': return this.execSort(plan, outerScopes);
      case 'limit': return this.execLimit(plan, outerScopes);
      case 'distinct': return this.execDistinct(plan, outerScopes);
      case 'setop': return this.execSetop(plan, outerScopes);
    }
  }

  private async execScan(plan: Extract<Plan, { kind: 'scan' }>): Promise<Batch> {
    const table = plan.table;
    if (table.id < 0) {
      return { columns: [], rows: [{}] }; // SELECT without FROM
    }
    const columns = table.columns.map(c => lc(plan.alias + '.' + c.name));
    const rows: Row[] = [];
    const gen = plan.index
      ? scanIndex(this.db, this.txn, table, plan.index, plan.lo, plan.loInc, plan.hi, plan.hiInc)
      : scanTable(this.db, this.txn, table);
    for await (const { values } of gen) {
      const row: Row = {};
      for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i] ?? null;
      rows.push(row);
    }
    return { columns, rows };
  }

  private async execFilter(
    plan: Extract<Plan, { kind: 'filter' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    const rows: Row[] = [];
    for (const row of input.rows) {
      const v = await evalExpr(plan.predicate, this.makeCtx([row, ...outerScopes]));
      if (v !== null && isTruthy(v)) rows.push(row);
    }
    return { columns: input.columns, rows };
  }

  private async execProject(
    plan: Extract<Plan, { kind: 'project' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    const columns = plan.items.map(i => lc(i.alias));
    const rows: Row[] = [];
    for (const row of input.rows) {
      const ctx = this.makeCtx([row, ...outerScopes]);
      const out: Row = { ...row };
      for (const item of plan.items) {
        out[lc(item.alias)] = await evalExpr(item.expr, ctx);
      }
      rows.push(out);
    }
    return { columns, rows };
  }

  private async execJoin(
    plan: Extract<Plan, { kind: 'join' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const left = await this.execute(plan.left, outerScopes);
    const right = await this.execute(plan.right, outerScopes);
    const columns = [...left.columns, ...right.columns];
    const rows: Row[] = [];
    const matchedRight = new Array(right.rows.length).fill(false);
    for (const lr of left.rows) {
      let matched = false;
      for (let ri = 0; ri < right.rows.length; ri++) {
        const rr = right.rows[ri];
        const combined = { ...lr, ...rr };
        let ok = true;
        if (plan.cond) {
          const v = await evalExpr(plan.cond, this.makeCtx([combined, ...outerScopes]));
          ok = v !== null && isTruthy(v);
        }
        if (ok) {
          matched = true;
          matchedRight[ri] = true;
          rows.push(combined);
        }
      }
      if (!matched && (plan.joinType === 'LEFT' || plan.joinType === 'FULL')) {
        const out: Row = { ...lr };
        for (const c of right.columns) out[c] = null;
        rows.push(out);
      }
    }
    if (plan.joinType === 'FULL') {
      for (let ri = 0; ri < right.rows.length; ri++) {
        if (!matchedRight[ri]) {
          const out: Row = { ...right.rows[ri] };
          for (const c of left.columns) out[c] = null;
          rows.push(out);
        }
      }
    }
    return { columns, rows };
  }

  private hashKey(vals: SqlValue[]): string | null {
    const parts: string[] = [];
    for (const v of vals) {
      if (v === null) return null; // NULL never joins
      if (typeof v === 'number') parts.push('n:' + v);
      else if (typeof v === 'string') parts.push('s:' + v.length + ':' + v);
      else parts.push('b:' + Buffer.from(v).toString('hex'));
    }
    return parts.join('|');
  }

  private async execHashJoin(
    plan: Extract<Plan, { kind: 'hashjoin' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const left = await this.execute(plan.left, outerScopes);
    const right = await this.execute(plan.right, outerScopes);
    const columns = [...left.columns, ...right.columns];
    const rows: Row[] = [];
    if (plan.joinType === 'INNER') {
      // build on left, probe with right
      const table = new Map<string, Row[]>();
      for (const lr of left.rows) {
        const ctx = this.makeCtx([lr, ...outerScopes]);
        const keyVals: SqlValue[] = [];
        for (const k of plan.leftKeys) keyVals.push(await evalExpr(k, ctx));
        const hk = this.hashKey(keyVals);
        if (hk === null) continue;
        let arr = table.get(hk);
        if (!arr) { arr = []; table.set(hk, arr); }
        arr.push(lr);
      }
      for (const rr of right.rows) {
        const ctx = this.makeCtx([rr, ...outerScopes]);
        const keyVals: SqlValue[] = [];
        for (const k of plan.rightKeys) keyVals.push(await evalExpr(k, ctx));
        const hk = this.hashKey(keyVals);
        if (hk === null) continue;
        const matches = table.get(hk);
        if (!matches) continue;
        for (const lr of matches) {
          const combined = { ...lr, ...rr };
          if (plan.residual) {
            const v = await evalExpr(plan.residual, this.makeCtx([combined, ...outerScopes]));
            if (v === null || !isTruthy(v)) continue;
          }
          rows.push(combined);
        }
      }
    } else {
      // LEFT: build on right, probe with left, keep unmatched left rows
      const table = new Map<string, Row[]>();
      for (const rr of right.rows) {
        const ctx = this.makeCtx([rr, ...outerScopes]);
        const keyVals: SqlValue[] = [];
        for (const k of plan.rightKeys) keyVals.push(await evalExpr(k, ctx));
        const hk = this.hashKey(keyVals);
        if (hk === null) continue;
        let arr = table.get(hk);
        if (!arr) { arr = []; table.set(hk, arr); }
        arr.push(rr);
      }
      for (const lr of left.rows) {
        const ctx = this.makeCtx([lr, ...outerScopes]);
        const keyVals: SqlValue[] = [];
        for (const k of plan.leftKeys) keyVals.push(await evalExpr(k, ctx));
        const hk = this.hashKey(keyVals);
        const matches = hk === null ? null : table.get(hk);
        if (!matches || matches.length === 0) {
          const out: Row = { ...lr };
          for (const c of right.columns) out[c] = null;
          rows.push(out);
          continue;
        }
        for (const rr of matches) {
          const combined = { ...lr, ...rr };
          if (plan.residual) {
            const v = await evalExpr(plan.residual, this.makeCtx([combined, ...outerScopes]));
            if (v === null || !isTruthy(v)) continue;
          }
          rows.push(combined);
        }
      }
    }
    return { columns, rows };
  }

  private async execAggregate(
    plan: Extract<Plan, { kind: 'aggregate' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    // group rows (NULL group keys group together, like SQLite)
    const columns = [
      ...plan.groupBy.map((_, i) => '__gb' + i),
      ...plan.aggs.map(a => lc(a.alias)),
    ];
    const rows: Row[] = [];
    const emitGroup = async (grp: { keyVals: SqlValue[]; rows: Row[] }) => {
      const out: Row = { ...grp.rows[0] }; // first row passthrough for bare cols
      plan.groupBy.forEach((_, i) => { out['__gb' + i] = grp.keyVals[i]; });
      for (const agg of plan.aggs) {
        out[lc(agg.alias)] = await this.evalAgg(agg, grp.rows, outerScopes);
      }
      if (plan.having) {
        const v = await evalExpr(plan.having, this.makeCtx([out, ...outerScopes]));
        if (v === null || !isTruthy(v)) return;
      }
      rows.push(out);
    };
    if (plan.groupBy.length === 0) {
      // single group even for empty input (COUNT(*) -> 0 etc.)
      const all = input.rows;
      await emitGroup({ keyVals: [], rows: all.length > 0 ? all : [{}] });
    } else {
      const grouped = new Map<string, { keyVals: SqlValue[]; rows: Row[] }>();
      const gorder: string[] = [];
      for (const row of input.rows) {
        const ctx = this.makeCtx([row, ...outerScopes]);
        const keyVals: SqlValue[] = [];
        for (const g of plan.groupBy) keyVals.push(await evalExpr(g, ctx));
        const hk = 'g:' + keyVals.map(v =>
          v === null ? 'N' : typeof v === 'number' ? 'n:' + v :
          typeof v === 'string' ? 's:' + v.length + ':' + v :
          'b:' + Buffer.from(v).toString('hex')).join('|');
        let grp = grouped.get(hk);
        if (!grp) { grp = { keyVals, rows: [] }; grouped.set(hk, grp); gorder.push(hk); }
        grp.rows.push(row);
      }
      for (const hk of gorder) await emitGroup(grouped.get(hk)!);
    }
    return { columns, rows };
  }

  private async evalAgg(
    agg: { func: string; arg: Expr | null; distinct: boolean; alias: string },
    rows: Row[],
    outerScopes: Row[],
  ): Promise<SqlValue> {
    const vals: SqlValue[] = [];
    if (agg.arg) {
      for (const row of rows) {
        vals.push(await evalExpr(agg.arg, this.makeCtx([row, ...outerScopes])));
      }
    }
    const nonNull = vals.filter(v => v !== null);
    let distinctVals = nonNull;
    if (agg.distinct) {
      const seen = new Set<string>();
      distinctVals = [];
      for (const v of nonNull) {
        const k = this.hashKey([v])!;
        if (!seen.has(k)) { seen.add(k); distinctVals.push(v); }
      }
    }
    switch (agg.func) {
      case 'count':
        return agg.arg ? distinctVals.length : rows.length;
      case 'sum': {
        if (distinctVals.length === 0) return null;
        let s = 0;
        for (const v of distinctVals) s += toNum(v);
        return s;
      }
      case 'avg': {
        if (distinctVals.length === 0) return null;
        let s = 0;
        for (const v of distinctVals) s += toNum(v);
        return s / distinctVals.length;
      }
      case 'total': {
        let s = 0;
        for (const v of distinctVals) s += toNum(v);
        return s;
      }
      case 'min': {
        if (distinctVals.length === 0) return null;
        let best = distinctVals[0];
        for (const v of distinctVals) if (compareValues(v, best) < 0) best = v;
        return best;
      }
      case 'max': {
        if (distinctVals.length === 0) return null;
        let best = distinctVals[0];
        for (const v of distinctVals) if (compareValues(v, best) > 0) best = v;
        return best;
      }
      case 'group_concat': {
        if (distinctVals.length === 0) return null;
        // separator: SQLite group_concat(x, sep); we only support single arg here
        return distinctVals.map(v =>
          v instanceof Uint8Array ? Buffer.from(v).toString() : String(v)).join(',');
      }
      default:
        throw new Error('unknown aggregate: ' + agg.func);
    }
  }

  private async execSort(
    plan: Extract<Plan, { kind: 'sort' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    const decorated: { row: Row; keys: SqlValue[] }[] = [];
    for (const row of input.rows) {
      const ctx = this.makeCtx([row, ...outerScopes]);
      const keys: SqlValue[] = [];
      for (const k of plan.keys) keys.push(await evalExpr(k.expr, ctx));
      decorated.push({ row, keys });
    }
    decorated.sort((a, b) => {
      for (let i = 0; i < plan.keys.length; i++) {
        const c = compareValues(a.keys[i], b.keys[i]);
        if (c !== 0) return plan.keys[i].desc ? -c : c;
      }
      return 0;
    });
    return { columns: input.columns, rows: decorated.map(d => d.row) };
  }

  private async execLimit(
    plan: Extract<Plan, { kind: 'limit' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    const ctx = this.makeCtx([]);
    let limit: number | null = null;
    let offset = 0;
    if (plan.limit) {
      const v = await evalExpr(plan.limit, ctx);
      if (v !== null) limit = Math.trunc(toNum(v));
    }
    if (plan.offset) {
      const v = await evalExpr(plan.offset, ctx);
      if (v !== null) offset = Math.max(0, Math.trunc(toNum(v)));
    }
    let rows = input.rows.slice(offset);
    if (limit !== null && limit >= 0) rows = rows.slice(0, limit);
    return { columns: input.columns, rows };
  }

  private async execDistinct(
    plan: Extract<Plan, { kind: 'distinct' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const input = await this.execute(plan.input, outerScopes);
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const row of input.rows) {
      const k = this.hashKey(input.columns.map(c => row[c] ?? null));
      if (!seen.has(k!)) { seen.add(k!); rows.push(row); }
    }
    return { columns: input.columns, rows };
  }

  private async execSetop(
    plan: Extract<Plan, { kind: 'setop' }>, outerScopes: Row[],
  ): Promise<Batch> {
    const left = await this.execute(plan.left, outerScopes);
    const right = await this.execute(plan.right, outerScopes);
    if (left.columns.length !== right.columns.length) {
      throw new Error('set operation requires the same number of columns');
    }
    const columns = left.columns;
    const keyOf = (row: Row, cols: string[]) =>
      'r:' + cols.map(c => {
        const v = row[c] ?? null;
        return v === null ? 'N' : typeof v === 'number' ? 'n:' + v :
          typeof v === 'string' ? 's:' + v.length + ':' + v :
          'b:' + Buffer.from(v).toString('hex');
      }).join('|');
    const toOut = (row: Row, cols: string[]): Row => {
      const out: Row = {};
      for (let i = 0; i < columns.length; i++) out[columns[i]] = row[cols[i]] ?? null;
      return out;
    };
    let rows: Row[];
    if (plan.op === 'UNION') {
      rows = [...left.rows.map(r => toOut(r, left.columns)),
              ...right.rows.map(r => toOut(r, right.columns))];
      if (!plan.all) rows = dedupe(rows, r => keyOf(r, columns));
    } else if (plan.op === 'INTERSECT') {
      const rset = new Set(right.rows.map(r => keyOf(toOut(r, right.columns), columns)));
      rows = dedupe(
        left.rows.map(r => toOut(r, left.columns)).filter(r => rset.has(keyOf(r, columns))),
        r => keyOf(r, columns));
    } else {
      const rset = new Set(right.rows.map(r => keyOf(toOut(r, right.columns), columns)));
      rows = dedupe(
        left.rows.map(r => toOut(r, left.columns)).filter(r => !rset.has(keyOf(r, columns))),
        r => keyOf(r, columns));
    }
    return { columns, rows };
  }
}

function dedupe(rows: Row[], keyOf: (r: Row) => string): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

function toNum(v: SqlValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

// ------------------------------------------------------------------
// Top-level entry points (called from db.ts)
// ------------------------------------------------------------------

export async function runSelect(
  db: Database, txn: Transaction, stmt: SelectStmt,
): Promise<QueryResult> {
  const pq = planSelect(db, stmt);
  const exec = new Executor(db, txn, pq);
  const batch = await exec.execute(pq.plan, []);
  const cols = pq.outputColumns.map(lc);
  return {
    columns: pq.outputColumns,
    rows: batch.rows.map(r => cols.map(c => (c in r ? r[c] : null))),
  };
}

export async function runWrite(
  db: Database, txn: Transaction, stmt: Extract<Stmt, { kind: 'insert' | 'update' | 'delete' }>,
): Promise<WriteResult> {
  if (stmt.kind === 'insert') return runInsert(db, txn, stmt);
  if (stmt.kind === 'update') return runUpdate(db, txn, stmt);
  return runDelete(db, txn, stmt);
}

function rowToRecord(table: { name: string; columns: { name: string }[] }, alias: string, values: SqlValue[]): Row {
  const row: Row = {};
  for (let i = 0; i < table.columns.length; i++) {
    row[lc(alias + '.' + table.columns[i].name)] = values[i] ?? null;
  }
  return row;
}

async function evalConstant(e: Expr, db: Database, txn: Transaction): Promise<SqlValue> {
  const ctx: EvalCtx = {
    db, txn, scopes: [{}], affinities: new Map(), subCache: new Map(),
    execSubquery: () => { throw new Error('subqueries not supported here'); },
  };
  return evalExpr(e, ctx);
}

async function runInsert(
  db: Database, txn: Transaction, stmt: Extract<Stmt, { kind: 'insert' }>,
): Promise<WriteResult> {
  const table = db.catalog.requireTable(stmt.table);
  const colIndexes: number[] = stmt.columns
    ? stmt.columns.map(c => {
        const i = db.catalog.columnIndex(table, c);
        if (i < 0) throw new Error('no such column: ' + c);
        return i;
      })
    : table.columns.map((_, i) => i);
  let sourceRows: SqlValue[][];
  if (stmt.source.kind === 'values') {
    sourceRows = [];
    for (const rowExprs of stmt.source.rows) {
      if (rowExprs.length !== colIndexes.length) {
        throw new Error('VALUES row has ' + rowExprs.length + ' values, expected ' + colIndexes.length);
      }
      const vals: SqlValue[] = [];
      for (const e of rowExprs) vals.push(await evalConstant(e, db, txn));
      sourceRows.push(vals);
    }
  } else {
    const pq = planSelect(db, stmt.source.select);
    const exec = new Executor(db, txn, pq);
    const batch = await exec.execute(pq.plan, []);
    const cols = pq.outputColumns.map(lc);
    if (cols.length !== colIndexes.length) {
      throw new Error('INSERT ... SELECT column count mismatch');
    }
    sourceRows = batch.rows.map(r => cols.map(c => (c in r ? r[c] : null)));
  }
  let changes = 0;
  let lastRowid: number | null = null;
  for (const srcRow of sourceRows) {
    const values: SqlValue[] = new Array(table.columns.length).fill(null);
    for (let i = 0; i < colIndexes.length; i++) values[colIndexes[i]] = srcRow[i];
    // defaults + affinity + NOT NULL
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i];
      if (values[i] === null || values[i] === undefined) {
        if (col.hasDefault && col.default !== null) {
          values[i] = col.default;
        } else {
          values[i] = null; // rowid pk: null => auto-assign; otherwise NULL
        }
      }
      if (values[i] !== null && values[i] !== undefined) {
        values[i] = applyAffinity(values[i]!, col.affinity);
      }
      if ((values[i] === null || values[i] === undefined) && col.notNull && table.rowidPkCol !== i) {
        throw new Error('NOT NULL constraint failed: ' + table.name + '.' + col.name);
      }
      if (values[i] === undefined) values[i] = null;
    }
    lastRowid = await insertRow(db, txn, table, values);
    changes++;
  }
  return { changes, lastRowid };
}

async function runUpdate(
  db: Database, txn: Transaction, stmt: Extract<Stmt, { kind: 'update' }>,
): Promise<WriteResult> {
  const table = db.catalog.requireTable(stmt.table);
  const setCols = stmt.sets.map(s => {
    const i = db.catalog.columnIndex(table, s.column);
    if (i < 0) throw new Error('no such column: ' + s.column);
    return i;
  });
  // materialize matches first: writes must not disturb the scan
  const matched: { rowid: number; values: SqlValue[] }[] = [];
  for await (const { rowid, values } of scanTable(db, txn, table)) {
    const ctx: EvalCtx = {
      db, txn, scopes: [rowToRecord(table, stmt.alias, values)],
      affinities: new Map(), subCache: new Map(),
      execSubquery: () => { throw new Error('subqueries not supported here'); },
    };
    if (!stmt.where || isTruthy(await evalExpr(stmt.where, ctx))) {
      matched.push({ rowid, values });
    }
  }
  let changes = 0;
  for (const m of matched) {
    const newValues = [...m.values];
    const ctx: EvalCtx = {
      db, txn, scopes: [rowToRecord(table, stmt.alias, m.values)],
      affinities: new Map(), subCache: new Map(),
      execSubquery: () => { throw new Error('subqueries not supported here'); },
    };
    for (let i = 0; i < stmt.sets.length; i++) {
      const ci = setCols[i];
      const v = await evalExpr(stmt.sets[i].expr, ctx);
      newValues[ci] = v === null ? null : applyAffinity(v, table.columns[ci].affinity);
      if (newValues[ci] === null && table.columns[ci].notNull && table.rowidPkCol !== ci) {
        throw new Error('NOT NULL constraint failed: ' + table.name + '.' + table.columns[ci].name);
      }
    }
    await updateRow(db, txn, table, m.rowid, newValues);
    changes++;
  }
  return { changes, lastRowid: null };
}

async function runDelete(
  db: Database, txn: Transaction, stmt: Extract<Stmt, { kind: 'delete' }>,
): Promise<WriteResult> {
  const table = db.catalog.requireTable(stmt.table);
  const matched: number[] = [];
  for await (const { rowid, values } of scanTable(db, txn, table)) {
    const ctx: EvalCtx = {
      db, txn, scopes: [rowToRecord(table, stmt.alias, values)],
      affinities: new Map(), subCache: new Map(),
      execSubquery: () => { throw new Error('subqueries not supported here'); },
    };
    if (!stmt.where || isTruthy(await evalExpr(stmt.where, ctx))) matched.push(rowid);
  }
  for (const rowid of matched) await deleteRow(db, txn, table, rowid);
  return { changes: matched.length, lastRowid: null };
}

export async function runDdl(
  db: Database, txn: Transaction, stmt: Extract<Stmt, { kind: 'createTable' | 'dropTable' | 'createIndex' | 'dropIndex' }>,
): Promise<void> {
  if (stmt.kind === 'createTable') {
    const existing = db.catalog.getTable(stmt.name);
    if (existing) {
      if (stmt.ifNotExists) return;
      throw new Error('table ' + stmt.name + ' already exists');
    }
    const columns = stmt.columns.map(cd => {
      const c = makeColumn(cd.name, cd.type);
      c.pk = cd.primaryKey;
      c.notNull = cd.notNull || cd.primaryKey;
      c.unique = cd.unique;
      if (cd.default) {
        // defaults must be constant
        c.hasDefault = true;
        c.default = null; // resolved below
        (c as { _defExpr?: ast.Expr })._defExpr = cd.default;
      }
      return c;
    });
    // resolve default expressions (must be constant)
    for (const c of columns) {
      const e = (c as { _defExpr?: ast.Expr })._defExpr;
      if (e) {
        c.default = await evalConstant(e, db, txn);
        delete (c as { _defExpr?: ast.Expr })._defExpr;
      }
    }
    // INTEGER PRIMARY KEY detection (single column, INTEGER affinity)
    const pkCols = columns.map((c, i) => (c.pk ? i : -1)).filter(i => i >= 0);
    let rowidPkCol = -1;
    if (pkCols.length === 1 && columns[pkCols[0]].affinity === 'INTEGER') {
      rowidPkCol = pkCols[0];
    }
    const tree = await BTree.create(db.pager);
    const table = {
      id: db.catalog.nextTableId,
      name: stmt.name,
      rootPage: tree.root,
      columns,
      rowidPkCol,
      maxRowid: 0,
      rowCount: 0,
    };
    db.catalog.addTable(table);
    // implicit unique indexes for UNIQUE / non-rowid PK columns
    let seq = 0;
    for (let i = 0; i < columns.length; i++) {
      const needUnique = columns[i].unique || (columns[i].pk && i !== rowidPkCol);
      if (!needUnique) continue;
      const ixTree = await BTree.create(db.pager);
      db.catalog.addIndex({
        id: db.catalog.nextIndexId,
        name: 'sqlite_autoindex_' + table.name + '_' + (seq++),
        tableId: table.id,
        rootPage: ixTree.root,
        columns: [i],
        unique: true,
        implicit: true,
      });
    }
    await saveCatalog(db.pager, db.catalog);
    return;
  }
  if (stmt.kind === 'dropTable') {
    const t = db.catalog.getTable(stmt.name);
    if (!t) {
      if (stmt.ifExists) return;
      throw new Error('no such table: ' + stmt.name);
    }
    db.catalog.dropTable(stmt.name);
    db.forgetTree(t.id);
    await saveCatalog(db.pager, db.catalog);
    return;
  }
  if (stmt.kind === 'createIndex') {
    const existing = db.catalog.getIndex(stmt.name);
    if (existing) {
      if (stmt.ifNotExists) return;
      throw new Error('index ' + stmt.name + ' already exists');
    }
    const table = db.catalog.requireTable(stmt.table);
    const cols = stmt.columns.map(c => {
      const i = db.catalog.columnIndex(table, c.name);
      if (i < 0) throw new Error('no such column: ' + c.name);
      return i;
    });
    const tree = await BTree.create(db.pager);
    const ix = {
      id: db.catalog.nextIndexId,
      name: stmt.name,
      tableId: table.id,
      rootPage: tree.root,
      columns: cols,
      unique: stmt.unique,
      implicit: false,
    };
    // populate from existing rows
    for await (const { rowid, values } of scanTable(db, txn, table)) {
      if (stmt.unique) {
        const keyVals = cols.map(ci => values[ci]);
        if (!keyVals.some(v => v === null)) {
          if (await hasVisibleKey(db, txn, table, ix, keyVals)) {
            throw new Error('UNIQUE constraint failed while building index ' + stmt.name);
          }
        }
      }
      await db.indexTree(ix).put(indexKey(ix, values, rowid), encodeRowIdKey(rowid));
    }
    db.catalog.addIndex(ix);
    await saveCatalog(db.pager, db.catalog);
    return;
  }
  // dropIndex
  const ix = db.catalog.getIndex(stmt.name);
  if (!ix) {
    if (stmt.ifExists) return;
    throw new Error('no such index: ' + stmt.name);
  }
  if (ix.implicit) throw new Error('cannot drop implicit index ' + stmt.name);
  db.catalog.dropIndex(stmt.name);
  db.forgetTree(ix.id);
  await saveCatalog(db.pager, db.catalog);
}

export async function runExplain(
  db: Database, _txn: Transaction, stmt: Stmt,
): Promise<QueryResult> {
  void _txn;
  if (stmt.kind !== 'select') throw new Error('EXPLAIN only supports SELECT here');
  const pq = planSelect(db, stmt);
  const lines: string[] = [];
  const print = (p: Plan, depth: number): void => {
    const pad = '  '.repeat(depth);
    switch (p.kind) {
      case 'scan':
        lines.push(pad + 'SCAN ' + p.table.name + ' AS ' + p.alias +
          (p.index ? ' USING INDEX ' + p.index.name : ''));
        break;
      case 'filter': lines.push(pad + 'FILTER'); print(p.input, depth + 1); break;
      case 'project':
        lines.push(pad + 'PROJECT ' + p.items.map(i => i.alias).join(', '));
        print(p.input, depth + 1);
        break;
      case 'join':
        lines.push(pad + p.joinType + ' JOIN (nested loop)');
        print(p.left, depth + 1); print(p.right, depth + 1);
        break;
      case 'hashjoin':
        lines.push(pad + p.joinType + ' JOIN (hash)');
        print(p.left, depth + 1); print(p.right, depth + 1);
        break;
      case 'aggregate': lines.push(pad + 'AGGREGATE'); print(p.input, depth + 1); break;
      case 'sort': lines.push(pad + 'SORT'); print(p.input, depth + 1); break;
      case 'limit': lines.push(pad + 'LIMIT'); print(p.input, depth + 1); break;
      case 'distinct': lines.push(pad + 'DISTINCT'); print(p.input, depth + 1); break;
      case 'setop':
        lines.push(pad + p.op + (p.all ? ' ALL' : ''));
        print(p.left, depth + 1); print(p.right, depth + 1);
        break;
    }
  };
  print(pq.plan, 0);
  return { columns: ['plan'], rows: lines.map(l => [l]) };
}
