# CLAUDE.md: AI Arena

AI Arena is a public paper-trading arena: five AI models each manage ₹1,00,000 of paper money, trading Nifty 50 stocks at real NSE prices, 12 rounds per trading day. The site shows the race, every trade, every rejected action and each model's reasoning, and anyone can verify the ledger.

**SPEC.md is the source of truth.** This file is a summary. If they ever differ, SPEC.md wins; flag the difference in PROGRESS.md.

## Every session

1. Read SPEC.md §0–§3, the sections for the current phase, and PROGRESS.md before writing any code. If PROGRESS.md doesn't exist, you're in Phase 0: create it in the format from SPEC §0.
2. Work only on the current phase (SPEC §21). One phase = one branch = one PR.
3. Before you stop: run the phase's acceptance checks, then update PROGRESS.md with what's done (the command you ran and its result), what's in progress, what's blocked on the human (exact steps), what isn't verified, and what's next.

## Non-negotiables

- **No fake data.** No mock, sample, placeholder or demo numbers outside `test/` directories. If real data isn't available, the UI shows an empty or error state, never zeros or guesses.
- **Money is integer paise** (`bigint` / `BIGINT`). No floats for money.
- **Models never set prices.** The engine fills only at recorded snapshot prices and computes every charge itself.
- **Never fix a model's mistake by guessing.** Invalid actions are rejected with a code from SPEC §11.3, and the rejection is published.
- **Never swap a model or a data source silently.** No OpenRouter model fallbacks; check the serving model on every response.
- **The ledger is append-only and hash-chained.** Never update or delete ledger rows; corrections are new entries.
- **No real orders.** The codebase never calls a broker order, modify or cancel endpoint.
- **No secrets** in code, logs, commits, PR text, fixtures, artifacts or the database. Never ask the human to paste a secret into chat.
- **Don't claim it works unless you ran it.** Paste the command and its output. Otherwise write "not verified" and why.
- **No silent stubs.** Unimplemented code throws `NotImplementedError` and is listed in PROGRESS.md.
- **Never weaken or delete a failing test to get green.**
- **No empty catch blocks.** Every error is classified, logged (redacted) and surfaced as SPEC §13 describes.
- **Config, not constants:** model IDs, fee rates, holidays, the universe and the schedule live in `config/`.
- **Nothing outside the spec** without asking first.

## You don't have production secrets

Live checks (Angel One, OpenRouter, production Neon, Telegram, Healthchecks) run in the `smoke.yml` GitHub Actions workflow. Ask the human to run it and paste the job summary. Build test fixtures only from real recorded responses (sanitised), never from invented shapes.

## Stop and ask the human when

- a step needs an account, a key, a payment, a dashboard setting or an approval (give numbered click-by-click steps and say what to paste back);
- the spec is ambiguous or contradicts itself;
- you want to add or change anything the spec doesn't cover.

## Commands

```
pnpm install
pnpm check            # format + typecheck + lint + unit + property tests + guard checks
pnpm test:int         # integration tests (needs local Postgres or the CI service)
pnpm test:e2e         # Playwright + axe
pnpm doctor           # configuration and live-service checks
pnpm engine tick --dry
pnpm --filter web dev
```

Keep this list in sync with the scripts as they're created.
