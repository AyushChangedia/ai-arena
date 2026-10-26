import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { executeActions, type ExecutionContext } from '../../src/core/execute';
import { markPortfolio, type PortfolioState } from '../../src/core/portfolio';
import {
  chainDrafts,
  tradeDraft,
  seasonStartDraft,
  rebuildFromLedger,
  EMPTY_HEAD,
  type LedgerDraft,
} from '../../src/core/ledger';
import { CHARGE_KEYS } from '../../src/core/fees';
import { verifyChain } from '@arena/shared/ledger-hash';
import { join } from 'node:path';
import { must, loadFees } from '../../src/config/load';

/** Long-only delivery (S0's rules) and intraday long-short (the committed rules since 2026-10-26). */
const deliveryFees = must(loadFees(join(__dirname, '../fixtures/delivery')));
const intradayFees = must(loadFees());
type Mode = 'delivery' | 'intraday';
const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
const RUNS = { numRuns: 1000 };

const actionArb = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      side: fc.constantFrom('BUY', 'SELL'),
      symbol: fc.constantFrom(...SYMBOLS, 'ZZZ', 'aaa', 'NSE:BBB'),
      quantity: fc.integer({ min: 1, max: 400 }),
      why: fc.string({ maxLength: 10 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      side: fc.constantFrom('BUY', 'SELL', 'HOLD'),
      symbol: fc.constantFrom(...SYMBOLS),
      quantity: fc.oneof(fc.integer({ min: -5, max: 5 }), fc.double(), fc.constant('7')),
    }),
  },
  { weight: 1, arbitrary: fc.anything() },
);

const roundArb = fc.record({
  actions: fc.array(actionArb, { maxLength: 8 }),
  prices: fc.array(fc.integer({ min: 100, max: 500_000 }), {
    minLength: SYMBOLS.length,
    maxLength: SYMBOLS.length,
  }),
  depth: fc.array(fc.boolean(), { minLength: SYMBOLS.length, maxLength: SYMBOLS.length }),
  missing: fc.subarray(SYMBOLS, { maxLength: 2 }),
  newDay: fc.boolean(),
});

type Round = typeof roundArb extends fc.Arbitrary<infer T> ? T : never;

async function simulate(rounds: Round[], mode: Mode = 'delivery') {
  const intraday = mode === 'intraday';
  let state: PortfolioState = { cashPaise: 10_000_000n, positions: new Map() };
  const t = new Date('2026-11-02T04:00:00Z');
  const base = (i: number) => ({
    id: `id-${i}`,
    seasonId: 'S',
    participantId: 'P',
    roundId: null,
    occurredAt: t,
    revealAt: t,
  });
  const drafts: LedgerDraft[] = [seasonStartDraft(base(0), 10_000_000n)];
  let soldToday = new Set<string>();
  const violations: string[] = [];
  let n = 1;
  for (const r of rounds) {
    if (r.newDay) soldToday = new Set();
    const prices = new Map(SYMBOLS.map((s, i) => [s, BigInt(r.prices[i]!)]));
    const fillQuotes = new Map(
      SYMBOLS.filter((s) => !r.missing.includes(s)).map((s, i) => {
        const p = prices.get(s)!;
        return [
          s,
          {
            ltpPaise: p,
            bidPaise: r.depth[i] ? p - 5n : null,
            askPaise: r.depth[i] ? p + 5n : null,
            depthAvailable: r.depth[i]!,
          },
        ];
      }),
    );
    const ctx: ExecutionContext = {
      universe: new Set(SYMBOLS),
      fillQuotes,
      valuationPrice: (s) => prices.get(s) ?? null,
      suspended: new Set(),
      soldToday,
      maxActions: 5,
      maxWeightPct: 25,
      slippageBps: 5,
      fees: intraday ? intradayFees : deliveryFees,
      allowShort: intraday,
      maxGrossExposurePct: 100,
    };
    const res = executeActions(r.actions, state, ctx);
    for (const o of res.outcomes) {
      if (o.status !== 'executed') continue;
      const f = o.fill!;
      for (const k of CHARGE_KEYS) if (f.charges[k] < 0n) violations.push(`negative charge ${k}`);
      if (f.cashAfterPaise < 0n) violations.push('negative cash');
      if (!intraday && f.positionAfter < 0) violations.push('negative quantity');
      drafts.push(
        tradeDraft(base(n++), {
          actionId: `a${n}`,
          side: o.side!,
          symbol: o.symbol!,
          quantity: o.quantity!,
          pricePaise: f.pricePaise,
          priceSource: f.priceSource,
          snapshotId: 'snap',
          grossPaise: f.grossPaise,
          charges: f.charges,
          chargesTotalPaise: f.chargesTotalPaise,
          cashDeltaPaise: f.cashDeltaPaise,
          cashAfterPaise: f.cashAfterPaise,
          positionAfter: f.positionAfter,
          avgCostAfterPaise: f.avgCostAfterPaise,
          realizedPnlPaise: f.realizedPnlPaise,
        }),
      );
    }
    // Concentration: after the round's buys, each bought stock's weight was ≤ 25% at the moment it was bought.
    let running: PortfolioState = {
      cashPaise: state.cashPaise,
      positions: new Map([...state.positions].map(([k, v]) => [k, { ...v }])),
    };
    for (const o of res.outcomes) {
      if (o.status !== 'executed') continue;
      const before = running.positions.get(o.symbol!)?.quantity ?? 0;
      running = { cashPaise: o.fill!.cashAfterPaise, positions: running.positions };
      if (o.fill!.positionAfter === 0) running.positions.delete(o.symbol!);
      else
        running.positions.set(o.symbol!, {
          quantity: o.fill!.positionAfter,
          avgCostPaise: o.fill!.avgCostAfterPaise!,
        });
      const after = o.fill!.positionAfter;
      // Opened or added to a position: a long BUY, a short SELL, or a trade that crossed zero.
      const opened =
        after !== 0 &&
        (Math.sign(after) !== Math.sign(before) || Math.abs(after) > Math.abs(before));
      if (opened) {
        const m = markPortfolio(running, (s) => prices.get(s) ?? null);
        const v = BigInt(Math.abs(after)) * prices.get(o.symbol!)!;
        if (v * 100n > m.totalPaise * 25n) violations.push(`concentration breach on ${o.symbol}`);
        let gross = 0n;
        for (const [s, p] of running.positions)
          gross += BigInt(Math.abs(p.quantity)) * prices.get(s)!;
        if (gross > m.totalPaise) violations.push(`exposure breach on ${o.symbol}`);
      }
      if (!intraday && o.side === 'SELL' && after < 0) violations.push('short in long-only mode');
    }
    state = res.state;
    soldToday = res.soldToday;
    if (state.cashPaise < 0n) violations.push('negative cash');
    for (const p of state.positions.values()) {
      if (!intraday && p.quantity < 0) violations.push('negative position');
      if (p.quantity === 0) violations.push('zero position kept');
    }
    const m = markPortfolio(state, (s) => prices.get(s) ?? null);
    let sum = state.cashPaise;
    for (const [s, p] of state.positions) sum += BigInt(p.quantity) * prices.get(s)!;
    if (m.totalPaise !== sum) violations.push('total != cash + holdings');
  }
  const { entries } = await chainDrafts(EMPTY_HEAD, drafts);
  return { state, entries, violations };
}

describe.each(['delivery', 'intraday'] as const)(
  'property tests (SPEC §19.2), %s rules, 1,000 runs each',
  (mode) => {
    it('cash never goes negative (and quantities only in intraday); charges never negative; no opening trade breaches 25% or 100% exposure; total = cash + positions', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(roundArb, { minLength: 1, maxLength: 6 }), async (rounds) => {
          const { violations } = await simulate(rounds, mode);
          expect(violations).toEqual([]);
        }),
        RUNS,
      );
    });

    it('rebuilding from the ledger reproduces positions and cash exactly, and the hash chain verifies', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(roundArb, { minLength: 1, maxLength: 6 }), async (rounds) => {
          const { state, entries } = await simulate(rounds, mode);
          const rebuilt = rebuildFromLedger(entries).get('P')!;
          expect(rebuilt.cashPaise).toBe(state.cashPaise);
          expect([...rebuilt.positions.entries()].sort()).toEqual(
            [...state.positions.entries()].sort(),
          );
          const chain = await verifyChain(entries);
          expect(chain.ok).toBe(true);
        }),
        RUNS,
      );
    });

    it('tampering with any entry breaks the chain', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(roundArb, { minLength: 1, maxLength: 4 }),
          fc.nat(),
          async (rounds, pick) => {
            const { entries } = await simulate(rounds, mode);
            const i = pick % entries.length;
            const tampered = entries.map((e, j) =>
              j === i ? { ...e, note: `${e.note ?? ''}x` } : e,
            );
            expect((await verifyChain(tampered)).ok).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });
  },
);
