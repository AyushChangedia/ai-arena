import { defineConfig } from 'vitest/config';

const all = process.env.COVERAGE_SCOPE === 'all';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'scripts/**/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: all
        ? ['packages/shared/src/**', 'packages/engine/src/**']
        : ['packages/shared/src/**', 'packages/engine/src/core/**'],
      exclude: ['**/index.ts', 'packages/shared/src/schemas/env.ts'],
      thresholds: {
        'packages/shared/src/**': { lines: 95, branches: 95 },
        'packages/engine/src/core/**': { lines: 95, branches: 95 },
        ...(all ? { 'packages/engine/src/**': { lines: 80, branches: 80 } } : {}),
      },
    },
  },
});
