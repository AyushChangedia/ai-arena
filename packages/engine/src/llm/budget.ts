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

/** At or above the cap → skip the call (SPEC §9.7). */
export function overBudget(spentUsd: number, capUsd: number): boolean {
  return spentUsd >= capUsd;
}
