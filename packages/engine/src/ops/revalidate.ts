import type { Logger } from 'pino';
import type { Queryable } from '@arena/db';
import { httpJson, type FetchLike } from '../data/http';

/**
 * Calls the web app's POST /api/revalidate (SPEC §16.8) when a reveal time has passed since the last call.
 * Skipped with a log line while WEB_BASE_URL is unset (SPEC §21 Phase 4).
 */
export async function revalidateIfDue(
  db: Queryable,
  opts: {
    baseUrl?: string;
    secret?: string;
    log: Logger;
    now: Date;
    fetchImpl?: FetchLike;
    tags?: string[];
    force?: boolean;
  },
): Promise<'skipped-unconfigured' | 'not-due' | 'ok' | 'failed'> {
  if (!opts.baseUrl || !opts.secret) {
    opts.log.info('revalidation skipped: WEB_BASE_URL or REVALIDATE_SECRET not set');
    return 'skipped-unconfigured';
  }
  const last = await db.query<{ at: Date }>(
    "SELECT max(at) AS at FROM heartbeats WHERE outcome = 'revalidated'",
  );
  const lastAt = last.rows[0]?.at ?? new Date(0);
  const due = await db.query(
    `SELECT 1 FROM (SELECT reveal_at FROM rounds UNION ALL SELECT reveal_at FROM marks WHERE kind = 'eod') x
     WHERE reveal_at > $1 AND reveal_at <= $2 LIMIT 1`,
    [lastAt, opts.now],
  );
  if (!opts.force && (due.rowCount ?? 0) === 0) return 'not-due';
  const tags = opts.tags ?? ['live'];
  try {
    const r = await httpJson({
      url: `${opts.baseUrl.replace(/\/$/, '')}/api/revalidate`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.secret}` },
      body: { tags },
      timeoutMs: 20_000,
      fetchImpl: opts.fetchImpl,
    });
    if (!r.ok) {
      opts.log.warn({ status: r.status }, 'revalidation rejected');
      return 'failed';
    }
    await db.query("INSERT INTO heartbeats (at, outcome, detail) VALUES ($1, 'revalidated', $2)", [
      opts.now,
      JSON.stringify({ tags }),
    ]);
    return 'ok';
  } catch (e) {
    opts.log.warn({ err: e }, 'revalidation failed');
    return 'failed';
  }
}
