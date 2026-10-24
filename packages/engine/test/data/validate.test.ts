import { describe, it, expect } from 'vitest';
import {
  validateQuote,
  validateIndexQuote,
  snapshotVerdict,
  istDate,
  type ValidationContext,
} from '../../src/data/validate';
import type { RawQuote, RawIndexQuote } from '../../src/data/provider';

const rules = { maxQuoteAgeMinutes: 5, maxDailyMovePct: 20, maxInvalidQuotesPerSnapshot: 5 };
const t = new Date('2026-11-02T05:00:00Z'); // 10:30 IST
const ctx: ValidationContext = {
  snapshotTime: t,
  checkFreshness: true,
  exDateToday: new Set(),
  requiredIndex: 'Nifty 50',
  tradingDate: '2026-11-02',
};

const q = (over: Partial<RawQuote> = {}): RawQuote => ({
  symbol: 'TCS',
  ltpPaise: 341250n,
  bidPaise: 341200n,
  askPaise: 341250n,
  openPaise: 340000n,
  highPaise: 342000n,
  lowPaise: 339000n,
  prevClosePaise: 340000n,
  volume: 1000n,
  exchangeTime: new Date(t.getTime() - 30_000),
  parseError: null,
  ...over,
});
const ix = (over: Partial<RawIndexQuote> = {}): RawIndexQuote => ({
  name: 'Nifty 50',
  valueX100: 2432145n,
  prevCloseX100: 2420000n,
  exchangeTime: new Date(t.getTime() - 10_000),
  parseError: null,
  ...over,
});

describe('quote validation (SPEC §8.4)', () => {
  it('accepts a good quote with depth', () => {
    const v = validateQuote(q(), rules, ctx);
    expect(v).toMatchObject({ valid: true, invalidReason: null, depthAvailable: true });
  });
  it.each([
    [{ parseError: 'schema: ltp Required' }, /schema/],
    [{ ltpPaise: null }, /ltp/],
    [{ ltpPaise: 0n }, /ltp/],
    [{ prevClosePaise: 0n }, /previous close/],
    [{ exchangeTime: null }, /exchange time/],
    [{ exchangeTime: new Date(t.getTime() - 6 * 60_000) }, /stale/],
    [{ ltpPaise: 410000n }, /moved more than 20%/],
    [{ ltpPaise: 270000n }, /moved more than 20%/],
  ] as [Partial<RawQuote>, RegExp][])('rejects %o', (over, re) => {
    const v = validateQuote(q(over), rules, ctx);
    expect(v.valid).toBe(false);
    expect(v.invalidReason).toMatch(re);
  });
  it('exempts symbols with an ex-date today from the daily-move rule, and skips freshness outside hours', () => {
    expect(
      validateQuote(q({ ltpPaise: 170000n }), rules, { ...ctx, exDateToday: new Set(['TCS']) })
        .valid,
    ).toBe(true);
    expect(
      validateQuote(q({ exchangeTime: new Date(0) }), rules, { ...ctx, checkFreshness: false })
        .valid,
    ).toBe(true);
    expect(validateQuote(q({ ltpPaise: 408000n }), rules, ctx).valid).toBe(true); // exactly 20%
  });
  it('keeps the quote valid without depth when bid/ask are missing, zero or crossed', () => {
    for (const over of [
      { bidPaise: null },
      { askPaise: 0n },
      { bidPaise: 341300n, askPaise: 341250n },
    ]) {
      const v = validateQuote(q(over), rules, ctx);
      expect(v).toMatchObject({
        valid: true,
        depthAvailable: false,
        bidPaise: null,
        askPaise: null,
      });
    }
  });
  it('validates index quotes', () => {
    expect(validateIndexQuote(ix(), rules, ctx).valid).toBe(true);
    expect(validateIndexQuote(ix({ parseError: 'x' }), rules, ctx).valid).toBe(false);
    expect(validateIndexQuote(ix({ valueX100: null }), rules, ctx).invalidReason).toMatch(/value/);
    expect(validateIndexQuote(ix({ prevCloseX100: 0n }), rules, ctx).invalidReason).toMatch(
      /previous/,
    );
    expect(validateIndexQuote(ix({ exchangeTime: null }), rules, ctx).invalidReason).toMatch(
      /time/,
    );
    expect(validateIndexQuote(ix({ exchangeTime: new Date(0) }), rules, ctx).invalidReason).toBe(
      'stale',
    );
  });
});

describe('snapshot verdict', () => {
  const good = Array.from({ length: 50 }, (_, i) =>
    validateQuote(q({ symbol: `S${i}` }), rules, ctx),
  );
  const idx = [validateIndexQuote(ix(), rules, ctx)];
  it('accepts up to 5 invalid symbols', () => {
    const some = good.map((x, i) => (i < 5 ? { ...x, valid: false } : x));
    expect(snapshotVerdict(some, idx, rules, ctx)).toEqual({ status: 'ok' });
  });
  it('rejects more than 5 invalid symbols, or an invalid index', () => {
    const many = good.map((x, i) => (i < 6 ? { ...x, valid: false } : x));
    expect(snapshotVerdict(many, idx, rules, ctx)).toMatchObject({
      status: 'rejected',
      reason: 'DATA_DEGRADED',
    });
    expect(
      snapshotVerdict(good, [{ ...idx[0]!, valid: false, invalidReason: 'stale' }], rules, ctx),
    ).toMatchObject({ reason: 'DATA_DEGRADED' });
    expect(snapshotVerdict(good, [], rules, ctx)).toMatchObject({
      reason: 'DATA_DEGRADED',
      detail: expect.stringMatching(/missing/),
    });
  });
  it('detects an unscheduled closure from previous-day exchange times', () => {
    const yesterday = new Date('2026-10-30T10:00:00Z');
    const stale = good.map((x) => ({ ...x, exchangeTime: yesterday }));
    expect(
      snapshotVerdict(stale, [{ ...idx[0]!, exchangeTime: yesterday }], rules, ctx),
    ).toMatchObject({ reason: 'MARKET_CLOSED_UNSCHEDULED' });
  });
  it('istDate uses IST', () => {
    expect(istDate(new Date('2026-11-01T19:00:00Z'))).toBe('2026-11-02');
  });
});
