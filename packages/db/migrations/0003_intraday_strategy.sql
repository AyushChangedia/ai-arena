-- Intraday long-short product and the models' stated strategy (owner decisions, 2026-10-26; SPEC §3, §10.3, §14).

-- Short positions have a negative quantity. A position row with quantity 0 is deleted, never stored.
ALTER TABLE positions DROP CONSTRAINT positions_quantity_check;
ALTER TABLE positions ADD CONSTRAINT positions_quantity_nonzero CHECK (quantity <> 0);
-- DDL only: the append-only trigger blocks row changes, and no existing row changes here.
ALTER TABLE ledger DROP CONSTRAINT ledger_position_after_check;

-- A square-off round closes every open position; it has no model decisions of its own.
ALTER TABLE rounds ADD COLUMN kind text NOT NULL DEFAULT 'trading' CHECK (kind IN ('trading','square_off'));

-- The model's stated approach for the round, and its exit plan for each action (published, never acted on).
ALTER TABLE decisions ADD COLUMN strategy text NULL;
ALTER TABLE actions ADD COLUMN exit_plan text NULL;

-- Public views gain the new columns (appended, so existing columns keep their positions).
CREATE OR REPLACE VIEW v_rounds WITH (security_barrier) AS
SELECT r.id, r.season_id, r.trading_date, r.slot_time, r.scheduled_at, r.started_at, r.finished_at, r.reveal_at,
       r.status, r.status_reason, r.trigger,
       ds.fetch_started_at AS decision_snapshot_started_at, ds.fetch_finished_at AS decision_snapshot_at,
       fs.fetch_started_at AS fill_snapshot_started_at, fs.fetch_finished_at AS fill_snapshot_at,
       r.kind
FROM rounds r
LEFT JOIN snapshots ds ON ds.id = r.decision_snapshot_id
LEFT JOIN snapshots fs ON fs.id = r.fill_snapshot_id
WHERE r.reveal_at IS NOT NULL AND r.reveal_at <= now();

CREATE OR REPLACE VIEW v_decisions WITH (security_barrier) AS
SELECT d.id, d.round_id, d.participant_id, d.status, d.error_class, d.private_block, d.prompt_sha256,
       d.parsed ->> 'content' AS answer_text, d.reasoning, d.note_to_self, d.flags, d.serving_model, d.attempts,
       d.latency_ms, d.input_tokens, d.output_tokens, d.reasoning_tokens, d.cost_usd, d.cost_estimated, d.rng_seed,
       d.reveal_at, d.strategy
FROM decisions d
WHERE d.reveal_at IS NOT NULL AND d.reveal_at <= now();

CREATE OR REPLACE VIEW v_actions WITH (security_barrier) AS
SELECT a.id, a.decision_id, d.round_id, d.participant_id, a.position, a.side_raw, a.symbol_raw, a.quantity_raw, a.why,
       a.side, a.symbol, a.quantity, a.status, a.reject_code, a.reject_detail, a.model_fault,
       l.seq AS ledger_seq, l.price_paise, l.price_source, l.charges_total_paise, d.reveal_at, a.exit_plan,
       l.position_after
FROM actions a
JOIN decisions d ON d.id = a.decision_id
LEFT JOIN ledger l ON l.action_id = a.id
WHERE d.reveal_at IS NOT NULL AND d.reveal_at <= now();

-- Open positions, long (quantity > 0) or short (quantity < 0).
CREATE OR REPLACE VIEW v_holdings WITH (security_barrier) AS
WITH last_entry AS (
  SELECT DISTINCT ON (participant_id, symbol) participant_id, symbol, position_after, avg_cost_after_paise, seq
  FROM ledger
  WHERE reveal_at <= now() AND symbol IS NOT NULL AND position_after IS NOT NULL
  ORDER BY participant_id, symbol, seq DESC
), last_mark AS (
  SELECT DISTINCT ON (participant_id) participant_id, snapshot_id, marked_at
  FROM marks
  WHERE reveal_at <= now()
  ORDER BY participant_id, marked_at DESC
)
SELECT le.participant_id, le.symbol, le.position_after AS quantity, le.avg_cost_after_paise AS avg_cost_paise,
       q.ltp_paise AS last_price_paise, lm.marked_at AS priced_at,
       (sf.symbol IS NOT NULL) AS under_review
FROM last_entry le
LEFT JOIN last_mark lm ON lm.participant_id = le.participant_id
LEFT JOIN quotes q ON q.snapshot_id = lm.snapshot_id AND q.symbol = le.symbol AND q.valid
LEFT JOIN symbol_flags sf ON sf.symbol = le.symbol AND sf.cleared_at IS NULL
WHERE le.position_after <> 0;

GRANT SELECT ON v_rounds, v_decisions, v_actions, v_holdings TO web_ro;
