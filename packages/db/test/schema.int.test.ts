import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { allTables, PUBLIC_VIEWS } from '../src/schema';
import { createTestDb, client, type TestDb } from './helpers';
import { GENESIS_HASH } from '@arena/shared/ledger-hash';

let db: TestDb;
let owner: pg.Client;

beforeAll(async () => {
  db = await createTestDb('schema');
  owner = await client(db.ownerUrl);
});
afterAll(async () => {
  await owner?.end();
  await db?.drop();
});

describe('schema (SPEC §14)', () => {
  it('every Drizzle table and column exists in the migrated database', async () => {
    const rows = (
      await owner.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
      )
    ).rows;
    const actual = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }
    for (const [name, table] of Object.entries(allTables)) {
      const cfg = getTableConfig(table);
      expect(cfg.name).toBe(name);
      const cols = actual.get(name);
      expect(cols, `table ${name}`).toBeDefined();
      const drizzleCols = cfg.columns.map((c) => c.name).sort();
      expect(drizzleCols).toEqual([...cols!].sort());
    }
  });

  it('every table has created_at', async () => {
    for (const name of Object.keys(allTables)) {
      const r = await owner.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'created_at'",
        [name],
      );
      expect(r.rowCount, name).toBe(1);
    }
  });
});

async function seedSeason(c: pg.Client) {
  await c.query(
    `INSERT INTO seasons (id, name, mode, starts_on, trading_days, starting_cash_paise, status) VALUES ('S0','Shadow','shadow','2026-11-02',20,10000000,'active')`,
  );
  await c.query(
    `INSERT INTO participants (id, season_id, kind, slot, display_name, short_code, color, status) VALUES ('S0-openai','S0','model','openai','GPT','GPT','#5AB8F0','active')`,
  );
}

async function insertLedger(c: pg.Client, seq: number, revealAt: string) {
  await c.query(
    `INSERT INTO ledger (seq, id, season_id, participant_id, entry_type, gross_paise, charges, charges_total_paise,
       cash_delta_paise, cash_after_paise, occurred_at, reveal_at, prev_hash, hash)
     VALUES ($1, gen_random_uuid(), 'S0', 'S0-openai', 'SEASON_START', 0, '{}', 0, 10000000, 10000000, now(), $2, $3, $4)`,
    [seq, revealAt, GENESIS_HASH, `h${seq}`],
  );
}

describe('ledger immutability (SPEC §11.7)', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    await seedSeason(owner);
    await insertLedger(owner, 1, '2000-01-01T00:00:00Z');
    await expect(owner.query('UPDATE ledger SET note = $1 WHERE seq = 1', ['x'])).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.query('DELETE FROM ledger WHERE seq = 1')).rejects.toThrow(/append-only/);
    await expect(owner.query('TRUNCATE ledger CASCADE')).rejects.toThrow(/append-only/);
  });

  it('engine_rw may insert and select the ledger but not update or delete', async () => {
    const eng = await client(db.engineUrl);
    try {
      await insertLedger(eng, 2, '2999-01-01T00:00:00Z');
      expect((await eng.query('SELECT count(*)::int AS n FROM ledger')).rows[0].n).toBe(2);
      await expect(eng.query('UPDATE ledger SET note = $1 WHERE seq = 2', ['x'])).rejects.toThrow(
        /permission denied|append-only/,
      );
      await expect(eng.query('DELETE FROM ledger WHERE seq = 2')).rejects.toThrow(
        /permission denied|append-only/,
      );
      await expect(
        eng.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['x']),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await eng.end();
    }
  });
});

describe('web_ro permissions and the reveal delay (SPEC §15)', () => {
  it('is denied on every base table', async () => {
    const web = await client(db.webUrl);
    try {
      for (const name of [...Object.keys(allTables), 'schema_migrations']) {
        await expect(web.query(`SELECT 1 FROM ${name} LIMIT 1`), name).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(
        web.query('INSERT INTO arena_state (id, paused, updated_at) VALUES (2, false, now())'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await web.end();
    }
  });

  it('can read every public view, and unrevealed rows are invisible', async () => {
    const web = await client(db.webUrl);
    try {
      for (const v of PUBLIC_VIEWS) await web.query(`SELECT * FROM ${v} LIMIT 1`);
      const seqs = (
        await web.query<{ seq: string }>('SELECT seq FROM v_ledger ORDER BY seq')
      ).rows.map((r) => r.seq);
      expect(seqs).toEqual(['1']); // seq 2 reveals in 2999
      await expect(web.query('CREATE TABLE x (a int)')).rejects.toThrow(/permission denied/);
    } finally {
      await web.end();
    }
  });

  it('hides unrevealed rounds, decisions and marks, and private columns', async () => {
    await owner.query(`INSERT INTO snapshots (id, purpose, fetch_started_at, fetch_finished_at, source, raw, valid_count, invalid_count, status)
      VALUES ('00000000-0000-4000-8000-0000000000aa','fill',now(),now(),'angelone','{}',50,0,'ok')`);
    for (const [id, reveal, slot] of [
      ['00000000-0000-4000-8000-000000000001', '2000-01-01T00:00:00Z', '09:30'],
      ['00000000-0000-4000-8000-000000000002', '2999-01-01T00:00:00Z', '10:00'],
    ] as const) {
      await owner.query(
        `INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, finished_at, reveal_at, status, trigger, market_block)
         VALUES ($1,'S0','2026-01-05',$3,now(),now(),now(),$2,'COMPLETED','cron','symbol,ltp')`,
        [id, reveal, slot],
      );
      await owner.query(
        `INSERT INTO decisions (id, round_id, participant_id, status, request_params, error_detail, reveal_at)
         VALUES (gen_random_uuid(), $1, 'S0-openai', 'OK', '{"model":"x"}', 'internal', $2)`,
        [id, reveal],
      );
      await owner.query(
        `INSERT INTO marks (id, participant_id, round_id, snapshot_id, kind, marked_at, cash_paise, holdings_value_paise, total_paise, reveal_at)
         VALUES (gen_random_uuid(), 'S0-openai', $1, '00000000-0000-4000-8000-0000000000aa', 'round', now(), 1, 0, 1, $2)`,
        [id, reveal],
      );
    }
    await owner.query(`INSERT INTO incidents (id, key, severity, title, detail, public_message, scope, started_at)
      VALUES (gen_random_uuid(), 'k', 'warn', 't', 'stack trace here', 'Plain words.', 'arena', now())`);
    const web = await client(db.webUrl);
    try {
      expect((await web.query('SELECT id FROM v_rounds')).rowCount).toBe(1);
      expect((await web.query('SELECT id FROM v_decisions')).rowCount).toBe(1);
      expect((await web.query('SELECT id FROM v_marks')).rowCount).toBe(1);
      const decCols = (await web.query('SELECT * FROM v_decisions LIMIT 1')).fields.map(
        (f) => f.name,
      );
      expect(decCols).not.toContain('request_params');
      expect(decCols).not.toContain('error_detail');
      const inc = await web.query('SELECT * FROM v_incidents');
      expect(inc.fields.map((f) => f.name)).not.toContain('detail');
      expect(inc.rows[0].public_message).toBe('Plain words.');
      // 2026-01-05 is long past its 15:30 IST close, so the revealed round's market table is public.
      expect((await web.query('SELECT round_id FROM v_market_tables')).rowCount).toBe(1);
      await owner.query("UPDATE arena_state SET publish_market_table = 'never'");
      expect((await web.query('SELECT round_id FROM v_market_tables')).rowCount).toBe(0);
      const status = (await web.query('SELECT * FROM v_status')).rows[0];
      expect(status.paused).toBe(false);
    } finally {
      await web.end();
    }
  });
});
