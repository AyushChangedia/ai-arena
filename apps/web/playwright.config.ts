import { defineConfig } from '@playwright/test';

/**
 * End-to-end + accessibility suite (SPEC §19.5). Each server seeds its own *_test database, then serves the
 * production build (built without a database, so nothing is baked in at build time).
 */
const PG = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const ro = (db: string) => {
  const u = new URL(PG);
  u.pathname = `/${db}`;
  u.username = 'web_ro';
  u.password = 'arena_local_test_only';
  return u.toString();
};
const SECRET = 'e2e-revalidate-secret-0123456789abcdef';
const server = (port: number, scenario: string | null, db: string | null, mode = 'shadow') => ({
  command: `${scenario && db ? `pnpm exec tsx test/e2e/seed.ts ${scenario} ${db} && ` : ''}pnpm exec next start -p ${port}`,
  port,
  timeout: 180_000,
  reuseExistingServer: false,
  env: {
    TEST_PG_URL: PG,
    ARENA_MODE: mode,
    REVALIDATE_SECRET: SECRET,
    ...(db ? { DATABASE_URL_READONLY: ro(db) } : {}),
  },
});

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  outputDir: 'test-results/output',
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'mobile-375',
      use: {
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: [
    server(3100, 'populated', 'arena_e2e_pop_test'),
    server(3101, 'empty', 'arena_e2e_empty_test'),
    server(3102, 'paused', 'arena_e2e_paused_test'),
    server(3103, null, null),
  ],
});
