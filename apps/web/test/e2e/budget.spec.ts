import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';

/** SPEC §16.8: JavaScript on the arena page ≤ 170 KB gzipped, excluding the lazily loaded chart. */
test('arena page JavaScript budget', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'measured once');
  const js = new Set<string>();
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') js.add(r.url());
  });
  await page.goto('http://localhost:3100/');
  await page.waitForLoadState('networkidle');
  let total = 0;
  let chart = 0;
  for (const url of js) {
    const body = await (await request.get(url)).body();
    const gz = gzipSync(body).length;
    if (
      body.includes('lightweight-charts') ||
      body.includes('LightweightCharts') ||
      body.includes('createChart')
    )
      chart += gz;
    else total += gz;
  }
  console.log(
    `arena JS: ${(total / 1024).toFixed(1)} KB gzipped (+ chart ${(chart / 1024).toFixed(1)} KB lazily loaded)`,
  );
  expect(chart).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(170 * 1024);
});
