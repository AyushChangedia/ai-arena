/**
 * Phase 2 acceptance: the ledger hash vectors produce identical output in Node and in a browser
 * (Playwright page evaluation of the same packages/shared code, bundled for the browser).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  computeEntryHash,
  canonicalEntry,
  GENESIS_HASH,
  type LedgerEntry,
} from '../src/ledger-hash';
import { VECTOR_ENTRY } from './vectors';

type HashModule = {
  canonicalEntry: typeof canonicalEntry;
  computeEntryHash: typeof computeEntryHash;
};

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `import * as h from './ledger-hash'; window.__arenaHash = h;`,
      resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
  });
  bundle = out.outputFiles[0]!.text;
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const entries: LedgerEntry[] = [
  VECTOR_ENTRY,
  {
    ...VECTOR_ENTRY,
    seq: 2n,
    id: '00000000-0000-4000-8000-000000000002',
    entry_type: 'BUY',
    symbol: 'M&M',
    side: 'BUY',
    quantity: 12,
    price_paise: 341250n,
    price_source: 'ask',
    gross_paise: 4095000n,
    charges: {
      stt: 4095n,
      exchange: 122n,
      sebi: 4n,
      ipft: 4n,
      stamp: 614n,
      gst: 23n,
      dp: 0n,
      brokerage: 0n,
    },
    charges_total_paise: 4862n,
    cash_delta_paise: -4099862n,
    cash_after_paise: 5900138n,
    position_after: 12,
    avg_cost_after_paise: 341250n,
    note: 'Unicode: ₹ — “quotes” 日本',
    prev_hash: 'f'.repeat(64),
  },
];

const toJsonable = (e: LedgerEntry) =>
  JSON.parse(
    JSON.stringify(e, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v,
    ),
  );

describe('hash vectors in Node and Chromium', () => {
  it('produce identical canonical forms and hashes', async () => {
    const page = await browser.newPage();
    // crypto.subtle needs a secure context; http://localhost counts as one.
    await page.route('http://localhost/hash', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>hash</title>' }),
    );
    await page.goto('http://localhost/hash');
    await page.addScriptTag({ content: bundle });
    for (const e of entries) {
      const nodeHash = await computeEntryHash(e);
      const nodeCanon = canonicalEntry(e);
      const [browserCanon, browserHash] = await page.evaluate(async (entry) => {
        const h = (window as unknown as { __arenaHash: HashModule }).__arenaHash;
        return [h.canonicalEntry(entry), await h.computeEntryHash(entry)];
      }, toJsonable(e));
      expect(browserCanon).toBe(nodeCanon);
      expect(browserHash).toBe(nodeHash);
    }
    expect(GENESIS_HASH).toHaveLength(64);
    await page.close();
  });
});
