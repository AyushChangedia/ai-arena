/** Database access for seasons, participants and portfolios (engine_rw). */
import type { Queryable } from '@arena/db';
import type { PortfolioState } from '../core/portfolio';

export interface SeasonRow {
  id: string;
  name: string;
  mode: 'shadow' | 'live';
  starts_on: string;
  ends_on: string | null;
  trading_days: number;
  starting_cash_paise: bigint;
  status: 'scheduled' | 'active' | 'finished';
  index_at_start_x100: bigint | null;
  system_prompt: string | null;
}

export interface ParticipantRow {
  id: string;
  season_id: string;
  kind: 'model' | 'index' | 'monkey';
  slot: string;
  display_name: string;
  short_code: string;
  color: string;
  openrouter_model_id: string | null;
  model_config: Record<string, unknown>;
  status: 'active' | 'paused_budget' | 'retired';
}

const seasonCols = `id, name, mode, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, trading_days,
  starting_cash_paise, status, index_at_start_x100, system_prompt`;

function toSeason(r: Record<string, unknown>): SeasonRow {
  return {
    ...(r as unknown as SeasonRow),
    starting_cash_paise: BigInt(r.starting_cash_paise as string),
    index_at_start_x100:
      r.index_at_start_x100 === null ? null : BigInt(r.index_at_start_x100 as string),
  };
}

/** The season that should run rounds on `date` for this mode: active, or scheduled and starting on/before date. */
export async function currentSeason(
  db: Queryable,
  mode: 'shadow' | 'live',
  date: string,
): Promise<SeasonRow | null> {
  const r = await db.query(
    `SELECT ${seasonCols} FROM seasons WHERE mode = $1 AND status IN ('scheduled','active') AND starts_on <= $2 ORDER BY starts_on DESC LIMIT 1`,
    [mode, date],
  );
  return r.rows[0] ? toSeason(r.rows[0]) : null;
}

export async function getSeason(db: Queryable, id: string): Promise<SeasonRow | null> {
  const r = await db.query(`SELECT ${seasonCols} FROM seasons WHERE id = $1`, [id]);
  return r.rows[0] ? toSeason(r.rows[0]) : null;
}

export async function participants(db: Queryable, seasonId: string): Promise<ParticipantRow[]> {
  const r = await db.query<ParticipantRow>(
    `SELECT id, season_id, kind, slot, display_name, short_code, color, openrouter_model_id, model_config, status
     FROM participants WHERE season_id = $1 ORDER BY CASE kind WHEN 'model' THEN 0 WHEN 'monkey' THEN 1 ELSE 2 END, slot`,
    [seasonId],
  );
  return r.rows;
}

/** Cash from the latest ledger entry and positions from the positions table. */
export async function loadPortfolio(
  db: Queryable,
  participantId: string,
): Promise<PortfolioState | null> {
  const c = await db.query<{ cash_after_paise: string }>(
    'SELECT cash_after_paise FROM ledger WHERE participant_id = $1 ORDER BY seq DESC LIMIT 1',
    [participantId],
  );
  if (!c.rows[0]) return null;
  const p = await db.query<{ symbol: string; quantity: number; avg_cost_paise: string }>(
    'SELECT symbol, quantity, avg_cost_paise FROM positions WHERE participant_id = $1 AND quantity > 0',
    [participantId],
  );
  return {
    cashPaise: BigInt(c.rows[0].cash_after_paise),
    positions: new Map(
      p.rows.map((r) => [
        r.symbol,
        { quantity: r.quantity, avgCostPaise: BigInt(r.avg_cost_paise) },
      ]),
    ),
  };
}

/** Symbols this participant has sold earlier on this trading date (DP charge once per symbol per day). */
export async function soldToday(
  db: Queryable,
  participantId: string,
  tradingDate: string,
): Promise<Set<string>> {
  const r = await db.query<{ symbol: string }>(
    `SELECT DISTINCT l.symbol FROM ledger l JOIN rounds r ON r.id = l.round_id
     WHERE l.participant_id = $1 AND l.entry_type = 'SELL' AND r.trading_date = $2`,
    [participantId, tradingDate],
  );
  return new Set(r.rows.map((x) => x.symbol));
}

/** Symbols held by anyone in the season (so held stocks that left the index still get quotes). */
export async function heldSymbols(db: Queryable, seasonId: string): Promise<string[]> {
  const r = await db.query<{ symbol: string }>(
    'SELECT DISTINCT p.symbol FROM positions p JOIN participants pa ON pa.id = p.participant_id WHERE pa.season_id = $1 AND p.quantity > 0',
    [seasonId],
  );
  return r.rows.map((x) => x.symbol).sort();
}

export async function activeSuspensions(db: Queryable): Promise<Set<string>> {
  const r = await db.query<{ symbol: string }>(
    'SELECT symbol FROM symbol_flags WHERE cleared_at IS NULL',
  );
  return new Set(r.rows.map((x) => x.symbol));
}

export async function isPaused(db: Queryable): Promise<{ paused: boolean; reason: string | null }> {
  const r = await db.query<{ paused: boolean; paused_reason: string | null }>(
    'SELECT paused, paused_reason FROM arena_state WHERE id = 1',
  );
  return { paused: r.rows[0]?.paused ?? false, reason: r.rows[0]?.paused_reason ?? null };
}

export async function setPaused(
  db: Queryable,
  paused: boolean,
  reason: string | null,
): Promise<void> {
  await db.query(
    'UPDATE arena_state SET paused = $1, paused_reason = $2, updated_at = now() WHERE id = 1',
    [paused, reason],
  );
}

/** Trading dates on which the season has held at least one round, oldest first. */
export async function seasonTradingDates(db: Queryable, seasonId: string): Promise<string[]> {
  const r = await db.query<{ d: string }>(
    "SELECT DISTINCT to_char(trading_date,'YYYY-MM-DD') AS d FROM rounds WHERE season_id = $1 ORDER BY d",
    [seasonId],
  );
  return r.rows.map((x) => x.d);
}
