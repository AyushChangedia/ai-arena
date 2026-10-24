import { randomUUID } from 'node:crypto';
import { openIncident } from '../ops/incidents';
import { slotInstant, expiredSlots } from './schedule';
import type { Deps } from './deps';
import type { SeasonRow } from './store';

/**
 * Crash recovery (SPEC §12.8): a round still RUNNING 15+ minutes after it started is ABORTED.
 * Participants whose execution committed keep their fills; everyone else is MISSED_ABORTED.
 */
export async function abortStaleRounds(d: Deps): Promise<string[]> {
  const now = d.now();
  const cutoff = new Date(now.getTime() - d.arena.schedule.staleRunningMinutes * 60_000);
  const stale = await d.db.query<{ id: string; season_id: string; d: string; t: string }>(
    "SELECT id, season_id, to_char(trading_date,'YYYY-MM-DD') AS d, to_char(slot_time,'HH24:MI') AS t FROM rounds WHERE status = 'RUNNING' AND started_at < $1",
    [cutoff],
  );
  const reveal = new Date(now.getTime() + d.arena.season.publicDelayMinutes * 60_000);
  const out: string[] = [];
  for (const r of stale.rows) {
    const parts = await d.db.query<{ id: string }>(
      "SELECT id FROM participants WHERE season_id = $1 AND kind <> 'index'",
      [r.season_id],
    );
    for (const p of parts.rows) {
      const committed = await d.db.query(
        'SELECT 1 FROM actions a JOIN decisions dd ON dd.id = a.decision_id WHERE dd.round_id = $1 AND dd.participant_id = $2 LIMIT 1',
        [r.id, p.id],
      );
      if (committed.rowCount) continue;
      const upd = await d.db.query(
        "UPDATE decisions SET status = 'MISSED_ABORTED', error_detail = coalesce(error_detail, 'round aborted') WHERE round_id = $1 AND participant_id = $2",
        [r.id, p.id],
      );
      if (!upd.rowCount) {
        await d.db.query(
          "INSERT INTO decisions (id, round_id, participant_id, status, error_detail) VALUES ($1,$2,$3,'MISSED_ABORTED','round aborted before this participant was recorded')",
          [randomUUID(), r.id, p.id],
        );
      }
    }
    await d.db.query(
      "UPDATE rounds SET status = 'ABORTED', status_reason = 'still running 15 minutes after it started', finished_at = $2, reveal_at = $3 WHERE id = $1",
      [r.id, now, reveal],
    );
    await d.db.query('UPDATE decisions SET reveal_at = $2 WHERE round_id = $1', [r.id, reveal]);
    await openIncident(
      d.db,
      {
        key: `aborted:${r.id}`,
        severity: 'critical',
        title: `Round ${r.d} ${r.t} aborted`,
        detail: 'The run crashed or was killed mid-round. Completed executions were kept.',
        publicMessage: 'Round aborted.',
        scope: 'round',
      },
      now,
    );
    await d.alerts.raise({
      key: `aborted:${r.id}`,
      severity: 'critical',
      text: `Round ${r.d} ${r.t} aborted (crash mid-round).`,
    });
    out.push(r.id);
  }
  return out;
}

/** Records slots whose grace window passed with no round: MISSED_SCHEDULE, or SKIPPED_PAUSED while paused. */
export async function recordMissedSlots(
  d: Deps,
  season: SeasonRow,
  tradingDate: string,
  paused: { paused: boolean; reason: string | null },
): Promise<string[]> {
  if (tradingDate < season.starts_on) return [];
  const now = d.now();
  const out: string[] = [];
  for (const slot of expiredSlots(d.arena, tradingDate, now)) {
    const status = paused.paused ? 'SKIPPED_PAUSED' : 'MISSED_SCHEDULE';
    const reason = paused.paused
      ? `arena paused: ${paused.reason ?? 'no reason given'}`
      : 'the scheduler did not run within the grace window';
    const r = await d.db.query(
      `INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, finished_at, reveal_at, status, status_reason, trigger)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7,$8,'cron') ON CONFLICT (season_id, trading_date, slot_time) DO NOTHING`,
      [
        randomUUID(),
        season.id,
        tradingDate,
        slot,
        slotInstant(tradingDate, slot),
        now,
        status,
        reason,
      ],
    );
    if (r.rowCount) {
      out.push(slot);
      if (!paused.paused) {
        await openIncident(
          d.db,
          {
            key: `schedule:missed:${tradingDate}:${slot}`,
            severity: 'warn',
            title: `Round ${tradingDate} ${slot} missed`,
            detail: 'No tick ran inside the grace window.',
            publicMessage: "Round missed: scheduler didn't run.",
            scope: 'round',
          },
          now,
        );
        await d.alerts.raise({
          key: `schedule:missed:${tradingDate}`,
          severity: 'warn',
          text: `Round ${tradingDate} ${slot} missed: the scheduler didn't run in time.`,
        });
      }
    }
  }
  return out;
}

/** A due slot while paused is recorded as SKIPPED_PAUSED so it isn't mistaken for a scheduler miss (SPEC §12.1). */
export async function recordPausedSlot(
  d: Deps,
  season: SeasonRow,
  tradingDate: string,
  slot: string,
  reason: string | null,
): Promise<boolean> {
  const now = d.now();
  const r = await d.db.query(
    `INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, finished_at, reveal_at, status, status_reason, trigger)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$6,'SKIPPED_PAUSED',$7,'cron') ON CONFLICT (season_id, trading_date, slot_time) DO NOTHING`,
    [
      randomUUID(),
      season.id,
      tradingDate,
      slot,
      slotInstant(tradingDate, slot),
      now,
      `arena paused: ${reason ?? 'no reason given'}`,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}
