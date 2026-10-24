import { describe, it, expect } from 'vitest';
import {
  istParts,
  isTradingDay,
  marketOpen,
  nextSlot,
  countdown,
  slotLabel,
} from '../../src/lib/clock';
import { verdict, blunderText, firstLine } from '../../src/lib/view';

const slots = ['09:30', '10:00', '15:00'];

describe('client clock (IST, from config)', () => {
  it('converts to IST and knows market hours', () => {
    expect(istParts(new Date('2026-11-02T04:00:00Z'))).toEqual({
      date: '2026-11-02',
      minutes: 570,
      weekday: 1,
    });
    expect(isTradingDay('2026-11-01', [])).toBe(false);
    expect(isTradingDay('2026-11-02', ['2026-11-02'])).toBe(false);
    expect(marketOpen(new Date('2026-11-02T04:00:00Z'), [])).toBe(true);
    expect(marketOpen(new Date('2026-11-02T11:00:00Z'), [])).toBe(false);
  });
  it('finds the next slot across weekends and holidays', () => {
    expect(nextSlot(new Date('2026-11-02T04:10:00Z'), { slots, holidays: [] })?.slot).toBe('10:00');
    const fri = new Date('2026-10-30T10:00:00Z'); // Friday 15:30 IST
    const n = nextSlot(fri, { slots, holidays: ['2026-11-02'] })!;
    expect([n.date, n.slot]).toEqual(['2026-11-03', '09:30']);
    expect(slotLabel(n, fri)).toBe('Tuesday 9:30 IST');
    expect(slotLabel({ date: '2026-10-30', slot: '15:00' }, fri)).toBe('15:00 IST');
    expect(nextSlot(fri, { slots: [], holidays: [] })).toBeNull();
  });
  it('formats countdowns', () => {
    expect(countdown(-1)).toBe('now');
    expect(countdown(5 * 60_000)).toBe('5 min');
    expect(countdown(125 * 60_000)).toBe('2 h 5 min');
    expect(countdown(50 * 3_600_000)).toBe('2 d 2 h');
  });
});

describe('verdicts and blunders (SPEC §16.3 vocabulary)', () => {
  const a = (side: string, quantity: number, symbol: string, status = 'executed') => ({
    side,
    quantity,
    symbol,
    status,
  });
  it('describes moves in plain words', () => {
    expect(verdict('OK', [a('BUY', 12, 'TCS')])).toBe('Bought 12 TCS');
    expect(verdict('OK', [a('BUY', 8, 'LT'), a('SELL', 30, 'ITC')])).toBe(
      'Sold 30 ITC, bought 8 LT',
    );
    expect(verdict('OK', [])).toBe('Held');
    expect(verdict('OK', [a('BUY', 1, 'X', 'rejected')])).toBe('Held (every action rejected)');
    expect(verdict('MISSED_PROVIDER', [])).toBe('Missed round: provider timeout');
    expect(verdict('INVALID_RESPONSE', [])).toBe('Unreadable answer');
    expect(verdict('SKIPPED_BUDGET', [])).toBe('Paused (budget)');
    expect(verdict('RETIRED', [a('SELL', 4, 'AAA')])).toBe('Retired: sold 4 AAA');
    expect(verdict('RETIRED', [])).toBe('Retired');
  });
  it('blunders and first lines', () => {
    expect(
      blunderText({
        rejectDetail: 'Tried to sell 40 HDFCBANK, held 0',
        rejectCode: 'UNKNOWN_SYMBOL',
        sideRaw: 'SELL',
        symbolRaw: 'HDFCBANK',
        quantityRaw: 40,
      }),
    ).toBe('Tried to sell 40 HDFCBANK, held 0');
    expect(
      blunderText({
        rejectDetail: null,
        rejectCode: 'INVALID_SIDE',
        sideRaw: 'HOLD',
        symbolRaw: 'X',
        quantityRaw: 1,
      }),
    ).toBe('INVALID_SIDE: HOLD 1 X');
    expect(firstLine('a\nb')).toBe('a');
    expect(firstLine(null)).toBe('');
    expect(firstLine('x'.repeat(200), 10)).toHaveLength(10);
  });
});
