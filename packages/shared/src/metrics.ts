/** Metrics derived from marks and the ledger (SPEC §11.8). Floats only for ratios. */

export interface MarkPoint {
  at: Date;
  totalPaise: bigint;
  kind: 'round' | 'eod';
  tradingDate: string;
}

export function totalReturn(totalPaise: bigint, startingCashPaise: bigint): number {
  return Number(totalPaise - startingCashPaise) / Number(startingCashPaise);
}

/** Latest mark ÷ previous day-end mark − 1. Null without a previous day-end mark. */
export function todayReturn(marks: MarkPoint[], today: string): number | null {
  const latest = marks.at(-1);
  const prevEod = [...marks].reverse().find((m) => m.kind === 'eod' && m.tradingDate < today);
  if (!latest || !prevEod || prevEod.totalPaise === 0n) return null;
  return Number(latest.totalPaise - prevEod.totalPaise) / Number(prevEod.totalPaise);
}

/** Largest peak-to-trough fall as a non-positive fraction (0 if it never fell). */
export function maxDrawdown(totals: bigint[]): number {
  let peak: bigint | null = null;
  let worst = 0;
  for (const t of totals) {
    if (peak === null || t > peak) peak = t;
    if (peak > 0n) {
      const dd = Number(t - peak) / Number(peak);
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

export interface TradeRecord {
  side: 'BUY' | 'SELL';
  grossPaise: bigint;
  chargesTotalPaise: bigint;
  realizedPnlPaise: bigint | null;
}

export interface TradeStats {
  trades: number;
  turnoverPaise: bigint;
  chargesPaise: bigint;
  /** Share of closing fills with positive realised P&L; null until 5 closes. */
  winRate: number | null;
  /** Closing fills: a SELL of a long, or a BUY that covers a short (they carry realised P&L). */
  closes: number;
}

export function tradeStats(trades: TradeRecord[], minCloses = 5): TradeStats {
  let turnover = 0n;
  let charges = 0n;
  let closes = 0;
  let wins = 0;
  for (const t of trades) {
    turnover += t.grossPaise;
    charges += t.chargesTotalPaise;
    if (t.realizedPnlPaise !== null) {
      closes++;
      if (t.realizedPnlPaise > 0n) wins++;
    }
  }
  return {
    trades: trades.length,
    turnoverPaise: turnover,
    chargesPaise: charges,
    closes,
    winRate: closes >= minCloses ? wins / closes : null,
  };
}

export interface DecisionCounts {
  ok: number;
  invalid: number;
  roundsHeld: number;
  executed: number;
  modelFaultRejections: number;
}

/** Clean answers = OK ÷ (OK + INVALID_RESPONSE). */
export function cleanAnswers(c: DecisionCounts): number | null {
  const d = c.ok + c.invalid;
  return d === 0 ? null : c.ok / d;
}

/** Uptime = rounds with a model answer (OK or invalid) ÷ rounds held. */
export function uptime(c: DecisionCounts): number | null {
  return c.roundsHeld === 0 ? null : (c.ok + c.invalid) / c.roundsHeld;
}

/** Accepted actions = executed ÷ (executed + model-fault rejections). */
export function acceptedActions(c: DecisionCounts): number | null {
  const d = c.executed + c.modelFaultRejections;
  return d === 0 ? null : c.executed / d;
}

/** Daily returns from day-end totals (oldest first), starting from the starting cash. */
export function dailyReturns(startingCashPaise: bigint, eodTotals: bigint[]): number[] {
  const out: number[] = [];
  let prev = startingCashPaise;
  for (const t of eodTotals) {
    out.push(Number(t - prev) / Number(prev));
    prev = t;
  }
  return out;
}

/** Annualised Sharpe (√252, risk-free 0). Null before `minDays` trading days or with zero variance. */
export function sharpe(returns: number[], minDays = 10): number | null {
  if (returns.length < minDays) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-12)) return null; // zero variance (allowing for float noise)
  return (mean / sd) * Math.sqrt(252);
}
