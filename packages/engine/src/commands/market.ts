import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DateTime } from 'luxon';
import { paiseToDecimal } from '@arena/shared/money';
import type { ParsedArgs } from '../ops/args';
import { flagString, flagRequired } from '../ops/args';
import { baseContext, angelProvider } from '../config/context';
import { must, loadUniverse, configDir } from '../config/load';
import { freshMapping, snapshotFor, summariseSnapshot } from '../data/market';
import { importNifty50Csv, importNseHolidays } from '../data/importers';
import { writeStepSummary, mdTable } from '../ops/summary';
import { FixtureRecorder } from '../ops/fixtures';
import { AngelOneProvider } from '../data/angelone';

const todayIst = () => DateTime.now().setZone('Asia/Kolkata').toISODate()!;

/** pnpm engine snapshot --dry: login, fetch, validate, print. No DB writes. */
export async function snapshotDry(args: ParsedArgs): Promise<number> {
  if (args.flags.dry !== true) {
    process.stderr.write('Only `snapshot --dry` exists; snapshots are stored by rounds.\n');
    return 2;
  }
  const ctx = baseContext();
  const universe = must(loadUniverse());
  const provider = angelProvider(ctx);
  const mapping = await freshMapping(provider, universe, ctx.arena);
  const session = await provider.login();
  const snap = await snapshotFor({
    session,
    source: provider.source,
    purpose: 'decision',
    mapping,
    arena: ctx.arena,
  });
  const rows = snap.quotes.map((q) => [
    q.symbol,
    q.ltpPaise === null ? '—' : paiseToDecimal(q.ltpPaise),
    q.bidPaise === null ? '—' : paiseToDecimal(q.bidPaise),
    q.askPaise === null ? '—' : paiseToDecimal(q.askPaise),
    q.exchangeTime?.toISOString() ?? '—',
    q.valid ? 'valid' : `NO_PRICE: ${q.invalidReason}`,
  ]);
  const md = [
    '## Snapshot (dry run)',
    '',
    `Fetched ${snap.startedAt.toISOString()} → ${snap.finishedAt.toISOString()}.`,
    '',
    `Mapping: ${mapping.equities.length} symbols mapped; unmapped: ${mapping.unmapped.map((u) => `${u.symbol} (${u.reason})`).join(', ') || 'none'}; indices missing: ${mapping.missingIndices.map((m) => m.name).join(', ') || 'none'}.`,
    '',
    summariseSnapshot(snap),
    '',
    mdTable(['Symbol', 'LTP', 'Bid', 'Ask', 'Exchange time', 'Status'], rows),
  ].join('\n');
  process.stdout.write(`${md}\n`);
  writeStepSummary(md);
  return 0;
}

/** pnpm engine import-universe --csv <file> --effective-from YYYY-MM-DD */
export async function importUniverse(args: ParsedArgs): Promise<number> {
  const csv = readFileSync(flagRequired(args, 'csv'), 'utf8');
  const u = importNifty50Csv(csv, {
    sourceUrl:
      flagString(args, 'source') ??
      'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv',
    effectiveFrom: flagRequired(args, 'effective-from'),
    downloadedOn: flagString(args, 'downloaded-on') ?? todayIst(),
  });
  const out = join(configDir(), 'universe', 'nifty50.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(u, null, 2)}\n`);
  process.stdout.write(`Wrote ${out}: ${u.constituents.length} symbols.\n`);
  return 0;
}

/** pnpm engine import-holidays --year 2026 --file <json|csv> */
export async function importHolidays(args: ParsedArgs): Promise<number> {
  const year = Number(flagRequired(args, 'year'));
  const text = readFileSync(flagRequired(args, 'file'), 'utf8');
  const cal = importNseHolidays(text, {
    year,
    sourceUrl:
      flagString(args, 'source') ??
      'https://www.nseindia.com/resources/exchange-communication-holidays',
    downloadedOn: flagString(args, 'downloaded-on') ?? todayIst(),
  });
  const out = join(configDir(), 'calendar', `nse-${year}.json`);
  writeFileSync(out, `${JSON.stringify(cal, null, 2)}\n`);
  process.stdout.write(`Wrote ${out}: ${cal.holidays.length} holidays.\n`);
  return 0;
}

/** smoke.yml record-fixtures: real Angel One responses, sanitised, for test fixtures. */
export async function recordAngelFixtures(args: ParsedArgs): Promise<number> {
  const ctx = baseContext();
  const universe = must(loadUniverse());
  const rec = new FixtureRecorder(join(flagString(args, 'out') ?? 'fixtures-out', 'angelone'));
  angelProvider(ctx); // validates the Angel One variables with friendly errors
  const md = ctx.arena.marketData;
  const e = ctx.env;
  const provider = new AngelOneProvider(
    {
      apiKey: e.ANGEL_API_KEY!,
      clientCode: e.ANGEL_CLIENT_CODE!,
      mpin: e.ANGEL_MPIN!,
      totpSecret: e.ANGEL_TOTP_SECRET!,
    },
    {
      apiRoot: md.apiRoot,
      instrumentMasterUrl: md.instrumentMasterUrl,
      timeoutMs: md.requestTimeoutSeconds * 1000,
      quoteBatchSize: md.quoteBatchSize,
      quoteRequestsPerSecond: md.quoteRequestsPerSecond,
      candleRequestsPerSecond: md.candleRequestsPerSecond,
      recorder: (path, request, status, response) =>
        rec.record(path.split('/').pop() ?? 'call', { path, request, status, response }),
    },
  );
  const mapping = await freshMapping(provider, universe, ctx.arena);
  rec.record('instrument-mapping', {
    equities: mapping.equities.slice(0, 5),
    indices: mapping.indices,
    unmapped: mapping.unmapped,
  });
  const session = await provider.login();
  await session.quotes(mapping.equities.slice(0, 3), mapping.indices);
  await session.quotes(
    [{ symbol: 'BOGUS', brokerToken: '0', exchange: 'NSE', name: 'bogus', tickSizePaise: 5 }],
    [],
  );
  const first = mapping.equities[0];
  if (first) {
    const to = todayIst();
    const from = DateTime.fromISO(to).minus({ days: 10 }).toISODate()!;
    await session.dailyCandles(first, from, to);
  }
  const msg = `## Recorded Angel One fixtures\n\n${rec.files.map((f) => `- ${f}`).join('\n')}\n`;
  process.stdout.write(msg);
  writeStepSummary(msg);
  return 0;
}
