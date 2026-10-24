# Progress

Current phase: 3 — LLM layer
Last updated: 2026-10-24 22:45 IST

## Build mode

The owner set these overrides for the end-to-end build (2026-10-24). Every later session follows them until the owner removes this section. All other rules in CLAUDE.md and SPEC.md still apply.

1. Build Phases 0 to 6 back to back on one branch (`claude/wonderful-cray-vukeoi`). At the end of each phase, commit ("phase 2: core engine" etc.) and tick it off below. Open one PR at the end. Don't wait for the owner to merge anything.
2. Don't stop at human checkpoints. Write every step that needs the owner (accounts, API keys, GitHub and Vercel secrets, payments, dashboard settings, workflow runs, roster approval, design review) into SETUP.md as numbered click-by-click instructions in the order they should be done, then keep building.
3. Roster: fetch OpenRouter's public model list (GET /api/v1/models, no key needed), pick the budget tier per SPEC §3.2 with Muse Spark in the Meta slot, and write config/models.json with `"approved": false` and the cost estimate. The engine must refuse to start a live season until `"approved"` is true; shadow seasons may run. Put the table and the Llama 4 Maverick alternative in SETUP.md.
4. Universe and holidays: fetch the current Nifty 50 list from niftyindices.com and the NSE 2026 holiday list from nseindia.com. If they can't be reached, don't guess: leave the files out, make `pnpm doctor` report them missing, and add download steps to SETUP.md.
5. Live services: there are no secrets in the build environment. Build the Angel One and OpenRouter clients from their official docs. Where SPEC asks for recorded fixtures, use the docs' example responses, label them "docs-example", and list them below for replacement after the first smoke.yml run. Never mark anything that needs a live service as verified.
6. Acceptance checks that need real market days (Phase 4 shadow days, Phase 5 live revalidation) go into SETUP.md as "verify after setup" items instead of blocking the build.
7. Run every check possible in the build environment (pnpm check, integration tests against a local Postgres, the web build, Playwright). Fix failures before moving on; never weaken a test.
8. Keep PROGRESS.md current after every phase.

## Phases

- [x] Phase 0 — Foundations
- [x] Phase 1 — Database and market data (live acceptance checks → SETUP.md "verify after setup")
- [x] Phase 2 — Core engine logic
- [ ] Phase 3 — LLM layer
- [ ] Phase 4 — Rounds, scheduling and the shadow season
- [ ] Phase 5 — Web app
- [ ] Phase 6 — Hardening and launch

## Done (verified)

- [x] Phase 0 monorepo (pnpm workspaces: packages/shared, packages/db, packages/engine) — verified by `pnpm install` → done, lockfile written
- [x] Typecheck — verified by `pnpm typecheck` → no errors
- [x] Lint — verified by `pnpm lint` → no errors, 0 warnings
- [x] Unit tests incl. money round-trip property test, hash vectors, formatters, schemas — verified by `pnpm test:coverage` → 7 files, 52 tests passed; coverage shared+core: lines 100%, branches 95.23%
- [x] Guard checks with self-tests (no mock data, no test imports, no broker orders) — verified by `pnpm guards` → "41 files scanned, no violations", and `scripts/guards/test/guards.test.ts` → each planted violation fails, clean source passes
- [x] Redaction — verified by `packages/engine/test/logger.test.ts` → configured secret values and secret-named fields never reach log output
- [x] `pnpm run doctor` prints the full table and exits non-zero — verified by `pnpm run doctor; echo $?` → 27 rows, "required checks failing", exit=1

## In progress

- [ ] Phase 1 — not started

## Blocked on the human

See SETUP.md (numbered steps, in order). Nothing here blocks the build.

## Not verified / known gaps

- CI (`ci.yml`) has not run yet: it runs on the first push. Local equivalents pass.
- Node 24: the build environment has Node 22.22; CI pins Node 24 via `.nvmrc`/`NODE_VERSION`. `engines` allows >=22.12 so local runs work.
- `pnpm doctor` is a pnpm built-in command (pnpm 10), so it shadows our script. The script is `pnpm run doctor`. SPEC §7.3 and CLAUDE.md say `pnpm doctor`; flagged here as a SPEC difference.
- gitleaks runs only in CI (no binary in the build environment).
- Phase 1 live acceptance (Angel One login from a GitHub runner, 50/50 symbols mapped, ≥45 valid quotes with depth in market hours, closed-market path, 60+ daily bars per symbol) needs secrets and market hours: listed in SETUP.md as "verify after setup". Not verified.
- docs-example fixtures to replace after the first `smoke.yml → record-fixtures` run (all reconstructed from SmartAPI documentation because smartapi.angelone.in was unreachable from the build environment): `packages/engine/test/fixtures/angelone/login-success.docs-example.json`, `login-invalid-totp.docs-example.json`, `login-bad-mpin.docs-example.json`, `session-invalid-token.docs-example.json`, `quote-full.docs-example.json`, `candles-one-day.docs-example.json`, `scrip-master-rows.docs-example.json`. Error code AB1050 for an invalid TOTP is from memory of the docs; the code also matches any message containing "totp".
- Angel One request headers X-ClientLocalIP / X-ClientPublicIP / X-MACAddress are sent as fixed placeholder values (the official SDK also hardcodes them). Not verified against the live API.
- Instrument master URL (`config/arena.json` marketData.instrumentMasterUrl) is the long-standing angelbroking.com address; not reachable from the build environment, not verified.
- config/universe/nifty50.json and config/calendar/nse-2026.json are NOT committed: niftyindices.com and nseindia.com were unreachable from the build environment. `pnpm run doctor` reports both missing; SETUP.md has the download + import steps.
- Golden fee cases were computed by hand from the SPEC §11.5 rates, not checked against a broker's online calculator (broker sites unreachable from the build environment). SETUP.md has a verify-after-setup item. GST is applied to the unrounded sum of its base charges, then rounded once.
- Rejection-code choices where SPEC §11.3 is open to reading: a SELL of a symbol not held is UNKNOWN_SYMBOL with detail "Tried to sell 40 HDFCBANK, held 0"; CONFLICTING_SIDES considers SELLs that passed shape checks; a quantity above 2,147,483,647 is INVALID_QUANTITY ("too large").
- Corporate-action ratios are new-for-old (split 2:1 doubles shares; bonus 1:2 adds one share per two held). Fractional entitlements are dropped (to be disclosed on /rules).
- The parser adds a `missing_note_to_self` flag next to SPEC's `missing_reasoning`, and `note_truncated` when the note is cut to 500 characters.
- Engine-wide coverage (unit + integration, `COVERAGE_SCOPE=all`) is 85% lines / 78% branches after Phase 1; target 80%. The gap is CLI glue for live services; to be closed before the PR.
- Additions beyond SPEC §14/§15, flagged: `seasons.system_prompt` (the round page shows the shared system prompt), `arena_state.publish_market_table` (lets the v_market_tables view apply the arena.json policy), ledger entry type `CORRECTION` (SPEC §11.7/§18.1 ask for adjusting entries but §11.7's type list has none), extra public views `v_seasons`, `v_holdings`, `v_admin_log`, `v_symbol_flags` (needed by /, /models and /status), extra smoke.yml choice `roster` (public model list, no secret).
- Migrations use a small runner (`packages/db/src/migrate.ts`) over committed SQL files instead of drizzle-kit's migrator, because the triggers, roles and views are hand-written SQL. The Drizzle schema is kept in sync by a test.

## Next

- Phase 3: OpenRouter client (timeout/retry/classification), capability discovery, `engine roster`, structured outputs, repair attempt, model identity check, budget caps, cost capture, `engine decide`, smoke decide-all.
