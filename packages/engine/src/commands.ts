import type { ParsedArgs } from './ops/args';
import { runDoctor, renderDoctor } from './ops/doctor';
import { serviceChecks } from './ops/service-checks';
import { writeStepSummary } from './ops/summary';

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
};
