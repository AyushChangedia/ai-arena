import { formatInr, formatInrCompact, formatPct, formatPts, direction } from '@arena/shared/format';

/** A value that couldn't be sourced: "—" with the reason as a tooltip (SPEC §2.1.2). Never 0. */
export function Missing({ reason }: { reason: string }) {
  return (
    <span className="num text-text-2" title={reason} aria-label={`Not available: ${reason}`}>
      —
    </span>
  );
}

export function Money({
  paise,
  compact = false,
  decimals = 2,
  missing,
}: {
  paise: bigint | null | undefined;
  compact?: boolean;
  decimals?: 0 | 2;
  missing?: string;
}) {
  if (paise === null || paise === undefined) return <Missing reason={missing ?? 'No value yet'} />;
  return (
    <span className="num">
      {compact ? formatInrCompact(paise) : formatInr(paise, { decimals })}
    </span>
  );
}

/** Signed percentage, coloured, always with ▲/▼ and a sign so colour is never the only cue (SPEC §16.1). */
export function Pct({
  frac,
  missing,
  arrow = true,
}: {
  frac: number | null | undefined;
  missing?: string;
  arrow?: boolean;
}) {
  if (frac === null || frac === undefined || !Number.isFinite(frac))
    return <Missing reason={missing ?? 'No value yet'} />;
  const dir = direction(frac);
  const cls = dir === 'gain' ? 'text-gain' : dir === 'loss' ? 'text-loss' : 'text-text-2';
  return <span className={`num ${cls}`}>{formatPct(frac, { arrow })}</span>;
}

export function Pts({ diff, missing }: { diff: number | null | undefined; missing?: string }) {
  if (diff === null || diff === undefined) return <Missing reason={missing ?? 'No value yet'} />;
  const dir = direction(diff);
  return (
    <span
      className={`num ${dir === 'gain' ? 'text-gain' : dir === 'loss' ? 'text-loss' : 'text-text-2'}`}
    >
      {formatPts(diff)}
    </span>
  );
}

export function Ratio({ value, missing }: { value: number | null | undefined; missing?: string }) {
  if (value === null || value === undefined) return <Missing reason={missing ?? 'No value yet'} />;
  return <span className="num">{(value * 100).toFixed(1)}%</span>;
}
