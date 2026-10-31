import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DateTime } from 'luxon';
import type pg from 'pg';
import { createPool } from '@arena/db';
import { TIERS, MIN_FREE_PARTICIPANTS, type ModelEntry } from '@arena/shared/schemas';
import { formatUsd } from '@arena/shared/format';
import type { ParsedArgs } from '../ops/args';
import { flagString } from '../ops/args';
import { baseContext, angelProvider } from '../config/context';
import {
  must,
  loadModels,
  loadRosterRules,
  loadUniverse,
  requireEnv,
  configDir,
} from '../config/load';
import { OpenRouterClient } from '../llm/openrouter';
import { proposeRoster, rosterTable, freeModelList, type Tier } from '../llm/roster';
import { decideWithModel } from '../llm/decide';
import { renderSystemPrompt, renderUserMessage } from '../llm/prompt';
import { freshMapping, snapshotFor, inMarketHours } from '../data/market';
import { loadSnapshot, type Snapshot } from '../data/snapshot';
import { TradingCalendar } from '../data/calendar';
import { executeActions } from '../core/execute';
import {
  buildMarketBlock,
  buildPrivateBlock,
  pricesWithFallback,
  historyFor,
  lastNoteToSelf,
  dayScoreFor,
} from '../round/context';
import { slotTimes, weekdayName, IST } from '../round/schedule';
import {
  currentSeason,
  participants as seasonParticipants,
  loadPortfolio,
  activeSuspensions,
  soldToday,
} from '../round/store';
import { writeStepSummary, mdTable } from '../ops/summary';
import type { PortfolioState } from '../core/portfolio';
import { tradingLimits } from '../round/runner';

/** pnpm engine roster --tier budget|flagship|free [--write] [--out path] */
export async function rosterCommand(args: ParsedArgs): Promise<number> {
  const ctx = baseContext();
  const tier = (flagString(args, 'tier') ?? 'budget') as Tier;
  if (!(TIERS as readonly string[]).includes(tier))
    throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  const rules = must(loadRosterRules());
  const { models, skipped } = await new OpenRouterClient({}).listModels();
  const proposal = proposeRoster(models, rules, tier, ctx.arena, new Date());
  const freeList = tier === 'free' ? `\n\n${freeModelList(models)}` : '';
  const md = `## Proposed roster (${tier})\n\nFrom ${models.length} models on OpenRouter${skipped ? ` (${skipped} skipped: unexpected shape)` : ''}, ${new Date().toISOString()}.\n\n${rosterTable(proposal)}${freeList}\n`;
  process.stdout.write(`${md}\n`);
  writeStepSummary(md);
  if (!proposal.config) {
    process.stderr.write(
      proposal.missingSlots.length
        ? `No model matched for: ${proposal.missingSlots.join(', ')}. Update config/roster-rules.json.\n`
        : `Only ${proposal.participants.length} free models matched; a season needs at least ${MIN_FREE_PARTICIPANTS}. Update config/roster-rules.json.\n`,
    );
    return 1;
  }
  const out =
    flagString(args, 'out') ??
    (args.flags.write === true ? join(configDir(), 'models.json') : undefined);
  const json = `${JSON.stringify(proposal.config, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    process.stdout.write(`Wrote ${out} with "approved": false.\n`);
  }
  // Also in the log, so the proposed file can be reviewed and committed without downloading the
  // artifact. It holds only public model data.
  process.stdout.write(`\n--- proposed config/models.json ---\n${json}--- end ---\n`);
  return 0;
}

async function latestStoredDecisionSnapshot(db: pg.Pool): Promise<Snapshot | null> {
  const r = await db.query<{ id: string }>(
    "SELECT id FROM snapshots WHERE purpose = 'decision' AND status = 'ok' ORDER BY fetch_finished_at DESC LIMIT 1",
  );
  return r.rows[0] ? loadSnapshot(db, r.rows[0].id) : null;
}

/** pnpm engine decide --participant <slot|all> --dry */
export async function decideCommand(args: ParsedArgs): Promise<number> {
  if (args.flags.dry !== true) {
    process.stderr.write('Only `decide --dry` exists; real decisions are made by rounds.\n');
    return 2;
  }
  const ctx = baseContext();
  const models = must(loadModels());
  const universe = must(loadUniverse());
  const env = requireEnv(ctx.envCheck, ['OPENROUTER_API_KEY']);
  const which = flagString(args, 'participant') ?? 'all';
  const entries: ModelEntry[] =
    which === 'all' ? models.participants : models.participants.filter((p) => p.slot === which);
  if (!entries.length)
    throw new Error(
      `--participant must be one of: all, ${models.participants.map((p) => p.slot).join(', ')}`,
    );

  const now = new Date();
  const tradingDate = DateTime.fromJSDate(now, { zone: IST }).toISODate()!;
  const db = ctx.env.DATABASE_URL ? createPool(ctx.env.DATABASE_URL) : null;
  try {
    let snap: Snapshot | null = null;
    let snapNote = '';
    if (!inMarketHours(now) && db) {
      snap = await latestStoredDecisionSnapshot(db);
      if (snap)
        snapNote = `market closed: using the latest stored decision snapshot (${snap.finishedAt.toISOString()})`;
    }
    if (!snap) {
      const provider = angelProvider(ctx);
      const mapping = await freshMapping(provider, universe, ctx.arena);
      snap = await snapshotFor({
        session: await provider.login(),
        source: provider.source,
        purpose: 'decision',
        mapping,
        arena: ctx.arena,
      });
      snapNote = `live snapshot (${snap.verdict.status === 'ok' ? 'accepted' : `would be rejected: ${snap.verdict.reason}`})`;
    }
    const season =
      db && ctx.env.ARENA_MODE ? await currentSeason(db, ctx.env.ARENA_MODE, tradingDate) : null;
    const symbols = universe.constituents.map((c) => c.symbol);
    const market = await buildMarketBlock(
      db,
      snap,
      symbols,
      tradingDate,
      ctx.arena.marketData.indexName,
      ctx.arena.marketData.vixName,
    );
    const slots = slotTimes(ctx.arena);
    let seasonEnd = 'unknown';
    try {
      const cal = TradingCalendar.fromConfig([
        Number(tradingDate.slice(0, 4)),
        Number(tradingDate.slice(0, 4)) + 1,
      ]);
      seasonEnd = cal
        .tradingDaysFrom(
          season?.starts_on ?? tradingDate,
          season?.trading_days ?? ctx.arena.season.tradingDays,
        )
        .at(-1)!;
    } catch (e) {
      snapNote += `; season end unknown (${(e as Error).message})`;
    }
    const system =
      season?.system_prompt ??
      renderSystemPrompt(ctx.arena, ctx.fees, {
        seasonStart: season?.starts_on ?? tradingDate,
        seasonEnd,
        seasonTradingDays: season?.trading_days ?? ctx.arena.season.tradingDays,
        roundTimes: slots,
      });
    const client = new OpenRouterClient({ apiKey: env.OPENROUTER_API_KEY });
    const parts = season && db ? await seasonParticipants(db, season.id) : [];
    const startCash = BigInt(ctx.arena.startingCashPaise);
    const suspended = db ? await activeSuspensions(db) : new Set<string>();

    const results = await Promise.all(
      entries.map(async (entry) => {
        const part = parts.find((p) => p.slot === entry.slot);
        const portfolio: PortfolioState = (part && db
          ? await loadPortfolio(db, part.id)
          : null) ?? { cashPaise: startCash, positions: new Map() };
        const prices = await pricesWithFallback(db, snap!, [...portfolio.positions.keys()]);
        const priv = buildPrivateBlock({
          round: 0,
          roundsToday: slots.length,
          tradingDate,
          weekday: weekdayName(tradingDate),
          slot: DateTime.fromJSDate(now, { zone: IST }).toFormat('HH:mm'),
          seasonDay: 0,
          seasonDays: season?.trading_days ?? ctx.arena.season.tradingDays,
          nextRound: 'dry run',
          startingCashPaise: startCash,
          portfolio,
          prices,
          history: part && db && season ? await historyFor(db, season.id, part.id, null) : [],
          noteToSelf: part && db ? await lastNoteToSelf(db, part.id) : null,
          squareOffAt:
            ctx.arena.product === 'intraday_long_short' ? ctx.arena.intraday!.squareOffFrom : null,
          maxGrossExposurePct: ctx.arena.limits.maxGrossExposurePct,
          day: part && db ? await dayScoreFor(db, part.id, tradingDate, startCash) : null,
        });
        const rec = await decideWithModel({
          client,
          entry,
          system,
          user: renderUserMessage(priv, market.text),
          llm: ctx.arena.llm,
          noteMaxChars: ctx.arena.display.noteToSelfMaxChars,
        });
        const fillQuotes = new Map(
          snap!.quotes
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
        const exec = rec.decision
          ? executeActions(rec.decision.actions, portfolio, {
              universe: new Set(symbols),
              fillQuotes,
              valuationPrice: (s) => fillQuotes.get(s)?.ltpPaise ?? prices.get(s) ?? null,
              suspended,
              soldToday: part && db ? await soldToday(db, part.id, tradingDate) : new Set(),
              ...tradingLimits(ctx.arena),
              fees: ctx.fees,
            })
          : null;
        return { entry, rec, exec };
      }),
    );

    const rows = results.map(({ entry, rec, exec }) => [
      entry.slot,
      entry.openrouterId,
      rec.status,
      rec.servingModel ?? '—',
      rec.latencyMs === null ? '—' : `${rec.latencyMs} ms`,
      `${rec.inputTokens ?? '—'} / ${rec.outputTokens ?? '—'} (${rec.reasoningTokens ?? 0} reasoning)`,
      rec.costUsd === null
        ? '—'
        : `${formatUsd(rec.costUsd)}${rec.costEstimated ? ' (estimated)' : ''}`,
      exec
        ? exec.outcomes
            .map(
              (o) =>
                `${o.side ?? o.sideRaw} ${o.quantity ?? String(o.quantityRaw)} ${o.symbol ?? o.symbolRaw}: ${o.status === 'executed' ? 'valid' : o.rejectCode}`,
            )
            .join('; ') || 'no actions'
        : (rec.errorDetail ?? '—'),
    ]);
    const md = `## decide --dry (${which})\n\nMarket data: ${snapNote}. Portfolio: ${season ? `season ${season.id}` : 'no active season: starting cash'}. No ledger writes.\n\n${mdTable(['Slot', 'Model', 'Status', 'Serving model', 'Latency', 'Tokens in/out', 'Cost', 'Actions (validated, not executed)'], rows)}\n`;
    process.stdout.write(`${md}\n`);
    writeStepSummary(md);
    return results.every((r) => r.rec.status === 'OK') ? 0 : 1;
  } finally {
    await db?.end();
  }
}
