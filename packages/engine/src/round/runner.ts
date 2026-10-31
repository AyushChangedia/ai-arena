/**
 * Running one round (SPEC §12.3). Each step degrades to a recorded status, never to a fake trade.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@arena/db';
import type { ModelEntry } from '@arena/shared/schemas';
import type { DecisionStatus } from '@arena/shared/codes';
import { DataError, type MarketDataSession } from '../data/provider';
import { snapshotFor, mappingFromDb, freshMapping } from '../data/market';
import { persistSnapshot, type Snapshot } from '../data/snapshot';
import { storeInstruments } from '../data/universe';
import { renderSystemPrompt, renderUserMessage } from '../llm/prompt';
import { decideWithModel, type DecisionRecord } from '../llm/decide';
import { monthSpendUsd, overBudget } from '../llm/budget';
import { executeActions, type ActionOutcome, type ExecutionContext } from '../core/execute';
import { tradeDraft, seasonStartDraft, adjustDraft, type LedgerDraft } from '../core/ledger';
import { markPortfolio, type PortfolioState } from '../core/portfolio';
import { indexBenchmarkValue } from '../core/benchmarks';
import { monkeyDecide } from '../core/monkey';
import { openIncident, resolveIncident } from '../ops/incidents';
import { appendLedger, applyPositions } from './ledger-store';
import {
  buildMarketBlock,
  buildPrivateBlock,
  dayScoreFor,
  historyFor,
  lastNoteToSelf,
  pricesWithFallback,
} from './context';
import {
  slotTimes,
  slotInstant,
  nextRoundText,
  weekdayName,
  istNow,
  minutesOfDay,
  minutesOf,
} from './schedule';
import {
  participants as loadParticipants,
  loadPortfolio,
  soldToday,
  heldSymbols,
  activeSuspensions,
  setPaused,
  seasonTradingDates,
  type SeasonRow,
  type ParticipantRow,
} from './store';
import type { Deps } from './deps';

export interface RoundSummary {
  roundId: string | null;
  slot: string;
  status: string;
  reason: string | null;
  /** Why a round was skipped, in more words (counts and causes, never prices); for the run summary. */
  detail?: string | null;
  participants: {
    slot: string;
    status: DecisionStatus | 'NONE';
    latencyMs: number | null;
    costUsd: number | null;
    actions: string;
  }[];
  incidents: string[];
}

const ms = (min: number) => min * 60_000;

async function incident(d: Deps, s: RoundSummary, i: Parameters<typeof openIncident>[1]) {
  const r = await openIncident(d.db, i, d.now());
  s.incidents.push(`${i.severity}: ${i.title}`);
  if (r.isNew)
    await d.alerts.raise({ key: i.key, severity: i.severity, text: `${i.title}. ${i.detail}` });
}

/** Writes SEASON_START entries for participants that have none, and activates the season (SPEC §12.9). */
export async function ensureSeasonStarted(
  d: Deps,
  season: SeasonRow,
  roundId: string,
  at: Date,
): Promise<SeasonRow> {
  const parts = await loadParticipants(d.db, season.id);
  const revealAt = new Date(at.getTime() + ms(d.arena.season.publicDelayMinutes));
  await withTransaction(d.db, async (tx) => {
    const drafts: LedgerDraft[] = [];
    for (const p of parts.filter((x) => x.kind !== 'index')) {
      const has = await tx.query('SELECT 1 FROM ledger WHERE participant_id = $1 LIMIT 1', [p.id]);
      if (!has.rowCount)
        drafts.push(
          seasonStartDraft(
            {
              id: randomUUID(),
              seasonId: season.id,
              participantId: p.id,
              roundId,
              occurredAt: at,
              revealAt,
            },
            season.starting_cash_paise,
          ),
        );
    }
    await appendLedger(tx, drafts);
    if (season.status === 'scheduled') {
      const days = d.calendar.tradingDaysFrom(season.starts_on, season.trading_days);
      const prompt = renderSystemPrompt(d.arena, d.fees, {
        seasonStart: days[0]!,
        seasonEnd: days.at(-1)!,
        seasonTradingDays: season.trading_days,
        roundTimes: slotTimes(d.arena),
      });
      await tx.query(
        "UPDATE seasons SET status = 'active', ends_on = $2, system_prompt = $3 WHERE id = $1",
        [season.id, days.at(-1), prompt],
      );
      season = { ...season, status: 'active', ends_on: days.at(-1)!, system_prompt: prompt };
    }
  });
  return season;
}

interface Pending {
  participant: ParticipantRow;
  decisionId: string;
  status: DecisionStatus;
  actions: unknown[];
  record: DecisionRecord | null;
}

async function insertDecision(
  db: pg.Pool,
  roundId: string,
  p: ParticipantRow,
  fields: {
    status: DecisionStatus;
    privateBlock?: string;
    rec?: DecisionRecord | null;
    reasoning?: string | null;
    strategy?: string | null;
    note?: string | null;
    flags?: string[];
    seed?: string | null;
    parsed?: unknown;
    errorDetail?: string | null;
    errorClass?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const r = fields.rec;
  await db.query(
    `INSERT INTO decisions (id, round_id, participant_id, status, error_class, error_detail, private_block, prompt_sha256, request_params,
       raw_response, parsed, reasoning, note_to_self, flags, serving_model, attempts, latency_ms, input_tokens, output_tokens, reasoning_tokens,
       cost_usd, cost_estimated, rng_seed, strategy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      id,
      roundId,
      p.id,
      fields.status,
      fields.errorClass ?? r?.errorClass ?? null,
      fields.errorDetail ?? r?.errorDetail ?? null,
      fields.privateBlock ?? '',
      r?.promptSha256 ?? '',
      JSON.stringify(r?.requestParams ?? {}),
      r?.rawResponse ?? null,
      fields.parsed !== undefined
        ? JSON.stringify(fields.parsed)
        : r?.parsed
          ? JSON.stringify(r.parsed)
          : null,
      fields.reasoning ?? r?.decision?.reasoning ?? null,
      fields.note ?? r?.decision?.noteToSelf ?? null,
      fields.flags ?? r?.decision?.flags ?? [],
      r?.servingModel ?? null,
      r?.attempts ?? 0,
      r?.latencyMs ?? null,
      r?.inputTokens ?? null,
      r?.outputTokens ?? null,
      r?.reasoningTokens ?? null,
      r?.costUsd ?? null,
      r?.costEstimated ?? false,
      fields.seed ?? null,
      fields.strategy ?? (r?.decision ? r.decision.strategy || null : null),
    ],
  );
  return id;
}

async function finish(
  d: Deps,
  roundId: string,
  status: string,
  reason: string | null,
  revealAt: Date,
) {
  await d.db.query(
    'UPDATE rounds SET status = $2, status_reason = $3, finished_at = $4, reveal_at = $5 WHERE id = $1',
    [roundId, status, reason, d.now(), revealAt],
  );
  await d.db.query('UPDATE decisions SET reveal_at = $2 WHERE round_id = $1', [roundId, revealAt]);
}

function describe(outcomes: ActionOutcome[]): string {
  if (!outcomes.length) return 'held';
  return outcomes
    .map(
      (o) =>
        `${o.side ?? o.sideRaw ?? '?'} ${o.quantity ?? '?'} ${o.symbol ?? o.symbolRaw ?? '?'}${o.status === 'executed' ? '' : ` (${o.rejectCode})`}`,
    )
    .join(', ');
}

/** The universe in force on a date: the configured list (universe_versions records history). */
function universeSymbols(d: Deps): string[] {
  return d.universe.constituents.map((c) => c.symbol);
}

async function dueCorporateActions(
  db: pg.Pool,
  date: string,
): Promise<{ unapplied: Set<string>; exDate: Set<string> }> {
  const r = await db.query<{ symbol: string; applied_at: Date | null }>(
    'SELECT symbol, applied_at FROM corporate_actions WHERE ex_date = $1',
    [date],
  );
  return {
    unapplied: new Set(r.rows.filter((x) => !x.applied_at).map((x) => x.symbol)),
    exDate: new Set(r.rows.map((x) => x.symbol)),
  };
}

/** Gap guard (SPEC §8.7): at the first round of the day, a held symbol opening >15% from its previous close with no corporate action. */
async function gapGuard(
  d: Deps,
  s: RoundSummary,
  snap: Snapshot,
  held: string[],
  exDate: Set<string>,
) {
  for (const sym of held) {
    const q = snap.quotes.find((x) => x.symbol === sym);
    if (
      !q ||
      q.openPaise === null ||
      q.prevClosePaise === null ||
      q.prevClosePaise <= 0n ||
      exDate.has(sym)
    )
      continue;
    const diff = q.openPaise - q.prevClosePaise;
    if ((diff < 0n ? -diff : diff) * 100n > q.prevClosePaise * BigInt(d.arena.limits.gapGuardPct)) {
      await d.db.query(
        `INSERT INTO symbol_flags (symbol, flag, reason, set_at) VALUES ($1,'SUSPENDED_REVIEW',$2,$3)
         ON CONFLICT (symbol) DO UPDATE SET flag = 'SUSPENDED_REVIEW', reason = EXCLUDED.reason, set_at = EXCLUDED.set_at, cleared_at = NULL`,
        [
          sym,
          `opened more than ${d.arena.limits.gapGuardPct}% from the previous close with no corporate action recorded`,
          d.now(),
        ],
      );
      await incident(d, s, {
        key: `gap:${sym}`,
        severity: 'critical',
        title: `${sym} gapped with no corporate action`,
        detail: `open ${q.openPaise} vs previous close ${q.prevClosePaise} paise. Enter the corporate action or clear the flag.`,
        publicMessage: `${sym} is under review: its price moved sharply at the open and we are checking for a corporate action.`,
        scope: 'symbol',
      });
    }
  }
}

export async function runRound(
  d: Deps,
  season: SeasonRow,
  tradingDate: string,
  slot: string,
  trigger: 'cron' | 'manual',
): Promise<RoundSummary> {
  const s: RoundSummary = {
    roundId: null,
    slot,
    status: 'NOT_RUN',
    reason: null,
    participants: [],
    incidents: [],
  };
  const roundId = randomUUID();
  const startedAt = d.now();
  const ins = await d.db.query(
    `INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, status, trigger)
     VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',$7) ON CONFLICT (season_id, trading_date, slot_time) DO NOTHING RETURNING id`,
    [roundId, season.id, tradingDate, slot, slotInstant(tradingDate, slot), startedAt, trigger],
  );
  if (!ins.rowCount) {
    s.status = 'OWNED_ELSEWHERE';
    s.reason = 'another run already owns this slot';
    return s;
  }
  s.roundId = roundId;
  const delay = ms(d.arena.season.publicDelayMinutes);
  const skip = async (
    reason: string,
    detail: string,
    publicMessage: string,
    key: string,
    severity: 'warn' | 'critical',
  ) => {
    await incident(d, s, {
      key,
      severity,
      title: `Round ${tradingDate} ${slot} skipped: ${reason}`,
      detail,
      publicMessage,
      scope: 'arena',
    });
    await finish(d, roundId, 'SKIPPED_DATA', reason, new Date(d.now().getTime() + delay));
    s.status = 'SKIPPED_DATA';
    s.reason = reason;
    s.detail = detail;
    return s;
  };

  season = await ensureSeasonStarted(d, season, roundId, startedAt);
  const parts = await loadParticipants(d.db, season.id);
  const held = await heldSymbols(d.db, season.id);
  const universe = universeSymbols(d);
  const symbols = [...new Set([...universe, ...held])].sort();
  const corp = await dueCorporateActions(d.db, tradingDate);
  const suspended = new Set([...(await activeSuspensions(d.db)), ...corp.unapplied]);

  // Market data: login, mapping, decision snapshot.
  let session: MarketDataSession;
  let decisionSnap: Snapshot;
  let mapping;
  try {
    const provider = d.provider();
    mapping = await mappingFromDb(d.db, d.universe, d.arena, held);
    if (!mapping.equities.length) {
      mapping = await freshMapping(
        provider,
        { ...d.universe, constituents: d.universe.constituents },
        d.arena,
      );
      await storeInstruments(d.db, mapping.equities, mapping.indices, tradingDate);
    }
    session = await provider.login();
    await resolveIncident(d.db, 'data:login');
    decisionSnap = await snapshotFor({
      session,
      source: provider.source,
      purpose: 'decision',
      mapping,
      arena: d.arena,
      exDateToday: corp.exDate,
      now: d.now,
    });
  } catch (e) {
    if (e instanceof DataError) {
      if (e.kind === 'DATA_LOGIN_FAILED')
        return skip(
          'DATA_LOGIN_FAILED',
          e.message,
          "Rounds are paused: market data isn't coming through.",
          'data:login',
          'critical',
        );
      return skip(
        e.kind === 'DATA_SHAPE_CHANGED' ? 'DATA_SHAPE_CHANGED' : 'DATA_DEGRADED',
        `${e.message}${e.fieldPath ? ` (field ${e.fieldPath})` : ''}`,
        'Round skipped: market data was incomplete.',
        `data:${e.kind}`,
        e.kind === 'DATA_SHAPE_CHANGED' ? 'critical' : 'warn',
      );
    }
    throw e;
  }
  await persistSnapshot(d.db, decisionSnap);
  await d.db.query('UPDATE rounds SET decision_snapshot_id = $2 WHERE id = $1', [
    roundId,
    decisionSnap.id,
  ]);
  if (decisionSnap.verdict.status === 'rejected') {
    const v = decisionSnap.verdict;
    if (v.reason === 'MARKET_CLOSED_UNSCHEDULED')
      return skip(
        v.reason,
        `${v.detail}. Update config/calendar if this was a holiday.`,
        'Market closed.',
        'data:closed',
        'warn',
      );
    const prior = await d.db.query(
      "SELECT count(*)::int AS n FROM rounds WHERE season_id = $1 AND status = 'SKIPPED_DATA' AND status_reason = 'DATA_DEGRADED' AND started_at > $2",
      [season.id, new Date(startedAt.getTime() - ms(65))],
    );
    return skip(
      'DATA_DEGRADED',
      v.detail,
      'Round skipped: market data was incomplete.',
      'data:degraded',
      (prior.rows[0]?.n ?? 0) >= 1 ? 'critical' : 'warn',
    );
  }
  await resolveIncident(d.db, 'data:degraded');
  for (const u of mapping.unmapped) s.incidents.push(`unmapped ${u.symbol}`);

  const slots = slotTimes(d.arena);
  if (slot === slots[0]) await gapGuard(d, s, decisionSnap, held, corp.exDate);
  for (const f of await activeSuspensions(d.db)) suspended.add(f);

  const market = await buildMarketBlock(
    d.db,
    decisionSnap,
    symbols,
    tradingDate,
    d.arena.marketData.indexName,
    d.arena.marketData.vixName,
  );
  await d.db.query('UPDATE rounds SET market_block = $2 WHERE id = $1', [roundId, market.text]);
  if (market.indicatorsMissing)
    await incident(d, s, {
      key: `indicators:${tradingDate}`,
      severity: 'warn',
      title: 'Indicators missing',
      detail: 'The pre-market job has not refreshed indicators; they are omitted from the prompt.',
      publicMessage: 'Some indicators were unavailable this round.',
      scope: 'arena',
    });

  // Decisions, in parallel, each persisted as it settles.
  const days = await seasonTradingDates(d.db, season.id);
  const seasonDay = Math.max(1, days.indexOf(tradingDate) + 1 || days.length);
  const nextRound = nextRoundText(d.arena, d.calendar, tradingDate, slot, season.ends_on);
  const roundNo = slots.indexOf(slot) + 1;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('decision deadline')),
    d.arena.schedule.decisionDeadlineSeconds * 1000,
  );
  const pending: Pending[] = [];
  const decideOne = async (p: ParticipantRow): Promise<void> => {
    const portfolio = (await loadPortfolio(d.db, p.id)) ?? {
      cashPaise: season.starting_cash_paise,
      positions: new Map(),
    };
    if (p.status === 'retired') {
      if (!portfolio.positions.size) return;
      const actions = closingActions(portfolio, 'Retired: positions are closed.');
      const id = await insertDecision(d.db, roundId, p, {
        status: 'RETIRED',
        reasoning:
          'Retired: the model is no longer available, so its positions are closed at this round’s prices.',
        parsed: { content: null, liquidation: actions },
      });
      pending.push({ participant: p, decisionId: id, status: 'RETIRED', actions, record: null });
      return;
    }
    if (p.kind === 'monkey') {
      const m = await monkeyDecide({
        roundId,
        portfolio,
        tradeable: new Map(
          [...market.tradeable].filter(([sym]) => universe.includes(sym) && !suspended.has(sym)),
        ),
        ltp: (sym) => market.tradeable.get(sym) ?? null,
        allowShort: tradingLimits(d.arena).allowShort,
      });
      const id = await insertDecision(d.db, roundId, p, {
        status: 'OK',
        strategy: m.strategy,
        reasoning: m.reasoning,
        note: '',
        flags: [],
        seed: m.seedHex,
        parsed: {
          content: JSON.stringify({
            strategy: m.strategy,
            reasoning: m.reasoning,
            actions: m.actions,
          }),
        },
      });
      pending.push({
        participant: p,
        decisionId: id,
        status: 'OK',
        actions: m.actions,
        record: null,
      });
      return;
    }
    const entry = p.model_config as unknown as ModelEntry;
    const spent = await monthSpendUsd(d.db, p.id, d.now());
    if (overBudget(spent, entry.monthlyCapUsd)) {
      await d.db.query("UPDATE participants SET status = 'paused_budget' WHERE id = $1", [p.id]);
      await insertDecision(d.db, roundId, p, {
        status: 'SKIPPED_BUDGET',
        errorDetail: `spent $${spent.toFixed(4)} of $${entry.monthlyCapUsd} this month`,
      });
      s.incidents.push(`info: ${p.slot} paused (budget)`);
      s.participants.push({
        slot: p.slot,
        status: 'SKIPPED_BUDGET',
        latencyMs: null,
        costUsd: null,
        actions: '—',
      });
      return;
    }
    if (p.status === 'paused_budget')
      await d.db.query("UPDATE participants SET status = 'active' WHERE id = $1", [p.id]);
    const prices = await pricesWithFallback(d.db, decisionSnap, [...portfolio.positions.keys()]);
    const priv = buildPrivateBlock({
      round: roundNo,
      roundsToday: slots.length,
      tradingDate,
      weekday: weekdayName(tradingDate),
      slot,
      seasonDay,
      seasonDays: season.trading_days,
      nextRound,
      startingCashPaise: season.starting_cash_paise,
      portfolio,
      prices,
      history: await historyFor(d.db, season.id, p.id, roundId),
      noteToSelf: await lastNoteToSelf(d.db, p.id),
      squareOffAt:
        d.arena.product === 'intraday_long_short' ? d.arena.intraday!.squareOffFrom : null,
      maxGrossExposurePct: d.arena.limits.maxGrossExposurePct,
      day: await dayScoreFor(d.db, p.id, tradingDate, season.starting_cash_paise),
    });
    const rec = await decideWithModel({
      client: d.llm(),
      entry,
      system: season.system_prompt!,
      user: renderUserMessage(priv, market.text),
      llm: d.arena.llm,
      noteMaxChars: d.arena.display.noteToSelfMaxChars,
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted && rec.status === 'MISSED_PROVIDER')
      rec.errorDetail = `decision deadline (${d.arena.schedule.decisionDeadlineSeconds} s) passed${rec.errorDetail ? `: ${rec.errorDetail}` : ''}`;
    const id = await insertDecision(d.db, roundId, p, {
      status: rec.status,
      privateBlock: priv,
      rec,
    });
    pending.push({
      participant: p,
      decisionId: id,
      status: rec.status,
      actions: rec.decision?.actions ?? [],
      record: rec,
    });
  };
  const decisionParts = parts.filter((p) => p.kind !== 'index');
  const settled = await Promise.allSettled(decisionParts.map((p) => decideOne(p)));
  clearTimeout(timer);
  for (const [i, r] of settled.entries()) {
    if (r.status === 'rejected') {
      const p = decisionParts[i]!;
      d.log.error({ err: r.reason, participant: p.id }, 'decision step failed');
      const exists = await d.db.query(
        'SELECT 1 FROM decisions WHERE round_id = $1 AND participant_id = $2',
        [roundId, p.id],
      );
      if (!exists.rowCount)
        await insertDecision(d.db, roundId, p, {
          status: 'MISSED_PROVIDER',
          errorClass: 'TRANSIENT',
          errorDetail: `engine error: ${(r.reason as Error).message}`,
        });
      s.participants.push({
        slot: p.slot,
        status: 'MISSED_PROVIDER',
        latencyMs: null,
        costUsd: null,
        actions: '—',
      });
    }
  }
  await handleLlmIncidents(d, s, pending, parts);

  // Fill snapshot.
  let fillSnap: Snapshot | null = null;
  try {
    fillSnap = await snapshotFor({
      session,
      source: d.provider().source,
      purpose: 'fill',
      mapping,
      arena: d.arena,
      exDateToday: corp.exDate,
      now: d.now,
    });
    await persistSnapshot(d.db, fillSnap);
    await d.db.query('UPDATE rounds SET fill_snapshot_id = $2 WHERE id = $1', [
      roundId,
      fillSnap.id,
    ]);
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    d.log.error({ err: e }, 'fill snapshot failed');
  }
  if (!fillSnap || fillSnap.verdict.status === 'rejected') {
    const why =
      fillSnap?.verdict.status === 'rejected' ? fillSnap.verdict.detail : 'provider error';
    await d.db.query(
      "UPDATE decisions SET status = 'NOT_EXECUTED_DATA' WHERE round_id = $1 AND status IN ('OK','RETIRED')",
      [roundId],
    );
    await incident(d, s, {
      key: `fill:${roundId}`,
      severity: 'critical',
      title: `Fill snapshot failed for ${tradingDate} ${slot}`,
      detail: why,
      publicMessage: 'Decisions made, not executed: market data failed.',
      scope: 'round',
    });
    await finish(
      d,
      roundId,
      'PARTIAL',
      'fill snapshot failed',
      new Date(d.now().getTime() + delay),
    );
    s.status = 'PARTIAL';
    s.reason = 'fill snapshot failed';
    for (const p of pending)
      s.participants.push({
        slot: p.participant.slot,
        status: p.status === 'OK' || p.status === 'RETIRED' ? 'NOT_EXECUTED_DATA' : p.status,
        latencyMs: p.record?.latencyMs ?? null,
        costUsd: p.record?.costUsd ?? null,
        actions: '—',
      });
    return s;
  }
  const idx = fillSnap.indices.find((x) => x.name === d.arena.marketData.indexName)!;
  if (season.index_at_start_x100 === null) {
    await d.db.query(
      'UPDATE seasons SET index_at_start_x100 = $2 WHERE id = $1 AND index_at_start_x100 IS NULL',
      [season.id, idx.valueX100],
    );
    season = { ...season, index_at_start_x100: idx.valueX100 };
  }

  // Every row from this round shares one reveal time. Ledger rows are immutable, so it is fixed before writing.
  const revealAt = new Date(fillSnap.finishedAt.getTime() + delay);
  const fillQuotes = new Map(
    fillSnap.quotes
      .filter((q) => q.valid)
      .map((q) => [
        q.symbol,
        {
          ltpPaise: q.ltpPaise!,
          bidPaise: q.bidPaise,
          askPaise: q.askPaise,
          depthAvailable: q.depthAvailable,
        },
      ]),
  );
  const valuation = await pricesWithFallback(d.db, fillSnap, symbols);
  let degraded = false;

  for (const pd of pending.filter((x) => x.status === 'OK' || x.status === 'RETIRED')) {
    const p = pd.participant;
    const retired = pd.status === 'RETIRED';
    const outcomes = await executeAndRecord(
      d,
      s,
      season,
      tradingDate,
      roundId,
      pd,
      fillSnap,
      revealAt,
      {
        universe: new Set(retired ? symbols : universe),
        fillQuotes,
        valuationPrice: (sym) => valuation.get(sym) ?? null,
        suspended: retired ? new Set() : suspended,
        ...tradingLimits(d.arena),
        maxActions: retired
          ? Math.max(d.arena.limits.maxActionsPerRound, pd.actions.length)
          : d.arena.limits.maxActionsPerRound,
        forced: retired,
      },
    );
    if (!outcomes) degraded = true;
    s.participants.push({
      slot: p.slot,
      status: outcomes ? pd.status : 'EXECUTION_FAILED',
      latencyMs: outcomes ? (pd.record?.latencyMs ?? null) : null,
      costUsd: outcomes ? (pd.record?.costUsd ?? null) : null,
      actions: outcomes ? describe(outcomes) : '—',
    });
  }
  for (const pd of pending.filter((x) => x.status !== 'OK' && x.status !== 'RETIRED')) {
    s.participants.push({
      slot: pd.participant.slot,
      status: pd.status,
      latencyMs: pd.record?.latencyMs ?? null,
      costUsd: pd.record?.costUsd ?? null,
      actions: pd.record?.errorDetail ?? '—',
    });
  }

  await writeMarks(d, season, parts, fillSnap, valuation, 'round', roundId, revealAt);
  await finish(
    d,
    roundId,
    degraded ? 'PARTIAL' : 'COMPLETED',
    degraded ? 'an execution transaction failed' : null,
    revealAt,
  );
  s.status = degraded ? 'PARTIAL' : 'COMPLETED';
  return s;
}

/** Engine-generated orders that close every open position: SELL a long, BUY back a short. */
export function closingActions(
  portfolio: PortfolioState,
  why: string,
): { side: 'BUY' | 'SELL'; symbol: string; quantity: number; why: string }[] {
  return [...portfolio.positions.entries()]
    .filter(([, pos]) => pos.quantity !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, pos]) => ({
      side: pos.quantity > 0 ? 'SELL' : 'BUY',
      symbol,
      quantity: Math.abs(pos.quantity),
      why,
    }));
}

/** Rule limits for executing model and Monkey actions (SPEC §3, §11.1). */
export function tradingLimits(arena: Deps['arena']) {
  return {
    maxActions: arena.limits.maxActionsPerRound,
    maxWeightPct: arena.limits.maxWeightPct,
    slippageBps: arena.limits.slippageBps,
    allowShort: arena.product === 'intraday_long_short',
    maxGrossExposurePct: arena.limits.maxGrossExposurePct,
  };
}

/**
 * Executes one participant's actions and writes the actions, ledger entries and positions in one
 * transaction (SPEC §11.1 step 5). Returns null, after marking the decision EXECUTION_FAILED and
 * raising an incident, if the transaction fails.
 */
async function executeAndRecord(
  d: Deps,
  s: RoundSummary,
  season: SeasonRow,
  tradingDate: string,
  roundId: string,
  pd: Pending,
  fillSnap: Snapshot,
  revealAt: Date,
  ctx: Omit<ExecutionContext, 'fees' | 'soldToday'>,
): Promise<ActionOutcome[] | null> {
  const p = pd.participant;
  try {
    return await withTransaction(d.db, async (tx) => {
      const portfolio = (await loadPortfolio(tx, p.id)) ?? {
        cashPaise: season.starting_cash_paise,
        positions: new Map(),
      };
      const res = executeActions(pd.actions, portfolio, {
        ...ctx,
        soldToday: await soldToday(tx, p.id, tradingDate),
        fees: d.fees,
      });
      const drafts: LedgerDraft[] = [];
      for (const o of res.outcomes) {
        const actionId = randomUUID();
        await tx.query(
          `INSERT INTO actions (id, decision_id, position, side_raw, symbol_raw, quantity_raw, why, side, symbol, quantity, status, reject_code, reject_detail, model_fault, exit_plan)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            actionId,
            pd.decisionId,
            o.position,
            o.sideRaw,
            o.symbolRaw,
            o.quantityRaw === undefined ? null : JSON.stringify(o.quantityRaw),
            o.why,
            o.side,
            o.symbol,
            o.quantity,
            o.status,
            o.rejectCode,
            o.rejectDetail,
            o.modelFault,
            o.exitPlan,
          ],
        );
        if (o.fill) {
          drafts.push(
            tradeDraft(
              {
                id: randomUUID(),
                seasonId: season.id,
                participantId: p.id,
                roundId,
                occurredAt: fillSnap.finishedAt,
                revealAt,
              },
              {
                actionId,
                side: o.side!,
                symbol: o.symbol!,
                quantity: o.quantity!,
                pricePaise: o.fill.pricePaise,
                priceSource: o.fill.priceSource,
                snapshotId: fillSnap.id,
                grossPaise: o.fill.grossPaise,
                charges: o.fill.charges,
                chargesTotalPaise: o.fill.chargesTotalPaise,
                cashDeltaPaise: o.fill.cashDeltaPaise,
                cashAfterPaise: o.fill.cashAfterPaise,
                positionAfter: o.fill.positionAfter,
                avgCostAfterPaise: o.fill.avgCostAfterPaise,
                realizedPnlPaise: o.fill.realizedPnlPaise,
              },
            ),
          );
        }
      }
      if (pd.status === 'RETIRED' && res.state.positions.size === 0) {
        drafts.push(
          adjustDraft(
            {
              id: randomUUID(),
              seasonId: season.id,
              participantId: p.id,
              roundId,
              occurredAt: fillSnap.finishedAt,
              revealAt,
            },
            {
              type: 'RETIRE',
              symbol: null,
              quantityDelta: null,
              grossPaise: 0n,
              cashDeltaPaise: 0n,
              cashAfterPaise: res.state.cashPaise,
              positionAfter: null,
              avgCostAfterPaise: null,
              note: 'Retired: holdings sold; final value is cash.',
            },
          ),
        );
      }
      const entries = await appendLedger(tx, drafts);
      await applyPositions(tx, entries);
      return res.outcomes;
    });
  } catch (e) {
    d.log.error({ err: e, participant: p.id }, 'execution transaction failed');
    await d.db.query(
      "UPDATE decisions SET status = 'EXECUTION_FAILED', error_detail = $2 WHERE id = $1",
      [pd.decisionId, `execution failed: ${(e as Error).message}`],
    );
    await incident(d, s, {
      key: `exec:${roundId}:${p.slot}`,
      severity: 'critical',
      title: `Recording failed for ${p.slot}`,
      detail: (e as Error).message,
      publicMessage: 'Not executed: recording failed.',
      scope: 'participant',
      participantId: p.id,
    });
    return null;
  }
}

export interface SquareOffOptions {
  /** End-of-day fallback: close at this (valuation) snapshot instead of taking a fresh fill snapshot. */
  snapshot?: Snapshot;
}

/**
 * The intraday square-off (SPEC §12.3a). Closes every open position at a fresh fill snapshot: longs
 * are sold at the best bid and shorts bought back at the best ask, with normal charges. It is recorded
 * as a round of kind 'square_off' with an engine decision (status SQUARE_OFF) for each participant that
 * had positions. A position without a valid price stays open: the next tick tries again, and end of day
 * closes whatever is left at the day-end last traded price.
 */
export async function runSquareOff(
  d: Deps,
  season: SeasonRow,
  tradingDate: string,
  trigger: 'cron' | 'manual',
  opts: SquareOffOptions = {},
): Promise<RoundSummary> {
  const intraday = d.arena.intraday;
  if (d.arena.product !== 'intraday_long_short' || !intraday)
    throw new Error('the square-off only applies to the intraday product');
  const now = d.now();
  const slot = istNow(now).toFormat('HH:mm');
  const s: RoundSummary = {
    roundId: null,
    slot: `square-off ${slot}`,
    status: 'NOT_RUN',
    reason: null,
    participants: [],
    incidents: [],
  };
  const parts = await loadParticipants(d.db, season.id);
  const open: { participant: ParticipantRow; portfolio: PortfolioState }[] = [];
  for (const p of parts.filter((x) => x.kind !== 'index')) {
    const portfolio = await loadPortfolio(d.db, p.id);
    if (portfolio && portfolio.positions.size) open.push({ participant: p, portfolio });
  }
  if (!open.length) {
    s.status = 'NOTHING_OPEN';
    return s;
  }
  const roundId = randomUUID();
  const ins = await d.db.query(
    `INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, status, trigger, kind)
     VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',$7,'square_off') ON CONFLICT (season_id, trading_date, slot_time) DO NOTHING RETURNING id`,
    [
      roundId,
      season.id,
      tradingDate,
      slot,
      slotInstant(tradingDate, intraday.squareOffFrom),
      now,
      trigger,
    ],
  );
  if (!ins.rowCount) {
    s.status = 'OWNED_ELSEWHERE';
    s.reason = 'another run already owns this minute';
    return s;
  }
  s.roundId = roundId;
  const delay = ms(d.arena.season.publicDelayMinutes);
  const late = minutesOfDay(now) >= minutesOf(intraday.squareOffDeadline);
  const held = await heldSymbols(d.db, season.id);
  const symbols = [...new Set([...universeSymbols(d), ...held])].sort();

  let snap: Snapshot | null = opts.snapshot ?? null;
  let failure: string | null = null;
  if (!snap) {
    try {
      const provider = d.provider();
      const mapping = await mappingFromDb(d.db, d.universe, d.arena, held);
      const session = await provider.login();
      snap = await snapshotFor({
        session,
        source: provider.source,
        purpose: 'fill',
        mapping,
        arena: d.arena,
        now: d.now,
      });
      await persistSnapshot(d.db, snap);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      failure = `${e.kind}: ${e.message}`;
    }
  }
  if (!snap || snap.verdict.status === 'rejected') {
    const why =
      failure ??
      (snap?.verdict.status === 'rejected'
        ? `${snap.verdict.reason}: ${snap.verdict.detail}`
        : 'no snapshot');
    await incident(d, s, {
      key: `squareoff:${tradingDate}`,
      severity: late ? 'critical' : 'warn',
      title: `Square-off at ${slot} could not get prices`,
      detail: `${why}. The next tick tries again; end of day closes anything still open at the day-end last traded price.`,
      publicMessage: 'Square-off delayed: market data was incomplete.',
      scope: 'arena',
    });
    if (snap)
      await d.db.query('UPDATE rounds SET fill_snapshot_id = $2 WHERE id = $1', [roundId, snap.id]);
    await finish(
      d,
      roundId,
      'SKIPPED_DATA',
      'square-off could not get prices',
      new Date(now.getTime() + delay),
    );
    s.status = 'SKIPPED_DATA';
    s.reason = why;
    return s;
  }
  await d.db.query('UPDATE rounds SET fill_snapshot_id = $2 WHERE id = $1', [roundId, snap.id]);
  const revealAt = new Date(snap.finishedAt.getTime() + delay);
  const fillQuotes = new Map(
    snap.quotes
      .filter((q) => q.valid)
      .map((q) => [
        q.symbol,
        {
          ltpPaise: q.ltpPaise!,
          bidPaise: q.bidPaise,
          askPaise: q.askPaise,
          depthAvailable: q.depthAvailable,
        },
      ]),
  );
  const valuation = await pricesWithFallback(d.db, snap, symbols);
  const why = `Square-off: intraday positions are closed by ${intraday.squareOffDeadline} IST.`;
  const reasoning = opts.snapshot
    ? `End-of-day square-off: no live price was available before ${intraday.squareOffDeadline} IST, so the remaining positions are closed at the day-end last traded price.`
    : `Square-off at ${slot} IST: every open position is closed (intraday rule; nothing is held overnight).`;
  let degraded = false;
  for (const o of open) {
    const actions = closingActions(o.portfolio, why);
    const decisionId = await insertDecision(d.db, roundId, o.participant, {
      status: 'SQUARE_OFF',
      reasoning,
      parsed: { content: null, liquidation: actions },
    });
    const pd: Pending = {
      participant: o.participant,
      decisionId,
      status: 'SQUARE_OFF',
      actions,
      record: null,
    };
    const outcomes = await executeAndRecord(
      d,
      s,
      season,
      tradingDate,
      roundId,
      pd,
      snap,
      revealAt,
      {
        universe: new Set(symbols),
        fillQuotes,
        valuationPrice: (sym) => valuation.get(sym) ?? null,
        suspended: new Set(),
        ...tradingLimits(d.arena),
        maxActions: Math.max(1, actions.length),
        forced: true,
      },
    );
    if (!outcomes) degraded = true;
    s.participants.push({
      slot: o.participant.slot,
      status: outcomes ? 'SQUARE_OFF' : 'EXECUTION_FAILED',
      latencyMs: null,
      costUsd: null,
      actions: outcomes ? describe(outcomes) : '—',
    });
  }
  await writeMarks(d, season, parts, snap, valuation, 'round', roundId, revealAt);
  const left = await heldSymbols(d.db, season.id);
  const status = left.length || degraded ? 'PARTIAL' : 'COMPLETED';
  const reason = left.length
    ? `still open (no price or recording failed): ${left.join(', ')}`
    : degraded
      ? 'an execution transaction failed'
      : null;
  if (left.length)
    await incident(d, s, {
      key: `squareoff:${tradingDate}`,
      severity: late || opts.snapshot ? 'critical' : 'warn',
      title: `Square-off at ${slot} left positions open`,
      detail: `${reason}. ${opts.snapshot ? 'These positions are held overnight; the next square-off closes them.' : 'The next tick tries again.'}`,
      publicMessage: 'Some positions could not be closed at the square-off yet.',
      scope: 'arena',
    });
  else {
    await resolveIncident(d.db, `squareoff:${tradingDate}`);
    if (late)
      await incident(d, s, {
        key: `squareoff-late:${tradingDate}`,
        severity: 'warn',
        title: `Square-off finished after ${intraday.squareOffDeadline} IST`,
        detail: `All positions were closed at ${slot} IST.`,
        publicMessage: `Today's square-off finished at ${slot} IST, after ${intraday.squareOffDeadline}.`,
        scope: 'arena',
      });
  }
  await finish(d, roundId, status, reason, revealAt);
  s.status = status;
  s.reason = reason;
  return s;
}

/** Marks every participant (benchmarks included) at a snapshot (SPEC §11.8). */
export async function writeMarks(
  d: Deps,
  season: SeasonRow,
  parts: ParticipantRow[],
  snap: Snapshot,
  valuation: Map<string, bigint>,
  kind: 'round' | 'eod',
  roundId: string | null,
  revealAt: Date,
): Promise<void> {
  const idx = snap.indices.find((x) => x.name === d.arena.marketData.indexName);
  for (const p of parts) {
    let mark: { cashPaise: bigint; holdingsValuePaise: bigint; totalPaise: bigint };
    if (p.kind === 'index') {
      if (!season.index_at_start_x100 || !idx?.valid || idx.valueX100 === null) continue;
      const v = indexBenchmarkValue(
        season.starting_cash_paise,
        season.index_at_start_x100,
        idx.valueX100,
      );
      mark = { cashPaise: 0n, holdingsValuePaise: v, totalPaise: v };
    } else {
      const portfolio: PortfolioState | null = await loadPortfolio(d.db, p.id);
      if (!portfolio) continue;
      try {
        mark = markPortfolio(portfolio, (sym) => valuation.get(sym) ?? null);
      } catch (e) {
        d.log.error(
          { err: e, participant: p.id },
          'cannot mark participant: a holding has no recorded price',
        );
        continue;
      }
    }
    await d.db.query(
      `INSERT INTO marks (id, participant_id, round_id, snapshot_id, kind, marked_at, cash_paise, holdings_value_paise, total_paise, reveal_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        p.id,
        roundId,
        snap.id,
        kind,
        snap.finishedAt,
        mark.cashPaise,
        mark.holdingsValuePaise,
        mark.totalPaise,
        revealAt,
      ],
    );
  }
}

async function handleLlmIncidents(
  d: Deps,
  s: RoundSummary,
  pending: Pending[],
  parts: ParticipantRow[],
) {
  const models = parts.filter((p) => p.kind === 'model' && p.status !== 'retired');
  const byClass = (c: string) => pending.filter((x) => x.record?.errorClass === c);
  if (byClass('CREDITS_EXHAUSTED').length) {
    await setPaused(d.db, true, 'credits_exhausted');
    await incident(d, s, {
      key: 'llm:credits',
      severity: 'critical',
      title: 'OpenRouter credit exhausted',
      detail: 'HTTP 402 from OpenRouter. Add credit, then run `pnpm admin resume`.',
      publicMessage: 'Rounds are paused: the arena is out of API credit.',
      scope: 'arena',
    });
  }
  const auth = byClass('CONFIG_AUTH');
  if (auth.length && auth.length === models.length) {
    await setPaused(d.db, true, 'llm_auth');
    await incident(d, s, {
      key: 'llm:auth',
      severity: 'critical',
      title: 'OpenRouter rejected the API key for every model',
      detail: 'HTTP 401/403 for all models. Check OPENROUTER_API_KEY.',
      publicMessage: 'Rounds are paused: the arena cannot reach its AI models.',
      scope: 'arena',
    });
  } else {
    for (const a of auth)
      await incident(d, s, {
        key: `llm:auth:${a.participant.slot}`,
        severity: 'critical',
        title: `${a.participant.slot}: OpenRouter rejected the request`,
        detail: a.record?.errorDetail ?? '',
        publicMessage: 'Missed round: model offline.',
        scope: 'participant',
        participantId: a.participant.id,
      });
  }
  for (const a of byClass('MODEL_UNAVAILABLE'))
    await incident(d, s, {
      key: `llm:unavailable:${a.participant.slot}`,
      severity: 'critical',
      title: `${a.participant.slot}: model unavailable`,
      detail: `${a.record?.errorDetail ?? ''}. Decide whether to retire it (pnpm admin retire).`,
      publicMessage: 'Missed round: model offline.',
      scope: 'participant',
      participantId: a.participant.id,
    });
  for (const a of byClass('MODEL_MISMATCH'))
    await incident(d, s, {
      key: `llm:mismatch:${a.participant.slot}`,
      severity: 'critical',
      title: `${a.participant.slot}: wrong model served`,
      detail: a.record?.errorDetail ?? '',
      publicMessage: 'Missed round: wrong model served.',
      scope: 'participant',
      participantId: a.participant.id,
    });
  for (const a of byClass('TRANSIENT')) {
    const r = await d.db.query<{ status: string }>(
      `SELECT d.status FROM decisions d JOIN rounds r ON r.id = d.round_id WHERE d.participant_id = $1 ORDER BY r.started_at DESC LIMIT 3`,
      [a.participant.id],
    );
    const three = r.rows.length === 3 && r.rows.every((x) => x.status === 'MISSED_PROVIDER');
    await incident(d, s, {
      key: `llm:transient:${a.participant.slot}`,
      severity: 'warn',
      title: `${a.participant.slot}: provider error or timeout`,
      detail: a.record?.errorDetail ?? '',
      publicMessage: 'Missed round: provider timeout.',
      scope: 'participant',
      participantId: a.participant.id,
    });
    if (three) {
      await incident(d, s, {
        key: `llm:down:${a.participant.slot}`,
        severity: 'critical',
        title: `${a.participant.slot}: missed 3 rounds in a row (provider)`,
        detail: a.record?.errorDetail ?? '',
        publicMessage: 'Missed round: provider timeout.',
        scope: 'participant',
        participantId: a.participant.id,
      });
    }
  }
  for (const ok of pending.filter((x) => x.status === 'OK' && x.participant.kind === 'model')) {
    await resolveIncident(d.db, `llm:transient:${ok.participant.slot}`);
    await resolveIncident(d.db, `llm:down:${ok.participant.slot}`);
    await resolveIncident(d.db, `llm:auth:${ok.participant.slot}`);
  }
}
