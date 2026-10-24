# AI Arena

Five AI models each manage ₹1,00,000 of paper money, trading Nifty 50 stocks at real NSE prices, 12 rounds per trading day. The site shows the race, every trade, every rejected action and each model's reasoning, and anyone can verify the ledger.

All trading is simulated. No real orders are placed. Nothing here is investment advice.

- **Spec:** [SPEC.md](SPEC.md) is the source of truth.
- **Build state:** [PROGRESS.md](PROGRESS.md).
- **Setup steps for the owner:** [SETUP.md](SETUP.md).

## Commands

```
pnpm install
pnpm check            # typecheck + lint + unit + property tests + guard checks
pnpm test:int         # integration tests (needs local Postgres or the CI service)
pnpm test:e2e         # Playwright + axe
pnpm run doctor       # configuration and live-service checks (`pnpm doctor` is a pnpm built-in)
pnpm engine tick --dry
pnpm --filter web dev
```

More sections (how it works, verifying the ledger, runbooks, architecture) are added in Phase 6.
