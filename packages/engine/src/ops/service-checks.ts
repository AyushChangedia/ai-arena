import pg from 'pg';
import { pendingMigrations } from '@arena/db';
import type { ServiceCheck } from './doctor';
import { baseContext, angelProvider } from '../config/context';

async function probeDatabase(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await c.connect();
  try {
    const pending = await pendingMigrations(c);
    if (pending.length)
      throw new Error(
        `connected, but migrations are pending: ${pending.join(', ')}. Run migrate.yml.`,
      );
    const s = await c.query<{ paused: boolean }>('SELECT paused FROM arena_state WHERE id = 1');
    return `connected; migrations up to date; arena ${s.rows[0]?.paused ? 'paused' : 'running'}`;
  } finally {
    await c.end();
  }
}

/** Live-service checks for `pnpm run doctor` (SPEC §7.3). Extra probes are appended by later phases. */
export function serviceChecks(extra: ServiceCheck[] = []): ServiceCheck[] {
  return [
    {
      name: 'database connection + migrations',
      required: true,
      needs: ['DATABASE_URL'],
      probe: async (ctx) => probeDatabase(ctx.envCheck.env.DATABASE_URL!),
    },
    {
      name: 'Angel One login',
      required: true,
      needs: ['ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_MPIN', 'ANGEL_TOTP_SECRET'],
      probe: async () => {
        await angelProvider(baseContext()).loginJwt();
        return 'login succeeded (session token not stored)';
      },
    },
    { name: 'OpenRouter key + credit', required: true, needs: ['OPENROUTER_API_KEY'] },
    { name: 'OpenRouter model IDs + parameters', required: true, needs: ['OPENROUTER_API_KEY'] },
    { name: 'Telegram', required: false, needs: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
    { name: 'Healthchecks', required: false, needs: ['HEALTHCHECKS_PING_URL'] },
    {
      name: 'revalidation endpoint',
      required: false,
      needs: ['WEB_BASE_URL', 'REVALIDATE_SECRET'],
    },
    ...extra,
  ];
}
