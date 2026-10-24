-- AI Arena schema (SPEC §14). Money is BIGINT paise. Every table has created_at.

CREATE TABLE seasons (
  id text PRIMARY KEY,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','live')),
  starts_on date NOT NULL,
  ends_on date NULL,
  trading_days int NOT NULL,
  starting_cash_paise bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','active','finished')),
  index_at_start_x100 bigint NULL,
  system_prompt text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE participants (
  id text PRIMARY KEY,
  season_id text NOT NULL REFERENCES seasons(id),
  kind text NOT NULL CHECK (kind IN ('model','index','monkey')),
  slot text NOT NULL,
  display_name text NOT NULL,
  short_code text NOT NULL,
  color text NOT NULL,
  openrouter_model_id text NULL,
  model_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('active','paused_budget','retired')),
  retired_at timestamptz NULL,
  retired_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, slot)
);

CREATE TABLE instruments (
  symbol text PRIMARY KEY,
  broker_token text NOT NULL,
  exchange text NOT NULL,
  name text NOT NULL,
  tick_size_paise int NOT NULL,
  refreshed_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE universe_versions (
  id serial PRIMARY KEY,
  effective_from date NOT NULL,
  symbols text[] NOT NULL,
  source_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_bars (
  symbol text NOT NULL,
  date date NOT NULL,
  open_paise bigint NOT NULL,
  high_paise bigint NOT NULL,
  low_paise bigint NOT NULL,
  close_paise bigint NOT NULL,
  volume bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);

CREATE TABLE indicators (
  symbol text NOT NULL,
  date date NOT NULL,
  sma20_paise bigint NULL,
  sma50_paise bigint NULL,
  rsi14 numeric NULL,
  avg_vol_20d bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);

CREATE TABLE snapshots (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('decision','fill','valuation')),
  fetch_started_at timestamptz NOT NULL,
  fetch_finished_at timestamptz NOT NULL,
  source text NOT NULL,
  raw jsonb NOT NULL,
  valid_count int NOT NULL,
  invalid_count int NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','rejected')),
  reject_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  snapshot_id uuid NOT NULL REFERENCES snapshots(id),
  symbol text NOT NULL,
  ltp_paise bigint NULL,
  bid_paise bigint NULL,
  ask_paise bigint NULL,
  open_paise bigint NULL,
  high_paise bigint NULL,
  low_paise bigint NULL,
  prev_close_paise bigint NULL,
  volume bigint NULL,
  exchange_time timestamptz NULL,
  valid boolean NOT NULL,
  invalid_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, symbol)
);

CREATE TABLE index_quotes (
  snapshot_id uuid NOT NULL REFERENCES snapshots(id),
  name text NOT NULL,
  value_x100 bigint NULL,
  prev_close_x100 bigint NULL,
  exchange_time timestamptz NULL,
  valid boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, name)
);

CREATE TABLE rounds (
  id uuid PRIMARY KEY,
  season_id text NOT NULL REFERENCES seasons(id),
  trading_date date NOT NULL,
  slot_time time NOT NULL,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NULL,
  reveal_at timestamptz NULL,
  status text NOT NULL,
  status_reason text NULL,
  decision_snapshot_id uuid NULL REFERENCES snapshots(id),
  fill_snapshot_id uuid NULL REFERENCES snapshots(id),
  market_block text NULL,
  trigger text NOT NULL CHECK (trigger IN ('cron','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, trading_date, slot_time)
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES rounds(id),
  participant_id text NOT NULL REFERENCES participants(id),
  status text NOT NULL,
  error_class text NULL,
  error_detail text NULL,
  private_block text NOT NULL DEFAULT '',
  prompt_sha256 text NOT NULL DEFAULT '',
  request_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_response text NULL,
  parsed jsonb NULL,
  reasoning text NULL,
  note_to_self text NULL,
  flags text[] NOT NULL DEFAULT '{}',
  serving_model text NULL,
  attempts int NOT NULL DEFAULT 0,
  latency_ms int NULL,
  input_tokens int NULL,
  output_tokens int NULL,
  reasoning_tokens int NULL,
  cost_usd numeric(12,6) NULL,
  cost_estimated boolean NOT NULL DEFAULT false,
  rng_seed text NULL,
  reveal_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, participant_id)
);

CREATE TABLE actions (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES decisions(id),
  position int NOT NULL,
  side_raw text NULL,
  symbol_raw text NULL,
  quantity_raw jsonb NULL,
  why text NULL,
  side text NULL,
  symbol text NULL,
  quantity int NULL,
  status text NOT NULL CHECK (status IN ('executed','rejected')),
  reject_code text NULL,
  reject_detail text NULL,
  model_fault boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, position)
);

CREATE TABLE ledger (
  seq bigint PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  season_id text NOT NULL REFERENCES seasons(id),
  participant_id text NOT NULL REFERENCES participants(id),
  round_id uuid NULL,
  action_id uuid NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('SEASON_START','BUY','SELL','DIVIDEND','SPLIT_ADJUST','BONUS_ADJUST','RETIRE','CORRECTION')),
  symbol text NULL,
  side text NULL CHECK (side IS NULL OR side IN ('BUY','SELL')),
  quantity int NULL,
  price_paise bigint NULL,
  price_source text NULL CHECK (price_source IS NULL OR price_source IN ('ask','bid','ltp_slippage')),
  snapshot_id uuid NULL,
  gross_paise bigint NOT NULL,
  charges jsonb NOT NULL,
  charges_total_paise bigint NOT NULL,
  cash_delta_paise bigint NOT NULL,
  cash_after_paise bigint NOT NULL CHECK (cash_after_paise >= 0),
  position_after int NULL CHECK (position_after IS NULL OR position_after >= 0),
  avg_cost_after_paise bigint NULL,
  realized_pnl_paise bigint NULL,
  note text NULL,
  ref_seq bigint NULL REFERENCES ledger(seq),
  occurred_at timestamptz NOT NULL,
  reveal_at timestamptz NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_participant_idx ON ledger (participant_id, seq);
CREATE INDEX ledger_round_idx ON ledger (round_id);

-- The ledger is append-only (SPEC §11.7).
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

CREATE TABLE positions (
  participant_id text NOT NULL REFERENCES participants(id),
  symbol text NOT NULL,
  quantity int NOT NULL CHECK (quantity >= 0),
  avg_cost_paise bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, symbol)
);

CREATE TABLE marks (
  id uuid PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id),
  round_id uuid NULL REFERENCES rounds(id),
  snapshot_id uuid NOT NULL REFERENCES snapshots(id),
  kind text NOT NULL CHECK (kind IN ('round','eod')),
  marked_at timestamptz NOT NULL,
  cash_paise bigint NOT NULL,
  holdings_value_paise bigint NOT NULL,
  total_paise bigint NOT NULL,
  reveal_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marks_participant_idx ON marks (participant_id, marked_at);

CREATE TABLE corporate_actions (
  id uuid PRIMARY KEY,
  symbol text NOT NULL,
  type text NOT NULL CHECK (type IN ('split','bonus','dividend')),
  ex_date date NOT NULL,
  ratio_num int NULL,
  ratio_den int NULL,
  amount_paise_per_share bigint NULL,
  source_url text NOT NULL,
  entered_by text NOT NULL,
  applied_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE symbol_flags (
  symbol text PRIMARY KEY,
  flag text NOT NULL,
  reason text NOT NULL,
  set_at timestamptz NOT NULL,
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warn','critical')),
  title text NOT NULL,
  detail text NOT NULL,
  public_message text NOT NULL,
  scope text NOT NULL,
  participant_id text NULL,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX incidents_open_key ON incidents (key) WHERE resolved_at IS NULL;

CREATE TABLE admin_log (
  id uuid PRIMARY KEY,
  command text NOT NULL,
  args jsonb NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_state (
  id int PRIMARY KEY CHECK (id = 1),
  paused boolean NOT NULL,
  paused_reason text NULL,
  publish_market_table text NOT NULL DEFAULT 'after_close' CHECK (publish_market_table IN ('after_close','never')),
  updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO arena_state (id, paused, paused_reason, updated_at) VALUES (1, false, NULL, now());

CREATE TABLE daily_jobs (
  date date NOT NULL,
  job text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, job)
);

CREATE TABLE heartbeats (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  outcome text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anchors (
  date date PRIMARY KEY,
  season_id text NOT NULL,
  first_seq bigint NOT NULL,
  last_seq bigint NOT NULL,
  entries int NOT NULL,
  head_hash text NOT NULL,
  commit_sha text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
