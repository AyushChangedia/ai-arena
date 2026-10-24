import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  arenaConfigSchema,
  feesConfigSchema,
  modelsConfigSchema,
  universeSchema,
  calendarSchema,
  rosterRulesSchema,
  envSchema,
  cleanEnv,
  ENV_VARS,
  type ArenaConfig,
  type FeesConfig,
  type ModelsConfig,
  type Universe,
  type MarketCalendar,
  type RosterRules,
  type Env,
  type EnvVarName,
} from '@arena/shared/schemas';
import { ConfigError } from '@arena/shared/errors';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../../..');
/** The config directory; ARENA_CONFIG_DIR overrides it (tests). Read at call time. */
export const configDir = (): string => process.env.ARENA_CONFIG_DIR ?? join(REPO_ROOT, 'config');

export type LoadResult<T> =
  | { ok: true; value: T; path: string }
  | { ok: false; missing: boolean; path: string; error: string; fix: string };

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

export function loadJson<T>(
  rel: string,
  schema: z.ZodType<T>,
  fixHint: string,
  dir = configDir(),
): LoadResult<T> {
  const path = join(dir, rel);
  if (!existsSync(path))
    return { ok: false, missing: true, path, error: `${rel} is missing.`, fix: fixHint };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      missing: false,
      path,
      error: `${rel} is not valid JSON: ${(e as Error).message}`,
      fix: `Fix the JSON syntax in config/${rel}.`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      missing: false,
      path,
      error: `${rel} is invalid: ${formatIssues(parsed.error.issues)}`,
      fix: `Correct the named field(s) in config/${rel}.`,
    };
  }
  return { ok: true, value: parsed.data, path };
}

export const loadArena = (dir?: string) =>
  loadJson<ArenaConfig>(
    'arena.json',
    arenaConfigSchema,
    'Restore config/arena.json from git.',
    dir,
  );
export const loadFees = (dir?: string) =>
  loadJson<FeesConfig>('fees.json', feesConfigSchema, 'Restore config/fees.json from git.', dir);
export const loadModels = (dir?: string) =>
  loadJson<ModelsConfig>(
    'models.json',
    modelsConfigSchema,
    'Generate it with `pnpm engine roster --tier budget --write` (or smoke.yml → roster), then approve it. See SETUP.md.',
    dir,
  );
export const loadRosterRules = (dir?: string) =>
  loadJson<RosterRules>(
    'roster-rules.json',
    rosterRulesSchema,
    'Restore config/roster-rules.json from git.',
    dir,
  );
export const loadUniverse = (dir?: string) =>
  loadJson<Universe>(
    'universe/nifty50.json',
    universeSchema,
    'Download the Nifty 50 list from niftyindices.com and run `pnpm engine import-universe --csv <file>`. See SETUP.md.',
    dir,
  );
export const loadCalendar = (year: number, dir?: string) =>
  loadJson<MarketCalendar>(
    `calendar/nse-${year}.json`,
    calendarSchema,
    `Download NSE's ${year} trading holiday list and run \`pnpm engine import-holidays --year ${year} --file <file>\`. See SETUP.md.`,
    dir,
  );

/** Unwraps a load result or throws a ConfigError naming the file and the fix. */
export function must<T>(r: LoadResult<T>): T {
  if (r.ok) return r.value;
  throw new ConfigError(r.error, r.fix);
}

export interface EnvCheck {
  env: Env;
  problems: { name: EnvVarName; message: string; fix: string }[];
}

export function parseEnv(raw: Record<string, string | undefined> = process.env): EnvCheck {
  const cleaned = cleanEnv(raw);
  const parsed = envSchema.safeParse(cleaned);
  if (parsed.success) return { env: parsed.data, problems: [] };
  const problems = parsed.error.issues.map((i) => {
    const name = String(i.path[0]) as EnvVarName;
    return { name, message: `${name} is invalid: ${i.message}.`, fix: ENV_VARS[name]?.how ?? '' };
  });
  // Keep the valid fields so callers can still report what is configured.
  const partial: Record<string, unknown> = { ...cleaned };
  for (const p of problems) delete partial[p.name];
  return { env: envSchema.parse(partial), problems };
}

/** Throws a ConfigError for the first missing or invalid variable among `names`. */
export function requireEnv<K extends EnvVarName>(
  check: EnvCheck,
  names: K[],
): Required<Pick<Env, K>> {
  for (const n of names) {
    const bad = check.problems.find((p) => p.name === n);
    if (bad) throw new ConfigError(bad.message, bad.fix);
    if (check.env[n] === undefined) throw new ConfigError(`${n} is missing.`, ENV_VARS[n].how);
  }
  return check.env as Required<Pick<Env, K>>;
}
