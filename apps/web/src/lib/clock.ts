/** Client-side schedule maths in IST from config (no database). */
export interface ClockInput {
  slots: string[];
  holidays: string[];
}

const IST_OFFSET_MIN = 330;

export function istParts(now: Date): { date: string; minutes: number; weekday: number } {
  const t = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const date = t.toISOString().slice(0, 10);
  return { date, minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function isTradingDay(date: string, holidays: string[]): boolean {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.includes(date);
}

export function marketOpen(now: Date, holidays: string[]): boolean {
  const p = istParts(now);
  return isTradingDay(p.date, holidays) && p.minutes >= 9 * 60 + 15 && p.minutes <= 15 * 60 + 30;
}

/** The next slot after `now`, as a Date, looking up to 14 days ahead. */
export function nextSlot(
  now: Date,
  c: ClockInput,
): { at: Date; slot: string; date: string } | null {
  const p = istParts(now);
  for (let d = 0; d < 14; d++) {
    const day = new Date(`${p.date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + d);
    const date = day.toISOString().slice(0, 10);
    if (!isTradingDay(date, c.holidays)) continue;
    for (const s of c.slots) {
      if (d === 0 && toMin(s) <= p.minutes) continue;
      return { at: new Date(`${date}T${s}:00+05:30`), slot: s, date };
    }
  }
  return null;
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} min`;
  return `${m} min`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function slotLabel(next: { date: string; slot: string }, now: Date): string {
  const today = istParts(now).date;
  const time = `${String(Number(next.slot.slice(0, 2)))}:${next.slot.slice(3)} IST`;
  if (next.date === today) return time;
  return `${WEEKDAYS[new Date(`${next.date}T12:00:00Z`).getUTCDay()]} ${time}`;
}
