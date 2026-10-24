'use client';
import { useState } from 'react';

/** "Share standings": Web Share API on mobile, copies the link elsewhere (SPEC §16.9). */
export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="min-h-11 rounded-[var(--radius-chip)] border border-line px-3 text-sm"
      onClick={async () => {
        const url = window.location.href;
        try {
          if (navigator.share) await navigator.share({ title, url });
          else {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        } catch {
          // The viewer cancelled the share sheet: nothing to do.
          setCopied(false);
        }
      }}
    >
      {copied ? 'Link copied' : 'Share standings'}
    </button>
  );
}
