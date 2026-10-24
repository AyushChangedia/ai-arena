/**
 * Corporate-action adjustments (SPEC §8.7). Ratios are new-for-old:
 *  split  num:den → quantity × num ÷ den (e.g. 2:1 doubles the shares), average cost × den ÷ num;
 *  bonus  num:den → num bonus shares for every den held; average cost spread over the new total;
 *  dividend       → cash += quantity × amount per share.
 * Fractional entitlements are dropped (disclosed on /rules).
 */
import { divRoundHalfUp } from '@arena/shared/money';
import type { Position } from './portfolio';

export interface CorporateAction {
  type: 'split' | 'bonus' | 'dividend';
  ratioNum: number | null;
  ratioDen: number | null;
  amountPaisePerShare: bigint | null;
}

export interface Adjustment {
  quantityDelta: number;
  quantityAfter: number;
  avgCostAfterPaise: bigint | null;
  cashDeltaPaise: bigint;
}

export function applyCorporateAction(pos: Position, ca: CorporateAction): Adjustment {
  if (ca.type === 'dividend') {
    if (ca.amountPaisePerShare === null || ca.amountPaisePerShare <= 0n)
      throw new RangeError('dividend needs a positive amount');
    return {
      quantityDelta: 0,
      quantityAfter: pos.quantity,
      avgCostAfterPaise: pos.avgCostPaise,
      cashDeltaPaise: BigInt(pos.quantity) * ca.amountPaisePerShare,
    };
  }
  const num = ca.ratioNum;
  const den = ca.ratioDen;
  if (!num || !den || num <= 0 || den <= 0)
    throw new RangeError(`${ca.type} needs a positive ratio`);
  const q = BigInt(pos.quantity);
  const after =
    ca.type === 'split' ? (q * BigInt(num)) / BigInt(den) : q + (q * BigInt(num)) / BigInt(den);
  if (after <= 0n)
    return {
      quantityDelta: -pos.quantity,
      quantityAfter: 0,
      avgCostAfterPaise: null,
      cashDeltaPaise: 0n,
    };
  const avg = divRoundHalfUp(q * pos.avgCostPaise, after);
  return {
    quantityDelta: Number(after - q),
    quantityAfter: Number(after),
    avgCostAfterPaise: avg,
    cashDeltaPaise: 0n,
  };
}
