import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ADMIN_URL } from './helpers';
import { checkPassword, passwordsFromEnv, setRolePasswords } from '../src/role-passwords';

// A throwaway role, so the shared engine_rw / web_ro test passwords are never touched.
const role = `pw_${randomBytes(4).toString('hex')}_test`;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin((c) => c.query(`CREATE ROLE ${role} LOGIN`)); // no password, as the migration does
});
afterAll(async () => {
  await admin((c) => c.query(`DROP ROLE IF EXISTS ${role}`));
});

describe('role passwords (migrate.yml)', () => {
  it('sets a password the role can then log in with', async () => {
    const pw = randomBytes(24).toString('hex');
    expect(await setRolePasswords(ADMIN_URL, { [role]: pw })).toEqual([role]);
    const u = new URL(ADMIN_URL);
    u.username = role;
    u.password = pw;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    expect((await c.query<{ who: string }>('SELECT current_user AS who')).rows[0]?.who).toBe(role);
    await c.end();
  });

  it('never puts the password in an error message', async () => {
    const pw = 'Abc123' + randomBytes(12).toString('hex');
    const err = await setRolePasswords(ADMIN_URL, { no_such_role_test: pw }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/could not set the password for no_such_role_test/);
    expect((err as Error).message).not.toContain(pw);
  });

  it('accepts only long letters-and-digits passwords and skips unset secrets', () => {
    expect(() => checkPassword('ENGINE_RW_PASSWORD', 'a'.repeat(24))).not.toThrow();
    expect(() => checkPassword('ENGINE_RW_PASSWORD', 'short1')).toThrow(/at least 24/);
    expect(() => checkPassword('WEB_RO_PASSWORD', `${'a'.repeat(30)}@x`)).toThrow(
      /WEB_RO_PASSWORD/,
    );
    expect(passwordsFromEnv({})).toEqual({});
    expect(passwordsFromEnv({ WEB_RO_PASSWORD: 'b'.repeat(30) })).toEqual({
      web_ro: 'b'.repeat(30),
    });
  });
});
