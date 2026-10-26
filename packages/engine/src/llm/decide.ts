/**
 * One model's decision for one round (SPEC §9.3–§9.8). Never throws for model or provider failures:
 * every outcome is a status to record and publish.
 */
import { createHash } from 'node:crypto';
import type { ArenaConfig, ModelEntry } from '@arena/shared/schemas';
import type { DecisionStatus, LlmErrorClass } from '@arena/shared/codes';
import type { OpenRouterClient } from './openrouter';
import { LlmError, type ChatMessage, type ChatAttempt } from './openrouter';
import { buildChatRequest, isSameModel, REPAIR_PROMPT } from './request';
import { parseDecisionContent, type ParsedDecision } from './parse';

export interface DecisionRecord {
  status: DecisionStatus;
  errorClass: LlmErrorClass | null;
  errorDetail: string | null;
  promptSha256: string;
  requestParams: Record<string, unknown>;
  rawResponse: string | null;
  parsed: {
    content: string | null;
    method: string | null;
    error: string | null;
    repaired: boolean;
  } | null;
  decision: ParsedDecision | null;
  servingModel: string | null;
  attempts: number;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
}

export function promptHash(messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

/** Request parameters with the message bodies replaced by their hash: no secrets, no duplication. */
export function publicRequestParams(
  body: Record<string, unknown>,
  sha: string,
): Record<string, unknown> {
  const { messages: _m, ...rest } = body;
  return { ...rest, messages_sha256: sha };
}

const STATUS_FOR: Record<LlmErrorClass, DecisionStatus> = {
  CONFIG_AUTH: 'MISSED_CONFIG',
  CREDITS_EXHAUSTED: 'MISSED_CONFIG',
  MODEL_UNAVAILABLE: 'MISSED_CONFIG',
  TRANSIENT: 'MISSED_PROVIDER',
  BAD_OUTPUT: 'INVALID_RESPONSE',
  MODEL_MISMATCH: 'MODEL_MISMATCH',
};

interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cost: number;
  estimated: boolean;
  any: boolean;
}

function addUsage(u: Usage, a: ChatAttempt, entry: ModelEntry) {
  const us = a.response.usage;
  if (!us) {
    u.estimated = true;
    return;
  }
  u.any = true;
  const inT = us.prompt_tokens ?? 0;
  const outT = us.completion_tokens ?? 0;
  u.input += inT;
  u.output += outT;
  u.reasoning += us.completion_tokens_details?.reasoning_tokens ?? 0;
  if (typeof us.cost === 'number') u.cost += us.cost;
  else {
    u.estimated = true;
    u.cost +=
      inT * Number(entry.pricing.promptUsdPerToken) +
      outT * Number(entry.pricing.completionUsdPerToken);
  }
}

export interface DecideArgs {
  client: OpenRouterClient;
  entry: ModelEntry;
  system: string;
  user: string;
  llm: ArenaConfig['llm'];
  noteMaxChars: number;
  signal?: AbortSignal;
}

export async function decideWithModel(a: DecideArgs): Promise<DecisionRecord> {
  const messages: ChatMessage[] = [
    { role: 'system', content: a.system },
    { role: 'user', content: a.user },
  ];
  const sha = promptHash(messages);
  const body = buildChatRequest(a.entry, messages, a.llm);
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cost: 0, estimated: false, any: false };
  let attempts = 0;
  let latency = 0;
  const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
    status: 'MISSED_PROVIDER',
    errorClass: null,
    errorDetail: null,
    promptSha256: sha,
    requestParams: publicRequestParams(body, sha),
    rawResponse: null,
    parsed: null,
    decision: null,
    servingModel: null,
    attempts,
    latencyMs: attempts ? latency : null,
    inputTokens: usage.any ? usage.input : null,
    outputTokens: usage.any ? usage.output : null,
    reasoningTokens: usage.any ? usage.reasoning : null,
    costUsd: usage.any || usage.cost > 0 ? Math.round(usage.cost * 1e6) / 1e6 : null,
    costEstimated: usage.estimated,
    ...over,
  });

  const call = async (b: Record<string, unknown>) => {
    try {
      const r = await a.client.chatWithRetry(
        b,
        a.llm.timeoutSeconds * 1000,
        a.llm.retryDelaysSeconds,
        a.signal,
        {
          delaysSeconds: a.llm.rateLimitRetryDelaysSeconds,
          maxRetryAfterSeconds: a.llm.maxRetryAfterSeconds,
        },
      );
      attempts += r.attempts;
      latency += r.attempt.latencyMs;
      addUsage(usage, r.attempt, a.entry);
      return { ok: true as const, attempt: r.attempt };
    } catch (e) {
      if (e instanceof LlmError) {
        attempts += (e as LlmError & { attempts?: number }).attempts ?? 1;
        return { ok: false as const, error: e };
      }
      throw e;
    }
  };

  const first = await call(body);
  if (!first.ok) {
    const cls = a.signal?.aborted ? 'TRANSIENT' : first.error.errorClass;
    return rec({
      status: STATUS_FOR[cls],
      errorClass: cls,
      errorDetail: first.error.message,
      rawResponse: first.error.body,
    });
  }
  const serving = first.attempt.response.model;
  if (!isSameModel(a.entry, serving)) {
    return rec({
      status: 'MODEL_MISMATCH',
      errorClass: 'MODEL_MISMATCH',
      errorDetail: `configured ${a.entry.openrouterId}, served ${serving}`,
      rawResponse: first.attempt.bodyText,
      servingModel: serving,
    });
  }
  const msg = first.attempt.response.choices[0]!.message;
  const content = msg.content ?? null;
  const ranOut1 = ranOutOfTokens(first.attempt);
  const p1 = msg.refusal
    ? ({ ok: false, error: `the model refused: ${msg.refusal.slice(0, 200)}` } as const)
    : explainCutOff(parseDecisionContent(content, { noteMaxChars: a.noteMaxChars }), ranOut1);
  if (p1.ok) {
    return rec({
      status: 'OK',
      rawResponse: first.attempt.bodyText,
      parsed: { content, method: p1.decision.method, error: null, repaired: false },
      decision: p1.decision,
      servingModel: serving,
    });
  }

  // One repair attempt in the same conversation (SPEC §9.4).
  // A reply cut off while thinking gets its repair with less thinking, so it has room to answer.
  const lessThinking =
    ranOut1 && a.llm.repairReasoningEffort && 'reasoning' in body
      ? { reasoning: { effort: a.llm.repairReasoningEffort } }
      : {};
  const repairBody = {
    ...body,
    ...lessThinking,
    messages: [
      ...messages,
      { role: 'assistant', content: content ?? '' },
      { role: 'user', content: REPAIR_PROMPT(p1.error) },
    ],
  };
  const second = await call(repairBody);
  if (!second.ok) {
    const cls = second.error.errorClass;
    const status: DecisionStatus =
      cls === 'TRANSIENT' || cls === 'BAD_OUTPUT' ? 'INVALID_RESPONSE' : STATUS_FOR[cls];
    return rec({
      status,
      errorClass: cls === 'TRANSIENT' ? 'BAD_OUTPUT' : cls,
      errorDetail: `first reply unreadable (${p1.error}); repair call failed: ${second.error.message}`,
      rawResponse: first.attempt.bodyText,
      parsed: { content, method: null, error: p1.error, repaired: false },
      servingModel: serving,
    });
  }
  const serving2 = second.attempt.response.model;
  if (!isSameModel(a.entry, serving2)) {
    return rec({
      status: 'MODEL_MISMATCH',
      errorClass: 'MODEL_MISMATCH',
      errorDetail: `repair served ${serving2}`,
      rawResponse: second.attempt.bodyText,
      servingModel: serving2,
    });
  }
  const content2 = second.attempt.response.choices[0]!.message.content ?? null;
  const p2 = explainCutOff(
    parseDecisionContent(content2, { noteMaxChars: a.noteMaxChars }),
    ranOutOfTokens(second.attempt),
  );
  if (p2.ok) {
    return rec({
      status: 'OK',
      rawResponse: second.attempt.bodyText,
      parsed: { content: content2, method: p2.decision.method, error: null, repaired: true },
      decision: { ...p2.decision, flags: [...p2.decision.flags, 'repaired'] },
      servingModel: serving,
    });
  }
  return rec({
    status: 'INVALID_RESPONSE',
    errorClass: 'BAD_OUTPUT',
    errorDetail: `unreadable twice: ${p1.error}; then ${p2.error}`,
    rawResponse: second.attempt.bodyText,
    parsed: { content: content2, method: null, error: p2.error, repaired: true },
    servingModel: serving,
  });
}

/** The reply stopped at the output-token limit (finish_reason "length"), with its token counts. */
function ranOutOfTokens(
  a: ChatAttempt,
): { output: number | null; reasoning: number | null } | null {
  if (a.response.choices[0]?.finish_reason !== 'length') return null;
  const u = a.response.usage;
  return {
    output: u?.completion_tokens ?? null,
    reasoning: u?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

/** Replaces a bare "empty" or "unreadable" with why: the model ran out of output tokens. */
function explainCutOff(
  p: ReturnType<typeof parseDecisionContent>,
  ranOut: { output: number | null; reasoning: number | null } | null,
): ReturnType<typeof parseDecisionContent> {
  if (p.ok || !ranOut) return p;
  const used =
    ranOut.output === null
      ? 'all its output tokens'
      : `all ${ranOut.output} output tokens${ranOut.reasoning ? ` (${ranOut.reasoning} on thinking)` : ''}`;
  return {
    ok: false,
    error: `the reply ran out of room: it used ${used} before finishing (${p.error})`,
  };
}
