/**
 * Money is integer paise (bigint). Floats are never used for money.
 * Provider prices arrive as JSON numbers in rupees; they are converted through
 * their decimal string form, never through float multiplication.
 */
export type Paise = bigint;

export const PAISE_PER_RUPEE = 100n;

/** Rounds num/den half away from zero. den must be positive. */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('den must be positive');
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / den;
  const r = a % den;
  const rounded = r * 2n >= den ? q + 1n : q;
  return neg ? -rounded : rounded;
}

/** amount × num / den, rounded half-up to an integer. */
export function mulFrac(amount: bigint, num: bigint, den: bigint): bigint {
  return divRoundHalfUp(amount * num, den);
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Converts a decimal number (rupees, or index points) to an integer scaled by 10^scale,
 * rounding half-up on the dropped digits. Rejects NaN, Infinity and exponent notation.
 */
export function decimalToScaled(value: number | string, scale = 2): bigint {
  const s = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new RangeError(`not a plain decimal: ${String(value)}`);
  const [, sign, intPart = '0', fracRaw = ''] = m;
  const frac = fracRaw.padEnd(scale + 1, '0');
  const kept = BigInt(intPart + frac.slice(0, scale));
  const nextDigit = Number(frac[scale] ?? '0');
  const magnitude = nextDigit >= 5 ? kept + 1n : kept;
  return sign ? -magnitude : magnitude;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`not a finite number: ${n}`);
  const s = String(n);
  if (/e/i.test(s)) {
    // toFixed(10) is exact enough for exchange prices, which have at most 2 decimals.
    if (Math.abs(n) >= 1e21) throw new RangeError(`number too large: ${n}`);
    return n.toFixed(10);
  }
  return s;
}

export const rupeesToPaise = (v: number | string): Paise => decimalToScaled(v, 2);

/** Paise to a plain decimal string in rupees, e.g. 341250n -> "3412.50". Used in prompts. */
export function paiseToDecimal(p: Paise): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** A ratio of two bigints as a float, for display and indicators only. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) throw new RangeError('division by zero');
  return Number(a) / Number(b);
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function sumBig(xs: Iterable<bigint>): bigint {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
}
