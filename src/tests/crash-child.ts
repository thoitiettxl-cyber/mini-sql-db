// Child process for crash.test.ts: inserts forever and prints "ACK <n>" only after the commit returned.
import { writeSync } from 'node:fs';
import { openDatabase } from '../index.js';

const [, , path, mode, startArg] = process.argv;
const start = Number(startArg);
const db = await openDatabase(path);
if (start === 0) {
  await db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER, s TEXT)`);
  await db.exec(`CREATE INDEX iv ON t(v)`);
}
for (let i = start + 1; ; i++) {
  if (mode === 'single') {
    await db.exec(`INSERT INTO t VALUES(${i}, ${i % 1000}, 'row-${i}-${'x'.repeat(i % 50)}')`);
  } else {
    // two rows in one explicit transaction: after a crash both must exist or neither
    await db.exec(`BEGIN; INSERT INTO t VALUES(${i}, ${i % 1000}, 'a'); INSERT INTO t VALUES(${i + 1000000}, ${i % 1000}, 'b'); COMMIT`);
  }
  writeSync(1, `ACK ${i}\n`); // synchronous: not lost in a buffer when we get SIGKILLed
}
