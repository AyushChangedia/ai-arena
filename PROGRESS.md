# Progress

Current phase: 1 — Database and market data
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
- [ ] Phase 1 — Database and market data
- [ ] Phase 2 — Core engine logic
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

## Next

- Phase 1: Drizzle schema + SQL migrations, roles, views, Angel One provider, quote validation, calendar/universe loaders, snapshots, migrate.yml, smoke.yml.
