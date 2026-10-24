import { divRoundHalfUp } from '@arena/shared/money';

export type PriceSource = 'ask' | 'bid' | 'ltp_slippage';

export interface QuoteForFill {
  ltpPaise: bigint;
  bidPaise: bigint | null;
  askPaise: bigint | null;
  depthAvailable: boolean;
}

export interface FillPrice {
  pricePaise: bigint;
  source: PriceSource;
}

/** BUY at best ask, SELL at best bid; without depth, LTP ± slippage rounded to the nearest paisa (SPEC §11.4). */
export function fillPrice(q: QuoteForFill, side: 'BUY' | 'SELL', slippageBps: number): FillPrice {
  if (q.depthAvailable && q.bidPaise !== null && q.askPaise !== null) {
    return side === 'BUY'
      ? { pricePaise: q.askPaise, source: 'ask' }
      : { pricePaise: q.bidPaise, source: 'bid' };
  }
  const bps = BigInt(slippageBps);
  const factor = side === 'BUY' ? 10_000n + bps : 10_000n - bps;
  return { pricePaise: divRoundHalfUp(q.ltpPaise * factor, 10_000n), source: 'ltp_slippage' };
}
