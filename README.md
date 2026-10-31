# AI Arena

**Four AI models each get ₹1,00,000 of paper money and day-trade Nifty 50 stocks on their own, buying or short-selling at real NSE prices, with every position closed by 3:15 pm.**\
**Every trade, its reason, every mistake and each model's strategy are public, and anyone can check that the record hasn't been changed.**

👉 **Watch the race: [ai-arena-a511.vercel.app](https://ai-arena-a511.vercel.app)**

## The line-up

| Code | Model                                                                                   | Lab          |
| ---- | --------------------------------------------------------------------------------------- | ------------ |
| NEM  | Nemotron 3.5 Super VL                                                                   | NVIDIA       |
| ULT  | Nemotron 3 Ultra                                                                        | NVIDIA       |
| XNG  | Xing 4.0 29B                                                                            | Xingchen AGI |
| FLT  | Flint v1.0                                                                              | Recursive    |
| NIF  | Nifty 50 index (benchmark: ₹1,00,000 held in the index, no trading)                     | —            |
| MKY  | Monkey (benchmark: a random trader that follows the same rules and pays the same costs) | —            |

The models run on OpenRouter's free tier, so the arena costs nothing to run. The line-up lives in [`config/models.json`](config/models.json) and never changes during a season.

## What you'll see on the site

- **The race:** each model's portfolio value, rank, and profit (green ▲) or loss (red ▼) since it started with ₹1,00,000.
- **Every round:** what each model bought, sold, shorted or held, its strategy, and for every trade the signal it acted on and its exit plan, in its own words.
- **Every trade's reason:** the Trades tab on each model's page has a "Why" column next to every fill.
- **Every mistake:** actions the rules don't allow (not enough cash, too much in one stock, borrowing to trade) are rejected and shown, never quietly fixed.
- **Each model's portfolio:** its open positions (long or short), cash and profit or loss on each stock.
- **Proof:** a "Check this trade" button and a whole-day check that recompute the ledger's hashes in your browser.

Rounds run at **09:30, 11:00, 12:30 and 14:00 IST** on NSE trading days, and each one appears on the site 15 minutes after it finishes. It's **intraday**: from **15:00 IST** the engine closes every open position (by 15:15 at the latest), so every day starts in cash. Each order pays real intraday charges plus **₹20 brokerage**. A season is 20 trading days. **Season 1** runs from **2 November to 1 December 2026**. (Practice seasons before it: S0 ran one day under buy-and-hold rules; P1 ran four days, 27–30 October, until Gemma 4 31B, which was busy in most rounds, was replaced by Nemotron 3 Ultra.)

> All trading is simulated with paper money; no real orders are placed. Prices are real NSE prices from Angel One SmartAPI, shown with a 15-minute delay. Nothing here is investment advice, and neither this site nor the AI models are SEBI-registered advisers or research analysts. Don't copy these trades.

## For developers

- **Spec:** [SPEC.md](SPEC.md) is the source of truth.
- **Build state:** [PROGRESS.md](PROGRESS.md).
- **Setup steps for the owner:** [SETUP.md](SETUP.md).

## How it works

Every trading day, at each slot in `config/arena.json` (now 09:30, 11:00, 12:30 and 14:00 IST), a round runs:

1. **Decision snapshot.** The engine logs in to Angel One, fetches quotes and market depth for the 50 stocks, and validates each quote. Stale, out-of-band or missing quotes are flagged and left out of the prompt.
2. **Decisions.** Each model gets the same prompt: the rules, its own portfolio, the market table (prices, depth, daily indicators) and its own note from the previous round. It answers with its strategy, its analysis, and up to 5 actions (BUY or SELL a whole number of shares; a SELL beyond what it holds opens a short), each with the reason and an exit plan. Models never set prices, and exit plans are never acted on.
3. **Fill snapshot.** A second, fresh snapshot is taken. Every BUY fills at the best ask and every SELL at the best bid from this snapshot (last price ± 5 bps if depth is missing). The engine computes every charge itself from `config/fees.json`.
4. **Validation.** An action the rules don't allow (unknown symbol, more than 25% in one stock, longs plus shorts above 100% of the portfolio, not enough cash…) is rejected with a code, and the rejection is published. The engine never guesses what a model meant.
5. **Ledger.** Every fill is appended to an append-only, hash-chained ledger. Rows are never updated or deleted; corrections are new entries.
6. **Reveal.** The round appears on the site 15 minutes later.

At **15:00 IST** a square-off closes every open position at the live bid (longs) or ask (shorts) with normal charges. A stock without a live price is retried on the next tick; anything still open at the end of the day is closed at the day's last traded price.

Two benchmarks race alongside the models: the **Nifty 50** index (₹1,00,000 "invested" at the season's first fill, no costs) and the **Monkey**, a seeded random trader that follows the same rules and pays the same costs.

A season is 20 trading days. Everyone restarts at ₹1,00,000.

## Verify the ledger yourself

Every ledger entry carries the hash of the entry before it, so changing, removing or reordering any past trade breaks every hash after it. At the end of each trading day the engine commits that day's data to this repository:

```
public-data/YYYY/MM/DD/ledger.jsonl     one entry per line, in canonical JSON
public-data/YYYY/MM/DD/rounds.jsonl
public-data/YYYY/MM/DD/decisions.jsonl  each model's reasoning, actions and rejections
public-data/YYYY/MM/DD/marks.jsonl      portfolio values
public-data/anchors/YYYY-MM-DD.json     the day's first and last seq and its head hash
```

The git history of `public-data/anchors/` is the public record: once a day's anchor is committed, the database can't be quietly rewritten without the hashes disagreeing with the commit.

**How an entry is hashed.** Take the entry without its `hash` field and write it as canonical JSON: keys sorted at every level, no whitespace, integers (money in paise, quantities, sequence numbers) as decimal strings, timestamps as ISO 8601 UTC with milliseconds. The entry's `hash` is the SHA-256 (hex) of that text, and its `prev_hash` must equal the previous entry's `hash`. The first entry ever has a `prev_hash` of 64 zeros; the first entry of a day follows the previous day's anchor `head_hash`.

**Three ways to check:**

- **In your browser.** Open `/verify` on the site and press "Check a whole day", or press "Check this trade" on any trade page. The check runs in your browser with Web Crypto; it doesn't trust the server's answer.
- **With this repo.** `pnpm install`, then `pnpm verify-ledger --file public-data/2026/10/19/ledger.jsonl --prev-hash <previous day's head_hash>`.
- **With no code from us.** This Python script uses only the standard library:

  ```python
  import hashlib, json, sys
  prev = sys.argv[2] if len(sys.argv) > 2 else "0" * 64   # previous day's anchor head_hash
  n = 0
  for line in open(sys.argv[1], encoding="utf-8"):
      e = json.loads(line)
      h = e.pop("hash")
      body = json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
      if e["prev_hash"] != prev or hashlib.sha256(body.encode()).hexdigest() != h:
          sys.exit(f"seq {e['seq']}: chain broken")
      prev, n = h, n + 1
  print(f"{n} entries verify; last hash {prev}")
  ```

  Run `python3 verify.py ledger.jsonl <previous head_hash>` and compare the last hash with that day's anchor.

## Architecture

```
GitHub Actions  (tick.yml: every 10 min, 08:32–16:22 IST, Mon–Fri)
   │
   └── engine CLI (Node + TypeScript, packages/engine)
          ├── Angel One SmartAPI ── quotes, market depth, daily candles, instrument master
          ├── OpenRouter ─────────── every model, one API key (free models, or prepaid credits)
          ├── Telegram bot ───────── alerts (optional)
          └── Healthchecks.io ────── dead-man's switch (optional)
          │
          ▼
   Neon Postgres  (source of truth: ledger, decisions, snapshots, marks, incidents)
          │   read-only role web_ro, public views with the 15-minute delay built in
          ▼
   Next.js on Vercel  (apps/web: cached pages, refreshed by on-demand revalidation from the engine)
```

| Path                | What's there                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `config/`           | Everything tunable: rules and schedule (`arena.json`), charges (`fees.json`), roster (`models.json`), universe, holidays     |
| `packages/shared`   | Money in integer paise, canonical JSON, the ledger hash chain, formatters, config schemas. Runs in Node and the browser      |
| `packages/db`       | SQL migrations (tables, the append-only ledger trigger, roles, delayed public views), the Drizzle schema, the web read layer |
| `packages/engine`   | The CLI: market data, LLM layer, validation and execution, rounds, end-of-day jobs, admin commands                           |
| `apps/web`          | The public site                                                                                                              |
| `public-data/`      | The daily public export and anchors (committed by `tick.yml`)                                                                |
| `.github/workflows` | `ci`, `tick`, `smoke`, `migrate`, `admin`, `keepalive`                                                                       |

Design choices worth knowing:

- **Money is integer paise** everywhere (`bigint` / `BIGINT`), never floats.
- **The tick is idempotent.** It runs every 10 minutes and works out what's due (pre-market job, a round within its grace window, end of day). A late or duplicate run does no harm; a crashed round is recovered on the next tick.
- **The site never queries the database per visitor.** Pages are cached; after each reveal the engine calls `/api/revalidate` (secret, rate limited) to refresh them.
- **No silent swaps.** The serving model is checked on every response. A model that disappears is retired publicly, never replaced mid-season.
- **No broker orders.** The codebase has no order, modify or cancel calls, and a CI guard checks for them.

## Commands

```
pnpm install
pnpm check            # format + typecheck + lint + unit + property tests + guard checks
pnpm test:int         # integration tests (needs local Postgres or the CI service)
pnpm test:e2e         # Playwright + axe
pnpm run doctor       # configuration and live-service checks (`pnpm doctor` is a pnpm built-in)
pnpm engine snapshot --dry
pnpm engine roster --tier budget [--write]
pnpm engine decide --participant <slot|all> --dry
pnpm engine tick [--dry]
pnpm engine replay --round <id|random> [--count 3]
pnpm engine reconcile [--date YYYY-MM-DD]
pnpm engine import-universe --csv <file> --effective-from YYYY-MM-DD
pnpm engine import-holidays --year YYYY --file <json|csv>
pnpm verify-ledger [--file ledger.jsonl] [--prev-hash <hash>]
pnpm admin <pause|resume|retire|corp-action|clear-flag|resolve-incident|start-season|correct>
pnpm --filter web dev
```

Integration and e2e tests read `TEST_PG_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`) and only ever touch databases whose names end in `_test`.

## Runbooks

Admin commands run from **GitHub → Actions → admin → Run workflow** (works in the GitHub mobile app) or locally with `pnpm admin …` and `DATABASE_URL` set. Every admin command is written to the public admin log on `/status`.

### Rotate a leaked key

1. **Angel One:** in the SmartAPI dashboard, regenerate the API key; in the Angel One app, disable and re-enable TOTP for SmartAPI (save the new base32 secret) and change your MPIN.
2. **OpenRouter:** openrouter.ai → Keys → revoke the leaked key, create a new one with a credit limit.
3. **Database:** change the GitHub secret `ENGINE_RW_PASSWORD` or `WEB_RO_PASSWORD` (letters and digits, 24+ characters), run **migrate**, then update the connection string in `DATABASE_URL` or Vercel's `DATABASE_URL_READONLY`.
4. **Revalidation secret:** generate a new 32+ character random string; set it in both Vercel and GitHub.
5. Update the GitHub secrets (Settings → Environments → production) and Vercel env vars, redeploy Vercel if you changed a web variable, then run **smoke.yml → doctor**. All required rows must pass.

### Angel One login keeps failing

The `data:login` incident is open and rounds are missed with a reason. Check, in order: the TOTP secret still matches your authenticator (re-enable TOTP if you reset it); the MPIN hasn't changed; the API key's app is still active in the SmartAPI dashboard; Angel One's status. Run **smoke.yml → snapshot** to see the exact error. If logins work from your machine but not from GitHub runners, Angel One may be blocking runner IPs: see Plan B below. The incident resolves itself on the next successful login.

### Out of OpenRouter credit

Rounds are paused automatically with "the arena is out of API credit" and the site shows the amber banner. Buy credit at openrouter.ai → Credits, raise the key's limit if it was hit, then run **admin → resume** with a reason. Check the remaining balance with **smoke.yml → doctor**.

### A model was removed

When OpenRouter stops serving a configured model ID (404 or "model not found"), the engine opens an `llm:unavailable:<slot>` incident and records missed rounds. If it doesn't come back, run **admin → retire** with the slot and a reason: the engine sells its holdings at that round's prices, and it stays on the leaderboard as retired. Never replace a model mid-season; pick a new roster for the next season.

### Entering a corporate action

Find the announcement on NSE or BSE (record date, ex-date, ratio or amount). Before market open on the ex-date, run **admin → corp-action** with `symbol`, `type` (`split`, `bonus` or `dividend`), `ratio` (new-for-old, e.g. `2:1`) or `amount` (rupees per share), `ex_date` and `source` (the announcement URL). The pre-market job applies it on the ex-date; holdings and average cost adjust, dividends are credited for shares held at the previous close. Fractional entitlements are dropped.

### Updating the holiday list

NSE publishes next year's trading holidays in December. Open `https://www.nseindia.com/api/holiday-master?type=trading` in a browser (it needs a browser session), save the page as `holidays.json`, then run `pnpm engine import-holidays --year 2027 --file holidays.json` and commit `config/calendar/nse-2027.json`. The pre-market job raises a reminder in December. If NSE announces an extra holiday mid-year, re-import and commit the same way.

### Index rebalance

NSE rebalances the Nifty 50 at the end of March and September; the pre-market job raises a reminder in the last two weeks of those months. Download the new list from niftyindices.com (Indices → Equity → Broad Based → NIFTY 50 → "Index constituents" CSV), run `pnpm engine import-universe --csv ind_nifty50list.csv --effective-from <effective date>`, and commit `config/universe/nifty50.json` before that date. Models keep and can sell stocks that leave the index; they can only buy current constituents.

### Reconciliation mismatch

End of day rebuilds every portfolio from the ledger and compares it with stored positions and marks; a difference opens a critical `reconcile:mismatch` incident and pauses rounds. Run `pnpm engine reconcile --date <date>` locally (with `DATABASE_URL`) to see which participant and symbol differ, and `pnpm verify-ledger` to check the chain. The ledger is the source of truth. If a stored position is wrong, fix the cause first; if the ledger itself needs an adjustment, use **admin → correct** with the `ref_seq` being corrected, the cash change and a reason. It appends a `CORRECTION` entry; nothing is edited. Then **admin → resume**.

### Scheduled workflow disabled

GitHub disables scheduled workflows in public repositories after 60 days without activity. `keepalive.yml` re-enables `tick.yml` weekly, and Healthchecks alerts you if no tick has run. To fix by hand: Actions → tick → "Enable workflow". Missed rounds while it was off stay missed.

### Moving to Plan B

If Angel One rejects GitHub runners or the schedule misses slots repeatedly, run the same CLI on a small Linux VM with a static IP in an Indian region (for example Oracle Cloud Always Free in Mumbai or Hyderabad):

1. Install Node 24 and pnpm, clone the repo, `pnpm install --frozen-lockfile`.
2. Put the same environment variables as `tick.yml` in a root-only env file (`chmod 600`).
3. Add a systemd service running `pnpm engine tick` in the repo directory with that env file, and a timer with `OnCalendar=Mon..Fri *-*-* 03..10:02/10:00` (UTC).
4. On GitHub, `tick.yml`'s commit job pushes `public-data/` and records the commit with `pnpm engine anchor-commit`. On the VM, do the same after the end-of-day tick: an `ExecStartPost=` script that commits and pushes `public-data/` with a deploy key that can write to the data branch, then runs `pnpm engine anchor-commit --date <date> --sha <commit>`.
5. Keep the same `HEALTHCHECKS_PING_URL`. Remove the `schedule:` block from `tick.yml`.

Optionally, a free external cron (cron-job.org) can call `tick.yml` through `workflow_dispatch` with a fine-grained token limited to `actions: write`, for more punctual starts than GitHub's scheduler.

## Licences and credits

Market data from Angel One SmartAPI. Charts by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache 2.0). Archivo font under the SIL Open Font License (`apps/web/src/fonts/OFL-Archivo.txt`).
