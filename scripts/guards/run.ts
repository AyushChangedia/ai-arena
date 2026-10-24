import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { runAllGuards, isScannedSource, type SourceFile } from './guards';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((p) => p && isScannedSource(p) && existsSync(p))
  .map<SourceFile>((path) => ({ path, content: readFileSync(path, 'utf8') }));

const violations = runAllGuards(files);
if (violations.length) {
  for (const v of violations) process.stderr.write(`[${v.guard}] ${v.path}:${v.line}  ${v.text}\n`);
  process.stderr.write(`\n${violations.length} guard violation(s).\n`);
  process.exit(1);
}
process.stdout.write(`guards: ${files.length} files scanned, no violations\n`);
