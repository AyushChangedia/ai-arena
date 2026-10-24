import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, redact, secretValuesFromEnv, REDACTED } from '../src/ops/logger';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('logger redaction (SPEC §2.3.2)', () => {
  const env = {
    OPENROUTER_API_KEY: 'sk-or-v1-THISISNOTAREALKEY000000000000',
    ANGEL_MPIN: '482913',
    ANGEL_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    DATABASE_URL: 'postgres://engine_rw:hunter2pass@host/db',
  };
  const secrets = secretValuesFromEnv(env);

  it('never writes configured secret values or secret-named fields', async () => {
    const { lines, stream } = capture();
    const log = createLogger({ secrets, destination: stream, tickId: 't1' });
    log.info(
      {
        headers: { Authorization: 'Bearer abc.def', 'X-PrivateKey': 'pk' },
        body: `key=${env.OPENROUTER_API_KEY}`,
      },
      'calling',
    );
    log.info({ nested: [{ jwtToken: 'eyJhbGciOi' }, { password: 'p' }], cookie: 'c=1' });
    log.error(
      { err: new Error(`login failed for mpin ${env.ANGEL_MPIN}`) },
      `db ${env.DATABASE_URL}`,
    );
    log.info(`totp secret ${env.ANGEL_TOTP_SECRET} in message`);
    await new Promise((r) => setTimeout(r, 10));
    const out = lines.join('');
    for (const v of Object.values(env)) expect(out).not.toContain(v);
    for (const v of ['abc.def', 'eyJhbGciOi', '"pk"', 'c=1']) expect(out).not.toContain(v);
    expect(out).toContain(REDACTED);
    expect(out).toContain('"tick_id":"t1"');
  });

  it('redacts keys by pattern and keeps other values', () => {
    const r = redact(
      { symbol: 'TCS', api_key: 'x', nested: { refreshToken: 'y', qty: 3 } },
      [],
    ) as Record<string, unknown>;
    expect(r).toEqual({
      symbol: 'TCS',
      api_key: REDACTED,
      nested: { refreshToken: REDACTED, qty: 3 },
    });
  });

  it('ignores very short env values to avoid redacting common substrings', () => {
    expect(secretValuesFromEnv({ ANGEL_MPIN: '12' })).toEqual([]);
  });
});
