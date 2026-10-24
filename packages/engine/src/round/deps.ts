import type pg from 'pg';
import type { Logger } from 'pino';
import type { ArenaConfig, FeesConfig, Universe, ModelsConfig, Env } from '@arena/shared/schemas';
import type { TradingCalendar } from '../data/calendar';
import type { MarketDataProvider } from '../data/provider';
import type { OpenRouterClient } from '../llm/openrouter';
import type { Alerter } from '../ops/alerts';

/** Everything a tick needs. Providers are created lazily so a missing optional service never blocks a tick. */
export interface Deps {
  arena: ArenaConfig;
  fees: FeesConfig;
  universe: Universe;
  calendar: TradingCalendar;
  models: ModelsConfig | null;
  env: Env;
  db: pg.Pool;
  provider: () => MarketDataProvider;
  llm: () => OpenRouterClient;
  log: Logger;
  alerts: Alerter;
  now: () => Date;
  tickId: string;
  /** Where end-of-day exports are written (repo root by default). */
  exportDir: string;
}
