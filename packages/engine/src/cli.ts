#!/usr/bin/env tsx
import { fileURLToPath } from 'node:url';
import { ConfigError, NotImplementedError, errorMessage } from '@arena/shared/errors';
import { parseArgs } from './ops/args';
import { createLogger } from './ops/logger';
import { writeStepSummary } from './ops/summary';
import { commands } from './commands';

/** Runs one CLI command and returns its exit code. Configuration errors exit 78 with how to fix them. */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
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
  try {
    return await cmd.run({ ...args, _: args._.slice(1) });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration problem: ${err.message}\nHow to fix: ${err.fix}\n`);
      writeStepSummary(`### Configuration problem\n\n${err.message}\n\nHow to fix: ${err.fix}\n`);
      return 78;
    }
    const log = createLogger();
    if (err instanceof NotImplementedError) {
      log.error({ err }, 'not implemented');
      return 70;
    }
    log.error({ err }, `command failed: ${errorMessage(err)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
