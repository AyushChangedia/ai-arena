import type { Participant } from '@arena/db/read';

/** Identity chip: jersey colour plus the short code (colour is never the only identifier). */
export function Chip({
  p,
  size = 'md',
}: {
  p: Pick<Participant, 'shortCode' | 'color' | 'kind' | 'displayName'>;
  size?: 'sm' | 'md';
}) {
  const quiet = p.kind !== 'model';
  return (
    <span
      className={`condensed inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] border font-semibold tracking-wide ${size === 'sm' ? 'px-1.5 text-xs' : 'px-2 py-0.5 text-sm'} ${quiet ? 'border-line text-text-2' : 'border-transparent text-bg'}`}
      style={quiet ? undefined : { background: p.color }}
      title={p.displayName}
    >
      {quiet ? (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: p.color }}
        />
      ) : null}
      {p.shortCode}
    </span>
  );
}
