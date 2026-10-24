import { describe, it, expect } from 'vitest';
import { runDoctor, renderDoctor } from '../src/ops/doctor';
import { serviceChecks } from '../src/ops/service-checks';
import { parseEnv, requireEnv } from '../src/config/load';
import { parseArgs } from '../src/ops/args';

describe('pnpm doctor (Phase 0)', () => {
  it('reports every check and fails with nothing configured', async () => {
    const { results, ok } = await runDoctor(serviceChecks(), {});
    expect(ok).toBe(false);
    const names = results.map((r) => r.name);
    for (const n of [
      'env DATABASE_URL',
      'env OPENROUTER_API_KEY',
      'config arena.json',
      'Angel One login',
      'Telegram',
    ])
      expect(names).toContain(n);
    expect(results.find((r) => r.name === 'Telegram')?.status).toBe('not configured');
    const md = renderDoctor(results, ok);
    expect(md).toContain('required checks failing');
  });
  it('never prints secret values', async () => {
    const secret = 'sk-or-v1-NOTREAL1234567890';
    const { results, ok } = await runDoctor([], { OPENROUTER_API_KEY: secret, ANGEL_MPIN: 'abc' });
    const md = renderDoctor(results, ok);
    expect(md).not.toContain(secret);
    expect(md).toContain('ANGEL_MPIN is invalid');
  });
  it('runs probes and records failures without throwing', async () => {
    const { results } = await runDoctor(
      [
        { name: 'p1', required: false, needs: [], probe: async () => 'fine' },
        {
          name: 'p2',
          required: false,
          needs: [],
          probe: async () => {
            throw new Error('boom');
          },
        },
        { name: 'p3', required: false, needs: [] },
      ],
      {},
    );
    expect(results.find((r) => r.name === 'p1')?.status).toBe('pass');
    expect(results.find((r) => r.name === 'p2')?.detail).toBe('boom');
    expect(results.find((r) => r.name === 'p3')?.status).toBe('skipped');
  });
  it('requireEnv names the missing variable and how to fix it', () => {
    expect(() => requireEnv(parseEnv({}), ['ANGEL_TOTP_SECRET'])).toThrow(
      /ANGEL_TOTP_SECRET is missing/,
    );
    expect(() => requireEnv(parseEnv({ ARENA_MODE: 'x' }), ['ARENA_MODE'])).toThrow(
      /ARENA_MODE is invalid/,
    );
    expect(requireEnv(parseEnv({ ARENA_MODE: 'shadow' }), ['ARENA_MODE']).ARENA_MODE).toBe(
      'shadow',
    );
  });
  it('parses CLI args', () => {
    expect(parseArgs(['tick', '--dry', '--round', 'abc', '--x=1'])).toEqual({
      _: ['tick'],
      flags: { dry: true, round: 'abc', x: '1' },
    });
  });
});
