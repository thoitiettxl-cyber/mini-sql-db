// Abstract syntax tree for the supported SQL dialect.
import type { SqlValue } from './value.js';

export type Expr =
  | { kind: 'lit'; value: SqlValue }
  | { kind: 'col'; table: string | null; column: string }
  | { kind: 'star' }
  | { kind: 'tableStar'; table: string }
  | { kind: 'binop'; op: string; left: Expr; right: Expr }
  | { kind: 'unop'; op: 'NOT' | '-'; expr: Expr }
  | { kind: 'func'; name: string; args: Expr[]; distinct: boolean }
  | { kind: 'case'; whens: { cond: Expr; val: Expr }[]; else: Expr | null }
  | { kind: 'cast'; expr: Expr; typeName: string }
  | { kind: 'inList'; expr: Expr; list: Expr[]; not: boolean }
  | { kind: 'inSub'; expr: Expr; sub: SelectStmt; not: boolean }
  | { kind: 'exists'; sub: SelectStmt; not: boolean }
  | { kind: 'scalarSub'; sub: SelectStmt }
  | { kind: 'between'; expr: Expr; lo: Expr; hi: Expr; not: boolean }
  | { kind: 'isNull'; expr: Expr; not: boolean }
  | { kind: 'like'; expr: Expr; pattern: Expr; escape: Expr | null; not: boolean; glob: boolean };

export interface SelectColumn {
  expr: Expr;
  alias: string | null;
}

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';

export type FromItem =
  | { kind: 'table'; name: string; alias: string }
  | { kind: 'subquery'; sub: SelectStmt; alias: string }
  | {
      kind: 'join';
      left: FromItem;
      right: FromItem;
      joinType: JoinType;
      cond: Expr | null;
      using: string[] | null;
      natural: boolean;
    };

export interface OrderKey {
  expr: Expr;
  desc: boolean;
}

export type SetOp = 'UNION' | 'INTERSECT' | 'EXCEPT';

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  columns: SelectColumn[];
  from: FromItem[];
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderKey[];
  limit: Expr | null;
  offset: Expr | null;
  setOp: { op: SetOp; all: boolean; left: SelectStmt; right: SelectStmt } | null;
}

export interface ColumnDef {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  default: Expr | null;
}

export type InsertSource =
  | { kind: 'values'; rows: Expr[][] }
  | { kind: 'select'; select: SelectStmt };

export type Stmt =
  | SelectStmt
  | { kind: 'insert'; table: string; columns: string[] | null; source: InsertSource }
  | { kind: 'update'; table: string; alias: string; sets: { column: string; expr: Expr }[]; where: Expr | null }
  | { kind: 'delete'; table: string; alias: string; where: Expr | null }
  | { kind: 'createTable'; name: string; columns: ColumnDef[]; ifNotExists: boolean }
  | { kind: 'dropTable'; name: string; ifExists: boolean }
  | { kind: 'createIndex'; name: string; table: string; columns: { name: string; desc: boolean }[]; unique: boolean; ifNotExists: boolean }
  | { kind: 'dropIndex'; name: string; ifExists: boolean }
  | { kind: 'begin' }
  | { kind: 'commit' }
  | { kind: 'rollback' }
  | { kind: 'explain'; stmt: Stmt };

export const AGG_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'group_concat', 'total']);

export function isAggFunc(name: string): boolean {
  return AGG_FUNCS.has(name.toLowerCase());
}

/** Collect all column references in an expression. */
export function collectColumns(e: Expr, out: { table: string | null; column: string }[] = []): { table: string | null; column: string }[] {
  switch (e.kind) {
    case 'col': out.push({ table: e.table, column: e.column }); break;
    case 'binop': collectColumns(e.left, out); collectColumns(e.right, out); break;
    case 'unop': collectColumns(e.expr, out); break;
    case 'func': for (const a of e.args) collectColumns(a, out); break;
    case 'case':
      for (const w of e.whens) { collectColumns(w.cond, out); collectColumns(w.val, out); }
      if (e.else) collectColumns(e.else, out);
      break;
    case 'cast': collectColumns(e.expr, out); break;
    case 'inList':
      collectColumns(e.expr, out);
      for (const x of e.list) collectColumns(x, out);
      break;
    case 'inSub': collectColumns(e.expr, out); collectColumnsFromSelect(e.sub, out); break;
    case 'exists': collectColumnsFromSelect(e.sub, out); break;
    case 'scalarSub': collectColumnsFromSelect(e.sub, out); break;
    case 'between':
      collectColumns(e.expr, out); collectColumns(e.lo, out); collectColumns(e.hi, out);
      break;
    case 'isNull': collectColumns(e.expr, out); break;
    case 'like':
      collectColumns(e.expr, out); collectColumns(e.pattern, out);
      if (e.escape) collectColumns(e.escape, out);
      break;
    default: break;
  }
  return out;
}

export function collectColumnsFromSelect(s: SelectStmt, out: { table: string | null; column: string }[] = []): { table: string | null; column: string }[] {
  for (const c of s.columns) collectColumns(c.expr, out);
  for (const f of s.from) collectColumnsFromItem(f, out);
  if (s.where) collectColumns(s.where, out);
  for (const g of s.groupBy) collectColumns(g, out);
  if (s.having) collectColumns(s.having, out);
  for (const o of s.orderBy) collectColumns(o.expr, out);
  if (s.limit) collectColumns(s.limit, out);
  if (s.offset) collectColumns(s.offset, out);
  if (s.setOp) {
    collectColumnsFromSelect(s.setOp.left, out);
    collectColumnsFromSelect(s.setOp.right, out);
  }
  return out;
}

function collectColumnsFromItem(f: FromItem, out: { table: string | null; column: string }[]): void {
  if (f.kind === 'table') return;
  if (f.kind === 'subquery') { collectColumnsFromSelect(f.sub, out); return; }
  collectColumnsFromItem(f.left, out);
  collectColumnsFromItem(f.right, out);
  if (f.cond) collectColumns(f.cond, out);
}

/** True when the expression contains an aggregate function call. */
export function containsAgg(e: Expr): boolean {
  switch (e.kind) {
    case 'func':
      if (isAggFunc(e.name)) return true;
      return e.args.some(containsAgg);
    case 'binop': return containsAgg(e.left) || containsAgg(e.right);
    case 'unop': return containsAgg(e.expr);
    case 'case':
      return e.whens.some(w => containsAgg(w.cond) || containsAgg(w.val)) || (e.else ? containsAgg(e.else) : false);
    case 'cast': return containsAgg(e.expr);
    case 'inList': return containsAgg(e.expr) || e.list.some(containsAgg);
    case 'between': return containsAgg(e.expr) || containsAgg(e.lo) || containsAgg(e.hi);
    case 'isNull': return containsAgg(e.expr);
    case 'like': return containsAgg(e.expr) || containsAgg(e.pattern);
    default: return false;
  }
}

/** True when the expression references no tables/columns (after alias resolution). */
export function isConstant(e: Expr): boolean {
  return collectColumns(e).length === 0;
}
