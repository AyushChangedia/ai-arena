import type { ArenaConfig, FeesConfig, Env } from '@arena/shared/schemas';
import { must, loadArena, loadFees, parseEnv, requireEnv, type EnvCheck } from './load';
import { AngelOneProvider } from '../data/angelone';

export interface BaseContext {
  arena: ArenaConfig;
  fees: FeesConfig;
  envCheck: EnvCheck;
  env: Env;
}

/** Loads and validates config and env before any work (SPEC §7.2). */
export function baseContext(raw: Record<string, string | undefined> = process.env): BaseContext {
  const envCheck = parseEnv(raw);
  return { arena: must(loadArena()), fees: must(loadFees()), envCheck, env: envCheck.env };
}

export function angelProvider(ctx: BaseContext): AngelOneProvider {
  const e = requireEnv(ctx.envCheck, [
    'ANGEL_API_KEY',
    'ANGEL_CLIENT_CODE',
    'ANGEL_MPIN',
    'ANGEL_TOTP_SECRET',
  ]);
  const md = ctx.arena.marketData;
  return new AngelOneProvider(
    {
      apiKey: e.ANGEL_API_KEY,
      clientCode: e.ANGEL_CLIENT_CODE,
      mpin: e.ANGEL_MPIN,
      totpSecret: e.ANGEL_TOTP_SECRET,
    },
    {
      apiRoot: md.apiRoot,
      instrumentMasterUrl: md.instrumentMasterUrl,
      timeoutMs: md.requestTimeoutSeconds * 1000,
      quoteBatchSize: md.quoteBatchSize,
      quoteRequestsPerSecond: md.quoteRequestsPerSecond,
      candleRequestsPerSecond: md.candleRequestsPerSecond,
    },
  );
}
