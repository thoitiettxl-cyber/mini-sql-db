// Recursive-descent SQL parser producing the AST in ./ast.js.
import { tokenize, Token } from './lexer.js';
import * as ast from './ast.js';

/** Split SQL text into statements on top-level semicolons. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let quote: string | null = null;
  let lineComment = false;
  let blockDepth = 0;
  while (i < n) {
    const c = sql[i];
    if (lineComment) {
      cur += c;
      if (c === '\n') lineComment = false;
      i++; continue;
    }
    if (blockDepth > 0) {
      cur += c;
      if (c === '*' && sql[i + 1] === '/') { cur += '/'; i += 2; blockDepth--; }
      else if (c === '/' && sql[i + 1] === '*') { cur += '*'; i += 2; blockDepth++; }
      else i++;
      continue;
    }
    if (quote) {
      cur += c;
      const close = quote === '[' ? ']' : quote;
      if (c === close) {
        if (sql[i + 1] === close) { cur += close; i += 2; continue; }
        quote = null;
      }
      i++; continue;
    }
    if (c === '-' && sql[i + 1] === '-') { lineComment = true; cur += '--'; i += 2; continue; }
    if (c === '/' && sql[i + 1] === '*') { blockDepth = 1; cur += '/*'; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') { quote = c; cur += c; i++; continue; }
    if (c === ';') {
      if (cur.trim() !== '') out.push(cur);
      cur = ''; i++; continue;
    }
    cur += c; i++;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/** Keywords that may never serve as a bare alias or name. */
const STRUCTURAL = new Set([
  'SELECT','FROM','WHERE','GROUP','HAVING','ORDER','LIMIT','OFFSET','JOIN',
  'INNER','LEFT','RIGHT','FULL','CROSS','NATURAL','ON','USING','UNION',
  'INTERSECT','EXCEPT','ALL','DISTINCT','AS','AND','OR','NOT','IN','BETWEEN',
  'LIKE','GLOB','IS','ISNULL','NOTNULL','ESCAPE','EXISTS','CASE','WHEN','THEN',
  'ELSE','END','CAST','INSERT','UPDATE','DELETE','CREATE','DROP','TABLE',
  'INDEX','INTO','VALUES','SET','BEGIN','COMMIT','ROLLBACK','TRANSACTION',
  'ASC','DESC','NULL','TRUE','FALSE','DEFAULT','PRIMARY','KEY','UNIQUE',
  'REFERENCES','CHECK','CONSTRAINT','COLLATE','FOREIGN','EXPLAIN',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(sql: string) { this.tokens = tokenize(sql); }
  peek(offset = 0): Token { return this.tokens[this.pos + offset]; }
  isEof(): boolean { return this.peek().kind === 'eof'; }
  private next(): Token { return this.tokens[this.pos++]; }
  private err(msg: string): Error {
    return new Error(msg + ' at position ' + this.peek().pos);
  }
  private matchOp(...words: string[]): Token | null {
    const t = this.peek();
    if (t.kind === 'op' && words.indexOf(t.text) >= 0) { this.pos++; return t; }
    return null;
  }
  private atOp(...words: string[]): boolean {
    const t = this.peek();
    return t.kind === 'op' && words.indexOf(t.text) >= 0;
  }
  private expectOp(...words: string[]): Token {
    const t = this.matchOp(...words);
    if (!t) throw this.err('expected ' + words.join('/'));
    return t;
  }
  private matchPunct(ch: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === ch) { this.pos++; return true; }
    return false;
  }
  private expectPunct(ch: string): void {
    if (!this.matchPunct(ch)) throw this.err("expected '" + ch + "'");
  }
  /** Parse an identifier-like name; allowKeyword also accepts non-structural keywords. */
  private parseName(allowKeyword = false): string {
    const t = this.peek();
    if (t.kind === 'ident' || t.kind === 'string') { this.pos++; return t.text; }
    if (allowKeyword && t.kind === 'op' && !STRUCTURAL.has(t.text)) {
      this.pos++; return t.text;
    }
    throw this.err('expected a name');
  }
  private parseNameList(): string[] {
    const out: string[] = [];
    do { out.push(this.parseName(false)); } while (this.matchPunct(','));
    return out;
  }

  parseStmt(): ast.Stmt {
    const t = this.peek();
    if (t.kind === 'op') {
      switch (t.text) {
        case 'SELECT': return this.parseSelect();
        case 'INSERT': return this.parseInsert();
        case 'UPDATE': return this.parseUpdate();
        case 'DELETE': return this.parseDelete();
        case 'CREATE': return this.parseCreate();
        case 'DROP': return this.parseDrop();
        case 'BEGIN':
          this.next(); this.matchOp('TRANSACTION');
          return { kind: 'begin' };
        case 'COMMIT':
          this.next(); this.matchOp('TRANSACTION');
          return { kind: 'commit' };
        case 'ROLLBACK':
          this.next(); this.matchOp('TRANSACTION');
          return { kind: 'rollback' };
        case 'EXPLAIN':
          this.next();
          return { kind: 'explain', stmt: this.parseStmt() };
      }
    }
    if (t.kind === 'punct' && t.text === '(') return this.parseSelect();
    throw this.err('unexpected token ' + JSON.stringify(t.text));
  }

  private parseInsert(): ast.Stmt {
    this.expectOp('INSERT');
    this.expectOp('INTO');
    const table = this.parseName(false);
    let columns: string[] | null = null;
    if (this.matchPunct('(')) {
      columns = this.parseNameList();
      this.expectPunct(')');
    }
    let source: ast.InsertSource;
    const t = this.peek();
    if (t.kind === 'op' && t.text === 'SELECT') {
      source = { kind: 'select', select: this.parseSelect() };
    } else if (t.kind === 'punct' && t.text === '(' &&
               this.peek(1).kind === 'op' && this.peek(1).text === 'SELECT') {
      source = { kind: 'select', select: this.parseSelect() };
    } else if (this.matchOp('VALUES')) {
      const rows: ast.Expr[][] = [];
      do {
        this.expectPunct('(');
        const row: ast.Expr[] = [];
        if (!this.matchPunct(')')) {
          do { row.push(this.parseExpr()); } while (this.matchPunct(','));
          this.expectPunct(')');
        }
        rows.push(row);
      } while (this.matchPunct(','));
      source = { kind: 'values', rows };
    } else {
      throw this.err('expected VALUES or SELECT after INSERT INTO');
    }
    return { kind: 'insert', table, columns, source };
  }

  private parseUpdate(): ast.Stmt {
    this.expectOp('UPDATE');
    const table = this.parseName(false);
    let alias = table;
    if (this.matchOp('AS')) {
      alias = this.parseName(true);
    } else {
      const t = this.peek();
      if (t.kind === 'ident' || t.kind === 'string') { this.next(); alias = t.text; }
    }
    this.expectOp('SET');
    const sets: { column: string; expr: ast.Expr }[] = [];
    do {
      const column = this.parseName(false);
      this.expectOp('=');
      sets.push({ column, expr: this.parseExpr() });
    } while (this.matchPunct(','));
    let where: ast.Expr | null = null;
    if (this.matchOp('WHERE')) where = this.parseExpr();
    return { kind: 'update', table, alias, sets, where };
  }

  private parseDelete(): ast.Stmt {
    this.expectOp('DELETE');
    this.expectOp('FROM');
    const table = this.parseName(false);
    let where: ast.Expr | null = null;
    if (this.matchOp('WHERE')) where = this.parseExpr();
    return { kind: 'delete', table, alias: table, where };
  }

  private parseCreate(): ast.Stmt {
    this.expectOp('CREATE');
    const unique = !!this.matchOp('UNIQUE');
    if (this.matchOp('TABLE')) return this.parseCreateTable(unique);
    if (this.atOp('INDEX')) return this.parseCreateIndex(unique);
    throw this.err('expected TABLE or INDEX after CREATE');
  }

  private parseCreateTable(_unique: boolean): ast.Stmt {
    let ifNotExists = false;
    if (this.matchOp('IF')) {
      this.expectOp('NOT'); this.expectOp('EXISTS');
      ifNotExists = true;
    }
    const name = this.parseName(false);
    this.expectPunct('(');
    const columns: ast.ColumnDef[] = [];
    const pkCols: string[] = [];
    const uqCols: string[][] = [];
    for (;;) {
      if (this.atOp('PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT')) {
        if (this.matchOp('CONSTRAINT')) this.parseName(true);
        if (this.matchOp('PRIMARY')) {
          this.expectOp('KEY');
          this.expectPunct('(');
          pkCols.push(...this.parseNameList());
          this.expectPunct(')');
        } else if (this.matchOp('UNIQUE')) {
          this.expectPunct('(');
          uqCols.push(this.parseNameList());
          this.expectPunct(')');
        } else if (this.matchOp('FOREIGN')) {
          this.expectOp('KEY');
          this.expectPunct('('); this.parseNameList(); this.expectPunct(')');
          this.expectOp('REFERENCES');
          this.parseName(false);
          this.skipConstraintTail();
        } else if (this.matchOp('CHECK')) {
          this.expectPunct('(');
          this.skipToCloseParen();
        }
      } else {
        columns.push(this.parseColumnDef());
      }
      if (this.matchPunct(',')) continue;
      break;
    }
    this.expectPunct(')');
    for (const c of columns) {
      if (pkCols.indexOf(c.name) >= 0) { c.primaryKey = true; c.notNull = true; }
      for (const u of uqCols) if (u.indexOf(c.name) >= 0) c.unique = true;
    }
    return { kind: 'createTable', name, columns, ifNotExists };
  }

  private parseColumnDef(): ast.ColumnDef {
    const name = this.parseName(false);
    const type = this.parseTypeName();
    const col: ast.ColumnDef = {
      name, type, primaryKey: false, notNull: false, unique: false, default: null,
    };
    for (;;) {
      if (this.matchOp('PRIMARY')) { this.expectOp('KEY'); col.primaryKey = true; col.notNull = true; }
      else if (this.matchOp('NOT')) { this.expectOp('NULL'); col.notNull = true; }
      else if (this.matchOp('NULL')) { /* nullable: nothing */ }
      else if (this.matchOp('UNIQUE')) { col.unique = true; }
      else if (this.matchOp('DEFAULT')) { col.default = this.parseDefaultExpr(); }
      else if (this.matchOp('REFERENCES')) { this.parseName(false); this.skipConstraintTail(); }
      else if (this.matchOp('CHECK')) { this.expectPunct('('); this.skipToCloseParen(); }
      else if (this.matchOp('COLLATE')) { this.next(); }
      else if (this.matchOp('CONSTRAINT')) { this.parseName(true); }
      else break;
    }
    return col;
  }

  private parseTypeName(): string {
    const parts: string[] = [];
    const stop = new Set(['PRIMARY','NOT','NULL','UNIQUE','DEFAULT','REFERENCES',
      'CHECK','COLLATE','CONSTRAINT']);
    for (;;) {
      const t = this.peek();
      if (t.kind === 'ident') { this.next(); parts.push(t.text); }
      else if (t.kind === 'op' && !stop.has(t.text)) { this.next(); parts.push(t.text); }
      else break;
    }
    if (this.matchPunct('(')) {
      parts.push('(');
      let depth = 1;
      for (;;) {
        const t = this.next();
        if (t.kind === 'eof') throw this.err('unterminated type parameters');
        if (t.kind === 'punct' && t.text === '(') depth++;
        if (t.kind === 'punct' && t.text === ')') {
          depth--;
          if (depth === 0) { parts.push(')'); break; }
        }
        parts.push(t.text);
      }
    }
    return parts.join(' ') || 'TEXT';
  }

  private parseDefaultExpr(): ast.Expr {
    if (this.matchPunct('(')) {
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    return this.parseUnary();
  }

  /** Skip to matching ')' (opening paren already consumed). */
  private skipToCloseParen(): void {
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.kind === 'eof') throw this.err('unterminated parenthesis');
      if (t.kind === 'punct' && t.text === '(') depth++;
      else if (t.kind === 'punct' && t.text === ')') {
        depth--;
        if (depth === 0) return;
      }
    }
  }

  /** Skip a REFERENCES tail up to ',' or ')' at depth 0. */
  private skipConstraintTail(): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.kind === 'eof') return;
      if (t.kind === 'punct' && t.text === '(') depth++;
      if (t.kind === 'punct' && t.text === ')') {
        if (depth === 0) return;
        depth--;
      }
      if (t.kind === 'punct' && t.text === ',' && depth === 0) return;
      this.next();
    }
  }

  private parseCreateIndex(unique: boolean): ast.Stmt {
    this.expectOp('INDEX');
    let ifNotExists = false;
    if (this.matchOp('IF')) {
      this.expectOp('NOT'); this.expectOp('EXISTS');
      ifNotExists = true;
    }
    const name = this.parseName(false);
    this.expectOp('ON');
    const table = this.parseName(false);
    this.expectPunct('(');
    const columns: { name: string; desc: boolean }[] = [];
    do {
      const cname = this.parseName(false);
      let desc = false;
      if (this.matchOp('DESC')) desc = true;
      else this.matchOp('ASC');
      columns.push({ name: cname, desc });
    } while (this.matchPunct(','));
    this.expectPunct(')');
    return { kind: 'createIndex', name, table, columns, unique, ifNotExists };
  }

  private parseDrop(): ast.Stmt {
    this.expectOp('DROP');
    const isTable = !!this.matchOp('TABLE');
    const isIndex = !isTable && !!this.matchOp('INDEX');
    if (!isTable && !isIndex) throw this.err('expected TABLE or INDEX after DROP');
    let ifExists = false;
    if (this.matchOp('IF')) { this.expectOp('EXISTS'); ifExists = true; }
    const name = this.parseName(false);
    return isTable
      ? { kind: 'dropTable', name, ifExists }
      : { kind: 'dropIndex', name, ifExists };
  }

  private parseSelect(): ast.SelectStmt {
    let left: ast.SelectStmt;
    if (this.matchPunct('(')) {
      left = this.parseSelect();
      this.expectPunct(')');
    } else {
      left = this.parseSelectCore();
    }
    for (;;) {
      let op: ast.SetOp | null = null;
      if (this.matchOp('UNION')) op = 'UNION';
      else if (this.matchOp('INTERSECT')) op = 'INTERSECT';
      else if (this.matchOp('EXCEPT')) op = 'EXCEPT';
      else break;
      let all = false;
      if (op === 'UNION' && this.matchOp('ALL')) all = true;
      let right: ast.SelectStmt;
      if (this.matchPunct('(')) {
        right = this.parseSelect();
        this.expectPunct(')');
      } else {
        right = this.parseSelectCore();
      }
      const prev = left;
      left = {
        kind: 'select', distinct: false, columns: [], from: [],
        where: null, groupBy: [], having: null, orderBy: [],
        limit: null, offset: null,
        setOp: { op, all, left: prev, right },
      };
    }
    this.parseTrailingClauses(left);
    return left;
  }

  private parseSelectCore(): ast.SelectStmt {
    this.expectOp('SELECT');
    let distinct = false;
    if (this.matchOp('DISTINCT')) distinct = true;
    else this.matchOp('ALL');
    const columns = this.parseSelectList();
    const from = this.parseFromClause();
    let where: ast.Expr | null = null;
    const groupBy: ast.Expr[] = [];
    let having: ast.Expr | null = null;
    if (this.matchOp('WHERE')) where = this.parseExpr();
    if (this.matchOp('GROUP')) {
      this.expectOp('BY');
      do { groupBy.push(this.parseExpr()); } while (this.matchPunct(','));
    }
    if (this.matchOp('HAVING')) having = this.parseExpr();
    return {
      kind: 'select', distinct, columns, from, where, groupBy, having,
      orderBy: [], limit: null, offset: null, setOp: null,
    };
  }

  private parseSelectList(): ast.SelectColumn[] {
    const cols: ast.SelectColumn[] = [];
    do {
      if (this.peek().kind === 'op' && this.peek().text === '*') {
        this.next();
        cols.push({ expr: { kind: 'star' }, alias: null });
        continue;
      }
      const t0 = this.peek();
      const t1 = this.peek(1);
      const t2 = this.peek(2);
      if ((t0.kind === 'ident' || t0.kind === 'string') &&
          t1.kind === 'punct' && t1.text === '.' &&
          t2.kind === 'op' && t2.text === '*') {
        this.next(); this.next(); this.next();
        cols.push({ expr: { kind: 'tableStar', table: t0.text }, alias: null });
        continue;
      }
      const expr = this.parseExpr();
      let alias: string | null = null;
      if (this.matchOp('AS')) {
        alias = this.parseName(true);
      } else {
        const t = this.peek();
        if (t.kind === 'ident' || t.kind === 'string') { this.next(); alias = t.text; }
      }
      cols.push({ expr, alias });
    } while (this.matchPunct(','));
    return cols;
  }

  private parseFromClause(): ast.FromItem[] {
    if (!this.matchOp('FROM')) return [];
    const items: ast.FromItem[] = [];
    do { items.push(this.parseFromItem()); } while (this.matchPunct(','));
    return items;
  }

  private parseFromItem(): ast.FromItem {
    let left = this.parseFromPrimary();
    for (;;) {
      const j = this.parseJoinOp();
      if (!j) break;
      const right = this.parseFromPrimary();
      let cond: ast.Expr | null = null;
      let using: string[] | null = null;
      if (j.type !== 'CROSS' && !j.natural) {
        if (this.matchOp('ON')) cond = this.parseExpr();
        else if (this.matchOp('USING')) {
          this.expectPunct('(');
          using = this.parseNameList();
          this.expectPunct(')');
        }
      }
      left = { kind: 'join', left, right, joinType: j.type, cond, using, natural: j.natural };
    }
    return left;
  }

  private parseFromPrimary(): ast.FromItem {
    if (this.matchPunct('(')) {
      const sub = this.parseSelect();
      this.expectPunct(')');
      let alias: string | null = null;
      if (this.matchOp('AS')) alias = this.parseName(true);
      else {
        const t = this.peek();
        if (t.kind === 'ident' || t.kind === 'string') { this.next(); alias = t.text; }
      }
      if (!alias) throw this.err('subquery in FROM must have an alias');
      return { kind: 'subquery', sub, alias };
    }
    const name = this.parseName(false);
    let alias = name;
    if (this.matchOp('AS')) alias = this.parseName(true);
    else {
      const t = this.peek();
      if (t.kind === 'ident' || t.kind === 'string') { this.next(); alias = t.text; }
    }
    return { kind: 'table', name, alias };
  }

  private parseJoinOp(): { type: ast.JoinType; natural: boolean } | null {
    const save = this.pos;
    let natural = false;
    if (this.matchOp('NATURAL')) natural = true;
    if (this.matchOp('CROSS')) {
      if (this.matchOp('JOIN')) return { type: 'CROSS', natural };
      this.pos = save; return null;
    }
    if (this.matchOp('INNER')) {
      if (this.matchOp('JOIN')) return { type: 'INNER', natural };
      this.pos = save; return null;
    }
    let type: ast.JoinType = 'INNER';
    if (this.matchOp('LEFT')) type = 'LEFT';
    else if (this.matchOp('RIGHT')) type = 'RIGHT';
    else if (this.matchOp('FULL')) type = 'FULL';
    if (type !== 'INNER') this.matchOp('OUTER');
    if (this.matchOp('JOIN')) return { type, natural };
    this.pos = save;
    return null;
  }

  private parseTrailingClauses(s: ast.SelectStmt): void {
    if (this.matchOp('ORDER')) {
      this.expectOp('BY');
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchOp('DESC')) desc = true;
        else this.matchOp('ASC');
        s.orderBy.push({ expr, desc });
      } while (this.matchPunct(','));
    }
    if (this.matchOp('LIMIT')) {
      const first = this.parseExpr();
      if (this.matchPunct(',')) {
        s.offset = first;
        s.limit = this.parseExpr();
      } else {
        s.limit = first;
        if (this.matchOp('OFFSET')) s.offset = this.parseExpr();
      }
    }
  }

  // ------------------------------------------------------------------
  // Expressions (precedence: OR < AND < NOT < comparison/IS/BETWEEN/IN/LIKE
  //              < +,- < *,/,% < || < unary < primary)
  // ------------------------------------------------------------------

  parseExpr(): ast.Expr {
    return this.parseOr();
  }

  private parseOr(): ast.Expr {
    let left = this.parseAnd();
    for (;;) {
      if (!this.matchOp('OR')) break;
      const right = this.parseAnd();
      left = { kind: 'binop', op: 'OR', left, right };
    }
    return left;
  }

  private parseAnd(): ast.Expr {
    let left = this.parseNot();
    for (;;) {
      if (!this.matchOp('AND')) break;
      const right = this.parseNot();
      left = { kind: 'binop', op: 'AND', left, right };
    }
    return left;
  }

  private parseNot(): ast.Expr {
    if (this.matchOp('NOT')) return { kind: 'unop', op: 'NOT', expr: this.parseNot() };
    return this.parseComparison();
  }

  private parseComparison(): ast.Expr {
    let left = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && t.text === 'IS') {
        this.next();
        const not = !!this.matchOp('NOT');
        if (this.matchOp('NULL')) {
          left = { kind: 'isNull', expr: left, not };
          continue;
        }
        const right = this.parseAdd();
        left = { kind: 'binop', op: not ? 'IS NOT' : 'IS', left, right };
        continue;
      }
      if (t.kind === 'op' && (t.text === 'ISNULL' || t.text === 'NOTNULL')) {
        this.next();
        left = { kind: 'isNull', expr: left, not: t.text === 'NOTNULL' };
        continue;
      }
      let not = false;
      if (t.kind === 'op' && t.text === 'NOT') {
        const t1 = this.peek(1);
        if (t1.kind === 'op' &&
            (t1.text === 'BETWEEN' || t1.text === 'IN' ||
             t1.text === 'LIKE' || t1.text === 'GLOB')) {
          this.next();
          not = true;
        }
      }
      const t2 = this.peek();
      if (t2.kind === 'op' && t2.text === 'BETWEEN') {
        this.next();
        const lo = this.parseAdd();
        this.expectOp('AND');
        const hi = this.parseAdd();
        left = { kind: 'between', expr: left, lo, hi, not };
        continue;
      }
      if (t2.kind === 'op' && t2.text === 'IN') {
        this.next();
        this.expectPunct('(');
        const p0 = this.peek();
        const p1 = this.peek(1);
        const isSelect = (p0.kind === 'op' && p0.text === 'SELECT') ||
          (p0.kind === 'punct' && p0.text === '(' &&
           p1.kind === 'op' && p1.text === 'SELECT');
        if (isSelect) {
          const sub = this.parseSelect();
          this.expectPunct(')');
          left = { kind: 'inSub', expr: left, sub, not };
        } else {
          const list: ast.Expr[] = [];
          if (!this.matchPunct(')')) {
            do { list.push(this.parseExpr()); } while (this.matchPunct(','));
            this.expectPunct(')');
          }
          left = { kind: 'inList', expr: left, list, not };
        }
        continue;
      }
      if (t2.kind === 'op' && (t2.text === 'LIKE' || t2.text === 'GLOB')) {
        this.next();
        const pattern = this.parseAdd();
        let escape: ast.Expr | null = null;
        if (this.matchOp('ESCAPE')) escape = this.parseAdd();
        left = { kind: 'like', expr: left, pattern, escape, not, glob: t2.text === 'GLOB' };
        continue;
      }
      if (not) throw this.err('expected BETWEEN, IN, LIKE or GLOB after NOT');
      if (t.kind === 'op' &&
          (t.text === '=' || t.text === '==' || t.text === '<>' ||
           t.text === '<' || t.text === '<=' || t.text === '>' || t.text === '>=')) {
        this.next();
        const right = this.parseAdd();
        left = { kind: 'binop', op: t.text === '==' ? '=' : t.text, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdd(): ast.Expr {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.text === '+' || t.text === '-')) {
        this.next();
        left = { kind: 'binop', op: t.text, left, right: this.parseMul() };
      } else break;
    }
    return left;
  }

  private parseMul(): ast.Expr {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.next();
        left = { kind: 'binop', op: t.text, left, right: this.parseConcat() };
      } else break;
    }
    return left;
  }

  private parseConcat(): ast.Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && t.text === '||') {
        this.next();
        left = { kind: 'binop', op: '||', left, right: this.parseUnary() };
      } else break;
    }
    return left;
  }

  private parseUnary(): ast.Expr {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '-') {
      this.next();
      return { kind: 'unop', op: '-', expr: this.parseUnary() };
    }
    if (t.kind === 'op' && t.text === '+') { this.next(); return this.parseUnary(); }
    return this.parsePrimary();
  }

  private parsePrimary(): ast.Expr {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === '(') {
      this.next();
      if (this.atOp('SELECT')) {
        const sub = this.parseSelect();
        this.expectPunct(')');
        return { kind: 'scalarSub', sub };
      }
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    if (t.kind === 'number') {
      this.next();
      const isInt = !/[.eE]/.test(t.text);
      return { kind: 'lit', value: t.value as number };
    }
    if (t.kind === 'string') { this.next(); return { kind: 'lit', value: t.text }; }
    if (t.kind === 'blob') {
      this.next();
      const hex = t.text.replace(/\s+/g, '');
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return { kind: 'lit', value: bytes };
    }
    if (t.kind === 'param') { this.next(); return { kind: 'lit', value: null }; }
    if (t.kind === 'op') {
      switch (t.text) {
        case 'NULL': this.next(); return { kind: 'lit', value: null };
        case 'TRUE': this.next(); return { kind: 'lit', value: 1 };
        case 'FALSE': this.next(); return { kind: 'lit', value: 0 };
        case 'CURRENT_DATE':
        case 'CURRENT_TIME':
        case 'CURRENT_TIMESTAMP':
          this.next(); return { kind: 'lit', value: null };
        case 'CASE': return this.parseCase();
        case 'CAST': return this.parseCast();
        case 'EXISTS': {
          this.next();
          this.expectPunct('(');
          const sub = this.parseSelect();
          this.expectPunct(')');
          return { kind: 'exists', sub, not: false };
        }
        default: throw this.err('unexpected keyword ' + t.text);
      }
    }
    if (t.kind === 'ident') {
      const p1 = this.peek(1);
      if (p1.kind === 'punct' && p1.text === '(') return this.parseFuncCall();
      this.next();
      if (this.matchPunct('.')) {
        return { kind: 'col', table: t.text, column: this.parseName(false) };
      }
      return { kind: 'col', table: null, column: t.text };
    }
    throw this.err('unexpected token ' + JSON.stringify(t.text));
  }

  private parseFuncCall(): ast.Expr {
    const nameTok = this.next();
    const name = nameTok.text.toLowerCase();
    this.expectPunct('(');
    const args: ast.Expr[] = [];
    let distinct = false;
    {
      const st = this.peek();
      if (st.kind === 'op' && st.text === '*') {
        this.next();
        this.expectPunct(')');
        return { kind: 'func', name, args, distinct };
      }
    }
    if (!this.matchPunct(')')) {
      if (this.matchOp('DISTINCT')) distinct = true;
      do { args.push(this.parseExpr()); } while (this.matchPunct(','));
      this.expectPunct(')');
    }
    return { kind: 'func', name, args, distinct };
  }

  private parseCase(): ast.Expr {
    this.expectOp('CASE');
    let operand: ast.Expr | null = null;
    if (!this.atOp('WHEN')) operand = this.parseExpr();
    const whens: { cond: ast.Expr; val: ast.Expr }[] = [];
    if (!this.atOp('WHEN')) throw this.err('expected WHEN in CASE');
    while (this.matchOp('WHEN')) {
      const w = this.parseExpr();
      this.expectOp('THEN');
      const v = this.parseExpr();
      const cond: ast.Expr = operand
        ? { kind: 'binop', op: '=', left: operand, right: w }
        : w;
      whens.push({ cond, val: v });
    }
    let els: ast.Expr | null = null;
    if (this.matchOp('ELSE')) els = this.parseExpr();
    this.expectOp('END');
    return { kind: 'case', whens, else: els };
  }

  private parseCast(): ast.Expr {
    this.expectOp('CAST');
    this.expectPunct('(');
    const e = this.parseExpr();
    this.expectOp('AS');
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && t.text === ')') break;
      if (t.kind === 'eof') throw this.err('unterminated CAST');
      parts.push(this.next().text);
    }
    this.expectPunct(')');
    return { kind: 'cast', expr: e, typeName: parts.join(' ') };
  }
} // end class Parser

export function parseAll(sql: string): ast.Stmt[] {
  const out: ast.Stmt[] = [];
  for (const part of splitStatements(sql)) {
    const p = new Parser(part);
    out.push(p.parseStmt());
    if (!p.isEof()) throw new Error('unexpected trailing tokens at position ' + p.peek().pos);
  }
  return out;
}

export function parseOne(sql: string): ast.Stmt {
  const stmts = parseAll(sql);
  if (stmts.length !== 1) throw new Error('expected exactly one statement, got ' + stmts.length);
  return stmts[0];
}
