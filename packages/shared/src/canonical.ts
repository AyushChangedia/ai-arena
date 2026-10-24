/**
 * Canonical JSON (SPEC §11.7): keys sorted at every level, no whitespace,
 * integers (money, quantities, sequence numbers) as decimal strings,
 * timestamps as ISO 8601 UTC with milliseconds and Z, nulls kept.
 * Non-integer numbers are refused: the ledger holds no floats.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(v: unknown, path: string): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`non-integer number at ${path}: ${v}`);
    return JSON.stringify(String(v));
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError(`invalid date at ${path}`);
    return JSON.stringify(v.toISOString());
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => encode(x, `${path}[${i}]`)).join(',')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(',')}}`;
  }
  throw new TypeError(`unsupported value at ${path}: ${typeof v}`);
}

/** SHA-256 hex using Web Crypto, available in Node 20+ and every browser. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
