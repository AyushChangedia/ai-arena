import type { Logger } from 'pino';
import type { Queryable } from '@arena/db';
import { httpJson, redactUrl, type FetchLike } from '../data/http';

/** Healthchecks.io pings (optional). Failures are logged, never fatal. */
export class Healthchecks {
  constructor(
    private readonly url: string | undefined,
    private readonly log: Logger,
    private readonly fetchImpl?: FetchLike,
  ) {}
  async ping(kind: 'start' | 'success' | 'fail', body?: string): Promise<void> {
    if (!this.url) return;
    const url = kind === 'success' ? this.url : `${this.url.replace(/\/$/, '')}/${kind}`;
    try {
      const r = await httpJson({
        url,
        method: 'POST',
        body: body ? { summary: body.slice(0, 10_000) } : undefined,
        timeoutMs: 10_000,
        fetchImpl: this.fetchImpl,
      });
      if (!r.ok)
        this.log.warn({ status: r.status, url: redactUrl(url) }, 'healthchecks ping not accepted');
    } catch (e) {
      this.log.warn({ err: e }, 'healthchecks ping failed');
    }
  }
}

export async function recordHeartbeat(
  db: Queryable,
  outcome: string,
  detail: Record<string, unknown>,
  at = new Date(),
): Promise<void> {
  await db.query('INSERT INTO heartbeats (at, outcome, detail) VALUES ($1,$2,$3)', [
    at,
    outcome,
    JSON.stringify(detail),
  ]);
}
