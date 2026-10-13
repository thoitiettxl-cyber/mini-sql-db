// SQL tokenizer. Produces a flat token stream for the recursive-descent parser.

export type TokenKind =
  | 'eof' | 'ident' | 'string' | 'number' | 'blob' | 'param' | 'op' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;      // raw text (for strings: unescaped content)
  value?: number;    // for numbers
  pos: number;
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
  'INDEX', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'UNIQUE', 'NOT', 'NULL', 'DEFAULT', 'CHECK', 'CONSTRAINT',
  'AND', 'OR', 'AS', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'NATURAL', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'DISTINCT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'IN', 'BETWEEN', 'LIKE',
  'GLOB', 'IS', 'ISNULL', 'NOTNULL', 'ESCAPE', 'CAST', 'COLLATE', 'ASC', 'DESC',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'EXPLAIN', 'PRAGMA', 'IF',
  'REPLACE', 'ABORT', 'FAIL', 'IGNORE', 'CONFLICT', 'TEMP', 'TEMPORARY',
  'VIEW', 'TRIGGER', 'ANALYZE', 'VACUUM', 'REINDEX', 'SAVEPOINT', 'RELEASE',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word.toUpperCase());
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const push = (kind: TokenKind, text: string, pos: number, value?: number) =>
    tokens.push({ kind, text, pos, value });

  while (i < n) {
    const c = input[i];
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    // line comment
    if (c === '-' && input[i + 1] === '-') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // string literal
    if (c === "'") {
      const start = i;
      i++;
      let s = '';
      while (i < n) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") { s += "'"; i += 2; }
          else { i++; break; }
        } else { s += input[i]; i++; }
      }
      push('string', s, start);
      continue;
    }
    // quoted identifier
    if (c === '"' || c === '`' || c === '[') {
      const start = i;
      const close = c === '[' ? ']' : c;
      i++;
      let s = '';
      while (i < n && input[i] !== close) {
        if (input[i] === close && input[i + 1] === close) { s += close; i += 2; }
        else { s += input[i]; i++; }
      }
      i++; // skip closer
      push('ident', s, start);
      continue;
    }
    // blob literal x'..' or number/ident starting with letter
    if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(input[i])) i++;
      const word = input.slice(start, i);
      if ((word === 'x' || word === 'X') && input[i] === "'") {
        i++;
        let hex = '';
        while (i < n && input[i] !== "'") { hex += input[i]; i++; }
        i++;
        push('blob', hex, start);
        continue;
      }
      if (isKeyword(word)) push('op', word.toUpperCase(), start);
      else push('ident', word, start);
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] || ''))) {
      const start = i;
      let j = i;
      while (j < n && /[0-9]/.test(input[j])) j++;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] || '')) {
        j++;
        while (j < n && /[0-9]/.test(input[j])) j++;
      } else if (input[j] === '.') {
        // trailing dot: keep as number with dot
        j++;
      }
      if ((input[j] === 'e' || input[j] === 'E')) {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k++;
        if (/[0-9]/.test(input[k] || '')) {
          j = k;
          while (j < n && /[0-9]/.test(input[j])) j++;
        }
      }
      const text = input.slice(start, j);
      i = j;
      push('number', text, start, Number(text));
      continue;
    }
    // parameter ? or ?NNN or :name
    if (c === '?') {
      const start = i;
      i++;
      let num = '';
      while (i < n && /[0-9]/.test(input[i])) { num += input[i]; i++; }
      push('param', '?' + num, start);
      continue;
    }
    // two-char operators
    const two = input.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '||', '<<', '>>'].includes(two)) {
      push('op', two === '!=' ? '<>' : two, i);
      i += 2;
      continue;
    }
    // single-char
    if ('=<>+-*/%(),.;'.includes(c)) {
      push(c === ';' ? 'punct' : (/[(),.]/.test(c) ? 'punct' : 'op'), c, i);
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}' at position ${i}`);
  }
  push('eof', '', n);
  return tokens;
}
