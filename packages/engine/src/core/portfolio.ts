export interface Position {
  quantity: number;
  avgCostPaise: bigint;
}

export interface PortfolioState {
  cashPaise: bigint;
  positions: Map<string, Position>;
}

export function clonePortfolio(p: PortfolioState): PortfolioState {
  return {
    cashPaise: p.cashPaise,
    positions: new Map([...p.positions].map(([k, v]) => [k, { ...v }])),
  };
}

export function heldQty(p: PortfolioState, symbol: string): number {
  return p.positions.get(symbol)?.quantity ?? 0;
}

/** Holdings value at the given prices. Throws if a held symbol has no price: callers must supply one. */
export function holdingsValue(
  p: PortfolioState,
  priceOf: (symbol: string) => bigint | null,
): bigint {
  let v = 0n;
  for (const [sym, pos] of p.positions) {
    if (pos.quantity === 0) continue;
    const px = priceOf(sym);
    if (px === null) throw new Error(`no valuation price for held symbol ${sym}`);
    v += BigInt(pos.quantity) * px;
  }
  return v;
}

export interface Mark {
  cashPaise: bigint;
  holdingsValuePaise: bigint;
  totalPaise: bigint;
}

export function markPortfolio(p: PortfolioState, priceOf: (symbol: string) => bigint | null): Mark {
  const h = holdingsValue(p, priceOf);
  return { cashPaise: p.cashPaise, holdingsValuePaise: h, totalPaise: p.cashPaise + h };
}
