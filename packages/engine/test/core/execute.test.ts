import { describe, it, expect } from 'vitest';
import { executeActions, normaliseSymbol, type ExecutionContext } from '../../src/core/execute';
import type { PortfolioState } from '../../src/core/portfolio';
import type { QuoteForFill } from '../../src/core/prices';
import { join } from 'node:path';
import { must, loadFees } from '../../src/config/load';

// Long-only delivery rules (no allowShort), as S0 ran; intraday long-short is in execute-intraday.test.ts.
const fees = must(loadFees(join(__dirname, '../fixtures/delivery')));
const px: Record<string, bigint> = {
  TCS: 341_250n,
  INFY: 150_000n,
  ITC: 45_000n,
  LT: 360_000n,
  OLD: 10_000n,
};
const quotes = new Map(
  Object.entries(px)
    .filter(([s]) => s !== 'OLD')
    .map(([s, p]) => [
      s,
      { ltpPaise: p, bidPaise: p - 50n, askPaise: p + 50n, depthAvailable: true },
    ]),
);

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    universe: new Set(['TCS', 'INFY', 'ITC', 'LT', 'HDFCBANK']),
    fillQuotes: quotes,
    valuationPrice: (s) => px[s] ?? null,
    suspended: new Set(),
    soldToday: new Set(),
    maxActions: 5,
    maxWeightPct: 25,
    slippageBps: 5,
    fees,
    ...over,
  };
}
const cash = (c: bigint, pos: [string, number, bigint][] = []): PortfolioState => ({
  cashPaise: c,
  positions: new Map(pos.map(([s, q, a]) => [s, { quantity: q, avgCostPaise: a }])),
});
const START = cash(10_000_000n);

describe('symbol normalisation (SPEC §11.2)', () => {
  it.each([
    [' tcs ', 'TCS'],
    ['NSE:INFY', 'INFY'],
    ['nse:itc.ns', 'ITC'],
    ['LT-EQ', 'LT'],
    ['M&M', 'M&M'],
    ['BAJAJ-AUTO', 'BAJAJ-AUTO'],
    ['Tata Consultancy', 'TATA CONSULTANCY'],
  ])('%s → %s', (raw, out) => expect(normaliseSymbol(raw)).toBe(out));
});

describe('executeActions: valid trades', () => {
  it('buys at the ask with charges, updating cash, position and average cost', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'TCS', quantity: 2, why: 'IT held up' }],
      START,
      ctx(),
    );
    const o = r.outcomes[0]!;
    expect(o.status).toBe('executed');
    expect(o.fill).toMatchObject({
      pricePaise: 341_300n,
      priceSource: 'ask',
      grossPaise: 682_600n,
      positionAfter: 2,
      avgCostAfterPaise: 341_300n,
      realizedPnlPaise: null,
    });
    expect(o.fill!.cashAfterPaise).toBe(10_000_000n - 682_600n - o.fill!.chargesTotalPaise);
    expect(r.state.positions.get('TCS')).toEqual({ quantity: 2, avgCostPaise: 341_300n });
    expect(o.why).toBe('IT held up');
  });
  it('averages cost across buys, excluding charges', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'TCS', quantity: 1 }],
      cash(5_000_000n, [['TCS', 1, 300_000n]]),
      ctx(),
    );
    expect(r.state.positions.get('TCS')!.avgCostPaise).toBe(320_650n); // (300000 + 341300) / 2
  });
  it('runs sells before buys so sale cash can fund buys, and computes realised P&L', () => {
    const start = cash(100_000n, [['INFY', 10, 140_000n]]);
    const r = executeActions(
      [
        { side: 'BUY', symbol: 'ITC', quantity: 5, why: 'b' },
        { side: 'SELL', symbol: 'INFY', quantity: 10, why: 's' },
      ],
      start,
      ctx(),
    );
    expect(r.outcomes.map((o) => [o.side, o.status])).toEqual([
      ['SELL', 'executed'],
      ['BUY', 'executed'],
    ]);
    const sell = r.outcomes[0]!.fill!;
    expect(sell.pricePaise).toBe(149_950n);
    expect(sell.charges.dp).toBe(1593n);
    expect(sell.realizedPnlPaise).toBe((149_950n - 140_000n) * 10n - sell.chargesTotalPaise);
    expect(sell.positionAfter).toBe(0);
    expect(sell.avgCostAfterPaise).toBeNull();
    expect(r.state.positions.has('INFY')).toBe(false);
    expect(r.soldToday.has('INFY')).toBe(true);
  });
  it('charges DP only on the first sell of a symbol that day', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'INFY', quantity: 1 }],
      cash(0n, [['INFY', 5, 1n]]),
      ctx({ soldToday: new Set(['INFY']) }),
    );
    expect(r.outcomes[0]!.fill!.charges.dp).toBe(0n);
  });
  it('keeps average cost on a partial sell', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'INFY', quantity: 4 }],
      cash(0n, [['INFY', 10, 140_000n]]),
      ctx(),
    );
    expect(r.state.positions.get('INFY')).toEqual({ quantity: 6, avgCostPaise: 140_000n });
    expect(r.outcomes[0]!.fill!.avgCostAfterPaise).toBe(140_000n);
  });
  it('lets a held stock that left the index be sold, and uses LTP slippage without depth', () => {
    const q = new Map<string, QuoteForFill>(quotes);
    q.set('OLD', { ltpPaise: 10_000n, bidPaise: null, askPaise: null, depthAvailable: false });
    const r = executeActions(
      [{ side: 'SELL', symbol: 'OLD', quantity: 3 }],
      cash(0n, [['OLD', 3, 9_000n]]),
      ctx({ fillQuotes: q }),
    );
    expect(r.outcomes[0]!.fill).toMatchObject({ pricePaise: 9_995n, priceSource: 'ltp_slippage' });
  });
  it('does nothing for an empty list', () => {
    const r = executeActions([], START, ctx());
    expect(r.outcomes).toEqual([]);
    expect(r.state.cashPaise).toBe(10_000_000n);
  });
});

describe('executeActions: every rejection code (SPEC §11.3)', () => {
  const code = (actions: unknown[], start = START, c = ctx()) =>
    executeActions(actions, start, c).outcomes.map((o) => o.rejectCode);
  it('MALFORMED_ACTION', () => {
    expect(
      code([
        'buy TCS',
        null,
        [1],
        { side: 'BUY', symbol: 'TCS' },
        { side: 'BUY', symbol: 5, quantity: 1 },
      ]),
    ).toEqual(Array(5).fill('MALFORMED_ACTION'));
    expect(code([{ side: 'BUY', symbol: '  ', quantity: 1 }])).toEqual(['MALFORMED_ACTION']);
  });
  it('INVALID_SIDE', () => {
    expect(
      code([
        { side: 'buy', symbol: 'TCS', quantity: 1 },
        { side: 'HOLD', symbol: 'TCS', quantity: 1 },
        { side: 1, symbol: 'TCS', quantity: 1 },
      ]),
    ).toEqual(Array(3).fill('INVALID_SIDE'));
  });
  it('INVALID_QUANTITY: strings, fractions, zero, negatives and absurd sizes are not converted', () => {
    const qs = ['10', 10.5, 0, -1, null];
    expect(code(qs.map((quantity) => ({ side: 'BUY', symbol: 'TCS', quantity })))).toEqual(
      Array(5).fill('INVALID_QUANTITY'),
    );
    expect(code([{ side: 'BUY', symbol: 'TCS', quantity: 3e9 }])).toEqual(['INVALID_QUANTITY']);
  });
  it('UNKNOWN_SYMBOL for a BUY outside the universe and a SELL of something not held', () => {
    const r = executeActions(
      [
        { side: 'BUY', symbol: 'TATAMOTORZ', quantity: 1 },
        { side: 'SELL', symbol: 'HDFCBANK', quantity: 40 },
      ],
      START,
      ctx(),
    );
    expect(r.outcomes.map((o) => o.rejectCode)).toEqual(['UNKNOWN_SYMBOL', 'UNKNOWN_SYMBOL']);
    expect(r.outcomes[0]!.rejectDetail).toBe('Tried to sell 40 HDFCBANK, held 0');
  });
  it('NOT_IN_UNIVERSE_FOR_BUY for a held stock that left the index', () => {
    expect(
      code([{ side: 'BUY', symbol: 'OLD', quantity: 1 }], cash(1_000_000n, [['OLD', 1, 1n]])),
    ).toEqual(['NOT_IN_UNIVERSE_FOR_BUY']);
  });
  it('DUPLICATE_ACTION for the same side and symbol twice', () => {
    expect(
      code([
        { side: 'BUY', symbol: 'ITC', quantity: 1 },
        { side: 'BUY', symbol: 'itc', quantity: 2 },
      ]),
    ).toEqual([null, 'DUPLICATE_ACTION']);
  });
  it('CONFLICTING_SIDES for a buy of a symbol also sold', () => {
    expect(
      code(
        [
          { side: 'BUY', symbol: 'INFY', quantity: 1 },
          { side: 'SELL', symbol: 'INFY', quantity: 1 },
        ],
        cash(1_000_000n, [['INFY', 2, 1n]]),
      ),
    ).toEqual([null, 'CONFLICTING_SIDES']);
  });
  it('TOO_MANY_ACTIONS beyond the 5th in the original order, even if the extra one is a SELL', () => {
    const buys = Array.from({ length: 5 }, () => ({ side: 'BUY', symbol: 'ITC', quantity: 1 }));
    const r = executeActions(
      [...buys, { side: 'SELL', symbol: 'INFY', quantity: 1 }],
      cash(1_000_000n, [['INFY', 1, 1n]]),
      ctx(),
    );
    const last = r.outcomes.find((o) => o.position === 5)!;
    expect(last.rejectCode).toBe('TOO_MANY_ACTIONS');
    expect(r.state.positions.get('INFY')!.quantity).toBe(1);
  });
  it('INSUFFICIENT_HOLDINGS for a stock that left the index, not NOT_IN_UNIVERSE_FOR_BUY', () => {
    const q = new Map([
      ...quotes,
      ['OLD', { ltpPaise: 10_000n, bidPaise: 9_950n, askPaise: 10_050n, depthAvailable: true }],
    ]);
    const r = executeActions(
      [{ side: 'SELL', symbol: 'OLD', quantity: 10 }],
      cash(1_000_000n, [['OLD', 5, 10_000n]]),
      ctx({ fillQuotes: q }),
    );
    expect(r.outcomes[0]!.rejectCode).toBe('INSUFFICIENT_HOLDINGS');
  });
  it('INSUFFICIENT_HOLDINGS', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'INFY', quantity: 11 }],
      cash(0n, [['INFY', 10, 1n]]),
      ctx(),
    );
    expect(r.outcomes[0]!.rejectCode).toBe('INSUFFICIENT_HOLDINGS');
    expect(r.outcomes[0]!.rejectDetail).toBe('Tried to sell 11 INFY, held 10');
  });
  it('INSUFFICIENT_CASH counts charges', () => {
    // 2 ITC at ask 450.50 = 901.00; charges push it over 901.00 of cash.
    expect(code([{ side: 'BUY', symbol: 'ITC', quantity: 2 }], cash(90_100n))).toEqual([
      'INSUFFICIENT_CASH',
    ]);
  });
  it('CONCENTRATION_LIMIT: a BUY may not take a stock above 25%', () => {
    // 8 TCS ≈ 27.3% of ₹1L; 7 TCS ≈ 23.9%.
    expect(code([{ side: 'BUY', symbol: 'TCS', quantity: 8 }])).toEqual(['CONCENTRATION_LIMIT']);
    expect(code([{ side: 'BUY', symbol: 'TCS', quantity: 7 }])).toEqual([null]);
  });
  it('allows price drift above 25% (only BUYs are checked)', () => {
    const r = executeActions(
      [{ side: 'SELL', symbol: 'TCS', quantity: 1 }],
      cash(100_000n, [['TCS', 10, 300_000n]]),
      ctx(),
    );
    expect(r.outcomes[0]!.status).toBe('executed');
  });
  it('PRICE_UNAVAILABLE and SYMBOL_SUSPENDED are not the model’s fault', () => {
    const r = executeActions(
      [
        { side: 'BUY', symbol: 'HDFCBANK', quantity: 1 },
        { side: 'BUY', symbol: 'LT', quantity: 1 },
      ],
      START,
      ctx({ suspended: new Set(['LT']) }),
    );
    expect(r.outcomes.map((o) => [o.rejectCode, o.modelFault])).toEqual([
      ['PRICE_UNAVAILABLE', false],
      ['SYMBOL_SUSPENDED', false],
    ]);
  });
  it('one malformed action never invalidates the others', () => {
    const r = executeActions(
      [{ side: 'BUY', symbol: 'ITC', quantity: 1 }, 'garbage'],
      START,
      ctx(),
    );
    expect(r.outcomes.map((o) => o.status)).toEqual(['executed', 'rejected']);
    expect(r.outcomes[1]!.modelFault).toBe(true);
  });
  it('keeps raw values for display', () => {
    const r = executeActions([{ side: 'LONG', symbol: ['x'], quantity: '5' }], START, ctx());
    expect(r.outcomes[0]).toMatchObject({
      sideRaw: 'LONG',
      symbolRaw: '["x"]',
      quantityRaw: '5',
      rejectCode: 'MALFORMED_ACTION',
    });
  });
});
