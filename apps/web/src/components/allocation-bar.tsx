import { formatPct } from '@arena/shared/format';

/** Allocation as a single stacked horizontal bar (not a donut), with a text legend (SPEC §16.3). */
export function AllocationBar({
  parts,
  color,
}: {
  parts: { label: string; valuePaise: bigint }[];
  color: string;
}) {
  const total = parts.reduce((s, p) => s + p.valuePaise, 0n);
  if (total <= 0n) return null;
  const shares = parts.map((p) => ({ ...p, frac: Number(p.valuePaise) / Number(total) }));
  return (
    <figure className="m-0">
      <div
        className="flex h-4 w-full overflow-hidden rounded-[var(--radius-chip)] bg-surface-2"
        role="img"
        aria-label={`Allocation: ${shares.map((s) => `${s.label} ${formatPct(s.frac, { arrow: false }).replace('+', '')}`).join(', ')}`}
      >
        {shares.map((s, i) => (
          <div
            key={s.label}
            style={{
              width: `${s.frac * 100}%`,
              background: s.label === 'Cash' ? 'var(--line)' : color,
              opacity: s.label === 'Cash' ? 1 : 1 - (i % 4) * 0.18,
            }}
            className="h-full border-r border-bg last:border-r-0"
          />
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2">
        {shares.map((s) => (
          <span key={s.label} className="num">
            {s.label} {(s.frac * 100).toFixed(1)}%
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
