'use client';
import { useEffect, useState } from 'react';
import { countdown } from '@/lib/clock';

export function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="num">
      {now === null ? ' ' : `Starts in ${countdown(new Date(to).getTime() - now)}`}
    </span>
  );
}
