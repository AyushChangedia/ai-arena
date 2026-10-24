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
    product: z.literal('long_only_delivery'),
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
      })
      .strict(),
    llm: z
      .object({
        temperature: z.number().min(0).max(2),
        reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']),
        maxTokens: z.number().int().min(256),
        timeoutSeconds: z.number().int().min(5),
        retryDelaysSeconds: z.array(z.number().min(0)),
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
        noteToSelfMaxChars: z.number().int().min(1),
      })
      .strict(),
    simplifications: z.array(z.string().min(1)),
  })
  .strict();
export type ArenaConfig = z.infer<typeof arenaConfigSchema>;

const chargeSchema = z
  .object({ rate: fraction, appliesTo: z.enum(['buy', 'sell', 'both']), label: z.string() })
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
    dpCharge: z
      .object({ paisePerSymbolPerDay: intString, label: z.string(), note: z.string() })
      .strict(),
    sources: z.array(z.object({ label: z.string(), url: z.string().url() }).strict()).min(1),
  })
  .strict();
export type FeesConfig = z.infer<typeof feesConfigSchema>;
export type ChargeName = keyof FeesConfig['charges'];

export const SLOTS = ['openai', 'anthropic', 'google', 'meta', 'deepseek'] as const;
export type ModelSlot = (typeof SLOTS)[number];

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const usdPerToken = z.string().regex(/^\d+(\.\d+)?(e-?\d+)?$/i, 'expected a decimal string');

export const modelEntrySchema = z
  .object({
    slot: z.enum(SLOTS),
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
    tier: z.enum(['budget', 'flagship']),
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
    participants: z.array(modelEntrySchema).length(5),
    alternatives: z.array(modelEntrySchema),
    benchmarks: z.object({ index: benchmarkEntrySchema, monkey: benchmarkEntrySchema }).strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const slots = new Set(cfg.participants.map((p) => p.slot));
    if (slots.size !== 5)
      ctx.addIssue({
        code: 'custom',
        message: 'each of the five slots must appear exactly once',
        path: ['participants'],
      });
    const codes = new Set([
      ...cfg.participants.map((p) => p.shortCode),
      cfg.benchmarks.index.shortCode,
      cfg.benchmarks.monkey.shortCode,
    ]);
    if (codes.size !== 7)
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
    slots: z.record(
      z.enum(SLOTS),
      z
        .object({
          shortCode: z.string().regex(/^[A-Z]{3}$/),
          color: hexColor,
          tiers: z
            .object({
              budget: z.array(z.string()).min(1),
              flagship: z.array(z.string()).min(1),
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
  .strict();
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
