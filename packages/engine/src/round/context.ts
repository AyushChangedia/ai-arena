/** Builds the shared market block and each participant's private block (SPEC §10.2). */
import { DateTime } from 'luxon';
import type { Queryable } from '@arena/db';
import type { DecisionStatus } from '@arena/shared/codes';
import type { Snapshot } from '../data/snapshot';
import { closeNDaysAgo, returnSince } from '../data/indicators';
import { loadBars } from '../data/market';
import {
  renderMarketBlock,
  renderPrivateBlock,
  historyLine,
  type MarketRow,
  type HoldingRow,
  type HistoryAction,
  type ClosedTrade,
  type DayScore,
} from '../llm/prompt';
import type { PortfolioState } from '../core/portfolio';
import { IST } from './schedule';

interface IndicatorRow {
  sma20Paise: bigint | null;
  sma50Paise: bigint | null;
  rsi14: number | null;
  avgVol20d: bigint | null;
}

async function indicatorsFor(
  db: Queryable | null,
  symbols: string[],
  tradingDate: string,
): Promise<Map<string, IndicatorRow & { ret5: bigint | null; ret20: bigint | null }>> {
  const out = new Map<string, IndicatorRow & { ret5: bigint | null; ret20: bigint | null }>();
  if (!db) return out;
  const r = await db.query(
    `SELECT symbol, sma20_paise, sma50_paise, rsi14, avg_vol_20d FROM indicators WHERE date = $1 AND symbol = ANY($2)`,
    [tradingDate, symbols],
  );
  const ind = new Map(r.rows.map((x) => [x.symbol as string, x]));
  for (const s of symbols) {
    const x = ind.get(s);
    const bars = await loadBars(db, s, tradingDate, 25);
    out.set(s, {
      sma20Paise:
        x?.sma20_paise === null || x?.sma20_paise === undefined ? null : BigInt(x.sma20_paise),
      sma50Paise:
        x?.sma50_paise === null || x?.sma50_paise === undefined ? null : BigInt(x.sma50_paise),
      rsi14: x?.rsi14 === null || x?.rsi14 === undefined ? null : Number(x.rsi14),
      avgVol20d:
        x?.avg_vol_20d === null || x?.avg_vol_20d === undefined ? null : BigInt(x.avg_vol_20d),
      ret5: closeNDaysAgo(bars, 5),
      ret20: closeNDaysAgo(bars, 20),
    });
  }
  return out;
}

export interface MarketBlockResult {
  text: string;
  tradeable: Map<string, bigint>; // valid symbols → decision LTP
  indicatorsMissing: boolean;
}

/** `symbols` is the universe plus any symbol held in the season. */
export async function buildMarketBlock(
  db: Queryable | null,
  snap: Snapshot,
  symbols: string[],
  tradingDate: string,
  indexName: string,
  vixName: string,
): Promise<MarketBlockResult> {
  const valid = snap.quotes.filter((q) => q.valid && symbols.includes(q.symbol));
  const ind = await indicatorsFor(
    db,
    valid.map((q) => q.symbol),
    tradingDate,
  );
  const rows: MarketRow[] = valid.map((q) => {
    const i = ind.get(q.symbol);
    return {
      symbol: q.symbol,
      ltpPaise: q.ltpPaise!,
      prevClosePaise: q.prevClosePaise!,
      openPaise: q.openPaise,
      highPaise: q.highPaise,
      lowPaise: q.lowPaise,
      volume: q.volume,
      avgVol20d: i?.avgVol20d ?? null,
      ret5d: i ? returnSince(q.ltpPaise!, i.ret5) : null,
      ret20d: i ? returnSince(q.ltpPaise!, i.ret20) : null,
      sma20Paise: i?.sma20Paise ?? null,
      sma50Paise: i?.sma50Paise ?? null,
      rsi14: i?.rsi14 ?? null,
    };
  });
  const noPrice = symbols
    .filter((s) => !valid.some((q) => q.symbol === s))
    .map((s) => ({
      symbol: s,
      reason: snap.quotes.find((q) => q.symbol === s)?.invalidReason ?? 'not quoted',
    }));
  const idx = snap.indices.find((x) => x.name === indexName);
  const vix = snap.indices.find((x) => x.name === vixName && x.valid);
  const text = renderMarketBlock({
    snapshotTimeIst: DateTime.fromJSDate(snap.finishedAt, { zone: IST }).toFormat('HH:mm'),
    niftyX100: idx!.valueX100!,
    niftyPrevCloseX100: idx!.prevCloseX100!,
    vixX100: vix?.valueX100 ?? null,
    rows,
    noPrice,
  });
  const indicatorsMissing =
    db !== null && rows.length > 0 && rows.every((r) => r.sma20Paise === null && r.rsi14 === null);
  return { text, tradeable: new Map(valid.map((q) => [q.symbol, q.ltpPaise!])), indicatorsMissing };
}

/** The latest valid LTP stored for a symbol at or before `asOf` (for holdings with no price this round). */
export async function lastValidPrice(
  db: Queryable,
  symbol: string,
  asOf: Date,
): Promise<bigint | null> {
  const r = await db.query<{ ltp_paise: string }>(
    `SELECT q.ltp_paise FROM quotes q JOIN snapshots s ON s.id = q.snapshot_id
     WHERE q.symbol = $1 AND q.valid AND s.fetch_finished_at <= $2 ORDER BY s.fetch_finished_at DESC LIMIT 1`,
    [symbol, asOf],
  );
  return r.rows[0] ? BigInt(r.rows[0].ltp_paise) : null;
}

export async function pricesWithFallback(
  db: Queryable | null,
  snap: Snapshot,
  symbols: string[],
): Promise<Map<string, bigint>> {
  const m = new Map<string, bigint>();
  for (const s of symbols) {
    const q = snap.quotes.find((x) => x.symbol === s && x.valid);
    if (q?.ltpPaise) m.set(s, q.ltpPaise);
    else if (db) {
      const p = await lastValidPrice(db, s, snap.finishedAt); // as of the snapshot, so replay is deterministic
      if (p !== null) m.set(s, p);
    }
  }
  return m;
}

const HISTORY_TEXT: Partial<Record<DecisionStatus, string>> = {
  MISSED_PROVIDER: 'missed (provider timeout)',
  MISSED_CONFIG: 'missed (model unavailable)',
  INVALID_RESPONSE: 'unreadable answer, no trades',
  MODEL_MISMATCH: 'missed (wrong model served)',
  SKIPPED_BUDGET: 'skipped (budget cap reached)',
  SKIPPED_PAUSED: 'skipped (arena paused)',
  NOT_EXECUTED_DATA: 'decided, not executed (market data failed)',
  EXECUTION_FAILED: 'decided, not executed (recording failed)',
  MISSED_ABORTED: 'missed (round aborted)',
};
const ROUND_TEXT: Record<string, string> = {
  SKIPPED_DATA: 'round skipped (market data unavailable)',
  SKIPPED_PAUSED: 'round skipped (arena paused)',
  MISSED_SCHEDULE: 'round missed (scheduler did not run)',
  ABORTED: 'round aborted',
};

/** "YOUR LAST 5 ROUNDS", newest first, excluding the current round. */
export async function historyFor(
  db: Queryable,
  seasonId: string,
  participantId: string,
  currentRoundId: string | null,
): Promise<string[]> {
  const rounds = await db.query(
    `SELECT r.id, to_char(r.trading_date,'YYYY-MM-DD') AS d, to_char(r.slot_time,'HH24:MI') AS t, r.status, d.id AS decision_id, d.status AS dstatus
     FROM rounds r LEFT JOIN decisions d ON d.round_id = r.id AND d.participant_id = $2
     WHERE r.season_id = $1 AND ($3::uuid IS NULL OR r.id <> $3::uuid)
     ORDER BY r.trading_date DESC, r.slot_time DESC LIMIT 5`,
    [seasonId, participantId, currentRoundId],
  );
  const lines: string[] = [];
  for (const r of rounds.rows) {
    const when = `${r.d} ${r.t}`;
    if (!r.decision_id) {
      lines.push(historyLine(when, ROUND_TEXT[r.status] ?? 'no decision recorded', []));
      continue;
    }
    const st = r.dstatus as DecisionStatus;
    if (st !== 'OK' && st !== 'SQUARE_OFF') {
      lines.push(historyLine(when, HISTORY_TEXT[st] ?? st.toLowerCase(), []));
      continue;
    }
    const a = await db.query(
      `SELECT a.side, a.symbol, a.quantity, a.status, a.reject_detail, a.side_raw, a.symbol_raw, l.price_paise
       FROM actions a LEFT JOIN ledger l ON l.action_id = a.id WHERE a.decision_id = $1 ORDER BY a.position`,
      [r.decision_id],
    );
    const acts: HistoryAction[] = a.rows.map((x) => ({
      side: x.side,
      symbol: x.symbol,
      quantity: x.quantity,
      status: x.status,
      rejectDetail: x.reject_detail,
      sideRaw: x.side_raw,
      symbolRaw: x.symbol_raw,
      pricePaise: x.price_paise === null ? null : BigInt(x.price_paise),
    }));
    lines.push(historyLine(st === 'SQUARE_OFF' ? `${when} square-off` : when, null, acts));
  }
  return lines;
}

/**
 * "YOUR DAY SO FAR" (owner, 2026-10-31): the value at today's open (the last day-end mark before
 * today, or the starting cash), today's fills and costs, and the positions closed today with their
 * gain before costs (a closing fill's realised P&L plus that order's charges).
 */
export async function dayScoreFor(
  db: Queryable,
  participantId: string,
  tradingDate: string,
  startingCashPaise: bigint,
): Promise<DayScore> {
  const start = await db.query<{ total_paise: string }>(
    `SELECT total_paise FROM marks
     WHERE participant_id = $1 AND kind = 'eod' AND marked_at < ($2::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
     ORDER BY marked_at DESC LIMIT 1`,
    [participantId, tradingDate],
  );
  const fills = await db.query<{
    side: 'BUY' | 'SELL';
    symbol: string;
    quantity: number;
    price_paise: string;
    position_after: number;
    realized_pnl_paise: string | null;
    charges_total_paise: string;
  }>(
    `SELECT l.side, l.symbol, l.quantity, l.price_paise, l.position_after, l.realized_pnl_paise, l.charges_total_paise
     FROM ledger l JOIN rounds r ON r.id = l.round_id
     WHERE l.participant_id = $1 AND r.trading_date = $2::date AND l.entry_type IN ('BUY','SELL')
     ORDER BY l.seq`,
    [participantId, tradingDate],
  );
  let costs = 0n;
  const closed: ClosedTrade[] = [];
  for (const f of fills.rows) {
    const charges = BigInt(f.charges_total_paise);
    costs += charges;
    if (f.realized_pnl_paise === null) continue;
    const before = f.position_after - (f.side === 'BUY' ? f.quantity : -f.quantity);
    const qty =
      f.side === 'SELL'
        ? Math.min(f.quantity, Math.max(before, 0))
        : Math.min(f.quantity, Math.max(-before, 0));
    closed.push({
      symbol: f.symbol,
      direction: f.side === 'SELL' ? 'long' : 'short',
      quantity: qty,
      exitPricePaise: BigInt(f.price_paise),
      gainBeforeCostsPaise: BigInt(f.realized_pnl_paise) + charges,
    });
  }
  return {
    dayStartValuePaise: start.rows[0] ? BigInt(start.rows[0].total_paise) : startingCashPaise,
    orders: fills.rows.length,
    costsPaise: costs,
    closed,
  };
}

export async function lastNoteToSelf(db: Queryable, participantId: string): Promise<string | null> {
  const r = await db.query<{ note_to_self: string | null }>(
    `SELECT note_to_self FROM decisions WHERE participant_id = $1 AND status = 'OK' ORDER BY created_at DESC LIMIT 1`,
    [participantId],
  );
  return r.rows[0]?.note_to_self ?? null;
}

export interface PrivateBlockInput {
  round: number;
  roundsToday: number;
  tradingDate: string;
  weekday: string;
  slot: string;
  seasonDay: number;
  seasonDays: number;
  nextRound: string;
  startingCashPaise: bigint;
  portfolio: PortfolioState;
  prices: Map<string, bigint>;
  history: string[];
  noteToSelf: string | null;
  /** Intraday product: the square-off time and the exposure limit, for the prompt. */
  squareOffAt?: string | null;
  maxGrossExposurePct?: number;
  day?: DayScore | null;
}

export function buildPrivateBlock(p: PrivateBlockInput): string {
  const holdings: HoldingRow[] = [...p.portfolio.positions.entries()]
    .filter(([, pos]) => pos.quantity !== 0)
    .map(([symbol, pos]) => {
      const last = p.prices.get(symbol);
      // Every position was opened at a recorded fill price, so a price always exists; never guess one.
      if (last === undefined) throw new Error(`no recorded price for held symbol ${symbol}`);
      return {
        symbol,
        quantity: pos.quantity,
        avgCostPaise: pos.avgCostPaise,
        lastPricePaise: last,
      };
    });
  return renderPrivateBlock({
    round: p.round,
    roundsToday: p.roundsToday,
    weekday: p.weekday,
    date: p.tradingDate,
    time: p.slot,
    seasonDay: p.seasonDay,
    seasonDays: p.seasonDays,
    nextRound: p.nextRound,
    cashPaise: p.portfolio.cashPaise,
    startingCashPaise: p.startingCashPaise,
    holdings,
    history: p.history,
    noteToSelf: p.noteToSelf,
    squareOffAt: p.squareOffAt ?? null,
    maxGrossExposurePct: p.maxGrossExposurePct ?? 100,
    day: p.day ?? null,
  });
}
