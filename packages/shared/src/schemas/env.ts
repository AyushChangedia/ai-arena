import { z } from 'zod';

/** Every environment variable from SPEC §7.1, with how to get it. */
export const ENV_VARS = {
  DATABASE_URL_OWNER: {
    usedBy: 'migrate.yml only',
    required: 'migrate',
    how: 'Neon → your project → Connection details → owner role connection string. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  DATABASE_URL: {
    usedBy: 'engine',
    required: 'engine',
    how: 'Neon connection string for role engine_rw (created by migrate.yml; set its password in Neon → Roles). Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  DATABASE_URL_READONLY: {
    usedBy: 'web',
    required: 'web',
    how: 'Neon connection string for role web_ro. Add it in Vercel → Project → Settings → Environment Variables.',
  },
  OPENROUTER_API_KEY: {
    usedBy: 'engine',
    required: 'engine',
    how: 'openrouter.ai → Keys → Create key (set a credit limit). Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  ANGEL_API_KEY: {
    usedBy: 'engine',
    required: 'engine',
    how: 'smartapi.angelone.in → My apps → Create app (market data). Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  ANGEL_CLIENT_CODE: {
    usedBy: 'engine',
    required: 'engine',
    how: 'Your Angel One client ID. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  ANGEL_MPIN: {
    usedBy: 'engine',
    required: 'engine',
    how: 'Your Angel One MPIN (not the web password). Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  ANGEL_TOTP_SECRET: {
    usedBy: 'engine',
    required: 'engine',
    how: 'The base32 secret shown when you enable TOTP for SmartAPI. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  WEB_BASE_URL: {
    usedBy: 'engine',
    required: 'optional',
    how: 'Your Vercel production URL, e.g. https://ai-arena.vercel.app. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  REVALIDATE_SECRET: {
    usedBy: 'engine + web',
    required: 'optional',
    how: 'A random string of 32+ characters. Add the same value in GitHub Actions secrets and in Vercel environment variables.',
  },
  TELEGRAM_BOT_TOKEN: {
    usedBy: 'engine',
    required: 'optional',
    how: 'Telegram → @BotFather → /newbot. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  TELEGRAM_CHAT_ID: {
    usedBy: 'engine',
    required: 'optional',
    how: 'Message your bot, then open https://api.telegram.org/bot<token>/getUpdates and read chat.id. Add it as a GitHub secret.',
  },
  HEALTHCHECKS_PING_URL: {
    usedBy: 'engine',
    required: 'optional',
    how: 'healthchecks.io → your check → ping URL. Add it in GitHub → Settings → Secrets and variables → Actions.',
  },
  ARENA_MODE: {
    usedBy: 'engine + web',
    required: 'engine',
    how: 'shadow or live. Set it in the workflow env (GitHub variable ARENA_MODE) and in Vercel.',
  },
} as const;
export type EnvVarName = keyof typeof ENV_VARS;

/** Names whose literal values the logger always redacts. */
export const SECRET_ENV_VARS: EnvVarName[] = [
  'DATABASE_URL_OWNER',
  'DATABASE_URL',
  'DATABASE_URL_READONLY',
  'OPENROUTER_API_KEY',
  'ANGEL_API_KEY',
  'ANGEL_CLIENT_CODE',
  'ANGEL_MPIN',
  'ANGEL_TOTP_SECRET',
  'REVALIDATE_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'HEALTHCHECKS_PING_URL',
];

const nonEmpty = z.string().trim().min(1);
const pgUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://');

export const envSchema = z.object({
  DATABASE_URL_OWNER: pgUrl.optional(),
  DATABASE_URL: pgUrl.optional(),
  DATABASE_URL_READONLY: pgUrl.optional(),
  OPENROUTER_API_KEY: nonEmpty.optional(),
  ANGEL_API_KEY: nonEmpty.optional(),
  ANGEL_CLIENT_CODE: nonEmpty.optional(),
  ANGEL_MPIN: z
    .string()
    .regex(/^\d{4,6}$/, 'must be a 4–6 digit MPIN')
    .optional(),
  ANGEL_TOTP_SECRET: z
    .string()
    .trim()
    .regex(/^[A-Z2-7]+=*$/i, 'must be a base32 secret')
    .optional(),
  WEB_BASE_URL: z.string().url().optional(),
  REVALIDATE_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  TELEGRAM_BOT_TOKEN: nonEmpty.optional(),
  TELEGRAM_CHAT_ID: nonEmpty.optional(),
  HEALTHCHECKS_PING_URL: z.string().url().optional(),
  ARENA_MODE: z.enum(['shadow', 'live']).optional(),
});
export type Env = z.infer<typeof envSchema>;

/** Treat empty strings (unset GitHub secrets expand to "") as missing. */
export function cleanEnv(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of Object.keys(ENV_VARS)) {
    const v = raw[k];
    out[k] = v === undefined || v.trim() === '' ? undefined : v;
  }
  return out;
}
