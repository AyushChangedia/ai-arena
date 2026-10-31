/**
 * The trader prompt (SPEC §10). Identical for every participant; numbers are plain decimals.
 */
import { paiseToDecimal } from '@arena/shared/money';
import type { ArenaConfig, FeesConfig } from '@arena/shared/schemas';
import { cappedCharges, costPctString, flatPerOrderPaise } from '../core/fees';

export interface SystemPromptParams {
  seasonStart: string;
  seasonEnd: string;
  seasonTradingDays: number;
  roundTimes: string[];
}

export function renderSystemPrompt(
  arena: ArenaConfig,
  fees: FeesConfig,
  p: SystemPromptParams,
): string {
  const intraday = arena.product === 'intraday_long_short' ? arena.intraday! : null;
  const flatBuy = flatPerOrderPaise(fees, 'BUY');
  const flatSell = flatPerOrderPaise(fees, 'SELL');
  const flat =
    flatBuy === flatSell
      ? `${paiseToDecimal(flatBuy)} INR per order`
      : `${paiseToDecimal(flatBuy)} INR per BUY order and ${paiseToDecimal(flatSell)} INR per SELL order`;
  const dp = fees.dpCharge
    ? ` plus ${paiseToDecimal(BigInt(fees.dpCharge.paisePerSymbolPerDay))} INR per stock on each day you sell it`
    : '';
  const caps = cappedCharges(fees)
    .map(
      (c) =>
        `${c.label.toLowerCase()} of ${c.ratePct}% of trade value or ${paiseToDecimal(c.maxPaise)} INR per order, whichever is lower${c.gstPct ? `, plus ${c.gstPct}% GST on it` : ''}`,
    )
    .join('; ');
  const costs = caps
    ? `Costs: ${caps}; other costs about ${costPctString(fees, 'BUY')}% of trade value on a BUY and about ${costPctString(fees, 'SELL')}% on a SELL${dp}.`
    : flatBuy > 0n || flatSell > 0n
      ? `Costs: ${flat} (brokerage with GST), plus about ${costPctString(fees, 'BUY')}% of trade value on a BUY and about ${costPctString(fees, 'SELL')}% on a SELL${dp}.`
      : `Costs: about ${costPctString(fees, 'BUY')}% of trade value on a BUY; about ${costPctString(fees, 'SELL')}% on a SELL${dp}.`;
  const rules = intraday
    ? [
        "Trade only symbols listed in the MARKET table, spelled exactly as shown. Symbols listed under NO_PRICE can't be traded this round.",
        'Intraday only, long or short. BUY to open or add to a long position; SELL to open or add to a short position (a short has a negative quantity). No leverage, no derivatives.',
        `Square-off: from ${intraday.squareOffFrom} IST (by ${intraday.squareOffDeadline} at the latest) every open position is closed automatically (longs sold at the best bid, shorts bought back at the best ask, with normal costs). Nothing is held overnight; every trading day starts in cash.`,
        'Quantity is a whole number of shares, at least 1. There are no partial fills.',
        'A SELL closes your long shares first; any shares beyond them open a short. A BUY buys back your short first; any shares beyond it open a long. A BUY needs cash for its full cost.',
        `After a trade that opens or adds to a position, that stock may not be more than ${arena.limits.maxWeightPct}% of your total portfolio value (long or short), and longs plus shorts at market value may not be more than ${arena.limits.maxGrossExposurePct}% of your total value.`,
        `At most ${arena.limits.maxActionsPerRound} actions per round. All SELLs run first, then all BUYs, each in the order you list them, so cash from sells can fund buys.`,
        "Don't BUY a symbol you are also selling in the same round.",
        'Orders fill a minute or two after you answer, at the live best ask (BUY) or best bid (SELL), not at the prices shown here.',
        costs,
        'To make no trades, return an empty actions list.',
      ]
    : [
        "Trade only symbols listed in the MARKET table, spelled exactly as shown. Symbols listed under NO_PRICE can't be traded this round.",
        'Long-only cash delivery: no short selling, no leverage, no derivatives.',
        'Quantity is a whole number of shares, at least 1. There are no partial fills.',
        'SELL only shares you hold. BUY only what your cash covers after costs.',
        `A BUY may not take that stock above ${arena.limits.maxWeightPct}% of your total portfolio value.`,
        `At most ${arena.limits.maxActionsPerRound} actions per round. All SELLs run first, then all BUYs, each in the order you list them, so cash from sells can fund buys.`,
        "Don't BUY a symbol you are also selling in the same round.",
        'Orders fill a minute or two after you answer, at the live best ask (BUY) or best bid (SELL), not at the prices shown here.',
        costs,
        'To make no trades, return an empty actions list.',
      ];
  const schedule = intraday
    ? `There are ${p.roundTimes.length} rounds per trading day, at ${p.roundTimes.join(', ')} IST, then the square-off at ${intraday.squareOffFrom} IST.`
    : `There are ${p.roundTimes.length} rounds per trading day, at ${p.roundTimes.join(', ')} IST.`;
  const exit = intraday
    ? 'when you will close it: a target price, a stop price or a time'
    : 'when you will sell it: a target price, a stop price or a date';
  return `You are a portfolio manager in AI Arena, a public competition between AI models trading Indian stocks with paper money at real prices on the National Stock Exchange (NSE). Each round you receive the same market data as every other competitor plus your own portfolio, and you decide what to trade.

Objective: finish the season with the highest total portfolio value (cash plus positions at market prices). The season runs from ${p.seasonStart} to ${p.seasonEnd} (${p.seasonTradingDays} trading days). Every competitor started with ${paiseToDecimal(BigInt(arena.startingCashPaise))} INR.

Rules. They are enforced by code; an action that breaks one is rejected, and the rejection is published.
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

${schedule} Your strategy, reasoning, actions and note to self are published ${arena.season.publicDelayMinutes} minutes after each round.

Explain your trading so viewers can follow it. In "strategy", describe your approach: the setups you look for, how you size positions and when you exit. For every action, "why" gives the signal you are acting on and what you expect to happen, and "exit_plan" says ${exit}. An exit plan is not an order: the engine never acts on it${intraday ? ', so close a position yourself in a later round or it is closed at the square-off' : ''}.

Reply with only a JSON object, with no markdown and no other text:
{"strategy": "<your trading approach, up to 600 characters>",
 "reasoning": "<your analysis of the market this round, up to 1200 characters>",
 "actions": [{"side": "BUY" or "SELL", "symbol": "<symbol>", "quantity": <integer>, "why": "<the signal and what you expect, up to 400 characters>", "exit_plan": "<${exit}; up to 200 characters>"}],
 "note_to_self": "<up to 500 characters; you will see it next round>"}`;
}

/** Signed percentage with two decimals, no % sign: 1.25, -0.40, 0.00. */
export function pct2(fraction: number): string {
  const v = Math.round(fraction * 10000) / 100;
  return (Object.is(v, -0) ? 0 : v).toFixed(2);
}

export interface MarketRow {
  symbol: string;
  ltpPaise: bigint;
  prevClosePaise: bigint;
  openPaise: bigint | null;
  highPaise: bigint | null;
  lowPaise: bigint | null;
  volume: bigint | null;
  avgVol20d: bigint | null;
  ret5d: number | null;
  ret20d: number | null;
  sma20Paise: bigint | null;
  sma50Paise: bigint | null;
  rsi14: number | null;
}

export interface MarketBlockParams {
  snapshotTimeIst: string; // HH:mm
  niftyX100: bigint;
  niftyPrevCloseX100: bigint;
  vixX100: bigint | null;
  rows: MarketRow[];
  noPrice: { symbol: string; reason: string }[];
}

const d = (p: bigint | null) => (p === null ? '' : paiseToDecimal(p));
const n = (v: bigint | null) => (v === null ? '' : v.toString());
const f = (v: number | null) => (v === null ? '' : pct2(v));

export function renderMarketBlock(m: MarketBlockParams): string {
  const chg = Number(m.niftyX100 - m.niftyPrevCloseX100) / Number(m.niftyPrevCloseX100);
  const vix = m.vixX100 === null ? '' : `, India VIX: ${paiseToDecimal(m.vixX100)}`;
  const rows = [...m.rows]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((r) =>
      [
        r.symbol,
        d(r.ltpPaise),
        pct2(Number(r.ltpPaise - r.prevClosePaise) / Number(r.prevClosePaise)),
        d(r.openPaise),
        d(r.highPaise),
        d(r.lowPaise),
        d(r.prevClosePaise),
        n(r.volume),
        n(r.avgVol20d),
        f(r.ret5d),
        f(r.ret20d),
        d(r.sma20Paise),
        d(r.sma50Paise),
        r.rsi14 === null ? '' : r.rsi14.toFixed(2),
      ].join(','),
    );
  const noPrice = m.noPrice.length
    ? m.noPrice.map((x) => `${x.symbol} (${x.reason})`).join(', ')
    : 'none';
  return [
    `MARKET at ${m.snapshotTimeIst} IST (NSE, prices in INR)`,
    `NIFTY 50: ${paiseToDecimal(m.niftyX100)} (${pct2(chg)}% today)${vix}`,
    'Columns: symbol,ltp,chg_pct,open,high,low,prev_close,vol_today,avg_vol_20d,ret_5d_pct,ret_20d_pct,sma20,sma50,rsi14',
    '(sma20, sma50 and rsi14 are daily values as of the previous close)',
    ...rows,
    `NO_PRICE this round: ${noPrice}`,
  ].join('\n');
}

export interface HoldingRow {
  symbol: string;
  quantity: number;
  avgCostPaise: bigint;
  lastPricePaise: bigint;
}

/** One position (or part of one) closed today, for "YOUR DAY SO FAR". */
export interface ClosedTrade {
  symbol: string;
  direction: 'long' | 'short';
  quantity: number;
  exitPricePaise: bigint;
  /** (exit − entry) × qty for a long, (entry − exit) × qty for a short; costs not deducted. */
  gainBeforeCostsPaise: bigint;
}

/** The participant's own results today (owner, 2026-10-31: "daily scorecard"). */
export interface DayScore {
  dayStartValuePaise: bigint;
  orders: number;
  costsPaise: bigint;
  closed: ClosedTrade[];
}

export interface PrivateBlockParams {
  round: number;
  roundsToday: number;
  weekday: string;
  date: string;
  time: string;
  seasonDay: number;
  seasonDays: number;
  nextRound: string;
  cashPaise: bigint;
  startingCashPaise: bigint;
  holdings: HoldingRow[];
  history: string[];
  noteToSelf: string | null;
  /** Intraday product: the square-off time, shown on the first line, and signed positions. */
  squareOffAt?: string | null;
  maxGrossExposurePct?: number;
  /** Shown as "YOUR DAY SO FAR" when given. */
  day?: DayScore | null;
}

function renderDay(day: DayScore, totalPaise: bigint): string[] {
  const change = totalPaise - day.dayStartValuePaise;
  const changePct =
    day.dayStartValuePaise > 0n ? Number(change) / Number(day.dayStartValuePaise) : 0;
  return [
    'YOUR DAY SO FAR',
    `Value at today's open: ${paiseToDecimal(day.dayStartValuePaise)} INR. Change today: ${paiseToDecimal(change)} INR (${pct2(changePct)}%), costs included.`,
    `Orders filled today: ${day.orders}. Costs paid today: ${paiseToDecimal(day.costsPaise)} INR.`,
    day.closed.length
      ? [
          'Positions closed today (symbol, long_or_short, qty, exit_price, gain_before_costs):',
          ...day.closed.map((c) =>
            [
              c.symbol,
              c.direction,
              c.quantity,
              paiseToDecimal(c.exitPricePaise),
              paiseToDecimal(c.gainBeforeCostsPaise),
            ].join(', '),
          ),
        ].join('\n')
      : 'Positions closed today: none',
  ];
}

export function renderPrivateBlock(p: PrivateBlockParams): string {
  let hv = 0n;
  let exposure = 0n;
  for (const h of p.holdings) {
    hv += BigInt(h.quantity) * h.lastPricePaise;
    exposure += BigInt(Math.abs(h.quantity)) * h.lastPricePaise;
  }
  const total = p.cashPaise + hv;
  const intraday = p.squareOffAt !== undefined && p.squareOffAt !== null;
  const ret = Number(total - p.startingCashPaise) / Number(p.startingCashPaise);
  const rows = [...p.holdings]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((h) => {
      const value = BigInt(h.quantity) * h.lastPricePaise;
      const weight = total > 0n ? Number(value) / Number(total) : 0;
      const pnl = (h.lastPricePaise - h.avgCostPaise) * BigInt(h.quantity);
      return [
        h.symbol,
        h.quantity,
        paiseToDecimal(h.avgCostPaise),
        paiseToDecimal(h.lastPricePaise),
        paiseToDecimal(value),
        pct2(weight),
        paiseToDecimal(pnl),
      ].join(', ');
    });
  const header = `ROUND ${p.round} of ${p.roundsToday} today, ${p.weekday} ${p.date}, ${p.time} IST. Season day ${p.seasonDay} of ${p.seasonDays}. Next round: ${p.nextRound}.`;
  const portfolio = intraday
    ? [
        `Cash: ${paiseToDecimal(p.cashPaise)} INR`,
        `Positions value (longs minus shorts): ${paiseToDecimal(hv)} INR`,
        `Total value: ${paiseToDecimal(total)} INR (${pct2(ret)}% since season start)`,
        `Exposure (longs plus shorts): ${paiseToDecimal(exposure)} INR (${pct2(total > 0n ? Number(exposure) / Number(total) : 0)}% of total value; limit ${p.maxGrossExposurePct ?? 100}%)`,
        'Positions (symbol, qty, avg_price, last_price, value, weight_pct, unrealized_pnl; a negative qty is a short):',
      ]
    : [
        `Cash: ${paiseToDecimal(p.cashPaise)} INR`,
        `Holdings value: ${paiseToDecimal(hv)} INR`,
        `Total value: ${paiseToDecimal(total)} INR (${pct2(ret)}% since season start)`,
        'Holdings (symbol, qty, avg_price, last_price, value, weight_pct, unrealized_pnl):',
      ];
  return [
    intraday ? `${header} Square-off: ${p.squareOffAt} IST today.` : header,
    '',
    'YOUR PORTFOLIO',
    ...portfolio,
    rows.length ? rows.join('\n') : 'none',
    '',
    ...(p.day ? [...renderDay(p.day, total), ''] : []),
    'YOUR LAST 5 ROUNDS (newest first)',
    p.history.length ? p.history.slice(0, 5).join('\n') : 'none',
    '',
    'YOUR NOTE TO SELF FROM LAST ROUND',
    p.noteToSelf && p.noteToSelf.trim() ? p.noteToSelf : 'none',
  ].join('\n');
}

export function renderUserMessage(privateBlock: string, marketBlock: string): string {
  return `${privateBlock}\n\n${marketBlock}`;
}

export interface HistoryAction {
  side: string | null;
  symbol: string | null;
  quantity: number | null;
  status: 'executed' | 'rejected';
  pricePaise: bigint | null;
  rejectDetail: string | null;
  sideRaw: string | null;
  symbolRaw: string | null;
}

/** One line of "YOUR LAST 5 ROUNDS". */
export function historyLine(
  when: string,
  decisionStatusText: string | null,
  actions: HistoryAction[],
): string {
  if (decisionStatusText) return `${when}: ${decisionStatusText}`;
  if (!actions.length) return `${when}: no actions`;
  const parts = actions.map((a) => {
    const what = `${a.side ?? a.sideRaw ?? '?'} ${a.quantity ?? '?'} ${a.symbol ?? a.symbolRaw ?? '?'}`;
    return a.status === 'executed'
      ? `${what} filled at ${a.pricePaise === null ? '?' : paiseToDecimal(a.pricePaise)}`
      : `${what} rejected: ${a.rejectDetail ?? 'invalid'}`;
  });
  return `${when}: ${parts.join(' | ')}`;
}
