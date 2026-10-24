import { arena } from './config';

/** Slot times from arena.json. */
export function slotTimes(): string[] {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const out: string[] = [];
  for (
    let m = toMin(arena.schedule.firstSlot);
    m <= toMin(arena.schedule.lastSlot);
    m += arena.schedule.everyMinutes
  ) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

export function roundNumber(slot: string): number {
  return slotTimes().indexOf(slot) + 1;
}
