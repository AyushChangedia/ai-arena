import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Sets the login passwords of the roles the migrations create (engine_rw, web_ro).
 * Neon's console can't reset the password of a role created without one, and its SQL editor
 * isn't always able to wake a suspended compute, so migrate.yml runs this with the passwords
 * from GitHub secrets. Password values are never printed.
 */
export const ROLE_PASSWORD_SECRETS = {
  engine_rw: 'ENGINE_RW_PASSWORD',
  web_ro: 'WEB_RO_PASSWORD',
} as const;

/** Letters and digits only, so the password goes into a connection URL without escaping. */
export function checkPassword(secretName: string, value: string): void {
  if (!/^[A-Za-z0-9]{24,}$/.test(value))
    throw new Error(
      `${secretName} must be at least 24 characters of letters and digits only (no symbols), so it works inside a connection URL. Replace the GitHub secret and run migrate again.`,
    );
}

/** Applies each password with ALTER ROLE. Returns the roles that were updated. */
export async function setRolePasswords(
  connectionString: string,
  passwords: Record<string, string>,
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const updated: string[] = [];
  try {
    for (const [role, password] of Object.entries(passwords)) {
      try {
        await client.query(
          `ALTER ROLE ${client.escapeIdentifier(role)} WITH PASSWORD ${client.escapeLiteral(password)}`,
        );
      } catch (e) {
        const msg = (e as Error).message.split(password).join('[redacted]');
        throw new Error(`could not set the password for ${role}: ${msg}`, { cause: e });
      }
      updated.push(role);
    }
  } finally {
    await client.end();
  }
  return updated;
}

/** Reads the passwords from the environment; roles whose secret is unset are left alone. */
export function passwordsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, secret] of Object.entries(ROLE_PASSWORD_SECRETS)) {
    const v = env[secret];
    if (!v) continue;
    checkPassword(secret, v);
    out[role] = v;
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const summary = (msg: string) => {
    process.stdout.write(msg);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Role passwords\n\n${msg}`);
  };
  const url = process.env.DATABASE_URL_OWNER;
  let passwords: Record<string, string>;
  try {
    passwords = passwordsFromEnv(process.env);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(78);
  }
  if (!Object.keys(passwords).length) {
    summary(
      'Role passwords: skipped (ENGINE_RW_PASSWORD and WEB_RO_PASSWORD are not set). Nothing changed.\n',
    );
  } else if (!url) {
    process.stderr.write('DATABASE_URL_OWNER is missing. Add it as a GitHub secret first.\n');
    process.exit(78);
  } else {
    setRolePasswords(url, passwords).then(
      (roles) => summary(`Role passwords set for: ${roles.join(', ')}.\n`),
      (e: unknown) => {
        process.stderr.write(`${(e as Error).message}\n`);
        process.exit(1);
      },
    );
  }
}
