// Persistence and crash-recovery tests. Run: npm run test:crash   (CRASH_ROUNDS=50 for more rounds)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROUNDS = Number(process.env.CRASH_ROUNDS ?? 20);
const num = (v: unknown) => Number(v);

describe('persistence across close/reopen', () => {
  it('schema, rows and later writes survive a clean close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-reopen-'));
    const f = join(dir, 'p.db');
    try {
      let db = await openDatabase(f);
      await db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)`);
      await db.exec(`CREATE INDEX iv ON t(v)`);
      await db.exec(`INSERT INTO t VALUES (1,10),(2,20)`);
      await db.exec(`UPDATE t SET v = 25 WHERE id = 2`);
      await db.close();

      db = await openDatabase(f);
      assert.deepEqual((await db.query(`SELECT id, v FROM t ORDER BY id`)).rows.map(r => r.map(num)), [[1, 10], [2, 25]]);
      await db.exec(`INSERT INTO t VALUES (3,30)`);
      await db.exec(`DELETE FROM t WHERE id = 1`);
      await db.close();

      db = await openDatabase(f);
      assert.deepEqual((await db.query(`SELECT id, v FROM t ORDER BY id`)).rows.map(r => r.map(num)), [[2, 25], [3, 30]]);
      assert.deepEqual((await db.query(`SELECT id FROM t WHERE v >= 0 ORDER BY id`)).rows.map(r => num(r[0])), [2, 3]);
      await db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a larger table (page splits) survives close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-reopen-big-'));
    const f = join(dir, 'p.db');
    try {
      let db = await openDatabase(f);
      await db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT)`);
      for (let i = 1; i <= 600; i++) await db.exec(`INSERT INTO t VALUES (${i}, '${'y'.repeat(40 + (i % 30))}')`);
      await db.close();
      db = await openDatabase(f);
      const r = (await db.query(`SELECT COUNT(*), MIN(id), MAX(id) FROM t`)).rows[0].map(num);
      assert.deepEqual(r, [600, 1, 600]);
      await db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

async function crashRounds(mode: 'single' | 'txn') {
  const dir = mkdtempSync(join(tmpdir(), `mini-crash-${mode}-`));
  const f = join(dir, 'c.db');
  const problems: string[] = [];
  let acked = 0;
  try {
    for (let round = 1; round <= ROUNDS && problems.length === 0; round++) {
      const child = spawn(process.execPath, [join(here, 'crash-child.js'), f, mode, String(acked)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let last = acked, buf = '', err = '';
      child.stdout.on('data', d => { buf += d; let m; while ((m = buf.match(/ACK (\d+)\n/))) { last = Number(m[1]); buf = buf.slice(m.index! + m[0].length); } });
      child.stderr.on('data', d => { err += d; });
      const exited = new Promise<number | null>(res => child.once('exit', (code) => res(code)));
      const early = await Promise.race([exited, new Promise<'alive'>(res => setTimeout(() => res('alive'), 300 + Math.random() * 900))]);
      if (early !== 'alive') { problems.push(`round ${round}: child exited by itself (code ${early}): ${err.slice(0, 300)}`); break; }
      child.kill('SIGKILL');
      await exited;

      let db;
      try { db = await openDatabase(f); } catch (e) { problems.push(`round ${round}: reopen failed: ${(e as Error).message}`); break; }
      try {
        const ids = (await db.query(`SELECT COUNT(*), MAX(id) FROM t WHERE id < 1000000`)).rows[0].map(num);
        const [count, maxId] = ids;
        if (maxId < last) problems.push(`round ${round}: LOST committed rows (last acked ${last}, found max id ${maxId})`);
        if (count !== maxId) problems.push(`round ${round}: gap or partial state (count ${count}, max id ${maxId})`);
        const viaIndex = num((await db.query(`SELECT COUNT(*) FROM t WHERE v >= 0 AND id < 1000000`)).rows[0][0]);
        if (viaIndex !== count) problems.push(`round ${round}: index disagrees with table (index ${viaIndex}, table ${count})`);
        const seven = (await db.query(`SELECT id FROM t WHERE v = 7 AND id < 1000000 ORDER BY id`)).rows.map(r => num(r[0]));
        const expect = Array.from({ length: maxId }, (_, k) => k + 1).filter(i => i % 1000 === 7);
        if (JSON.stringify(seven) !== JSON.stringify(expect)) problems.push(`round ${round}: index lookup v=7 returned ${seven.length} rows, expected ${expect.length}`);
        if (mode === 'txn') {
          const second = num((await db.query(`SELECT COUNT(*) FROM t WHERE id >= 1000000`)).rows[0][0]);
          if (second !== count) problems.push(`round ${round}: transaction not atomic (first rows ${count}, second rows ${second})`);
        }
        acked = Math.max(maxId, last);
      } catch (e) {
        problems.push(`round ${round}: query after reopen failed: ${(e as Error).message}`);
      } finally { await db.close().catch(() => undefined); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { problems, acked };
}

describe(`kill -9 recovery (${ROUNDS} rounds each)`, () => {
  it('single-statement commits: nothing acknowledged is lost, no partial rows, index consistent', async () => {
    const { problems, acked } = await crashRounds('single');
    assert.deepEqual(problems, [], `${problems.length} problem(s) after ${acked} acknowledged commits`);
  });
  it('explicit BEGIN..COMMIT transactions are atomic after a crash', async () => {
    const { problems, acked } = await crashRounds('txn');
    assert.deepEqual(problems, [], `${problems.length} problem(s) after ${acked} acknowledged commits`);
  });
});
