'use client';
import { useState } from 'react';
import { verifyChain, type LedgerEntry } from '@arena/shared/ledger-hash';

/** Downloads a day's ledger.jsonl and checks the hash chain in the browser against the day's anchor (SPEC §16.3). */
export function VerifyDay({
  anchors,
}: {
  anchors: { date: string; headHash: string; firstSeq: string; lastSeq: string; entries: number }[];
}) {
  const [date, setDate] = useState(anchors[0]?.date ?? '');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!anchors.length)
    return (
      <p className="text-sm text-text-2">
        No day has been anchored yet. The first anchor appears after the first trading day ends.
      </p>
    );
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const anchor = anchors.find((a) => a.date === date)!;
      const res = await fetch(`/api/ledger/${date}`);
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      const entries = (await res.text())
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as LedgerEntry);
      const r = await verifyChain(entries, entries[0]?.prev_hash);
      const head = entries.at(-1)?.hash;
      if (!r.ok)
        setResult({
          ok: false,
          text: `The chain does not verify: ${r.problems.map((p) => `entry ${p.seq}: ${p.kind.replace(/_/g, ' ')}`).join('; ')}.`,
        });
      else if (head !== anchor.headHash)
        setResult({
          ok: false,
          text: `The chain verifies, but its last hash ${head} differs from the anchor ${anchor.headHash}.`,
        });
      else
        setResult({
          ok: true,
          text: `All ${entries.length} entries for ${date} verify, and the last hash matches the day's anchor.`,
        });
    } catch (e) {
      setResult({ ok: false, text: `Could not check: ${(e as Error).message}.` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-text-2">Day</span>
          <select
            className="min-h-11 rounded-[var(--radius-chip)] border border-line bg-surface-2 px-2"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          >
            {anchors.map((a) => (
              <option key={a.date} value={a.date}>
                {a.date}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={check}
          className="min-h-11 rounded-[var(--radius-chip)] bg-accent px-4 font-semibold text-bg disabled:opacity-60"
        >
          Check a whole day
        </button>
        <a
          className="link inline-flex min-h-11 items-center text-sm"
          href={`/api/ledger/${date}`}
          download={`ledger-${date}.jsonl`}
        >
          Download this day&apos;s ledger
        </a>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`text-sm ${result ? (result.ok ? 'text-gain' : 'text-loss') : ''}`}
      >
        {busy ? 'Checking…' : result ? `${result.ok ? '✓' : '✗'} ${result.text}` : ''}
      </p>
    </div>
  );
}
