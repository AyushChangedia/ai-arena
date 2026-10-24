import { describe, it, expect } from 'vitest';
import { computeCharges } from '../../src/core/fees';
import {
  chainDrafts,
  adjustDraft,
  seasonStartDraft,
  rebuildFromLedger,
  EMPTY_HEAD,
} from '../../src/core/ledger';
import { monkeyDecide } from '../../src/core/monkey';
import { must, loadFees } from '../../src/config/load';

const fees = must(loadFees());

describe('fees with other broker profiles', () => {
  it('applies sell-only charges and skips GST on charges that do not apply to the side', () => {
    const custom = structuredClone(fees);
    custom.charges.brokerage = {
      rate: { num: 3, den: 10000 },
      appliesTo: 'sell',
      label: 'Brokerage',
    };
    const buy = computeCharges(custom, 'BUY', 10_000_000n, { dpApplies: false });
    const sell = computeCharges(custom, 'SELL', 10_000_000n, { dpApplies: false });
    expect(buy.lines.brokerage).toBe(0n);
    expect(sell.lines.brokerage).toBe(3000n);
    expect(sell.lines.gst).toBe(597n); // 18% × (30.00 + 2.97 + 0.10 + 0.10) = 5.9706
    expect(buy.lines.gst).toBe(57n);
  });
});

describe('ledger rebuild edge cases', () => {
  it('sorts by seq and applies corrections that set a position directly', async () => {
    const t = new Date('2026-11-02T04:00:00Z');
    const b = (id: string) => ({
      id,
      seasonId: 'S',
      participantId: 'P',
      roundId: null,
      occurredAt: t,
      revealAt: t,
    });
    const { entries } = await chainDrafts(EMPTY_HEAD, [
      seasonStartDraft(b('a'), 500n),
      adjustDraft(b('b'), {
        type: 'CORRECTION',
        symbol: 'TCS',
        quantityDelta: null,
        grossPaise: 0n,
        cashDeltaPaise: 0n,
        cashAfterPaise: 500n,
        positionAfter: 3,
        avgCostAfterPaise: null,
        note: 'fix',
        refSeq: 1n,
      }),
    ]);
    const p = rebuildFromLedger([...entries].reverse()).get('P')!;
    expect(p.positions.get('TCS')).toEqual({ quantity: 3, avgCostPaise: 0n });
    expect(entries[1]!.ref_seq).toBe(1n);
  });
});

describe('Monkey valuation', () => {
  it('ignores holdings with no price when sizing a buy', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        monkeyDecide({
          roundId: `v${i}`,
          portfolio: {
            cashPaise: 1_000_000n,
            positions: new Map([['NOPX', { quantity: 1, avgCostPaise: 1n }]]),
          },
          tradeable: new Map([['ITC', 45_000n]]),
          ltp: () => null,
        }),
      ),
    );
    const buys = results.flatMap((r) => r.actions).filter((a) => a.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    for (const a of buys) expect(BigInt(a.quantity) * 45_000n).toBeLessThanOrEqual(200_000n);
  });
});
