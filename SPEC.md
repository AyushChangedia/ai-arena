# AI Arena — Build Spec v1

Five AI models. ₹1,00,000 of paper money each. Real NSE prices. A public, verifiable record of every decision.

This file is the single source of truth for the build. `CLAUDE.md` summarises the rules for every session; if the two ever differ, this file wins and you flag the difference.

---

## 0. How to use this spec

You (Claude Code) are the only engineer on this project. Read this section, §2 and §3 before any work, then the sections for the current phase.

**Phases.** Work in the phases of §21, in order. One phase = one branch = one PR. A phase is done only when every acceptance check for it passes and you have pasted the commands you ran and their key output into `PROGRESS.md`.

**PROGRESS.md.** Create it in Phase 0 and keep it current. Exact format:

```markdown
# Progress
Current phase: <n> — <name>
Last updated: <YYYY-MM-DD HH:mm IST>

## Done (verified)
- [x] <item> — verified by `<command>` → <one-line result>

## In progress
- [ ] <item> — <state>

## Blocked on the human
1. <exact step-by-step instructions, what to paste back>

## Not verified / known gaps
- <anything built but not proven, and why>

## Next
- <first thing the next session should do>
```

**You don't have production secrets.** Anything that needs a live service (Angel One, OpenRouter, production Neon, Telegram, Healthchecks) runs in the GitHub Actions workflow `smoke.yml`, which the human triggers from GitHub. Ask them to run it and paste back the job summary. Never ask the human to paste a secret into the chat; they add secrets to GitHub or Vercel directly.

**When you need the human** (an account, a key, a payment, a dashboard setting, an approval): stop, explain why in one sentence, and give numbered click-by-click steps plus exactly what to paste back.

---

## 1. What we're building

A public website plus a scheduled engine.

- On every NSE trading day, at 12 fixed times, the engine shows each AI model the same market snapshot plus its own portfolio, collects its decision, checks every action against the rules, fills valid actions at real prices, charges real Indian trading costs, and records everything in an append-only, hash-chained ledger.
- The website shows the race between the models, every trade, every rejected action, each model's own reasoning, two benchmarks (Nifty 50 and a random "Monkey" trader), the arena's health, and a way for anyone to verify that the ledger hasn't been altered.

**Success criteria**

1. Every number on the site traces to a ledger entry, a portfolio mark, or a recorded price snapshot. Nothing is estimated, mocked or typed in by hand.
2. Every failure (API down, bad data, invalid answer, missed schedule) is visible on the site in plain words, and never produces a fake trade or a fake number.
3. The arena runs unattended for a full 20-trading-day season, with API spend around $5–10 a month on the budget model tier.
4. It looks distinctive, reads clearly, and is fast on a mid-range Android phone on 4G.

---

## 2. Non-negotiable rules

### 2.1 Integrity: no fake trades, no fake numbers

1. Only the engine writes trading data. The website connects with a read-only database role that can `SELECT` from the public views (§15) and nothing else.
2. Every displayed number derives from the ledger, the portfolio marks, or a recorded price snapshot. If a value can't be sourced, show "—" with a tooltip saying why. Never show 0, a guess, or an interpolated value instead.
3. No mock, sample, placeholder, demo or "lorem" data anywhere outside `**/test/**`. Seed scripts refuse to run unless the database name ends in `_test`. CI enforces this (§20).
4. Models never set prices, fills, fees or balances. Any price a model mentions is ignored. Fills come only from the fill snapshot (§11.4).
5. No auto-correcting model output beyond the normalisation in §11.2. An invalid action is rejected with a code and shown publicly as rejected.
6. No silent substitution. Never route a participant to a different model: no OpenRouter `models` fallback list, no auto-router. Verify the `model` field of every response (§9.6). Never switch market-data sources silently.
7. The ledger is append-only (enforced by a database trigger), hash-chained (§11.7), and anchored daily in git (§12.6).
8. Money is integer paise: `bigint` in TypeScript, `BIGINT` in Postgres. Quantities are integers. Floats are allowed only for indicators and display ratios.
9. Paper trading only. The codebase contains no broker order, modify or cancel calls. CI greps for them (§20).
10. Determinism. The same stored inputs must produce the same ledger hashes (replay, §19.4). The only randomness is the Monkey's seeded PRNG, and its seed is recorded.
11. Time: store UTC `timestamptz`; schedule and display in `Asia/Kolkata`; label displayed times "IST".

### 2.2 Honesty during development

1. Don't say something works unless you ran it in this session. Paste the command and its key output. Otherwise write "not verified" and why.
2. No silent stubs. Unimplemented paths throw `NotImplementedError("<what>")` and are listed in PROGRESS.md under "Not verified / known gaps".
3. Never weaken, skip or delete a failing test to get green. Fix the code, or explain in PROGRESS.md and ask.
4. Never invent API response shapes. Read the provider's current docs, validate every response with zod, and build test fixtures from real responses recorded by `smoke.yml` (sanitised: no tokens, no account identifiers).
5. Nothing outside this spec without asking first.

### 2.3 Security

1. Secrets live only in GitHub Actions secrets (engine) and Vercel environment variables (web gets only the read-only DB URL and the revalidation secret). Never in code, logs, commits, PR text, fixtures, artifacts or the database.
2. The logger redacts any field whose key matches `/(key|secret|token|password|pin|totp|authorization|cookie)/i`, and also redacts the literal values of all configured secrets wherever they appear.
3. Never store or log broker login responses; they contain session tokens.
4. Model output is untrusted text. Render it as plain text with line breaks preserved. No HTML, no markdown-to-HTML.
5. GitHub Actions: pin third-party actions to commit SHAs, give each workflow the minimum `permissions`, and never expose secrets to `pull_request` runs from forks.
6. Secret scanning (gitleaks) runs in CI on every push.

---

## 3. Arena rules (the game)

All values live in `config/arena.json`. Code reads the config; the `/rules` page renders from the same file, so the rules shown are always the rules enforced.

| Rule | Value |
|---|---|
| Universe | Nifty 50 constituents, NSE cash market, EQ series (`config/universe/nifty50.json`) |
| Starting cash | ₹1,00,000 per participant (10,000,000 paise) |
| Product | **Intraday, long or short** (the owner's choice, 2026-10-26; `product: "intraday_long_short"`). A BUY opens or adds to a long; a SELL opens or adds to a short (negative quantity). Net positions: a SELL closes a long first and any shares beyond it open a short; a BUY covers a short first and any shares beyond it open a long. No leverage, no F&O. (Seasons up to S0 ran long-only delivery, `product: "long_only_delivery"`, which the engine still supports.) |
| Square-off | Intraday: from `intraday.squareOffFrom` (15:00 IST) the engine closes every open position, and every position should be closed by `intraday.squareOffDeadline` (15:15 IST) (§12.3a). Nothing is held overnight; every trading day starts in cash |
| Round times | Set in `arena.json` `schedule`. Free-tier seasons (the owner's choice, 2026-10-25): 09:30, 11:00, 12:30 and 14:00 IST, 4 rounds. Paid tiers: 09:30 to 14:30 IST every 30 minutes, 11 rounds (intraday: the last round plus its grace window must end before the square-off; config validation enforces it). NSE trading days only |
| Max actions per round | 5 |
| Concentration limit | A trade that opens or adds to a position may not take that stock above 25% of total portfolio value, long or short (absolute value). Price drift above 25% is allowed |
| Exposure limit | Intraday: after a trade that opens or adds to a position, longs plus shorts at market value may not exceed `limits.maxGrossExposurePct` (100%) of total portfolio value. No leverage |
| Order size | Whole shares, quantity ≥ 1, no partial fills |
| Execution order | All SELLs (in the model's order), then all BUYs (in the model's order); each checked against the running state |
| Same symbol both sides | A BUY of a symbol that is also sold in the same round is rejected |
| Fill price | BUY at best ask, SELL at best bid from the fill snapshot. If depth is missing: last traded price ± 5 bps slippage. The method used is recorded |
| Costs | Real Indian equity-intraday charges, discount-broker profile, with a flat ₹20 brokerage per executed order (the owner's choice, 2026-10-26), `config/fees.json` (§11.5) |
| Sale proceeds | Usable immediately in the same round (simplification, disclosed on /rules) |
| Corporate actions | Intraday: none apply, since nothing is held overnight. (Delivery: splits and bonuses adjust quantity and average cost on the ex-date; cash dividends are credited on the ex-date for shares held at the previous close.) |
| Strategy | Each answer states the model's strategy, and each action the signal behind it (`why`) and an exit plan (the owner's request, 2026-10-26; §10.3). Published, never acted on |
| Missed round | Portfolio unchanged; shown as missed with the reason |
| Season | 20 trading days. Every participant restarts at ₹1,00,000. An admin can end a season early (`end-season`, §18.1), as when S0 ended after its first day for the switch to intraday (the owner's choice, 2026-10-26) |
| Public delay | Each round appears on the site 15 minutes after it finishes |

### 3.1 Participants

Configured in `config/models.json`:

- Paid tiers: five model slots, `openai`, `anthropic`, `google`, `meta`, `deepseek`. The free tier (§3.2) fields the labs in `config/roster-rules.json` that have a free model today; on 2026-10-25 only Google among the five had one, so the free slots also include NVIDIA, Xingchen AGI and Recursive (the owner's choice; Thinking Machines' Inkling was tried and dropped because OpenRouter serves it only to coding agents). On 2026-10-30 the owner chose to swap the busiest free model: Google's free Gemma 4 models are excluded (Gemma 4 31B got HTTP 429 in most P1 rounds; Gemma 4 26B was busy in a test call too), and NVIDIA's Nemotron 3 Ultra, which answered that test, takes a second NVIDIA slot, `ultra`. The swap starts a new practice season (P2), per rule 6 below. Slot names are lowercase slugs, and the site's model pages follow the config.
- Two benchmarks that appear on the leaderboard but are visually quieter:
  - **Nifty 50**: ₹1,00,000 "invested" in the index at the season's first fill snapshot, no costs. Value = 1,00,000 × index now ÷ index at start.
  - **Monkey**: a seeded random trader that follows the same rules and pays the same costs (§11.9).

### 3.2 Picking the models (Phase 3, human approves)

1. Call OpenRouter `GET /api/v1/models`.
2. For each slot, pick that lab's current model in the chosen tier. `budget` = each lab's fast, cheap tier. `flagship` = each lab's top general model. `free` (the owner's choice for running at no cost, 2026-10-25) = each configured lab's newest OpenRouter `:free` model; a lab with no free model today sits out the season, and a free roster has 3 to 6 models. Mixing tiers across slots is not allowed. Prefer dated or pinned model IDs. Free models come with OpenRouter's limits (50 free requests a day on an account that has never bought credit, 20 a minute) and their capacity can disappear; a round a free model can't answer is missed with its reason, like any other provider failure. Use a schedule whose daily calls (models × rounds, plus repairs) stay well under the daily limit.
3. Meta: the open Llama line stopped at Llama 4; Meta's current model is Muse Spark (closed, available through Meta's API and OpenRouter). Offer the human a choice: Muse Spark (current), or Llama 4 Maverick (older and cheap, a deliberate underdog). Show both in the approval table.
4. For each model record: OpenRouter ID, display name, 3-letter short code, jersey colour (§16.1), `supported_parameters` (structured outputs, reasoning, temperature), price per million input and output tokens, context length.
5. Show the human the table and an estimated monthly cost (§9.7). Write `config/models.json` only after they approve.
6. Never change a participant's model during a season. If a model becomes unavailable mid-season, retire it (§13).

---

## 4. Architecture

```
GitHub Actions  (tick.yml: every 10 min, 08:32–16:22 IST, Mon–Fri)
   │
   └── engine CLI (Node + TypeScript)
          ├── Angel One SmartAPI ── quotes, market depth, daily candles, instrument master
          ├── OpenRouter ─────────── all five models, one API key, prepaid credits
          ├── Telegram bot ───────── alerts (optional)
          └── Healthchecks.io ────── dead-man's switch (optional)
          │
          ▼
   Neon Postgres  (source of truth: ledger, decisions, snapshots, marks, incidents)
          │   read-only role, public views with the 15-minute delay built in
          ▼
   Next.js on Vercel  (cached pages, refreshed by on-demand revalidation from the engine)

   End of day: the engine commits public-data/ (the day's ledger, rounds, decisions, marks)
   and a ledger anchor (head hash) to this repo: a public audit trail and a backup.
```

Why each piece:

- **Engine as a CLI.** The scheduler is swappable. If Angel One blocks GitHub's runner IPs, or GitHub's schedule proves unreliable, the same CLI runs on a small VM (Plan B, §18.4) with no code changes.
- **GitHub Actions.** Free for public repositories on standard runners, with built-in secrets and logs. Known limits you must design around: scheduled runs can be delayed or dropped, and scheduled workflows in public repositories are disabled automatically after 60 days without repository activity. Hence frequent idempotent ticks (§12.2), a keepalive workflow and a dead-man's switch (§18.3).
- **Neon free plan.** 100 CU-hours a month and 0.5 GB per project, compute suspends after 5 idle minutes. Fix compute at 0.25 CU. The website must not query the database per visitor; it serves cached pages that the engine refreshes (§16.8).
- **OpenRouter.** One key for all five labs, one SDK shape, prepaid credits act as a hard spending cap, and the response reports the cost of each call. Fee: 5.5% on credit purchases; token prices are passed through.
- **Angel One SmartAPI.** Free market data for account holders, and the API login (client code + MPIN + TOTP) can run unattended. Sessions expire at midnight IST, so the engine logs in fresh for each round. (Upstox's API is also free, but its token needs a browser login every day, which can't run unattended.)
- **SEBI retail algo framework.** In force since 1 April 2026; it governs orders sent through broker APIs (registered static IP and so on). This project sends no orders, so it doesn't apply, but Phase 1 must prove Angel One's data endpoints work from a GitHub runner.

---

## 5. Tech stack

- The current Node.js LTS (24 or newer), pnpm workspaces, TypeScript in strict mode (`any` only with a comment explaining why).
- zod for every external response and every config file.
- Drizzle ORM with committed SQL migrations; `pg` in the engine; `@neondatabase/serverless` in the web app.
- Luxon for time (`Asia/Kolkata`); `otplib` or `otpauth` for TOTP; pino for structured logs with redaction; native `fetch` with our own timeout and retry wrapper (no SDK-level automatic retries).
- Next.js (current stable, App Router, server components), Tailwind CSS driven by CSS-variable tokens, TradingView Lightweight Charts for time series (keep its attribution; its licence requires it), `next/og` for share images.
- Vitest with fast-check for property tests, Playwright with axe-core for end-to-end and accessibility, ESLint (flat config), Prettier, gitleaks.

Use current stable versions and check the docs for any API that may have changed since your training data, especially Next.js caching and revalidation, OpenRouter request parameters, and Angel One endpoints.

---

## 6. Repository layout

```
ai-arena/
  CLAUDE.md  SPEC.md  PROGRESS.md  README.md  .env.example
  package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js
  config/
    arena.json                 rules, schedule, limits, delay, season settings
    models.json                roster (written in Phase 3 after approval)
    fees.json                  charge rates as fractions, with sources and verified date
    calendar/nse-2026.json     trading holidays (+ next year when NSE publishes it)
    universe/nifty50.json      constituents, effective date, source URL
  packages/
    shared/    zod schemas, types, money (paise) utils, formatters, canonical JSON, ledger hash
    db/        Drizzle schema, migrations, roles, public views, typed read queries for web
    engine/
      src/
        cli.ts               commands (§7.3)
        config/              loading + validation
        data/                Angel One provider, snapshots, validation, indicators, calendar, universe
        llm/                 OpenRouter client, capabilities, prompt renderer, parser, errors, budget
        core/                validator, fees, executor, positions, ledger, marks, metrics, benchmarks, corporate actions
        round/               tick, slots, round runner, pre-market, end-of-day, reconcile, export, anchors
        ops/                 alerts, heartbeat, revalidate, admin commands
      test/                  unit, property, integration tests and fixtures (fixtures live ONLY here)
  apps/
    web/                     Next.js app
  public-data/               written by the engine at end of day (§12.6)
  .github/workflows/         ci.yml tick.yml smoke.yml migrate.yml admin.yml keepalive.yml
```

---

## 7. Configuration and secrets

### 7.1 Environment variables

| Name | Used by | Required | How to get it |
|---|---|---|---|
| `DATABASE_URL_OWNER` | `migrate.yml` only | yes | Neon's default owner role. Used only to run migrations and create roles; never by the engine or web |
| `DATABASE_URL` | engine | yes | Neon, role `engine_rw` (created by migration; password set by the human in Neon) |
| `DATABASE_URL_READONLY` | web | yes | Neon, role `web_ro` (created by migration; password set by the human in Neon) |
| `OPENROUTER_API_KEY` | engine | yes | openrouter.ai → Keys. Set a credit limit on the key |
| `ANGEL_API_KEY` | engine | yes | smartapi.angelone.in → create an app. If the dashboard offers app types, choose market data, not trading |
| `ANGEL_CLIENT_CODE` | engine | yes | Angel One client ID |
| `ANGEL_MPIN` | engine | yes | Angel One MPIN (API login uses the MPIN, not the web password) |
| `ANGEL_TOTP_SECRET` | engine | yes | Base32 secret shown when enabling TOTP for SmartAPI |
| `WEB_BASE_URL` | engine | from Phase 5 | Vercel production URL |
| `REVALIDATE_SECRET` | engine + web | from Phase 5 | Random 32+ character string |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | engine | optional | @BotFather, then message the bot and read the chat ID |
| `HEALTHCHECKS_PING_URL` | engine | optional | healthchecks.io check URL |
| `ARENA_MODE` | engine + web | yes | `shadow` or `live` |

### 7.2 Config validation

Every config file and the environment are parsed with zod at startup. On failure, the engine exits **before doing any work** with a message that names the variable or field, says what's wrong, and says how to fix it (for example: `ANGEL_TOTP_SECRET is missing. Add it in GitHub → Settings → Secrets and variables → Actions.`). Optional services that aren't configured are reported as "not configured" and skipped cleanly; their absence is never an error.

### 7.3 CLI commands

| Command | What it does |
|---|---|
| `pnpm doctor` | Checks env and config, DB connection and migrations, Angel One login, OpenRouter key and remaining credit, every configured model ID exists and supports the parameters we send, Telegram, Healthchecks, the revalidation endpoint. Prints a pass/fail table; exits non-zero on any required failure. Never prints secret values |
| `pnpm engine snapshot --dry` | Logs in to Angel One, fetches quotes for the universe, validates them, prints a summary table. No DB writes |
| `pnpm engine roster --tier budget\|flagship` | Proposes the roster table from OpenRouter's model list (§3.2). Writes nothing |
| `pnpm engine decide --participant <slot> --dry` | Builds the real prompt from a live (or the latest stored) snapshot, calls the model, parses and validates the answer against the participant's current portfolio, prints the result. No ledger writes |
| `pnpm engine tick` | The scheduled entry point (§12.1). `--dry` runs everything except ledger writes, alerts and revalidation |
| `pnpm engine replay --round <id>` | Recomputes a stored round from its stored snapshots and stored raw model responses; compares hashes |
| `pnpm engine reconcile [--date YYYY-MM-DD]` | Rebuilds positions and cash from the ledger and checks them against stored positions, marks and the hash chain |
| `pnpm verify-ledger [--file path]` | Verifies a hash chain from the DB or from an exported `ledger.jsonl` |
| `pnpm admin <command>` | §18.1 |

All commands write a Markdown summary to `$GITHUB_STEP_SUMMARY` when it is set, so results are readable in the GitHub mobile app.

---

## 8. Market data (Angel One SmartAPI)

Read the current SmartAPI docs before implementing; the paths below were correct when this spec was written and must be verified. Wrap all of it behind a `MarketDataProvider` interface (`login`, `instruments`, `quotes`, `indexQuotes`, `dailyCandles`) so a second provider can be added later without touching the engine.

### 8.1 Login

- Login with client code + MPIN + a TOTP generated at call time (`loginByPassword`). Sessions expire at midnight IST; log in fresh once per round and once per pre-market or end-of-day job. Never persist the session token.
- If login fails with an invalid-TOTP error, wait for the next 30-second TOTP window and retry once. Any other login failure: no retry; the round is skipped with reason `DATA_LOGIN_FAILED` (§13).

### 8.2 Instruments and universe

- Download the instrument master once per trading day in the pre-market job. Map each universe symbol to exactly one NSE equity instrument (`<SYMBOL>-EQ`, NSE segment). Look up the tokens for the Nifty 50 index and India VIX by name.
- If any universe symbol maps to zero or multiple instruments, that symbol is untradeable for the day and an incident is raised. Never guess a mapping.
- `config/universe/nifty50.json` holds the constituents, the effective date and the source URL (niftyindices.com publishes the official list). NSE rebalances the index semi-annually (end of March and end of September); the pre-market job raises a reminder incident in the last two weeks of those months.
- A held stock that leaves the index can still be sold but not bought.

### 8.3 Snapshots

A snapshot is one batched fetch of full quotes (LTP, OHLC, previous close, volume, best 5 bid/ask, exchange feed time) for the universe plus index quotes, stored with: purpose (`decision`, `fill`, `valuation`), fetch start and end times, source, the provider's raw response (sanitised), and per-symbol validation results. Respect the provider's per-request instrument limit and rate limits; batch and throttle with a token-bucket limiter. A quote request that fails (an error reply such as AB4030, a network error or a timeout) is retried once after `marketData.quoteRetryDelaySeconds` (3 s); a second failure fails the snapshot. A changed response shape or an expired session is not retried this way (added 2026-10-30, the owner's decision: one AB4030 reply had skipped the whole 09:30 round on 29 Oct).

### 8.4 Quote validation (per symbol, per snapshot)

A quote is valid only if all of these hold. Otherwise the symbol is `NO_PRICE` for that snapshot, with the reason recorded:

1. The response parsed against the zod schema; missing fields are never defaulted to 0.
2. LTP > 0, previous close > 0.
3. Exchange feed time is within 5 minutes of the snapshot time during market hours (configurable).
4. |LTP ÷ previous close − 1| ≤ 20%, unless a corporate action for that symbol has today as its ex-date.
5. If bid and ask are present: both > 0 and bid ≤ ask. Otherwise depth is marked unavailable (fills fall back to LTP + slippage) but the quote stays valid.

If more than 5 of the 50 symbols are invalid, or the index quote is invalid, the whole snapshot is rejected and the round is skipped (`DATA_DEGRADED`).

### 8.5 Daily bars and indicators

- Fetch 60+ trading days of daily candles per symbol when a season is set up; then append the previous day's bar in each pre-market job.
- Compute per symbol, from completed daily bars only: SMA20, SMA50, RSI14, 5-day and 20-day returns (the returns use today's LTP against the close 5 or 20 trading days ago), 20-day average volume. If history is too short for an indicator, omit it; never fill with 0.

### 8.6 Market calendar

- `config/calendar/nse-<year>.json` lists trading holidays with the source (NSE's holiday circular). Weekends are closed. Special sessions (for example Muhurat trading) are out of scope for v1: the arena simply doesn't run.
- Safety net: if quotes during scheduled market hours carry exchange times from a previous day, treat the market as closed, skip the round (`MARKET_CLOSED_UNSCHEDULED`) and raise an incident asking for a calendar update.

### 8.7 Corporate actions

- Admins enter corporate actions with `pnpm admin corp-action` (symbol, type `split|bonus|dividend`, ratio or amount per share, ex-date, source URL). On the ex-date, before the first round, the engine writes ledger entries that adjust quantity and average cost (split/bonus) or credit cash (dividend) for every participant holding the stock at the previous close.
- Gap guard: at the first round of each day, if a held symbol's open differs from its previous close by more than 15% and no corporate action is recorded, flag the symbol `SUSPENDED_REVIEW`: it can't be traded, the holding shows "Under review" on the site, a critical incident is raised, and it stays that way until an admin either enters the corporate action or clears the flag. Valuations keep using real market prices; the badge tells viewers why a number may look odd.

### 8.8 Display rights

Broker data is licensed for the account holder's use. Angel One's forum has indicated public display is acceptable but directs formal requests to their API team, so the human emails them before launch (§22). Until then, and by design anyway:

- The site never shows a live quote board or ticker. It shows trade fill prices, holdings valuations and portfolio values, all with the 15-minute delay.
- The full per-round market table (the data the models saw) is published only after that day's market close (`publishFullMarketTable: "after_close"` in `arena.json`; other allowed values: `"never"`).
- The footer credits the data source and states the delay.

---

## 9. LLM layer (OpenRouter)

### 9.1 Request

`POST https://openrouter.ai/api/v1/chat/completions` with:

- `model`: the exact configured ID. No `models` array, no auto-router.
- `messages`: one system message (static rules, §10.1) followed by one user message (round data, §10.2). Static content first, so provider prompt caching can help.
- `response_format` with a JSON schema, only if the model lists structured outputs in `supported_parameters`. Send a provider-safe schema (types, enums, required, `additionalProperties: false`); enforce lengths and counts in our own validation, not in the schema.
- `reasoning: { effort }` and `temperature` only where supported, with the same values for every participant (default effort `medium`, temperature `0.3`).
- `max_tokens`: enough for reasoning plus the answer (default 4000).
- Provider routing: `require_parameters: true` (only hosts that support what we send). Falling back between hosts of the *same* model is fine; falling back to a different model never is.
- Usage accounting enabled, so the response carries token counts and cost.

### 9.2 Capabilities

At roster time and in `pnpm doctor`, read each model's `supported_parameters` and pricing from `/api/v1/models` and store them in `config/models.json`. Never send a parameter a model doesn't support.

### 9.3 Parsing the answer

1. Take the message content. Accept, in this order: the whole content as JSON; JSON inside a single fenced code block; the first balanced top-level `{…}` object. Store the full raw content regardless.
2. The decision is **valid** if it parses to an object with an `actions` array. `reasoning` and `note_to_self` are stored if they're strings, otherwise stored as empty with a `missing_reasoning` flag.
3. Each action is validated individually (§11). One malformed action never invalidates the others.

### 9.4 One repair attempt

If the decision is invalid, send exactly one follow-up in the same conversation: "Your reply couldn't be read: <parser error>. Reply again with only the JSON object described in the rules." If that also fails, the decision is `INVALID_RESPONSE`: no trades, shown publicly as "Unreadable answer", and it counts against the model's clean-answer rate. When the first reply stopped at the output-token limit (`finish_reason: "length"`), the parser error says so ("the reply ran out of room: it used all N output tokens (M on thinking)…") and the repair call uses `llm.repairReasoningEffort` (low) instead of the usual effort, so the model has room to answer (added 2026-10-26 after Flint's replies came back empty).

### 9.5 Errors

| Signal | Class | Behaviour |
|---|---|---|
| 401, 403 | `CONFIG_AUTH` | No retry. This model is `MISSED_CONFIG`. Critical alert. If every model gets it, the key is bad: pause the arena |
| 402 | `CREDITS_EXHAUSTED` | No retry. Pause the arena (all models share the key). Critical alert. Public banner: "Rounds are paused: the arena is out of API credit." |
| 404 or "model not found" | `MODEL_UNAVAILABLE` | No retry. `MISSED_CONFIG`. Critical alert. Admin decides: retire the model (§13) |
| 408, 5xx, network error, timeout | `TRANSIENT` | Up to 2 retries with exponential backoff and jitter (2 s, then 6 s), each attempt with a 120 s timeout. Then `MISSED_PROVIDER` |
| 429 (provider busy) | `TRANSIENT` | Up to 2 retries after `llm.rateLimitRetryDelaysSeconds` (20 s, then 60 s), or longer if a `Retry-After` header asks, capped at `maxRetryAfterSeconds` (90 s). The daily free-model limit ("free-models-per-day") is never retried. Then `MISSED_PROVIDER` (added 2026-10-26: free models returned 429 within seconds) |
| Empty content, refusal, unparseable | `BAD_OUTPUT` | One repair attempt (§9.4), then `INVALID_RESPONSE` |
| Response `model` differs from configured | `MODEL_MISMATCH` | Record nothing as a decision; status `MODEL_MISMATCH`. Critical alert |

Each participant is called in parallel and isolated: one model's failure never delays or affects another. The decision phase has a hard deadline of 6 minutes; anything unfinished by then is `MISSED_PROVIDER` (timeout).

### 9.6 Model identity check

OpenRouter returns the serving model in the response. It must equal the configured ID, or be a dated variant of it that OpenRouter documents as the same model. Anything else is `MODEL_MISMATCH`.

### 9.7 Budget

- `models.json` sets a monthly USD cap per participant (default: 1.5 × that model's approved monthly estimate). Before each call, if that participant's recorded spend this calendar month is at or above the cap, skip the call: status `SKIPPED_BUDGET`, public status "Paused (budget)". A free model's cap is $0: it runs while its calls cost nothing and is paused at the first billed call.
- The pre-market job checks the key's remaining credit (`/api/v1/key` or `/api/v1/credits`, whichever is current) and raises a warning under $3 and a critical alert under $1. With a free-tier roster no credit is needed, so these thresholds don't apply.
- Cost estimate shown in the roster approval table: rounds per month (rounds per day × ~21) × (estimated input tokens × input price + estimated output tokens incl. reasoning × output price), per model and total. For the free tier the table shows $0 and the model calls per day against the free daily limit.
- A `:free` model's responses may name it without the `:free` suffix; that counts as the same model for the identity check (§9.6).

### 9.8 Recording

For every call record: prompt hash, request parameters (no secrets), raw response body, parsed result, serving model, attempts, latency, input/output/reasoning tokens, cost in USD (`cost_estimated = true` if computed from token prices because the response didn't include it).

---

## 10. The trader prompt

**Since 2026-10-26 (the owner's decisions):** the rules list is rendered for the configured product. For `intraday_long_short` it replaces rules 2, 4 and 5 below with: intraday long or short (a short has a negative quantity); the square-off from `intraday.squareOffFrom` (by `squareOffDeadline` at the latest), nothing held overnight; net positions (a SELL closes a long first, then opens a short; a BUY covers a short first, then opens a long; a BUY needs cash for its full cost); the concentration limit for any trade that opens or adds to a position, long or short, plus the exposure limit. Costs read "{flat} INR per order (brokerage with GST), plus about {buy}% … and about {sell}% …" with no DP charge. The schedule line adds "then the square-off at {time} IST". Every product adds an "Explain your trading" paragraph asking for a strategy, a `why` (the signal and what the model expects) and an `exit_plan` per action, stating that an exit plan is not an order, and the reply format adds `"strategy"` (up to 600 characters) and `"exit_plan"` (up to 200 characters); `why` grows to 400 characters. The per-round message under intraday adds "Square-off: {time} IST today." to the first line and shows "Positions value (longs minus shorts)", "Exposure (longs plus shorts) … limit {pct}%" and signed positions. The engine's snapshot tests pin both renderings.

Identical for every participant. Don't tell a model which lab it is or who it's competing against. All numbers come from the engine's data; bracketed values are filled from config and the database. Numbers in the prompt are plain decimals (no lakh commas, no ₹ symbol) to avoid parsing mistakes.

### 10.1 System message (static for the season)

```
You are a portfolio manager in AI Arena, a public competition between AI models trading Indian stocks with paper money at real prices on the National Stock Exchange (NSE). Each round you receive the same market data as every other competitor plus your own portfolio, and you decide what to trade.

Objective: finish the season with the highest total portfolio value (cash plus holdings at market prices). The season runs from {season_start} to {season_end} ({season_trading_days} trading days). Every competitor started with 100000.00 INR.

Rules. They are enforced by code; an action that breaks one is rejected, and the rejection is published.
1. Trade only symbols listed in the MARKET table, spelled exactly as shown. Symbols listed under NO_PRICE can't be traded this round.
2. Long-only cash delivery: no short selling, no leverage, no derivatives.
3. Quantity is a whole number of shares, at least 1. There are no partial fills.
4. SELL only shares you hold. BUY only what your cash covers after costs.
5. A BUY may not take that stock above {max_weight_pct}% of your total portfolio value.
6. At most {max_actions} actions per round. All SELLs run first, then all BUYs, each in the order you list them, so cash from sells can fund buys.
7. Don't BUY a symbol you are also selling in the same round.
8. Orders fill a minute or two after you answer, at the live best ask (BUY) or best bid (SELL), not at the prices shown here.
9. Costs: about {buy_cost_pct}% of trade value on a BUY; about {sell_cost_pct}% on a SELL plus {dp_charge} INR per stock on each day you sell it.
10. To make no trades, return an empty actions list.

There are {rounds_per_day} rounds per trading day, at {round_times} IST. Your reasoning, actions and note to self are published 15 minutes after each round.

Reply with only a JSON object, with no markdown and no other text:
{"reasoning": "<your analysis, up to 1200 characters>",
 "actions": [{"side": "BUY" or "SELL", "symbol": "<symbol>", "quantity": <integer>, "why": "<up to 200 characters>"}],
 "note_to_self": "<up to 500 characters; you will see it next round>"}
```

`{buy_cost_pct}`, `{sell_cost_pct}` and `{dp_charge}` are computed from `config/fees.json` at render time, never hardcoded.

### 10.2 User message (per round)

```
ROUND {n} of {rounds_today} today, {weekday} {date}, {time} IST. Season day {d} of {D}. Next round: {next_round}.

YOUR PORTFOLIO
Cash: {cash} INR
Holdings value: {holdings_value} INR
Total value: {total} INR ({return_pct}% since season start)
Holdings (symbol, qty, avg_price, last_price, value, weight_pct, unrealized_pnl):
{holding rows, or "none"}

YOUR LAST 5 ROUNDS (newest first)
{e.g. "2026-11-03 11:00: BUY 10 TCS filled at 3412.50 | SELL 5 INFY rejected: you held 0 INFY"}
{e.g. "2026-11-03 10:30: no actions"}
{e.g. "2026-11-03 10:00: missed (provider timeout)"}

YOUR NOTE TO SELF FROM LAST ROUND
{note, or "none"}

MARKET at {snapshot_time} IST (NSE, prices in INR)
NIFTY 50: {value} ({chg_pct}% today){, India VIX: {vix} — only if available}
Columns: symbol,ltp,chg_pct,open,high,low,prev_close,vol_today,avg_vol_20d,ret_5d_pct,ret_20d_pct,sma20,sma50,rsi14
(sma20, sma50 and rsi14 are daily values as of the previous close)
{one CSV row per valid symbol; omitted indicators are left empty, never 0}
NO_PRICE this round: {symbols with reason, or "none"}
```

### 10.3 Answer schema (zod, enforced after parsing)

- `strategy` (since 2026-10-26): string, the model's approach (setups, sizing, exits); stored in `decisions.strategy`, displayed up to 600 characters on its panel, the round page and the Thinking tab. Missing → flag `missing_strategy` and "No strategy given"; it never blocks the trades.
- `reasoning`: string; stored in full, displayed up to 1,200 characters with a "show full answer" toggle.
- `actions`: array. Each item: `side` ∈ {BUY, SELL}; `symbol` string; `quantity` integer ≥ 1 (a string "10" or 10.5 is invalid, not converted); `why` string (display up to 400 characters); `exit_plan` string (since 2026-10-26: a target, stop or time; stored in `actions.exit_plan`, display up to 200 characters; published, never acted on).
- `note_to_self`: string, stored up to 500 characters (truncation flagged).

---

## 11. Validation, execution and the ledger

### 11.1 Pipeline (per participant, per round)

1. Parse the decision (§9.3).
2. Normalise symbols (§11.2).
3. Order actions: SELLs in the model's order, then BUYs in the model's order. Actions beyond the 5th (in the model's original order) are rejected `TOO_MANY_ACTIONS` first.
4. For each action, check it against the running state (cash and positions after the actions already accepted) at fill-snapshot prices. Accept or reject with exactly one code.
5. Write all accepted fills, their charges and the resulting positions in **one database transaction** per participant. If the transaction fails, nothing is written for that participant, the decision is marked `EXECUTION_FAILED`, and it is **not retried later** (a later price would be a different trade).

### 11.2 Symbol normalisation (the only allowed cleanup)

Trim whitespace, uppercase, strip a leading `NSE:` and a trailing `.NS` or `-EQ`. Nothing else. No fuzzy matching, no name-to-symbol lookup.

### 11.3 Rejection codes

| Code | Meaning | Model's fault |
|---|---|---|
| `MALFORMED_ACTION` | Not an object, or missing side/symbol/quantity | yes |
| `INVALID_SIDE` | Side isn't BUY or SELL | yes |
| `INVALID_QUANTITY` | Not a JSON integer ≥ 1 | yes |
| `UNKNOWN_SYMBOL` | Not in the universe (a trade that opens a position), or not held (a SELL under long-only rules) | yes |
| `NOT_IN_UNIVERSE_FOR_BUY` | A position in a stock that left the index: it can be closed, not added to | yes |
| `DUPLICATE_ACTION` | Same side and symbol already in this round | yes |
| `CONFLICTING_SIDES` | BUY of a symbol also sold this round | yes |
| `TOO_MANY_ACTIONS` | Beyond the 5th action | yes |
| `INSUFFICIENT_HOLDINGS` | SELL quantity > shares held | yes |
| `INSUFFICIENT_CASH` | BUY cost including charges > available cash | yes |
| `CONCENTRATION_LIMIT` | A trade that opens or adds to a position would take the stock above 25% of total value (long or short) | yes |
| `EXPOSURE_LIMIT` | Intraday: longs plus shorts would exceed 100% of total value (no leverage) | yes |
| `PRICE_UNAVAILABLE` | No valid fill price for the symbol | no |
| `SYMBOL_SUSPENDED` | Symbol under corporate-action review or an admin halt | no |

Only "model's fault" codes count against the model's accepted-action rate.

### 11.4 Fills

- The fill snapshot is taken once, right after the decision phase ends, and used for every participant in that round. Same moment, same prices: fair, and no participant's order affects another's (paper trading has no market impact).
- BUY at best ask; SELL at best bid. If depth is unavailable for that symbol: LTP × (1 + 5 bps) for buys, LTP × (1 − 5 bps) for sells, rounded to the nearest paisa. Record `price_source` (`ask`, `bid`, `ltp_slippage`) and the snapshot ID on every fill.

### 11.5 Charges

**Intraday profile (committed since 2026-10-26, the owner's choice):** brokerage a flat ₹20 per executed order (`flatPaisePerOrder: "2000"`; real discount brokers charge the lower of ₹20 and 0.03%), STT 0.025% (1/4000) on the sell side only, exchange 0.00297%, SEBI ₹10 per crore, IPFT ₹0.10 per lakh (as below), stamp duty 0.003% (3/100,000) on buys, GST 18% on brokerage + exchange + SEBI + IPFT (the flat brokerage included), no DP charge (`dpCharge: null`). A charge may carry a rate and a flat amount per order; the flat part is added before rounding, and GST applies to the exact base including it. The delivery profile below is kept as a test fixture (`packages/engine/test/fixtures/delivery/`) with its golden cases; intraday has its own golden cases.

`config/fees.json` stores each rate as an exact fraction (numerator/denominator), plus source URLs and a `verifiedOn` date. Defaults, from the brokers' published charges pages for equity delivery as of October 2026 (re-verify in Phase 2 and record the date):

| Charge | Rate | Applies to |
|---|---|---|
| Brokerage | ₹0 (discount-broker delivery) | each order |
| STT | 0.1% (1/1000) | buy and sell value (unchanged by Budget 2026 for delivery) |
| Exchange transaction (NSE) | 0.00297% (297/10,000,000) | buy and sell value |
| SEBI turnover fee | ₹10 per crore (1/1,000,000) | buy and sell value |
| IPFT (NSE) | ₹0.10 per lakh (1/1,000,000) | buy and sell value |
| Stamp duty | 0.015% (3/20,000) | buy value only |
| GST | 18% | on brokerage + exchange transaction + SEBI fee + IPFT |
| DP charge | ₹15.93 per stock per day it's sold (varies by broker; verify) | first SELL of each symbol per day |

Computation is in BigInt paise. Each charge is rounded half-up to the nearest paisa per order. Disclose on /rules: real contract notes round some charges (STT, for example) to the rupee, so a real broker's costs may differ by about a rupee per order. Golden test cases in Phase 2 must match a broker's online calculator to the paisa for each charge, before rounding differences.

### 11.6 Positions, average cost, realised P&L

Intraday positions are signed: a short has a negative quantity, and its average cost is its average sale price. Closing part of a short books (average sale price − buy price) × quantity − that order's charges. A trade that crosses zero books realised P&L on the part that closed (less the whole order's charges), and the new position's average cost is the fill price. Holdings value is Σ quantity × price, so a short counts negative and total value = cash + longs − shorts.

- Average cost = weighted average fill price of the shares currently held, excluding charges (how brokers show it). Charges hit cash and therefore total value and total return exactly.
- On SELL: realised P&L = (fill price − average cost) × quantity − that order's charges. Average cost of the remaining shares doesn't change.
- Positions are stored for speed but are always rebuildable from the ledger; reconciliation (§12.7) proves they match.

### 11.7 Ledger and hash chain

Ledger entry types: `SEASON_START` (starting cash), `BUY`, `SELL`, `DIVIDEND`, `SPLIT_ADJUST`, `BONUS_ADJUST`, `RETIRE` (a closing marker written after a retired participant's holdings are sold; no cash change).

- Append-only. A trigger raises an exception on any `UPDATE`, `DELETE` or `TRUNCATE` of the ledger table. The engine's role has `INSERT` and `SELECT` only on it.
- Appends are serialised with `pg_advisory_xact_lock`. `seq` is a gap-free sequence assigned inside that lock.
- `hash = sha256_hex(canonical_json(entry without hash))`, where the entry includes `prev_hash` (the previous entry's hash; the first entry uses 64 zeros).
- Canonical JSON: object keys sorted lexicographically at every level, no whitespace, integer money and quantities as decimal **strings**, timestamps as ISO 8601 UTC with milliseconds and `Z`, `null` included for empty fields, UTF-8. One implementation in `packages/shared`, used by the engine, the web app (Web Crypto) and `verify-ledger`.
- Corrections are new entries, never edits. If a past entry turns out wrong (for example, a corporate action entered late), write an adjusting entry that references the original and explains why in a `note` field.

### 11.8 Marks and metrics

- After execution, every participant (benchmarks included) is marked at the fill snapshot: cash, holdings value, total. End of day: a `valuation` snapshot at about 15:42 IST, labelled "day-end mark (last traded price)", because NSE's official closing price is a different calculation.
- Metrics, all derived from marks and the ledger:
  - Total return = total ÷ starting cash − 1.
  - Today = latest mark ÷ previous day-end mark − 1.
  - vs Nifty = participant return − Nifty benchmark return (percentage points).
  - Max drawdown from the series of round marks.
  - Trades (count), turnover, total charges paid.
  - Win rate = share of closing fills (a SELL of a long, or a BUY that covers a short) with positive realised P&L (shown only after 5).
  - Clean answers = OK decisions ÷ (OK + `INVALID_RESPONSE`).
  - Uptime = rounds with a model answer (OK or invalid) ÷ rounds held.
  - Accepted actions = executed ÷ (executed + model-fault rejections).
  - API spend (USD) this season.
  - Sharpe (daily returns, annualised with √252, risk-free 0) shown only after 10 trading days, labelled as such.

### 11.9 Benchmarks

- **Nifty 50**: computed from index quotes in each fill snapshot; no ledger trades; marked like everyone else.
- **Monkey**: each round, a mulberry32 PRNG seeded with the first 32 bits of `sha256(round_id + ":monkey")`. With probability ½ it does nothing. Otherwise one action: if it holds anything and a coin flip says sell, SELL a random holding, random quantity from 1 to all; else BUY a random tradeable symbol sized at a random 5–20% of total value at the decision snapshot's LTP, rounded down to whole shares. Intraday: it closes part of a random position (SELL a long, BUY back a short), or opens a random position whose side (long or short) is drawn last, so long-only rounds replay unchanged. It goes through the same validator, fills and charges. The seed is stored in its decision record so the round replays exactly.

---

## 12. Round lifecycle

### 12.1 The tick

`tick.yml` runs `pnpm engine tick` on cron `2,12,22,32,42,52 3-10 * * 1-5` (UTC), which is every 10 minutes from 08:32 to 16:22 IST (written as a minute list since 2026-10-25; the step form `2-59/10` never fired). Minutes ending in 2 avoid the top-of-the-hour congestion on GitHub's scheduler. The workflow uses a concurrency group with `cancel-in-progress: false`, so runs never overlap.

Each tick:

1. Load and validate config and env. Connect to the DB. On failure: exit non-zero, ping Healthchecks `/fail`, alert if possible.
2. If the arena is paused (`arena_state`): record any due slot as a round with status `SKIPPED_PAUSED` and the pause reason (so it isn't later mistaken for a scheduler miss), record a heartbeat, exit.
3. If today isn't a trading day: heartbeat "closed", exit.
4. If the pre-market job hasn't run today and it's between 08:30 and 09:25 IST: run it (§12.4).
5. Mark any slot whose grace window has passed without a round as `MISSED_SCHEDULE` (raises a warning incident).
6. Find a due slot: scheduled time ≤ now < scheduled time + 20 minutes, with no round row yet. If found, run the round (§12.3).
6b. Intraday: if it's between `intraday.squareOffFrom` and `schedule.endOfDayAfter` and anyone in the season has an open position, run the square-off (§12.3a). It also runs while the arena is paused, unless the pause is for a reconciliation mismatch.
7. If it's after 15:40 IST and end of day hasn't run: run it (§12.5).
8. If end of day has run, the day-end marks' reveal time has passed, and today's export hasn't run: export and anchor (§12.6). With ticks until 16:22 IST there are several chances; if all fail, the next trading day's pre-market job retries it.
9. If any reveal time (a round's or the day-end marks') has passed since the last revalidation: call the web's revalidation endpoint.
10. Write the step summary, ping Healthchecks `/success`, exit.

### 12.2 Slots and grace

Slots come from `arena.json` (default 09:30 … 15:00 every 30 minutes). A slot runs at most once: `rounds` has a unique key on (season, trading date, slot time), and the round row is inserted with `ON CONFLICT DO NOTHING` before any work starts; whoever inserts it owns it. The round records both the scheduled time and the actual start time; the site shows the actual time.

### 12.3 Running a round

1. Insert the round (status `RUNNING`).
2. Log in to Angel One. Take the decision snapshot and validate it (§8.4). If rejected: status `SKIPPED_DATA` with the reason, incident, go to step 8 (so the skipped round still appears on the site with its reason).
3. Render the prompt (§10) for each model participant. Store the shared market block once per round and each participant's private block with its decision.
4. Call all models in parallel (§9). Generate the Monkey's decision. Persist each decision as soon as it settles (its own transaction).
5. Take the fill snapshot (all universe symbols plus the index). If rejected: every decision is marked `NOT_EXECUTED_DATA`, round status `PARTIAL`, no fills, no marks, incident, go to step 8.
6. Execute each participant (§11.1), one transaction each.
7. Mark every participant at the fill snapshot.
8. Set status `COMPLETED` (or `PARTIAL` if anything above degraded), `finished_at`, and `reveal_at = finished_at + 15 minutes`. Every row from this round (decisions, actions, ledger entries, marks) shares this `reveal_at`, so the whole round becomes public at once.
9. Raise alerts for anything abnormal (§17).

### 12.3a The intraday square-off (since 2026-10-26)

1. Load every participant with an open position; if there are none, do nothing.
2. Insert a round with `kind = 'square_off'` and `slot_time` = the current IST minute (`ON CONFLICT DO NOTHING`; another run owns it otherwise). It counts towards no participant's uptime or accepted actions, and the site labels it "Square-off at HH:MM IST".
3. Take a fill snapshot (all universe symbols plus the index). If login or the snapshot fails: `SKIPPED_DATA`, incident `squareoff:<date>` (warn; critical after the deadline), and the next tick tries again.
4. For each participant with positions: an engine decision with status `SQUARE_OFF` and closing orders (SELL each long, BUY back each short, in symbol order), executed through the normal validator and charges with the limits on opening positions switched off. A symbol without a valid price stays open.
5. Mark every participant at the snapshot. `COMPLETED` if nothing is left open, else `PARTIAL` with the open symbols and an incident. Finishing after the deadline raises `squareoff-late:<date>` (warn).
6. End of day (§12.5) closes anything still open at the valuation snapshot (the day-end last traded price), labelled as such; if even that fails the position is held overnight with a critical incident, and the next square-off closes it.

### 12.4 Pre-market job (once per trading day, 08:30–09:25 IST)

Download the instrument master and validate the universe mapping; append yesterday's daily bars and recompute indicators; apply corporate actions whose ex-date is today; check OpenRouter credit; check universe-rebalance and calendar-year reminders; retry a missed previous-day export; record the job in `daily_jobs`.

If the job hasn't succeeded by the first slot, rounds still run using the latest successful instrument mapping; indicators that couldn't be refreshed are omitted from the prompt (never stale-labelled as fresh, never 0) and a warning incident is raised. Corporate actions due today block trading in the affected symbols (`SYMBOL_SUSPENDED`) until they're applied.

### 12.5 End of day (once per trading day, after 15:40 IST)

1. Valuation snapshot. Intraday: anything still open is closed at it (§12.3a step 6). Then day-end marks for everyone (`reveal_at` = marked time + 15 minutes).
2. Reconciliation (§12.7).
3. Daily digest alert: standings, incidents, spend, reconciliation result.

Export and anchoring wait until the day-end marks are public (§12.1 step 8).

### 12.6 Public data export and anchors

After the day's last reveal time has passed, write `public-data/YYYY/MM/DD/` with `rounds.jsonl`, `decisions.jsonl` (reasoning, actions, statuses, note to self, model ID, tokens, cost; plus the market tables if `publishFullMarketTable` allows), `ledger.jsonl` (canonical form), `marks.jsonl`, and `public-data/anchors/YYYY-MM-DD.json` (`date`, `season`, `first_seq`, `last_seq`, `entries`, `head_hash`). Commit with message `data: YYYY-MM-DD [skip ci]` using the workflow's token (`contents: write` on that job only). Configure Vercel's ignored-build step so commits touching only `public-data/` don't redeploy. If branch protection on `main` blocks the Actions bot, commit to a dedicated `data` branch instead and link anchors from there. The git history timestamps every day's head hash; rewriting the ledger would require rewriting public git history.

### 12.7 Reconciliation

Rebuild every participant's cash and positions from the ledger alone; compare with stored positions and with the day's last marks; re-verify the hash chain for the day's entries and its link to the previous day's anchor. Any mismatch: critical incident, the arena is **paused automatically**, and the site shows "Numbers under review since <time>. Rounds are paused until this is resolved." Never silently fix data; corrections are new ledger entries (§11.7) made by an admin with a written reason.

### 12.8 Crash recovery

If a tick finds a round still `RUNNING` more than 15 minutes after it started, mark it `ABORTED`. Participants whose execution transaction committed keep their fills (they're consistent, thanks to per-participant transactions); everyone else gets `MISSED_ABORTED`. Raise a critical incident. Never resume a half-finished round: prices have moved.

### 12.9 Seasons

`pnpm admin start-season --id S1 --start YYYY-MM-DD --mode live` creates the season and its participants and writes `SEASON_START` entries at the first round. A season ends after its last trading day's end-of-day job; final standings are frozen and archived at `/seasons/<id>`. `pnpm admin end-season --id S0 --reason …` ends a season early: status `finished`, `ends_on` = its last trading day with rounds, `trading_days` = the days it held rounds; the ledger is untouched and its standings freeze at the last day-end marks. Shadow seasons (`mode: shadow`) never appear in live leaderboards; the site shows them only when `ARENA_MODE=shadow`, behind a banner and `noindex`.

---

## 13. Failure-mode matrix

| # | Failure | Detected by | Engine does | Site shows | Alert |
|---|---|---|---|---|---|
| 1 | Missing or invalid env/config | zod at startup | Exits before any work | Nothing changes; /status shows last good round time | Critical (Actions failure email; Telegram if configured) |
| 2 | Angel One login fails | Login error | Skip round `SKIPPED_DATA` (`DATA_LOGIN_FAILED`) | Banner: "Rounds are paused: market data isn't coming through. Holdings haven't changed since <time>." | Critical |
| 3 | Session expires mid-round | 401 / session error | Re-login once, else as #2 | As #2 | Critical |
| 4 | Some quotes invalid | §8.4 | Those symbols `NO_PRICE`; actions on them `PRICE_UNAVAILABLE` | Round page lists unavailable stocks | Warn |
| 5 | Too many invalid quotes, or index invalid | §8.4 | Skip round `DATA_DEGRADED` | "Round skipped: market data was incomplete." | Warn; critical after 2 in a row |
| 6 | Unscheduled market closure | Stale exchange times | Skip `MARKET_CLOSED_UNSCHEDULED` | "Market closed" | Warn (update calendar) |
| 7 | OpenRouter 401/403 | §9.5 | `MISSED_CONFIG`; if all models, pause arena | Model status "Offline"; paused banner if all | Critical |
| 8 | Out of credit (402) | §9.5 | Pause arena | "Rounds are paused: the arena is out of API credit." | Critical |
| 9 | Rate limit / provider error / timeout | §9.5 | Retry, then `MISSED_PROVIDER` for that model only | "Missed round: provider timeout" on that model | Warn; critical after 3 in a row |
| 10 | Model removed or renamed (404) | §9.5 | `MISSED_CONFIG`; admin retires it: at the next round its holdings are sold at the fill snapshot with normal charges, then a `RETIRE` entry closes it; its final value is cash | "Retired on <date>: model no longer available. Holdings sold; final value ₹…" | Critical |
| 11 | Serving model ≠ configured | §9.6 | `MODEL_MISMATCH`, no trades | "Missed round: wrong model served" | Critical |
| 12 | Unreadable answer | §9.3–9.4 | Repair once, then `INVALID_RESPONSE`, no trades | "Unreadable answer" in the round and the model's blunders | — (it's part of the game) |
| 13 | Invalid individual action | §11.3 | Reject that action only | The rejection with its reason, e.g. "Tried to sell 40 HDFCBANK, held 0" | — |
| 14 | Budget cap reached | §9.7 | `SKIPPED_BUDGET` | "Paused (budget)" | Info |
| 15 | DB unreachable | Connect / query error | Exit before calling any model | Cached pages keep showing the last good data; /status can't update | Critical via Healthchecks `/fail` |
| 16 | Execution transaction fails | DB error | `EXECUTION_FAILED` for that participant, no retry | "Not executed: recording failed" | Critical |
| 17 | Fill snapshot fails after decisions | §12.3 step 5 | `NOT_EXECUTED_DATA` for all | "Decisions made, not executed: market data failed" | Critical |
| 18 | GitHub runs late | Slot logic | Run within grace using the actual time | Actual start time shown | — |
| 19 | GitHub skips beyond grace | Next tick | `MISSED_SCHEDULE` | "Round missed: scheduler didn't run" on /status | Warn (Healthchecks catches total silence) |
| 20 | Workflow disabled (60-day rule) | keepalive + Healthchecks | keepalive re-enables weekly | /status goes stale | Critical via Healthchecks |
| 21 | Overlapping runs | Concurrency group + unique slot row | Second run exits | — | — |
| 22 | Crash mid-round | Stale `RUNNING` row | `ABORTED` per §12.8 | "Round aborted" with per-model detail | Critical |
| 23 | Price gap with no corporate action | §8.7 gap guard | `SUSPENDED_REVIEW` for that symbol | "Under review" badge on holdings | Critical |
| 24 | Reconciliation mismatch or broken hash chain | §12.7 | Pause arena | "Numbers under review since <time>." | Critical |
| 25 | Provider response shape changed | zod parse failure | Treat as data error (#2 or #5), never default fields | As #2 / #5 | Critical, with the failing field path |
| 26 | Universe symbol unmapped | §8.2 | Symbol untradeable for the day | Listed on /status | Warn |

Public messages come from `incidents.public_message`, written in the same plain voice as above. Internal details (stack traces, provider error bodies) never reach the site.

---

## 14. Database schema

Migration `0003_intraday_strategy.sql` (2026-10-26): `positions.quantity` may be negative (check `quantity <> 0` replaces `>= 0`), `ledger.position_after` may be negative, `rounds.kind text not null default 'trading' check (kind in ('trading','square_off'))`, `decisions.strategy text null`, `actions.exit_plan text null`; the public views gain `v_rounds.kind`, `v_decisions.strategy`, `v_actions.exit_plan` and `v_actions.position_after`, and `v_holdings` lists shorts too. The block below is the original schema.

Write the Drizzle schema and migrations to match this. Money columns are `BIGINT` paise. Every table has `created_at timestamptz default now()`.

```sql
seasons(id text pk, name text, mode text check (mode in ('shadow','live')), starts_on date, ends_on date,
        trading_days int, starting_cash_paise bigint, status text, index_at_start_x100 bigint null)

participants(id text pk, season_id fk, kind text check (kind in ('model','index','monkey')), slot text,
        display_name text, short_code text, color text, openrouter_model_id text null, model_config jsonb,
        status text check (status in ('active','paused_budget','retired')), retired_at timestamptz null,
        retired_reason text null, unique(season_id, slot))

instruments(symbol text pk, broker_token text, exchange text, name text, tick_size_paise int, refreshed_on date)
universe_versions(id serial pk, effective_from date, symbols text[], source_url text)
daily_bars(symbol text, date date, open_paise bigint, high_paise bigint, low_paise bigint, close_paise bigint,
        volume bigint, primary key(symbol, date))
indicators(symbol text, date date, sma20_paise bigint null, sma50_paise bigint null, rsi14 numeric null,
        avg_vol_20d bigint null, primary key(symbol, date))

snapshots(id uuid pk, purpose text check (purpose in ('decision','fill','valuation')), fetch_started_at timestamptz,
        fetch_finished_at timestamptz, source text, raw jsonb, valid_count int, invalid_count int,
        status text check (status in ('ok','rejected')), reject_reason text null)
quotes(snapshot_id fk, symbol text, ltp_paise bigint null, bid_paise bigint null, ask_paise bigint null,
        open_paise bigint null, high_paise bigint null, low_paise bigint null, prev_close_paise bigint null,
        volume bigint null, exchange_time timestamptz null, valid boolean, invalid_reason text null,
        primary key(snapshot_id, symbol))
index_quotes(snapshot_id fk, name text, value_x100 bigint null, prev_close_x100 bigint null,
        exchange_time timestamptz null, valid boolean, primary key(snapshot_id, name))

rounds(id uuid pk, season_id fk, trading_date date, slot_time time, scheduled_at timestamptz,
        started_at timestamptz, finished_at timestamptz null, reveal_at timestamptz null,
        status text, status_reason text null, decision_snapshot_id uuid null, fill_snapshot_id uuid null,
        market_block text null, trigger text check (trigger in ('cron','manual')),
        unique(season_id, trading_date, slot_time))

decisions(id uuid pk, round_id fk, participant_id fk, status text, error_class text null, error_detail text null,
        private_block text, prompt_sha256 text, request_params jsonb, raw_response text null, parsed jsonb null,
        reasoning text null, note_to_self text null, flags text[], serving_model text null, attempts int,
        latency_ms int null, input_tokens int null, output_tokens int null, reasoning_tokens int null,
        cost_usd numeric(12,6) null, cost_estimated boolean, rng_seed text null, reveal_at timestamptz null,
        unique(round_id, participant_id))

actions(id uuid pk, decision_id fk, position int, side_raw text, symbol_raw text, quantity_raw jsonb,
        why text null, side text null, symbol text null, quantity int null,
        status text check (status in ('executed','rejected')), reject_code text null, reject_detail text null,
        model_fault boolean)

ledger(seq bigint pk, id uuid unique, season_id fk, participant_id fk, round_id uuid null, action_id uuid null,
        entry_type text, symbol text null, side text null, quantity int null, price_paise bigint null,
        price_source text null, snapshot_id uuid null, gross_paise bigint, charges jsonb, charges_total_paise bigint,
        cash_delta_paise bigint, cash_after_paise bigint, position_after int null, avg_cost_after_paise bigint null,
        realized_pnl_paise bigint null, note text null, ref_seq bigint null, occurred_at timestamptz,
        reveal_at timestamptz, prev_hash text, hash text unique)
  -- trigger: raise exception on UPDATE, DELETE, TRUNCATE

positions(participant_id fk, symbol text, quantity int, avg_cost_paise bigint, primary key(participant_id, symbol))
marks(id uuid pk, participant_id fk, round_id uuid null, snapshot_id uuid, kind text check (kind in ('round','eod')),
        marked_at timestamptz, cash_paise bigint, holdings_value_paise bigint, total_paise bigint,
        reveal_at timestamptz)

corporate_actions(id uuid pk, symbol text, type text, ex_date date, ratio_num int null, ratio_den int null,
        amount_paise_per_share bigint null, source_url text, entered_by text, applied_at timestamptz null)
symbol_flags(symbol text pk, flag text, reason text, set_at timestamptz, cleared_at timestamptz null)

incidents(id uuid pk, key text, severity text, title text, detail text, public_message text,
        scope text, participant_id uuid null, started_at timestamptz, resolved_at timestamptz null)
admin_log(id uuid pk, command text, args jsonb, reason text, actor text, at timestamptz)
arena_state(id int pk check (id = 1), paused boolean, paused_reason text null, updated_at timestamptz)
daily_jobs(date date, job text, status text, started_at timestamptz, finished_at timestamptz, detail jsonb,
        primary key(date, job))
heartbeats(id bigserial pk, at timestamptz, outcome text, detail jsonb)
anchors(date date pk, season_id text, first_seq bigint, last_seq bigint, entries int, head_hash text,
        commit_sha text null)
```

Roles: `engine_rw` (all tables; on `ledger` only `INSERT` and `SELECT`), `web_ro` (`SELECT` on the `v_*` views only, no base tables).

---

## 15. Public data rules

- Public views (`v_participants`, `v_rounds`, `v_decisions`, `v_actions`, `v_ledger`, `v_marks`, `v_incidents`, `v_status`, `v_anchors`, `v_market_tables`) filter on `reveal_at <= now()` and expose only public columns. `v_market_tables` additionally applies the `publishFullMarketTable` policy (§8.8). `v_incidents` exposes `public_message`, never `detail`.
- `v_decisions` exposes reasoning, note to self, actions, status, serving model, tokens, cost and latency; it doesn't expose raw request parameters.
- The web app imports read functions from `packages/db` that query only `v_*` views. An integration test proves `web_ro` gets "permission denied" on every base table and that unrevealed rows are invisible.

---

## 16. Web app

### 16.1 Design direction: a night match on Dalal Street

The subject is a competition watched live by Indian viewers, so the site borrows the visual language Indian audiences already read fluently for a live contest: the floodlit night-match broadcast. A **score bug** (the strip of live scores from TV coverage) is the signature element; each AI wears a **jersey colour** like a franchise; new rounds arrive with a broadcast-style **reveal**. Everything around those three things stays quiet and disciplined. The site is an instrument for following a race, not a trading terminal.

Tokens (CSS variables):

| Token | Value | Use |
|---|---|---|
| `--bg` (stadium night) | `#0D1A2B` | page background (a deep navy, not neutral black) |
| `--surface` | `#142338` | panels |
| `--surface-2` | `#1B2D46` | raised and hover states |
| `--line` | `#263A56` | hairlines and dividers |
| `--text` (floodlight) | `#F2F5F9` | primary text |
| `--text-2` | `#93A4BA` | secondary text |
| `--accent` (scoreboard amber) | `#FFB648` | live state, the current round, focus rings, primary buttons; nothing else |
| `--gain` | `#3DDC97` | gains, always with ▲ and a + sign |
| `--loss` | `#FF6B6B` | losses, always with ▼ and a − sign |

Jersey colours (chart series and identity chips; deliberately not the labs' brand colours): OpenAI slot sky `#5AB8F0`, Anthropic slot lavender `#B39DFF`, Google slot pink `#F48FC1`, Meta slot teal `#2EC4C4`, DeepSeek slot sand `#E6C88A`; Nifty 50 floodlight `#F2F5F9` dashed; Monkey slate `#93A4BA` dotted. Check that each series colour has at least 3:1 contrast against `--bg` and a CIEDE2000 distance of at least 15 from every other series colour; adjust and record if not. Colour is never the only identifier: chart lines carry end labels with the short code, and chips always show the short code.

Typography: one variable grotesk family with a width axis. Condensed widths for the score bug, big numbers and the round reveal (the scoreboard feel); normal width for everything else. Candidates: Archivo or Mona Sans. Requirements, verified before choosing: includes the rupee sign ₹ (U+20B9), supports tabular figures (`font-variant-numeric: tabular-nums` on every number), and is self-hosted through `next/font`. Type scale 1.25 from a 16 px base (13, 16, 20, 25, 31, 39, 49 px). Body line height 1.5; prose lines at most 72 characters. Shape: 6 px radius on chips and buttons, 10 px on panels, no drop shadows (depth comes from surface steps and hairlines).

Voice: sentence case everywhere, plain verbs, no exclamation marks.

### 16.2 Layout

Mobile (375 px), single column, 16 px gutters:

```
┌───────────────────────────────────┐
│ AI Arena                 ● Live   │  header; chip states: Live, Closed, Paused
│ Round 7 of 12, next at 12:00 IST  │
├───────────────────────────────────┤
│ 1 DSK ₹1,04,212 ▲4.21%  2 CLD ₹1… │  score bug: sticky, horizontal scroll with snap
├───────────────────────────────────┤
│ Portfolio value                   │
│ [multi-line chart, end labels]    │
│ Today  5D  Season       ₹  %      │
├───────────────────────────────────┤
│ Round 7 at 11:30 IST              │
│ DSK  Bought 12 TCS                │
│      IT names held up while…      │
│ CLD  Held                         │
│ GEM  Rejected: sell 40 HDFCBANK,  │
│      held 0                       │
│ …                                 │
├───────────────────────────────────┤
│ Standings | Rounds | Blunders     │  tabs
└───────────────────────────────────┘
```

Desktop (≥ 1024 px, max width 1200 px, 12 columns): header; score bug full width; left 8 columns: chart, then standings table; right 4 columns: latest round, then recent blunders. All content left-aligned.

### 16.3 Pages

1. **`/` Arena.** Header with market-state chip, IST clock and countdown to the next round (computed client-side from the schedule in config, no DB call). Score bug ranked by total value (rank, short code chip, value, return since start). Portfolio value chart: all participants, ranges Today / 5D / Season, ₹ or % toggle, crosshair tooltip listing every participant sorted by value at that moment, end-of-line labels, benchmarks drawn quieter, "View as table" link. Latest revealed round: one row per participant with a verdict ("Bought 12 TCS", "Sold 30 ITC, bought 8 LT", "Held", "Missed round: provider timeout", "Unreadable answer", "Paused (budget)") and the first line of its reasoning; expand for full reasoning, fills, prices and charges. Standings table: rank with movement since yesterday, participant, value, return, today, vs Nifty, max drawdown, trades, status; sortable. Recent blunders: the last 10 model-fault rejections in plain words. Footer (§24). The Nifty 50 benchmark appears in the score bug, chart and standings but not in round panels (it makes no decisions); the Monkey appears everywhere, labelled "Monkey (random)".
   **Strategy and reasons (the owner's request, 2026-10-26):** each model panel adds the model's latest stated strategy and the reason for its latest trade, and notes the intraday square-off time. The round panel shows the strategy, every action's why and exit plan. Trades read in plain words under net positions: Bought, Sold, Shorted, Bought back.
   **Model panels (the owner's request, 2026-10-25):** directly under the score bug, one panel per AI model: chip and name, rank, "Started with ₹1,00,000", "Worth now", profit or loss in rupees and percent (gain colour with ▲ and +, loss colour with ▼ and −), what it did in the latest revealed round with the first line of its reasoning, and its portfolio (each holding's shares, value and unrealised profit or loss, then cash), linking to its model page. Before the first round the panels show the line-up with "No trades yet" and all cash. Same delayed public views as the rest of the page.
2. **`/models/[slug]`.** Chip, name, exact model ID, status. Key figures: value, return, vs Nifty, max drawdown, trades, clean answers, accepted actions, uptime, API spend. Chart of value against the Nifty benchmark. Holdings: quantity, average price, last price (delayed), value, weight bar, unrealised P&L, "Under review" badge where flagged. Allocation as a single stacked horizontal bar (not a donut). Under intraday the section is "Open positions" (a short shows as negative with "short"; the allocation bar appears only without shorts). Tabs: Trades (with a **Why** column: the model's reason and exit plan for each fill, or "Square-off: the engine closed the position"), Thinking (round by round: strategy, analysis, actions with outcomes, reasons and exit plans, note to self), Blunders, Report card (uptime strip of the last 60 rounds, latency, tokens, spend).
3. **`/rounds`** (by day, with status) and **`/rounds/[id]`.** Scheduled time, actual start, decision and fill snapshot times, status and reason. Every participant's move side by side. The shared system prompt; the shared market block (after close, per policy); each participant's private block. Fills with price source. Missed or skipped participants with reasons.
4. **`/trades/[seq]`.** Side, symbol, quantity, fill price and its source, snapshot time, every charge line, cash before and after, position after, realised P&L, the model's "why", links to the round and decision. Ledger panel: `seq`, `prev_hash`, `hash`, previous and next entry links, and a **Check this trade** button that recomputes the hash in the browser and shows "This trade matches the public ledger" or exactly what didn't match.
5. **`/verify`.** How the ledger and anchors work in plain words. Current head hash. Daily anchors with links to their git commits. Download a day's `ledger.jsonl`. "Check a whole day" runs the chain check in the browser and reports the result. Instructions for `pnpm verify-ledger --file`.
6. **`/status`.** Arena state, last completed round, data feed status, each participant's last 24 rounds as a strip (answered, invalid, missed), open and resolved incidents with their public messages and times, admin actions from `admin_log`, upcoming holidays, season dates.
7. **`/rules`.** Rendered from `arena.json` and `fees.json`: the rules table, the cost table with sources and verified date, how fills work, the 15-minute delay, simplifications, methodology, FAQ ("Is this real money?", "Can I copy these trades?", "Why did a model miss a round?", "How do I know the numbers are real?"), disclaimer.
8. **`/seasons/[id]`.** Final standings and chart of a finished season.
9. **404 and error pages** in the site's voice, with a way back to the arena.

### 16.4 States and copy

- **Before the season:** "Season 1 starts <weekday> <date> at 9:30 IST." (for example "Season 1 starts Monday 2 Nov at 9:30 IST.", with the real date from the season record) with a countdown and a link to the rules. No chart, no table, no placeholder lines.
- **Market closed:** chip "Closed"; "Next round: Monday 9:30 IST."
- **Paused:** amber-outlined banner with the incident's public message and "Holdings haven't changed since <time>."
- **Shadow mode:** a persistent banner "Private preview. These rounds are a test run and will be reset before Season 1." and `noindex`.
- **Data unreachable with no cached page:** "The arena's records aren't reachable right now. Try again in a few minutes." Never zeros.
- **Missing value:** "—" with a tooltip giving the reason ("No price this round", "Needs 10 trading days").
- Vocabulary is fixed across the site: round, bought, sold, held, missed round, unreadable answer, rejected, paused, retired, under review.
- Buttons say what they do: "Check this trade", "Download this day's ledger", "View as table", "Show full answer". No arrows appended to text.

### 16.5 Motion

One orchestrated moment: the **round reveal**. When a viewer has the page open and a new round becomes public (detected after a periodic `router.refresh()` every 5 minutes while the tab is visible during market hours), the score bug re-sorts with a FLIP animation and the latest-round rows appear one after another (about 120 ms apart, under 1.2 s total). On first load nothing animates. Everything else moves only in response to the viewer (expanding a row, switching a tab). `prefers-reduced-motion` turns the reveal into an instant update. An `aria-live="polite"` region announces "Round 7 results are in."

### 16.6 Number and time formatting

One formatter module in `packages/shared`, fully unit-tested:

- Rupees with Indian grouping: `₹1,00,000.00`; compact for tight spaces: `₹1.04L`, `₹2.5Cr` (custom formatter, tested; don't rely on `Intl` compact output).
- Percentages with sign and two decimals: `▲ +4.21%`, `▼ −1.07%` (true minus sign).
- Times as `11:30 IST`, dates as `Mon 2 Nov`. All times in IST regardless of the viewer's time zone.
- Every number uses tabular figures.

### 16.7 Accessibility

WCAG 2.2 AA: text contrast ≥ 4.5:1, visible amber focus rings, full keyboard support, 44 px minimum touch targets, no meaning carried by colour alone, every chart has a summary `aria-label` and a "View as table" equivalent, axe-core reports zero serious or critical issues.

### 16.8 Performance and caching

- Pages are server-rendered and cached. Two cache tags: `live` (arena, model pages, rounds index, status) and `detail` (individual round and trade pages, which never change once revealed). The engine calls `POST /api/revalidate` with `REVALIDATE_SECRET` to refresh `live` after reveals and `detail` after admin corrections. Use the current Next.js tag-revalidation API from its docs. A long time-based revalidation (1 hour) is the safety net.
- No per-visitor database queries. No client-side polling of the database.
- Budgets on a mid-range Android over 4G: LCP < 2.5 s, CLS < 0.05, JavaScript on the arena page ≤ 170 KB gzipped excluding the lazily loaded chart. Lighthouse mobile ≥ 90 for performance, accessibility, best practices and SEO.

### 16.9 Sharing and SEO

Open Graph images generated with `next/og` from revealed data only: the arena image shows the current top three and the Nifty line; model pages show that model's value and return. A "Share standings" button uses the Web Share API on mobile and copies a link elsewhere. Titles like "AI Arena: Season 1, day 6 standings". Shadow mode is `noindex`.

### 16.10 Don'ts

No gradient washes, glassmorphism or glow effects. No all-caps eyebrow labels above headings (team short codes like DSK are content, not labels). No middle-dot separated meta strings. No monospace font for small labels; numbers use tabular figures in the main family. No identical rounded-card grid for every section. No emoji in the interface. No company logos (identity is the chip with short code and jersey colour). No testimonials, "trusted by" rows or invented stats. No lorem ipsum. No "copy this trade" buttons, trade alerts or anything that reads as a stock tip.

---

## 17. Alerts and observability

- **Logs:** pino JSON with redaction; one `tick_id` on every line of a run.
- **Step summary:** every tick writes a short Markdown table (time, what ran, round status, per-participant status, latency, cost, incidents opened) to the GitHub job summary.
- **Telegram (optional):** critical alerts immediately; warnings batched once per tick; one daily digest after end of day. Deduplicate by incident key: one message per key per hour. Each message links to the run and to /status.
- **Healthchecks.io (optional, strongly recommended):** ping `/start` and `/success` or `/fail` every tick. Configure the check with cron `*/10 9-15 * * 1-5`, time zone Asia/Kolkata, 25-minute grace (ticks run 08:32–16:22, so this window never raises a false alarm at the edges). Ticks on holidays still ping success, so there are no false alarms.
- **Incidents:** every abnormal condition opens an incident with a stable key, a severity, internal detail and a plain public message. Incidents resolve automatically when their condition clears (for example, a later successful login) or by admin command.

---

## 18. Operations

### 18.1 Admin commands (CLI and `admin.yml` workflow_dispatch)

`pause --reason`, `resume`, `retire --slot --reason`, `corp-action --symbol --type --ratio|--amount --ex-date --source`, `clear-flag --symbol --reason`, `resolve-incident --id --note`, `start-season --id --start --mode`, `end-season --id --reason` (since 2026-10-26), `correct --ref-seq --reason …` (writes an adjusting ledger entry). Every admin command writes `admin_log`, which `/status` shows publicly. `admin.yml` exposes these as workflow inputs so the human can run them from the GitHub mobile app.

### 18.2 Runbooks (in README)

Rotate a leaked key (Angel One: regenerate TOTP and change MPIN; OpenRouter: revoke and create a new key; update GitHub secrets; run `smoke.yml`). Angel One login keeps failing. Out of OpenRouter credit. A model was removed. Entering a corporate action. Updating the holiday list. Index rebalance. Reconciliation mismatch. Scheduled workflow disabled. Moving to Plan B.

### 18.3 Keepalive and heartbeat

`keepalive.yml` runs weekly and re-enables `tick.yml` through the GitHub REST API (`actions: write` only). Healthchecks catches the case where nothing runs at all.

### 18.4 Plan B hosting

If Angel One rejects requests from GitHub runners, or the GitHub schedule misses slots repeatedly: run the same CLI on a small Linux VM with a static IP in an Indian region (for example Oracle Cloud Always Free in Mumbai or Hyderabad) using a systemd timer every 10 minutes, the same environment variables and the same Healthchecks URL; disable the cron in `tick.yml`. Optionally, a free external cron (cron-job.org) can trigger `tick.yml` via `workflow_dispatch` with a fine-grained token limited to `actions: write`, for more punctual starts than GitHub's own scheduler.

---

## 19. Testing

### 19.1 Unit

Fees (golden cases per charge for buys and sells at several sizes, including the DP charge once per symbol per day), validator (every rejection code, plus valid cases), execution ordering, positions and average cost, realised P&L, metrics, Monkey determinism, formatters, canonical JSON and hash (fixed known vectors), prompt renderer (snapshot tests), output parser (fenced JSON, prose around JSON, missing fields, wrong types), error classification from recorded OpenRouter and Angel One error bodies, slot and grace logic across a full day.

### 19.2 Property tests (fast-check, 1,000 runs each)

For random valid and invalid action sequences: cash never negative; quantities never negative; total value = cash + Σ quantity × price; rebuilding from the ledger reproduces positions and cash exactly; charges never negative; the hash chain always verifies; no accepted BUY ever breaches the concentration limit.

### 19.3 Integration (Postgres service container in CI)

A full round end to end using recorded provider fixtures and recorded model responses: decisions, actions, ledger, marks and views are as expected; unrevealed rows are invisible through `web_ro`; `web_ro` is denied on every base table; `UPDATE` and `DELETE` on the ledger fail; crash recovery marks a stale round `ABORTED`; reconciliation detects a planted mismatch and pauses the arena; two concurrent ticks produce exactly one round.

### 19.4 Replay

`pnpm engine replay` over stored rounds reproduces identical ledger hashes. Run it in Phase 4 on three random shadow rounds and in CI on recorded fixtures.

### 19.5 End to end (Playwright + axe)

Every page at 375, 768 and 1280 px against a test database: renders, empty states, paused banner, shadow banner, "Check this trade" success and a planted failure, keyboard navigation, axe clean. Save screenshots as CI artifacts for design review.

### 19.6 Guard checks (CI, with self-tests proving each catches a planted violation)

- **No mock data:** fail if `faker`, `lorem`, `mock`, `dummy`, `sample data` or `Math.random` appear in non-test source (allowlist: the Monkey's seeded PRNG module), or if any non-test file imports from a `test/` path.
- **No orders:** fail if non-test source contains broker order endpoints or method names (`placeOrder`, `modifyOrder`, `cancelOrder`, `/order/`).
- **No secrets:** gitleaks.

Coverage: ≥ 95% lines and branches on `engine/src/core` and `shared`; ≥ 80% elsewhere in the engine.

---

## 20. CI/CD and workflows

| Workflow | Trigger | Does | Permissions |
|---|---|---|---|
| `ci.yml` | push, PR | install, typecheck, lint, unit, property, integration, guard checks, build web, E2E | `contents: read` |
| `tick.yml` | cron (§12.1), `workflow_dispatch` | `pnpm engine tick`; end-of-day commit of `public-data/` | `contents: write` on the commit job only |
| `smoke.yml` | `workflow_dispatch` with a choice: doctor, snapshot, decide-all, record-fixtures | Live checks with secrets; uploads sanitised fixtures as an artifact with 1-day retention (artifacts on public repos are visible to other GitHub users) | `contents: read` |
| `migrate.yml` | `workflow_dispatch` | Applies migrations to production Neon using `DATABASE_URL_OWNER` | `contents: read` |
| `admin.yml` | `workflow_dispatch` with inputs | Admin commands (§18.1) | `contents: read` |
| `keepalive.yml` | weekly cron | Re-enables `tick.yml` | `actions: write` |

Vercel deploys `apps/web` from `main`; preview deployments for PRs; ignored-build step skips commits that touch only `public-data/`.

---

## 21. Build phases

Each phase ends with its acceptance checks run and recorded in PROGRESS.md, then a PR the human merges.

### Phase 0: Foundations (no external services)

Build: monorepo and tooling; `ci.yml`; zod schemas for env and every config file; `config/arena.json` and `config/fees.json` filled from this spec; `.env.example` documenting every variable from §7.1; logger with redaction; error classes and `NotImplementedError`; `pnpm doctor` reporting every check as "not configured"; guard checks with self-tests; PROGRESS.md; README skeleton.

Accept: CI green. `pnpm doctor` prints the full table and exits non-zero. Each guard check fails on a planted violation and passes without it. A redaction test proves secrets never reach log output.

Human: create the public GitHub repository and add CLAUDE.md and SPEC.md (already done if you're reading this).

### Phase 1: Database and market data

Build: Drizzle schema, migrations, triggers, roles and views from §14–15; `migrate.yml`; the Angel One provider (login, instrument master, quotes, index quotes, daily candles); quote validation; calendar and universe loaders; snapshot persistence; `smoke.yml` (doctor, snapshot, record-fixtures) with step summaries.

Human checkpoint:
1. Neon: create project `ai-arena` (region closest to India that Neon offers), set compute to a fixed 0.25 CU, and add the owner connection string as the GitHub secret `DATABASE_URL_OWNER`. After `migrate.yml` creates the `engine_rw` and `web_ro` roles, set their passwords in the Neon console and add the `engine_rw` connection string as `DATABASE_URL` (keep the `web_ro` one for Vercel in Phase 5).
2. Angel One: an Angel One account is required. Create a SmartAPI app, enable TOTP for SmartAPI and save the base32 secret, then add `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_MPIN`, `ANGEL_TOTP_SECRET` as GitHub secrets.
3. Provide the current Nifty 50 constituents and the NSE 2026 holiday list if they can't be fetched from the build environment (download the CSV from niftyindices.com and the holiday list from nseindia.com, then upload both to the repo).
4. Run `migrate.yml`, then `smoke.yml` (doctor and snapshot), and paste the job summaries.

Accept: Angel One login succeeds from a GitHub runner; all 50 symbols map to exactly one instrument; during market hours ≥ 45 valid quotes with depth for most; outside market hours the "market closed" path is detected correctly; 60+ daily bars stored for every symbol; integration tests for ledger immutability and `web_ro` permissions pass.

### Phase 2: Core engine logic (offline, pure functions)

Build: money utilities, fees, validator and rejection codes, executor, positions, ledger hash chain, marks and metrics, benchmarks including the Monkey, corporate-action adjustments, prompt renderer, output parser.

Accept: coverage targets met; property tests pass; golden fee cases documented with the calculator used and its results; the hash test vectors produce identical output in Node and in a browser (Playwright page evaluation).

### Phase 3: LLM layer

Build: OpenRouter client with timeout and retry policy, capability discovery, `engine roster`, structured outputs where supported, parsing and the repair attempt, error classification, model identity check, budget caps, cost capture; `smoke.yml` decide-all.

Human checkpoint:
1. OpenRouter: create an account, buy $10 of credit, create an API key with a credit limit, add `OPENROUTER_API_KEY` as a GitHub secret.
2. Approve the roster table (including the Meta choice) and the cost estimate.
3. Run `smoke.yml` decide-all and paste the summary.

Accept: all five models return OK decisions in a dry run (against a live snapshot, or the latest stored one if the market is closed); recorded error bodies for 401, 402, 404, 429, 5xx and a timeout are classified correctly in tests; cost recorded for every call.

### Phase 4: Rounds, scheduling and the shadow season

Build: tick, slots and grace, round runner, fill snapshot, per-participant execution transactions, marks, pre-market and end-of-day jobs, reconciliation, export, anchors and the git commit, revalidation call (skipped with a log line while `WEB_BASE_URL` is unset), alerts, heartbeat, `admin.yml`, `keepalive.yml`, `tick.yml`. Then start shadow season S0 with `ARENA_MODE=shadow`.

Human checkpoint: optionally set up the Telegram bot and Healthchecks check and add their secrets; enable `tick.yml`; look at the first day's step summaries.

Accept (needs real market days; the human confirms): at least 3 consecutive trading days in which every slot is either completed or explained (skipped or missed with a reason); zero reconciliation mismatches; replay of 3 random rounds reproduces their hashes; in the test environment, a broken model key, a data outage and a crash mid-round each produce exactly the statuses in §13.

### Phase 5: Web app

Build: tokens and layout, every page in §16.3, charts, states, round reveal, the verify page with in-browser checks, share images, rules rendered from config, status page; Playwright and axe suites; Lighthouse runs. The UI reads real shadow-season data through the public views. Tests use the test database only.

Human checkpoint:
1. Vercel: import the repo, root directory `apps/web`, add `DATABASE_URL_READONLY`, `REVALIDATE_SECRET`, `ARENA_MODE`; add `WEB_BASE_URL` and `REVALIDATE_SECRET` as GitHub secrets.
2. Review the screenshots at 375 and 1280 px and approve the design or list changes.

Accept: every page renders real S0 data; empty, paused, shadow and error states verified against the test database; Lighthouse mobile ≥ 90 in all four categories; axe clean; "Check a whole day" passes on a real shadow day; a revealed round appears on the site within one tick of its reveal time.

### Phase 6: Hardening and launch

Build: security headers and a Content Security Policy; the revalidation endpoint rejects bad secrets and is rate limited; README (what it is, how it works, how to verify the ledger, runbooks, architecture); final copy pass; disclaimers; 404 and error pages.

Human checkpoint: email Angel One's API team to confirm public display of derived data (§8.8); go through the launch checklist (§22); run `pnpm admin start-season --id S1 --start <next Monday> --mode live` (through `admin.yml`); set `ARENA_MODE=live`.

---

## 22. Launch checklist

- [ ] Every acceptance check from Phases 0–5 recorded in PROGRESS.md.
- [ ] Shadow season ran ≥ 3 trading days with zero reconciliation mismatches.
- [ ] `pnpm doctor` passes in `smoke.yml`.
- [ ] OpenRouter balance covers at least two months at the estimated burn; per-model caps set.
- [ ] Healthchecks configured and tested by pausing the tick once.
- [ ] Holiday list covers the whole season; universe file matches the current official list.
- [ ] Angel One display confirmation received, or the "after close" policy confirmed as acceptable.
- [ ] Disclaimers visible in the footer and on /rules.
- [ ] Shadow data excluded from live views; `noindex` removed only for live.
- [ ] README explains how anyone can verify the ledger.

---

## 23. Out of scope for v1

News or fundamentals in the prompt; F&O, intraday or short selling; user accounts, comments or predictions; trade alerts or any "copy trading"; native apps; any model-written commentary containing numbers; more than one universe; special sessions such as Muhurat trading. Candidates for v2: a news-aware season, per-round return bars per model, a head-to-head comparison page, a Nifty Next 50 league.

---

## 24. Disclaimer and attribution text

Footer (every page):

> AI Arena is an experiment in how AI models make decisions. All trading is simulated with paper money; no real orders are placed. Prices are real NSE prices from Angel One SmartAPI, shown with a 15-minute delay. Nothing here is investment advice, and neither this site nor the AI models are SEBI-registered advisers or research analysts. Don't copy these trades.

Also in the footer: a link to the source code, a link to /verify, the chart library attribution required by its licence, and "Last updated <time> IST" taken from the latest revealed round.
