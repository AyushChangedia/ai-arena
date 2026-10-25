/**
 * Proposes the roster from OpenRouter's public model list (SPEC §3.2, §9.7). Never changes a running season.
 */
import type {
  ArenaConfig,
  ModelEntry,
  ModelsConfig,
  RosterRules,
  ModelSlot,
  Tier,
} from '@arena/shared/schemas';
import { SLOTS, MIN_FREE_PARTICIPANTS } from '@arena/shared/schemas';
import type { OrModel } from './openrouter';
import { slotTimes } from '../round/schedule';

export type { Tier };

/** OpenRouter's daily cap on `:free` requests for an account that has never bought credit. */
export const FREE_REQUESTS_PER_DAY = 50;

const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3,4})$/;

/** Monthly estimate in USD: rounds × (input tokens × input price + output tokens × output price). */
export function monthlyEstimateUsd(
  m: Pick<OrModel, 'pricing'>,
  est: ArenaConfig['llm']['estimate'],
): number {
  const perCall =
    est.inputTokensPerCall * Number(m.pricing.prompt) +
    est.outputTokensPerCall * Number(m.pricing.completion);
  return Math.round(est.roundsPerMonth * perCall * 100) / 100;
}

function excluded(id: string, rules: RosterRules): boolean {
  return rules.exclude.some((p) => new RegExp(p, 'i').test(id));
}

export interface SlotPick {
  slot: ModelSlot;
  chosen: OrModel | null;
  otherMatches: string[];
}

/** Newest matching model (by `created`), then its dated variant if one exists. */
export function pickForPatterns(
  models: OrModel[],
  patterns: string[],
  rules: RosterRules,
): { chosen: OrModel | null; others: string[] } {
  const res = patterns.map((p) => new RegExp(p));
  const matches = models
    .filter((m) => res.some((r) => r.test(m.id)) && !excluded(m.id, rules))
    .filter((m) => Number(m.pricing.prompt) >= 0 && Number(m.pricing.completion) >= 0)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  const top = matches[0] ?? null;
  if (!top) return { chosen: null, others: [] };
  const base = top.id.replace(DATED, '');
  const dated = matches.find(
    (m) => m.id !== base && m.id.startsWith(`${base}-`) && DATED.test(m.id),
  );
  const chosen = DATED.test(top.id) ? top : (dated ?? top);
  return {
    chosen,
    others: matches
      .filter((m) => m.id !== chosen.id)
      .map((m) => m.id)
      .slice(0, 5),
  };
}

export function toEntry(
  slot: ModelSlot,
  m: OrModel,
  shortCode: string,
  color: string,
  arena: ArenaConfig,
): ModelEntry {
  const est = monthlyEstimateUsd(m, arena.llm.estimate);
  return {
    slot,
    openrouterId: m.id,
    canonicalSlug: m.canonical_slug ?? null,
    displayName: m.name.replace(/^[^:]+:\s*/, ''),
    shortCode,
    color,
    created: m.created ?? null,
    contextLength: m.context_length ?? null,
    supportedParameters: [...(m.supported_parameters ?? [])].sort(),
    pricing: { promptUsdPerToken: m.pricing.prompt, completionUsdPerToken: m.pricing.completion },
    monthlyEstimateUsd: est,
    monthlyCapUsd: Math.round(est * arena.llm.budgetCapMultiplier * 100) / 100,
  };
}

export interface RosterProposal {
  config: ModelsConfig | null;
  picks: SlotPick[];
  alternatives: ModelEntry[];
  /** Slots whose rules matched no model: the roster can't be written. */
  missingSlots: ModelSlot[];
  /** Slots that sit out this tier (the free tier, for a lab with no free model). */
  notOffered: ModelSlot[];
  /** Model calls per trading day at this roster and schedule, before repair attempts. */
  callsPerDay: number;
  /** The models that matched, shown even when the roster is incomplete. */
  participants: ModelEntry[];
}

export function proposeRoster(
  models: OrModel[],
  rules: RosterRules,
  tier: Tier,
  arena: ArenaConfig,
  generatedAt: Date,
): RosterProposal {
  const picks: SlotPick[] = [];
  const participants: ModelEntry[] = [];
  const alternatives: ModelEntry[] = [];
  const notOffered: ModelSlot[] = [];
  for (const slot of SLOTS) {
    const r = rules.slots[slot];
    if (!r) {
      picks.push({ slot, chosen: null, otherMatches: [] });
      continue;
    }
    const patterns = r.tiers[tier] ?? [];
    if (tier === 'free' && patterns.length === 0) {
      notOffered.push(slot);
      continue;
    }
    const { chosen, others } = pickForPatterns(models, patterns, rules);
    picks.push({ slot, chosen, otherMatches: others });
    const code = tier === 'free' ? (r.freeShortCode ?? r.shortCode) : r.shortCode;
    if (chosen) participants.push(toEntry(slot, chosen, code, r.color, arena));
    // Alternatives are priced models, so they don't apply to the free tier.
    if (tier === 'free') continue;
    for (const alt of r.alternatives) {
      const a = pickForPatterns(models, [alt.pattern], rules);
      if (a.chosen) alternatives.push(toEntry(slot, a.chosen, alt.shortCode, r.color, arena));
    }
  }
  const missingSlots = picks.filter((p) => !p.chosen).map((p) => p.slot);
  const enough = tier !== 'free' || participants.length >= MIN_FREE_PARTICIPANTS;
  const callsPerDay = participants.length * slotTimes(arena).length;
  const config: ModelsConfig | null =
    missingSlots.length === 0 && enough
      ? {
          $comment:
            'Proposed by `pnpm engine roster`. A live season will not start until a human sets "approved": true (SPEC §3.2). Never change a model mid-season.',
          tier,
          approved: false,
          approvedBy: null,
          approvedOn: null,
          generatedAt: generatedAt.toISOString(),
          source: 'https://openrouter.ai/api/v1/models',
          estimateAssumptions: { ...arena.llm.estimate },
          totalMonthlyEstimateUsd:
            Math.round(participants.reduce((s, p) => s + p.monthlyEstimateUsd, 0) * 100) / 100,
          participants,
          alternatives,
          benchmarks: rules.benchmarks,
        }
      : null;
  return { config, picks, alternatives, missingSlots, notOffered, callsPerDay, participants };
}

const perM = (usdPerToken: string) => `$${(Number(usdPerToken) * 1e6).toFixed(2)}`;

export function rosterTable(p: RosterProposal): string {
  const rows = [
    '| Slot | Code | Model ID | Name | $/M in | $/M out | Context | Structured outputs | Reasoning | Temperature | Est. $/month | Cap $/month |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const line = (e: ModelEntry, label: string = e.slot) =>
    `| ${label} | ${e.shortCode} | \`${e.openrouterId}\` | ${e.displayName} | ${perM(e.pricing.promptUsdPerToken)} | ${perM(e.pricing.completionUsdPerToken)} | ${e.contextLength ?? '—'} | ${e.supportedParameters.includes('structured_outputs') ? 'yes' : 'no'} | ${e.supportedParameters.includes('reasoning') ? 'yes' : 'no'} | ${e.supportedParameters.includes('temperature') ? 'yes' : 'no'} | ${e.monthlyEstimateUsd.toFixed(2)} | ${e.monthlyCapUsd.toFixed(2)} |`;
  for (const e of p.participants) rows.push(line(e));
  for (const e of p.alternatives) rows.push(line(e, `${e.slot} (alternative)`));
  for (const s of p.missingSlots)
    rows.push(`| ${s} | — | no model matched the rules | | | | | | | | | |`);
  for (const s of p.notOffered)
    rows.push(`| ${s} | — | sits out: no free model from this lab | | | | | | | | | |`);
  const free = p.config?.tier === 'free';
  const total = !p.config
    ? ''
    : free
      ? `\n\nFree models: **$0 a month**. About ${p.callsPerDay} model calls per trading day (${p.config.participants.length} models × ${p.callsPerDay / p.config.participants.length} rounds), plus a repair call when an answer can't be read. OpenRouter allows ${FREE_REQUESTS_PER_DAY} free-model requests a day on an account that has never bought credit.${p.callsPerDay * 2 > FREE_REQUESTS_PER_DAY ? ' **Warning:** with repairs and retries this can pass the daily limit; consider fewer rounds.' : ''}`
      : `\n\nEstimated total: **$${p.config.totalMonthlyEstimateUsd.toFixed(2)} a month** (${p.config.estimateAssumptions.roundsPerMonth} rounds × ${p.config.estimateAssumptions.inputTokensPerCall} input + ${p.config.estimateAssumptions.outputTokensPerCall} output tokens per call, incl. reasoning), before OpenRouter's 5.5% credit fee.`;
  const others = p.picks
    .filter((x) => x.otherMatches.length)
    .map((x) => `- ${x.slot}: also matched ${x.otherMatches.map((o) => `\`${o}\``).join(', ')}`)
    .join('\n');
  return `${rows.join('\n')}${total}${others ? `\n\nOther models that matched (older or undated):\n${others}` : ''}`;
}

/**
 * Every `:free` model OpenRouter lists right now, newest first, so the owner can see what the free
 * tier can choose from (the free lineup changes often).
 */
export function freeModelList(models: OrModel[]): string {
  const free = models
    .filter((m) => m.id.endsWith(':free'))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  if (!free.length) return 'OpenRouter lists no `:free` models right now.';
  const day = (s: number | null | undefined) =>
    s ? new Date(s * 1000).toISOString().slice(0, 10) : '—';
  const rows = free.map(
    (m) =>
      `| \`${m.id}\` | ${day(m.created)} | ${m.context_length ?? '—'} | ${m.supported_parameters?.includes('structured_outputs') || m.supported_parameters?.includes('response_format') ? 'yes' : 'no'} |`,
  );
  return [
    `Free models on OpenRouter now (${free.length}), newest first:`,
    '',
    '| Model ID | Released | Context | JSON output |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
