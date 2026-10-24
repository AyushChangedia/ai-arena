import { DateTime } from 'luxon';
import type { MarketCalendar } from '@arena/shared/schemas';
import { ConfigError } from '@arena/shared/errors';
import { loadCalendar } from '../config/load';

export const IST = 'Asia/Kolkata';

/** Trading-day logic from config/calendar/nse-<year>.json (SPEC §8.6). Weekends are closed. */
export class TradingCalendar {
  private readonly holidays = new Map<string, string>();
  private readonly years = new Set<number>();

  constructor(calendars: MarketCalendar[]) {
    for (const c of calendars) {
      this.years.add(c.year);
      for (const h of c.holidays) this.holidays.set(h.date, h.description);
    }
  }

  static fromConfig(years: number[], dir?: string): TradingCalendar {
    const cals: MarketCalendar[] = [];
    for (const y of years) {
      const r = loadCalendar(y, dir);
      if (r.ok) cals.push(r.value);
      else if (!r.missing) throw new ConfigError(r.error, r.fix);
    }
    return new TradingCalendar(cals);
  }

  hasYear(year: number): boolean {
    return this.years.has(year);
  }

  /** Throws when the year's holiday list is missing: never guess whether the market is open. */
  isTradingDay(isoDate: string): boolean {
    const d = DateTime.fromISO(isoDate, { zone: IST });
    if (!d.isValid) throw new RangeError(`bad date ${isoDate}`);
    if (!this.years.has(d.year)) {
      throw new ConfigError(
        `No NSE holiday list for ${d.year}.`,
        `Add config/calendar/nse-${d.year}.json (see SETUP.md: holiday list).`,
      );
    }
    if (d.weekday >= 6) return false;
    return !this.holidays.has(isoDate);
  }

  holidayName(isoDate: string): string | undefined {
    return this.holidays.get(isoDate);
  }

  nextTradingDay(isoDate: string): string {
    let d = DateTime.fromISO(isoDate, { zone: IST }).plus({ days: 1 });
    for (let i = 0; i < 30; i++) {
      const s = d.toISODate()!;
      if (this.isTradingDay(s)) return s;
      d = d.plus({ days: 1 });
    }
    throw new RangeError(`no trading day within 30 days after ${isoDate}`);
  }

  previousTradingDay(isoDate: string): string {
    let d = DateTime.fromISO(isoDate, { zone: IST }).minus({ days: 1 });
    for (let i = 0; i < 30; i++) {
      const s = d.toISODate()!;
      if (this.isTradingDay(s)) return s;
      d = d.minus({ days: 1 });
    }
    throw new RangeError(`no trading day within 30 days before ${isoDate}`);
  }

  /** The `n` trading days starting at `start` (inclusive if it is a trading day). */
  tradingDaysFrom(start: string, n: number): string[] {
    const out: string[] = [];
    let d = start;
    if (!this.isTradingDay(d)) d = this.nextTradingDay(d);
    while (out.length < n) {
      out.push(d);
      if (out.length < n) d = this.nextTradingDay(d);
    }
    return out;
  }

  upcomingHolidays(fromIso: string, limit = 5): { date: string; description: string }[] {
    return [...this.holidays.entries()]
      .filter(([d]) => d >= fromIso)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([date, description]) => ({ date, description }));
  }
}
