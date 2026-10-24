/** A strip of recent rounds for one participant: answered, invalid, missed (SPEC §16.3, §16.4). Text, not colour alone. */
export function StatusStrip({
  items,
  label,
}: {
  items: { key: string; status: string | null; title: string }[];
  label: string;
}) {
  const kind = (s: string | null) =>
    s === 'OK' ? 'answered' : s === 'INVALID_RESPONSE' ? 'invalid' : s === null ? 'none' : 'missed';
  const glyph = { answered: '●', invalid: '◐', missed: '○', none: '·' } as const;
  const cls = {
    answered: 'text-gain',
    invalid: 'text-accent',
    missed: 'text-loss',
    none: 'text-text-2',
  } as const;
  const counts = items.reduce((c, i) => ((c[kind(i.status)] += 1), c), {
    answered: 0,
    invalid: 0,
    missed: 0,
    none: 0,
  });
  return (
    <div>
      <div
        className="flex flex-wrap gap-0.5 text-sm leading-none"
        role="img"
        aria-label={`${label}: ${counts.answered} answered, ${counts.invalid} unreadable, ${counts.missed} missed, out of ${items.length} rounds`}
      >
        {items.map((i) => (
          <span key={i.key} title={i.title} className={cls[kind(i.status)]} aria-hidden>
            {glyph[kind(i.status)]}
          </span>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-2">● answered ◐ unreadable ○ missed</p>
    </div>
  );
}
