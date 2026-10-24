-- Roles and public views (SPEC §14 roles, §15 public data rules).
-- Roles are created without passwords; the owner sets them in Neon (see SETUP.md).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engine_rw') THEN
    CREATE ROLE engine_rw LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_ro') THEN
    CREATE ROLE web_ro LOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO engine_rw, web_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO engine_rw, web_ro;

-- Public views: every row is filtered on reveal_at <= now(); only public columns.
CREATE VIEW v_seasons WITH (security_barrier) AS
SELECT id, name, mode, starts_on, ends_on, trading_days, starting_cash_paise, status, index_at_start_x100, system_prompt
FROM seasons;

CREATE VIEW v_participants WITH (security_barrier) AS
SELECT id, season_id, kind, slot, display_name, short_code, color, openrouter_model_id, status, retired_at, retired_reason
FROM participants;

CREATE VIEW v_rounds WITH (security_barrier) AS
SELECT r.id, r.season_id, r.trading_date, r.slot_time, r.scheduled_at, r.started_at, r.finished_at, r.reveal_at,
       r.status, r.status_reason, r.trigger,
       ds.fetch_started_at AS decision_snapshot_started_at, ds.fetch_finished_at AS decision_snapshot_at,
       fs.fetch_started_at AS fill_snapshot_started_at, fs.fetch_finished_at AS fill_snapshot_at
FROM rounds r
LEFT JOIN snapshots ds ON ds.id = r.decision_snapshot_id
LEFT JOIN snapshots fs ON fs.id = r.fill_snapshot_id
WHERE r.reveal_at IS NOT NULL AND r.reveal_at <= now();

CREATE VIEW v_decisions WITH (security_barrier) AS
SELECT d.id, d.round_id, d.participant_id, d.status, d.error_class, d.private_block, d.prompt_sha256,
       d.parsed ->> 'content' AS answer_text, d.reasoning, d.note_to_self, d.flags, d.serving_model, d.attempts,
       d.latency_ms, d.input_tokens, d.output_tokens, d.reasoning_tokens, d.cost_usd, d.cost_estimated, d.rng_seed,
       d.reveal_at
FROM decisions d
WHERE d.reveal_at IS NOT NULL AND d.reveal_at <= now();

CREATE VIEW v_actions WITH (security_barrier) AS
SELECT a.id, a.decision_id, d.round_id, d.participant_id, a.position, a.side_raw, a.symbol_raw, a.quantity_raw, a.why,
       a.side, a.symbol, a.quantity, a.status, a.reject_code, a.reject_detail, a.model_fault,
       l.seq AS ledger_seq, l.price_paise, l.price_source, l.charges_total_paise, d.reveal_at
FROM actions a
JOIN decisions d ON d.id = a.decision_id
LEFT JOIN ledger l ON l.action_id = a.id
WHERE d.reveal_at IS NOT NULL AND d.reveal_at <= now();

CREATE VIEW v_ledger WITH (security_barrier) AS
SELECT seq, id, season_id, participant_id, round_id, action_id, entry_type, symbol, side, quantity, price_paise,
       price_source, snapshot_id, gross_paise, charges, charges_total_paise, cash_delta_paise, cash_after_paise,
       position_after, avg_cost_after_paise, realized_pnl_paise, note, ref_seq, occurred_at, reveal_at, prev_hash, hash
FROM ledger
WHERE reveal_at <= now();

CREATE VIEW v_marks WITH (security_barrier) AS
SELECT id, participant_id, round_id, snapshot_id, kind, marked_at, cash_paise, holdings_value_paise, total_paise, reveal_at
FROM marks
WHERE reveal_at <= now();

-- Holdings as of each participant's latest revealed ledger entry per symbol, priced at the latest revealed mark.
CREATE VIEW v_holdings WITH (security_barrier) AS
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
WHERE le.position_after > 0;

CREATE VIEW v_incidents WITH (security_barrier) AS
SELECT id, key, severity, title, public_message, scope, participant_id, started_at, resolved_at
FROM incidents;

CREATE VIEW v_status WITH (security_barrier) AS
SELECT s.paused, s.paused_reason, s.updated_at AS state_updated_at,
       (SELECT max(finished_at) FROM rounds WHERE status IN ('COMPLETED','PARTIAL') AND reveal_at <= now()) AS last_completed_round_at,
       (SELECT max(reveal_at) FROM rounds WHERE reveal_at <= now()) AS last_revealed_at,
       (SELECT max(at) FROM heartbeats) AS last_heartbeat_at,
       (SELECT outcome FROM heartbeats ORDER BY at DESC, id DESC LIMIT 1) AS last_heartbeat_outcome,
       (SELECT status FROM snapshots WHERE purpose IN ('decision','fill') ORDER BY fetch_finished_at DESC LIMIT 1) AS last_snapshot_status,
       (SELECT fetch_finished_at FROM snapshots WHERE purpose IN ('decision','fill') ORDER BY fetch_finished_at DESC LIMIT 1) AS last_snapshot_at,
       (SELECT reject_reason FROM snapshots WHERE purpose IN ('decision','fill') ORDER BY fetch_finished_at DESC LIMIT 1) AS last_snapshot_reject_reason
FROM arena_state s
WHERE s.id = 1;

CREATE VIEW v_anchors WITH (security_barrier) AS
SELECT date, season_id, first_seq, last_seq, entries, head_hash, commit_sha
FROM anchors;

-- The full market table the models saw: after that day's close, and only if the policy allows (SPEC §8.8).
CREATE VIEW v_market_tables WITH (security_barrier) AS
SELECT r.id AS round_id, r.season_id, r.trading_date, r.slot_time, r.market_block
FROM rounds r
CROSS JOIN arena_state s
WHERE s.id = 1
  AND s.publish_market_table = 'after_close'
  AND r.market_block IS NOT NULL
  AND r.reveal_at IS NOT NULL AND r.reveal_at <= now()
  AND now() >= ((r.trading_date + time '15:30') AT TIME ZONE 'Asia/Kolkata');

CREATE VIEW v_admin_log WITH (security_barrier) AS
SELECT id, command, args, reason, actor, at FROM admin_log;

CREATE VIEW v_symbol_flags WITH (security_barrier) AS
SELECT symbol, flag, reason, set_at, cleared_at FROM symbol_flags;

-- Grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO engine_rw;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger FROM engine_rw;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM engine_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO engine_rw;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM web_ro;
GRANT SELECT ON v_seasons, v_participants, v_rounds, v_decisions, v_actions, v_ledger, v_marks, v_holdings,
  v_incidents, v_status, v_anchors, v_market_tables, v_admin_log, v_symbol_flags TO web_ro;
