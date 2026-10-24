import { divRoundHalfUp } from '@arena/shared/money';
import type { Candle } from './provider';

export interface IndicatorValues {
  sma20Paise: bigint | null;
  sma50Paise: bigint | null;
  rsi14: number | null;
  avgVol20d: bigint | null;
}

function smaPaise(closes: bigint[], n: number): bigint | null {
  if (closes.length < n) return null;
  let s = 0n;
  for (const c of closes.slice(-n)) s += c;
  return divRoundHalfUp(s, BigInt(n));
}

/** Wilder's RSI over completed closes. Needs n+1 closes; otherwise null (never 0). */
export function rsi(closes: bigint[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = Number(closes[i]! - closes[i - 1]!);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = Number(closes[i]! - closes[i - 1]!);
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/** Indicators from completed daily bars (oldest first). Short history omits values; never zero-fills. */
export function computeIndicators(bars: Candle[]): IndicatorValues {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const closes = sorted.map((b) => b.closePaise);
  const vols = sorted.map((b) => b.volume);
  return {
    sma20Paise: smaPaise(closes, 20),
    sma50Paise: smaPaise(closes, 50),
    rsi14: rsi(closes, 14),
    avgVol20d:
      vols.length >= 20
        ? divRoundHalfUp(
            vols.slice(-20).reduce((a, b) => a + b, 0n),
            20n,
          )
        : null,
  };
}

/** Close `n` trading days before today, given completed bars through yesterday (oldest first). */
export function closeNDaysAgo(bars: Candle[], n: number): bigint | null {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const b = sorted[sorted.length - n];
  return b ? b.closePaise : null;
}

/** Return of `ltp` against a reference close, as a fraction (display only). */
export function returnSince(ltpPaise: bigint, refPaise: bigint | null): number | null {
  if (refPaise === null || refPaise <= 0n) return null;
  return Number(ltpPaise - refPaise) / Number(refPaise);
}
