import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../src/migrate';

/** Admin connection to a local or CI Postgres. Test databases are always named *_test. */
export const ADMIN_URL =
  process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const ROLE_PASSWORD = 'arena_local_test_only';

function withDb(url: string, db: string, user?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = ROLE_PASSWORD;
  }
  return u.toString();
}

export interface TestDb {
  name: string;
  ownerUrl: string;
  engineUrl: string;
  webUrl: string;
  drop: () => Promise<void>;
}

export async function createTestDb(prefix = 'arena'): Promise<TestDb> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}_test`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const ownerUrl = withDb(ADMIN_URL, name);
  await migrate(ownerUrl);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query(`ALTER ROLE engine_rw PASSWORD '${ROLE_PASSWORD}'`);
  await owner.query(`ALTER ROLE web_ro PASSWORD '${ROLE_PASSWORD}'`);
  await owner.end();
  return {
    name,
    ownerUrl,
    engineUrl: withDb(ADMIN_URL, name, 'engine_rw'),
    webUrl: withDb(ADMIN_URL, name, 'web_ro'),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function client(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
