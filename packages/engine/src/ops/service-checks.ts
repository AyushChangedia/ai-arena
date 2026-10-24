import pg from 'pg';
import { pendingMigrations } from '@arena/db';
import type { ServiceCheck } from './doctor';
import { baseContext, angelProvider } from '../config/context';
import { OpenRouterClient } from '../llm/openrouter';
import { loadModels } from '../config/load';
import { buildChatRequest } from '../llm/request';

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
    {
      name: 'OpenRouter key + credit',
      required: true,
      needs: ['OPENROUTER_API_KEY'],
      probe: async (ctx) => {
        const c = await new OpenRouterClient({
          apiKey: ctx.envCheck.env.OPENROUTER_API_KEY,
        }).remainingCreditUsd();
        const arena = baseContext().arena;
        if (c.remainingUsd !== null && c.remainingUsd < arena.llm.creditCriticalUsd)
          throw new Error(
            `key works, but only $${c.remainingUsd.toFixed(2)} of credit is left (${c.source})`,
          );
        return c.remainingUsd === null
          ? `key works; ${c.source}`
          : `key works; $${c.remainingUsd.toFixed(2)} left (${c.source})`;
      },
    },
    {
      name: 'OpenRouter model IDs + parameters',
      required: true,
      needs: ['OPENROUTER_API_KEY'],
      probe: async () => {
        const m = loadModels();
        if (!m.ok) throw new Error(m.error);
        const { models } = await new OpenRouterClient({}).listModels();
        const arena = baseContext().arena;
        const problems: string[] = [];
        for (const p of m.value.participants) {
          const live = models.find((x) => x.id === p.openrouterId);
          if (!live) {
            problems.push(`${p.slot}: ${p.openrouterId} is not listed`);
            continue;
          }
          const sent = Object.keys(buildChatRequest(p, [], arena.llm)).filter((k) =>
            ['max_tokens', 'temperature', 'reasoning', 'response_format'].includes(k),
          );
          const supported = new Set(live.supported_parameters ?? []);
          const missing = sent.filter((k) => !supported.has(k));
          if (missing.length) problems.push(`${p.slot}: no longer supports ${missing.join(', ')}`);
        }
        if (problems.length) throw new Error(problems.join('; '));
        return `all ${m.value.participants.length} models listed and support the parameters we send${m.value.approved ? '' : ' (roster not approved yet)'}`;
      },
    },
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
