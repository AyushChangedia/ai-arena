'use client';
import { useState } from 'react';
import { computeEntryHash, canonicalEntry, type LedgerEntry } from '@arena/shared/ledger-hash';

/** Recomputes the entry's hash in the browser and compares it with the public ledger (SPEC §16.3). */
export function CheckTrade({ entry, expectedHash }: { entry: LedgerEntry; expectedHash: string }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div>
      <button
        type="button"
        className="min-h-11 rounded-[var(--radius-chip)] bg-accent px-4 font-semibold text-bg"
        onClick={async () => {
          const h = await computeEntryHash(entry);
          if (h === expectedHash)
            setResult({ ok: true, text: 'This trade matches the public ledger.' });
          else
            setResult({
              ok: false,
              text: `This trade does not match: the recomputed hash is ${h}, the ledger says ${expectedHash}. Canonical form checked: ${canonicalEntry(entry).length} characters.`,
            });
        }}
      >
        Check this trade
      </button>
      <p
        role="status"
        aria-live="polite"
        className={`mt-2 text-sm ${result ? (result.ok ? 'text-gain' : 'text-loss') : ''}`}
      >
        {result ? `${result.ok ? '✓' : '✗'} ${result.text}` : ''}
      </p>
    </div>
  );
}
