import type { ParsedArgs } from './ops/args';
import { runDoctor, renderDoctor } from './ops/doctor';
import { serviceChecks } from './ops/service-checks';
import { rosterCommand, decideCommand } from './commands/llm';
import {
  tickCommand,
  replayCommand,
  reconcileCommand,
  verifyLedgerCommand,
  anchorCommitCommand,
  adminCommand,
} from './commands/ops';
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
  tick: { help: '[--dry] [--manual]: the scheduled entry point (SPEC §12.1)', run: tickCommand },
  replay: {
    help: '--round <id|random> [--count n]: recompute stored rounds and compare ledger hashes',
    run: replayCommand,
  },
  reconcile: {
    help: '[--season id] [--date YYYY-MM-DD]: rebuild from the ledger and compare',
    run: reconcileCommand,
  },
  'verify-ledger': {
    help: '[--file ledger.jsonl] [--prev-hash h]: verify a hash chain',
    run: verifyLedgerCommand,
  },
  'anchor-commit': {
    help: '--date YYYY-MM-DD[,..] --sha <commit>: record the git commit of an anchor',
    run: anchorCommitCommand,
  },
  admin: {
    help: '<pause|resume|retire|corp-action|clear-flag|resolve-incident|start-season|correct>',
    run: adminCommand,
  },
  'record-fixtures': {
    help: '[--out dir]: record sanitised Angel One responses (smoke.yml)',
    run: recordAngelFixtures,
  },
};
