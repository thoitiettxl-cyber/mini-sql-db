// SQL value system: storage classes, SQLite-compatible comparison, type affinity.
// No external dependencies.

export type SqlValue = null | number | string | Uint8Array;

export type StorageClass = 'null' | 'integer' | 'real' | 'text' | 'blob';

export type Affinity = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC';

export function storageClass(v: SqlValue): StorageClass {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'real';
  if (typeof v === 'string') return 'text';
  return 'blob';
}

/** SQLite column type affinity derived from the declared type name. */
export function affinityOf(declaredType: string): Affinity {
  const t = declaredType.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB') || t === '') return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

/** Convert a number to its canonical SQLite text representation. */
export function numToText(n: number): string {
  if (!Number.isFinite(n)) return 'Inf';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toPrecision(15);
  if (s.includes('e') || s.includes('E')) return s;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Parse leading numeric prefix of text like SQLite (null when none). */
export function textToNumber(s: string): number | null {
  const m = /^[\s]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isNaN(n) ? null : n;
}

export function textToInteger(s: string): number {
  const n = textToNumber(s);
  return n === null ? 0 : Math.trunc(n);
}

/** Apply column affinity to a value, following SQLite rules. */
export function applyAffinity(v: SqlValue, aff: Affinity): SqlValue {
  if (v === null) return null;
  const sc = storageClass(v);
  switch (aff) {
    case 'TEXT':
      if (sc === 'text' || sc === 'blob') return v;
      return numToText(v as number);
    case 'NUMERIC':
      if (sc === 'integer' || sc === 'real') return v;
      if (sc === 'text') {
        const n = textToNumber(v as string);
        return n === null ? v : n;
      }
      return v;
    case 'INTEGER':
      if (sc === 'integer') return v;
      if (sc === 'real') return v;
      if (sc === 'text') {
        const n = textToNumber(v as string);
        if (n === null) return v;
        return Math.trunc(n);
      }
      return v;
    case 'REAL':
      if (sc === 'real' || sc === 'integer') return v;
      if (sc === 'text') {
        const n = textToNumber(v as string);
        return n === null ? v : n;
      }
      return v;
    case 'BLOB':
    default:
      return v;
  }
}

/** SQLite value ordering: NULL < numbers < text < blob. Returns -1 | 0 | 1. */
export function compareValues(a: SqlValue, b: SqlValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'number') return -1;
  if (tb === 'number') return 1;
  if (ta === 'string' && tb === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'string') return -1;
  if (tb === 'string') return 1;
  const ab = a as Uint8Array;
  const bb = b as Uint8Array;
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1;
  }
  return ab.length < bb.length ? -1 : ab.length > bb.length ? 1 : 0;
}

/** SQL `=` equality on values: null when either side is null. */
export function sqlEquals(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  return compareValues(a, b) === 0 ? 1 : 0;
}

/** Truthiness for WHERE/HAVING/WHEN: NULL and 0 are false, everything else true. */
export function isTruthy(v: SqlValue): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const n = textToNumber(v);
    return n !== null && n !== 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Arithmetic / operators with SQLite semantics
// ---------------------------------------------------------------------------

function toNumberOrNull(v: SqlValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = textToNumber(v);
    return n === null ? 0 : n;
  }
  return null;
}

export function sqlAdd(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  return toNumberOrNull(a)! + toNumberOrNull(b)!;
}

export function sqlSub(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  return toNumberOrNull(a)! - toNumberOrNull(b)!;
}

export function sqlMul(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  return toNumberOrNull(a)! * toNumberOrNull(b)!;
}

export function sqlDiv(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  const y = toNumberOrNull(b)!;
  if (y === 0) return null;
  return toNumberOrNull(a)! / y; // always real in SQLite
}

export function sqlMod(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  const y = toNumberOrNull(b)!;
  if (y === 0) return null;
  return Math.trunc(toNumberOrNull(a)!) % Math.trunc(y);
}

export function sqlNeg(a: SqlValue): SqlValue {
  if (a === null) return null;
  const x = toNumberOrNull(a);
  return x === null ? null : -x;
}

export function toText(v: SqlValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return numToText(v);
  if (typeof v === 'string') return v;
  return new TextDecoder().decode(v);
}

export function sqlConcat(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    const ab = a instanceof Uint8Array ? a : new TextEncoder().encode(toText(a));
    const bb = b instanceof Uint8Array ? b : new TextEncoder().encode(toText(b));
    const out = new Uint8Array(ab.length + bb.length);
    out.set(ab, 0);
    out.set(bb, ab.length);
    return out;
  }
  return toText(a) + toText(b);
}

// ---------------------------------------------------------------------------
// CAST
// ---------------------------------------------------------------------------

export function sqlCast(v: SqlValue, target: string): SqlValue {
  const t = target.toUpperCase();
  if (v === null) return null;
  if (t.includes('INT')) {
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'string') return textToInteger(v);
    return 0;
  }
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = textToNumber(v);
      return n === null ? 0.0 : n;
    }
    return 0.0;
  }
  if (t.includes('TEXT') || t.includes('CHAR') || t.includes('CLOB')) {
    if (v instanceof Uint8Array) return new TextDecoder().decode(v);
    return toText(v);
  }
  if (t.includes('BLOB')) {
    if (v instanceof Uint8Array) return v;
    return new TextEncoder().encode(toText(v));
  }
  return applyAffinity(v, 'NUMERIC');
}

// ---------------------------------------------------------------------------
// LIKE / GLOB pattern matching (LIKE is ASCII case-insensitive, like SQLite)
// ---------------------------------------------------------------------------

function matchPattern(str: string, pat: string, escape: string | null, like: boolean): boolean {
  const s = [...str];
  const p = [...pat];
  const esc = escape ? [...escape][0] : null;
  function rec(si: number, pi: number): boolean {
    while (pi < p.length) {
      const c = p[pi];
      if (esc !== null && c === esc && pi + 1 < p.length) {
        pi++;
        if (si >= s.length || s[si] !== p[pi]) return false;
        si++; pi++;
        continue;
      }
      const many = like ? c === '%' : c === '*';
      const one = like ? c === '_' : c === '?';
      if (many) {
        for (let k = si; k <= s.length; k++) if (rec(k, pi + 1)) return true;
        return false;
      }
      if (one) {
        if (si >= s.length) return false;
        si++; pi++;
        continue;
      }
      if (!like && c === '[') {
        pi++;
        let negate = false;
        if (p[pi] === '^') { negate = true; pi++; }
        let matched = false;
        let first = true;
        while (pi < p.length && (p[pi] !== ']' || first)) {
          first = false;
          if (pi + 2 < p.length && p[pi + 1] === '-' && p[pi + 2] !== ']') {
            if (si < s.length && s[si] >= p[pi] && s[si] <= p[pi + 2]) matched = true;
            pi += 3;
          } else {
            if (si < s.length && s[si] === p[pi]) matched = true;
            pi++;
          }
        }
        pi++;
        if (si >= s.length) return false;
        if (matched === negate) return false;
        si++;
        continue;
      }
      if (si >= s.length) return false;
      const sc = like ? s[si].toLowerCase() : s[si];
      const pc = like ? c.toLowerCase() : c;
      if (sc !== pc) return false;
      si++; pi++;
    }
    return si === s.length;
  }
  return rec(0, 0);
}

export function sqlLike(value: SqlValue, pattern: SqlValue, escape: SqlValue = null): SqlValue {
  if (value === null || pattern === null) return null;
  if (escape !== null && typeof escape !== 'string') return null;
  const s = value instanceof Uint8Array ? new TextDecoder().decode(value) : toText(value);
  const p = pattern instanceof Uint8Array ? new TextDecoder().decode(pattern) : toText(pattern);
  return matchPattern(s, p, typeof escape === 'string' ? escape : null, true) ? 1 : 0;
}

export function sqlGlob(value: SqlValue, pattern: SqlValue): SqlValue {
  if (value === null || pattern === null) return null;
  const s = value instanceof Uint8Array ? new TextDecoder().decode(value) : toText(value);
  const p = pattern instanceof Uint8Array ? new TextDecoder().decode(pattern) : toText(pattern);
  return matchPattern(s, p, null, false) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Order-preserving key encoding for B-tree index keys.
// Per value: 1 tag byte (0=null,1=number,2=text,3=blob), then payload.
// Numbers: float64 bits mapped so memcmp == numeric order.
// Text: utf8 with NUL escaped, 0x00 terminator. Blob: u32be length + bytes.
// ---------------------------------------------------------------------------

export function encodeOrderKey(values: SqlValue[]): Buffer {
  const parts: Buffer[] = [];
  for (const v of values) {
    if (v === null) {
      parts.push(Buffer.from([0]));
    } else if (typeof v === 'number') {
      const fbuf = Buffer.alloc(8);
      fbuf.writeDoubleBE(v, 0);
      let u = fbuf.readBigUInt64BE(0);
      u = (u & 0x8000000000000000n) ? ~u : u ^ 0x8000000000000000n;
      const b = Buffer.alloc(9);
      b[0] = 1;
      b.writeBigUInt64BE(u, 1);
      parts.push(b);
    } else if (typeof v === 'string') {
      const raw = Buffer.from(v, 'utf8');
      const esc: number[] = [2];
      for (const byte of raw) {
        if (byte === 0) esc.push(0, 1);
        else esc.push(byte);
      }
      esc.push(0);
      parts.push(Buffer.from(esc));
    } else {
      const b = Buffer.alloc(1 + 4 + v.length);
      b[0] = 3;
      b.writeUInt32BE(v.length, 1);
      Buffer.from(v).copy(b, 5);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

export function encodeRowIdKey(rowid: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(rowid), 0);
  return b;
}

export function decodeRowIdKey(buf: Buffer): number {
  return Number(buf.readBigUInt64BE(0));
}

// ---------------------------------------------------------------------------
// Row serialization: [u32 ncols][col...]; col = tag + payload
// tags: 0=null, 1=int64 BE, 2=float64 BE, 3=text(u32 len+utf8), 4=blob(u32 len)
// ---------------------------------------------------------------------------

export function serializeRow(values: SqlValue[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(4)];
  parts[0].writeUInt32BE(values.length, 0);
  for (const v of values) {
    if (v === null) {
      parts.push(Buffer.from([0]));
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        const b = Buffer.alloc(9);
        b[0] = 1;
        b.writeBigInt64BE(BigInt(v), 1);
        parts.push(b);
      } else {
        const b = Buffer.alloc(9);
        b[0] = 2;
        b.writeDoubleBE(v, 1);
        parts.push(b);
      }
    } else if (typeof v === 'string') {
      const raw = Buffer.from(v, 'utf8');
      const b = Buffer.alloc(1 + 4 + raw.length);
      b[0] = 3;
      b.writeUInt32BE(raw.length, 1);
      raw.copy(b, 5);
      parts.push(b);
    } else {
      const b = Buffer.alloc(1 + 4 + v.length);
      b[0] = 4;
      b.writeUInt32BE(v.length, 1);
      Buffer.from(v).copy(b, 5);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

export function deserializeRow(buf: Buffer): SqlValue[] {
  let off = 0;
  const n = buf.readUInt32BE(off); off += 4;
  const out: SqlValue[] = [];
  for (let i = 0; i < n; i++) {
    const tag = buf[off]; off += 1;
    if (tag === 0) out.push(null);
    else if (tag === 1) { out.push(Number(buf.readBigInt64BE(off))); off += 8; }
    else if (tag === 2) { out.push(buf.readDoubleBE(off)); off += 8; }
    else if (tag === 3) {
      const len = buf.readUInt32BE(off); off += 4;
      out.push(buf.toString('utf8', off, off + len)); off += len;
    } else if (tag === 4) {
      const len = buf.readUInt32BE(off); off += 4;
      out.push(new Uint8Array(buf.subarray(off, off + len))); off += len;
    } else throw new Error('bad row tag ' + tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// MVCC version chain: [u32 nver][ver...]; ver = [u64 xmin][u64 xmax][row]
// ---------------------------------------------------------------------------

export interface RowVersion {
  xmin: bigint;
  xmax: bigint; // 0n = live
  values: SqlValue[];
}

export function serializeChain(chain: RowVersion[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(4)];
  parts[0].writeUInt32BE(chain.length, 0);
  for (const ver of chain) {
    const rowBuf = serializeRow(ver.values);
    const h = Buffer.alloc(20);
    h.writeBigUInt64BE(ver.xmin, 0);
    h.writeBigUInt64BE(ver.xmax, 8);
    h.writeUInt32BE(rowBuf.length, 16);
    parts.push(h, rowBuf);
  }
  return Buffer.concat(parts);
}

export function deserializeChain(buf: Buffer): RowVersion[] {
  let off = 0;
  const n = buf.readUInt32BE(off); off += 4;
  const out: RowVersion[] = [];
  for (let i = 0; i < n; i++) {
    const xmin = buf.readBigUInt64BE(off); off += 8;
    const xmax = buf.readBigUInt64BE(off); off += 8;
    const rowLen = buf.readUInt32BE(off); off += 4;
    const values = deserializeRow(buf.subarray(off, off + rowLen));
    off += rowLen;
    out.push({ xmin, xmax, values });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRC32 (WAL framing)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(buf: Buffer, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Canonical normalization for differential tests
// ---------------------------------------------------------------------------

export function normalizeForTest(v: SqlValue): unknown {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { $int: String(v) };
    return { $float: Number(v.toPrecision(12)) };
  }
  if (typeof v === 'string') return { $text: v };
  return { $blob: Buffer.from(v).toString('hex') };
}
