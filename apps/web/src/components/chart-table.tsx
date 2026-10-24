import type { MarkRow, Participant } from '@arena/db/read';
import { formatInr, formatTradingDate } from '@arena/shared/format';
import { istDate } from '@/lib/view';

/** "View as table": day-end values for every participant (the chart's equivalent, SPEC §16.7). */
export function ChartTable({
  id,
  marks,
  participants,
}: {
  id: string;
  marks: MarkRow[];
  participants: Participant[];
}) {
  const days = [...new Set(marks.map((m) => istDate(m.markedAt)))].sort();
  const valueAt = (pid: string, day: string) =>
    marks.filter((m) => m.participantId === pid && istDate(m.markedAt) === day).at(-1)
      ?.totalPaise ?? null;
  return (
    <details id={id} className="mt-4 rounded-[var(--radius-panel)] border border-line">
      <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm">
        Portfolio values by day (table)
      </summary>
      <div
        className="relative overflow-x-auto px-3 pb-3"
        tabIndex={0}
        role="region"
        aria-label="Scrollable table"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Latest portfolio value on each day, per participant</caption>
          <thead>
            <tr className="border-b border-line text-text-2">
              <th scope="col" className="px-2 py-1 text-left font-normal">
                Day
              </th>
              {participants.map((p) => (
                <th key={p.id} scope="col" className="px-2 py-1 text-right font-normal">
                  {p.shortCode}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d} className="border-b border-line">
                <th scope="row" className="num px-2 py-1 text-left font-normal">
                  {formatTradingDate(d)}
                </th>
                {participants.map((p) => {
                  const v = valueAt(p.id, d);
                  return (
                    <td key={p.id} className="num px-2 py-1 text-right">
                      {v === null ? (
                        <span title="No mark that day">—</span>
                      ) : (
                        formatInr(v, { decimals: 0 })
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
