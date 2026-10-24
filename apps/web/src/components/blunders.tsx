import Link from 'next/link';
import type { Blunder, Participant } from '@arena/db/read';
import { blunderText } from '@/lib/view';
import { Chip } from './chip';

export function Blunders({
  items,
  participants,
}: {
  items: Blunder[];
  participants: Participant[];
}) {
  if (!items.length) return <p className="text-sm text-text-2">No rejected actions yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((b) => {
        const p = participants.find((x) => x.id === b.participantId);
        return (
          <li key={b.id} className="flex items-start gap-3 py-2 text-sm">
            {p ? <Chip p={p} size="sm" /> : null}
            <span className="flex-1">
              <span className="block">{blunderText(b)}</span>
              <Link href={`/rounds/${b.roundId}`} className="link num text-xs text-text-2">
                {b.tradingDate} {b.slotTime} IST
              </Link>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
