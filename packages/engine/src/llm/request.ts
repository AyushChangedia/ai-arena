import type { ArenaConfig, ModelEntry } from '@arena/shared/schemas';
import type { ChatMessage } from './openrouter';

/** Provider-safe JSON schema: types, enums, required, additionalProperties false. Lengths are checked by us. */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    strategy: { type: 'string' },
    reasoning: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          side: { type: 'string', enum: ['BUY', 'SELL'] },
          symbol: { type: 'string' },
          quantity: { type: 'integer' },
          why: { type: 'string' },
          exit_plan: { type: 'string' },
        },
        required: ['side', 'symbol', 'quantity', 'why', 'exit_plan'],
        additionalProperties: false,
      },
    },
    note_to_self: { type: 'string' },
  },
  required: ['strategy', 'reasoning', 'actions', 'note_to_self'],
  additionalProperties: false,
} as const;

export function supports(entry: Pick<ModelEntry, 'supportedParameters'>, param: string): boolean {
  return entry.supportedParameters.includes(param);
}

/**
 * The chat request (SPEC §9.1). Only parameters the model lists in supported_parameters are sent,
 * with the same values for every participant.
 */
export function buildChatRequest(
  entry: ModelEntry,
  messages: ChatMessage[],
  llm: ArenaConfig['llm'],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: entry.openrouterId,
    messages,
    provider: { require_parameters: true },
    usage: { include: true },
  };
  if (supports(entry, 'max_tokens')) body.max_tokens = llm.maxTokens;
  if (supports(entry, 'temperature')) body.temperature = llm.temperature;
  if (supports(entry, 'reasoning')) body.reasoning = { effort: llm.reasoningEffort };
  if (supports(entry, 'structured_outputs') && supports(entry, 'response_format')) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'trading_decision', strict: true, schema: DECISION_JSON_SCHEMA },
    };
  }
  return body;
}

/** The serving model must equal the configured ID or its documented canonical (dated) slug (SPEC §9.6). */
export function isSameModel(
  entry: Pick<ModelEntry, 'openrouterId' | 'canonicalSlug'>,
  serving: string,
): boolean {
  // A `:free` variant is the same model on a free route; responses may name it without the suffix.
  const base = entry.openrouterId.endsWith(':free') ? entry.openrouterId.slice(0, -5) : null;
  return (
    serving === entry.openrouterId ||
    (base !== null && serving === base) ||
    (entry.canonicalSlug !== null && serving === entry.canonicalSlug)
  );
}

export const REPAIR_PROMPT = (err: string) =>
  `Your reply couldn't be read: ${err}. Reply again with only the JSON object described in the rules.`;
