import { describe, it, expect } from 'vitest';
import {
  chainDrafts,
  seasonStartDraft,
  tradeDraft,
  adjustDraft,
  rebuildFromLedger,
  chargesJson,
  EMPTY_HEAD,
} from '../../src/core/ledger';
import {
  totalReturn,
  todayReturn,
  maxDrawdown,
  tradeStats,
  cleanAnswers,
  uptime,
  acceptedActions,
  dailyReturns,
  sharpe,
} from '../../src/core/metrics';
import { indexBenchmarkValue } from '../../src/core/benchmarks';
import { mulberry32, monkeySeed, monkeyDecide } from '../../src/core/monkey';
import { applyCorporateAction } from '../../src/core/corporate';
import { markPortfolio, holdingsValue, heldQty, clonePortfolio } from '../../src/core/portfolio';
import { verifyChain, GENESIS_HASH } from '@arena/shared/ledger-hash';
import { createHash } from 'node:crypto';

const t = new Date('2026-11-02T04:00:00Z');
const b = (id: string) => ({
  id,
  seasonId: 'S1',
  participantId: 'P',
  roundId: 'r1',
  occurredAt: t,
  revealAt: t,
});
const charges = {
  brokerage: 0n,
  stt: 1n,
  exchange: 0n,
  sebi: 0n,
  ipft: 0n,
  stamp: 0n,
  gst: 0n,
  dp: 0n,
};

describe('ledger chain', () => {
  it('chains drafts from genesis and continues from a head', async () => {
    const { entries, head } = await chainDrafts(EMPTY_HEAD, [seasonStartDraft(b('a'), 1000n)]);
    expect(entries[0]).toMatchObject({
      seq: 1n,
      prev_hash: GENESIS_HASH,
      entry_type: 'SEASON_START',
      cash_after_paise: 1000n,
    });
    const more = await chainDrafts(head, [
      tradeDraft(b('b'), {
        actionId: 'x',
        side: 'BUY',
        symbol: 'TCS',
        quantity: 2,
        pricePaise: 400n,
        priceSource: 'ask',
        snapshotId: 's',
        grossPaise: 800n,
        charges,
        chargesTotalPaise: 1n,
        cashDeltaPaise: -801n,
        cashAfterPaise: 199n,
        positionAfter: 2,
        avgCostAfterPaise: 400n,
        realizedPnlPaise: null,
      }),
    ]);
    expect(more.entries[0]).toMatchObject({ seq: 2n, prev_hash: head.hash });
    expect((await verifyChain([...entries, ...more.entries])).ok).toBe(true);
    expect(chargesJson(null)).toEqual({});
  });
  it('rebuilds state and detects inconsistent entries', async () => {
    const drafts = [
      seasonStartDraft(b('a'), 1000n),
      tradeDraft(b('b'), {
        actionId: 'x',
        side: 'BUY',
        symbol: 'TCS',
        quantity: 2,
        pricePaise: 400n,
        priceSource: 'ask',
        snapshotId: 's',
        grossPaise: 800n,
        charges,
        chargesTotalPaise: 1n,
        cashDeltaPaise: -801n,
        cashAfterPaise: 199n,
        positionAfter: 2,
        avgCostAfterPaise: 400n,
        realizedPnlPaise: null,
      }),
      adjustDraft(b('c'), {
        type: 'SPLIT_ADJUST',
        symbol: 'TCS',
        quantityDelta: 2,
        grossPaise: 0n,
        cashDeltaPaise: 0n,
        cashAfterPaise: 199n,
        positionAfter: 4,
        avgCostAfterPaise: 200n,
        note: '2:1 split',
        refSeq: null,
      }),
      tradeDraft(b('d'), {
        actionId: 'y',
        side: 'SELL',
        symbol: 'TCS',
        quantity: 4,
        pricePaise: 210n,
        priceSource: 'bid',
        snapshotId: 's',
        grossPaise: 840n,
        charges,
        chargesTotalPaise: 1n,
        cashDeltaPaise: 839n,
        cashAfterPaise: 1038n,
        positionAfter: 0,
        avgCostAfterPaise: null,
        realizedPnlPaise: 39n,
      }),
      adjustDraft(b('e'), {
        type: 'RETIRE',
        symbol: null,
        quantityDelta: null,
        grossPaise: 0n,
        cashDeltaPaise: 0n,
        cashAfterPaise: 1038n,
        positionAfter: null,
        avgCostAfterPaise: null,
        note: 'Retired',
      }),
    ];
    const { entries } = await chainDrafts(EMPTY_HEAD, drafts);
    const p = rebuildFromLedger(entries).get('P')!;
    expect(p.cashPaise).toBe(1038n);
    expect(p.positions.size).toBe(0);
    const badCash = entries.map((e, i) => (i === 1 ? { ...e, cash_after_paise: 200n } : e));
    expect(() => rebuildFromLedger(badCash)).toThrow(/cash_after/);
    const badPos = entries.map((e, i) => (i === 1 ? { ...e, position_after: 3 } : e));
    expect(() => rebuildFromLedger(badPos)).toThrow(/position_after/);
  });
});

describe('metrics (SPEC §11.8)', () => {
  it('returns, today, drawdown', () => {
    expect(totalReturn(10_421_200n, 10_000_000n)).toBeCloseTo(0.04212);
    const marks = [
      { at: t, totalPaise: 100n, kind: 'eod' as const, tradingDate: '2026-11-02' },
      { at: t, totalPaise: 110n, kind: 'round' as const, tradingDate: '2026-11-03' },
    ];
    expect(todayReturn(marks, '2026-11-03')).toBeCloseTo(0.1);
    expect(todayReturn(marks, '2026-11-02')).toBeNull();
    expect(todayReturn([], '2026-11-02')).toBeNull();
    expect(maxDrawdown([100n, 120n, 90n, 130n, 117n])).toBeCloseTo(-0.25);
    expect(maxDrawdown([100n, 110n])).toBe(0);
    expect(maxDrawdown([0n, 0n])).toBe(0);
  });
  it('trade stats and win rate after 5 closing fills', () => {
    const sells = (pnls: bigint[]) =>
      pnls.map((p) => ({
        side: 'SELL' as const,
        grossPaise: 100n,
        chargesTotalPaise: 1n,
        realizedPnlPaise: p,
      }));
    expect(
      tradeStats([
        { side: 'BUY', grossPaise: 500n, chargesTotalPaise: 2n, realizedPnlPaise: null },
        ...sells([1n, -1n, 1n, 0n]),
      ]),
    ).toMatchObject({ trades: 5, turnoverPaise: 900n, chargesPaise: 6n, winRate: null });
    expect(tradeStats(sells([1n, -1n, 1n, 0n, 5n])).winRate).toBeCloseTo(0.6);
    // Intraday: a BUY that covers a short is a closing fill too.
    const cover = { side: 'BUY' as const, grossPaise: 100n, chargesTotalPaise: 1n };
    expect(
      tradeStats([
        ...sells([1n, -1n, 1n, 0n]),
        { ...cover, realizedPnlPaise: 7n },
        { ...cover, realizedPnlPaise: null },
      ]),
    ).toMatchObject({ closes: 5, winRate: 0.6 });
  });
  it('rates', () => {
    const c = { ok: 8, invalid: 2, roundsHeld: 12, executed: 9, modelFaultRejections: 3 };
    expect(cleanAnswers(c)).toBeCloseTo(0.8);
    expect(uptime(c)).toBeCloseTo(10 / 12);
    expect(acceptedActions(c)).toBeCloseTo(0.75);
    const z = { ok: 0, invalid: 0, roundsHeld: 0, executed: 0, modelFaultRejections: 0 };
    expect([cleanAnswers(z), uptime(z), acceptedActions(z)]).toEqual([null, null, null]);
  });
  it('Sharpe only after 10 days', () => {
    expect(dailyReturns(100n, [110n, 99n])).toEqual([0.1, -0.1]);
    expect(sharpe([0.01, 0.02])).toBeNull();
    const r = [0.01, -0.005, 0.02, 0.0, 0.01, -0.01, 0.015, 0.005, 0.0, 0.01];
    expect(sharpe(r)).toBeGreaterThan(0);
    expect(sharpe(Array(10).fill(0.01))).toBeNull();
  });
});

describe('benchmarks', () => {
  it('Nifty benchmark = start × now ÷ start index', () => {
    expect(indexBenchmarkValue(10_000_000n, 2_400_000n, 2_424_000n)).toBe(10_100_000n);
    expect(() => indexBenchmarkValue(1n, 0n, 1n)).toThrow();
  });
});

describe('the Monkey (SPEC §11.9)', () => {
  it('mulberry32 is deterministic', () => {
    const a = mulberry32(42);
    const b2 = mulberry32(42);
    const xs = [a(), a(), a()];
    expect([b2(), b2(), b2()]).toEqual(xs);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
  });
  it('seeds from the first 32 bits of sha256(round_id + ":monkey")', async () => {
    const h = createHash('sha256').update('round-1:monkey').digest('hex');
    expect(await monkeySeed('round-1')).toEqual({
      seedHex: h.slice(0, 8),
      seed: parseInt(h.slice(0, 8), 16),
    });
  });
  it('replays the same decision for the same round, and varies across rounds', async () => {
    const input = (roundId: string) => ({
      roundId,
      portfolio: {
        cashPaise: 10_000_000n,
        positions: new Map([['TCS', { quantity: 5, avgCostPaise: 300_000n }]]),
      },
      tradeable: new Map([
        ['INFY', 150_000n],
        ['ITC', 45_000n],
        ['TCS', 341_250n],
      ]),
      ltp: (s: string) => (s === 'TCS' ? 341_250n : null),
    });
    expect(await monkeyDecide(input('r-1'))).toEqual(await monkeyDecide(input('r-1')));
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const d = await monkeyDecide(input(`r-${i}`));
      kinds.add(d.actions[0]?.side ?? 'none');
      for (const a of d.actions) {
        expect(a.quantity).toBeGreaterThanOrEqual(1);
        if (a.side === 'SELL') expect(a.quantity).toBeLessThanOrEqual(5);
        if (a.side === 'BUY') {
          const value = BigInt(a.quantity) * input('x').tradeable.get(a.symbol)!;
          expect(value).toBeLessThanOrEqual((11_706_250n * 2000n) / 10_000n);
        }
      }
    }
    expect(kinds).toEqual(new Set(['none', 'BUY', 'SELL']));
  });
  it('does nothing when nothing is tradeable or a share is too expensive', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        monkeyDecide({
          roundId: `q${i}`,
          portfolio: { cashPaise: 100n, positions: new Map() },
          tradeable: new Map([['MRF', 10_000_000n]]),
          ltp: () => null,
        }),
      ),
    );
    expect(results.every((r) => r.actions.length === 0)).toBe(true);
    const empty = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        monkeyDecide({
          roundId: `e${i}`,
          portfolio: { cashPaise: 100n, positions: new Map() },
          tradeable: new Map(),
          ltp: () => null,
        }),
      ),
    );
    expect(empty.some((r) => /Nothing tradeable/.test(r.reasoning))).toBe(true);
  });
});

describe('corporate actions (SPEC §8.7)', () => {
  const pos = { quantity: 10, avgCostPaise: 100_000n };
  it('split 2:1 doubles shares and halves cost', () => {
    expect(
      applyCorporateAction(pos, {
        type: 'split',
        ratioNum: 2,
        ratioDen: 1,
        amountPaisePerShare: null,
      }),
    ).toEqual({
      quantityDelta: 10,
      quantityAfter: 20,
      avgCostAfterPaise: 50_000n,
      cashDeltaPaise: 0n,
    });
  });
  it('bonus 1:2 adds one share per two held', () => {
    expect(
      applyCorporateAction(pos, {
        type: 'bonus',
        ratioNum: 1,
        ratioDen: 2,
        amountPaisePerShare: null,
      }),
    ).toEqual({
      quantityDelta: 5,
      quantityAfter: 15,
      avgCostAfterPaise: 66_667n,
      cashDeltaPaise: 0n,
    });
  });
  it('dividend credits cash', () => {
    expect(
      applyCorporateAction(pos, {
        type: 'dividend',
        ratioNum: null,
        ratioDen: null,
        amountPaisePerShare: 1_150n,
      }).cashDeltaPaise,
    ).toBe(11_500n);
  });
  it('rejects bad inputs and handles reverse splits that round to zero', () => {
    expect(() =>
      applyCorporateAction(pos, {
        type: 'dividend',
        ratioNum: null,
        ratioDen: null,
        amountPaisePerShare: null,
      }),
    ).toThrow();
    expect(() =>
      applyCorporateAction(pos, {
        type: 'split',
        ratioNum: 0,
        ratioDen: 1,
        amountPaisePerShare: null,
      }),
    ).toThrow();
    expect(
      applyCorporateAction(
        { quantity: 1, avgCostPaise: 5n },
        { type: 'split', ratioNum: 1, ratioDen: 10, amountPaisePerShare: null },
      ),
    ).toMatchObject({ quantityAfter: 0, avgCostAfterPaise: null });
  });
});

describe('portfolio helpers', () => {
  it('marks, clones and refuses to value a holding with no price', () => {
    const p = {
      cashPaise: 100n,
      positions: new Map([
        ['A', { quantity: 2, avgCostPaise: 1n }],
        ['Z', { quantity: 0, avgCostPaise: 1n }],
      ]),
    };
    expect(markPortfolio(p, () => 10n)).toEqual({
      cashPaise: 100n,
      holdingsValuePaise: 20n,
      totalPaise: 120n,
    });
    expect(() => holdingsValue(p, () => null)).toThrow(/no valuation price/);
    expect(heldQty(p, 'B')).toBe(0);
    const c = clonePortfolio(p);
    c.positions.get('A')!.quantity = 9;
    expect(p.positions.get('A')!.quantity).toBe(2);
  });
});
