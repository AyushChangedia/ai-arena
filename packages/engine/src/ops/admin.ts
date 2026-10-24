/** Admin commands (SPEC §18.1). Every command writes admin_log, which /status shows publicly. */
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type pg from 'pg';
import { withTransaction } from '@arena/db';
import { rupeesToPaise } from '@arena/shared/money';
import type { ModelsConfig } from '@arena/shared/schemas';
import { ConfigError } from '@arena/shared/errors';
import type { TradingCalendar } from '../data/calendar';
import { adjustDraft } from '../core/ledger';
import { appendLedger, applyPositions } from '../round/ledger-store';
import { setPaused } from '../round/store';
import { resolveIncident } from './incidents';

export function actor(explicit?: string): string {
  return explicit ?? process.env.GITHUB_ACTOR ?? userInfo().username;
}

export async function adminLog(
  db: pg.Pool | pg.PoolClient,
  command: string,
  args: Record<string, unknown>,
  reason: string,
  who: string,
): Promise<void> {
  await db.query(
    'INSERT INTO admin_log (id, command, args, reason, actor, at) VALUES ($1,$2,$3,$4,$5,now())',
    [randomUUID(), command, JSON.stringify(args), reason, who],
  );
}

function need(v: string | undefined, name: string): string {
  if (!v || !v.trim()) throw new ConfigError(`--${name} is required.`, `Pass --${name} <value>.`);
  return v.trim();
}

export async function pause(db: pg.Pool, reason: string, who: string) {
  await setPaused(db, true, need(reason, 'reason'));
  await adminLog(db, 'pause', {}, reason, who);
  return 'Arena paused.';
}

export async function resume(db: pg.Pool, reason: string, who: string) {
  await setPaused(db, false, null);
  for (const k of ['llm:credits', 'llm:auth', 'reconcile:mismatch']) await resolveIncident(db, k);
  await adminLog(db, 'resume', {}, reason || 'resumed', who);
  return 'Arena resumed.';
}

async function seasonFor(db: pg.Pool, seasonId?: string): Promise<string> {
  if (seasonId) return seasonId;
  const r = await db.query<{ id: string }>(
    "SELECT id FROM seasons WHERE status = 'active' ORDER BY starts_on DESC LIMIT 1",
  );
  if (!r.rows[0]) throw new ConfigError('No active season.', 'Pass --season <id>.');
  return r.rows[0].id;
}

export async function retire(
  db: pg.Pool,
  slot: string,
  reason: string,
  who: string,
  seasonId?: string,
) {
  const sid = await seasonFor(db, seasonId);
  const r = await db.query(
    "UPDATE participants SET status = 'retired', retired_at = now(), retired_reason = $3 WHERE season_id = $1 AND slot = $2 AND kind = 'model' RETURNING id",
    [sid, need(slot, 'slot'), need(reason, 'reason')],
  );
  if (!r.rowCount)
    throw new ConfigError(`No model participant ${slot} in season ${sid}.`, 'Check --slot.');
  await adminLog(db, 'retire', { slot, season: sid }, reason, who);
  return `Retired ${slot} in ${sid}. Its holdings are sold at the next round, then a RETIRE entry closes it.`;
}

export interface CorpActionArgs {
  symbol: string;
  type: 'split' | 'bonus' | 'dividend';
  ratio?: string;
  amount?: string;
  exDate: string;
  source: string;
}

export async function corpAction(db: pg.Pool, a: CorpActionArgs, reason: string, who: string) {
  if (!['split', 'bonus', 'dividend'].includes(a.type))
    throw new ConfigError('--type must be split, bonus or dividend.', 'Fix --type.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.exDate))
    throw new ConfigError('--ex-date must be YYYY-MM-DD.', 'Fix --ex-date.');
  let num: number | null = null;
  let den: number | null = null;
  let amount: bigint | null = null;
  if (a.type === 'dividend') {
    amount = rupeesToPaise(need(a.amount, 'amount'));
    if (amount <= 0n)
      throw new ConfigError('--amount must be positive rupees per share.', 'Fix --amount.');
  } else {
    const m = /^(\d+):(\d+)$/.exec(need(a.ratio, 'ratio'));
    if (!m)
      throw new ConfigError(
        '--ratio must look like 2:1 (new:old for splits; bonus:held for bonuses).',
        'Fix --ratio.',
      );
    num = Number(m[1]);
    den = Number(m[2]);
  }
  const id = randomUUID();
  await db.query(
    'INSERT INTO corporate_actions (id, symbol, type, ex_date, ratio_num, ratio_den, amount_paise_per_share, source_url, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      need(a.symbol, 'symbol').toUpperCase(),
      a.type,
      a.exDate,
      num,
      den,
      amount,
      need(a.source, 'source'),
      who,
    ],
  );
  await adminLog(db, 'corp-action', { ...a }, reason || `${a.type} for ${a.symbol}`, who);
  return `Recorded ${a.type} for ${a.symbol} on ${a.exDate}. It is applied by the pre-market job on the ex-date.`;
}

export async function clearFlag(db: pg.Pool, symbol: string, reason: string, who: string) {
  const r = await db.query(
    'UPDATE symbol_flags SET cleared_at = now() WHERE symbol = $1 AND cleared_at IS NULL',
    [need(symbol, 'symbol').toUpperCase()],
  );
  if (!r.rowCount) throw new ConfigError(`${symbol} has no active flag.`, 'Check --symbol.');
  await resolveIncident(db, `gap:${symbol.toUpperCase()}`);
  await adminLog(db, 'clear-flag', { symbol }, need(reason, 'reason'), who);
  return `Cleared the flag on ${symbol}.`;
}

export async function resolveIncidentById(db: pg.Pool, id: string, note: string, who: string) {
  const r = await db.query(
    'UPDATE incidents SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL',
    [need(id, 'id')],
  );
  if (!r.rowCount) throw new ConfigError(`No open incident ${id}.`, 'Check --id.');
  await adminLog(db, 'resolve-incident', { id }, need(note, 'note'), who);
  return `Resolved incident ${id}.`;
}

export async function startSeason(
  db: pg.Pool,
  a: { id: string; start: string; mode: 'shadow' | 'live'; name?: string },
  models: ModelsConfig | null,
  cal: TradingCalendar,
  startingCashPaise: bigint,
  tradingDays: number,
  reason: string,
  who: string,
) {
  if (a.mode !== 'shadow' && a.mode !== 'live')
    throw new ConfigError('--mode must be shadow or live.', 'Fix --mode.');
  if (!models)
    throw new ConfigError(
      'config/models.json is missing.',
      'Generate it with `pnpm engine roster --tier budget --write` (SETUP.md).',
    );
  if (a.mode === 'live' && !models.approved)
    throw new ConfigError(
      'The roster in config/models.json is not approved; a live season cannot start.',
      'Review the roster, then set "approved": true, "approvedBy" and "approvedOn" in config/models.json (SETUP.md).',
    );
  if (!cal.isTradingDay(a.start))
    throw new ConfigError(
      `${a.start} is not an NSE trading day.`,
      `Use ${cal.nextTradingDay(a.start)}.`,
    );
  const days = cal.tradingDaysFrom(a.start, tradingDays);
  await withTransaction(db, async (tx) => {
    const active = await tx.query(
      "SELECT id FROM seasons WHERE mode = $1 AND status IN ('scheduled','active')",
      [a.mode],
    );
    if (active.rowCount)
      throw new ConfigError(
        `A ${a.mode} season (${active.rows[0].id}) is already scheduled or running.`,
        'Wait for it to finish.',
      );
    await tx.query(
      "INSERT INTO seasons (id, name, mode, starts_on, ends_on, trading_days, starting_cash_paise, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled')",
      [
        a.id,
        a.name ??
          (a.mode === 'shadow' ? `Shadow season ${a.id}` : `Season ${a.id.replace(/^S/, '')}`),
        a.mode,
        a.start,
        days.at(-1),
        tradingDays,
        startingCashPaise,
      ],
    );
    for (const m of models.participants) {
      await tx.query(
        "INSERT INTO participants (id, season_id, kind, slot, display_name, short_code, color, openrouter_model_id, model_config, status) VALUES ($1,$2,'model',$3,$4,$5,$6,$7,$8,'active')",
        [
          `${a.id}-${m.slot}`,
          a.id,
          m.slot,
          m.displayName,
          m.shortCode,
          m.color,
          m.openrouterId,
          JSON.stringify(m),
        ],
      );
    }
    const b = models.benchmarks;
    await tx.query(
      "INSERT INTO participants (id, season_id, kind, slot, display_name, short_code, color, status) VALUES ($1,$2,'index','nifty50',$3,$4,$5,'active')",
      [`${a.id}-nifty50`, a.id, b.index.displayName, b.index.shortCode, b.index.color],
    );
    await tx.query(
      "INSERT INTO participants (id, season_id, kind, slot, display_name, short_code, color, status) VALUES ($1,$2,'monkey','monkey',$3,$4,$5,'active')",
      [`${a.id}-monkey`, a.id, b.monkey.displayName, b.monkey.shortCode, b.monkey.color],
    );
    await adminLog(
      tx,
      'start-season',
      { ...a, ends: days.at(-1) },
      reason || `start ${a.mode} season`,
      who,
    );
  });
  return `Season ${a.id} (${a.mode}) scheduled: ${a.start} to ${days.at(-1)}, ${tradingDays} trading days. SEASON_START entries are written at the first round.`;
}

/** Writes an adjusting CORRECTION entry that references the original (SPEC §11.7). Never edits a row. */
export async function correct(
  db: pg.Pool,
  a: {
    refSeq: string;
    cashDeltaPaise: bigint;
    symbol?: string;
    positionAfter?: number;
    avgCostPaise?: bigint;
  },
  reason: string,
  who: string,
) {
  const note = need(reason, 'reason');
  return withTransaction(db, async (tx) => {
    const ref = await tx.query('SELECT season_id, participant_id FROM ledger WHERE seq = $1', [
      a.refSeq,
    ]);
    if (!ref.rows[0])
      throw new ConfigError(`No ledger entry with seq ${a.refSeq}.`, 'Check --ref-seq.');
    const { season_id, participant_id } = ref.rows[0];
    const last = await tx.query<{ c: string }>(
      'SELECT cash_after_paise AS c FROM ledger WHERE participant_id = $1 ORDER BY seq DESC LIMIT 1',
      [participant_id],
    );
    const cashAfter = BigInt(last.rows[0]!.c) + a.cashDeltaPaise;
    if (cashAfter < 0n)
      throw new ConfigError('This correction would make cash negative.', 'Check --cash-delta.');
    const now = new Date();
    const entries = await appendLedger(tx, [
      adjustDraft(
        {
          id: randomUUID(),
          seasonId: season_id,
          participantId: participant_id,
          roundId: null,
          occurredAt: now,
          revealAt: now,
        },
        {
          type: 'CORRECTION',
          symbol: a.symbol ?? null,
          quantityDelta: null,
          grossPaise: 0n,
          cashDeltaPaise: a.cashDeltaPaise,
          cashAfterPaise: cashAfter,
          positionAfter: a.positionAfter ?? null,
          avgCostAfterPaise: a.avgCostPaise ?? null,
          note,
          refSeq: BigInt(a.refSeq),
        },
      ),
    ]);
    await applyPositions(tx, entries);
    await adminLog(
      tx,
      'correct',
      {
        refSeq: a.refSeq,
        cashDeltaPaise: a.cashDeltaPaise.toString(),
        symbol: a.symbol,
        positionAfter: a.positionAfter,
      },
      note,
      who,
    );
    return `Wrote correction seq ${entries[0]!.seq} referencing seq ${a.refSeq}.`;
  });
}
