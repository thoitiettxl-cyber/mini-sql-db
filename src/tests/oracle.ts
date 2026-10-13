// Shared helpers for the differential tests: SQLite oracle + result comparison.
// Oracle: better-sqlite3 (devDependency) if it loads, otherwise Node's built-in node:sqlite.

export interface Oracle {
  name: string;
  exec(sql: string): void;
  rows(sql: string): unknown[][];
}

export async function makeOracle(): Promise<Oracle> {
  try {
    const mod: any = await import('better-sqlite3' as string);
    const db = new (mod.default ?? mod)(':memory:');
    return { name: 'better-sqlite3', exec: s => { db.exec(s); }, rows: s => db.prepare(s).raw(true).all() };
  } catch { /* native module not built: fall back */ }
  const { DatabaseSync }: any = await import('node:sqlite' as string);
  const db = new DatabaseSync(':memory:');
  return {
    name: 'node:sqlite',
    exec: s => { db.exec(s); },
    rows: s => { const p = db.prepare(s); p.setReturnArrays(true); return p.all(); },
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

type V = null | number | string;
export function norm(v: unknown): V {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return String(v);
}

function eqV(a: V, b: V): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

const key = (r: V[]) => r.map(v => (v === null ? '\u0000' : typeof v === 'number' ? v.toFixed(4) : v)).join('\u0001');

export function normRows(rows: unknown[][]): V[][] {
  return rows.map(r => r.map(norm));
}

/** Returns a short description of the first difference, or null if equal. */
export function diffRows(expected: V[][], actual: V[][], ordered: boolean): string | null {
  const e = ordered ? expected : [...expected].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const a = ordered ? actual : [...actual].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  if (e.length !== a.length) {
    return `row count: sqlite=${e.length} mini=${a.length}; first sqlite=${JSON.stringify(e[0])} first mini=${JSON.stringify(a[0])}`;
  }
  for (let i = 0; i < e.length; i++) {
    const re = e[i], ra = a[i];
    if (re.length !== ra.length || re.some((v, j) => !eqV(v, ra[j]))) {
      return `row ${i}: sqlite=${JSON.stringify(re)} mini=${JSON.stringify(ra)}`;
    }
  }
  return null;
}
