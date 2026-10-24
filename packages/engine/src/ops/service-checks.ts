import type { ServiceCheck } from './doctor';

/** Live-service checks for `pnpm doctor` (SPEC §7.3). Probes are filled in as each phase lands. */
export function serviceChecks(): ServiceCheck[] {
  return [
    { name: 'database connection + migrations', required: true, needs: ['DATABASE_URL'] },
    {
      name: 'Angel One login',
      required: true,
      needs: ['ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_MPIN', 'ANGEL_TOTP_SECRET'],
    },
    { name: 'OpenRouter key + credit', required: true, needs: ['OPENROUTER_API_KEY'] },
    { name: 'OpenRouter model IDs + parameters', required: true, needs: ['OPENROUTER_API_KEY'] },
    { name: 'Telegram', required: false, needs: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
    { name: 'Healthchecks', required: false, needs: ['HEALTHCHECKS_PING_URL'] },
    {
      name: 'revalidation endpoint',
      required: false,
      needs: ['WEB_BASE_URL', 'REVALIDATE_SECRET'],
    },
  ];
}
