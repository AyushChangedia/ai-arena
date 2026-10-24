import pino, { type Logger, type DestinationStream } from 'pino';
import { SECRET_ENV_VARS } from '@arena/shared/schemas';

/** Keys whose values are always redacted (SPEC §2.3.2). */
export const REDACT_KEY_RE = /(key|secret|token|password|pin|totp|authorization|cookie)/i;
export const REDACTED = '[redacted]';

/** Literal secret values to scrub from every string, collected from the environment. */
export function secretValuesFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const vals: string[] = [];
  for (const name of SECRET_ENV_VARS) {
    const v = env[name];
    if (v && v.trim().length >= 4) vals.push(v.trim());
  }
  // Longest first so that a secret containing another is replaced whole.
  return vals.sort((a, b) => b.length - a.length);
}

export function scrubString(s: string, secrets: string[]): string {
  let out = s;
  for (const v of secrets) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

/** Deep copy with secret-looking keys and literal secret values redacted. */
export function redact(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 12) return '[depth]';
  if (typeof value === 'string') return scrubString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message, secrets),
      stack: value.stack ? scrubString(value.stack, secrets) : undefined,
      kind: (value as { kind?: unknown }).kind,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY_RE.test(k) ? REDACTED : redact(v, secrets, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  tickId?: string;
  secrets?: string[];
  destination?: DestinationStream;
  level?: string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const secrets = opts.secrets ?? secretValuesFromEnv();
  const base = opts.tickId ? { tick_id: opts.tickId } : {};
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      base,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (obj) => redact(obj, secrets) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? scrubString(a, secrets) : a));
          return method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
    },
    opts.destination,
  );
}
