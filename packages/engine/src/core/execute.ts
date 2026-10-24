/**
 * Validation and execution of one participant's actions in one round (SPEC §11.1–§11.6).
 * Pure: takes the portfolio and the fill snapshot's prices, returns per-action outcomes and the new state.
 */
import { REJECTION_CODES, type RejectionCode } from '@arena/shared/codes';
import type { FeesConfig } from '@arena/shared/schemas';
import { divRoundHalfUp } from '@arena/shared/money';
import { computeCharges, type Charges } from './fees';
import { fillPrice, type PriceSource, type QuoteForFill } from './prices';
import { clonePortfolio, heldQty, holdingsValue, type PortfolioState } from './portfolio';

export type Side = 'BUY' | 'SELL';
const MAX_QTY = 2_147_483_647;

/** The only cleanup allowed (SPEC §11.2). */
export function normaliseSymbol(raw: string): string {
  let s = raw.trim().toUpperCase();
  if (s.startsWith('NSE:')) s = s.slice(4);
  if (s.endsWith('.NS')) s = s.slice(0, -3);
  else if (s.endsWith('-EQ')) s = s.slice(0, -3);
  return s;
}

export interface Fill {
  pricePaise: bigint;
  priceSource: PriceSource;
  grossPaise: bigint;
  charges: Charges;
  chargesTotalPaise: bigint;
  cashDeltaPaise: bigint;
  cashAfterPaise: bigint;
  positionAfter: number;
  avgCostAfterPaise: bigint | null;
  realizedPnlPaise: bigint | null;
}

export interface ActionOutcome {
  /** Position in the model's original list (0-based). */
  position: number;
  sideRaw: string | null;
  symbolRaw: string | null;
  quantityRaw: unknown;
  why: string | null;
  side: Side | null;
  symbol: string | null;
  quantity: number | null;
  status: 'executed' | 'rejected';
  rejectCode: RejectionCode | null;
  rejectDetail: string | null;
  modelFault: boolean;
  fill: Fill | null;
}

export interface ExecutionContext {
  universe: Set<string>;
  /** Fill-snapshot quotes for valid symbols; absent = no valid price this round. */
  fillQuotes: Map<string, QuoteForFill>;
  /** Valuation price per symbol (fill snapshot LTP, or the latest valid price for held symbols without one). */
  valuationPrice: (symbol: string) => bigint | null;
  suspended: Set<string>;
  /** Symbols this participant already sold earlier today (DP charge applies once per symbol per day). */
  soldToday: Set<string>;
  maxActions: number;
  maxWeightPct: number;
  slippageBps: number;
  fees: FeesConfig;
}

export interface ExecutionResult {
  outcomes: ActionOutcome[]; // in execution order
  state: PortfolioState;
  soldToday: Set<string>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function reject(
  base: Omit<ActionOutcome, 'status' | 'rejectCode' | 'rejectDetail' | 'modelFault' | 'fill'>,
  code: RejectionCode,
  detail: string,
): ActionOutcome {
  return {
    ...base,
    status: 'rejected',
    rejectCode: code,
    rejectDetail: detail,
    modelFault: REJECTION_CODES[code].modelFault,
    fill: null,
  };
}

interface Parsed {
  base: Omit<ActionOutcome, 'status' | 'rejectCode' | 'rejectDetail' | 'modelFault' | 'fill'>;
  error: { code: RejectionCode; detail: string } | null;
}

function parseAction(raw: unknown, position: number): Parsed {
  const obj =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const sideRaw = obj
    ? (str(obj.side) ?? (obj.side === undefined ? null : JSON.stringify(obj.side)))
    : null;
  const symbolRaw = obj
    ? (str(obj.symbol) ?? (obj.symbol === undefined ? null : JSON.stringify(obj.symbol)))
    : null;
  const quantityRaw = obj ? (obj.quantity === undefined ? null : obj.quantity) : null;
  const why = obj ? str(obj.why) : null;
  const base = {
    position,
    sideRaw,
    symbolRaw,
    quantityRaw,
    why,
    side: null,
    symbol: null,
    quantity: null,
  } as Parsed['base'];
  if (!obj || obj.side === undefined || obj.symbol === undefined || obj.quantity === undefined) {
    return {
      base,
      error: {
        code: 'MALFORMED_ACTION',
        detail: obj ? 'missing side, symbol or quantity' : 'action is not an object',
      },
    };
  }
  if (typeof obj.symbol !== 'string' || normaliseSymbol(obj.symbol) === '') {
    return {
      base,
      error: { code: 'MALFORMED_ACTION', detail: 'symbol is not a non-empty string' },
    };
  }
  base.symbol = normaliseSymbol(obj.symbol);
  if (obj.side !== 'BUY' && obj.side !== 'SELL')
    return {
      base,
      error: { code: 'INVALID_SIDE', detail: `side was ${JSON.stringify(obj.side)}` },
    };
  base.side = obj.side;
  const q = obj.quantity;
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) {
    return {
      base,
      error: { code: 'INVALID_QUANTITY', detail: `quantity was ${JSON.stringify(q)}` },
    };
  }
  if (q > MAX_QTY)
    return { base, error: { code: 'INVALID_QUANTITY', detail: `quantity ${q} is too large` } };
  base.quantity = q;
  return { base, error: null };
}

/**
 * Runs the pipeline: TOO_MANY_ACTIONS for anything past the limit (original order), then SELLs in the
 * model's order, then BUYs in the model's order, each checked against the running state.
 */
export function executeActions(
  rawActions: unknown[],
  start: PortfolioState,
  ctx: ExecutionContext,
): ExecutionResult {
  const state = clonePortfolio(start);
  const soldToday = new Set(ctx.soldToday);
  const parsed = rawActions.map((a, i) => parseAction(a, i));
  const tooMany: ActionOutcome[] = [];
  const kept: Parsed[] = [];
  for (const p of parsed) {
    if (p.base.position >= ctx.maxActions) {
      tooMany.push(
        reject(p.base, 'TOO_MANY_ACTIONS', `only ${ctx.maxActions} actions are allowed per round`),
      );
    } else kept.push(p);
  }
  const malformed = kept.filter((p) => p.error);
  const valid = kept.filter((p) => !p.error);
  const sells = valid.filter((p) => p.base.side === 'SELL');
  const buys = valid.filter((p) => p.base.side === 'BUY');
  const soldSymbols = new Set(sells.map((p) => p.base.symbol!));
  const seen = new Set<string>();
  const outcomes: ActionOutcome[] = [];

  for (const p of [...sells, ...buys]) {
    const b = p.base;
    const side = b.side!;
    const sym = b.symbol!;
    const qty = b.quantity!;
    const key = `${side}:${sym}`;
    if (seen.has(key)) {
      outcomes.push(reject(b, 'DUPLICATE_ACTION', `${side} ${sym} already appears in this round`));
      continue;
    }
    seen.add(key);
    if (side === 'BUY' && soldSymbols.has(sym)) {
      outcomes.push(reject(b, 'CONFLICTING_SIDES', `Tried to buy ${sym} while also selling it`));
      continue;
    }
    const held = heldQty(state, sym);
    if (side === 'SELL' && held === 0) {
      outcomes.push(reject(b, 'UNKNOWN_SYMBOL', `Tried to sell ${qty} ${sym}, held 0`));
      continue;
    }
    if (side === 'BUY' && !ctx.universe.has(sym)) {
      if (held > 0)
        outcomes.push(
          reject(
            b,
            'NOT_IN_UNIVERSE_FOR_BUY',
            `${sym} has left the Nifty 50: it can be sold but not bought`,
          ),
        );
      else outcomes.push(reject(b, 'UNKNOWN_SYMBOL', `${sym} is not in the Nifty 50`));
      continue;
    }
    if (ctx.suspended.has(sym)) {
      outcomes.push(reject(b, 'SYMBOL_SUSPENDED', `${sym} is under review and can't be traded`));
      continue;
    }
    const q = ctx.fillQuotes.get(sym);
    if (!q) {
      outcomes.push(reject(b, 'PRICE_UNAVAILABLE', `No valid price for ${sym} this round`));
      continue;
    }
    const fp = fillPrice(q, side, ctx.slippageBps);
    const gross = fp.pricePaise * BigInt(qty);

    if (side === 'SELL') {
      if (qty > held) {
        outcomes.push(
          reject(b, 'INSUFFICIENT_HOLDINGS', `Tried to sell ${qty} ${sym}, held ${held}`),
        );
        continue;
      }
      const ch = computeCharges(ctx.fees, 'SELL', gross, { dpApplies: !soldToday.has(sym) });
      const pos = state.positions.get(sym)!;
      const cashDelta = gross - ch.total;
      state.cashPaise += cashDelta;
      const after = pos.quantity - qty;
      const realized = (fp.pricePaise - pos.avgCostPaise) * BigInt(qty) - ch.total;
      const avgAfter = after > 0 ? pos.avgCostPaise : null;
      if (after > 0) pos.quantity = after;
      else state.positions.delete(sym);
      soldToday.add(sym);
      outcomes.push({
        ...b,
        status: 'executed',
        rejectCode: null,
        rejectDetail: null,
        modelFault: false,
        fill: {
          pricePaise: fp.pricePaise,
          priceSource: fp.source,
          grossPaise: gross,
          charges: ch.lines,
          chargesTotalPaise: ch.total,
          cashDeltaPaise: cashDelta,
          cashAfterPaise: state.cashPaise,
          positionAfter: after,
          avgCostAfterPaise: avgAfter,
          realizedPnlPaise: realized,
        },
      });
      continue;
    }

    // BUY
    const ch = computeCharges(ctx.fees, 'BUY', gross, { dpApplies: false });
    const cost = gross + ch.total;
    if (cost > state.cashPaise) {
      outcomes.push(
        reject(
          b,
          'INSUFFICIENT_CASH',
          `Buying ${qty} ${sym} needs ${fmt(cost)} INR with costs; cash is ${fmt(state.cashPaise)}`,
        ),
      );
      continue;
    }
    // Concentration: after the buy, this stock's value at the valuation price must be ≤ maxWeightPct of total value.
    const valPx = ctx.valuationPrice(sym) ?? q.ltpPaise;
    const newQty = held + qty;
    const cashAfter = state.cashPaise - cost;
    const pos = state.positions.get(sym);
    const trial: PortfolioState = { cashPaise: cashAfter, positions: new Map(state.positions) };
    trial.positions.set(sym, {
      quantity: newQty,
      avgCostPaise: pos?.avgCostPaise ?? fp.pricePaise,
    });
    const total =
      cashAfter + holdingsValue(trial, (s) => (s === sym ? valPx : ctx.valuationPrice(s)));
    const stockValue = BigInt(newQty) * valPx;
    if (stockValue * 100n > total * BigInt(ctx.maxWeightPct)) {
      outcomes.push(
        reject(
          b,
          'CONCENTRATION_LIMIT',
          `Buying ${qty} ${sym} would make it ${pct(stockValue, total)}% of the portfolio; the limit is ${ctx.maxWeightPct}%`,
        ),
      );
      continue;
    }
    const avgAfter = pos
      ? divRoundHalfUp(BigInt(pos.quantity) * pos.avgCostPaise + gross, BigInt(newQty))
      : fp.pricePaise;
    state.cashPaise = cashAfter;
    state.positions.set(sym, { quantity: newQty, avgCostPaise: avgAfter });
    outcomes.push({
      ...b,
      status: 'executed',
      rejectCode: null,
      rejectDetail: null,
      modelFault: false,
      fill: {
        pricePaise: fp.pricePaise,
        priceSource: fp.source,
        grossPaise: gross,
        charges: ch.lines,
        chargesTotalPaise: ch.total,
        cashDeltaPaise: -cost,
        cashAfterPaise: cashAfter,
        positionAfter: newQty,
        avgCostAfterPaise: avgAfter,
        realizedPnlPaise: null,
      },
    });
  }

  for (const p of malformed) outcomes.push(reject(p.base, p.error!.code, p.error!.detail));
  outcomes.push(...tooMany);
  return { outcomes, state, soldToday };
}

function fmt(p: bigint): string {
  // Only called with non-negative amounts (cash and costs).
  return `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
}

function pct(part: bigint, whole: bigint): string {
  // whole ≥ part > 0: the total includes the stock being bought.
  const tenths = divRoundHalfUp(part * 1000n, whole);
  return `${tenths / 10n}.${tenths % 10n}`;
}
