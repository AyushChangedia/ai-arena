/**
 * The Monkey: a seeded random trader (SPEC §11.9). The only randomness in the engine.
 * mulberry32 seeded with the first 32 bits of sha256(round_id + ":monkey").
 */
import { sha256Hex } from '@arena/shared/canonical';
import type { PortfolioState } from './portfolio';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function monkeySeed(roundId: string): Promise<{ seedHex: string; seed: number }> {
  const h = await sha256Hex(`${roundId}:monkey`);
  const seedHex = h.slice(0, 8);
  return { seedHex, seed: parseInt(seedHex, 16) >>> 0 };
}

export interface MonkeyInput {
  roundId: string;
  portfolio: PortfolioState;
  /** Tradeable symbols with their decision-snapshot LTP (valid, in universe, not suspended). */
  tradeable: Map<string, bigint>;
  /** Decision-snapshot LTP for valuation of every held symbol. */
  ltp: (symbol: string) => bigint | null;
}

export interface MonkeyDecision {
  seedHex: string;
  reasoning: string;
  actions: { side: 'BUY' | 'SELL'; symbol: string; quantity: number; why: string }[];
}

export async function monkeyDecide(input: MonkeyInput): Promise<MonkeyDecision> {
  const { seedHex, seed } = await monkeySeed(input.roundId);
  const rng = mulberry32(seed);
  const none = (why: string): MonkeyDecision => ({ seedHex, reasoning: why, actions: [] });
  if (rng() < 0.5) return none('Coin flip: do nothing this round.');
  const holdings = [...input.portfolio.positions.entries()]
    .filter(([, p]) => p.quantity > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (holdings.length > 0 && rng() < 0.5) {
    const [symbol, pos] = holdings[Math.floor(rng() * holdings.length)]!;
    const quantity = 1 + Math.floor(rng() * pos.quantity);
    return {
      seedHex,
      reasoning: 'Coin flip: sell a random holding.',
      actions: [{ side: 'SELL', symbol, quantity, why: 'Random sell.' }],
    };
  }
  const symbols = [...input.tradeable.keys()].sort();
  if (symbols.length === 0) return none('Nothing tradeable this round.');
  const symbol = symbols[Math.floor(rng() * symbols.length)]!;
  const bp = 500 + Math.floor(rng() * 1501); // 5.00% to 20.00% of total value
  let total = input.portfolio.cashPaise;
  for (const [s, p] of input.portfolio.positions) {
    const px = input.ltp(s);
    if (px !== null) total += BigInt(p.quantity) * px;
  }
  const ltp = input.tradeable.get(symbol)!;
  const quantity = Number((total * BigInt(bp)) / 10_000n / ltp);
  if (quantity < 1)
    return none(
      `Coin flip: buy ${symbol}, but ${(bp / 100).toFixed(2)}% of the portfolio is less than one share.`,
    );
  return {
    seedHex,
    reasoning: `Coin flip: buy ${symbol} worth about ${(bp / 100).toFixed(2)}% of the portfolio.`,
    actions: [{ side: 'BUY', symbol, quantity, why: 'Random buy.' }],
  };
}
