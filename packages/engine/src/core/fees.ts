/**
 * Equity charges (SPEC §11.5), computed in BigInt paise from config/fees.json: a rate (exact fraction)
 * plus an optional flat amount per order (brokerage). Each charge is rounded half-up to the nearest
 * paisa per order. GST is 18% of the unrounded sum of its base charges, then rounded. The DP charge
 * (delivery only) is a flat amount on the first SELL of a symbol per day.
 */
import type { FeesConfig, ChargeName } from '@arena/shared/schemas';
import { divRoundHalfUp } from '@arena/shared/money';

export type Side = 'BUY' | 'SELL';

export const CHARGE_KEYS = [
  'brokerage',
  'stt',
  'exchange',
  'sebi',
  'ipft',
  'stamp',
  'gst',
  'dp',
] as const;
export type ChargeKey = (typeof CHARGE_KEYS)[number];
export type Charges = Record<ChargeKey, bigint>;

export interface ChargeResult {
  lines: Charges;
  total: bigint;
}

function applies(appliesTo: 'buy' | 'sell' | 'both', side: Side): boolean {
  return appliesTo === 'both' || (appliesTo === 'buy' ? side === 'BUY' : side === 'SELL');
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

const flatOf = (c: { flatPaisePerOrder?: string | undefined }): bigint =>
  c.flatPaisePerOrder === undefined ? 0n : BigInt(c.flatPaisePerOrder);

export function computeCharges(
  fees: FeesConfig,
  side: Side,
  valuePaise: bigint,
  opts: { dpApplies: boolean },
): ChargeResult {
  if (valuePaise < 0n) throw new RangeError('trade value must be non-negative');
  const lines: Charges = {
    brokerage: 0n,
    stt: 0n,
    exchange: 0n,
    sebi: 0n,
    ipft: 0n,
    stamp: 0n,
    gst: 0n,
    dp: 0n,
  };
  const names = Object.keys(fees.charges) as ChargeName[];
  for (const name of names) {
    const c = fees.charges[name];
    if (!applies(c.appliesTo, side)) continue;
    lines[name] = divRoundHalfUp(valuePaise * BigInt(c.rate.num), BigInt(c.rate.den)) + flatOf(c);
  }
  // GST on the exact (unrounded) base: (value × Σ(num_i/den_i) + Σ flat_i) × gstNum/gstDen.
  let num = 0n;
  let den = 1n;
  let flat = 0n;
  for (const name of fees.gst.on) {
    const c = fees.charges[name];
    if (!applies(c.appliesTo, side)) continue;
    const n = BigInt(c.rate.num);
    const d = BigInt(c.rate.den);
    num = num * d + n * den;
    den = den * d;
    const g = gcd(num, den);
    num /= g;
    den /= g;
    flat += flatOf(c);
  }
  lines.gst = divRoundHalfUp(
    (valuePaise * num + flat * den) * BigInt(fees.gst.rate.num),
    den * BigInt(fees.gst.rate.den),
  );
  if (side === 'SELL' && opts.dpApplies && fees.dpCharge)
    lines.dp = BigInt(fees.dpCharge.paisePerSymbolPerDay);
  let total = 0n;
  for (const k of CHARGE_KEYS) total += lines[k];
  return { lines, total };
}

/**
 * Charge rate for one side as a percentage string with 3 decimals, excluding flat per-order amounts
 * (see flatPerOrderPaise) and the DP charge. For the prompt.
 */
export function costPctString(fees: FeesConfig, side: Side): string {
  // Evaluate on ₹1 crore (1e9 paise) so rounding is far below the displayed precision.
  const base = 1_000_000_000n;
  const { lines } = computeCharges(withoutFlat(fees), side, base, { dpApplies: false });
  const t =
    lines.brokerage +
    lines.stt +
    lines.exchange +
    lines.sebi +
    lines.ipft +
    lines.stamp +
    lines.gst;
  const thousandthsPct = divRoundHalfUp(t * 100_000n, base); // percent × 1000
  return `${thousandthsPct / 1000n}.${(thousandthsPct % 1000n).toString().padStart(3, '0')}`;
}

function withoutFlat(fees: FeesConfig): FeesConfig {
  const charges = Object.fromEntries(
    Object.entries(fees.charges).map(([k, c]) => [k, { ...c, flatPaisePerOrder: undefined }]),
  ) as FeesConfig['charges'];
  return { ...fees, charges };
}

/** Flat amount per executed order on one side, GST included (e.g. ₹20 brokerage → 2360 paise). */
export function flatPerOrderPaise(fees: FeesConfig, side: Side): bigint {
  const zeroRates = Object.fromEntries(
    Object.entries(fees.charges).map(([k, c]) => [k, { ...c, rate: { num: 0, den: 1 } }]),
  ) as FeesConfig['charges'];
  return computeCharges({ ...fees, charges: zeroRates }, side, 0n, { dpApplies: false }).total;
}

export function chargesToJson(c: Charges): Record<ChargeKey, string> {
  return Object.fromEntries(CHARGE_KEYS.map((k) => [k, c[k].toString()])) as Record<
    ChargeKey,
    string
  >;
}
