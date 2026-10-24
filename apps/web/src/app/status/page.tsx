import { Suspense } from 'react';
import { cacheLife, cacheTag } from 'next/cache';
import { formatDateTimeIst, formatTradingDate } from '@arena/shared/format';
import { loadStatus } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { loadHolidays } from '@/lib/calendar';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable, pausedMessage } from '@/components/banners';
import { StatusStrip } from '@/components/status-strip';
import { Chip } from '@/components/chip';

export const metadata = { title: 'Status' };

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Status />
    </Suspense>
  );
}

const when = (d: Date | null) => (d ? formatDateTimeIst(d) : '—');

async function Status() {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const r = await loadStatus();
  if (!r.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  const { arena: a, incidents, admin, strips, flags } = r.data;
  const st = a.status;
  const year = new Date().getUTCFullYear();
  const cal = [loadHolidays(year), loadHolidays(year + 1)];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = cal
    .flatMap((c) => c?.holidays ?? [])
    .filter((h) => h.date >= today)
    .slice(0, 6);
  const open = incidents.filter((i) => !i.resolvedAt);
  const resolved = incidents.filter((i) => i.resolvedAt);
  return (
    <PageShell
      mode={a.mode}
      status={st}
      holidays={holidays}
      seasonActive={a.season?.status === 'active'}
      lastUpdated={a.lastUpdated}
    >
      <h1 className="condensed py-6 text-2xl font-bold">Status</h1>
      <section aria-labelledby="state" className="rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="state" className="condensed mb-2 text-lg font-semibold">
          Arena
        </h2>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-2">State</dt>
            <dd>{st?.paused ? pausedMessage(st.pausedReason) : 'Running'}</dd>
          </div>
          <div>
            <dt className="text-text-2">Last completed round</dt>
            <dd className="num">{when(st?.lastCompletedRoundAt ?? null)}</dd>
          </div>
          <div>
            <dt className="text-text-2">Data feed</dt>
            <dd>
              {st?.lastSnapshotStatus
                ? `${st.lastSnapshotStatus === 'ok' ? 'Working' : `Last snapshot rejected (${st.lastSnapshotRejectReason?.split(':')[0] ?? 'unknown'})`}, ${when(st.lastSnapshotAt)}`
                : 'No snapshots yet'}
            </dd>
          </div>
          <div>
            <dt className="text-text-2">Engine heartbeat</dt>
            <dd className="num">
              {st?.lastHeartbeatAt
                ? `${when(st.lastHeartbeatAt)} (${st.lastHeartbeatOutcome})`
                : 'No heartbeat yet'}
            </dd>
          </div>
          <div>
            <dt className="text-text-2">Season</dt>
            <dd>
              {a.season
                ? `${a.season.name}: ${formatTradingDate(a.season.startsOn)} to ${a.season.endsOn ? formatTradingDate(a.season.endsOn) : '—'} (${a.season.status})`
                : 'Not scheduled'}
            </dd>
          </div>
        </dl>
      </section>
      {a.participants.length && strips.length ? (
        <section
          aria-labelledby="strips"
          className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
        >
          <h2 id="strips" className="condensed mb-2 text-lg font-semibold">
            Last {strips.length} rounds
          </h2>
          <ul className="space-y-3">
            {a.participants
              .filter((p) => p.kind === 'model')
              .map((p) => (
                <li key={p.id} className="flex items-start gap-3">
                  <Chip p={p} size="sm" />
                  <StatusStrip
                    label={`${p.displayName}, last ${strips.length} rounds`}
                    items={strips.map((s) => ({
                      key: s.roundId,
                      status: s.byParticipant[p.id] ?? null,
                      title: `${s.tradingDate} ${s.slotTime}: ${s.byParticipant[p.id] ?? s.roundStatus.toLowerCase()}`,
                    }))}
                  />
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="inc" className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="inc" className="condensed mb-2 text-lg font-semibold">
          Incidents
        </h2>
        {open.length === 0 ? <p className="text-sm text-text-2">No open incidents.</p> : null}
        <ul className="divide-y divide-line text-sm">
          {[...open, ...resolved.slice(0, 20)].map((i) => (
            <li key={i.id} className="py-2">
              <p
                className={
                  i.resolvedAt
                    ? 'text-text-2'
                    : i.severity === 'critical'
                      ? 'text-loss'
                      : 'text-accent'
                }
              >
                {i.resolvedAt ? 'Resolved' : i.severity === 'critical' ? 'Open, critical' : 'Open'}:{' '}
                {i.publicMessage}
              </p>
              <p className="text-xs text-text-2 tabular-nums">
                Since {when(i.startedAt)}
                {i.resolvedAt ? `, resolved ${when(i.resolvedAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {flags.length ? (
        <section
          aria-labelledby="flags"
          className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
        >
          <h2 id="flags" className="condensed mb-2 text-lg font-semibold">
            Stocks under review
          </h2>
          <ul className="text-sm">
            {flags.map((f) => (
              <li key={f.symbol}>
                {f.symbol}: {f.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section
        aria-labelledby="admin"
        className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
      >
        <h2 id="admin" className="condensed mb-2 text-lg font-semibold">
          Admin actions
        </h2>
        {admin.length ? (
          <ul className="divide-y divide-line text-sm">
            {admin.map((x, i) => (
              <li key={i} className="py-2">
                <span className="font-medium">{x.command}</span> by {x.actor}: {x.reason}
                <span className="num block text-xs text-text-2">{when(x.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-2">None yet.</p>
        )}
      </section>
      <section aria-labelledby="hol" className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="hol" className="condensed mb-2 text-lg font-semibold">
          Upcoming market holidays
        </h2>
        {cal[0] === null ? (
          <p className="text-sm text-text-2">The {year} NSE holiday list has not been loaded.</p>
        ) : null}
        <ul className="text-sm">
          {upcoming.map((h) => (
            <li key={h.date} className="tabular-nums">
              {formatTradingDate(h.date)}: {h.description}
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
