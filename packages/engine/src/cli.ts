#!/usr/bin/env tsx
import { ConfigError, NotImplementedError, errorMessage } from '@arena/shared/errors';
import { parseArgs } from './ops/args';
import { createLogger } from './ops/logger';
import { writeStepSummary } from './ops/summary';
import { commands } from './commands';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0];
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    process.stdout.write(
      `Usage: pnpm engine <command>\n\nCommands:\n${Object.entries(commands)
        .map(([k, c]) => `  ${k.padEnd(16)} ${c.help}`)
        .join('\n')}\n`,
    );
    return name ? 2 : 0;
  }
  return cmd.run({ ...args, _: args._.slice(1) });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const log = createLogger();
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration problem: ${err.message}\nHow to fix: ${err.fix}\n`);
      writeStepSummary(`### Configuration problem\n\n${err.message}\n\nHow to fix: ${err.fix}\n`);
      process.exitCode = 78;
      return;
    }
    if (err instanceof NotImplementedError) {
      log.error({ err }, 'not implemented');
      process.exitCode = 70;
      return;
    }
    log.error({ err }, `command failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  },
);
