/**
 * Typed read queries for the web app. They read ONLY the public v_* views (SPEC §15), through any
 * executor: `pg` locally and in tests, the Neon serverless driver in production.
 */
import { cleanModelName } from '@arena/shared/format';

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const big = (v: unknown): bigint => BigInt(v as string);
const bigOrNull = (v: unknown): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as string);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface Season {
  id: string;
  name: string;
  mode: 'shadow' | 'live';
  startsOn: string;
  endsOn: string | null;
  tradingDays: number;
  startingCashPaise: bigint;
  status: 'scheduled' | 'active' | 'finished';
  indexAtStartX100: bigint | null;
  systemPrompt: string | null;
}

const seasonSql = `SELECT id, name, mode, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, trading_days,
  starting_cash_paise::text, status, index_at_start_x100::text, system_prompt FROM v_seasons`;
function toSeason(r: Record<string, unknown>): Season {
  return {
    id: r.id as string,
    name: r.name as string,
    mode: r.mode as Season['mode'],
    startsOn: r.starts_on as string,
    endsOn: (r.ends_on as string) ?? null,
    tradingDays: Number(r.trading_days),
    startingCashPaise: big(r.starting_cash_paise),
    status: r.status as Season['status'],
    indexAtStartX100: bigOrNull(r.index_at_start_x100),
    systemPrompt: (r.system_prompt as string) ?? null,
  };
}

/** The season the site shows for a mode: the newest by start date. */
export async function getSiteSeason(sql: Sql, mode: 'shadow' | 'live'): Promise<Season | null> {
  const r = await sql.query(`${seasonSql} WHERE mode = $1 ORDER BY starts_on DESC LIMIT 1`, [mode]);
  return r[0] ? toSeason(r[0]) : null;
}

export async function getSeasonById(sql: Sql, id: string): Promise<Season | null> {
  const r = await sql.query(`${seasonSql} WHERE id = $1`, [id]);
  return r[0] ? toSeason(r[0]) : null;
}

export async function listSeasons(sql: Sql, mode: 'shadow' | 'live'): Promise<Season[]> {
  return (await sql.query(`${seasonSql} WHERE mode = $1 ORDER BY starts_on DESC`, [mode])).map(
    toSeason,
  );
}

export interface Participant {
  id: string;
  seasonId: string;
  kind: 'model' | 'index' | 'monkey';
  slot: string;
  displayName: string;
  shortCode: string;
  color: string;
  modelId: string | null;
  status: 'active' | 'paused_budget' | 'retired';
  retiredAt: Date | null;
  retiredReason: string | null;
}

export async function getParticipants(sql: Sql, seasonId: string): Promise<Participant[]> {
  const r = await sql.query(
    `SELECT id, season_id, kind, slot, display_name, short_code, color, openrouter_model_id, status, retired_at, retired_reason FROM v_participants WHERE season_id = $1
     ORDER BY CASE kind WHEN 'model' THEN 0 WHEN 'monkey' THEN 1 ELSE 2 END, slot`,
    [seasonId],
  );
  return r.map((x) => ({
    id: x.id as string,
    seasonId: x.season_id as string,
    kind: x.kind as Participant['kind'],
    slot: x.slot as string,
    displayName: cleanModelName(x.display_name as string),
    shortCode: x.short_code as string,
    color: x.color as string,
    modelId: (x.openrouter_model_id as string) ?? null,
    status: x.status as Participant['status'],
    retiredAt: dateOrNull(x.retired_at),
    retiredReason: (x.retired_reason as string) ?? null,
  }));
}

export interface MarkRow {
  participantId: string;
  roundId: string | null;
  kind: 'round' | 'eod';
  markedAt: Date;
  cashPaise: bigint;
  holdingsValuePaise: bigint;
  totalPaise: bigint;
}

export async function getMarks(sql: Sql, seasonId: string): Promise<MarkRow[]> {
  const r = await sql.query(
    `SELECT m.participant_id, m.round_id, m.kind, m.marked_at, m.cash_paise::text, m.holdings_value_paise::text, m.total_paise::text
     FROM v_marks m JOIN v_participants p ON p.id = m.participant_id WHERE p.season_id = $1 ORDER BY m.marked_at, m.participant_id`,
    [seasonId],
  );
  return r.map((x) => ({
    participantId: x.participant_id as string,
    roundId: (x.round_id as string) ?? null,
    kind: x.kind as MarkRow['kind'],
    markedAt: date(x.marked_at),
    cashPaise: big(x.cash_paise),
    holdingsValuePaise: big(x.holdings_value_paise),
    totalPaise: big(x.total_paise),
  }));
}

export interface StatusRow {
  paused: boolean;
  pausedReason: string | null;
  stateUpdatedAt: Date;
  lastCompletedRoundAt: Date | null;
  lastRevealedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastHeartbeatOutcome: string | null;
  lastSnapshotStatus: string | null;
  lastSnapshotAt: Date | null;
  lastSnapshotRejectReason: string | null;
}

export async function getStatus(sql: Sql): Promise<StatusRow | null> {
  const r = await sql.query('SELECT * FROM v_status');
  const x = r[0];
  if (!x) return null;
  return {
    paused: Boolean(x.paused),
    pausedReason: (x.paused_reason as string) ?? null,
    stateUpdatedAt: date(x.state_updated_at),
    lastCompletedRoundAt: dateOrNull(x.last_completed_round_at),
    lastRevealedAt: dateOrNull(x.last_revealed_at),
    lastHeartbeatAt: dateOrNull(x.last_heartbeat_at),
    lastHeartbeatOutcome: (x.last_heartbeat_outcome as string) ?? null,
    lastSnapshotStatus: (x.last_snapshot_status as string) ?? null,
    lastSnapshotAt: dateOrNull(x.last_snapshot_at),
    lastSnapshotRejectReason: (x.last_snapshot_reject_reason as string) ?? null,
  };
}

export interface RoundRow {
  id: string;
  seasonId: string;
  tradingDate: string;
  slotTime: string;
  scheduledAt: Date;
  startedAt: Date;
  finishedAt: Date | null;
  revealAt: Date | null;
  status: string;
  statusReason: string | null;
  decisionSnapshotAt: Date | null;
  fillSnapshotAt: Date | null;
}

const roundSql = `SELECT id, season_id, to_char(trading_date,'YYYY-MM-DD') AS trading_date, to_char(slot_time,'HH24:MI') AS slot_time, scheduled_at, started_at,
  finished_at, reveal_at, status, status_reason, decision_snapshot_at, fill_snapshot_at FROM v_rounds`;
function toRound(x: Record<string, unknown>): RoundRow {
  return {
    id: x.id as string,
    seasonId: x.season_id as string,
    tradingDate: x.trading_date as string,
    slotTime: x.slot_time as string,
    scheduledAt: date(x.scheduled_at),
    startedAt: date(x.started_at),
    finishedAt: dateOrNull(x.finished_at),
    revealAt: dateOrNull(x.reveal_at),
    status: x.status as string,
    statusReason: (x.status_reason as string) ?? null,
    decisionSnapshotAt: dateOrNull(x.decision_snapshot_at),
    fillSnapshotAt: dateOrNull(x.fill_snapshot_at),
  };
}

export async function getRounds(sql: Sql, seasonId: string): Promise<RoundRow[]> {
  return (
    await sql.query(`${roundSql} WHERE season_id = $1 ORDER BY trading_date DESC, slot_time DESC`, [
      seasonId,
    ])
  ).map(toRound);
}

export async function getRound(sql: Sql, id: string): Promise<RoundRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await sql.query(`${roundSql} WHERE id = $1`, [id]);
  return r[0] ? toRound(r[0]) : null;
}

/** The latest revealed round that held decisions (completed or partial). */
export async function getLatestDecisionRound(sql: Sql, seasonId: string): Promise<RoundRow | null> {
  const r = await sql.query(
    `${roundSql} WHERE season_id = $1 AND status IN ('COMPLETED','PARTIAL','ABORTED') ORDER BY trading_date DESC, slot_time DESC LIMIT 1`,
    [seasonId],
  );
  return r[0] ? toRound(r[0]) : null;
}

export interface ActionRow {
  id: string;
  decisionId: string;
  roundId: string;
  participantId: string;
  position: number;
  sideRaw: string | null;
  symbolRaw: string | null;
  quantityRaw: unknown;
  why: string | null;
  side: string | null;
  symbol: string | null;
  quantity: number | null;
  status: 'executed' | 'rejected';
  rejectCode: string | null;
  rejectDetail: string | null;
  modelFault: boolean;
  ledgerSeq: string | null;
  pricePaise: bigint | null;
  priceSource: string | null;
  chargesTotalPaise: bigint | null;
}

function toAction(x: Record<string, unknown>): ActionRow {
  return {
    id: x.id as string,
    decisionId: x.decision_id as string,
    roundId: x.round_id as string,
    participantId: x.participant_id as string,
    position: Number(x.position),
    sideRaw: (x.side_raw as string) ?? null,
    symbolRaw: (x.symbol_raw as string) ?? null,
    quantityRaw: x.quantity_raw ?? null,
    why: (x.why as string) ?? null,
    side: (x.side as string) ?? null,
    symbol: (x.symbol as string) ?? null,
    quantity: num(x.quantity),
    status: x.status as ActionRow['status'],
    rejectCode: (x.reject_code as string) ?? null,
    rejectDetail: (x.reject_detail as string) ?? null,
    modelFault: Boolean(x.model_fault),
    ledgerSeq: x.ledger_seq === null || x.ledger_seq === undefined ? null : String(x.ledger_seq),
    pricePaise: bigOrNull(x.price_paise),
    priceSource: (x.price_source as string) ?? null,
    chargesTotalPaise: bigOrNull(x.charges_total_paise),
  };
}
const actionSql = `SELECT id, decision_id, round_id, participant_id, position, side_raw, symbol_raw, quantity_raw, why, side, symbol, quantity, status, reject_code,
  reject_detail, model_fault, ledger_seq::text, price_paise::text, price_source, charges_total_paise::text FROM v_actions`;

export interface DecisionRow {
  id: string;
  roundId: string;
  participantId: string;
  status: string;
  errorClass: string | null;
  privateBlock: string;
  promptSha256: string;
  answerText: string | null;
  reasoning: string | null;
  noteToSelf: string | null;
  flags: string[];
  servingModel: string | null;
  attempts: number;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  rngSeed: string | null;
  actions: ActionRow[];
}

const decisionSql = `SELECT id, round_id, participant_id, status, error_class, private_block, prompt_sha256, answer_text, reasoning, note_to_self, flags,
  serving_model, attempts, latency_ms, input_tokens, output_tokens, reasoning_tokens, cost_usd::text, cost_estimated, rng_seed FROM v_decisions`;
async function withActions(sql: Sql, rows: Record<string, unknown>[]): Promise<DecisionRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);
  const acts = (
    await sql.query(`${actionSql} WHERE decision_id = ANY($1::uuid[]) ORDER BY position`, [ids])
  ).map(toAction);
  return rows.map((x) => ({
    id: x.id as string,
    roundId: x.round_id as string,
    participantId: x.participant_id as string,
    status: x.status as string,
    errorClass: (x.error_class as string) ?? null,
    privateBlock: (x.private_block as string) ?? '',
    promptSha256: (x.prompt_sha256 as string) ?? '',
    answerText: (x.answer_text as string) ?? null,
    reasoning: (x.reasoning as string) ?? null,
    noteToSelf: (x.note_to_self as string) ?? null,
    flags: (x.flags as string[]) ?? [],
    servingModel: (x.serving_model as string) ?? null,
    attempts: Number(x.attempts ?? 0),
    latencyMs: num(x.latency_ms),
    inputTokens: num(x.input_tokens),
    outputTokens: num(x.output_tokens),
    reasoningTokens: num(x.reasoning_tokens),
    costUsd: num(x.cost_usd),
    costEstimated: Boolean(x.cost_estimated),
    rngSeed: (x.rng_seed as string) ?? null,
    actions: acts.filter((a) => a.decisionId === x.id),
  }));
}

export async function getRoundDecisions(sql: Sql, roundId: string): Promise<DecisionRow[]> {
  return withActions(sql, await sql.query(`${decisionSql} WHERE round_id = $1`, [roundId]));
}

export async function getParticipantDecisions(
  sql: Sql,
  participantId: string,
  limit = 60,
): Promise<(DecisionRow & { tradingDate: string; slotTime: string })[]> {
  const rows = await sql.query(
    `SELECT d.*, to_char(r.trading_date,'YYYY-MM-DD') AS trading_date, to_char(r.slot_time,'HH24:MI') AS slot_time FROM (${decisionSql}) d
     JOIN v_rounds r ON r.id = d.round_id WHERE d.participant_id = $1 ORDER BY r.trading_date DESC, r.slot_time DESC LIMIT $2`,
    [participantId, limit],
  );
  const out = await withActions(sql, rows);
  return out.map((d, i) => ({
    ...d,
    tradingDate: rows[i]!.trading_date as string,
    slotTime: rows[i]!.slot_time as string,
  }));
}

export interface Blunder extends ActionRow {
  tradingDate: string;
  slotTime: string;
}

/** The latest model-fault rejections (SPEC §16.3). */
export async function getBlunders(
  sql: Sql,
  seasonId: string,
  limit = 10,
  participantId?: string,
): Promise<Blunder[]> {
  const r = await sql.query(
    `SELECT a.*, to_char(r.trading_date,'YYYY-MM-DD') AS trading_date, to_char(r.slot_time,'HH24:MI') AS slot_time FROM (${actionSql}) a
     JOIN v_rounds r ON r.id = a.round_id
     WHERE r.season_id = $1 AND a.model_fault AND ($3::text IS NULL OR a.participant_id = $3) ORDER BY r.trading_date DESC, r.slot_time DESC, a.position LIMIT $2`,
    [seasonId, limit, participantId ?? null],
  );
  return r.map((x) => ({
    ...toAction(x),
    tradingDate: x.trading_date as string,
    slotTime: x.slot_time as string,
  }));
}

/** Decisions per participant that ended in an unreadable answer (they appear among the blunders too). */
export async function getUnreadable(
  sql: Sql,
  seasonId: string,
  limit = 10,
): Promise<{ participantId: string; tradingDate: string; slotTime: string; roundId: string }[]> {
  const r = await sql.query(
    `SELECT d.participant_id, d.round_id, to_char(r.trading_date,'YYYY-MM-DD') AS trading_date, to_char(r.slot_time,'HH24:MI') AS slot_time FROM v_decisions d
     JOIN v_rounds r ON r.id = d.round_id WHERE r.season_id = $1 AND d.status = 'INVALID_RESPONSE' ORDER BY r.trading_date DESC, r.slot_time DESC LIMIT $2`,
    [seasonId, limit],
  );
  return r.map((x) => ({
    participantId: x.participant_id as string,
    roundId: x.round_id as string,
    tradingDate: x.trading_date as string,
    slotTime: x.slot_time as string,
  }));
}

export interface LedgerRow {
  seq: string;
  id: string;
  seasonId: string;
  participantId: string;
  roundId: string | null;
  actionId: string | null;
  entryType: string;
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  pricePaise: bigint | null;
  priceSource: string | null;
  snapshotId: string | null;
  grossPaise: bigint;
  charges: Record<string, string>;
  chargesTotalPaise: bigint;
  cashDeltaPaise: bigint;
  cashAfterPaise: bigint;
  positionAfter: number | null;
  avgCostAfterPaise: bigint | null;
  realizedPnlPaise: bigint | null;
  note: string | null;
  refSeq: string | null;
  occurredAt: Date;
  revealAt: Date;
  prevHash: string;
  hash: string;
}

const ledgerSql = `SELECT seq::text, id, season_id, participant_id, round_id, action_id, entry_type, symbol, side, quantity, price_paise::text, price_source, snapshot_id,
  gross_paise::text, charges, charges_total_paise::text, cash_delta_paise::text, cash_after_paise::text, position_after, avg_cost_after_paise::text,
  realized_pnl_paise::text, note, ref_seq::text, occurred_at, reveal_at, prev_hash, hash FROM v_ledger`;
function toLedger(x: Record<string, unknown>): LedgerRow {
  return {
    seq: x.seq as string,
    id: x.id as string,
    seasonId: x.season_id as string,
    participantId: x.participant_id as string,
    roundId: (x.round_id as string) ?? null,
    actionId: (x.action_id as string) ?? null,
    entryType: x.entry_type as string,
    symbol: (x.symbol as string) ?? null,
    side: (x.side as LedgerRow['side']) ?? null,
    quantity: num(x.quantity),
    pricePaise: bigOrNull(x.price_paise),
    priceSource: (x.price_source as string) ?? null,
    snapshotId: (x.snapshot_id as string) ?? null,
    grossPaise: big(x.gross_paise),
    charges: (x.charges as Record<string, string>) ?? {},
    chargesTotalPaise: big(x.charges_total_paise),
    cashDeltaPaise: big(x.cash_delta_paise),
    cashAfterPaise: big(x.cash_after_paise),
    positionAfter: num(x.position_after),
    avgCostAfterPaise: bigOrNull(x.avg_cost_after_paise),
    realizedPnlPaise: bigOrNull(x.realized_pnl_paise),
    note: (x.note as string) ?? null,
    refSeq: (x.ref_seq as string) ?? null,
    occurredAt: date(x.occurred_at),
    revealAt: date(x.reveal_at),
    prevHash: x.prev_hash as string,
    hash: x.hash as string,
  };
}

export async function getLedgerEntry(sql: Sql, seq: string): Promise<LedgerRow | null> {
  if (!/^\d{1,18}$/.test(seq)) return null;
  const r = await sql.query(`${ledgerSql} WHERE seq = $1`, [seq]);
  return r[0] ? toLedger(r[0]) : null;
}

export async function getNeighbourSeqs(
  sql: Sql,
  seq: string,
): Promise<{ prev: string | null; next: string | null }> {
  const r = await sql.query<{ prev: string | null; next: string | null }>(
    'SELECT (SELECT max(seq)::text FROM v_ledger WHERE seq < $1) AS prev, (SELECT min(seq)::text FROM v_ledger WHERE seq > $1) AS next',
    [seq],
  );
  return r[0] ?? { prev: null, next: null };
}

export async function getParticipantLedger(sql: Sql, participantId: string): Promise<LedgerRow[]> {
  return (
    await sql.query(`${ledgerSql} WHERE participant_id = $1 ORDER BY v_ledger.seq`, [participantId])
  ).map(toLedger);
}

/** Ledger entries that occurred on an IST trading date. */
export async function getLedgerForDate(sql: Sql, isoDate: string): Promise<LedgerRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return [];
  return (
    await sql.query(
      `${ledgerSql} WHERE occurred_at >= ($1::date + time '00:00') AT TIME ZONE 'Asia/Kolkata' AND occurred_at < ($1::date + 1 + time '00:00') AT TIME ZONE 'Asia/Kolkata' ORDER BY v_ledger.seq`,
      [isoDate],
    )
  ).map(toLedger);
}

export async function getLedgerHead(
  sql: Sql,
): Promise<{ seq: string; hash: string; occurredAt: Date } | null> {
  const r = await sql.query<{ seq: string; hash: string; occurred_at: Date }>(
    'SELECT seq::text, hash, occurred_at FROM v_ledger ORDER BY v_ledger.seq DESC LIMIT 1',
  );
  return r[0] ? { seq: r[0].seq, hash: r[0].hash, occurredAt: date(r[0].occurred_at) } : null;
}

export interface HoldingRow {
  participantId: string;
  symbol: string;
  quantity: number;
  avgCostPaise: bigint;
  lastPricePaise: bigint | null;
  pricedAt: Date | null;
  underReview: boolean;
}

export async function getHoldings(sql: Sql, participantIds: string[]): Promise<HoldingRow[]> {
  const r = await sql.query(
    'SELECT participant_id, symbol, quantity, avg_cost_paise::text, last_price_paise::text, priced_at, under_review FROM v_holdings WHERE participant_id = ANY($1::text[]) ORDER BY symbol',
    [participantIds],
  );
  return r.map((x) => ({
    participantId: x.participant_id as string,
    symbol: x.symbol as string,
    quantity: Number(x.quantity),
    avgCostPaise: big(x.avg_cost_paise),
    lastPricePaise: bigOrNull(x.last_price_paise),
    pricedAt: dateOrNull(x.priced_at),
    underReview: Boolean(x.under_review),
  }));
}

export interface IncidentRow {
  id: string;
  severity: string;
  title: string;
  publicMessage: string;
  scope: string;
  participantId: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
}

export async function getIncidents(sql: Sql, limit = 50): Promise<IncidentRow[]> {
  const r = await sql.query(
    'SELECT id, severity, title, public_message, scope, participant_id, started_at, resolved_at FROM v_incidents ORDER BY (resolved_at IS NULL) DESC, started_at DESC LIMIT $1',
    [limit],
  );
  return r.map((x) => ({
    id: x.id as string,
    severity: x.severity as string,
    title: x.title as string,
    publicMessage: x.public_message as string,
    scope: x.scope as string,
    participantId: (x.participant_id as string) ?? null,
    startedAt: date(x.started_at),
    resolvedAt: dateOrNull(x.resolved_at),
  }));
}

export async function getAdminLog(
  sql: Sql,
  limit = 30,
): Promise<{ command: string; reason: string; actor: string; at: Date }[]> {
  const r = await sql.query(
    'SELECT command, reason, actor, at FROM v_admin_log ORDER BY at DESC LIMIT $1',
    [limit],
  );
  return r.map((x) => ({
    command: x.command as string,
    reason: x.reason as string,
    actor: x.actor as string,
    at: date(x.at),
  }));
}

export async function getAnchors(sql: Sql): Promise<
  {
    date: string;
    seasonId: string;
    firstSeq: string;
    lastSeq: string;
    entries: number;
    headHash: string;
    commitSha: string | null;
  }[]
> {
  const r = await sql.query(
    "SELECT to_char(date,'YYYY-MM-DD') AS date, season_id, first_seq::text, last_seq::text, entries, head_hash, commit_sha FROM v_anchors ORDER BY date DESC",
  );
  return r.map((x) => ({
    date: x.date as string,
    seasonId: x.season_id as string,
    firstSeq: x.first_seq as string,
    lastSeq: x.last_seq as string,
    entries: Number(x.entries),
    headHash: x.head_hash as string,
    commitSha: (x.commit_sha as string) ?? null,
  }));
}

export async function getMarketTable(sql: Sql, roundId: string): Promise<string | null> {
  const r = await sql.query<{ market_block: string }>(
    'SELECT market_block FROM v_market_tables WHERE round_id = $1',
    [roundId],
  );
  return r[0]?.market_block ?? null;
}

/** Per-participant decision statuses for the last `n` revealed rounds (status strips). */
export async function getRecentStatuses(
  sql: Sql,
  seasonId: string,
  n = 24,
): Promise<
  {
    roundId: string;
    tradingDate: string;
    slotTime: string;
    roundStatus: string;
    byParticipant: Record<string, string>;
  }[]
> {
  const rounds = await sql.query(
    `SELECT id, to_char(trading_date,'YYYY-MM-DD') AS trading_date, to_char(slot_time,'HH24:MI') AS slot_time, status FROM v_rounds WHERE season_id = $1
     ORDER BY trading_date DESC, slot_time DESC LIMIT $2`,
    [seasonId, n],
  );
  if (!rounds.length) return [];
  const ds = await sql.query<{ round_id: string; participant_id: string; status: string }>(
    'SELECT round_id, participant_id, status FROM v_decisions WHERE round_id = ANY($1::uuid[])',
    [rounds.map((r) => r.id)],
  );
  return rounds.reverse().map((r) => ({
    roundId: r.id as string,
    tradingDate: r.trading_date as string,
    slotTime: r.slot_time as string,
    roundStatus: r.status as string,
    byParticipant: Object.fromEntries(
      ds.filter((d) => d.round_id === r.id).map((d) => [d.participant_id, d.status]),
    ),
  }));
}

export interface ParticipantCounts {
  participantId: string;
  ok: number;
  invalid: number;
  roundsHeld: number;
  executed: number;
  modelFaultRejections: number;
  costUsd: number;
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export async function getParticipantCounts(
  sql: Sql,
  seasonId: string,
): Promise<ParticipantCounts[]> {
  const r = await sql.query(
    `SELECT p.id AS participant_id,
       count(*) FILTER (WHERE d.status = 'OK') AS ok,
       count(*) FILTER (WHERE d.status = 'INVALID_RESPONSE') AS invalid,
       (SELECT count(*) FROM v_rounds r WHERE r.season_id = p.season_id AND r.status IN ('COMPLETED','PARTIAL','ABORTED')) AS rounds_held,
       (SELECT count(*) FROM v_actions a WHERE a.participant_id = p.id AND a.status = 'executed') AS executed,
       (SELECT count(*) FROM v_actions a WHERE a.participant_id = p.id AND a.model_fault) AS fault,
       coalesce(sum(d.cost_usd), 0)::text AS cost, avg(d.latency_ms) AS latency,
       coalesce(sum(d.input_tokens), 0) AS input_tokens, coalesce(sum(d.output_tokens), 0) AS output_tokens
     FROM v_participants p LEFT JOIN v_decisions d ON d.participant_id = p.id
     WHERE p.season_id = $1 GROUP BY p.id, p.season_id`,
    [seasonId],
  );
  return r.map((x) => ({
    participantId: x.participant_id as string,
    ok: Number(x.ok),
    invalid: Number(x.invalid),
    roundsHeld: Number(x.rounds_held),
    executed: Number(x.executed),
    modelFaultRejections: Number(x.fault),
    costUsd: Number(x.cost),
    avgLatencyMs: x.latency === null ? null : Math.round(Number(x.latency)),
    inputTokens: Number(x.input_tokens),
    outputTokens: Number(x.output_tokens),
  }));
}

export async function getTradesForSeason(sql: Sql, seasonId: string): Promise<LedgerRow[]> {
  return (
    await sql.query(
      `${ledgerSql} WHERE season_id = $1 AND entry_type IN ('BUY','SELL') ORDER BY v_ledger.seq`,
      [seasonId],
    )
  ).map(toLedger);
}

export async function getFlags(
  sql: Sql,
): Promise<{ symbol: string; reason: string; setAt: Date }[]> {
  const r = await sql.query(
    'SELECT symbol, reason, set_at FROM v_symbol_flags WHERE cleared_at IS NULL ORDER BY symbol',
  );
  return r.map((x) => ({
    symbol: x.symbol as string,
    reason: x.reason as string,
    setAt: date(x.set_at),
  }));
}
