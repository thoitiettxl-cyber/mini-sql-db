// Differential test: mini-sql-db vs SQLite on the same data and queries (fixed seed => reproducible).
// Each group is one test; a failing group lists the first differences. Run: npm run test:diff
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../index.js';
import type { Database } from '../index.js';
import { makeOracle, rng, normRows, diffRows } from './oracle.js';
import type { Oracle } from './oracle.js';

const SEED = 42;
const SHOW = Number(process.env.DIFF_SHOW ?? 4); // DIFF_SHOW=999 npm run test:diff lists every difference
const CITIES = ['hanoi', 'saigon', 'hue', null, 'danang'];
const STATUS = ['new', 'paid', 'void', null];
const q = (s: string | null) => (s === null ? 'NULL' : `'${s}'`);

async function seedBoth(lite: Oracle, mini: Database) {
  const r = rng(SEED);
  const stmts = [
    `CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, city TEXT)`,
    `CREATE TABLE orders(id INTEGER PRIMARY KEY, uid INTEGER, total REAL, status TEXT)`,
    `CREATE TABLE empty_t(id INTEGER PRIMARY KEY, age INTEGER)`,
    `CREATE INDEX iu_age ON users(age)`,
    `CREATE INDEX iu_city ON users(city)`,
    `CREATE INDEX io_uid ON orders(uid)`,
  ];
  for (let i = 1; i <= 200; i++) {
    stmts.push(`INSERT INTO users VALUES(${i},'u${i % 37}_${i}',${r(8) === 0 ? 'NULL' : 18 + r(50)},${q(CITIES[r(5)])})`);
  }
  for (let i = 1; i <= 600; i++) {
    stmts.push(`INSERT INTO orders VALUES(${i},${r(10) === 0 ? 'NULL' : 1 + r(230)},${r(7) === 0 ? 'NULL' : (r(100000) / 100).toFixed(2)},${q(STATUS[r(4)])})`);
  }
  for (const s of stmts) { lite.exec(s); await mini.exec(s); }
}

interface Case { sql: string; ordered: boolean }
function buildCases(): Record<string, Case[]> {
  const r = rng(SEED + 1);
  const ops = ['=', '<', '>', '<=', '>=', '<>'];
  const g: Record<string, Case[]> = {};
  const add = (grp: string, sql: string) => (g[grp] ??= []).push({ sql, ordered: /ORDER BY/i.test(sql) });

  for (let i = 0; i < 36; i++) add('filters on a nullable indexed column', `SELECT id, name, age FROM users WHERE age ${ops[i % 6]} ${18 + r(50)} ORDER BY id`);
  for (let i = 0; i < 10; i++) add('filters on a nullable indexed column', `SELECT id FROM users WHERE city = '${CITIES[i % 3]}' AND age ${ops[i % 6]} ${20 + r(40)} ORDER BY id`);
  for (let i = 0; i < 8; i++) add('filters on a nullable indexed column', `SELECT id FROM users WHERE city IS NULL OR age IS NULL OR age BETWEEN ${18 + r(20)} AND ${40 + r(20)} ORDER BY id`);
  for (let i = 0; i < 6; i++) add('filters on a nullable indexed column', `SELECT id FROM users WHERE NOT (age > ${25 + i * 5}) ORDER BY id`);
  for (let i = 0; i < 8; i++) add('filters on a nullable indexed column', `SELECT id FROM users WHERE name LIKE 'u${i}%' ORDER BY id`);
  for (let i = 0; i < 8; i++) add('filters on a nullable indexed column', `SELECT id FROM users WHERE city IN ('hanoi','hue') AND id NOT IN (${i + 1},${i + 9}) ORDER BY id`);

  for (const a of ['COUNT(*)', 'COUNT(age)', 'SUM(age)', 'AVG(age)', 'MIN(age)', 'MAX(age)', 'MIN(name)', 'MAX(city)', 'COUNT(DISTINCT city)', 'SUM(age)*2']) {
    add('aggregates, including empty input', `SELECT ${a} FROM users`);
    add('aggregates, including empty input', `SELECT ${a} FROM users WHERE age > 30`);
    add('aggregates, including empty input', `SELECT ${a} FROM users WHERE id < 0`);
    add('aggregates, including empty input', `SELECT ${a} FROM users WHERE age > 999`);
    add('aggregates, including empty input', `SELECT ${a.replace(/age|name|city/, 'age')} FROM empty_t`);
  }
  add('aggregates, including empty input', `SELECT COUNT(*) FROM empty_t`);
  add('aggregates, including empty input', `SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.uid = u.id) FROM users u ORDER BY u.id`);
  add('aggregates, including empty input', `SELECT u.id, (SELECT SUM(o.total) FROM orders o WHERE o.uid = u.id) FROM users u ORDER BY u.id`);

  for (const gb of ['city', 'age/10', 'city, age/20', '1', '2']) {
    const sel = gb === '1' ? 'city' : gb === '2' ? 'age/10' : gb;
    const body = gb === '2' ? 'city, age/10' : sel;
    for (const a of ['COUNT(*)', 'SUM(age)', 'AVG(age)', 'MIN(id)', 'MAX(age)']) {
      add('group by / having', `SELECT ${body}, ${a} FROM users GROUP BY ${gb} ORDER BY ${gb === '2' ? 'age/10' : gb === '1' ? '1' : gb}`);
      add('group by / having', `SELECT ${body}, ${a} FROM users GROUP BY ${gb} HAVING COUNT(*) > 5 ORDER BY ${gb === '2' ? 'age/10' : gb === '1' ? '1' : gb}`);
    }
  }
  for (let i = 0; i < 8; i++) {
    add('group by / having', `SELECT CASE WHEN age IS NULL THEN 'n' WHEN age < ${25 + i * 4} THEN 'y' ELSE 'o' END, COUNT(*) FROM users GROUP BY 1 ORDER BY 1`);
    add('group by / having', `SELECT city, COUNT(*) AS c FROM users GROUP BY city HAVING c > ${i} ORDER BY city`);
  }

  for (const j of ['JOIN', 'LEFT JOIN']) {
    for (let i = 0; i < 8; i++) {
      add('joins on tables with a same-named column', `SELECT u.id, o.id FROM users u ${j} orders o ON o.uid = u.id WHERE u.age ${ops[i % 6]} ${25 + i * 3} ORDER BY u.id, o.id`);
      add('joins on tables with a same-named column', `SELECT o.id, u.id, o.total FROM users u ${j} orders o ON o.uid = u.id WHERE u.city = '${CITIES[i % 3]}' ORDER BY o.id, u.id`);
      add('joins on tables with a same-named column', `SELECT u.city, COUNT(o.id), SUM(o.total) FROM users u ${j} orders o ON o.uid = u.id WHERE o.status ${i % 2 ? '=' : '<>'} 'paid' OR o.id IS NULL GROUP BY u.city ORDER BY u.city`);
      add('joins on tables with a same-named column', `SELECT u.id, COUNT(o.id) AS c FROM users u ${j} orders o ON o.uid = u.id GROUP BY u.id HAVING c ${ops[i % 3]} ${i} ORDER BY u.id`);
    }
  }
  add('joins on tables with a same-named column', `SELECT u.id, o.id FROM users u JOIN orders o ON o.uid = u.id JOIN users u2 ON u2.id = o.uid ORDER BY o.id`);

  for (let i = 0; i < 8; i++) {
    add('subqueries', `SELECT id FROM users WHERE id IN (SELECT uid FROM orders WHERE total > ${r(900)}) ORDER BY id`);
    add('subqueries', `SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.uid = u.id AND o.status = '${STATUS[i % 3]}') ORDER BY id`);
    add('subqueries', `SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.uid = u.id AND o.total > ${100 * i}) ORDER BY id`);
    add('subqueries', `SELECT id FROM users WHERE age > (SELECT AVG(age) FROM users WHERE city = '${CITIES[i % 3]}') ORDER BY id`);
    add('subqueries', `SELECT x.city, x.n FROM (SELECT city, COUNT(*) AS n FROM users GROUP BY city) x WHERE x.n > ${i * 5} ORDER BY x.city`);
  }

  for (let i = 0; i < 8; i++) {
    add('set operations, ordering, limit', `SELECT id FROM users WHERE age < ${25 + i * 5} UNION SELECT id FROM users WHERE city = '${CITIES[i % 3]}' ORDER BY id`);
    add('set operations, ordering, limit', `SELECT id FROM users WHERE age < ${25 + i * 5} INTERSECT SELECT id FROM users WHERE city = '${CITIES[i % 3]}' ORDER BY id`);
    add('set operations, ordering, limit', `SELECT id FROM users WHERE age < ${25 + i * 5} EXCEPT SELECT uid FROM orders ORDER BY id`);
    add('set operations, ordering, limit', `SELECT id FROM users WHERE id < ${10 + i} UNION ALL SELECT id FROM users WHERE id < ${5 + i} ORDER BY id`);
    add('set operations, ordering, limit', `SELECT id, age FROM users ORDER BY age DESC, id LIMIT ${5 + i} OFFSET ${i}`);
    add('set operations, ordering, limit', `SELECT id, city FROM users ORDER BY city, id LIMIT ${10 + i}`);
  }
  add('set operations, ordering, limit', `SELECT DISTINCT city FROM users ORDER BY city`);
  add('set operations, ordering, limit', `SELECT DISTINCT age / 10 FROM users ORDER BY 1`);

  for (let i = 0; i < 10; i++) {
    add('expressions and functions', `SELECT id, COALESCE(city, '?'), UPPER(name), LENGTH(name), ABS(age - 40) FROM users WHERE id = ${1 + i * 17}`);
    add('expressions and functions', `SELECT u.id, age * 2 + 1, age % 7, o.total / 3, age / 3 FROM users u JOIN orders o ON o.uid = u.id WHERE o.id = ${1 + i * 53} ORDER BY u.id`);
    add('expressions and functions', `SELECT id, age + NULL, age IS NULL, name || '-' || id FROM users WHERE id = ${2 + i * 11}`);
  }
  return g;
}

describe('differential vs SQLite (seed 42)', () => {
  let dir: string, lite: Oracle, mini: Database;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-diff-'));
    lite = await makeOracle();
    mini = await openDatabase(join(dir, 'd.db'));
    await seedBoth(lite, mini);
  });
  after(async () => { await mini.close(); rmSync(dir, { recursive: true, force: true }); });

  async function compareOne(sql: string, ordered: boolean): Promise<string | null> {
    let le: string | undefined, me: string | undefined, a: any[][] = [], b: any[][] = [];
    try { a = normRows(lite.rows(sql)); } catch (e) { le = (e as Error).message; }
    try { b = normRows((await mini.query(sql)).rows as unknown[][]); } catch (e) { me = (e as Error).message; }
    if (le && me) return null; // both reject
    if (le) return `SQLite rejects (${le}) but mini accepted`;
    if (me) return `mini failed (${me}) but SQLite accepted`;
    return diffRows(a, b, ordered);
  }

  for (const [group, cases] of Object.entries(buildCases())) {
    it(`${group} (${cases.length} queries)`, async () => {
      const fails: string[] = [];
      for (const c of cases) {
        const d = await compareOne(c.sql, c.ordered);
        if (d) fails.push(`${c.sql}\n    -> ${d}`);
      }
      assert.equal(fails.length, 0, `${fails.length}/${cases.length} queries differ. First ${Math.min(SHOW, fails.length)}:\n  ${fails.slice(0, SHOW).join('\n  ')}`);
    });
  }

  it('both engines reject invalid statements', async () => {
    const bad = [
      `SELECT id FROM users u JOIN orders o ON o.uid = u.id`,            // ambiguous column
      `SELECT nope FROM users`, `SELECT * FROM nope`,
      `INSERT INTO users VALUES(1,'dup',1,'x')`,                            // duplicate primary key
      `INSERT INTO users(id, age) VALUES(9999, 1)`,                         // NOT NULL name
    ];
    const wrong: string[] = [];
    for (const s of bad) {
      let le = false, me = false;
      try { lite.exec(s); } catch { le = true; }
      try { await mini.exec(s); } catch { me = true; }
      if (le !== me) wrong.push(`${s} (sqlite rejects=${le}, mini rejects=${me})`);
    }
    assert.equal(wrong.length, 0, wrong.join('\n'));
  });
});

describe('DML parity: table state matches SQLite after every mutation', () => {
  let dir: string, lite: Oracle, mini: Database;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-dml-'));
    lite = await makeOracle();
    mini = await openDatabase(join(dir, 'd.db'));
    await seedBoth(lite, mini);
  });
  after(async () => { await mini.close(); rmSync(dir, { recursive: true, force: true }); });

  const mutations = [
    `UPDATE users SET age = age + 1 WHERE city = 'hue'`,
    `UPDATE users SET city = NULL WHERE age > 60`,
    `DELETE FROM orders WHERE status = 'void'`,
    `DELETE FROM users WHERE id % 11 = 0`,
    `DELETE FROM orders WHERE uid IN (SELECT id FROM users WHERE age IS NULL)`,
    `UPDATE orders SET total = total * 1.5 WHERE status = 'paid'`,
    `INSERT INTO users VALUES(1000, 'zz', NULL, NULL)`,
    `UPDATE users SET id = 2000 WHERE id = 1000`,
    `INSERT INTO orders SELECT id + 10000, uid, total, status FROM orders WHERE id < 20`,
    `UPDATE users SET age = NULL WHERE age < 25`,
  ];
  const views = [
    `SELECT * FROM users ORDER BY id`, `SELECT * FROM orders ORDER BY id`,
    `SELECT COUNT(*), SUM(age) FROM users`, `SELECT city, COUNT(*) FROM users GROUP BY city ORDER BY city`,
    `SELECT id FROM users WHERE age < 40 ORDER BY id`,             // goes through the age index
    `SELECT id FROM users WHERE age >= 30 ORDER BY id`,
  ];
  it(`${mutations.length} mutations x ${views.length} views`, async () => {
    const fails: string[] = [];
    for (const m of mutations) {
      let le: string | undefined, me: string | undefined;
      try { lite.exec(m); } catch (e) { le = (e as Error).message; }
      try { await mini.exec(m); } catch (e) { me = (e as Error).message; }
      if (!!le !== !!me) fails.push(`${m}\n    -> error mismatch: sqlite=${le ?? 'ok'} mini=${me ?? 'ok'}`);
      for (const v of views) {
        const d = diffRows(normRows(lite.rows(v)), normRows((await mini.query(v)).rows as unknown[][]), true);
        if (d) fails.push(`after ${m}: ${v}\n    -> ${d}`);
      }
    }
    assert.equal(fails.length, 0, `${fails.length} mismatches. First ${Math.min(SHOW, fails.length)}:\n  ${fails.slice(0, SHOW).join('\n  ')}`);
  });
});
