// Quick end-to-end smoke test (not part of the suite).
import { openDatabase } from './index.js';
import { rmSync } from 'node:fs';

const file = '/tmp/mini-smoke.db';
try { rmSync(file); } catch { /* fresh */ }

const db = await openDatabase(file);
const q = async (sql: string) => {
  try {
    const results = await db.exec(sql);
    console.log('OK  ', sql.slice(0, 70));
    for (const r of results) {
      if ('columns' in r) {
        console.log('      cols:', r.columns.join(','));
        for (const row of r.rows.slice(0, 5)) console.log('      ', JSON.stringify(row));
      } else if ('changes' in r) {
        console.log('      changes=' + r.changes + ' lastRowid=' + r.lastRowid);
      } else {
        console.log('      ok');
      }
    }
  } catch (e) {
    console.log('FAIL', sql.slice(0, 70), '::', (e as Error).message);
  }
};

await q(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER DEFAULT 0)`);
await q(`INSERT INTO users(name, age) VALUES ('alice', 30), ('bob', 25), ('carol', NULL)`);
await q(`INSERT INTO users(name) VALUES ('dave')`);
await q(`SELECT * FROM users`);
await q(`SELECT name, age FROM users WHERE age >= 25 ORDER BY age DESC`);
await q(`SELECT COUNT(*), AVG(age), MAX(name) FROM users`);
await q(`CREATE TABLE orders(id INTEGER PRIMARY KEY, uid INTEGER, total REAL)`);
await q(`INSERT INTO orders(uid, total) VALUES (1, 9.99), (1, 4.50), (2, 100.0), (99, 1.0)`);
await q(`SELECT u.name, o.total FROM users u JOIN orders o ON o.uid = u.id ORDER BY o.total`);
await q(`SELECT u.name, SUM(o.total) AS s FROM users u LEFT JOIN orders o ON o.uid = u.id GROUP BY u.name ORDER BY s`);
await q(`SELECT name FROM users WHERE id IN (SELECT uid FROM orders WHERE total > 5)`);
await q(`UPDATE users SET age = age + 1 WHERE name = 'alice'`);
await q(`SELECT name, age FROM users WHERE name = 'alice'`);
await q(`DELETE FROM orders WHERE total < 5`);
await q(`SELECT COUNT(*) FROM orders`);
await q(`SELECT name FROM users UNION SELECT name FROM users ORDER BY 1`);
await q(`EXPLAIN SELECT * FROM users WHERE id = 1`);

await db.close();
console.log('smoke done');
