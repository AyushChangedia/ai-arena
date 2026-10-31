import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const P = { populated: 3100, empty: 3101, paused: 3102, unreachable: 3103 };
const at = (port: number, path: string) => `http://localhost:${port}${path}`;

async function axe(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    ),
  ).toEqual([]);
}

async function noHorizontalScroll(page: Page, what: string) {
  const [sw, iw, offenders] = await page.evaluate(() => {
    const vw = window.innerWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > vw + 1)
      .slice(0, 4)
      .map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`);
    return [document.documentElement.scrollWidth, vw, wide.join(', ')] as const;
  });
  expect(sw, `${what} scrolls horizontally (${offenders})`).toBeLessThanOrEqual(iw);
}

async function shot(page: Page, name: string, project: string) {
  await page.screenshot({ path: `test-results/screens/${project}/${name}.png`, fullPage: true });
}

async function firstHref(page: Page, prefix: string): Promise<string> {
  const href = await page.locator(`a[href^="${prefix}"]`).first().getAttribute('href');
  expect(href).toBeTruthy();
  return href!;
}

test.describe('populated shadow season', () => {
  test('arena page: score bug, chart, latest round, standings, blunders, footer', async ({
    page,
  }, info) => {
    await page.goto(at(P.populated, '/'));
    await expect(
      page.getByText(
        'Private preview. These rounds are a test run and will be reset before Season 1.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: /Score bug/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Round \d+ at \d\d:\d\d IST/ })).toBeVisible();
    await expect(
      page.getByText(/^Portfolio value over the season for every participant/),
    ).toBeAttached();
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(
      page.getByText(/AI Arena is an experiment in how AI models make decisions/),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/lorem|NaN|undefined|Infinity/i);
    await page.waitForTimeout(500);
    await noHorizontalScroll(page, '/');
    await shot(page, 'arena', info.project.name);
    await axe(page);
  });

  test('model panels: start, worth now, profit or loss in colour, last round, portfolio', async ({
    page,
  }) => {
    await page.goto(at(P.populated, '/'));
    const section = page.getByRole('region', { name: 'The models' });
    await expect(section).toBeVisible();
    const cards = section.getByRole('article');
    expect(await cards.count()).toBe(5); // the five test models; benchmarks stay in the standings
    for (const card of await cards.all()) {
      await expect(card.getByText('Started with')).toBeVisible();
      // The value next to "Started with" (worth now can round to ₹1,00,000 too).
      await expect(card.locator('dt:text-is("Started with") + dd')).toHaveText('₹1,00,000');
      await expect(card.getByText(/^Last round, \d\d:\d\d IST$/)).toBeVisible();
      await expect(card.getByRole('rowheader', { name: 'Cash' })).toBeVisible();
    }
    // Profit is green with ▲ and +, loss red with ▼ and −; colour is never the only cue.
    const changes = section.locator('.text-gain, .text-loss');
    expect(await changes.count()).toBeGreaterThan(0);
    for (const el of await changes.all()) {
      const [cls, text] = [(await el.getAttribute('class')) ?? '', await el.innerText()];
      if (cls.includes('text-gain')) expect(text).toMatch(/^▲ \+/);
      else expect(text).toMatch(/^▼ −/);
    }
    await expect(
      section.getByRole('rowheader').filter({ hasNotText: 'Cash' }).first(),
    ).toBeVisible();
  });

  test('trades explain themselves: strategy, why and exit plan; shorts and the square-off', async ({
    page,
  }) => {
    await page.goto(at(P.populated, '/models/openai'));
    await expect(page.getByRole('columnheader', { name: 'Why' })).toBeVisible();
    await expect(page.getByText(/^Shorted 2 [A-H]{3}$/).first()).toBeVisible();
    await expect(
      page.getByText(/fell below its opening range on heavy volume/).first(),
    ).toBeVisible();
    await expect(
      page.getByText('Exit plan: Buy back 1% lower, or if it reclaims the open.').first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(
          'Square-off: the engine closed the position (intraday rule, nothing is held overnight).',
        )
        .first(),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Thinking' }).click();
    await expect(
      page.getByText(/openai: momentum\. Buy stocks breaking out/).first(),
    ).toBeVisible();
    await page.goto(at(P.populated, '/'));
    const section = page.getByRole('region', { name: 'The models' });
    await expect(section.getByText('Strategy', { exact: true }).first()).toBeVisible();
    await expect(
      section.getByText(/^Intraday: every position is closed by 15:15 IST\.$/).first(),
    ).toBeVisible();
    await page.goto(at(P.populated, '/rounds'));
    await expect(page.getByText('Square-off at 15:02 IST')).toBeVisible();
    await page.goto(at(P.populated, '/rules'));
    await expect(
      page.getByText(
        /^From 15:00 IST \(by 15:15 at the latest\) the engine closes every open position/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: '0.03% or ₹20.00, whichever is lower' }),
    ).toBeVisible();
  });

  test('every page renders and is axe-clean', async ({ page }, info) => {
    await page.goto(at(P.populated, '/rounds'));
    const roundHref = await firstHref(page, '/rounds/');
    const pages = [
      '/rounds',
      roundHref,
      '/models/openai',
      '/models/monkey',
      '/models/nifty50',
      '/status',
      '/verify',
      '/rules',
      '/seasons/S0',
    ];
    for (const p of pages) {
      const res = await page.goto(at(P.populated, p));
      expect(res?.status(), p).toBe(200);
      await expect(page.locator('main')).toBeVisible();
      expect(await page.locator('body').innerText()).not.toMatch(/NaN|undefined|Infinity/);
      await noHorizontalScroll(page, p);
      await shot(page, p.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'root', info.project.name);
      await axe(page);
    }
    await page.goto(at(P.populated, roundHref));
    const tradeHref = await firstHref(page, '/trades/');
    await page.goto(at(P.populated, tradeHref));
    await expect(page.getByRole('button', { name: 'Check this trade' })).toBeVisible();
    await shot(page, 'trade', info.project.name);
    await axe(page);
  });

  test('Check this trade confirms an untouched trade', async ({ page }) => {
    await page.goto(at(P.populated, '/rounds'));
    await page.goto(at(P.populated, await firstHref(page, '/rounds/')));
    await page.goto(at(P.populated, await firstHref(page, '/trades/')));
    await page.getByRole('button', { name: 'Check this trade' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'This trade matches the public ledger.' }),
    ).toBeVisible();
  });

  test('Check a whole day verifies the chain against the anchor', async ({ page }) => {
    await page.goto(at(P.populated, '/verify'));
    await page.getByRole('button', { name: 'Check a whole day' }).click();
    await expect(
      page.getByText(/entries for 2026-10-19 verify, and the last hash matches the day's anchor/),
    ).toBeVisible();
  });

  test('keyboard: skip link, tabs with arrow keys, sortable standings', async ({ page }, info) => {
    await page.goto(at(P.populated, '/models/openai'));
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.getByRole('tab', { name: 'Trades' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Thinking' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Thinking' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    if (info.project.name === 'desktop-1280') {
      await page.goto(at(P.populated, '/'));
      const btn = page.getByRole('button', { name: /^Return/ }).first();
      await btn.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('th[aria-sort="descending"]').first()).toBeVisible();
    }
  });

  test('security headers are set and the CSP blocks nothing the site uses', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    const res = await page.goto(at(P.populated, '/'));
    const h = res!.headers();
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    await expect(page.locator('canvas').first()).toBeVisible();
    await page.goto(at(P.populated, '/verify'));
    await page.getByRole('button', { name: 'Check a whole day' }).click();
    await expect(page.getByText(/verify, and the last hash matches/)).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('revalidation endpoint rejects a bad secret and accepts the right one', async ({
    request,
  }) => {
    const bad = await request.post(at(P.populated, '/api/revalidate'), {
      headers: { Authorization: 'Bearer nope' },
      data: { tags: ['live'] },
    });
    expect(bad.status()).toBe(401);
    const ok = await request.post(at(P.populated, '/api/revalidate'), {
      headers: { Authorization: 'Bearer e2e-revalidate-secret-0123456789abcdef' },
      data: { tags: ['live'] },
    });
    expect(ok.status()).toBe(200);
  });

  test('404 page in the site voice', async ({ page }) => {
    for (const bad of ['/rounds/not-a-round', '/trades/abc', '/models/gpt-9', '/seasons/../x']) {
      const r = await page.goto(at(P.populated, bad));
      expect(r?.status(), bad).toBe(404);
    }
    await expect(page.getByRole('link', { name: 'Back to the arena' })).toBeVisible();
    await axe(page);
    // A well-formed id that doesn't exist: the same page, streamed with noindex (Next.js streams 404s after the shell).
    await page.goto(at(P.populated, '/rounds/00000000-0000-4000-8000-000000000000'));
    await expect(page.getByRole('heading', { name: 'Nothing on the board here.' })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  });
});

test.describe('states', () => {
  test('before the season: start date and countdown, no chart or table', async ({ page }, info) => {
    await page.goto(at(P.empty, '/'));
    await expect(
      page.getByRole('heading', { name: /starts \w+day \d+ \w+ at 9:30 IST\./ }),
    ).toBeVisible();
    await expect(page.getByText(/Starts in/)).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    // The line-up is shown before the first round: each model starts with ₹1,00,000 in cash.
    const cards = page.getByRole('region', { name: 'The models' }).getByRole('article');
    expect(await cards.count()).toBe(5);
    await expect(cards.first().getByText('No trades yet')).toBeVisible();
    await expect(cards.first().getByText('All cash:')).toBeVisible();
    await shot(page, 'pre-season', info.project.name);
    await axe(page);
  });

  test('paused: amber banner with the public message', async ({ page }, info) => {
    await page.goto(at(P.paused, '/'));
    await expect(
      page.getByText('Rounds are paused: the arena is out of API credit.').first(),
    ).toBeVisible();
    await expect(page.getByText(/Holdings haven't changed since/)).toBeVisible();
    await shot(page, 'paused', info.project.name);
    await axe(page);
  });

  test('Check this trade reports a planted mismatch', async ({ page }) => {
    await page.goto(at(P.paused, '/trades/7'));
    await page.getByRole('button', { name: 'Check this trade' }).click();
    await expect(page.getByRole('status').filter({ hasText: /does not match/ })).toBeVisible();
  });

  test('records unreachable: plain message, never zeros', async ({ page }, info) => {
    await page.goto(at(P.unreachable, '/'));
    await expect(
      page.getByText("The arena's records aren't reachable right now. Try again in a few minutes."),
    ).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/₹0\.00|₹0\b/);
    await shot(page, 'unreachable', info.project.name);
    await axe(page);
  });
});
