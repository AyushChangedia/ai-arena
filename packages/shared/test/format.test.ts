import { describe, it, expect } from 'vitest';
import {
  groupIndian,
  formatInr,
  formatInrCompact,
  formatPct,
  formatPts,
  direction,
  formatTimeIst,
  formatDateIst,
  formatLongDateIst,
  formatDateTimeIst,
  formatTradingDate,
  formatInt,
  formatUsd,
} from '../src/format';

describe('formatters (SPEC §16.6)', () => {
  it('groups digits the Indian way', () => {
    expect(groupIndian('1')).toBe('1');
    expect(groupIndian('1000')).toBe('1,000');
    expect(groupIndian('100000')).toBe('1,00,000');
    expect(groupIndian('10000000')).toBe('1,00,00,000');
    expect(groupIndian('123456789')).toBe('12,34,56,789');
  });
  it('formats rupees', () => {
    expect(formatInr(10000000n)).toBe('₹1,00,000.00');
    expect(formatInr(341250n)).toBe('₹3,412.50');
    expect(formatInr(-5n)).toBe('−₹0.05');
    expect(formatInr(10421250n, { decimals: 0 })).toBe('₹1,04,213');
  });
  it('formats compact rupees', () => {
    expect(formatInrCompact(10421200n)).toBe('₹1.04L');
    expect(formatInrCompact(2_50_00_000n * 100n)).toBe('₹2.5Cr');
    expect(formatInrCompact(10000000n)).toBe('₹1L');
    expect(formatInrCompact(9999900n)).toBe('₹99,999');
    expect(formatInrCompact(-10421200n)).toBe('−₹1.04L');
    expect(formatInrCompact(150_00_00_000n * 100n)).toBe('₹150Cr');
  });
  it('formats percentages with arrows and true minus', () => {
    expect(formatPct(0.0421)).toBe('▲ +4.21%');
    expect(formatPct(-0.0107)).toBe('▼ −1.07%');
    expect(formatPct(0)).toBe('0.00%');
    expect(formatPct(0.00001)).toBe('0.00%');
    expect(formatPct(0.5, { arrow: false })).toBe('+50.00%');
    expect(formatPct(-0.5, { arrow: false })).toBe('−50.00%');
    expect(() => formatPct(Number.NaN)).toThrow();
    expect(formatPts(0.012)).toBe('+1.20 pts');
    expect(formatPts(-0.012)).toBe('−1.20 pts');
    expect(formatPts(0)).toBe('0.00 pts');
    expect(direction(0.01)).toBe('gain');
    expect(direction(-0.01)).toBe('loss');
    expect(direction(0)).toBe('flat');
  });
  it('formats times and dates in IST regardless of host time zone', () => {
    const d = new Date('2026-11-02T06:00:00Z'); // 11:30 IST, Monday
    expect(formatTimeIst(d)).toBe('11:30 IST');
    expect(formatDateIst(d)).toBe('Mon 2 Nov');
    expect(formatLongDateIst(d)).toBe('Monday 2 Nov');
    expect(formatDateTimeIst(d)).toBe('Mon 2 Nov, 11:30 IST');
    expect(formatTradingDate('2026-11-02')).toBe('Mon 2 Nov');
    expect(formatTimeIst(new Date('2026-11-02T19:00:00Z'))).toBe('00:30 IST');
  });
  it('formats integers and dollars', () => {
    expect(formatInt(1234567)).toBe('12,34,567');
    expect(formatInt(-1000n)).toBe('−1,000');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(3.5)).toBe('$3.50');
  });
});
