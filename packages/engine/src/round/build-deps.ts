import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { createPool } from '@arena/db';
import { must, loadUniverse, loadModels, requireEnv, REPO_ROOT } from '../config/load';
import { baseContext, angelProvider } from '../config/context';
import { TradingCalendar } from '../data/calendar';
import { OpenRouterClient } from '../llm/openrouter';
import { createLogger } from '../ops/logger';
import { Alerter, TelegramSink } from '../ops/alerts';
import type { MarketDataProvider } from '../data/provider';
import type { Deps } from './deps';

/** Builds the tick's dependencies from config and env. Fails before any work if something required is wrong. */
export function buildDeps(raw: Record<string, string | undefined> = process.env): Deps {
  const ctx = baseContext(raw);
  const env = requireEnv(ctx.envCheck, ['DATABASE_URL', 'ARENA_MODE']);
  const universe = must(loadUniverse());
  const year = DateTime.now().setZone('Asia/Kolkata').year;
  const calendar = TradingCalendar.fromConfig([year - 1, year, year + 1]);
  const models = loadModels();
  if (!models.ok && !models.missing) throw new Error(models.error);
  const tickId = randomUUID().slice(0, 8);
  const log = createLogger({ tickId });
  const db = createPool(env.DATABASE_URL);
  const runUrl =
    raw.GITHUB_RUN_ID && raw.GITHUB_REPOSITORY
      ? `${raw.GITHUB_SERVER_URL ?? 'https://github.com'}/${raw.GITHUB_REPOSITORY}/actions/runs/${raw.GITHUB_RUN_ID}`
      : null;
  const statusUrl = ctx.env.WEB_BASE_URL
    ? `${ctx.env.WEB_BASE_URL.replace(/\/$/, '')}/status`
    : null;
  const sink =
    ctx.env.TELEGRAM_BOT_TOKEN && ctx.env.TELEGRAM_CHAT_ID
      ? new TelegramSink(ctx.env.TELEGRAM_BOT_TOKEN, ctx.env.TELEGRAM_CHAT_ID)
      : null;
  let provider: MarketDataProvider | null = null;
  let llm: OpenRouterClient | null = null;
  return {
    arena: ctx.arena,
    fees: ctx.fees,
    universe,
    calendar,
    models: models.ok ? models.value : null,
    env: ctx.env,
    db,
    provider: () => (provider ??= angelProvider(ctx)),
    llm: () =>
      (llm ??= new OpenRouterClient({
        apiKey: requireEnv(ctx.envCheck, ['OPENROUTER_API_KEY']).OPENROUTER_API_KEY,
      })),
    log,
    alerts: new Alerter(db, sink, log, { runUrl, statusUrl }),
    now: () => new Date(),
    tickId,
    exportDir: REPO_ROOT,
  };
}
