import { DateTime } from 'luxon';
import type { RawQuote, RawIndexQuote } from './provider';

export interface ValidatedQuote extends RawQuote {
  valid: boolean;
  invalidReason: string | null;
  depthAvailable: boolean;
}
export interface ValidatedIndexQuote extends RawIndexQuote {
  valid: boolean;
  invalidReason: string | null;
}

export interface ValidationRules {
  maxQuoteAgeMinutes: number;
  maxDailyMovePct: number;
  maxInvalidQuotesPerSnapshot: number;
}

export interface ValidationContext {
  snapshotTime: Date;
  /** Check exchange-time freshness (rule 3). True during market hours. */
  checkFreshness: boolean;
  /** Symbols with a corporate action whose ex-date is today: exempt from the daily-move rule. */
  exDateToday: Set<string>;
  /** Index whose quote must be valid for the snapshot to be accepted. */
  requiredIndex: string;
  /** Today's trading date (YYYY-MM-DD, IST), for the unscheduled-closure safety net. */
  tradingDate: string;
}

export type SnapshotVerdict =
  | { status: 'ok' }
  | { status: 'rejected'; reason: 'DATA_DEGRADED' | 'MARKET_CLOSED_UNSCHEDULED'; detail: string };

export function istDate(d: Date): string {
  return DateTime.fromJSDate(d, { zone: 'Asia/Kolkata' }).toISODate()!;
}

/** Validates one quote against SPEC §8.4. Exactly one reason when invalid. */
export function validateQuote(
  q: RawQuote,
  rules: ValidationRules,
  ctx: ValidationContext,
): ValidatedQuote {
  const bad = (reason: string): ValidatedQuote => ({
    ...q,
    valid: false,
    invalidReason: reason,
    depthAvailable: false,
  });
  if (q.parseError) return bad(q.parseError);
  if (q.ltpPaise === null || q.ltpPaise <= 0n) return bad('ltp missing or not positive');
  if (q.prevClosePaise === null || q.prevClosePaise <= 0n)
    return bad('previous close missing or not positive');
  if (q.exchangeTime === null) return bad('exchange time missing');
  if (ctx.checkFreshness) {
    const ageMs = Math.abs(ctx.snapshotTime.getTime() - q.exchangeTime.getTime());
    if (ageMs > rules.maxQuoteAgeMinutes * 60_000)
      return bad(`stale: exchange time ${Math.round(ageMs / 60_000)} min from snapshot`);
  }
  if (!ctx.exDateToday.has(q.symbol)) {
    // |ltp/prev - 1| <= maxDailyMovePct/100, in integer arithmetic.
    const diff = q.ltpPaise - q.prevClosePaise;
    const absDiff = diff < 0n ? -diff : diff;
    if (absDiff * 100n > q.prevClosePaise * BigInt(rules.maxDailyMovePct))
      return bad(`moved more than ${rules.maxDailyMovePct}% from previous close`);
  }
  const depthAvailable =
    q.bidPaise !== null &&
    q.askPaise !== null &&
    q.bidPaise > 0n &&
    q.askPaise > 0n &&
    q.bidPaise <= q.askPaise;
  return {
    ...q,
    bidPaise: depthAvailable ? q.bidPaise : null,
    askPaise: depthAvailable ? q.askPaise : null,
    valid: true,
    invalidReason: null,
    depthAvailable,
  };
}

export function validateIndexQuote(
  q: RawIndexQuote,
  rules: ValidationRules,
  ctx: ValidationContext,
): ValidatedIndexQuote {
  const bad = (reason: string): ValidatedIndexQuote => ({
    ...q,
    valid: false,
    invalidReason: reason,
  });
  if (q.parseError) return bad(q.parseError);
  if (q.valueX100 === null || q.valueX100 <= 0n) return bad('value missing or not positive');
  if (q.prevCloseX100 === null || q.prevCloseX100 <= 0n)
    return bad('previous close missing or not positive');
  if (q.exchangeTime === null) return bad('exchange time missing');
  if (ctx.checkFreshness) {
    const ageMs = Math.abs(ctx.snapshotTime.getTime() - q.exchangeTime.getTime());
    if (ageMs > rules.maxQuoteAgeMinutes * 60_000) return bad('stale');
  }
  return { ...q, valid: true, invalidReason: null };
}

/**
 * Whole-snapshot verdict: closed market (exchange times from a previous day during scheduled hours),
 * too many invalid symbols, or an invalid index quote.
 */
export function snapshotVerdict(
  quotes: ValidatedQuote[],
  indices: ValidatedIndexQuote[],
  rules: ValidationRules,
  ctx: ValidationContext,
): SnapshotVerdict {
  if (ctx.checkFreshness) {
    const timed = [
      ...quotes.map((q) => q.exchangeTime),
      ...indices.map((i) => i.exchangeTime),
    ].filter((t): t is Date => t !== null);
    const previousDay = timed.filter((t) => istDate(t) < ctx.tradingDate).length;
    if (timed.length > 0 && previousDay * 2 > timed.length) {
      return {
        status: 'rejected',
        reason: 'MARKET_CLOSED_UNSCHEDULED',
        detail: `${previousDay} of ${timed.length} quotes carry a previous day's exchange time`,
      };
    }
  }
  const index = indices.find((i) => i.name === ctx.requiredIndex);
  if (!index || !index.valid) {
    return {
      status: 'rejected',
      reason: 'DATA_DEGRADED',
      detail: `index quote invalid: ${index?.invalidReason ?? 'missing'}`,
    };
  }
  const bad = quotes.filter((q) => !q.valid);
  if (bad.length > rules.maxInvalidQuotesPerSnapshot) {
    // Count by reason (no prices), so a skipped round can be diagnosed from the run summary.
    const byReason = new Map<string, number>();
    for (const q of bad) {
      const r = q.invalidReason ?? 'unknown';
      byReason.set(r, (byReason.get(r) ?? 0) + 1);
    }
    const reasons = [...byReason]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([r, n]) => `${r} ${n}`)
      .join(', ');
    return {
      status: 'rejected',
      reason: 'DATA_DEGRADED',
      detail: `${bad.length} of ${quotes.length} quotes invalid (${reasons})`,
    };
  }
  return { status: 'ok' };
}
