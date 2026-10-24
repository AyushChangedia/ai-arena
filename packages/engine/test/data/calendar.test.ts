import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingCalendar } from '../../src/data/calendar';

// A calendar used only by these tests (not the real NSE list).
const cal = new TradingCalendar([
  {
    year: 2030,
    exchange: 'NSE',
    segment: 'equity',
    source: 'test',
    sourceUrl: 'https://example.test/',
    downloadedOn: '2030-01-01',
    holidays: [
      { date: '2030-01-01', description: 'Test holiday' },
      { date: '2030-01-07', description: 'Test holiday 2' },
    ],
  },
]);

describe('trading calendar', () => {
  it('closes weekends and holidays', () => {
    expect(cal.isTradingDay('2030-01-01')).toBe(false); // holiday (Tue)
    expect(cal.isTradingDay('2030-01-02')).toBe(true);
    expect(cal.isTradingDay('2030-01-05')).toBe(false); // Saturday
    expect(cal.holidayName('2030-01-07')).toBe('Test holiday 2');
  });
  it('refuses to guess a year with no holiday list', () => {
    expect(() => cal.isTradingDay('2031-01-02')).toThrow(/No NSE holiday list for 2031/);
    expect(() => cal.isTradingDay('nope')).toThrow();
    expect(cal.hasYear(2030)).toBe(true);
  });
  it('walks trading days', () => {
    expect(cal.nextTradingDay('2030-01-04')).toBe('2030-01-08'); // Fri -> skip weekend and holiday Mon
    expect(cal.previousTradingDay('2030-01-08')).toBe('2030-01-04');
    expect(cal.tradingDaysFrom('2030-01-05', 3)).toEqual([
      '2030-01-08',
      '2030-01-09',
      '2030-01-10',
    ]);
    expect(cal.upcomingHolidays('2030-01-02')).toEqual([
      { date: '2030-01-07', description: 'Test holiday 2' },
    ]);
  });
  it('gives up after 30 days of no trading', () => {
    const days = Array.from({ length: 70 }, (_, i) =>
      new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10),
    );
    const allHoliday = new TradingCalendar([
      {
        year: 2030,
        exchange: 'NSE',
        segment: 'equity',
        source: 't',
        sourceUrl: 'https://e.test/',
        downloadedOn: '2030-01-01',
        holidays: days.map((date) => ({ date, description: 'h' })),
      },
    ]);
    expect(() => allHoliday.nextTradingDay('2030-01-01')).toThrow(/no trading day/);
    expect(() => allHoliday.previousTradingDay('2030-03-05')).toThrow(/no trading day/);
  });
  it('loads from a config directory, skipping missing years and rejecting invalid files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    mkdirSync(join(dir, 'calendar'));
    writeFileSync(
      join(dir, 'calendar', 'nse-2030.json'),
      JSON.stringify({
        year: 2030,
        exchange: 'NSE',
        segment: 'equity',
        source: 's',
        sourceUrl: 'https://e.test/',
        downloadedOn: '2030-01-01',
        holidays: [],
      }),
    );
    const c = TradingCalendar.fromConfig([2030, 2031], dir);
    expect(c.hasYear(2030)).toBe(true);
    expect(c.hasYear(2031)).toBe(false);
    writeFileSync(join(dir, 'calendar', 'nse-2031.json'), '{"year": 2031}');
    expect(() => TradingCalendar.fromConfig([2031], dir)).toThrow(/invalid/);
  });
});
