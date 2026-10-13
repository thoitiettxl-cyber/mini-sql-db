// Public entry point for mini-sql-db.
import { Database } from './db.js';
export { Database } from './db.js';
export type { Transaction, QueryResult, WriteResult } from './db.js';
export type { SqlValue } from './value.js';

export async function openDatabase(path: string): Promise<Database> {
  return Database.open(path);
}
