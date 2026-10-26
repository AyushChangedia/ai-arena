/**
 * End-of-day public export and ledger anchor (SPEC §12.6). Writes public-data/YYYY/MM/DD/*.jsonl
 * and public-data/anchors/YYYY-MM-DD.json; the tick workflow commits them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '@arena/db';
import { hashableEntry } from '@arena/shared/ledger-hash';
import { canonicalJson } from '@arena/shared/canonical';
import { loadLedger } from './ledger-store';

const jsonl = (rows: unknown[]) =>
  rows
    .map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .join('\n') + (rows.length ? '\n' : '');

export interface ExportResult {
  dir: string;
  files: string[];
  anchor: {
    date: string;
    season: string | null;
    first_seq: string | null;
    last_seq: string | null;
    entries: number;
    head_hash: string | null;
  };
}

/** Exports one trading date. Only revealed data is exported (call after the day's last reveal). */
export async function exportDay(
  db: Queryable,
  date: string,
  rootDir: string,
  includeMarketTables: boolean,
): Promise<ExportResult> {
  const [y, m, dd] = date.split('-');
  const dir = join(rootDir, 'public-data', y!, m!, dd!);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(rootDir, 'public-data', 'anchors'), { recursive: true });
  const rounds = await db.query(
    `SELECT id, season_id, to_char(trading_date,'YYYY-MM-DD') AS trading_date, to_char(slot_time,'HH24:MI') AS slot_time, scheduled_at, started_at,
       finished_at, reveal_at, status, status_reason, kind, decision_snapshot_id, fill_snapshot_id ${includeMarketTables ? ', market_block' : ''}
     FROM rounds WHERE trading_date = $1 AND reveal_at <= now() ORDER BY slot_time`,
    [date],
  );
  const decisions = await db.query(
    `SELECT d.id, d.round_id, d.participant_id, p.openrouter_model_id AS model_id, d.status, d.error_class, d.strategy, d.reasoning, d.note_to_self, d.flags,
       d.serving_model, d.attempts, d.latency_ms, d.input_tokens, d.output_tokens, d.reasoning_tokens, d.cost_usd, d.cost_estimated, d.rng_seed,
       d.private_block, d.parsed->>'content' AS answer_text,
       (SELECT coalesce(json_agg(json_build_object('position', a.position, 'side_raw', a.side_raw, 'symbol_raw', a.symbol_raw, 'quantity_raw', a.quantity_raw,
          'why', a.why, 'exit_plan', a.exit_plan, 'side', a.side, 'symbol', a.symbol, 'quantity', a.quantity, 'status', a.status, 'reject_code', a.reject_code,
          'reject_detail', a.reject_detail, 'model_fault', a.model_fault) ORDER BY a.position), '[]'::json) FROM actions a WHERE a.decision_id = d.id) AS actions
     FROM decisions d JOIN rounds r ON r.id = d.round_id JOIN participants p ON p.id = d.participant_id
     WHERE r.trading_date = $1 AND d.reveal_at <= now() ORDER BY r.slot_time, p.slot`,
    [date],
  );
  const ledger = await loadLedger(
    db as never,
    "occurred_at >= ($1::date + time '00:00') AT TIME ZONE 'Asia/Kolkata' AND occurred_at < ($1::date + 1 + time '00:00') AT TIME ZONE 'Asia/Kolkata' AND reveal_at <= now()",
    [date],
  );
  const marks = await db.query(
    `SELECT id, participant_id, round_id, snapshot_id, kind, marked_at, cash_paise, holdings_value_paise, total_paise, reveal_at FROM marks
     WHERE marked_at >= ($1::date + time '00:00') AT TIME ZONE 'Asia/Kolkata' AND marked_at < ($1::date + 1 + time '00:00') AT TIME ZONE 'Asia/Kolkata' AND reveal_at <= now()
     ORDER BY marked_at, participant_id`,
    [date],
  );
  const files = [
    ['rounds.jsonl', jsonl(rounds.rows)],
    ['decisions.jsonl', jsonl(decisions.rows)],
    [
      'ledger.jsonl',
      ledger.map((e) => canonicalJson({ ...hashableEntry(e), hash: e.hash })).join('\n') +
        (ledger.length ? '\n' : ''),
    ],
    ['marks.jsonl', jsonl(marks.rows)],
  ] as const;
  const written: string[] = [];
  for (const [name, body] of files) {
    const p = join(dir, name);
    writeFileSync(p, body);
    written.push(p);
  }
  const first = ledger[0];
  const last = ledger.at(-1);
  const anchor = {
    date,
    season: last?.season_id ?? null,
    first_seq: first ? String(first.seq) : null,
    last_seq: last ? String(last.seq) : null,
    entries: ledger.length,
    head_hash: last?.hash ?? null,
  };
  if (last) {
    const ap = join(rootDir, 'public-data', 'anchors', `${date}.json`);
    writeFileSync(ap, `${JSON.stringify(anchor, null, 2)}\n`);
    written.push(ap);
    await db.query(
      `INSERT INTO anchors (date, season_id, first_seq, last_seq, entries, head_hash) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (date) DO UPDATE SET season_id = EXCLUDED.season_id, first_seq = EXCLUDED.first_seq, last_seq = EXCLUDED.last_seq,
         entries = EXCLUDED.entries, head_hash = EXCLUDED.head_hash`,
      [date, last.season_id, first!.seq, last.seq, ledger.length, last.hash],
    );
  }
  return { dir, files: written, anchor };
}
