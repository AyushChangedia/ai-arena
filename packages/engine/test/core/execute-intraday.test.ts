/**
 * Intraday long-short execution (SPEC §3, §11.1, §11.6; the owner's choice, 2026-10-26).
 * Positions are signed: a negative quantity is a short whose average cost is its average sale price.
 */
import { describe, it, expect } from 'vitest';
import { executeActions, type ExecutionContext } from '../../src/core/execute';
import { markPortfolio, type PortfolioState } from '../../src/core/portfolio';
import { computeCharges } from '../../src/core/fees';
import { closingActions } from '../../src/round/runner';
import { must, loadFees } from '../../src/config/load';

const fees = must(loadFees());
const PX = 100_000n; // ₹1,000 a share for every symbol
const BID = PX - 50n;
const ASK = PX + 50n;
const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
const quotes = new Map(
  SYMBOLS.map((s) => [s, { ltpPaise: PX, bidPaise: BID, askPaise: ASK, depthAvailable: true }]),
);

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    universe: new Set(SYMBOLS),
    fillQuotes: quotes,
    valuationPrice: (s) => (SYMBOLS.includes(s) || s === 'OLD' ? PX : null),
    suspended: new Set(),
    soldToday: new Set(),
    maxActions: 5,
    maxWeightPct: 25,
    slippageBps: 5,
    fees,
    allowShort: true,
    maxGrossExposurePct: 100,
    ...over,
  };
}
const book = (c: bigint, pos: [string, number, bigint][] = []): PortfolioState => ({
  cashPaise: c,
  positions: new Map(pos.map(([s, q, a]) => [s, { quantity: q, avgCostPaise: a }])),
});
const START = book(10_000_000n);
const sellCharges = (gross: bigint) =>
  computeCharges(fees, 'SELL', gross, { dpApplies: true }).total;
const buyCharges = (gross: bigint) =>
  computeCharges(fees, 'BUY', gross, { dpApplies: false }).total;

describe('intraday: opening and closing shorts', () => {
  it('a SELL with nothing held opens a short at the best bid', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'AAA', quantity: 10, why: 'weak open', exit_plan: 'cover at 990' }],
      START,
      ctx(),
    );
    const o = r.outcomes[0]!;
    expect(o.status).toBe('executed');
    expect(o.exitPlan).toBe('cover at 990');
    const gross = BID * 10n;
    expect(o.fill).toMatchObject({
      pricePaise: BID,
      priceSource: 'bid',
      grossPaise: gross,
      positionAfter: -10,
      avgCostAfterPaise: BID,
      realizedPnlPaise: null,
      cashDeltaPaise: gross - sellCharges(gross),
    });
    expect(r.state.positions.get('AAA')).toEqual({ quantity: -10, avgCostPaise: BID });
    // Total value = cash + positions (a short counts negative): only the costs and the spread are lost.
    const m = markPortfolio(r.state, () => PX);
    expect(m.holdingsValuePaise).toBe(-PX * 10n);
    expect(m.totalPaise).toBe(10_000_000n + gross - sellCharges(gross) - PX * 10n);
  });

  it('adding to a short averages the sale prices', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'AAA', quantity: 10 }],
      book(10_000_000n, [['AAA', -10, 101_000n]]),
      ctx(),
    );
    // (10 × 1010.00 + 10 × 999.50) / 20 = 1004.75
    expect(r.state.positions.get('AAA')).toEqual({ quantity: -20, avgCostPaise: 100_475n });
  });

  it('a BUY covers a short at the best ask and books (sale price − buy price) × qty − charges', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'AAA', quantity: 10 }],
      book(10_000_000n, [['AAA', -10, 102_000n]]),
      ctx(),
    );
    const f = r.outcomes[0]!.fill!;
    const gross = ASK * 10n;
    expect(f.pricePaise).toBe(ASK);
    expect(f.positionAfter).toBe(0);
    expect(f.avgCostAfterPaise).toBeNull();
    expect(f.realizedPnlPaise).toBe((102_000n - ASK) * 10n - buyCharges(gross));
    expect(r.state.positions.has('AAA')).toBe(false);
  });

  it('a partial cover keeps the average sale price', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'AAA', quantity: 4 }],
      book(10_000_000n, [['AAA', -10, 102_000n]]),
      ctx(),
    );
    expect(r.state.positions.get('AAA')).toEqual({ quantity: -6, avgCostPaise: 102_000n });
  });

  it('a SELL larger than a long closes it and opens a short with the rest (net position)', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'AAA', quantity: 15 }],
      book(5_000_000n, [['AAA', 10, 98_000n]]),
      ctx(),
    );
    const f = r.outcomes[0]!.fill!;
    const gross = BID * 15n;
    expect(f.positionAfter).toBe(-5);
    expect(f.avgCostAfterPaise).toBe(BID);
    // Realised on the 10 long shares that closed, less the whole order's charges.
    expect(f.realizedPnlPaise).toBe((BID - 98_000n) * 10n - sellCharges(gross));
  });

  it('a BUY larger than a short covers it and opens a long with the rest', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'AAA', quantity: 8 }],
      book(10_000_000n, [['AAA', -5, 101_000n]]),
      ctx(),
    );
    const f = r.outcomes[0]!.fill!;
    expect(f.positionAfter).toBe(3);
    expect(f.avgCostAfterPaise).toBe(ASK);
    expect(f.realizedPnlPaise).toBe((101_000n - ASK) * 5n - buyCharges(ASK * 8n));
  });
});

describe('intraday: limits', () => {
  it('a short may not take the stock above 25% of total value', () => {
    const r = executeActions([{ side: 'SELL', symbol: 'AAA', quantity: 26 }], START, ctx());
    expect(r.outcomes[0]!.rejectCode).toBe('CONCENTRATION_LIMIT');
    expect(r.outcomes[0]!.rejectDetail).toMatch(
      /^Shorting 26 AAA would make it 2[56]\.\d% of the portfolio; the limit is 25%$/,
    );
    expect(r.outcomes[0]!.modelFault).toBe(true);
    expect(
      executeActions([{ side: 'SELL', symbol: 'AAA', quantity: 24 }], START, ctx()).outcomes[0]!
        .status,
    ).toBe('executed');
  });

  it('longs plus shorts may not exceed 100% of total value (no leverage)', () => {
    // 80% long across four stocks and 20% cash.
    const start = book(2_000_000n, [
      ['AAA', 20, PX],
      ['BBB', 20, PX],
      ['CCC', 20, PX],
      ['DDD', 20, PX],
    ]);
    const over = executeActions([{ side: 'SELL', symbol: 'EEE', quantity: 21 }], start, ctx());
    expect(over.outcomes[0]!.rejectCode).toBe('EXPOSURE_LIMIT');
    expect(over.outcomes[0]!.rejectDetail).toMatch(
      /^Shorting 21 EEE would take longs plus shorts to 10[01]\.\d% of the portfolio; the limit is 100%$/,
    );
    expect(over.outcomes[0]!.modelFault).toBe(true);
    const under = executeActions([{ side: 'SELL', symbol: 'EEE', quantity: 19 }], start, ctx());
    expect(under.outcomes[0]!.status).toBe('executed');
    // A BUY can't use short-sale cash to lever up either.
    const levered = executeActions(
      [{ side: 'BUY', symbol: 'AAA', quantity: 4 }],
      book(4_000_000n, [
        ['BBB', 20, PX],
        ['CCC', 20, PX],
        ['DDD', 20, PX],
        ['EEE', -20, PX],
      ]),
      ctx(),
    );
    expect(levered.outcomes[0]!.rejectCode).toBe('EXPOSURE_LIMIT');
  });

  it('closing trades are never blocked by the limits, but a cover needs cash', () => {
    const start = book(500_000n, [['AAA', -25, PX]]);
    const r = executeActions([{ side: 'BUY', symbol: 'AAA', quantity: 25 }], start, ctx());
    expect(r.outcomes[0]!.rejectCode).toBe('INSUFFICIENT_CASH');
    const ok = executeActions(
      [{ side: 'BUY', symbol: 'AAA', quantity: 25 }],
      book(5_000_000n, [['AAA', -25, PX]]),
      ctx({ maxWeightPct: 1, maxGrossExposurePct: 1 }),
    );
    expect(ok.outcomes[0]!.status).toBe('executed');
  });

  it('a stock outside the index can be bought back but not shorted', () => {
    const start = book(10_000_000n, [['OLD', -5, PX]]);
    const q = new Map([...quotes, ['OLD', quotes.get('AAA')!]]);
    expect(
      executeActions([{ side: 'SELL', symbol: 'ZZZ', quantity: 1 }], START, ctx()).outcomes[0]!
        .rejectCode,
    ).toBe('UNKNOWN_SYMBOL');
    const more = executeActions(
      [{ side: 'SELL', symbol: 'OLD', quantity: 1 }],
      start,
      ctx({ fillQuotes: q }),
    );
    expect(more.outcomes[0]!.rejectCode).toBe('NOT_IN_UNIVERSE_FOR_BUY');
    expect(more.outcomes[0]!.rejectDetail).toBe(
      'OLD has left the Nifty 50: it can be bought back but not shorted',
    );
    const cover = executeActions(
      [{ side: 'BUY', symbol: 'OLD', quantity: 5 }],
      start,
      ctx({ fillQuotes: q }),
    );
    expect(cover.outcomes[0]!.status).toBe('executed');
  });

  it('without allowShort, a SELL of nothing held is still UNKNOWN_SYMBOL (long-only rules)', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'AAA', quantity: 1 }],
      START,
      ctx({ allowShort: false }),
    );
    expect(r.outcomes[0]!.rejectCode).toBe('UNKNOWN_SYMBOL');
  });
});

describe('intraday: square-off orders', () => {
  it('closing orders sell longs and buy back shorts, in symbol order', () => {
    const p = book(1_000_000n, [
      ['CCC', 5, PX],
      ['AAA', -7, PX],
    ]);
    expect(closingActions(p, 'Square-off.')).toEqual([
      { side: 'BUY', symbol: 'AAA', quantity: 7, why: 'Square-off.' },
      { side: 'SELL', symbol: 'CCC', quantity: 5, why: 'Square-off.' },
    ]);
  });

  it('a forced square-off closes everything at bid and ask with normal charges', () => {
    const p = book(3_000_000n, [
      ['AAA', -20, 101_000n],
      ['BBB', 30, 99_000n],
    ]);
    const r = executeActions(
      closingActions(p, 'Square-off.'),
      p,
      ctx({ forced: true, maxActions: 2 }),
    );
    expect(r.outcomes.map((o) => [o.side, o.symbol, o.status])).toEqual([
      ['SELL', 'BBB', 'executed'],
      ['BUY', 'AAA', 'executed'],
    ]);
    expect(r.state.positions.size).toBe(0);
    const sell = BID * 30n;
    const buy = ASK * 20n;
    expect(r.state.cashPaise).toBe(3_000_000n + sell - sellCharges(sell) - buy - buyCharges(buy));
  });
});
