/**
 * OpenRouter client (SPEC §9). One exact model per call: no `models` fallback list, no auto-router.
 * Our own timeout and retry policy; no SDK retries.
 */
import { z } from 'zod';
import type { LlmErrorClass } from '@arena/shared/codes';
import { httpJson, HttpError, sleep, type FetchLike } from '../data/http';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ---- /models (public) ----
export const orModel = z
  .object({
    id: z.string(),
    canonical_slug: z.string().nullish(),
    name: z.string(),
    created: z.number().nullish(),
    context_length: z.number().nullish(),
    pricing: z.object({ prompt: z.string(), completion: z.string() }).passthrough(),
    supported_parameters: z.array(z.string()).nullish(),
  })
  .passthrough();
export type OrModel = z.infer<typeof orModel>;
const modelsResponse = z.object({ data: z.array(z.unknown()) });

// ---- /chat/completions ----
const usageSchema = z
  .object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
    cost: z.number().nullish(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export const chatResponse = z
  .object({
    id: z.string().optional(),
    model: z.string(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullish(),
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullish(),
                refusal: z.string().nullish(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: usageSchema.nullish(),
  })
  .passthrough();
export type ChatResponse = z.infer<typeof chatResponse>;
const errorBody = z
  .object({
    error: z
      .object({ code: z.union([z.number(), z.string()]).nullish(), message: z.string().nullish() })
      .passthrough(),
  })
  .passthrough();

// ---- /key ----
const keyResponse = z.object({
  data: z
    .object({
      label: z.string().nullish(),
      limit: z.number().nullish(),
      usage: z.number().nullish(),
      limit_remaining: z.number().nullish(),
      is_free_tier: z.boolean().nullish(),
    })
    .passthrough(),
});
const creditsResponse = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }).passthrough(),
});

export class LlmError extends Error {
  constructor(
    readonly errorClass: LlmErrorClass,
    message: string,
    readonly status: number | null,
    readonly body: string | null,
    /** Seconds from a Retry-After header, when the response sent one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** OpenRouter's daily cap on free-model requests: retrying can't help until the next day. */
export function isDailyLimit(e: LlmError): boolean {
  return e.status === 429 && /per[- ]?day|daily/i.test(`${e.message} ${e.body ?? ''}`);
}

function retryAfterOf(headers: Headers | undefined): number | null {
  const v = headers?.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** Maps an HTTP status and error body to a SPEC §9.5 class. */
export function classifyHttp(status: number, bodyText: string): LlmErrorClass | null {
  const parsed = errorBody.safeParse(safeJson(bodyText));
  const code = parsed.success ? Number(parsed.data.error.code) : NaN;
  const msg = parsed.success ? (parsed.data.error.message ?? '') : bodyText;
  const s = status >= 200 && status < 300 && Number.isFinite(code) ? code : status;
  if (s === 401 || s === 403) return 'CONFIG_AUTH';
  if (s === 402) return 'CREDITS_EXHAUSTED';
  if (s === 404 || /model not found|no endpoints found|is not a valid model/i.test(msg))
    return 'MODEL_UNAVAILABLE';
  if (s === 400) return 'MODEL_UNAVAILABLE';
  if (s === 408 || s === 429 || s >= 500) return 'TRANSIENT';
  if (status >= 200 && status < 300 && parsed.success) return 'TRANSIENT'; // an error object in a 200 body without a usable code
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: classification falls back to the status code and raw text.
    return undefined;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatAttempt {
  status: number;
  bodyText: string;
  response: ChatResponse;
  latencyMs: number;
}

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class OpenRouterClient {
  private readonly base: string;
  constructor(private readonly opts: OpenRouterOptions) {
    this.base = opts.baseUrl ?? OPENROUTER_BASE;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Title': 'AI Arena' };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  /** GET /models: the public model list, no key needed. */
  async listModels(timeoutMs = 30_000): Promise<{ models: OrModel[]; skipped: number }> {
    const res = await httpJson({
      url: `${this.base}/models`,
      timeoutMs,
      fetchImpl: this.opts.fetchImpl,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok)
      throw new LlmError(
        classifyHttp(res.status, res.text) ?? 'TRANSIENT',
        `GET /models failed with HTTP ${res.status}`,
        res.status,
        null,
      );
    const env = modelsResponse.safeParse(res.json);
    if (!env.success)
      throw new LlmError('BAD_OUTPUT', 'GET /models: unexpected shape', res.status, null);
    const models: OrModel[] = [];
    let skipped = 0;
    for (const m of env.data.data) {
      const p = orModel.safeParse(m);
      if (p.success) models.push(p.data);
      else skipped++;
    }
    return { models, skipped };
  }

  /** Remaining credit in USD from /key (limit_remaining) or /credits (total − used). Null when unlimited/unknown. */
  async remainingCreditUsd(
    timeoutMs = 30_000,
  ): Promise<{ remainingUsd: number | null; source: string }> {
    const key = await httpJson({
      url: `${this.base}/key`,
      timeoutMs,
      headers: this.headers(),
      fetchImpl: this.opts.fetchImpl,
    });
    if (key.status === 401 || key.status === 403)
      throw new LlmError('CONFIG_AUTH', 'OpenRouter rejected the API key', key.status, null);
    const k = keyResponse.safeParse(key.json);
    if (key.ok && k.success && typeof k.data.data.limit_remaining === 'number')
      return { remainingUsd: k.data.data.limit_remaining, source: '/key limit_remaining' };
    const cr = await httpJson({
      url: `${this.base}/credits`,
      timeoutMs,
      headers: this.headers(),
      fetchImpl: this.opts.fetchImpl,
    });
    const c = creditsResponse.safeParse(cr.json);
    if (cr.ok && c.success)
      return {
        remainingUsd: c.data.data.total_credits - c.data.data.total_usage,
        source: '/credits',
      };
    if (key.ok && k.success) return { remainingUsd: null, source: '/key (no limit set)' };
    throw new LlmError(
      classifyHttp(cr.status, cr.text) ?? 'TRANSIENT',
      `could not read credit (HTTP ${key.status}/${cr.status})`,
      cr.status,
      null,
    );
  }

  /** One HTTP attempt. Throws LlmError with a class; returns the validated response otherwise. */
  async chatOnce(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<ChatAttempt> {
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    let res;
    try {
      res = await httpJson({
        url: `${this.base}/chat/completions`,
        method: 'POST',
        headers: this.headers(),
        body,
        timeoutMs,
        fetchImpl: this.opts.fetchImpl,
        signal,
      });
    } catch (e) {
      if (e instanceof HttpError) throw new LlmError('TRANSIENT', e.message, null, null);
      throw e;
    }
    const latencyMs = Math.round(now() - t0);
    const cls = classifyHttp(res.status, res.text);
    const parsed = chatResponse.safeParse(res.json);
    if (res.ok && parsed.success) {
      return { status: res.status, bodyText: res.text, response: parsed.data, latencyMs };
    }
    if (cls)
      throw new LlmError(
        cls,
        `OpenRouter HTTP ${res.status}: ${errorMessageOf(res.text)}`,
        res.status,
        res.text,
        retryAfterOf(res.headers),
      );
    throw new LlmError(
      'BAD_OUTPUT',
      `unexpected response shape (HTTP ${res.status})`,
      res.status,
      res.text,
    );
  }

  /**
   * TRANSIENT failures: up to len(delays) retries with backoff and jitter (SPEC §9.5). An HTTP 429
   * (provider busy) uses the longer rate-limit delays and honours Retry-After up to a cap; the
   * daily free-model limit is never retried.
   */
  async chatWithRetry(
    body: unknown,
    timeoutMs: number,
    delaysSeconds: number[],
    signal?: AbortSignal,
    rateLimit: { delaysSeconds?: number[]; maxRetryAfterSeconds?: number } = {},
  ): Promise<{ attempt: ChatAttempt; attempts: number }> {
    const wait = this.opts.wait ?? sleep;
    // Jitter only; never affects trading decisions. Uses crypto, since the guard reserves the global PRNG for nobody.
    const random =
      this.opts.random ??
      (() => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        return { attempt: await this.chatOnce(body, timeoutMs, signal), attempts };
      } catch (e) {
        const busy = e instanceof LlmError && e.status === 429;
        const delays = busy ? (rateLimit.delaysSeconds ?? delaysSeconds) : delaysSeconds;
        const retryable =
          e instanceof LlmError &&
          e.errorClass === 'TRANSIENT' &&
          !(busy && isDailyLimit(e)) &&
          attempts <= delays.length &&
          !signal?.aborted;
        if (!retryable) {
          if (e instanceof LlmError) (e as LlmError & { attempts?: number }).attempts = attempts;
          throw e;
        }
        let base = delays[attempts - 1]! * 1000;
        const after = (e as LlmError).retryAfterSeconds;
        if (busy && after !== null)
          base = Math.max(base, Math.min(after, rateLimit.maxRetryAfterSeconds ?? 90) * 1000);
        await wait(base + Math.floor(random() * base * 0.25));
      }
    }
  }
}

function errorMessageOf(text: string): string {
  const p = errorBody.safeParse(safeJson(text));
  return (p.success ? (p.data.error.message ?? '') : text).slice(0, 300);
}
