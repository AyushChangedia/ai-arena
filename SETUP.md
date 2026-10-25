# Setup steps for the owner

Everything that needs you: accounts, keys, secrets, payments, dashboard settings, workflow runs and approvals. Do the steps in order; each one says what it unlocks. The build itself is finished, so nothing here blocks code work.

**Secrets never go into chat, code, commits or issues.** You paste them only into GitHub, Vercel or Neon screens. When a step says "paste back", it means a job summary or a table, which never contains secret values.

Where a step says "add a GitHub secret": your repository → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab → **New repository secret** → enter the name exactly as written → paste the value → **Add secret**.

Where it says "run a workflow": your repository → **Actions** → pick the workflow in the left list → **Run workflow** (top right of the run list) → choose the inputs → **Run workflow**. When it finishes, open the run and scroll to the **Summary**: that's the "job summary" to paste back.

---

## Status (2026-10-25)

| Step  | State                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–4   | Done: workflow permissions read-only, `production` environment, Neon project `ai-arena` (Singapore, 0.25 CU), `DATABASE_URL_OWNER`, migrate #1 applied 0001 and 0002 |
| 5     | **You:** role passwords, then the `DATABASE_URL` secret; keep the `web_ro` string for Vercel                                                                         |
| 6–7   | **You:** Angel One SmartAPI and OpenRouter (accounts, credit, keys, secrets)                                                                                         |
| 8–10  | Done: universe (effective 2026-09-30), 2026 holidays and the proposed roster are committed; the roster is not approved yet (step 27)                                 |
| 11    | Checked: rates match Zerodha's calculator; the DP charge differs (₹15.93 here, ₹15.34 at Zerodha). Pick one; details in PROGRESS.md                                  |
| 12–15 | After steps 5–7                                                                                                                                                      |
| 16    | **You:** make `REVALIDATE_SECRET` and add it to Vercel and GitHub                                                                                                    |
| 17    | Done except the two secret variables: add `DATABASE_URL_READONLY` and `REVALIDATE_SECRET` in Vercel, then redeploy. Site: https://ai-arena-psi-gules.vercel.app      |
| 18    | `WEB_BASE_URL` done; `REVALIDATE_SECRET` comes with step 16                                                                                                          |
| 19    | Any time: screenshots artifact from the latest **ci** run                                                                                                            |
| 20    | Optional, **you**                                                                                                                                                    |
| 21    | Done: `ARENA_MODE` = `shadow`                                                                                                                                        |
| 22    | **tick** and **keepalive** are disabled on purpose until steps 5–7 are done; enable both here                                                                        |
| 23+   | After step 22                                                                                                                                                        |

---

## Part A: Accounts and the database

### 1. GitHub repository

Done (this repo). One setting: **Settings** → **Actions** → **General** → **Workflow permissions** → choose **Read repository contents and packages permissions** → **Save**. (Workflows that need more ask for it themselves.)

### 2. GitHub environment

1. **Settings** → **Environments** → **New environment** → name it `production` → **Configure environment**.
2. Leave protection rules off for now (a required reviewer would block every scheduled tick).

The tick, smoke, admin and migrate workflows run in this environment. Repository secrets (above) are visible to it.

### 3. Neon project

1. Sign up at https://neon.tech (free plan).
2. **Create project** → name `ai-arena` → Postgres version 16 or newer → region: **AWS Asia Pacific (Singapore)** (the closest to India Neon offers; pick an Indian region instead if one is listed) → **Create**.
3. **Project settings** → **Compute** → set the compute size to a fixed **0.25 CU** (minimum and maximum both 0.25) → **Save**. Leave "scale to zero" on.
4. **Dashboard** → **Connect** → role: the default owner role (usually `neondb_owner`) → copy the connection string (it starts with `postgresql://` and ends with `?sslmode=require`).
5. Add it as the GitHub secret **`DATABASE_URL_OWNER`**.

### 4. Create the tables and roles

1. Run the workflow **migrate**. It applies every migration and creates two login roles with no password: `engine_rw` (the engine) and `web_ro` (the website, read-only views only).
2. Expect a green run that lists the applied migrations.

### 5. Give the two roles passwords

Neon's console can't reset the password of a role that was created without one, and its SQL editor sometimes can't wake a suspended compute, so the **migrate** workflow sets the passwords from two GitHub secrets.

1. Make two random passwords of **letters and digits only**, at least 24 characters (symbols would break the connection URL). On Windows, open PowerShell and run this twice:
   ```
   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
   ```
   On Mac or Linux: `openssl rand -hex 24`, twice.
2. Add two GitHub secrets: **`ENGINE_RW_PASSWORD`** (the first password) and **`WEB_RO_PASSWORD`** (the second).
3. Run the workflow **migrate** again. Its summary should say "Role passwords set for: engine_rw, web_ro". It never prints the passwords.
4. Build the two connection strings by taking the owner string from step 3 and replacing the user and password:
   `postgresql://engine_rw:<first password>@<same host>/<same database>?sslmode=require`
   `postgresql://web_ro:<second password>@<same host>/<same database>?sslmode=require`
5. Add the first as the GitHub secret **`DATABASE_URL`**.
6. Keep the second (`web_ro`) somewhere safe (a password manager); it goes into Vercel in step 17.

To change a password later (for example after a leak), update the secret and run **migrate** again.

### 6. Angel One SmartAPI (market data)

You need an Angel One trading account (KYC done). The project only reads market data; it never places orders.

1. Sign in at https://smartapi.angelone.in with your Angel One client ID.
2. **My Apps** (or **Create an App**) → app type: choose **Market Feeds / market data** if offered (not trading) → name `ai-arena` → redirect URL: `https://127.0.0.1` (not used) → create. Copy the **API key**.
3. Enable TOTP for SmartAPI: https://smartapi.angelone.in/enable-totp (if that page has moved, search the SmartAPI site for "Enable TOTP") → sign in with client ID and MPIN → an OTP comes to your phone/email → the page shows a QR code **and a text secret** (base32, capital letters and digits). Scan the QR into your authenticator app (so you can log in yourself) and copy the text secret.
4. Add four GitHub secrets:
   - **`ANGEL_API_KEY`**: the API key from step 2
   - **`ANGEL_CLIENT_CODE`**: your client ID (e.g. `A123456`)
   - **`ANGEL_MPIN`**: your 4-digit MPIN (the API login uses the MPIN, not your web password)
   - **`ANGEL_TOTP_SECRET`**: the base32 text secret from step 3

### 7. OpenRouter (the AI models)

The arena runs on **free models** (the owner's choice, 2026-10-25): no credit to buy. OpenRouter allows 50 free-model requests a day on an account that has never bought credit; the 4-round schedule uses about 16 a day with 4 models.

1. Sign up at https://openrouter.ai. Don't add credits.
2. **Settings** → **Privacy**: leave model fallbacks off; the engine also disables them per request and checks the serving model on every response. If free models are blocked by a privacy setting about providers that may train on prompts, allow it: the prompts contain only public market data and each model's own notes.
3. **Keys** → **Create key** → name `ai-arena-engine` → credit limit **0** (or leave it empty; with no credit on the account nothing can be billed) → create → copy the key (shown once).
4. Add it as the GitHub secret **`OPENROUTER_API_KEY`**.

To switch to paid models later, buy credit, set `schedule.everyMinutes` back to 30 and `schedule.lastSlot` to 15:00 in `config/arena.json`, and run the roster with tier **budget** (step 10).

---

## Part B: Config files the build environment couldn't fetch

niftyindices.com, nseindia.com and openrouter.ai were unreachable from the build environment, so these three files are not in the repo yet and `pnpm run doctor` reports them missing. The engine refuses to run rounds without them. You need the repo on your computer once:

```
git clone https://github.com/AyushChangedia/ai-arena.git
cd ai-arena
# Node 24 (https://nodejs.org) and pnpm: `corepack enable`
pnpm install
```

### 8. Nifty 50 universe

1. Open https://www.niftyindices.com/indices/equity/broad-based-indices/nifty--50 → **Index Constituent** → download the CSV (file name `ind_nifty50list.csv`). If the page moved: niftyindices.com → **Indices** → **Equity** → **Broad Based Indices** → **NIFTY 50** → constituents CSV.
2. Note the date the list became effective (shown on the page or in NSE's rebalance press release; the last rebalance before this list).
3. Run:
   ```
   pnpm engine import-universe --csv ~/Downloads/ind_nifty50list.csv --effective-from YYYY-MM-DD
   ```
   It checks there are exactly 50 EQ rows and writes `config/universe/nifty50.json`. A CI guard checks every ISIN's check digit, so a mangled file fails CI.
4. Commit and push the file (step 10 covers the commit).

### 9. NSE holiday list for 2026

1. In a normal browser, open https://www.nseindia.com first (it sets cookies), then open https://www.nseindia.com/api/holiday-master?type=trading. You'll see JSON.
2. Save the page as `holidays-2026.json` (**File** → **Save Page As** → format "JSON" or "Page source").
3. Run:
   ```
   pnpm engine import-holidays --year 2026 --file holidays-2026.json
   ```
   It takes the `CM` (capital market) list and writes `config/calendar/nse-2026.json`.
4. If NSE has already published the **2027** list (usually in December), repeat with `--year 2027`. A season of 20 trading days that starts in November or December runs into January, and the engine needs the next year's holidays before it gets there (the pre-market job reminds you from 1 December).

### 10. Roster: pick the models

**Free tier (current choice):** run the workflow **smoke** with check **roster** and tier **free**. It picks each lab's newest `:free` model (Anthropic has none, so Claude sits out) and shows the table with $0 and the calls per day. Download the **roster** artifact, and replace `config/models.json` with its `models.json` (or upload the artifact to a Claude session and ask it to commit it). The paid roster committed on 2026-10-25 stays in place until you do; with no credit on the account it can't be billed, but its calls would fail.

The steps below describe the paid tiers.

1. Run the workflow **smoke** with check **roster** and tier **budget**. It reads OpenRouter's public model list (no key used), picks each lab's newest budget model by the rules in `config/roster-rules.json`, and shows the table in the job summary: OpenRouter ID, short code, price per million tokens, context length, structured-output / reasoning / temperature support, monthly estimate and monthly cap per model, and the estimated monthly total.
2. The same run uploads an artifact **roster** containing `models.json`. Download it from the run page (**Artifacts** at the bottom) and unzip it.
3. **Meta choice.** The Meta slot defaults to **Muse Spark** (Meta's current model, closed). The table also shows **Llama 4 Maverick** as an alternative (older, cheap, a deliberate underdog). To use Maverick instead, open `models.json`, find the entry under `alternatives` with slot `meta`, and move it into `participants` in place of the Muse Spark entry.
4. Copy the file to `config/models.json` in your clone. Leave `"approved": false` for now: shadow seasons run with an unapproved roster; a **live** season refuses to start until it's approved (step 27).
5. Commit and push steps 8–10 together:
   ```
   git add config/universe/nifty50.json config/calendar/ config/models.json
   git commit -m "config: universe, holidays and roster"
   git push
   ```

For reference, a web search on 2026-10-24 suggested the budget tier would come out roughly as below. **None of this is verified**; the roster run is the source of truth, with exact IDs and prices.

| Slot               | Likely pick (unverified)                             |
| ------------------ | ---------------------------------------------------- |
| openai             | `openai/gpt-5.4-mini`                                |
| anthropic          | Claude Haiku 5.5 (exact OpenRouter ID unconfirmed)   |
| google             | `google/gemini-3.6-flash` (possibly a dated variant) |
| meta               | `meta/muse-spark-1.3`                                |
| meta (alternative) | `meta-llama/llama-4-maverick`                        |
| deepseek           | a DeepSeek V4 model (exact ID unconfirmed)           |

### 11. Check the charges against a broker calculator

The fee rates in `config/fees.json` come from SPEC §11.5; broker sites were unreachable from the build environment.

1. Open https://zerodha.com/brokerage-calculator → **Equity** → **Delivery** tab.
2. Enter buy price 1000, sell price 1000, quantity 100 (₹1,00,000 each side), exchange NSE.
3. Compare with the engine's golden cases (in `packages/engine/test/core/fees.test.ts`):
   - BUY ₹1,00,000: total charges **₹118.74**
   - SELL ₹1,00,000: **₹103.74** before the DP charge, **₹119.67** including DP ₹15.93 (Zerodha shows DP separately)
   - BUY 12 at ₹3,412.50: **₹48.62**
4. If they match (within a paisa per line), set `"verifiedOn": "YYYY-MM-DD"` and update `verificationNote` in `config/fees.json`, then commit. If they don't, don't edit the numbers yourself: open an issue or a session with the calculator's breakdown, so the rates and golden tests are changed together.

---

## Part C: Live checks

### 12. Doctor

Run **smoke** with check **doctor**. Paste the job summary back into a Claude session. Every required row should pass; the roster row shows a warning until step 27.

### 13. Market snapshot

Run **smoke** with check **snapshot** twice:

1. During market hours (09:15–15:30 IST on a trading day): expect a login, 50/50 symbols mapped, at least 45 valid quotes, most with depth.
2. Outside market hours: expect the "market closed" path.

Paste both summaries back. If the login fails from GitHub but works for you locally, Angel One may be blocking GitHub's runner IPs: see "Moving to Plan B" in README.md.

### 14. Model dry run

Run **smoke** with check **decide-all**. Each of the five models gets a real prompt and its answer is parsed and validated (no ledger writes). Costs a few cents. Paste the summary back: all five should be OK.

### 15. Record real fixtures

Run **smoke** with check **record-fixtures**. It records sanitised Angel One responses and uploads them as the artifact **fixtures** (kept for 1 day, because artifacts on public repos are visible to other GitHub users). Within that day, download it and give it to a Claude session with: "Replace the docs-example fixtures listed in PROGRESS.md with these recordings and rerun the tests." Then delete your local copy.

---

## Part D: The website

### 16. Revalidation secret

On your computer run `openssl rand -hex 32`. This is `REVALIDATE_SECRET`; it goes into both Vercel (step 17) and GitHub (step 18).

### 17. Vercel

1. Sign up at https://vercel.com with your GitHub account (Hobby plan is fine).
2. **Add New…** → **Project** → import `ai-arena`.
3. **Root Directory** → **Edit** → `apps/web` → keep "Include files outside the root directory" **on**. Framework preset: **Next.js**. Leave build and install commands as detected (pnpm).
4. **Environment Variables** (Production and Preview):
   - `DATABASE_URL_READONLY`: the `web_ro` connection string from step 5
   - `REVALIDATE_SECRET`: from step 16
   - `ARENA_MODE`: `shadow`
   - `NEXT_PUBLIC_SITE_URL`: leave out for now; add it after the first deploy (step 6 below)
5. **Deploy**.
6. Copy the production URL (e.g. `https://ai-arena.vercel.app`). Add it as the env var `NEXT_PUBLIC_SITE_URL` (Settings → Environment Variables) and redeploy (Deployments → ⋯ → **Redeploy**).
7. **Settings** → **Functions** → **Function Region**: pick the region nearest your Neon database (Singapore, `sin1`, if Neon is in Singapore) → **Save**.
8. **Settings** → **General** → **Node.js Version**: **24.x**.
9. **Settings** → **Git** → **Ignored Build Step** → **Custom** → command:
   ```
   git diff --quiet HEAD^ HEAD -- ':(top)' ':(top,exclude)public-data'
   ```
   This skips a deploy when a commit only touches `public-data/` (the end-of-day export).

### 18. Connect the engine to the site

Add two GitHub secrets:

- **`WEB_BASE_URL`**: the production URL from step 17.6 (no trailing slash)
- **`REVALIDATE_SECRET`**: the same value as in Vercel

### 19. Design review

1. Open the latest **ci** run on the PR or `main` → **Artifacts** → download **screenshots**. It has every page at 375, 768 and 1280 px, populated with test data from the e2e database (the site itself never shows test data).
2. Approve the design, or list changes for a Claude session.

---

## Part E: Shadow season S0

### 20. Optional: alerts

**Telegram** (alerts to your phone):

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy the bot token.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser and copy `"chat":{"id": …}`.
3. Add GitHub secrets **`TELEGRAM_BOT_TOKEN`** and **`TELEGRAM_CHAT_ID`**.

**Healthchecks.io** (alerts you if ticks stop running; strongly recommended):

1. Sign up at https://healthchecks.io → **Add Check**.
2. Schedule: **Cron** → `*/10 9-15 * * 1-5` → time zone **Asia/Kolkata** → grace time **25 minutes** → **Save**.
3. Add its email or Telegram integration under **Integrations**.
4. Copy the ping URL and add it as the GitHub secret **`HEALTHCHECKS_PING_URL`**.

### 21. Mode variable

**Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable** → name **`ARENA_MODE`**, value **`shadow`**.

Optional: variable **`DATA_BRANCH`** if you want the end-of-day export committed to a branch other than `main` (the branch must exist).

### 22. Enable the schedule

**Actions** → **tick** → if you see "This scheduled workflow is disabled", click **Enable workflow**. Do the same for **keepalive**. Then run **tick** once by hand with **dry** ticked: expect a green run whose summary says what would run now.

### 23. Start the shadow season

Run the workflow **admin** with:

- command: `start-season`
- id: `S0`
- start: the next trading day, `YYYY-MM-DD`
- mode: `shadow`
- reason: `Shadow season before launch`

The site shows the pre-season countdown with the "private preview" banner and `noindex`.

### 24. Watch the first day

On the first trading day, open a few **tick** runs (each run's summary lists the round, every participant's status, latency, cost and incidents). After 16:00 IST check the end-of-day run: reconciliation **ok**, and a `public-data/…` commit on the data branch. If Telegram is set up you get the daily digest.

---

## Part F: Verify after setup

These acceptance checks need real market days or live services, so they couldn't run during the build. Paste results back to a Claude session to record them in PROGRESS.md.

1. **Phase 1, market data:** steps 12–13 pass (login from a GitHub runner, 50/50 mapped, ≥ 45 valid quotes with depth in market hours, closed-market path detected). After the first pre-market job, the doctor or the status page shows 60+ daily bars for every symbol.
2. **Phase 3, models:** step 14 shows all five models OK; the doctor confirms every model ID exists and supports the parameters we send.
3. **Phase 4, three shadow days:** at least 3 consecutive trading days where every slot is completed, or skipped/missed with a reason, and zero reconciliation mismatches.
4. **Phase 4, replay:** with `DATABASE_URL` set locally (or in a one-off workflow run), `pnpm engine replay --round random --count 3` → all three hashes match.
5. **Phase 5, real data:** every page renders S0 data; on `/verify`, "Check a whole day" passes for a real shadow day.
6. **Phase 5, reveal timing:** note a round's reveal time (finish + 15 min) and confirm it appears on the site within one tick (10 minutes) after that.
7. **Phase 5, Lighthouse:** run PageSpeed Insights (https://pagespeed.web.dev) on the production URL, mobile: all four categories ≥ 90.
8. **Fixtures:** step 15 done and the replaced fixtures pass CI.

---

## Part G: Launch

### 25. Ask Angel One about public display

Email Angel One's SmartAPI team at the support address listed on https://smartapi.angelone.in (look for Support or Contact; the SmartAPI forum also names it), from the email on your Angel One account. Suggested text:

> Subject: Public display of derived data from SmartAPI (client <your client ID>)
>
> Hello, I use SmartAPI market data for a non-commercial public experiment, AI Arena (<your site URL>), in which AI models paper-trade Nifty 50 stocks. No orders are placed through the API. The site never shows a live quote board: it shows simulated fill prices, holdings values and portfolio values with a 15-minute delay, credits Angel One SmartAPI as the source, and publishes the full per-round market table only after the day's close. Could you confirm this use is acceptable, or tell me what I should change? Thank you.

Until they answer, the "after close" policy (`publishFullMarketTable: "after_close"` in `config/arena.json`) stays on; set it to `"never"` if they ask.

### 26. Launch checklist (SPEC §22)

- [ ] Every acceptance check from Phases 0–5 recorded in PROGRESS.md (Part F above).
- [ ] Shadow season ran ≥ 3 trading days with zero reconciliation mismatches.
- [ ] **smoke → doctor** passes.
- [ ] OpenRouter balance covers at least two months at the estimated burn (from step 10's table); per-model caps set in `config/models.json` (`monthlyCapUsd`).
- [ ] Healthchecks configured and tested: disable **tick** for 30 minutes during market hours and confirm the alert arrives, then re-enable it.
- [ ] Holiday list covers the whole season; universe file matches the current official list.
- [ ] Angel One display confirmation received, or the "after close" policy confirmed as acceptable.
- [ ] Disclaimers visible in the footer and on /rules.
- [ ] Shadow data excluded from live views; `noindex` removed only for live.
- [ ] README explains how anyone can verify the ledger.

### 27. Approve the roster

Re-run **smoke → roster** if a few weeks have passed (models and prices change). If the picks still stand, edit `config/models.json`: `"approved": true`, `"approvedBy": "<your name>"`, `"approvedOn": "YYYY-MM-DD"`. Commit and push. The roster can't change during a season.

### 28. Go live

1. Pick the Monday (or next trading day) to start.
2. Run **admin** with command `start-season`, id `S1`, start `YYYY-MM-DD`, mode `live`, reason `Season 1`. It refuses if the roster isn't approved.
3. Change the GitHub variable **`ARENA_MODE`** to **`live`**.
4. In Vercel, change `ARENA_MODE` to `live` and redeploy. The preview banner and `noindex` go away; shadow rounds no longer appear.
5. On the first live day, watch the first two ticks' summaries.
