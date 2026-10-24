import 'server-only';
import type { Sql } from '@arena/db/read';

/**
 * The web app's only database access: the read-only role over public views (SPEC §2.1.1).
 * Neon's HTTP driver in production; node-postgres for a local or CI test database.
 */
let cached: Sql | null = null;

export class DataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

export async function getSql(): Promise<Sql> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL_READONLY;
  if (!url) throw new DataUnavailableError('DATABASE_URL_READONLY is not set');
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    cached = { query: async (text, params) => (await pool.query(text, params as unknown[])).rows };
  } else {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    cached = {
      query: async (text, params) => (await sql.query(text, (params ?? []) as unknown[])) as never,
    };
  }
  return cached;
}
