/**
 * Guard checks (SPEC §19.6). Each guard is a pure function over (path, content) pairs so the
 * self-tests can plant violations. Patterns are assembled from fragments so this file does not
 * trip its own checks.
 */
export interface SourceFile {
  path: string;
  content: string;
}
export interface Violation {
  guard: string;
  path: string;
  line: number;
  text: string;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|yml|yaml)$/;
const IGNORED_DIRS =
  /(^|\/)(node_modules|\.next|coverage|dist|public-data|test-results|playwright-report)\//;

/** Test code lives only under a `test/` directory (SPEC §2.1.3). */
export function isTestPath(p: string): boolean {
  return /(^|\/)test\//.test(p);
}

export function isScannedSource(p: string): boolean {
  return (
    SOURCE_EXT.test(p) &&
    !IGNORED_DIRS.test(p) &&
    !p.endsWith('pnpm-lock.yaml') &&
    !p.endsWith('package-lock.json')
  );
}

function scan(
  files: SourceFile[],
  guard: string,
  patterns: RegExp[],
  allow: (p: string) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!isScannedSource(f.path) || isTestPath(f.path) || allow(f.path)) continue;
    const lines = f.content.split('\n');
    lines.forEach((text, i) => {
      for (const re of patterns) {
        if (re.test(text)) {
          out.push({ guard, path: f.path, line: i + 1, text: text.trim().slice(0, 160) });
          break;
        }
      }
    });
  }
  return out;
}

const w = (...parts: string[]) => parts.join('');

/** No fake data outside test/. */
export const NO_MOCK_PATTERNS: RegExp[] = [
  new RegExp(w('\\bfak', 'er\\b'), 'i'),
  new RegExp(w('lor', 'em'), 'i'),
  new RegExp(w('\\bmo', 'ck'), 'i'),
  new RegExp(w('\\bdum', 'my\\b'), 'i'),
  new RegExp(w('sample', ' data'), 'i'),
  new RegExp(w('Math\\.ran', 'dom')),
];
/** Files allowed to use the patterns above. The Monkey uses a seeded PRNG and needs no entry. */
export const NO_MOCK_ALLOWLIST: string[] = ['scripts/guards/guards.ts'];

export function checkNoMock(files: SourceFile[]): Violation[] {
  const v = scan(files, 'no-mock-data', NO_MOCK_PATTERNS, (p) => NO_MOCK_ALLOWLIST.includes(p));
  // Non-test code must never import from a test/ path.
  const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const f of files) {
    if (!isScannedSource(f.path) || isTestPath(f.path)) continue;
    f.content.split('\n').forEach((text, i) => {
      for (const m of text.matchAll(importRe)) {
        if (/(^|\/)test(\/|$)/.test(m[1] ?? ''))
          v.push({ guard: 'no-test-imports', path: f.path, line: i + 1, text: text.trim() });
      }
    });
  }
  return v;
}

/** No broker order calls anywhere outside test/. */
export const NO_ORDER_PATTERNS: RegExp[] = [
  new RegExp(w('place', 'Order'), 'i'),
  new RegExp(w('modify', 'Order'), 'i'),
  new RegExp(w('cancel', 'Order'), 'i'),
  new RegExp(w('/ord', 'er/')),
];

export function checkNoOrders(files: SourceFile[]): Violation[] {
  return scan(files, 'no-broker-orders', NO_ORDER_PATTERNS, () => false);
}

export function runAllGuards(files: SourceFile[]): Violation[] {
  return [...checkNoMock(files), ...checkNoOrders(files)];
}
