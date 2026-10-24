import { divRoundHalfUp } from '@arena/shared/money';

/** Nifty 50 benchmark value: starting cash × index now ÷ index at start, no costs (SPEC §3.1). */
export function indexBenchmarkValue(
  startingCashPaise: bigint,
  indexAtStartX100: bigint,
  indexNowX100: bigint,
): bigint {
  if (indexAtStartX100 <= 0n) throw new RangeError('index at start must be positive');
  return divRoundHalfUp(startingCashPaise * indexNowX100, indexAtStartX100);
}
