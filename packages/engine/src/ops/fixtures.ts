import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubString, secretValuesFromEnv } from './logger';

const SENSITIVE_KEY =
  /(jwt|refresh|feed)token|clientcode|client_code|password|totp|mpin|authorization|api[-_]?key|privatekey/i;

/** Removes session tokens, account identifiers and literal secrets from a recorded response. */
export function sanitize(value: unknown, secrets = secretValuesFromEnv()): unknown {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[removed]' : sanitize(v, secrets),
      ]),
    );
  }
  return value;
}

export class FixtureRecorder {
  private n = 0;
  readonly files: string[] = [];
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  record(name: string, payload: unknown): void {
    this.n++;
    const file = join(
      this.dir,
      `${String(this.n).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.recorded.json`,
    );
    writeFileSync(
      file,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), label: 'recorded', ...(sanitize(payload) as object) }, null, 2)}\n`,
    );
    this.files.push(file);
  }
}
