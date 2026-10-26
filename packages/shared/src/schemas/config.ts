import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm (24-hour)');
const intString = z.string().regex(/^\d+$/, 'expected a whole number as a string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const fraction = z.object({ num: z.number().int().min(0), den: z.number().int().min(1) }).strict();

export const arenaConfigSchema = z
  .object({
    $comment: z.string().optional(),
    timezone: z.literal('Asia/Kolkata'),
    startingCashPaise: intString,
    /** long_only_delivery: buy and hold. intraday_long_short (the owner's choice, 2026-10-26): long and short, every position closed by the square-off deadline. */
    product: z.enum(['long_only_delivery', 'intraday_long_short']),
    /** Required for the intraday product: when the engine closes every open position. */
    intraday: z
      .object({
        /** The square-off starts at the first tick at or after this time. */
        squareOffFrom: hhmm,
        /** Every position should be closed by this time; a later close raises an incident. */
        squareOffDeadline: hhmm,
      })
      .strict()
      .optional(),
    schedule: z
      .object({
        firstSlot: hhmm,
        lastSlot: hhmm,
        everyMinutes: z.number().int().min(5),
        graceMinutes: z.number().int().min(1),
        preMarketWindow: z.object({ from: hhmm, to: hhmm }).strict(),
        endOfDayAfter: hhmm,
        valuationAt: hhmm,
        staleRunningMinutes: z.number().int().min(1),
        decisionDeadlineSeconds: z.number().int().min(10),
      })
      .strict(),
    limits: z
      .object({
        maxActionsPerRound: z.number().int().min(1),
        maxWeightPct: z.number().int().min(1).max(100),
        slippageBps: z.number().int().min(0),
        maxInvalidQuotesPerSnapshot: z.number().int().min(0),
        maxQuoteAgeMinutes: z.number().int().min(1),
        maxDailyMovePct: z.number().int().min(1),
        gapGuardPct: z.number().int().min(1),
        /** Longs plus shorts at market value may not exceed this share of total value. 100 = no leverage. */
        maxGrossExposurePct: z.number().int().min(1).max(100).default(100),
      })
      .strict(),
    season: z
      .object({
        tradingDays: z.number().int().min(1),
        publicDelayMinutes: z.number().int().min(0),
      })
      .strict(),
    publishFullMarketTable: z.enum(['after_close', 'never']),
    marketData: z
      .object({
        provider: z.literal('angelone'),
        quoteBatchSize: z.number().int().min(1).max(50),
        quoteRequestsPerSecond: z.number().positive(),
        candleRequestsPerSecond: z.number().positive(),
        historyTradingDays: z.number().int().min(50),
        indexName: z.string().min(1),
        vixName: z.string().min(1),
        instrumentMasterUrl: z.string().url(),
        apiRoot: z.string().url(),
        requestTimeoutSeconds: z.number().int().min(1),
      })
      .strict(),
    llm: z
      .object({
        temperature: z.number().min(0).max(2),
        reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']),
        maxTokens: z.number().int().min(256),
        timeoutSeconds: z.number().int().min(5),
        retryDelaysSeconds: z.array(z.number().min(0)),
        /** Waits before retrying an HTTP 429 (provider busy). Longer than retryDelaysSeconds; default: the same list. */
        rateLimitRetryDelaysSeconds: z.array(z.number().min(0)).optional(),
        /** Longest wait taken from a Retry-After header. */
        maxRetryAfterSeconds: z.number().min(0).default(90),
        /** Reasoning effort for the one repair call after a reply that ran out of tokens while thinking. */
        repairReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
        creditWarnUsd: z.number().min(0),
        creditCriticalUsd: z.number().min(0),
        budgetCapMultiplier: z.number().min(1),
        estimate: z
          .object({
            inputTokensPerCall: z.number().int().min(1),
            outputTokensPerCall: z.number().int().min(1),
            roundsPerMonth: z.number().int().min(1),
          })
          .strict(),
      })
      .strict(),
    display: z
      .object({
        reasoningDisplayChars: z.number().int().min(1),
        whyDisplayChars: z.number().int().min(1),
        /** The model's stated strategy, shown on its panel and the Thinking tab. */
        strategyDisplayChars: z.number().int().min(1).default(600),
        /** The exit plan for each action. */
        exitPlanDisplayChars: z.number().int().min(1).default(200),
        noteToSelfMaxChars: z.number().int().min(1),
      })
      .strict(),
    simplifications: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((a, ctx) => {
    const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    if (a.product === 'intraday_long_short' && !a.intraday) {
      ctx.addIssue({
        code: 'custom',
        path: ['intraday'],
        message: 'the intraday product needs an intraday block (squareOffFrom, squareOffDeadline)',
      });
      return;
    }
    if (a.product === 'long_only_delivery' && a.intraday) {
      ctx.addIssue({
        code: 'custom',
        path: ['intraday'],
        message: 'an intraday block only applies to the intraday product',
      });
      return;
    }
    if (!a.intraday) return;
    const from = min(a.intraday.squareOffFrom);
    const deadline = min(a.intraday.squareOffDeadline);
    if (deadline <= from)
      ctx.addIssue({
        code: 'custom',
        path: ['intraday', 'squareOffDeadline'],
        message: 'the square-off deadline must be after squareOffFrom',
      });
    if (min(a.schedule.lastSlot) + a.schedule.graceMinutes > from)
      ctx.addIssue({
        code: 'custom',
        path: ['intraday', 'squareOffFrom'],
        message: 'the last round (plus its grace window) must end before the square-off starts',
      });
    if (deadline > min(a.schedule.endOfDayAfter))
      ctx.addIssue({
        code: 'custom',
        path: ['intraday', 'squareOffDeadline'],
        message: 'the square-off deadline must be before end of day',
      });
  });
export type ArenaConfig = z.infer<typeof arenaConfigSchema>;

const chargeSchema = z
  .object({
    rate: fraction,
    /** A flat amount per executed order, added to the rate (brokerage: ₹20 an order, the owner's choice). */
    flatPaisePerOrder: intString.optional(),
    appliesTo: z.enum(['buy', 'sell', 'both']),
    label: z.string(),
  })
  .strict();

export const feesConfigSchema = z
  .object({
    $comment: z.string().optional(),
    profile: z.string(),
    verifiedOn: isoDate.nullable(),
    verificationNote: z.string().optional(),
    charges: z
      .object({
        brokerage: chargeSchema,
        stt: chargeSchema,
        exchange: chargeSchema,
        sebi: chargeSchema,
        ipft: chargeSchema,
        stamp: chargeSchema,
      })
      .strict(),
    gst: z
      .object({
        rate: fraction,
        on: z.array(z.enum(['brokerage', 'exchange', 'sebi', 'ipft'])),
        label: z.string(),
      })
      .strict(),
    /** Delivery only; null for intraday (no shares leave the demat account). */
    dpCharge: z
      .object({ paisePerSymbolPerDay: intString, label: z.string(), note: z.string() })
      .strict()
      .nullable(),
    sources: z.array(z.object({ label: z.string(), url: z.string().url() }).strict()).min(1),
  })
  .strict();
export type FeesConfig = z.infer<typeof feesConfigSchema>;
export type ChargeName = keyof FeesConfig['charges'];

/** The five labs a paid-tier season fields, in display order (SPEC §3.1). */
export const SLOTS = ['openai', 'anthropic', 'google', 'meta', 'deepseek'] as const;
/** A participant slot: one lab. Paid tiers use SLOTS; the free tier can field any lab in roster-rules.json. */
export type ModelSlot = string;
/** Slugs the benchmarks use on the site, so no lab may take them. */
export const BENCHMARK_SLUGS = ['monkey', 'nifty50'] as const;
export const slotId = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,23}$/, 'a slot is 2–24 lowercase letters and digits')
  .refine((s) => !(BENCHMARK_SLUGS as readonly string[]).includes(s), 'reserved for a benchmark');

/** Roster tiers (SPEC §3.2). `free` uses only OpenRouter `:free` models and fields the labs that offer one. */
export const TIERS = ['budget', 'flagship', 'free'] as const;
export type Tier = (typeof TIERS)[number];
/** A free-tier season still needs a real field of models, and the site is laid out for a handful. */
export const MIN_FREE_PARTICIPANTS = 3;
export const MAX_PARTICIPANTS = 6;

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const usdPerToken = z.string().regex(/^\d+(\.\d+)?(e-?\d+)?$/i, 'expected a decimal string');

export const modelEntrySchema = z
  .object({
    slot: slotId,
    openrouterId: z.string().min(3),
    canonicalSlug: z.string().nullable(),
    displayName: z.string().min(1),
    shortCode: z.string().regex(/^[A-Z]{3}$/),
    color: hexColor,
    created: z.number().int().nullable(),
    contextLength: z.number().int().positive().nullable(),
    supportedParameters: z.array(z.string()),
    pricing: z
      .object({ promptUsdPerToken: usdPerToken, completionUsdPerToken: usdPerToken })
      .strict(),
    monthlyEstimateUsd: z.number().min(0),
    monthlyCapUsd: z.number().min(0),
  })
  .strict();
export type ModelEntry = z.infer<typeof modelEntrySchema>;

export const benchmarkEntrySchema = z
  .object({ displayName: z.string(), shortCode: z.string().regex(/^[A-Z]{3}$/), color: hexColor })
  .strict();

export const modelsConfigSchema = z
  .object({
    $comment: z.string().optional(),
    tier: z.enum(TIERS),
    approved: z.boolean(),
    approvedBy: z.string().nullable(),
    approvedOn: isoDate.nullable(),
    generatedAt: z.string(),
    source: z.string().url(),
    estimateAssumptions: z
      .object({
        inputTokensPerCall: z.number().int(),
        outputTokensPerCall: z.number().int(),
        roundsPerMonth: z.number().int(),
      })
      .strict(),
    totalMonthlyEstimateUsd: z.number().min(0),
    participants: z.array(modelEntrySchema).min(MIN_FREE_PARTICIPANTS).max(MAX_PARTICIPANTS),
    alternatives: z.array(modelEntrySchema),
    benchmarks: z.object({ index: benchmarkEntrySchema, monkey: benchmarkEntrySchema }).strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const slots = new Set(cfg.participants.map((p) => p.slot));
    if (slots.size !== cfg.participants.length)
      ctx.addIssue({
        code: 'custom',
        message: 'each slot may appear only once',
        path: ['participants'],
      });
    // Paid tiers field the five labs. The free tier fields the labs that offer a free model.
    if (cfg.tier !== 'free' && (slots.size !== SLOTS.length || !SLOTS.every((x) => slots.has(x))))
      ctx.addIssue({
        code: 'custom',
        message: `the ${cfg.tier} tier needs each of ${SLOTS.join(', ')} exactly once`,
        path: ['participants'],
      });
    if (cfg.tier === 'free') {
      const paid = cfg.participants.filter(
        (p) =>
          Number(p.pricing.promptUsdPerToken) !== 0 ||
          Number(p.pricing.completionUsdPerToken) !== 0,
      );
      if (paid.length)
        ctx.addIssue({
          code: 'custom',
          message: `the free tier may only hold free models; priced: ${paid.map((p) => p.openrouterId).join(', ')}`,
          path: ['participants'],
        });
    }
    const codes = new Set([
      ...cfg.participants.map((p) => p.shortCode),
      cfg.benchmarks.index.shortCode,
      cfg.benchmarks.monkey.shortCode,
    ]);
    if (codes.size !== cfg.participants.length + 2)
      ctx.addIssue({
        code: 'custom',
        message: 'short codes must be unique',
        path: ['participants'],
      });
  });
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export const rosterRulesSchema = z
  .object({
    $comment: z.string().optional(),
    // Object key order is the display order.
    slots: z.record(
      slotId,
      z
        .object({
          /** The lab's name as people know it. */
          lab: z.string().min(1).optional(),
          shortCode: z.string().regex(/^[A-Z]{3}$/),
          /** Short code for the free-tier pick, when it is a different model line (e.g. Llama for Meta). */
          freeShortCode: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
          color: hexColor,
          tiers: z
            .object({
              // Empty for a lab that only takes part in free-tier seasons.
              budget: z.array(z.string()).default([]),
              flagship: z.array(z.string()).default([]),
              // Empty when the lab offers no free model: the slot sits out a free-tier season.
              free: z.array(z.string()).default([]),
            })
            .strict(),
          alternatives: z
            .array(
              z
                .object({
                  label: z.string(),
                  pattern: z.string(),
                  shortCode: z.string().regex(/^[A-Z]{3}$/),
                })
                .strict(),
            )
            .default([]),
        })
        .strict(),
    ),
    exclude: z.array(z.string()),
    benchmarks: z.object({ index: benchmarkEntrySchema, monkey: benchmarkEntrySchema }).strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const slot of SLOTS) {
      const t = r.slots[slot]?.tiers;
      if (!t || !t.budget.length || !t.flagship.length)
        ctx.addIssue({
          code: 'custom',
          message: `${slot} needs budget and flagship patterns (the paid tiers field all five labs)`,
          path: ['slots', slot],
        });
    }
  });
export type RosterRules = z.infer<typeof rosterRulesSchema>;

export const universeSchema = z
  .object({
    index: z.literal('NIFTY 50'),
    effectiveFrom: isoDate,
    sourceUrl: z.string().url(),
    downloadedOn: isoDate,
    constituents: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^[A-Z0-9&-]+$/),
            name: z.string().min(1),
            industry: z.string().optional(),
            isin: z
              .string()
              .regex(/^IN[A-Z0-9]{10}$/)
              .optional(),
          })
          .strict(),
      )
      .length(50),
  })
  .strict()
  .superRefine((u, ctx) => {
    const s = new Set(u.constituents.map((c) => c.symbol));
    if (s.size !== u.constituents.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate symbols', path: ['constituents'] });
  });
export type Universe = z.infer<typeof universeSchema>;

export const calendarSchema = z
  .object({
    year: z.number().int().min(2025),
    exchange: z.literal('NSE'),
    segment: z.literal('equity'),
    source: z.string().min(1),
    sourceUrl: z.string().url(),
    downloadedOn: isoDate,
    holidays: z.array(z.object({ date: isoDate, description: z.string().min(1) }).strict()),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [i, h] of c.holidays.entries()) {
      if (!h.date.startsWith(`${c.year}-`))
        ctx.addIssue({
          code: 'custom',
          message: `holiday ${h.date} is not in ${c.year}`,
          path: ['holidays', i, 'date'],
        });
    }
  });
export type MarketCalendar = z.infer<typeof calendarSchema>;
