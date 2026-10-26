/**
 * Drizzle schema mirroring migrations/*.sql (SPEC §14). The SQL migrations are the source of
 * truth; test/schema.int.test.ts proves every table and column here exists in a migrated database.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  time,
  uuid,
  jsonb,
  numeric,
  serial,
  bigserial,
  primaryKey,
} from 'drizzle-orm/pg-core';

const big = (name: string) => bigint(name, { mode: 'bigint' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const seasons = pgTable('seasons', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mode: text('mode').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  tradingDays: integer('trading_days').notNull(),
  startingCashPaise: big('starting_cash_paise').notNull(),
  status: text('status').notNull(),
  indexAtStartX100: big('index_at_start_x100'),
  systemPrompt: text('system_prompt'),
  createdAt: createdAt(),
});

export const participants = pgTable('participants', {
  id: text('id').primaryKey(),
  seasonId: text('season_id').notNull(),
  kind: text('kind').notNull(),
  slot: text('slot').notNull(),
  displayName: text('display_name').notNull(),
  shortCode: text('short_code').notNull(),
  color: text('color').notNull(),
  openrouterModelId: text('openrouter_model_id'),
  modelConfig: jsonb('model_config').notNull(),
  status: text('status').notNull(),
  retiredAt: ts('retired_at'),
  retiredReason: text('retired_reason'),
  createdAt: createdAt(),
});

export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(),
  brokerToken: text('broker_token').notNull(),
  exchange: text('exchange').notNull(),
  name: text('name').notNull(),
  tickSizePaise: integer('tick_size_paise').notNull(),
  refreshedOn: date('refreshed_on').notNull(),
  createdAt: createdAt(),
});

export const universeVersions = pgTable('universe_versions', {
  id: serial('id').primaryKey(),
  effectiveFrom: date('effective_from').notNull(),
  symbols: text('symbols').array().notNull(),
  sourceUrl: text('source_url').notNull(),
  createdAt: createdAt(),
});

export const dailyBars = pgTable(
  'daily_bars',
  {
    symbol: text('symbol').notNull(),
    date: date('date').notNull(),
    openPaise: big('open_paise').notNull(),
    highPaise: big('high_paise').notNull(),
    lowPaise: big('low_paise').notNull(),
    closePaise: big('close_paise').notNull(),
    volume: big('volume').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

export const indicators = pgTable(
  'indicators',
  {
    symbol: text('symbol').notNull(),
    date: date('date').notNull(),
    sma20Paise: big('sma20_paise'),
    sma50Paise: big('sma50_paise'),
    rsi14: numeric('rsi14'),
    avgVol20d: big('avg_vol_20d'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

export const snapshots = pgTable('snapshots', {
  id: uuid('id').primaryKey(),
  purpose: text('purpose').notNull(),
  fetchStartedAt: ts('fetch_started_at').notNull(),
  fetchFinishedAt: ts('fetch_finished_at').notNull(),
  source: text('source').notNull(),
  raw: jsonb('raw').notNull(),
  validCount: integer('valid_count').notNull(),
  invalidCount: integer('invalid_count').notNull(),
  status: text('status').notNull(),
  rejectReason: text('reject_reason'),
  createdAt: createdAt(),
});

export const quotes = pgTable(
  'quotes',
  {
    snapshotId: uuid('snapshot_id').notNull(),
    symbol: text('symbol').notNull(),
    ltpPaise: big('ltp_paise'),
    bidPaise: big('bid_paise'),
    askPaise: big('ask_paise'),
    openPaise: big('open_paise'),
    highPaise: big('high_paise'),
    lowPaise: big('low_paise'),
    prevClosePaise: big('prev_close_paise'),
    volume: big('volume'),
    exchangeTime: ts('exchange_time'),
    valid: boolean('valid').notNull(),
    invalidReason: text('invalid_reason'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.symbol] })],
);

export const indexQuotes = pgTable(
  'index_quotes',
  {
    snapshotId: uuid('snapshot_id').notNull(),
    name: text('name').notNull(),
    valueX100: big('value_x100'),
    prevCloseX100: big('prev_close_x100'),
    exchangeTime: ts('exchange_time'),
    valid: boolean('valid').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.name] })],
);

export const rounds = pgTable('rounds', {
  id: uuid('id').primaryKey(),
  seasonId: text('season_id').notNull(),
  tradingDate: date('trading_date').notNull(),
  slotTime: time('slot_time').notNull(),
  scheduledAt: ts('scheduled_at').notNull(),
  startedAt: ts('started_at').notNull(),
  finishedAt: ts('finished_at'),
  revealAt: ts('reveal_at'),
  status: text('status').notNull(),
  statusReason: text('status_reason'),
  decisionSnapshotId: uuid('decision_snapshot_id'),
  fillSnapshotId: uuid('fill_snapshot_id'),
  marketBlock: text('market_block'),
  trigger: text('trigger').notNull(),
  /** 'trading' or 'square_off' (intraday: closes every open position). */
  kind: text('kind').notNull().default('trading'),
  createdAt: createdAt(),
});

export const decisions = pgTable('decisions', {
  id: uuid('id').primaryKey(),
  roundId: uuid('round_id').notNull(),
  participantId: text('participant_id').notNull(),
  status: text('status').notNull(),
  errorClass: text('error_class'),
  errorDetail: text('error_detail'),
  privateBlock: text('private_block').notNull(),
  promptSha256: text('prompt_sha256').notNull(),
  requestParams: jsonb('request_params').notNull(),
  rawResponse: text('raw_response'),
  parsed: jsonb('parsed'),
  reasoning: text('reasoning'),
  noteToSelf: text('note_to_self'),
  /** The model's stated approach (published). */
  strategy: text('strategy'),
  flags: text('flags').array().notNull(),
  servingModel: text('serving_model'),
  attempts: integer('attempts').notNull(),
  latencyMs: integer('latency_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  costEstimated: boolean('cost_estimated').notNull(),
  rngSeed: text('rng_seed'),
  revealAt: ts('reveal_at'),
  createdAt: createdAt(),
});

export const actions = pgTable('actions', {
  id: uuid('id').primaryKey(),
  decisionId: uuid('decision_id').notNull(),
  position: integer('position').notNull(),
  sideRaw: text('side_raw'),
  symbolRaw: text('symbol_raw'),
  quantityRaw: jsonb('quantity_raw'),
  why: text('why'),
  side: text('side'),
  symbol: text('symbol'),
  quantity: integer('quantity'),
  status: text('status').notNull(),
  rejectCode: text('reject_code'),
  rejectDetail: text('reject_detail'),
  modelFault: boolean('model_fault').notNull(),
  /** The model's stated exit for this action (published, never acted on). */
  exitPlan: text('exit_plan'),
  createdAt: createdAt(),
});

export const ledger = pgTable('ledger', {
  seq: big('seq').primaryKey(),
  id: uuid('id').notNull(),
  seasonId: text('season_id').notNull(),
  participantId: text('participant_id').notNull(),
  roundId: uuid('round_id'),
  actionId: uuid('action_id'),
  entryType: text('entry_type').notNull(),
  symbol: text('symbol'),
  side: text('side'),
  quantity: integer('quantity'),
  pricePaise: big('price_paise'),
  priceSource: text('price_source'),
  snapshotId: uuid('snapshot_id'),
  grossPaise: big('gross_paise').notNull(),
  charges: jsonb('charges').notNull(),
  chargesTotalPaise: big('charges_total_paise').notNull(),
  cashDeltaPaise: big('cash_delta_paise').notNull(),
  cashAfterPaise: big('cash_after_paise').notNull(),
  positionAfter: integer('position_after'),
  avgCostAfterPaise: big('avg_cost_after_paise'),
  realizedPnlPaise: big('realized_pnl_paise'),
  note: text('note'),
  refSeq: big('ref_seq'),
  occurredAt: ts('occurred_at').notNull(),
  revealAt: ts('reveal_at').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  createdAt: createdAt(),
});

export const positions = pgTable(
  'positions',
  {
    participantId: text('participant_id').notNull(),
    symbol: text('symbol').notNull(),
    quantity: integer('quantity').notNull(),
    avgCostPaise: big('avg_cost_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.participantId, t.symbol] })],
);

export const marks = pgTable('marks', {
  id: uuid('id').primaryKey(),
  participantId: text('participant_id').notNull(),
  roundId: uuid('round_id'),
  snapshotId: uuid('snapshot_id').notNull(),
  kind: text('kind').notNull(),
  markedAt: ts('marked_at').notNull(),
  cashPaise: big('cash_paise').notNull(),
  holdingsValuePaise: big('holdings_value_paise').notNull(),
  totalPaise: big('total_paise').notNull(),
  revealAt: ts('reveal_at').notNull(),
  createdAt: createdAt(),
});

export const corporateActions = pgTable('corporate_actions', {
  id: uuid('id').primaryKey(),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(),
  exDate: date('ex_date').notNull(),
  ratioNum: integer('ratio_num'),
  ratioDen: integer('ratio_den'),
  amountPaisePerShare: big('amount_paise_per_share'),
  sourceUrl: text('source_url').notNull(),
  enteredBy: text('entered_by').notNull(),
  appliedAt: ts('applied_at'),
  createdAt: createdAt(),
});

export const symbolFlags = pgTable('symbol_flags', {
  symbol: text('symbol').primaryKey(),
  flag: text('flag').notNull(),
  reason: text('reason').notNull(),
  setAt: ts('set_at').notNull(),
  clearedAt: ts('cleared_at'),
  createdAt: createdAt(),
});

export const incidents = pgTable('incidents', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  publicMessage: text('public_message').notNull(),
  scope: text('scope').notNull(),
  participantId: text('participant_id'),
  startedAt: ts('started_at').notNull(),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
});

export const adminLog = pgTable('admin_log', {
  id: uuid('id').primaryKey(),
  command: text('command').notNull(),
  args: jsonb('args').notNull(),
  reason: text('reason').notNull(),
  actor: text('actor').notNull(),
  at: ts('at').notNull(),
  createdAt: createdAt(),
});

export const arenaState = pgTable('arena_state', {
  id: integer('id').primaryKey(),
  paused: boolean('paused').notNull(),
  pausedReason: text('paused_reason'),
  publishMarketTable: text('publish_market_table').notNull(),
  updatedAt: ts('updated_at').notNull(),
  createdAt: createdAt(),
});

export const dailyJobs = pgTable(
  'daily_jobs',
  {
    date: date('date').notNull(),
    job: text('job').notNull(),
    status: text('status').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    detail: jsonb('detail').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.date, t.job] })],
);

export const heartbeats = pgTable('heartbeats', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  at: ts('at').notNull(),
  outcome: text('outcome').notNull(),
  detail: jsonb('detail').notNull(),
  createdAt: createdAt(),
});

export const anchors = pgTable('anchors', {
  date: date('date').primaryKey(),
  seasonId: text('season_id').notNull(),
  firstSeq: big('first_seq').notNull(),
  lastSeq: big('last_seq').notNull(),
  entries: integer('entries').notNull(),
  headHash: text('head_hash').notNull(),
  commitSha: text('commit_sha'),
  createdAt: createdAt(),
});

export const allTables = {
  seasons,
  participants,
  instruments,
  universe_versions: universeVersions,
  daily_bars: dailyBars,
  indicators,
  snapshots,
  quotes,
  index_quotes: indexQuotes,
  rounds,
  decisions,
  actions,
  ledger,
  positions,
  marks,
  corporate_actions: corporateActions,
  symbol_flags: symbolFlags,
  incidents,
  admin_log: adminLog,
  arena_state: arenaState,
  daily_jobs: dailyJobs,
  heartbeats,
  anchors,
};

export const PUBLIC_VIEWS = [
  'v_seasons',
  'v_participants',
  'v_rounds',
  'v_decisions',
  'v_actions',
  'v_ledger',
  'v_marks',
  'v_holdings',
  'v_incidents',
  'v_status',
  'v_anchors',
  'v_market_tables',
  'v_admin_log',
  'v_symbol_flags',
] as const;
