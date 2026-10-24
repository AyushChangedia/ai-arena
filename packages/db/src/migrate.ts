import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 7_311_001; // advisory lock id for migrations

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/** Applies pending migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(
  connectionString: string,
  dir = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    for (const file of migrationFiles(dir)) {
      if (done.has(file)) {
        result.alreadyApplied.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((e: unknown) => {
      process.stderr.write(`could not release migration lock: ${(e as Error).message}\n`);
    });
    await client.end();
  }
  return result;
}

/** Pending migration names, for doctor. */
export async function pendingMigrations(
  client: { query: pg.Client['query'] },
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const exists = await client.query<{ t: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS t",
  );
  if (!exists.rows[0]?.t) return migrationFiles(dir);
  const done = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );
  return migrationFiles(dir).filter((f) => !done.has(f));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    process.stderr.write(
      'DATABASE_URL_OWNER is missing. Add it in GitHub → Settings → Secrets and variables → Actions (owner role connection string from Neon).\n',
    );
    process.exit(78);
  }
  migrate(url).then(
    (r) => {
      const msg = `migrations applied: ${r.applied.length ? r.applied.join(', ') : 'none'}; already applied: ${r.alreadyApplied.length}\n`;
      process.stdout.write(msg);
      if (process.env.GITHUB_STEP_SUMMARY) {
        void import('node:fs').then((fs) =>
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY as string, `## Migrations\n\n${msg}`),
        );
      }
    },
    (e: unknown) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
