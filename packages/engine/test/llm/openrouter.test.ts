import { describe, it, expect } from 'vitest';
import { OpenRouterClient, classifyHttp, LlmError } from '../../src/llm/openrouter';
import { decideWithModel, publicRequestParams } from '../../src/llm/decide';
import { buildChatRequest, isSameModel, DECISION_JSON_SCHEMA } from '../../src/llm/request';
import {
  proposeRoster,
  rosterTable,
  monthlyEstimateUsd,
  pickForPatterns,
} from '../../src/llm/roster';
import { overBudget } from '../../src/llm/budget';
import { fixture, fakeFetch } from '../helpers/fixtures';
import { must, loadArena, loadRosterRules } from '../../src/config/load';
import { modelsConfigSchema, type ModelEntry } from '@arena/shared/schemas';
import { slotTimes } from '../../src/round/schedule';

const arena = must(loadArena());
const rules = must(loadRosterRules());
const ok = fixture('openrouter/chat-success.docs-example.json');
const err = (code: number) => fixture(`openrouter/error-${code}.docs-example.json`);

const entry: ModelEntry = {
  slot: 'openai',
  openrouterId: 'openai/gpt-5.4-mini',
  canonicalSlug: 'openai/gpt-5.4-mini-2026-04-27',
  displayName: 'GPT-5.4 Mini',
  shortCode: 'GPT',
  color: '#5AB8F0',
  created: 1,
  contextLength: 400000,
  supportedParameters: [
    'max_tokens',
    'temperature',
    'reasoning',
    'response_format',
    'structured_outputs',
  ],
  pricing: { promptUsdPerToken: '0.00000075', completionUsdPerToken: '0.0000045' },
  monthlyEstimateUsd: 2.83,
  monthlyCapUsd: 4.25,
};

const okBody = (
  content: string,
  model = 'openai/gpt-5.4-mini',
  usage: unknown = (ok.body as { usage: unknown }).usage,
) => ({
  ...(ok.body as object),
  model,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage,
});
const GOOD = (ok.body as { choices: { message: { content: string } }[] }).choices[0]!.message
  .content;

function client(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  const waits: number[] = [];
  return {
    f,
    waits,
    c: new OpenRouterClient({
      apiKey: 'sk-test',
      fetchImpl: f.impl,
      wait: async (ms) => void waits.push(ms),
      random: () => 0,
    }),
  };
}
const decide = (c: OpenRouterClient, signal?: AbortSignal) =>
  decideWithModel({
    client: c,
    entry,
    system: 'SYS',
    user: 'USER',
    llm: arena.llm,
    noteMaxChars: 500,
    signal,
  });

describe('error classification from recorded bodies (SPEC §9.5)', () => {
  it.each([
    [401, 'CONFIG_AUTH'],
    [402, 'CREDITS_EXHAUSTED'],
    [404, 'MODEL_UNAVAILABLE'],
    [400, 'MODEL_UNAVAILABLE'],
    [408, 'TRANSIENT'],
    [429, 'TRANSIENT'],
    [502, 'TRANSIENT'],
    [503, 'TRANSIENT'],
  ])('HTTP %i → %s', (code, cls) => {
    expect(classifyHttp(code, JSON.stringify(err(code).body))).toBe(cls);
  });
  it('reads an error object inside a 200 body, and plain-text bodies', () => {
    expect(classifyHttp(200, JSON.stringify({ error: { code: 402, message: 'x' } }))).toBe(
      'CREDITS_EXHAUSTED',
    );
    expect(classifyHttp(200, JSON.stringify({ error: { message: 'something' } }))).toBe(
      'TRANSIENT',
    );
    expect(classifyHttp(403, 'Forbidden')).toBe('CONFIG_AUTH');
    expect(classifyHttp(418, 'teapot')).toBeNull();
    expect(classifyHttp(422, '{"error":{"message":"model not found"}}')).toBe('MODEL_UNAVAILABLE');
  });
});

describe('request (SPEC §9.1)', () => {
  it('sends the exact model, no fallback list, only supported parameters', () => {
    const b = buildChatRequest(entry, [{ role: 'system', content: 's' }], arena.llm);
    expect(b).toMatchObject({
      model: 'openai/gpt-5.4-mini',
      provider: { require_parameters: true },
      usage: { include: true },
      max_tokens: 4000,
      temperature: 0.3,
      reasoning: { effort: 'medium' },
    });
    expect(b).not.toHaveProperty('models');
    expect((b.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toBe(
      DECISION_JSON_SCHEMA,
    );
    const bare = buildChatRequest({ ...entry, supportedParameters: ['max_tokens'] }, [], arena.llm);
    expect(Object.keys(bare).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'provider',
      'usage',
    ]);
    expect(publicRequestParams(b, 'abc')).not.toHaveProperty('messages');
  });
  it('accepts only the configured ID or its documented canonical slug (SPEC §9.6)', () => {
    expect(isSameModel(entry, 'openai/gpt-5.4-mini')).toBe(true);
    expect(isSameModel(entry, 'openai/gpt-5.4-mini-2026-04-27')).toBe(true);
    expect(isSameModel(entry, 'openai/gpt-5-mini')).toBe(false);
    expect(isSameModel({ ...entry, canonicalSlug: null }, 'openai/gpt-5.4-mini-2026-04-27')).toBe(
      false,
    );
  });
});

describe('decideWithModel', () => {
  it('records an OK decision with tokens, cost and serving model; sends the bearer key', async () => {
    const { c, f } = client(() => ({ body: okBody(GOOD) }));
    const r = await decide(c);
    expect(r).toMatchObject({
      status: 'OK',
      servingModel: 'openai/gpt-5.4-mini',
      attempts: 1,
      inputTokens: 5821,
      outputTokens: 912,
      reasoningTokens: 640,
      costUsd: 0.004982,
      costEstimated: false,
    });
    expect(r.decision?.actions).toHaveLength(1);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer sk-test');
    expect(r.requestParams).not.toHaveProperty('messages');
    expect(JSON.stringify(r)).not.toContain('sk-test');
  });
  it('estimates cost from token prices when the response has none', async () => {
    const { c } = client(() => ({
      body: okBody(GOOD, entry.openrouterId, { prompt_tokens: 1000, completion_tokens: 100 }),
    }));
    const r = await decide(c);
    expect(r.costEstimated).toBe(true);
    expect(r.costUsd).toBeCloseTo(1000 * 0.00000075 + 100 * 0.0000045, 9);
    const { c: c2 } = client(() => ({ body: okBody(GOOD, entry.openrouterId, null) }));
    expect((await decide(c2)).costEstimated).toBe(true);
  });
  it('retries TRANSIENT errors twice with backoff, then MISSED_PROVIDER', async () => {
    const { c, f, waits } = client(() => ({ status: 429, body: err(429).body }));
    const r = await decide(c);
    expect(r).toMatchObject({ status: 'MISSED_PROVIDER', errorClass: 'TRANSIENT', attempts: 3 });
    expect(f.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 6000]);
  });
  it('recovers when a retry succeeds', async () => {
    const { c } = client((_c, n) =>
      n === 1 ? { status: 502, body: err(502).body } : { body: okBody(GOOD) },
    );
    expect(await decide(c)).toMatchObject({ status: 'OK', attempts: 2 });
  });
  it('treats network errors and timeouts as TRANSIENT', async () => {
    const { c } = client(() => new Error('ECONNRESET'));
    expect((await decide(c)).status).toBe('MISSED_PROVIDER');
    const slow = new OpenRouterClient({
      apiKey: 'k',
      wait: async () => {},
      fetchImpl: (_u, init) =>
        new Promise((_r, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    });
    const r = await decideWithModel({
      client: slow,
      entry,
      system: 's',
      user: 'u',
      llm: { ...arena.llm, timeoutSeconds: 0.01 as unknown as number, retryDelaysSeconds: [0] },
      noteMaxChars: 500,
    });
    expect(r).toMatchObject({ status: 'MISSED_PROVIDER', errorClass: 'TRANSIENT', attempts: 2 });
  });
  it.each([
    [401, 'MISSED_CONFIG', 'CONFIG_AUTH'],
    [402, 'MISSED_CONFIG', 'CREDITS_EXHAUSTED'],
    [404, 'MISSED_CONFIG', 'MODEL_UNAVAILABLE'],
  ])('HTTP %i: no retry, %s / %s', async (code, status, cls) => {
    const { c, f } = client(() => ({ status: code, body: err(code).body }));
    expect(await decide(c)).toMatchObject({ status, errorClass: cls, attempts: 1 });
    expect(f.calls).toHaveLength(1);
  });
  it('flags a different serving model as MODEL_MISMATCH and records no decision', async () => {
    const { c } = client(() => ({ body: okBody(GOOD, 'openai/gpt-5-mini') }));
    const r = await decide(c);
    expect(r).toMatchObject({
      status: 'MODEL_MISMATCH',
      errorClass: 'MODEL_MISMATCH',
      servingModel: 'openai/gpt-5-mini',
      decision: null,
    });
  });
  it('accepts the canonical dated slug', async () => {
    const { c } = client(() => ({ body: okBody(GOOD, 'openai/gpt-5.4-mini-2026-04-27') }));
    expect((await decide(c)).status).toBe('OK');
  });
  it('sends exactly one repair message, and accepts a readable second answer', async () => {
    const { c, f } = client((_c, n) => ({
      body: okBody(n === 1 ? 'I think TCS looks good.' : GOOD),
    }));
    const r = await decide(c);
    expect(r.status).toBe('OK');
    expect(r.decision?.flags).toContain('repaired');
    const msgs = (f.calls[1]!.body as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3]!.content).toBe(
      "Your reply couldn't be read: no JSON object could be read from the reply. Reply again with only the JSON object described in the rules.",
    );
    expect(r.costUsd).toBeCloseTo(0.004982 * 2, 9);
  });
  it('is INVALID_RESPONSE after two unreadable answers, empty content, or a refusal', async () => {
    const { c, f } = client(() => ({ body: okBody('nope') }));
    expect(await decide(c)).toMatchObject({ status: 'INVALID_RESPONSE', errorClass: 'BAD_OUTPUT' });
    expect(f.calls).toHaveLength(2);
    const refusal = {
      ...okBody(''),
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: null, refusal: 'I cannot give financial advice.' },
        },
      ],
    };
    const { c: c2 } = client(() => ({ body: refusal }));
    expect((await decide(c2)).errorDetail).toMatch(/refused/);
  });
  it('treats a failed repair call as INVALID_RESPONSE, but keeps auth/credit classes', async () => {
    const { c } = client((_c, n) =>
      n === 1 ? { body: okBody('???') } : { status: 503, body: err(503).body },
    );
    expect((await decide(c)).status).toBe('INVALID_RESPONSE');
    const { c: c2 } = client((_c, n) =>
      n === 1 ? { body: okBody('???') } : { status: 402, body: err(402).body },
    );
    expect(await decide(c2)).toMatchObject({
      status: 'MISSED_CONFIG',
      errorClass: 'CREDITS_EXHAUSTED',
    });
    const { c: c3 } = client((_c, n) => ({
      body: n === 1 ? okBody('???') : okBody(GOOD, 'other/model'),
    }));
    expect((await decide(c3)).status).toBe('MODEL_MISMATCH');
  });
  it('treats an unexpected 200 shape as an unreadable answer', async () => {
    const { c } = client(() => ({ body: { hello: 'world' } }));
    expect((await decide(c)).status).toBe('INVALID_RESPONSE');
  });
  it('stops at the decision deadline', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { c } = client(() => new Error('aborted'));
    expect((await decide(c, ctrl.signal)).status).toBe('MISSED_PROVIDER');
  });
});

describe('credit and model list', () => {
  it('reads remaining credit from /key, falls back to /credits, and rejects a bad key', async () => {
    const k = fixture('openrouter/key.docs-example.json');
    const { c } = client(() => ({ body: k.body }));
    expect(await c.remainingCreditUsd()).toEqual({
      remainingUsd: 7.5,
      source: '/key limit_remaining',
    });
    const { c: c2 } = client((call) =>
      call.url.endsWith('/key')
        ? { body: { data: { limit: null, limit_remaining: null } } }
        : { body: { data: { total_credits: 10, total_usage: 4 } } },
    );
    expect(await c2.remainingCreditUsd()).toEqual({ remainingUsd: 6, source: '/credits' });
    const { c: c3 } = client((call) =>
      call.url.endsWith('/key') ? { body: { data: { limit: null } } } : { status: 403, body: {} },
    );
    expect((await c3.remainingCreditUsd()).remainingUsd).toBeNull();
    const { c: c4 } = client(() => ({ status: 401, body: err(401).body }));
    await expect(c4.remainingCreditUsd()).rejects.toMatchObject({ errorClass: 'CONFIG_AUTH' });
    const { c: c5 } = client(() => ({ status: 500, body: 'oops' }));
    await expect(c5.remainingCreditUsd()).rejects.toBeInstanceOf(LlmError);
  });
  it('lists models, skipping entries with an unexpected shape', async () => {
    const { c } = client(() => ({
      body: fixture('openrouter/models-list.docs-example.json').body,
    }));
    const r = await c.listModels();
    expect(r.skipped).toBe(1);
    expect(r.models.length).toBeGreaterThan(10);
    const { c: c2 } = client(() => ({ status: 500, body: 'x' }));
    await expect(c2.listModels()).rejects.toBeInstanceOf(LlmError);
    const { c: c3 } = client(() => ({ body: { models: [] } }));
    await expect(c3.listModels()).rejects.toMatchObject({ errorClass: 'BAD_OUTPUT' });
  });
});

describe('roster (SPEC §3.2)', () => {
  it('picks the newest model per slot, prefers dated IDs, excludes aliases, batch, lite and contributor variants', async () => {
    const { c } = client(() => ({
      body: fixture('openrouter/models-list.docs-example.json').body,
    }));
    const { models } = await c.listModels();
    const p = proposeRoster(models, rules, 'budget', arena, new Date('2026-10-24T00:00:00Z'));
    expect(p.missingSlots).toEqual([]);
    expect(p.config!.participants.map((x) => x.openrouterId)).toEqual([
      'openai/gpt-5.4-mini-2026-04-27',
      'anthropic/claude-haiku-5.5',
      'google/gemini-3.6-flash-20260721',
      'meta/muse-spark-1.3',
      'deepseek/deepseek-v4-flash',
    ]);
    expect(p.config!.approved).toBe(false);
    expect(p.alternatives.map((a) => [a.openrouterId, a.shortCode])).toEqual([
      ['meta-llama/llama-4-maverick', 'LMA'],
    ]);
    const gpt = p.config!.participants[0]!;
    expect(gpt.monthlyEstimateUsd).toBe(
      monthlyEstimateUsd(
        { pricing: { prompt: '0.00000075', completion: '0.0000045' } },
        arena.llm.estimate,
      ),
    );
    expect(gpt.monthlyCapUsd).toBeCloseTo(gpt.monthlyEstimateUsd * 1.5, 2);
    expect(gpt.displayName).toBe('GPT-5.4 Mini (2026-04-27)');
    const table = rosterTable(p);
    expect(table).toContain('meta (alternative)');
    expect(table).toContain('Estimated total');
    const flagship = proposeRoster(models, rules, 'flagship', arena, new Date());
    expect(flagship.picks.find((x) => x.slot === 'openai')!.chosen!.id).toBe('openai/gpt-5.4');
    expect(flagship.missingSlots).toEqual(['anthropic', 'google']); // the fixture lists no Opus or Gemini Pro
    expect(flagship.config).toBeNull();
  });
  it('reports slots with no match and writes no config', () => {
    const p = proposeRoster([], rules, 'budget', arena, new Date());
    expect(p.config).toBeNull();
    expect(p.missingSlots).toHaveLength(5);
    expect(rosterTable(p)).toContain('no model matched');
    expect(pickForPatterns([], ['x'], rules)).toEqual({ chosen: null, others: [] });
  });
  it('budget cap', () => {
    expect(overBudget(4.25, 4.25)).toBe(true);
    expect(overBudget(4.24, 4.25)).toBe(false);
  });
  it('a zero cap (free model) runs at no cost and stops at the first billed call', () => {
    expect(overBudget(0, 0)).toBe(false);
    expect(overBudget(0.000001, 0)).toBe(true);
  });
});

describe('free tier (SPEC §3.2)', () => {
  // Test values in OpenRouter's model-list shape; free variants are priced "0".
  const m = (id: string, created: number, price = '0') => ({
    id,
    canonical_slug: id.replace(/:free$/, ''),
    name: `Lab: ${id}`,
    created,
    context_length: 131072,
    pricing: { prompt: price, completion: price },
    supported_parameters: ['max_tokens', 'temperature', 'response_format'],
  });
  const models = [
    m('openai/gpt-oss-120b:free', 300),
    m('openai/gpt-oss-120b', 300, '0.0000001'),
    m('openai/gpt-5.4-mini', 400, '0.00000075'),
    m('google/gemma-3-27b-it:free', 200),
    m('google/gemini-2.0-flash-exp:free', 250),
    m('meta-llama/llama-4-maverick:free', 220),
    m('meta-llama/llama-3.3-70b-instruct:free', 120),
    m('deepseek/deepseek-chat-v3.1:free', 260),
    m('deepseek/deepseek-r1-distill-llama-70b:free', 280),
    m('anthropic/claude-haiku-5.5', 500, '0.0000001'),
  ];
  it('picks only :free models, newest per slot, and the lab with no free model sits out', () => {
    const p = proposeRoster(models, rules, 'free', arena, new Date('2026-10-25T00:00:00Z'));
    expect(p.missingSlots).toEqual([]);
    expect(p.notOffered).toEqual(['anthropic']);
    expect(p.config!.participants.map((x) => [x.openrouterId, x.shortCode])).toEqual([
      ['openai/gpt-oss-120b:free', 'GPT'],
      ['google/gemma-3-27b-it:free', 'GEM'], // gemini …-exp is excluded
      ['meta-llama/llama-4-maverick:free', 'LMA'],
      ['deepseek/deepseek-chat-v3.1:free', 'DSK'], // distills are excluded
    ]);
    expect(p.config!.totalMonthlyEstimateUsd).toBe(0);
    expect(p.config!.participants.every((x) => x.monthlyCapUsd === 0)).toBe(true);
    expect(p.alternatives).toEqual([]);
    expect(modelsConfigSchema.safeParse(p.config).success).toBe(true);
    expect(p.callsPerDay).toBe(4 * slotTimes(arena).length);
    const table = rosterTable(p);
    expect(table).toContain('sits out: no free model from this lab');
    expect(table).toContain('$0 a month');
  });
  it('paid tiers never pick a :free variant', () => {
    const p = proposeRoster(models, rules, 'budget', arena, new Date());
    expect(p.picks.find((x) => x.slot === 'openai')!.chosen!.id).toBe('openai/gpt-5.4-mini');
  });
  it('needs at least three free models', () => {
    const p = proposeRoster(models.slice(0, 4), rules, 'free', arena, new Date());
    expect(p.config).toBeNull();
  });
  it('the schema rejects a priced model in a free roster, and a short paid roster', () => {
    const p = proposeRoster(models, rules, 'free', arena, new Date());
    const priced = structuredClone(p.config!);
    priced.participants[0]!.pricing.promptUsdPerToken = '0.0000001';
    expect(modelsConfigSchema.safeParse(priced).success).toBe(false);
    expect(modelsConfigSchema.safeParse({ ...p.config, tier: 'budget' }).success).toBe(false);
  });
  it('accepts a response that names the :free model without its suffix', () => {
    const free = { openrouterId: 'meta-llama/llama-4-maverick:free', canonicalSlug: null };
    expect(isSameModel(free, 'meta-llama/llama-4-maverick:free')).toBe(true);
    expect(isSameModel(free, 'meta-llama/llama-4-maverick')).toBe(true);
    expect(isSameModel(free, 'meta-llama/llama-4-scout')).toBe(false);
    const paid = { openrouterId: 'openai/gpt-5.4-mini', canonicalSlug: null };
    expect(isSameModel(paid, 'openai/gpt-5.4-mini:free')).toBe(false);
  });
});
