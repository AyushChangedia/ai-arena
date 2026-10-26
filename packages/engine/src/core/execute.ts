/**
 * Validation and execution of one participant's actions in one round (SPEC §11.1–§11.6).
 * Pure: takes the portfolio and the fill snapshot's prices, returns per-action outcomes and the new state.
 * Positions are signed: a negative quantity is a short (intraday product only), and its average cost is
 * the average price it was sold at.
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
  /** The model's stated exit (target, stop or time). Published, never acted on. */
  exitPlan: string | null;
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
  /** Intraday product: a SELL beyond the shares held opens or adds to a short position. */
  allowShort?: boolean;
  /** Longs plus shorts at the valuation price may not exceed this % of total value (100 = no leverage). */
  maxGrossExposurePct?: number;
  /** Engine-generated closing orders (square-off): the limits on opening a position don't apply. */
  forced?: boolean;
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
  const exitPlan = obj ? str(obj.exit_plan) : null;
  const base = {
    position,
    sideRaw,
    symbolRaw,
    quantityRaw,
    why,
    exitPlan,
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
  const allowShort = ctx.allowShort ?? false;
  const maxExposurePct = ctx.maxGrossExposurePct ?? 100;
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
    // Signed position: negative = short. A SELL closes a long first, then opens or adds to a short;
    // a BUY covers a short first, then opens or adds to a long.
    const held = heldQty(state, sym);
    const closing =
      side === 'SELL' ? Math.min(qty, Math.max(held, 0)) : Math.min(qty, Math.max(-held, 0));
    const opening = qty - closing;
    if (side === 'SELL' && opening > 0 && !allowShort && held <= 0) {
      outcomes.push(reject(b, 'UNKNOWN_SYMBOL', `Tried to sell ${qty} ${sym}, held 0`));
      continue;
    }
    // Under long-only rules a SELL never opens a position (too many shares is INSUFFICIENT_HOLDINGS below).
    const opens = opening > 0 && (side === 'BUY' || allowShort);
    if (opens && !ctx.universe.has(sym)) {
      if (held !== 0)
        outcomes.push(
          reject(
            b,
            'NOT_IN_UNIVERSE_FOR_BUY',
            held > 0
              ? `${sym} has left the Nifty 50: it can be sold but not bought`
              : `${sym} has left the Nifty 50: it can be bought back but not shorted`,
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
    if (side === 'SELL' && opening > 0 && !allowShort) {
      outcomes.push(
        reject(b, 'INSUFFICIENT_HOLDINGS', `Tried to sell ${qty} ${sym}, held ${held}`),
      );
      continue;
    }
    const fp = fillPrice(q, side, ctx.slippageBps);
    const gross = fp.pricePaise * BigInt(qty);
    const ch = computeCharges(ctx.fees, side, gross, {
      dpApplies: side === 'SELL' && closing > 0 && !soldToday.has(sym),
    });
    const cashDelta = side === 'SELL' ? gross - ch.total : -(gross + ch.total);
    if (side === 'BUY' && -cashDelta > state.cashPaise) {
      outcomes.push(
        reject(
          b,
          'INSUFFICIENT_CASH',
          `Buying ${qty} ${sym} needs ${fmt(-cashDelta)} INR with costs; cash is ${fmt(state.cashPaise)}`,
        ),
      );
      continue;
    }
    const after = side === 'SELL' ? held - qty : held + qty;
    const cashAfter = state.cashPaise + cashDelta;
    if (opens && !ctx.forced) {
      // Limits on opening or adding to a position, at the valuation price, after the trade.
      const valPx = ctx.valuationPrice(sym) ?? q.ltpPaise;
      const trial: PortfolioState = { cashPaise: cashAfter, positions: new Map(state.positions) };
      trial.positions.set(sym, { quantity: after, avgCostPaise: fp.pricePaise });
      const priceOf = (s: string) => (s === sym ? valPx : ctx.valuationPrice(s));
      const total = cashAfter + holdingsValue(trial, priceOf);
      const stockValue = BigInt(Math.abs(after)) * valPx;
      const verb = side === 'BUY' ? 'Buying' : after < 0 ? 'Shorting' : 'Selling';
      if (total <= 0n || stockValue * 100n > total * BigInt(ctx.maxWeightPct)) {
        outcomes.push(
          reject(
            b,
            'CONCENTRATION_LIMIT',
            `${verb} ${qty} ${sym} would make it ${total > 0n ? pct(stockValue, total) : 'over 100'}% of the portfolio; the limit is ${ctx.maxWeightPct}%`,
          ),
        );
        continue;
      }
      const exposure = grossExposure(trial, priceOf);
      if (exposure * 100n > total * BigInt(maxExposurePct)) {
        outcomes.push(
          reject(
            b,
            'EXPOSURE_LIMIT',
            `${verb} ${qty} ${sym} would take longs plus shorts to ${pct(exposure, total)}% of the portfolio; the limit is ${maxExposurePct}%`,
          ),
        );
        continue;
      }
    }
    const pos = state.positions.get(sym);
    let avgAfter: bigint | null;
    if (after === 0) avgAfter = null;
    else if (held === 0 || Math.sign(after) !== Math.sign(held)) avgAfter = fp.pricePaise;
    else if (Math.abs(after) < Math.abs(held)) avgAfter = pos!.avgCostPaise;
    else
      avgAfter = divRoundHalfUp(
        BigInt(Math.abs(held)) * pos!.avgCostPaise + gross,
        BigInt(Math.abs(after)),
      );
    // Realised P&L on the part that closed a position, less this order's charges.
    const realized =
      closing > 0
        ? (side === 'SELL'
            ? fp.pricePaise - pos!.avgCostPaise
            : pos!.avgCostPaise - fp.pricePaise) *
            BigInt(closing) -
          ch.total
        : null;
    state.cashPaise = cashAfter;
    if (after === 0) state.positions.delete(sym);
    else state.positions.set(sym, { quantity: after, avgCostPaise: avgAfter! });
    if (side === 'SELL') soldToday.add(sym);
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
        cashAfterPaise: cashAfter,
        positionAfter: after,
        avgCostAfterPaise: avgAfter,
        realizedPnlPaise: realized,
      },
    });
  }

  for (const p of malformed) outcomes.push(reject(p.base, p.error!.code, p.error!.detail));
  outcomes.push(...tooMany);
  return { outcomes, state, soldToday };
}

/** Longs plus shorts at the given prices (absolute values). */
function grossExposure(p: PortfolioState, priceOf: (symbol: string) => bigint | null): bigint {
  let v = 0n;
  for (const [sym, pos] of p.positions) {
    if (pos.quantity === 0) continue;
    const px = priceOf(sym);
    if (px === null) throw new Error(`no valuation price for held symbol ${sym}`);
    v += BigInt(Math.abs(pos.quantity)) * px;
  }
  return v;
}

function fmt(p: bigint): string {
  // Only called with non-negative amounts (cash and costs).
  return `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
}

function pct(part: bigint, whole: bigint): string {
  // whole > 0 (callers check); part ≥ 0.
  const tenths = divRoundHalfUp(part * 1000n, whole);
  return `${tenths / 10n}.${tenths % 10n}`;
}
