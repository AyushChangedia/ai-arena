import { DateTime } from 'luxon';
import type { ArenaConfig } from '@arena/shared/schemas';
import type { TradingCalendar } from '../data/calendar';

export const IST = 'Asia/Kolkata';

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const toHhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Slot times from arena.json (default 09:30 … 15:00 every 30 minutes). */
export function slotTimes(arena: ArenaConfig): string[] {
  const out: string[] = [];
  for (
    let m = toMin(arena.schedule.firstSlot);
    m <= toMin(arena.schedule.lastSlot);
    m += arena.schedule.everyMinutes
  )
    out.push(toHhmm(m));
  return out;
}

export function istNow(now: Date): DateTime {
  return DateTime.fromJSDate(now, { zone: IST });
}

export function slotInstant(tradingDate: string, slot: string): Date {
  return DateTime.fromISO(`${tradingDate}T${slot}:00`, { zone: IST }).toJSDate();
}

export function minutesOfDay(now: Date): number {
  const d = istNow(now);
  return d.hour * 60 + d.minute;
}

export function isBetween(now: Date, from: string, to: string): boolean {
  const m = minutesOfDay(now);
  return m >= toMin(from) && m < toMin(to);
}

export function isAfter(now: Date, hhmm: string): boolean {
  return minutesOfDay(now) >= toMin(hhmm);
}

/** The slot that is due now: scheduled ≤ now < scheduled + grace (SPEC §12.2). */
export function dueSlot(arena: ArenaConfig, tradingDate: string, now: Date): string | null {
  for (const s of slotTimes(arena)) {
    const t = slotInstant(tradingDate, s).getTime();
    if (now.getTime() >= t && now.getTime() < t + arena.schedule.graceMinutes * 60_000) return s;
  }
  return null;
}

/** Slots whose grace window has fully passed. */
export function expiredSlots(arena: ArenaConfig, tradingDate: string, now: Date): string[] {
  return slotTimes(arena).filter(
    (s) =>
      now.getTime() >= slotInstant(tradingDate, s).getTime() + arena.schedule.graceMinutes * 60_000,
  );
}

/** "12:00 IST", or "Monday 2026-11-09 09:30 IST" after the last slot, or "none (the season ends today)". */
export function nextRoundText(
  arena: ArenaConfig,
  cal: TradingCalendar,
  tradingDate: string,
  slot: string,
  seasonLastDay: string | null,
): string {
  const slots = slotTimes(arena);
  const i = slots.indexOf(slot);
  if (i >= 0 && i < slots.length - 1) return `${slots[i + 1]} IST`;
  if (seasonLastDay && tradingDate >= seasonLastDay) return 'none (the season ends today)';
  const next = cal.nextTradingDay(tradingDate);
  const d = DateTime.fromISO(next, { zone: IST });
  return `${d.toFormat('cccc')} ${next} ${slots[0]} IST`;
}

export function weekdayName(tradingDate: string): string {
  return DateTime.fromISO(tradingDate, { zone: IST }).toFormat('cccc');
}
