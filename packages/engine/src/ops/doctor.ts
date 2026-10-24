import { ENV_VARS, type EnvVarName } from '@arena/shared/schemas';
import { errorMessage } from '@arena/shared/errors';
import {
  parseEnv,
  loadArena,
  loadFees,
  loadModels,
  loadUniverse,
  loadCalendar,
  loadRosterRules,
  type EnvCheck,
  type LoadResult,
} from '../config/load';
import { mdTable } from './summary';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'not configured' | 'skipped';

export interface CheckResult {
  name: string;
  required: boolean;
  status: CheckStatus;
  detail: string;
}

/** A live-service probe. Returns a detail string on success; throws on failure. */
export type Probe = (ctx: DoctorContext) => Promise<string>;

export interface DoctorContext {
  envCheck: EnvCheck;
  results: CheckResult[];
}

export interface ServiceCheck {
  name: string;
  required: boolean;
  needs: EnvVarName[];
  probe?: Probe;
}

function envRows(envCheck: EnvCheck): CheckResult[] {
  return (Object.keys(ENV_VARS) as EnvVarName[]).map((name) => {
    const meta = ENV_VARS[name];
    const required = meta.required === 'engine';
    const problem = envCheck.problems.find((p) => p.name === name);
    if (problem)
      return {
        name: `env ${name}`,
        required,
        status: 'fail',
        detail: `${problem.message} ${problem.fix}`,
      };
    if (envCheck.env[name] === undefined) {
      return { name: `env ${name}`, required, status: 'not configured', detail: meta.how };
    }
    return {
      name: `env ${name}`,
      required,
      status: 'pass',
      detail: name === 'ARENA_MODE' ? `set (${envCheck.env.ARENA_MODE})` : 'set',
    };
  });
}

function configRow<T>(
  name: string,
  r: LoadResult<T>,
  describe: (v: T) => string,
  required = true,
): CheckResult {
  if (r.ok) return { name, required, status: 'pass', detail: describe(r.value) };
  return {
    name,
    required,
    status: r.missing ? 'not configured' : 'fail',
    detail: `${r.error} ${r.fix}`,
  };
}

export function configChecks(now = new Date()): CheckResult[] {
  const year = Number(now.toISOString().slice(0, 4));
  const rows: CheckResult[] = [
    configRow(
      'config arena.json',
      loadArena(),
      (a) =>
        `${a.limits.maxActionsPerRound} actions/round, slots ${a.schedule.firstSlot}–${a.schedule.lastSlot}`,
    ),
    configRow('config fees.json', loadFees(), (f) =>
      f.verifiedOn ? `verified ${f.verifiedOn}` : 'loaded; rates not re-verified (see SETUP.md)',
    ),
    configRow('config roster-rules.json', loadRosterRules(), () => 'loaded'),
    configRow('config models.json', loadModels(), (m) =>
      m.approved
        ? `approved (${m.tier}): ${m.participants.map((p) => p.openrouterId).join(', ')}`
        : `NOT approved yet (${m.tier}); live seasons refuse to start, shadow allowed`,
    ),
    configRow(
      'config universe/nifty50.json',
      loadUniverse(),
      (u) => `${u.constituents.length} symbols, effective ${u.effectiveFrom}`,
    ),
    configRow(
      `config calendar/nse-${year}.json`,
      loadCalendar(year),
      (c) => `${c.holidays.length} holidays (${c.source})`,
    ),
  ];
  const models = rows[3]!;
  if (models.status === 'pass' && models.detail.startsWith('NOT approved')) models.status = 'warn';
  return rows;
}

export async function runDoctor(
  services: ServiceCheck[],
  raw: Record<string, string | undefined> = process.env,
): Promise<{ results: CheckResult[]; ok: boolean }> {
  const envCheck = parseEnv(raw);
  const results: CheckResult[] = [...envRows(envCheck), ...configChecks()];
  const ctx: DoctorContext = { envCheck, results };
  for (const s of services) {
    const missing = s.needs.filter((n) => envCheck.env[n] === undefined);
    if (missing.length) {
      results.push({
        name: s.name,
        required: s.required,
        status: 'not configured',
        detail: `needs ${missing.join(', ')}`,
      });
      continue;
    }
    if (!s.probe) {
      results.push({ name: s.name, required: s.required, status: 'skipped', detail: 'no probe' });
      continue;
    }
    try {
      const detail = await s.probe(ctx);
      results.push({ name: s.name, required: s.required, status: 'pass', detail });
    } catch (e) {
      results.push({ name: s.name, required: s.required, status: 'fail', detail: errorMessage(e) });
    }
  }
  const ok = results.every((r) => !r.required || r.status === 'pass' || r.status === 'warn');
  return { results, ok };
}

export function renderDoctor(results: CheckResult[], ok: boolean): string {
  const table = mdTable(
    ['Check', 'Required', 'Status', 'Detail'],
    results.map((r) => [r.name, r.required ? 'yes' : 'no', r.status, r.detail]),
  );
  return `## pnpm doctor\n\n${table}\n\n**Result: ${ok ? 'all required checks pass' : 'required checks failing'}**\n`;
}
