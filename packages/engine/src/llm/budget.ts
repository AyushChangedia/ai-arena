import type { Queryable } from '@arena/db';
import { DateTime } from 'luxon';

/** Recorded spend for a participant in the current calendar month (IST), in USD. */
export async function monthSpendUsd(
  db: Queryable,
  participantId: string,
  now: Date,
): Promise<number> {
  const start = DateTime.fromJSDate(now, { zone: 'Asia/Kolkata' }).startOf('month').toJSDate();
  const r = await db.query<{ s: string | null }>(
    'SELECT sum(cost_usd)::text AS s FROM decisions WHERE participant_id = $1 AND created_at >= $2',
    [participantId, start],
  );
  return Number(r.rows[0]?.s ?? 0);
}

/**
 * At or above the cap → skip the call (SPEC §9.7). A cap of 0 belongs to a free model: it may run
 * at no cost, and is paused as soon as any call is billed.
 */
export function overBudget(spentUsd: number, capUsd: number): boolean {
  if (capUsd === 0) return spentUsd > 0;
  return spentUsd >= capUsd;
}
