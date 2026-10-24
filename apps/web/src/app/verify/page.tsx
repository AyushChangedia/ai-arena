import { Suspense } from 'react';
import { cacheLife, cacheTag } from 'next/cache';
import { loadVerify, loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { SOURCE_URL } from '@/lib/config';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { VerifyDay } from '@/components/verify-day';

export const metadata = { title: 'Verify the ledger' };

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Verify />
    </Suspense>
  );
}

async function Verify() {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const [v, a] = await Promise.all([loadVerify(), loadArena()]);
  if (!v.ok || !a.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  return (
    <PageShell
      mode={a.data.mode}
      status={a.data.status}
      holidays={holidays}
      seasonActive={a.data.season?.status === 'active'}
      lastUpdated={a.data.lastUpdated}
    >
      <h1 className="condensed py-6 text-2xl font-bold">Verify the ledger</h1>
      <div className="prose-measure space-y-3">
        <p>
          Every trade, dividend and adjustment is an entry in an append-only ledger. The database
          refuses to change or delete an entry; a correction is a new entry that points at the old
          one.
        </p>
        <p>
          Each entry is written in a fixed text form (keys sorted, no spaces, amounts in paise as
          whole numbers) and hashed with SHA-256. The text includes the previous entry&apos;s hash,
          so changing any entry changes every hash after it.
        </p>
        <p>
          After each trading day the engine commits that day&apos;s entries and the last hash (the
          anchor) to the public git repository. Git records when each anchor was committed, so
          rewriting the ledger would mean rewriting public git history.
        </p>
      </div>
      <section aria-labelledby="head" className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="head" className="condensed text-lg font-semibold">
          Current head
        </h2>
        {v.data.head ? (
          <p className="mt-1 break-all text-sm tabular-nums">
            Entry #{v.data.head.seq}: {v.data.head.hash}
          </p>
        ) : (
          <p className="mt-1 text-sm text-text-2">No entries are public yet.</p>
        )}
      </section>
      <section aria-labelledby="day" className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="day" className="condensed mb-2 text-lg font-semibold">
          Check a day in your browser
        </h2>
        <VerifyDay
          anchors={v.data.anchors.map((x) => ({
            date: x.date,
            headHash: x.headHash,
            firstSeq: x.firstSeq,
            lastSeq: x.lastSeq,
            entries: x.entries,
          }))}
        />
      </section>
      <section
        aria-labelledby="anchors"
        className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
      >
        <h2 id="anchors" className="condensed mb-2 text-lg font-semibold">
          Daily anchors
        </h2>
        {v.data.anchors.length ? (
          <div
            className="relative overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <caption className="sr-only">Daily ledger anchors with their git commits</caption>
              <thead>
                <tr className="border-b border-line text-text-2">
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Day
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-normal">
                    Entries
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Head hash
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Commit
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.data.anchors.map((x) => (
                  <tr key={x.date} className="border-b border-line">
                    <td className="num px-2 py-1">{x.date}</td>
                    <td className="num px-2 py-1 text-right">{x.entries}</td>
                    <td className="tabular-nums px-2 py-1 break-all">{x.headHash.slice(0, 16)}…</td>
                    <td className="px-2 py-1">
                      {x.commitSha ? (
                        <a
                          className="link num inline-flex min-h-11 items-center"
                          href={`${SOURCE_URL}/commit/${x.commitSha}`}
                        >
                          {x.commitSha.slice(0, 7)}
                        </a>
                      ) : (
                        <span
                          className="text-text-2"
                          title="The commit is recorded after the end-of-day job pushes it"
                        >
                          Pending
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-text-2">No anchors yet.</p>
        )}
      </section>
      <section aria-labelledby="cli" className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="cli" className="condensed mb-2 text-lg font-semibold">
          Check it yourself
        </h2>
        <p className="prose-measure text-sm">
          Download a day&apos;s ledger above (or from the repository&apos;s public-data folder),
          then run:
        </p>
        <pre
          tabIndex={0}
          className="mt-2 overflow-x-auto rounded bg-bg p-3 text-sm"
        >{`git clone ${SOURCE_URL}
cd ai-arena && pnpm install
pnpm verify-ledger --file ledger-YYYY-MM-DD.jsonl`}</pre>
      </section>
    </PageShell>
  );
}
