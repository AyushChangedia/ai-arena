/**
 * The scheduled entry point (SPEC §12.1). Idempotent: run it as often as you like.
 */
import { DateTime } from 'luxon';
import { errorMessage } from '@arena/shared/errors';
import { mdTable } from '../ops/summary';
import { recordHeartbeat } from '../ops/heartbeat';
import { revalidateIfDue } from '../ops/revalidate';
import { openIncident } from '../ops/incidents';
import { runRound, runSquareOff, type RoundSummary } from './runner';
import { runPreMarket, startJob, endJob, jobStatus } from './premarket';
import { runEndOfDay } from './eod';
import { abortStaleRounds, recordMissedSlots, recordPausedSlot } from './recovery';
import { exportDay } from './export';
import { dueSlot, isBetween, isAfter, istNow } from './schedule';
import { currentSeason, heldSymbols, isPaused, type SeasonRow } from './store';
import { mappingFromDb, snapshotFor, summariseSnapshot } from '../data/market';
import type { Deps } from './deps';

export interface TickResult {
  ran: string[];
  rounds: RoundSummary[];
  exported: string[];
  summary: string;
  ok: boolean;
}

export interface TickOptions {
  dry: boolean;
  mode: 'shadow' | 'live';
  trigger: 'cron' | 'manual';
}

export async function tick(d: Deps, opts: TickOptions): Promise<TickResult> {
  const now = d.now();
  const today = istNow(now).toISODate()!;
  const ran: string[] = [];
  const rounds: RoundSummary[] = [];
  const exported: string[] = [];
  const notes: string[] = [];
  let ok = true;

  const paused = await isPaused(d.db);
  const tradingDay = d.calendar.isTradingDay(today);
  const season = tradingDay ? await currentSeason(d.db, opts.mode, today) : null;
  if (opts.mode === 'live' && season && !d.models?.approved) {
    notes.push('Live season found but config/models.json is not approved: no rounds run.');
    await openIncident(
      d.db,
      {
        key: 'roster:not-approved',
        severity: 'critical',
        title: 'Roster not approved',
        detail: 'Set "approved": true in config/models.json after review.',
        publicMessage: 'The season has not started yet.',
        scope: 'arena',
      },
      now,
    );
    await recordHeartbeat(d.db, 'blocked', { reason: 'roster not approved', tick: d.tickId }, now);
    return { ran, rounds, exported, ok: false, summary: render(now, ran, rounds, exported, notes) };
  }

  if (opts.dry) {
    notes.push(
      'Dry run: checks config, database, schedule and market data. No database writes, model calls, alerts or revalidation.',
    );
    const slot = season ? dueSlot(d.arena, today, now) : null;
    notes.push(
      `Trading day: ${tradingDay}. Season: ${season?.id ?? 'none'}${season ? ` (${season.status})` : ''}. Paused: ${paused.paused}. Due slot: ${slot ?? 'none'}.`,
    );
    if (slot && season) {
      try {
        const provider = d.provider();
        const mapping = await mappingFromDb(d.db, d.universe, d.arena);
        const snap = await snapshotFor({
          session: await provider.login(),
          source: provider.source,
          purpose: 'decision',
          mapping,
          arena: d.arena,
          now: d.now,
        });
        notes.push(`Decision snapshot (not stored): ${summariseSnapshot(snap)}`);
      } catch (e) {
        ok = false;
        notes.push(`Market data check failed: ${errorMessage(e)}`);
      }
    }
    return { ran, rounds, exported, ok, summary: render(now, ran, rounds, exported, notes) };
  }

  // Crash recovery first: a stale RUNNING round is never resumed.
  const aborted = await abortStaleRounds(d);
  if (aborted.length) ran.push(`aborted ${aborted.length} stale round(s)`);

  if (!tradingDay) {
    await recordHeartbeat(d.db, 'closed', { tick: d.tickId }, now);
    notes.push(`Market closed today (${d.calendar.holidayName(today) ?? 'weekend'}).`);
    return { ran, rounds, exported, ok, summary: render(now, ran, rounds, exported, notes) };
  }

  // Step 6b: the intraday square-off. It also runs while the arena is paused, so no position is held
  // overnight, unless the pause is for a reconciliation mismatch (the numbers are under review).
  const squareOff = async (s: SeasonRow) => {
    const io = d.arena.product === 'intraday_long_short' ? d.arena.intraday : undefined;
    if (!io || !isBetween(now, io.squareOffFrom, d.arena.schedule.endOfDayAfter)) return;
    if (!(await heldSymbols(d.db, s.id)).length) return;
    try {
      const r = await runSquareOff(d, s, today, opts.trigger);
      if (r.status !== 'OWNED_ELSEWHERE' && r.status !== 'NOTHING_OPEN') {
        rounds.push(r);
        ran.push(r.slot);
      }
    } catch (e) {
      ok = false;
      d.log.error({ err: e }, 'square-off failed with an unexpected error');
      ran.push(`square-off (engine error: ${errorMessage(e)})`);
    }
  };

  // Step 2: paused.
  if (paused.paused) {
    if (season) {
      await recordMissedSlots(d, season, today, paused);
      const slot = dueSlot(d.arena, today, now);
      if (slot && (await recordPausedSlot(d, season, today, slot, paused.reason)))
        ran.push(`slot ${slot} recorded as paused`);
      if (paused.reason !== 'reconciliation_mismatch') await squareOff(season);
    }
    await recordHeartbeat(d.db, 'paused', { reason: paused.reason, tick: d.tickId }, now);
    notes.push(`Arena paused: ${paused.reason ?? 'no reason'}.`);
    return { ran, rounds, exported, ok, summary: render(now, ran, rounds, exported, notes) };
  }

  // Step 4: pre-market job.
  const pre = d.arena.schedule.preMarketWindow;
  if (
    isBetween(now, pre.from, pre.to) &&
    (await jobStatus(d, today, 'premarket')) !== 'ok' &&
    (await startJob(d, today, 'premarket'))
  ) {
    try {
      const detail = await runPreMarket(d, season, today);
      await endJob(d, today, 'premarket', 'ok', detail);
      ran.push('pre-market job');
    } catch (e) {
      ok = false;
      await endJob(d, today, 'premarket', 'failed', { error: errorMessage(e) });
      await openIncident(
        d.db,
        {
          key: `premarket:${today}`,
          severity: 'warn',
          title: 'Pre-market job failed',
          detail: errorMessage(e),
          publicMessage: 'Some indicators may be missing today.',
          scope: 'arena',
        },
        now,
      );
      await d.alerts.raise({
        key: `premarket:${today}`,
        severity: 'warn',
        text: `Pre-market job failed: ${errorMessage(e)}`,
      });
      ran.push('pre-market job (failed)');
    }
  }

  if (season) {
    // Step 5: missed slots.
    const missed = await recordMissedSlots(d, season, today, paused);
    if (missed.length) ran.push(`recorded missed slot(s) ${missed.join(', ')}`);
    // Step 6: the due slot.
    const slot = dueSlot(d.arena, today, now);
    if (slot) {
      try {
        const s = await runRound(d, season, today, slot, opts.trigger);
        if (s.status !== 'OWNED_ELSEWHERE') {
          rounds.push(s);
          ran.push(`round ${slot}`);
        }
      } catch (e) {
        ok = false;
        d.log.error({ err: e }, 'round failed with an unexpected error');
        ran.push(`round ${slot} (engine error: ${errorMessage(e)})`);
      }
    }
    await squareOff(season);
    // Step 7: end of day.
    if (
      isAfter(now, d.arena.schedule.endOfDayAfter) &&
      (await jobStatus(d, today, 'eod')) !== 'ok' &&
      (await startJob(d, today, 'eod'))
    ) {
      try {
        const r = await runEndOfDay(d, season, today);
        await endJob(d, today, 'eod', 'ok', {
          reconcile: r.reconcile.ok,
          problems: r.reconcile.problems.slice(0, 20),
          seasonFinished: r.seasonFinished,
        });
        if (r.squareOff) {
          rounds.push(r.squareOff);
          ran.push(`${r.squareOff.slot} (end of day)`);
        }
        ran.push(`end of day (reconciliation ${r.reconcile.ok ? 'ok' : 'MISMATCH'})`);
      } catch (e) {
        ok = false;
        await endJob(d, today, 'eod', 'failed', { error: errorMessage(e) });
        await d.alerts.raise({
          key: `eod:${today}`,
          severity: 'critical',
          text: `End of day failed: ${errorMessage(e)}`,
        });
        ran.push('end of day (failed)');
      }
    }
  }

  // Step 8: export once the day-end marks are public; retry a missed previous day.
  for (const date of [d.calendar.previousTradingDay(today), today]) {
    if ((await jobStatus(d, date, 'eod')) !== 'ok' || (await jobStatus(d, date, 'export')) === 'ok')
      continue;
    const m = await d.db.query<{ pending: number; n: number }>(
      "SELECT count(*) FILTER (WHERE reveal_at > $2)::int AS pending, count(*)::int AS n FROM marks WHERE kind = 'eod' AND (marked_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date",
      [date, now],
    );
    if (!m.rows[0]?.n || m.rows[0].pending > 0) continue;
    if (!(await startJob(d, date, 'export'))) continue;
    try {
      const r = await exportDay(
        d.db,
        date,
        d.exportDir,
        d.arena.publishFullMarketTable === 'after_close',
      );
      await endJob(d, date, 'export', 'ok', { files: r.files.length, anchor: r.anchor });
      exported.push(date);
      ran.push(`export ${date}`);
    } catch (e) {
      ok = false;
      await endJob(d, date, 'export', 'failed', { error: errorMessage(e) });
      ran.push(`export ${date} (failed)`);
    }
  }

  // Step 9: revalidation.
  const rv = await revalidateIfDue(d.db, {
    baseUrl: d.env.WEB_BASE_URL,
    secret: d.env.REVALIDATE_SECRET,
    log: d.log,
    now,
  });
  if (rv === 'ok') ran.push('revalidated the site');

  await d.alerts.flush();
  await recordHeartbeat(d.db, ok ? 'ok' : 'error', { ran, tick: d.tickId }, now);
  return { ran, rounds, exported, ok, summary: render(now, ran, rounds, exported, notes) };
}

function render(
  now: Date,
  ran: string[],
  rounds: RoundSummary[],
  exported: string[],
  notes: string[],
): string {
  const t = DateTime.fromJSDate(now, { zone: 'Asia/Kolkata' }).toFormat('yyyy-MM-dd HH:mm');
  const parts = [`## Tick ${t} IST`, '', `Ran: ${ran.length ? ran.join('; ') : 'nothing due'}.`];
  for (const n of notes) parts.push('', n);
  for (const r of rounds) {
    parts.push('', `### Round ${r.slot}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`, '');
    if (r.detail) parts.push(`Detail: ${r.detail}`, '');
    if (r.participants.length) {
      parts.push(
        mdTable(
          ['Participant', 'Status', 'Latency', 'Cost (USD)', 'Actions'],
          r.participants.map((p) => [
            p.slot,
            p.status,
            p.latencyMs === null ? '—' : `${p.latencyMs} ms`,
            p.costUsd === null ? '—' : p.costUsd.toFixed(6),
            p.actions,
          ]),
        ),
      );
    }
    if (r.incidents.length) parts.push('', `Incidents: ${r.incidents.join('; ')}`);
  }
  if (exported.length) parts.push('', `Exported: ${exported.join(', ')}`);
  return parts.join('\n');
}
