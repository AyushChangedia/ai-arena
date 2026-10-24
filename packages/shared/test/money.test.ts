import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  divRoundHalfUp,
  mulFrac,
  decimalToScaled,
  rupeesToPaise,
  paiseToDecimal,
  ratio,
  maxBig,
  minBig,
  sumBig,
} from '../src/money';

describe('money', () => {
  it('rounds half up, away from zero', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
    expect(divRoundHalfUp(-15n, 10n)).toBe(-2n);
    expect(divRoundHalfUp(-14n, 10n)).toBe(-1n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow();
  });
  it('mulFrac', () => {
    expect(mulFrac(10000000n, 1n, 1000n)).toBe(10000n);
    expect(mulFrac(12345n, 3n, 20000n)).toBe(2n); // 1.85 -> 2
  });
  it('converts rupee decimals exactly', () => {
    expect(rupeesToPaise(568.2)).toBe(56820n);
    expect(rupeesToPaise('3412.50')).toBe(341250n);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30n);
    expect(rupeesToPaise(1.005)).toBe(101n);
    expect(rupeesToPaise(-12.345)).toBe(-1235n);
    expect(rupeesToPaise(7)).toBe(700n);
    expect(rupeesToPaise(1e-7)).toBe(0n);
    expect(decimalToScaled('24321.4', 2)).toBe(2432140n);
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
    expect(() => rupeesToPaise(1e22)).toThrow();
    expect(() => rupeesToPaise('12,3')).toThrow();
  });
  it('round-trips paise through decimal strings', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (p) => {
        expect(rupeesToPaise(paiseToDecimal(p))).toBe(p);
      }),
      { numRuns: 1000 },
    );
    expect(paiseToDecimal(5n)).toBe('0.05');
    expect(paiseToDecimal(-150n)).toBe('-1.50');
  });
  it('helpers', () => {
    expect(ratio(1n, 4n)).toBe(0.25);
    expect(() => ratio(1n, 0n)).toThrow();
    expect(maxBig(1n, 2n)).toBe(2n);
    expect(maxBig(3n, 2n)).toBe(3n);
    expect(minBig(1n, 2n)).toBe(1n);
    expect(minBig(3n, 2n)).toBe(2n);
    expect(sumBig([1n, 2n, 3n])).toBe(6n);
  });
});
