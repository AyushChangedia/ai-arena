import 'server-only';
import { loadHolidays } from './calendar';

/** Holiday dates for this year and next, for the client clock. */
export function holidayDates(now = new Date()): string[] {
  const y = Number(now.toISOString().slice(0, 4));
  return [y, y + 1].flatMap((year) => loadHolidays(year)?.holidays.map((h) => h.date) ?? []);
}
