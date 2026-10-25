/**
 * The one formatter module (SPEC §16.6). All times are shown in IST regardless of the viewer.
 */
const MINUS = '−';
const TZ = 'Asia/Kolkata';

/** Indian digit grouping of a non-negative integer string: 10000000 -> 1,00,00,000. */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  let rest = intDigits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** ₹1,00,000.00 from paise. `decimals` is 0 or 2. */
export function formatInr(paise: bigint, opts: { decimals?: 0 | 2 } = {}): string {
  const decimals = opts.decimals ?? 2;
  const neg = paise < 0n;
  let a = neg ? -paise : paise;
  let out: string;
  if (decimals === 0) {
    a = (a + 50n) / 100n;
    out = `₹${groupIndian(a.toString())}`;
  } else {
    out = `₹${groupIndian((a / 100n).toString())}.${(a % 100n).toString().padStart(2, '0')}`;
  }
  return neg ? `${MINUS}${out}` : out;
}

/** Compact rupees: ₹1.04L, ₹2.5Cr; below one lakh, whole rupees with grouping. */
export function formatInrCompact(paise: bigint): string {
  const neg = paise < 0n;
  const a = neg ? -paise : paise;
  const LAKH = 100_000n * 100n;
  const CRORE = 10_000_000n * 100n;
  let out: string;
  if (a >= CRORE) out = `₹${scaled(a, CRORE)}Cr`;
  else if (a >= LAKH) out = `₹${scaled(a, LAKH)}L`;
  else out = formatInr(a, { decimals: 0 });
  return neg ? `${MINUS}${out}` : out;
}

function scaled(a: bigint, unit: bigint): string {
  // Two decimals, half-up, trailing zeros trimmed.
  const hundredths = (a * 100n + unit / 2n) / unit;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${groupIndian(whole.toString())}.${frac}` : groupIndian(whole.toString());
}

/** Signed percentage with arrow: ▲ +4.21%, ▼ −1.07%, 0.00%. Input is a fraction (0.0421). */
export function formatPct(fraction: number, opts: { arrow?: boolean } = {}): string {
  if (!Number.isFinite(fraction)) throw new RangeError('not a finite number');
  const arrow = opts.arrow ?? true;
  const hundredths = Math.round(fraction * 10000);
  const abs = (Math.abs(hundredths) / 100).toFixed(2);
  if (hundredths === 0) return '0.00%';
  if (hundredths > 0) return `${arrow ? '▲ ' : ''}+${abs}%`;
  return `${arrow ? '▼ ' : ''}${MINUS}${abs}%`;
}

/**
 * A model's name for display: OpenRouter's "Lab: Name" without the lab prefix, and without the
 * " (free)" tag that free variants carry (the tier is shown on /rules, not in every name).
 */
export function cleanModelName(name: string): string {
  return name
    .replace(/^[^:]+:\s*/, '')
    .replace(/\s*\(free\)\s*$/i, '')
    .trim();
}

/** A change in rupees, signed, with ▲/▼ so colour is never the only cue: ▲ +₹4,212.00, ▼ −₹2,100.00. */
export function formatInrChange(paise: bigint, opts: { decimals?: 0 | 2 } = {}): string {
  if (paise === 0n) return formatInr(0n, opts);
  return paise > 0n ? `▲ +${formatInr(paise, opts)}` : `▼ ${formatInr(paise, opts)}`;
}

/** Percentage points, signed, for "vs Nifty": +1.20 pts. */
export function formatPts(fractionDiff: number): string {
  const hundredths = Math.round(fractionDiff * 10000);
  const abs = (Math.abs(hundredths) / 100).toFixed(2);
  if (hundredths === 0) return '0.00 pts';
  return `${hundredths > 0 ? '+' : MINUS}${abs} pts`;
}

export function direction(fraction: number): 'gain' | 'loss' | 'flat' {
  const h = Math.round(fraction * 10000);
  return h > 0 ? 'gain' : h < 0 ? 'loss' : 'flat';
}

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const longDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'short',
});

/** 11:30 IST */
export function formatTimeIst(d: Date): string {
  return `${timeFmt.format(d)} IST`;
}

function partsOf(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  return Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
}

/** Mon 2 Nov */
export function formatDateIst(d: Date): string {
  const p = partsOf(dateFmt, d);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** Monday 2 Nov */
export function formatLongDateIst(d: Date): string {
  const p = partsOf(longDateFmt, d);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** Mon 2 Nov, 11:30 IST */
export function formatDateTimeIst(d: Date): string {
  return `${formatDateIst(d)}, ${formatTimeIst(d)}`;
}

/** A date-only value (YYYY-MM-DD, a trading date) formatted as Mon 2 Nov, without time-zone drift. */
export function formatTradingDate(isoDate: string): string {
  return formatDateIst(new Date(`${isoDate}T12:00:00+05:30`));
}

export function formatInt(n: number | bigint): string {
  const neg = n < 0;
  const s = (neg ? -BigInt(n) : BigInt(n)).toString();
  return `${neg ? MINUS : ''}${groupIndian(s)}`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
