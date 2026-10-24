'use client';
import { useId, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';

/** Accessible tabs (WAI-ARIA tabs pattern with arrow-key navigation). */
export function Tabs({
  tabs,
  label,
}: {
  tabs: { id: string; label: string; content: ReactNode }[];
  label: string;
}) {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const n = tabs.length;
    let i: number;
    if (e.key === 'ArrowRight') i = (active + 1) % n;
    else if (e.key === 'ArrowLeft') i = (active - 1 + n) % n;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else return;
    e.preventDefault();
    setActive(i);
    refs.current[i]?.focus();
  };
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 border-b border-line"
        onKeyDown={onKey}
      >
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === active}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`min-h-11 px-3 text-sm ${i === active ? 'border-b-2 border-accent text-text' : 'text-text-2'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={i !== active}
          tabIndex={0}
          className="pt-3"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
