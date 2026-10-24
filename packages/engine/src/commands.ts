import type { ParsedArgs } from './ops/args';
import { runDoctor, renderDoctor } from './ops/doctor';
import { serviceChecks } from './ops/service-checks';
import { rosterCommand, decideCommand } from './commands/llm';
import { writeStepSummary } from './ops/summary';
import {
  snapshotDry,
  importUniverse,
  importHolidays,
  recordAngelFixtures,
} from './commands/market';

export interface Command {
  help: string;
  run: (args: ParsedArgs) => Promise<number>;
}

export const commands: Record<string, Command> = {
  doctor: {
    help: 'Check env, config and live services. Never prints secret values.',
    run: async () => {
      const { results, ok } = await runDoctor(serviceChecks());
      const md = renderDoctor(results, ok);
      process.stdout.write(`${md}\n`);
      writeStepSummary(md);
      return ok ? 0 : 1;
    },
  },
  snapshot: {
    help: '--dry: log in to Angel One, fetch and validate quotes, print a table. No DB writes.',
    run: snapshotDry,
  },
  'import-universe': {
    help: '--csv <file> --effective-from YYYY-MM-DD: write config/universe/nifty50.json',
    run: importUniverse,
  },
  'import-holidays': {
    help: '--year YYYY --file <json|csv>: write config/calendar/nse-YYYY.json',
    run: importHolidays,
  },
  roster: {
    help: '--tier budget|flagship [--write | --out path]: propose the roster from OpenRouter (no key needed)',
    run: rosterCommand,
  },
  decide: {
    help: '--participant <slot|all> --dry: real prompt, real model call, validated answer. No ledger writes.',
    run: decideCommand,
  },
  'record-fixtures': {
    help: '[--out dir]: record sanitised Angel One responses (smoke.yml)',
    run: recordAngelFixtures,
  },
};
