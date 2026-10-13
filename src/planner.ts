// Query planner: SQL AST -> executable plan tree, with basic optimizations:
// predicate pushdown, index selection, join reordering, hash-join choice,
// constant folding, and subquery planning (with correlation detection).
import type { Database } from './db.js';
import * as ast from './ast.js';
import type { Expr, SelectStmt, FromItem, JoinType } from './ast.js';
import type { TableInfo, IndexInfo } from './catalog.js';
import { SqlValue, Affinity, applyAffinity } from './value.js';

export interface AggSpec {
  func: string;
  arg: Expr | null; // null for COUNT(*)
  distinct: boolean;
  alias: string;
}

export interface ProjectItem {
  expr: Expr;
  alias: string;
}

export type Plan =
  | { kind: 'scan'; table: TableInfo; alias: string; index: IndexInfo | null; lo: SqlValue[] | null; loInc: boolean; hi: SqlValue[] | null; hiInc: boolean }
  | { kind: 'filter'; input: Plan; predicate: Expr }
  | { kind: 'project'; input: Plan; items: ProjectItem[] }
  | { kind: 'join'; left: Plan; right: Plan; joinType: JoinType; cond: Expr | null }
  | { kind: 'hashjoin'; left: Plan; right: Plan; joinType: 'INNER' | 'LEFT'; leftKeys: Expr[]; rightKeys: Expr[]; residual: Expr | null }
  | { kind: 'aggregate'; input: Plan; groupBy: Expr[]; aggs: AggSpec[]; having: Expr | null }
  | { kind: 'sort'; input: Plan; keys: { expr: Expr; desc: boolean }[] }
  | { kind: 'limit'; input: Plan; limit: Expr | null; offset: Expr | null }
  | { kind: 'distinct'; input: Plan }
  | { kind: 'setop'; op: 'UNION' | 'INTERSECT' | 'EXCEPT'; all: boolean; left: Plan; right: Plan };

export interface SubPlan {
  node: SelectStmt;
  plan: Plan;
  correlated: boolean;
}

export interface PlannedQuery {
  plan: Plan;
  affinities: Map<string, Affinity>;
  subs: SubPlan[];
  outputColumns: string[];
}

interface Ctx {
  db: Database;
  affinities: Map<string, Affinity>;
  subs: SubPlan[];
  /** tables in scope: alias (lower) -> { table, columns } */
  scopeTables: Map<string, { table: TableInfo | null; columns: string[] }>;
  /** memoised subquery plans (shared across child contexts) */
  planCache: Map<SelectStmt, Plan>;
}

function childCtx(ctx: Ctx): Ctx {
  return {
    db: ctx.db,
    affinities: ctx.affinities,
    subs: ctx.subs,
    scopeTables: new Map(),
    planCache: ctx.planCache,
  };
}

/** Split a predicate into AND conjuncts. */
export function conjuncts(e: Expr | null): Expr[] {
  if (!e) return [];
  if (e.kind === 'binop' && e.op === 'AND') return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

export function andAll(exprs: Expr[]): Expr | null {
  if (exprs.length === 0) return null;
  let out = exprs[0];
  for (let i = 1; i < exprs.length; i++) out = { kind: 'binop', op: 'AND', left: out, right: exprs[i] };
  return out;
}

/** Canonical string key for structural expression equality. */
export function exprKey(e: Expr): string {
  switch (e.kind) {
    case 'lit':
      return 'lit:' + JSON.stringify(e.value instanceof Uint8Array ? [...e.value] : e.value);
    case 'col':
      return 'col:' + (e.table ? e.table.toLowerCase() + '.' : '') + e.column.toLowerCase();
    case 'binop':
      return 'binop:' + e.op + '(' + exprKey(e.left) + ',' + exprKey(e.right) + ')';
    case 'unop':
      return 'unop:' + e.op + '(' + exprKey(e.expr) + ')';
    case 'func':
      return 'func:' + e.name + (e.distinct ? ':d' : '') + '(' + e.args.map(exprKey).join(',') + ')';
    case 'case':
      return 'case:' + e.whens.map(w => exprKey(w.cond) + '=>' + exprKey(w.val)).join(';') +
        (e.else ? '|else:' + exprKey(e.else) : '');
    case 'cast':
      return 'cast:' + e.typeName + '(' + exprKey(e.expr) + ')';
    case 'isNull':
      return 'isnull:' + (e.not ? 'not:' : '') + exprKey(e.expr);
    case 'between':
      return 'between:' + (e.not ? 'not:' : '') + exprKey(e.expr) + ',' + exprKey(e.lo) + ',' + exprKey(e.hi);
    case 'like':
      return 'like:' + (e.not ? 'not:' : '') + (e.glob ? 'glob:' : '') + exprKey(e.expr) + ',' + exprKey(e.pattern);
    case 'inList':
      return 'inlist:' + (e.not ? 'not:' : '') + exprKey(e.expr);
    default:
      return e.kind + ':?';
  }
}

/** Substitute subexpressions matching group keys with their aggregate output refs. */
export function substituteGroupKeys(e: Expr, map: Map<string, Expr>): Expr {
  const k = exprKey(e);
  const rep = map.get(k);
  if (rep) return rep;
  switch (e.kind) {
    case 'binop':
      return { ...e, left: substituteGroupKeys(e.left, map), right: substituteGroupKeys(e.right, map) };
    case 'unop':
      return { ...e, expr: substituteGroupKeys(e.expr, map) };
    case 'func':
      return { ...e, args: e.args.map(a => substituteGroupKeys(a, map)) };
    case 'case':
      return {
        ...e,
        whens: e.whens.map(w => ({ cond: substituteGroupKeys(w.cond, map), val: substituteGroupKeys(w.val, map) })),
        else: e.else ? substituteGroupKeys(e.else, map) : null,
      };
    case 'cast':
      return { ...e, expr: substituteGroupKeys(e.expr, map) };
    case 'isNull':
      return { ...e, expr: substituteGroupKeys(e.expr, map) };
    case 'between':
      return {
        ...e,
        expr: substituteGroupKeys(e.expr, map),
        lo: substituteGroupKeys(e.lo, map),
        hi: substituteGroupKeys(e.hi, map),
      };
    case 'like':
      return { ...e, expr: substituteGroupKeys(e.expr, map), pattern: substituteGroupKeys(e.pattern, map) };
    default:
      return e;
  }
}

/** Plan a SELECT statement. */
export function planSelect(db: Database, stmt: SelectStmt): PlannedQuery {
  const ctx: Ctx = {
    db,
    affinities: new Map(),
    subs: [],
    scopeTables: new Map(),
    planCache: new Map(),
  };
  const plan = planSelectInner(stmt, ctx);
  return { plan, affinities: ctx.affinities, subs: ctx.subs, outputColumns: outputColumnsOf(plan, ctx) };
}

function planSelectInner(stmt: SelectStmt, ctx: Ctx): Plan {
  if (stmt.setOp) {
    const left = planSelectInner(stmt.setOp.left, ctx);
    const right = planSelectInner(stmt.setOp.right, ctx);
    let plan: Plan = {
      kind: 'setop', op: stmt.setOp.op, all: stmt.setOp.all, left, right,
    };
    plan = applyOrderLimit(plan, stmt, ctx, null);
    return plan;
  }
  // FROM
  let plan = planFrom(stmt.from, ctx);
  // WHERE with pushdown
  const pushed = pushPredicates(plan, conjuncts(stmt.where), ctx);
  plan = pushed.plan;
  const remaining = pushed.remaining;
  if (remaining.length > 0) plan = { kind: 'filter', input: plan, predicate: andAll(remaining)! };
  // Aggregation?
  const needsAgg = stmt.groupBy.length > 0 ||
    stmt.columns.some(c => ast.containsAgg(c.expr)) ||
    (stmt.having !== null && ast.containsAgg(stmt.having));
  // plan subqueries inside SELECT list / HAVING now (they may be correlated)
  const groupMap = new Map<string, Expr>();
  if (needsAgg) {
    const groupBy = stmt.groupBy.map(g => g);
    const aggs: AggSpec[] = [];
    const aggMap = new Map<string, string>();
    const selectItems = planProjectItems(stmt.columns, ctx, null);
    for (const item of selectItems) collectAggs(item.expr, aggs, aggMap, ctx);
    if (stmt.having) collectAggs(stmt.having, aggs, aggMap, ctx);
    groupBy.forEach((g, i) => groupMap.set(exprKey(g), { kind: 'col', table: null, column: '__gb' + i }));
    plan = {
      kind: 'aggregate', input: plan, groupBy,
      aggs,
      having: stmt.having ? substituteAggs(substituteGroupKeys(stmt.having, groupMap), aggMap) : null,
    };
    // project the select list (with group key + aggregate substitution)
    const items = selectItems.map(it => ({
      expr: substituteAggs(substituteGroupKeys(it.expr, groupMap), aggMap),
      alias: it.alias,
    }));
    plan = { kind: 'project', input: plan, items };
  } else {
    if (stmt.having) throw new Error('HAVING without GROUP BY requires aggregates');
    const items = planProjectItems(stmt.columns, ctx, null);
    plan = { kind: 'project', input: plan, items };
  }
  if (stmt.distinct) plan = { kind: 'distinct', input: plan };
  plan = applyOrderLimit(plan, stmt, ctx, stmt.columns);
  return plan;
}

/** Output column names of a plan (best effort, for subquery scoping). */
export function outputColumnsOf(plan: Plan, _ctx?: Ctx): string[] {
  switch (plan.kind) {
    case 'project': return plan.items.map(i => i.alias);
    case 'scan': return plan.table.columns.map(c => c.name);
    case 'aggregate': return [...plan.groupBy.map((_, i) => '__gb' + i), ...plan.aggs.map(a => a.alias)];
    case 'setop': return outputColumnsOf(plan.left, _ctx);
    case 'filter':
    case 'sort':
    case 'limit':
    case 'distinct':
      return outputColumnsOf(plan.input, _ctx);
    case 'join':
    case 'hashjoin':
      return [...outputColumnsOf(plan.left, _ctx), ...outputColumnsOf(plan.right, _ctx)];
  }
}

/** Plan the FROM clause into a left-deep join tree. */
function planFrom(items: FromItem[], ctx: Ctx): Plan {
  if (items.length === 0) {
    // SELECT without FROM: single empty row
    return { kind: 'project', input: dummyScan(), items: [] };
  }
  let plan = planFromItem(items[0], ctx);
  for (let i = 1; i < items.length; i++) {
    const right = planFromItem(items[i], ctx);
    plan = makeJoin(plan, right, 'CROSS', null, ctx);
  }
  return plan;
}

/** A scan node producing one empty row (for SELECT without FROM). */
function dummyScan(): Plan {
  return {
    kind: 'scan',
    table: {
      id: -1, name: '__dummy', rootPage: -1, columns: [],
      rowidPkCol: -1, maxRowid: 0, rowCount: 1,
    },
    alias: '',
    index: null, lo: null, loInc: true, hi: null, hiInc: true,
  };
}

function planFromItem(item: FromItem, ctx: Ctx): Plan {
  switch (item.kind) {
    case 'table': {
      const table = ctx.db.catalog.requireTable(item.name);
      const alias = item.alias;
      ctx.scopeTables.set(alias.toLowerCase(), { table, columns: table.columns.map(c => c.name) });
      for (const c of table.columns) {
        ctx.affinities.set((alias + '.' + c.name).toLowerCase(), c.affinity);
      }
      return {
        kind: 'scan', table, alias, index: null,
        lo: null, loInc: true, hi: null, hiInc: true,
      };
    }
    case 'subquery': {
      const sub = planCachedSubquery(item.sub, ctx);
      const cols = outputColumnsOf(sub, ctx);
      ctx.scopeTables.set(item.alias.toLowerCase(), { table: null, columns: cols });
      // wrap so the subquery's rows are namespaced under its alias
      return { kind: 'project', input: sub, items: cols.map(c => ({ expr: { kind: 'col', table: null, column: c } as Expr, alias: c })) };
    }
    case 'join': {
      const left = planFromItem(item.left, ctx);
      const right = planFromItem(item.right, ctx);
      let cond = item.cond;
      let joinType = item.joinType;
      if (item.natural || item.using) {
        const using = item.using || naturalColumns(item.left, item.right, ctx);
        cond = andAll([
          ...(cond ? [cond] : []),
          ...using.map(col => ({
            kind: 'binop', op: '=',
            left: { kind: 'col', table: leftAlias(item.left), column: col },
            right: { kind: 'col', table: leftAlias(item.right), column: col },
          } as Expr)),
        ]);
      }
      if (joinType === 'RIGHT') {
        // convert to LEFT with swapped sides
        return makeJoin(right, left, 'LEFT', cond ? swapSides(cond) : null, ctx);
      }
      return makeJoin(left, right, joinType, cond, ctx);
    }
  }
}

function leftAlias(item: FromItem): string {
  if (item.kind === 'table') return item.alias;
  if (item.kind === 'subquery') return item.alias;
  return leftAlias(item.right);
}

function naturalColumns(left: FromItem, right: FromItem, ctx: Ctx): string[] {
  const lc = columnsOfItem(left, ctx).map(c => c.toLowerCase());
  const rc = columnsOfItem(right, ctx);
  const lset = new Set(lc);
  return rc.filter(c => lset.has(c.toLowerCase()));
}

function columnsOfItem(item: FromItem, ctx: Ctx): string[] {
  if (item.kind === 'table') {
    return ctx.db.catalog.requireTable(item.name).columns.map(c => c.name);
  }
  if (item.kind === 'subquery') {
    return outputColumnsOf(planCachedSubquery(item.sub, ctx), ctx);
  }
  return [...columnsOfItem(item.left, ctx), ...columnsOfItem(item.right, ctx)];
}

/** Swap left/right of equality conditions (for RIGHT -> LEFT conversion). */
function swapSides(e: Expr): Expr {
  if (e.kind === 'binop' && (e.op === '=' || e.op === '<>')) {
    return { kind: 'binop', op: e.op, left: swapSides(e.right), right: swapSides(e.left) };
  }
  if (e.kind === 'binop' && e.op === 'AND') {
    return { kind: 'binop', op: 'AND', left: swapSides(e.left), right: swapSides(e.right) };
  }
  return e;
}

/** Build a join node: reorder INNER joins by size, pick hash vs nested loop. */
function makeJoin(left: Plan, right: Plan, joinType: JoinType, cond: Expr | null, ctx: Ctx): Plan {
  // plan subqueries inside the join condition now
  if (cond) planSubsInExpr(cond, ctx);
  if (joinType === 'INNER' || joinType === 'CROSS') {
    // join ordering: smaller side first (left-deep)
    if (estimateRows(right) < estimateRows(left)) {
      const tmp = left;
      left = right;
      right = tmp;
    }
  }
  if (joinType === 'INNER' || joinType === 'LEFT') {
    const eq = extractEquiJoinKeys(cond, left, right);
    if (eq && eq.leftKeys.length > 0) {
      return {
        kind: 'hashjoin', left, right,
        joinType: joinType as 'INNER' | 'LEFT',
        leftKeys: eq.leftKeys, rightKeys: eq.rightKeys, residual: eq.residual,
      };
    }
  }
  if (joinType === 'FULL') {
    // FULL = LEFT + (RIGHT anti) via union; implemented directly by executor
    return { kind: 'join', left, right, joinType, cond };
  }
  return { kind: 'join', left, right, joinType, cond };
}

function estimateRows(plan: Plan): number {
  switch (plan.kind) {
    case 'scan': return Math.max(1, plan.table.rowCount);
    case 'filter': return estimateRows(plan.input);
    case 'project':
    case 'sort':
    case 'limit':
    case 'distinct':
      return estimateRows(plan.input);
    case 'join':
    case 'hashjoin':
      return estimateRows(plan.left) * estimateRows(plan.right);
    case 'aggregate': return Math.max(1, Math.min(1000, estimateRows(plan.input) / 10));
    case 'setop': return estimateRows(plan.left) + estimateRows(plan.right);
  }
}

/** Extract equi-join keys (a = b) where a comes from left, b from right. */
function extractEquiJoinKeys(
  cond: Expr | null, left: Plan, right: Plan,
): { leftKeys: Expr[]; rightKeys: Expr[]; residual: Expr | null } | null {
  if (!cond) return null;
  const leftTables = tablesInPlan(left);
  const rightTables = tablesInPlan(right);
  const leftKeys: Expr[] = [];
  const rightKeys: Expr[] = [];
  const residual: Expr[] = [];
  for (const c of conjuncts(cond)) {
    if (c.kind === 'binop' && c.op === '=') {
      const lt = tablesInExpr(c.left);
      const rt = tablesInExpr(c.right);
      const lInLeft = [...lt].every(t => leftTables.has(t)) && lt.size > 0;
      const rInRight = [...rt].every(t => rightTables.has(t)) && rt.size > 0;
      const lInRight = [...lt].every(t => rightTables.has(t)) && lt.size > 0;
      const rInLeft = [...rt].every(t => leftTables.has(t)) && rt.size > 0;
      if (lInLeft && rInRight && !isConstantSide(c.left) && !isConstantSide(c.right)) {
        leftKeys.push(c.left);
        rightKeys.push(c.right);
        continue;
      }
      if (lInRight && rInLeft && !isConstantSide(c.left) && !isConstantSide(c.right)) {
        leftKeys.push(c.right);
        rightKeys.push(c.left);
        continue;
      }
    }
    residual.push(c);
  }
  if (leftKeys.length === 0) return null;
  return { leftKeys, rightKeys, residual: andAll(residual) };
}

function isConstantSide(e: Expr): boolean {
  return ast.collectColumns(e).length === 0;
}

/** Table aliases referenced by an expression. */
function tablesInExpr(e: Expr): Set<string> {
  const out = new Set<string>();
  for (const c of ast.collectColumns(e)) {
    if (c.table) out.add(c.table.toLowerCase());
  }
  return out;
}

/** Table aliases produced by a plan subtree. */
function tablesInPlan(plan: Plan): Set<string> {
  const out = new Set<string>();
  const walk = (p: Plan): void => {
    if (p.kind === 'scan') {
      if (p.alias) out.add(p.alias.toLowerCase());
      return;
    }
    if (p.kind === 'project' || p.kind === 'filter' || p.kind === 'sort' ||
        p.kind === 'limit' || p.kind === 'distinct' || p.kind === 'aggregate') {
      walk(p.input);
      return;
    }
    if (p.kind === 'join' || p.kind === 'hashjoin' || p.kind === 'setop') {
      walk(p.left);
      walk(p.right);
    }
  };
  walk(plan);
  return out;
}

/** Predicate pushdown: push conjuncts to the deepest applicable node; pick indexes. */
function pushPredicates(
  plan: Plan, preds: Expr[], ctx: Ctx,
): { plan: Plan; remaining: Expr[] } {
  // fold constants and plan subqueries inside predicates first
  preds.forEach(p => planSubsInExpr(p, ctx));
  if (plan.kind === 'scan') {
    const { node, rest } = chooseIndex(plan, preds, ctx);
    return { plan: node, remaining: rest };
  }
  if (plan.kind === 'join' || plan.kind === 'hashjoin') {
    const leftTables = tablesInPlan(plan.left);
    const rightTables = tablesInPlan(plan.right);
    const forLeft: Expr[] = [];
    const forRight: Expr[] = [];
    const keep: Expr[] = [];
    for (const p of preds) {
      const ts = tablesInExpr(p);
      if (ts.size > 0 && [...ts].every(t => leftTables.has(t))) forLeft.push(p);
      else if (ts.size > 0 && [...ts].every(t => rightTables.has(t))) forRight.push(p);
      else keep.push(p);
    }
    const l = pushPredicates(plan.left, forLeft, ctx);
    const r = pushPredicates(plan.right, forRight, ctx);
    return {
      plan: { ...plan, left: l.plan, right: r.plan },
      remaining: [...l.remaining, ...r.remaining, ...keep],
    };
  }
  return { plan, remaining: preds };
}

/** Index selection for a single-table scan given pushed predicates. */
function chooseIndex(
  scan: Extract<Plan, { kind: 'scan' }>, preds: Expr[], ctx: Ctx,
): { node: Plan; rest: Expr[] } {
  const table = scan.table;
  if (table.id < 0) return { node: scan, rest: preds }; // dummy scan
  const indexes = ctx.db.catalog.indexesForTable(table.id);
  // candidate: equality prefix on index columns, optional one range bound
  let best: {
    ix: IndexInfo; eq: Map<number, SqlValue>; lo: SqlValue[] | null; loInc: boolean;
    hi: SqlValue[] | null; hiInc: boolean; used: Set<Expr>; nEq: number;
  } | null = null;
  for (const ix of indexes) {
    const eq = new Map<number, SqlValue>();
    const used = new Set<Expr>();
    let lo: SqlValue[] | null = null;
    let loInc = true;
    let hi: SqlValue[] | null = null;
    let hiInc = true;
    let nEq = 0;
    let stopped = false;
    for (let ci = 0; ci < ix.columns.length && !stopped; ci++) {
      const colIdx = ix.columns[ci];
      const colName = table.columns[colIdx].name;
      const colAff = table.columns[colIdx].affinity;
      let found = false;
      for (const p of preds) {
        if (used.has(p)) continue;
        const m = matchColOp(p, scan.alias, colName);
        if (!m || m.value === undefined) continue;
        m.value = applyAffinity(m.value, colAff);
        if (m.op === '=') {
          eq.set(colIdx, m.value);
          used.add(p);
          nEq++;
          found = true;
          break;
        }
        // range on the first non-equality column only
        if (nEq === ci) {
          const vals = [...eq.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
          if (m.op === '>' || m.op === '>=') { lo = [...vals, m.value]; loInc = m.op === '>='; }
          else if (m.op === '<' || m.op === '<=') { hi = [...vals, m.value]; hiInc = m.op === '<='; }
          else continue;
          used.add(p);
          stopped = true;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    if (nEq > 0 || lo || hi) {
      if (!best || nEq > best.nEq) best = { ix, eq, lo, loInc, hi, hiInc, used, nEq };
    }
  }
  if (!best) return { node: scan, rest: preds };
  // fold equality prefix into bounds when there is no separate range
  let { lo, loInc, hi, hiInc } = best;
  const eqVals = [...best.eq.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if (eqVals.length > 0 && !lo && !hi) {
    lo = eqVals; loInc = true;
    hi = eqVals; hiInc = true;
  }
  const rest = preds.filter(p => !best!.used.has(p));
  const node: Plan = {
    ...scan, index: best.ix, lo, loInc, hi, hiInc,
  };
  return { node, rest };
}

/** Match `alias.col OP const` (or `const OP alias.col` with flipped op). */
function matchColOp(
  p: Expr, alias: string, colName: string,
): { op: string; value: SqlValue } | null {
  if (p.kind !== 'binop') return null;
  if (['=', '<', '<=', '>', '>='].indexOf(p.op) < 0) return null;
  const al = alias.toLowerCase();
  const cn = colName.toLowerCase();
  const isCol = (e: Expr) =>
    e.kind === 'col' && e.column.toLowerCase() === cn &&
    (!e.table || e.table.toLowerCase() === al);
  const flip = (op: string) =>
    op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : op === '>=' ? '<=' : op;
  if (isCol(p.left) && p.right.kind === 'lit') return { op: p.op, value: p.right.value };
  if (isCol(p.right) && p.left.kind === 'lit') return { op: flip(p.op), value: p.left.value };
  return null;
}

/** Expand the SELECT list: stars, aliases, subquery planning. */
function planProjectItems(
  columns: ast.SelectColumn[], ctx: Ctx, _groupMap: Map<string, Expr> | null,
): ProjectItem[] {
  const items: ProjectItem[] = [];
  let n = 0;
  for (const c of columns) {
    n++;
    if (c.expr.kind === 'star') {
      for (const [alias, t] of ctx.scopeTables) {
        for (const col of t.columns) {
          const expr: Expr = { kind: 'col', table: t.table ? alias : null, column: col };
          items.push({ expr, alias: col });
        }
      }
      continue;
    }
    if (c.expr.kind === 'tableStar') {
      const t = ctx.scopeTables.get(c.expr.table.toLowerCase());
      if (!t) throw new Error('no such table: ' + c.expr.table);
      for (const col of t.columns) {
        const expr: Expr = { kind: 'col', table: t.table ? c.expr.table : null, column: col };
        items.push({ expr, alias: col });
      }
      continue;
    }
    planSubsInExpr(c.expr, ctx);
    const alias = c.alias || defaultAlias(c.expr, n);
    items.push({ expr: c.expr, alias });
  }
  return items;
}

function defaultAlias(e: Expr, n: number): string {
  if (e.kind === 'col') return e.column;
  return 'column' + n;
}

/** ORDER BY / LIMIT / OFFSET. selectColumns is null for compound right sides. */
function applyOrderLimit(
  plan: Plan, stmt: SelectStmt, ctx: Ctx, selectColumns: ast.SelectColumn[] | null,
): Plan {
  if (stmt.orderBy.length > 0) {
    const keys = stmt.orderBy.map(o => {
      let expr = o.expr;
      // ordinal?
      if (expr.kind === 'lit' && typeof expr.value === 'number' &&
          Number.isInteger(expr.value) && selectColumns) {
        const idx = (expr.value as number) - 1;
        if (idx < 0 || idx >= selectColumns.length) throw new Error('ORDER BY ordinal out of range');
        const sc = selectColumns[idx];
        expr = sc.alias
          ? { kind: 'col', table: null, column: sc.alias } as Expr
          : sc.expr;
      } else if (expr.kind === 'col' && !expr.table && selectColumns) {
        // output alias?
        const want = expr.column.toLowerCase();
        const matchCol: ast.SelectColumn | undefined = selectColumns.find(sc => {
          let nm: string | null = sc.alias;
          if (nm === null && sc.expr.kind === 'col') nm = sc.expr.column;
          return nm !== null && nm.toLowerCase() === want;
        });
        if (matchCol) expr = matchCol.expr;
      }
      planSubsInExpr(expr, ctx);
      return { expr, desc: o.desc };
    });
    plan = { kind: 'sort', input: plan, keys };
  }
  if (stmt.limit || stmt.offset) {
    if (stmt.limit) planSubsInExpr(stmt.limit, ctx);
    if (stmt.offset) planSubsInExpr(stmt.offset, ctx);
    plan = { kind: 'limit', input: plan, limit: stmt.limit, offset: stmt.offset };
  }
  return plan;
}

/** Collect aggregate calls, assigning output aliases. */
function collectAggs(e: Expr, aggs: AggSpec[], aggMap: Map<string, string>, ctx: Ctx): void {
  const walk = (x: Expr, inAgg: boolean): void => {
    if (x.kind === 'func' && ast.isAggFunc(x.name)) {
      if (inAgg) throw new Error('nested aggregates are not supported');
      if (x.args.length > 1) throw new Error('too many arguments to ' + x.name);
      const key = exprKey(x);
      if (!aggMap.has(key)) {
        x.args.forEach(a => planSubsInExpr(a, ctx));
        const alias = x.name + '_' + aggs.length;
        aggs.push({
          func: x.name,
          arg: x.args.length === 0 ? null : x.args[0],
          distinct: x.distinct,
          alias,
        });
        aggMap.set(key, alias);
      }
      return;
    }
    const rec = (y: Expr) => walk(y, inAgg || (x.kind === 'func' && ast.isAggFunc(x.name)));
    switch (x.kind) {
      case 'binop': rec(x.left); rec(x.right); break;
      case 'unop': rec(x.expr); break;
      case 'func': x.args.forEach(rec); break;
      case 'case':
        x.whens.forEach(w => { rec(w.cond); rec(w.val); });
        if (x.else) rec(x.else);
        break;
      case 'cast': rec(x.expr); break;
      case 'isNull': rec(x.expr); break;
      case 'between': rec(x.expr); rec(x.lo); rec(x.hi); break;
      case 'like': rec(x.expr); rec(x.pattern); break;
      case 'inList': rec(x.expr); x.list.forEach(rec); break;
      default: break;
    }
  };
  walk(e, false);
}

/** Rewrite aggregate calls to their computed output column refs. */
function substituteAggs(e: Expr, aggMap: Map<string, string>): Expr {
  if (e.kind === 'func' && ast.isAggFunc(e.name)) {
    const alias = aggMap.get(exprKey(e));
    if (alias) return { kind: 'col', table: null, column: alias };
    return e;
  }
  switch (e.kind) {
    case 'binop': return { ...e, left: substituteAggs(e.left, aggMap), right: substituteAggs(e.right, aggMap) };
    case 'unop': return { ...e, expr: substituteAggs(e.expr, aggMap) };
    case 'func': return { ...e, args: e.args.map(a => substituteAggs(a, aggMap)) };
    case 'case':
      return {
        ...e,
        whens: e.whens.map(w => ({ cond: substituteAggs(w.cond, aggMap), val: substituteAggs(w.val, aggMap) })),
        else: e.else ? substituteAggs(e.else, aggMap) : null,
      };
    case 'cast': return { ...e, expr: substituteAggs(e.expr, aggMap) };
    case 'isNull': return { ...e, expr: substituteAggs(e.expr, aggMap) };
    case 'between':
      return { ...e, expr: substituteAggs(e.expr, aggMap), lo: substituteAggs(e.lo, aggMap), hi: substituteAggs(e.hi, aggMap) };
    case 'like': return { ...e, expr: substituteAggs(e.expr, aggMap), pattern: substituteAggs(e.pattern, aggMap) };
    case 'inList': return { ...e, expr: substituteAggs(e.expr, aggMap), list: e.list.map(x => substituteAggs(x, aggMap)) };
    default: return e;
  }
}

/** Fold step for index bounds: bounds are Exprs evaluated by the executor. */
export function isSimpleConstant(e: Expr): boolean {
  if (!ast.isConstant(e)) return false;
  let ok = true;
  const walk = (x: Expr): void => {
    if (!ok) return;
    if (x.kind === 'inSub' || x.kind === 'exists' || x.kind === 'scalarSub') { ok = false; return; }
    switch (x.kind) {
      case 'binop': walk(x.left); walk(x.right); break;
      case 'unop': walk(x.expr); break;
      case 'func': x.args.forEach(walk); break;
      case 'case':
        x.whens.forEach(w => { walk(w.cond); walk(w.val); });
        if (x.else) walk(x.else);
        break;
      case 'cast': walk(x.expr); break;
      case 'isNull': walk(x.expr); break;
      case 'between': walk(x.expr); walk(x.lo); walk(x.hi); break;
      case 'like': walk(x.expr); walk(x.pattern); break;
      case 'inList': walk(x.expr); x.list.forEach(walk); break;
      default: break;
    }
  };
  walk(e);
  return ok;
}

/** Plan a subquery with memoisation; each gets a child scope context. */
function planCachedSubquery(node: SelectStmt, ctx: Ctx): Plan {
  const hit = ctx.planCache.get(node);
  if (hit) return hit;
  const plan = planSelectInner(node, childCtx(ctx));
  ctx.planCache.set(node, plan);
  return plan;
}

/** Find subquery expressions, plan them, and record correlation info. */
function planSubsInExpr(e: Expr, ctx: Ctx): void {
  const walk = (x: Expr): void => {
    if (x.kind === 'inSub' || x.kind === 'exists' || x.kind === 'scalarSub') {
      planOneSubquery(x.sub, ctx);
    }
    switch (x.kind) {
      case 'binop': walk(x.left); walk(x.right); break;
      case 'unop': walk(x.expr); break;
      case 'func': x.args.forEach(walk); break;
      case 'case':
        x.whens.forEach(w => { walk(w.cond); walk(w.val); });
        if (x.else) walk(x.else);
        break;
      case 'cast': walk(x.expr); break;
      case 'isNull': walk(x.expr); break;
      case 'between': walk(x.expr); walk(x.lo); walk(x.hi); break;
      case 'like': walk(x.expr); walk(x.pattern); if (x.escape) walk(x.escape); break;
      case 'inList': walk(x.expr); x.list.forEach(walk); break;
      case 'inSub': walk(x.expr); break;
      default: break;
    }
  };
  walk(e);
}

function planOneSubquery(node: SelectStmt, ctx: Ctx): void {
  if (ctx.subs.some(s => s.node === node)) return;
  const child = childCtx(ctx);
  const plan = planSelectInner(node, child);
  ctx.planCache.set(node, plan);
  const correlated = detectCorrelation(node, child);
  ctx.subs.push({ node, plan, correlated });
}

/**
 * A subquery is correlated when it references columns that are not bound to
 * its own FROM tables (those refs resolve against outer scopes at execution).
 */
function detectCorrelation(node: SelectStmt, child: Ctx): boolean {
  const refs = ast.collectColumnsFromSelect(node);
  // don't descend into nested subqueries: they are planned separately
  const topRefs: { table: string | null; column: string }[] = [];
  const collectTop = (s: SelectStmt): void => {
    for (const c of s.columns) collectTopExpr(c.expr);
    for (const f of s.from) collectTopFrom(f);
    if (s.where) collectTopExpr(s.where);
    for (const g of s.groupBy) collectTopExpr(g);
    if (s.having) collectTopExpr(s.having);
    for (const o of s.orderBy) collectTopExpr(o.expr);
  };
  const collectTopExpr = (e: Expr): void => {
    if (e.kind === 'inSub' || e.kind === 'exists' || e.kind === 'scalarSub') return;
    ast.collectColumns(e, topRefs);
  };
  const collectTopFrom = (f: FromItem): void => {
    if (f.kind === 'subquery') return; // nested: separate plan
    if (f.kind === 'table') return;
    collectTopFrom(f.left);
    collectTopFrom(f.right);
    if (f.cond) collectTopExpr(f.cond);
  };
  collectTop(node);
  void refs;
  for (const r of topRefs) {
    if (r.table) {
      if (!child.scopeTables.has(r.table.toLowerCase())) return true;
    } else {
      let found = false;
      for (const t of child.scopeTables.values()) {
        if (t.columns.some(c => c.toLowerCase() === r.column.toLowerCase())) { found = true; break; }
      }
      if (!found) return true;
    }
  }
  return false;
}
