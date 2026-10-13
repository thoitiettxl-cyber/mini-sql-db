// Expression evaluation with SQLite-compatible semantics.
import type { Database, Transaction } from './db.js';
import type { Expr, SelectStmt } from './ast.js';
import {
  SqlValue, Affinity, applyAffinity, compareValues, sqlEquals, isTruthy,
  sqlAdd, sqlSub, sqlMul, sqlDiv, sqlMod, sqlNeg, sqlConcat, sqlCast,
  sqlLike, sqlGlob, toText, textToNumber,
} from './value.js';

/** An execution row: keys are lowercased qualified names (alias.column) or bare aliases. */
export type Row = { [key: string]: SqlValue };

/** Trimmed subquery result: rows contain exactly `columns` (lowercased). */
export interface SubqueryResult {
  columns: string[];
  rows: Row[];
}

export interface EvalCtx {
  db: Database;
  txn: Transaction;
  /** innermost scope first; outer scopes enable correlated subqueries */
  scopes: Row[];
  /** qualified column name (lowercased) -> column affinity, for comparisons */
  affinities: Map<string, Affinity>;
  /** uncorrelated subquery results, cached per Expr node */
  subCache: Map<Expr, Row[]>;
  /** executes a subquery plan with the given outer scopes (set by executor) */
  execSubquery: (sub: SelectStmt, outerScopes: Row[]) => Promise<SubqueryResult>;
}

export function colKey(table: string | null, column: string): string {
  return (table ? table + '.' + column : column).toLowerCase();
}

/** Resolve a column reference across scopes. Returns value + qualified key. */
export function resolveCol(
  table: string | null, column: string, scopes: Row[],
): { value: SqlValue; key: string } {
  const col = column.toLowerCase();
  if (table) {
    const key = (table + '.' + column).toLowerCase();
    for (const scope of scopes) {
      if (key in scope) return { value: scope[key], key };
    }
    throw new Error('no such column: ' + table + '.' + column);
  }
  for (const scope of scopes) {
    if (col in scope) return { value: scope[col], key: col };
    const suffix = '.' + col;
    for (const k of Object.keys(scope)) {
      if (k.endsWith(suffix)) return { value: scope[k], key: k };
    }
  }
  throw new Error('no such column: ' + column);
}

const isNumAff = (a: Affinity | undefined) =>
  a === 'INTEGER' || a === 'REAL' || a === 'NUMERIC';

/** Comparison with SQLite affinity rules. Returns -1|0|1 or null. */
export function compareWithAffinity(
  a: SqlValue, affA: Affinity | undefined, b: SqlValue, affB: Affinity | undefined,
): number | null {
  if (a === null || b === null) return null;
  let aa: SqlValue = a;
  let bb: SqlValue = b;
  if (affA && isNumAff(affA) && (!affB || affB === 'TEXT' || affB === 'BLOB')) {
    bb = applyAffinity(b, 'NUMERIC');
  } else if (affB && isNumAff(affB) && (!affA || affA === 'TEXT' || affA === 'BLOB')) {
    aa = applyAffinity(a, 'NUMERIC');
  } else if (affA === 'TEXT' && !affB) {
    bb = applyAffinity(b, 'TEXT');
  } else if (affB === 'TEXT' && !affA) {
    aa = applyAffinity(a, 'TEXT');
  }
  return compareValues(aa, bb);
}

function affinityOfExpr(e: Expr, ctx: EvalCtx): Affinity | undefined {
  if (e.kind !== 'col') return undefined;
  try {
    const { key } = resolveCol(e.table, e.column, ctx.scopes);
    return ctx.affinities.get(key);
  } catch {
    return undefined;
  }
}

function sqlOr(a: SqlValue, b: SqlValue): SqlValue {
  const ta = a === null ? null : isTruthy(a);
  const tb = b === null ? null : isTruthy(b);
  if (ta === true || tb === true) return 1;
  if (ta === null || tb === null) return null;
  return 0;
}

function sqlAnd(a: SqlValue, b: SqlValue): SqlValue {
  const ta = a === null ? null : isTruthy(a);
  const tb = b === null ? null : isTruthy(b);
  if (ta === false || tb === false) return 0;
  if (ta === null || tb === null) return null;
  return 1;
}

/** Evaluate an expression against the scope chain. */
export async function evalExpr(e: Expr, ctx: EvalCtx): Promise<SqlValue> {
  switch (e.kind) {
    case 'lit':
      return e.value;
    case 'col': {
      return resolveCol(e.table, e.column, ctx.scopes).value;
    }
    case 'star':
    case 'tableStar':
      throw new Error('unexpected * in expression');
    case 'unop': {
      const v = await evalExpr(e.expr, ctx);
      if (e.op === 'NOT') return v === null ? null : isTruthy(v) ? 0 : 1;
      return sqlNeg(v);
    }
    case 'binop':
      return evalBinop(e.op, e.left, e.right, ctx);
    case 'case': {
      for (const w of e.whens) {
        const c = await evalExpr(w.cond, ctx);
        if (c !== null && isTruthy(c)) return evalExpr(w.val, ctx);
      }
      return e.else ? evalExpr(e.else, ctx) : null;
    }
    case 'cast': {
      const v = await evalExpr(e.expr, ctx);
      return sqlCast(v, e.typeName);
    }
    case 'isNull': {
      const v = await evalExpr(e.expr, ctx);
      return (v === null) !== e.not ? 1 : 0;
    }
    case 'between': {
      const v = await evalExpr(e.expr, ctx);
      const lo = await evalExpr(e.lo, ctx);
      const hi = await evalExpr(e.hi, ctx);
      const aff = affinityOfExpr(e.expr, ctx);
      const c1 = compareWithAffinity(v, aff, lo, affinityOfExpr(e.lo, ctx));
      const c2 = compareWithAffinity(v, aff, hi, affinityOfExpr(e.hi, ctx));
      // v >= lo AND v <= hi  (three-valued)
      const g1: SqlValue = c1 === null ? null : c1 >= 0 ? 1 : 0;
      const g2: SqlValue = c2 === null ? null : c2 <= 0 ? 1 : 0;
      const r = sqlAnd(g1, g2);
      return e.not ? (r === null ? null : r === 1 ? 0 : 1) : r;
    }
    case 'like': {
      const v = await evalExpr(e.expr, ctx);
      const p = await evalExpr(e.pattern, ctx);
      const esc = e.escape ? await evalExpr(e.escape, ctx) : null;
      const r = e.glob ? sqlGlob(v, p) : sqlLike(v, p, esc);
      if (r === null) return null;
      return e.not ? (r === 1 ? 0 : 1) : r;
    }
    case 'inList': {
      const v = await evalExpr(e.expr, ctx);
      const aff = affinityOfExpr(e.expr, ctx);
      let sawNull = false;
      for (const item of e.list) {
        const iv = await evalExpr(item, ctx);
        const c = compareWithAffinity(v, aff, iv, affinityOfExpr(item, ctx));
        if (c === null) { sawNull = true; continue; }
        if (c === 0) return e.not ? 0 : 1;
      }
      if (sawNull) return null;
      return e.not ? 1 : 0;
    }
    case 'inSub':
    case 'exists':
    case 'scalarSub': {
      const res = await evalSubquery(e.sub, ctx);
      const rows = res.rows;
      if (e.kind === 'exists') {
        return (rows.length > 0) !== e.not ? 1 : 0;
      }
      const firstCol = res.columns.length > 0 ? res.columns[0] : null;
      if (e.kind === 'scalarSub') {
        if (rows.length === 0 || firstCol === null) return null;
        return firstCol in rows[0] ? rows[0][firstCol] : null;
      }
      // inSub
      const v = await evalExpr(e.expr, ctx);
      const aff = affinityOfExpr(e.expr, ctx);
      let sawNull = false;
      for (const r of rows) {
        const iv = firstCol !== null && firstCol in r ? r[firstCol] : null;
        const c = compareWithAffinity(v, aff, iv, undefined);
        if (c === null) { sawNull = true; continue; }
        if (c === 0) return e.not ? 0 : 1;
      }
      if (sawNull) return null;
      return e.not ? 1 : 0;
    }
    case 'func':
      return evalFunc(e.name, e.args, e.distinct, ctx);
  }
}

async function evalBinop(
  op: string, left: Expr, right: Expr, ctx: EvalCtx,
): Promise<SqlValue> {
  if (op === 'AND') return sqlAnd(await evalExpr(left, ctx), await evalExpr(right, ctx));
  if (op === 'OR') return sqlOr(await evalExpr(left, ctx), await evalExpr(right, ctx));
  const a = await evalExpr(left, ctx);
  const b = await evalExpr(right, ctx);
  switch (op) {
    case '=': {
      const c = compareWithAffinity(a, affinityOfExpr(left, ctx), b, affinityOfExpr(right, ctx));
      return c === null ? null : c === 0 ? 1 : 0;
    }
    case '<>': {
      const c = compareWithAffinity(a, affinityOfExpr(left, ctx), b, affinityOfExpr(right, ctx));
      return c === null ? null : c === 0 ? 0 : 1;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = compareWithAffinity(a, affinityOfExpr(left, ctx), b, affinityOfExpr(right, ctx));
      if (c === null) return null;
      const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      return ok ? 1 : 0;
    }
    case 'IS': {
      if (a === null && b === null) return 1;
      if (a === null || b === null) return 0;
      return compareValues(a, b) === 0 ? 1 : 0;
    }
    case 'IS NOT': {
      if (a === null && b === null) return 0;
      if (a === null || b === null) return 1;
      return compareValues(a, b) === 0 ? 0 : 1;
    }
    case '||': return sqlConcat(a, b);
    case '+': return sqlAdd(a, b);
    case '-': return sqlSub(a, b);
    case '*': return sqlMul(a, b);
    case '/': return sqlDiv(a, b);
    case '%': return sqlMod(a, b);
    default: throw new Error('unknown operator ' + op);
  }
}

/** Evaluate a subquery; the executor caches uncorrelated subqueries. */
function evalSubquery(sub: SelectStmt, ctx: EvalCtx): Promise<SubqueryResult> {
  return ctx.execSubquery(sub, ctx.scopes);
}

/** Scalar function evaluation (aggregates are handled by the executor). */
async function evalFunc(
  name: string, args: Expr[], distinct: boolean, ctx: EvalCtx,
): Promise<SqlValue> {
  void distinct;
  const vals: SqlValue[] = [];
  for (const a of args) vals.push(await evalExpr(a, ctx));
  const anyNull = vals.some(v => v === null);
  switch (name) {
    case 'abs': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v === 'number') return Math.abs(v);
      const n = textToNumber(toText(v));
      return n === null ? 0 : Math.abs(n);
    }
    case 'coalesce': {
      for (const v of vals) if (v !== null) return v;
      return null;
    }
    case 'ifnull':
      return vals[0] !== null ? vals[0] : vals[1];
    case 'nullif': {
      if (vals[0] === null || vals[1] === null) return vals[0];
      return compareValues(vals[0], vals[1]) === 0 ? null : vals[0];
    }
    case 'length': {
      const v = vals[0];
      if (v === null) return null;
      if (v instanceof Uint8Array) return v.length;
      if (typeof v === 'number') return toText(v).length;
      return [...v].length;
    }
    case 'lower': {
      const v = vals[0];
      return v === null ? null : toText(v).toLowerCase();
    }
    case 'upper': {
      const v = vals[0];
      return v === null ? null : toText(v).toUpperCase();
    }
    case 'substr':
    case 'substring': {
      const v = vals[0];
      if (v === null || vals[1] === null) return null;
      const start = toInt(vals[1]);
      const len = vals.length > 2 ? (vals[2] === null ? null : toInt(vals[2])) : null;
      if (v instanceof Uint8Array) {
        const s = start > 0 ? start - 1 : Math.max(0, v.length + start);
        const e = len === null ? v.length : len < 0 ? v.length : s + len;
        return v.slice(s, Math.max(s, e));
      }
      const s = toText(v);
      const chars = [...s];
      const st = start > 0 ? start - 1 : Math.max(0, chars.length + start);
      if (len === null) return chars.slice(st).join('');
      if (len <= 0) return '';
      return chars.slice(st, st + len).join('');
    }
    case 'trim':
    case 'ltrim':
    case 'rtrim': {
      const v = vals[0];
      if (v === null) return null;
      const s = toText(v);
      const chars = vals.length > 1 && vals[1] !== null ? toText(vals[1]) : ' ';
      const set = new Set([...chars]);
      let a = 0;
      let b = s.length;
      if (name !== 'rtrim') while (a < b && set.has(s[a])) a++;
      if (name !== 'ltrim') while (b > a && set.has(s[b - 1])) b--;
      return s.slice(a, b);
    }
    case 'replace': {
      if (anyNull) return null;
      return toText(vals[0]).split(toText(vals[1])).join(toText(vals[2]));
    }
    case 'instr': {
      if (anyNull) return null;
      const idx = toText(vals[0]).indexOf(toText(vals[1]));
      return idx < 0 ? 0 : idx + 1;
    }
    case 'hex': {
      const v = vals[0];
      if (v === null) return null;
      const bytes = v instanceof Uint8Array ? v : new TextEncoder().encode(toText(v));
      return Buffer.from(bytes).toString('hex').toUpperCase();
    }
    case 'typeof': {
      const v = vals[0];
      if (v === null) return 'null';
      if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'real';
      if (typeof v === 'string') return 'text';
      return 'blob';
    }
    case 'round': {
      const v = vals[0];
      if (v === null) return null;
      const digits = vals.length > 1 && vals[1] !== null ? toInt(vals[1]) : 0;
      const n = typeof v === 'number' ? v : (textToNumber(toText(v)) ?? 0);
      const f = Math.pow(10, digits);
      const r = (n >= 0 ? Math.floor(n * f + 0.5) : Math.ceil(n * f - 0.5)) / f;
      return r === 0 ? 0 : r;
    }
    case 'max':
    case 'min': {
      // multi-argument scalar form: NULL if any argument is NULL
      if (anyNull) return null;
      if (vals.length === 0) return null;
      let best = vals[0];
      for (let i = 1; i < vals.length; i++) {
        const c = compareValues(vals[i], best);
        if ((name === 'max' && c > 0) || (name === 'min' && c < 0)) best = vals[i];
      }
      return best;
    }
    case 'like': {
      if (anyNull) return null;
      const esc = vals.length > 2 ? vals[2] : null;
      return sqlLike(vals[0], vals[1], esc);
    }
    case 'glob': {
      if (anyNull) return null;
      return sqlGlob(vals[0], vals[1]);
    }
    case 'zeroblob': {
      const n = toInt(vals[0]);
      return new Uint8Array(Math.max(0, n));
    }
    case 'sqlite_version':
      return '3.45.0-mini';
    default:
      throw new Error('no such function: ' + name);
  }
}

function toInt(v: SqlValue): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const n = textToNumber(v);
    return n === null ? 0 : Math.trunc(n);
  }
  return 0;
}

/** True for aggregate function names (handled by the executor, not evalExpr). */
export function isAggregate(name: string): boolean {
  return ['count', 'sum', 'avg', 'min', 'max', 'group_concat', 'total'].includes(name);
}
