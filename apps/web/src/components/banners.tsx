import { formatTimeIst, formatDateIst } from '@arena/shared/format';

export function ShadowBanner() {
  return (
    <div role="note" className="border-b border-line bg-surface-2 px-4 py-2 text-sm text-text">
      Private preview. These rounds are a test run and will be reset before Season 1.
    </div>
  );
}

export function PausedBanner({ message, since }: { message: string; since: Date | null }) {
  return (
    <div
      role="status"
      className="mx-4 mt-4 rounded-[var(--radius-panel)] border-2 border-accent px-4 py-3 lg:mx-auto lg:max-w-[1200px]"
    >
      <p className="font-semibold">{message}</p>
      {since ? (
        <p className="text-sm text-text-2">
          Holdings haven&apos;t changed since{' '}
          <time dateTime={since.toISOString()}>
            {formatDateIst(since)}, {formatTimeIst(since)}
          </time>
          .
        </p>
      ) : null}
    </div>
  );
}

export function Unreachable() {
  return (
    <div
      role="alert"
      className="mx-4 my-8 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-6 lg:mx-auto lg:max-w-[1200px]"
    >
      <p className="text-lg font-semibold">
        The arena&apos;s records aren&apos;t reachable right now. Try again in a few minutes.
      </p>
    </div>
  );
}

/** Plain-words message for why the arena is paused, from arena_state.paused_reason. */
export function pausedMessage(reason: string | null): string {
  switch (reason) {
    case 'credits_exhausted':
      return 'Rounds are paused: the arena is out of API credit.';
    case 'reconciliation_mismatch':
      return 'Numbers under review. Rounds are paused until this is resolved.';
    case 'llm_auth':
      return 'Rounds are paused: the arena cannot reach its AI models.';
    default:
      return 'Rounds are paused.';
  }
}
