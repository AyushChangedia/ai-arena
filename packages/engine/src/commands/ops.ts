import { readFileSync } from 'node:fs';
import { createPool } from '@arena/db';
import { verifyChain, GENESIS_HASH, type LedgerEntry } from '@arena/shared/ledger-hash';
import { ConfigError } from '@arena/shared/errors';
import type { ParsedArgs } from '../ops/args';
import { flagString, flagRequired } from '../ops/args';
import { writeStepSummary } from '../ops/summary';
import { Healthchecks } from '../ops/heartbeat';
import { createLogger } from '../ops/logger';
import { buildDeps } from '../round/build-deps';
import { tick } from '../round/tick';
import { replayRound } from '../round/replay';
import { reconcile } from '../round/reconcile';
import { loadLedger } from '../round/ledger-store';
import { baseContext } from '../config/context';
import { requireEnv } from '../config/load';
import * as admin from '../ops/admin';
import { rupeesToPaise } from '@arena/shared/money';

/** pnpm engine tick [--dry] [--manual] */
export async function tickCommand(args: ParsedArgs): Promise<number> {
  const hc = new Healthchecks(process.env.HEALTHCHECKS_PING_URL || undefined, createLogger());
  const dry = args.flags.dry === true;
  if (!dry) await hc.ping('start');
  let d;
  try {
    d = buildDeps();
  } catch (e) {
    if (!dry) await hc.ping('fail', (e as Error).message);
    throw e;
  }
  try {
    const r = await tick(d, {
      dry,
      mode: d.env.ARENA_MODE!,
      trigger: args.flags.manual === true ? 'manual' : 'cron',
    });
    process.stdout.write(`${r.summary}\n`);
    writeStepSummary(r.summary);
    if (r.exported.length && process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `exported=${r.exported.join(',')}\n`);
    }
    if (!dry) await hc.ping(r.ok ? 'success' : 'fail', r.summary);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (!dry) await hc.ping('fail', (e as Error).message);
    throw e;
  } finally {
    await d.db.end();
  }
}

export async function replayCommand(args: ParsedArgs): Promise<number> {
  const d = buildDeps();
  try {
    const ids =
      flagString(args, 'round') === 'random'
        ? (
            await d.db.query<{ id: string }>(
              "SELECT id FROM rounds WHERE fill_snapshot_id IS NOT NULL AND status IN ('COMPLETED','PARTIAL') ORDER BY random() LIMIT $1",
              [Number(flagString(args, 'count') ?? 3)],
            )
          ).rows.map((r) => r.id)
        : [flagRequired(args, 'round')];
    let ok = true;
    const lines: string[] = ['## Replay', ''];
    for (const id of ids) {
      const r = await replayRound(
        d.db,
        id,
        d.arena,
        d.fees,
        d.universe.constituents.map((c) => c.symbol),
      );
      ok &&= r.ok;
      lines.push(
        `- ${id}: ${r.ok ? 'identical' : 'MISMATCH'} (${r.compared} entries compared)${r.mismatches.length ? `\n  - ${r.mismatches.join('\n  - ')}` : ''}`,
      );
    }
    const md = lines.join('\n');
    process.stdout.write(`${md}\n`);
    writeStepSummary(md);
    return ok ? 0 : 1;
  } finally {
    await d.db.end();
  }
}

export async function reconcileCommand(args: ParsedArgs): Promise<number> {
  const ctx = baseContext();
  const env = requireEnv(ctx.envCheck, ['DATABASE_URL']);
  const db = createPool(env.DATABASE_URL);
  try {
    const r = await reconcile(
      db,
      flagString(args, 'season') ?? null,
      flagString(args, 'date') ?? null,
    );
    const md = `## Reconciliation\n\n${r.ok ? 'OK' : 'MISMATCH'}: ${r.entries} entries, head ${r.headHash ?? '—'}.${r.problems.length ? `\n\n- ${r.problems.join('\n- ')}` : ''}\n`;
    process.stdout.write(md);
    writeStepSummary(md);
    return r.ok ? 0 : 1;
  } finally {
    await db.end();
  }
}

/** pnpm verify-ledger [--file ledger.jsonl] [--prev-hash <hash>]: from a file, or the DB (v_ledger when read-only). */
export async function verifyLedgerCommand(args: ParsedArgs): Promise<number> {
  let entries: LedgerEntry[];
  let source: string;
  const file = flagString(args, 'file');
  if (file) {
    entries = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LedgerEntry);
    source = file;
  } else {
    const url = process.env.DATABASE_URL || process.env.DATABASE_URL_READONLY;
    if (!url)
      throw new ConfigError(
        'No --file and no database URL.',
        'Pass --file <ledger.jsonl>, or set DATABASE_URL / DATABASE_URL_READONLY.',
      );
    const db = createPool(url);
    try {
      entries = await loadLedger(db, 'TRUE').catch(async () =>
        (await db.query('SELECT * FROM v_ledger ORDER BY seq')).rows.map((r) => r as LedgerEntry),
      );
      source = 'database';
    } finally {
      await db.end();
    }
  }
  const prev =
    flagString(args, 'prev-hash') ??
    (entries[0] && BigInt(entries[0].seq) === 1n
      ? GENESIS_HASH
      : (entries[0]?.prev_hash ?? GENESIS_HASH));
  const r = await verifyChain(entries, prev);
  const msg = r.ok
    ? `OK: ${r.entries} entries from ${source} verify; head ${r.headHash ?? '—'}\n`
    : `FAILED: ${r.problems.length} problem(s):\n${r.problems.map((p) => `- seq ${p.seq}: ${p.kind}`).join('\n')}\n`;
  process.stdout.write(msg);
  writeStepSummary(`## verify-ledger\n\n${msg}`);
  return r.ok ? 0 : 1;
}

/** pnpm engine anchor-commit --date YYYY-MM-DD --sha <commit>: records the git commit that anchored a day. */
export async function anchorCommitCommand(args: ParsedArgs): Promise<number> {
  const ctx = baseContext();
  const env = requireEnv(ctx.envCheck, ['DATABASE_URL']);
  const db = createPool(env.DATABASE_URL);
  try {
    const sha = flagRequired(args, 'sha');
    if (!/^[0-9a-f]{7,40}$/.test(sha))
      throw new ConfigError('--sha must be a git commit hash.', 'Pass the commit SHA.');
    for (const date of flagRequired(args, 'date').split(','))
      await db.query('UPDATE anchors SET commit_sha = $2 WHERE date = $1', [date, sha]);
    return 0;
  } finally {
    await db.end();
  }
}

/** pnpm admin <command> ... (SPEC §18.1) */
export async function adminCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[0];
  const reason = flagString(args, 'reason') ?? flagString(args, 'note') ?? '';
  const who = admin.actor(flagString(args, 'actor'));
  if (sub === 'start-season') {
    const d = buildDeps();
    try {
      const msg = await admin.startSeason(
        d.db,
        {
          id: flagRequired(args, 'id'),
          start: flagRequired(args, 'start'),
          mode: flagRequired(args, 'mode') as 'shadow' | 'live',
          name: flagString(args, 'name'),
        },
        d.models,
        d.calendar,
        BigInt(d.arena.startingCashPaise),
        d.arena.season.tradingDays,
        reason,
        who,
      );
      process.stdout.write(`${msg}\n`);
      writeStepSummary(`## admin start-season\n\n${msg}\n`);
      return 0;
    } finally {
      await d.db.end();
    }
  }
  const ctx = baseContext();
  const env = requireEnv(ctx.envCheck, ['DATABASE_URL']);
  const db = createPool(env.DATABASE_URL);
  try {
    let msg: string;
    switch (sub) {
      case 'pause':
        msg = await admin.pause(db, reason, who);
        break;
      case 'resume':
        msg = await admin.resume(db, reason, who);
        break;
      case 'retire':
        msg = await admin.retire(
          db,
          flagRequired(args, 'slot'),
          reason,
          who,
          flagString(args, 'season'),
        );
        break;
      case 'corp-action':
        msg = await admin.corpAction(
          db,
          {
            symbol: flagRequired(args, 'symbol'),
            type: flagRequired(args, 'type') as 'split',
            ratio: flagString(args, 'ratio'),
            amount: flagString(args, 'amount'),
            exDate: flagRequired(args, 'ex-date'),
            source: flagRequired(args, 'source'),
          },
          reason,
          who,
        );
        break;
      case 'clear-flag':
        msg = await admin.clearFlag(db, flagRequired(args, 'symbol'), reason, who);
        break;
      case 'resolve-incident':
        msg = await admin.resolveIncidentById(db, flagRequired(args, 'id'), reason, who);
        break;
      case 'correct': {
        const pos = flagString(args, 'position');
        const avg = flagString(args, 'avg-cost');
        msg = await admin.correct(
          db,
          {
            refSeq: flagRequired(args, 'ref-seq'),
            cashDeltaPaise: rupeesToPaise(flagString(args, 'cash-delta') ?? '0'),
            symbol: flagString(args, 'symbol'),
            positionAfter: pos === undefined ? undefined : Number(pos),
            avgCostPaise: avg === undefined ? undefined : rupeesToPaise(avg),
          },
          reason,
          who,
        );
        break;
      }
      default:
        process.stderr.write(
          'Usage: pnpm admin <pause|resume|retire|corp-action|clear-flag|resolve-incident|start-season|correct> [--flags]\n',
        );
        return 2;
    }
    process.stdout.write(`${msg}\n`);
    writeStepSummary(`## admin ${sub}\n\n${msg}\n`);
    return 0;
  } finally {
    await db.end();
  }
}
