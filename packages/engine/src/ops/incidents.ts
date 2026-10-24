import { randomUUID } from 'node:crypto';
import type { Queryable } from '@arena/db';

export type Severity = 'info' | 'warn' | 'critical';

export interface IncidentInput {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  publicMessage: string;
  scope: string;
  participantId?: string | null;
}

export interface OpenedIncident extends IncidentInput {
  id: string;
  isNew: boolean;
}

/**
 * Opens an incident unless one with the same key is already open (stable keys deduplicate).
 * Returns whether it is new, so alerts fire once.
 */
export async function openIncident(
  db: Queryable,
  i: IncidentInput,
  at = new Date(),
): Promise<OpenedIncident> {
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM incidents WHERE key = $1 AND resolved_at IS NULL',
    [i.key],
  );
  if (existing.rows[0]) return { ...i, id: existing.rows[0].id, isNew: false };
  const id = randomUUID();
  const r = await db.query(
    `INSERT INTO incidents (id, key, severity, title, detail, public_message, scope, participant_id, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (key) WHERE resolved_at IS NULL DO NOTHING`,
    [
      id,
      i.key,
      i.severity,
      i.title,
      i.detail,
      i.publicMessage,
      i.scope,
      i.participantId ?? null,
      at,
    ],
  );
  return { ...i, id, isNew: (r.rowCount ?? 0) > 0 };
}

export async function resolveIncident(
  db: Queryable,
  key: string,
  at = new Date(),
): Promise<number> {
  const r = await db.query(
    'UPDATE incidents SET resolved_at = $2 WHERE key = $1 AND resolved_at IS NULL',
    [key, at],
  );
  return r.rowCount ?? 0;
}

export async function resolveIncidentsByPrefix(
  db: Queryable,
  prefix: string,
  at = new Date(),
): Promise<number> {
  const r = await db.query(
    "UPDATE incidents SET resolved_at = $2 WHERE key LIKE $1 || '%' AND resolved_at IS NULL",
    [prefix, at],
  );
  return r.rowCount ?? 0;
}

export async function openIncidentCount(db: Queryable, keyPrefix: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM incidents WHERE key LIKE $1 || '%' AND resolved_at IS NULL",
    [keyPrefix],
  );
  return r.rows[0]?.n ?? 0;
}
