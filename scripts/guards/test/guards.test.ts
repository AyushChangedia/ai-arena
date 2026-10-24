import { describe, it, expect } from 'vitest';
import { checkNoMock, checkNoOrders, runAllGuards, isTestPath } from '../guards';

// Planted strings are built from fragments so this test file itself stays clean if ever scanned.
const j = (...p: string[]) => p.join('');

describe('guard: no mock data (SPEC §19.6)', () => {
  const clean = { path: 'packages/engine/src/core/x.ts', content: 'export const a = 1;\n' };
  it('passes clean source', () => {
    expect(checkNoMock([clean])).toEqual([]);
  });
  it.each([
    j('import { fa', 'ker } from "@fa', 'ker-js/fa', 'ker";'),
    j('const t = "lor', 'em ipsum";'),
    j('const x = Math.ran', 'dom();'),
    j('// use ', 'mo', 'ck prices'),
    j('const d = ', 'dum', 'my;'),
    j('load sam', 'ple data here'),
  ])('fails on planted violation: %s', (line) => {
    const v = checkNoMock([{ path: 'packages/engine/src/core/x.ts', content: line }]);
    expect(v.length).toBe(1);
  });
  it('allows anything under test/', () => {
    expect(
      checkNoMock([{ path: 'packages/engine/test/x.test.ts', content: j('Math.ran', 'dom()') }]),
    ).toEqual([]);
  });
  it('fails when non-test code imports from a test/ path', () => {
    const v = checkNoMock([
      { path: 'apps/web/src/a.ts', content: "import x from '../test/fixtures/a';" },
    ]);
    expect(v[0]?.guard).toBe('no-test-imports');
  });
  it('recognises test paths', () => {
    expect(isTestPath('packages/engine/test/a.ts')).toBe(true);
    expect(isTestPath('packages/engine/src/latest.ts')).toBe(false);
  });
});

describe('guard: no broker orders (SPEC §19.6)', () => {
  it('passes clean source', () => {
    expect(
      checkNoOrders([
        { path: 'a.ts', content: 'fetch("/rest/secure/angelbroking/market/v1/quote")' },
      ]),
    ).toEqual([]);
  });
  it.each([
    j('api.place', 'Order()'),
    j('modify', 'Order'),
    j('cancel', 'Order'),
    j('"/rest/secure/angelbroking/ord', 'er/v1/x"'),
  ])('fails on planted violation: %s', (line) => {
    expect(checkNoOrders([{ path: 'a.ts', content: line }]).length).toBe(1);
  });
  it('ignores markdown files', () => {
    expect(runAllGuards([{ path: 'SPEC.md', content: j('place', 'Order') }])).toEqual([]);
  });
});
