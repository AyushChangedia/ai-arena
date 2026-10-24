import { DateTime } from 'luxon';
import {
  universeSchema,
  calendarSchema,
  type Universe,
  type MarketCalendar,
} from '@arena/shared/schemas';

/** Splits one CSV line, honouring double quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
  const header = splitCsvLine(lines[0] ?? '');
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

/**
 * Parses niftyindices.com's ind_nifty50list.csv (columns: Company Name, Industry, Symbol, Series, ISIN Code).
 * Throws if the file doesn't have exactly 50 EQ rows.
 */
export function importNifty50Csv(
  text: string,
  meta: { sourceUrl: string; effectiveFrom: string; downloadedOn: string },
): Universe {
  const rows = parseCsv(text);
  const need = ['Company Name', 'Symbol', 'Series'];
  for (const n of need)
    if (!rows[0] || !(n in rows[0]))
      throw new Error(
        `CSV is missing the "${n}" column. Expected niftyindices.com's ind_nifty50list.csv.`,
      );
  const constituents = rows
    .filter((r) => r.Series === 'EQ')
    .map((r) => ({
      symbol: r.Symbol!.toUpperCase(),
      name: r['Company Name']!,
      ...(r.Industry ? { industry: r.Industry } : {}),
      ...(r['ISIN Code'] ? { isin: r['ISIN Code'] } : {}),
    }));
  return universeSchema.parse({
    index: 'NIFTY 50',
    effectiveFrom: meta.effectiveFrom,
    sourceUrl: meta.sourceUrl,
    downloadedOn: meta.downloadedOn,
    constituents,
  });
}

function parseHolidayDate(s: string): string {
  const t = s.trim();
  for (const fmt of ['dd-LLL-yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'd-LLL-yyyy', 'dd MMM yyyy']) {
    const d = DateTime.fromFormat(t, fmt, { locale: 'en' });
    if (d.isValid) return d.toISODate()!;
  }
  throw new Error(`Unrecognised holiday date "${s}".`);
}

/**
 * Parses NSE's trading-holiday list: the JSON from nseindia.com/api/holiday-master?type=trading
 * (equity segment "CM"), or a CSV with Date and Description columns.
 */
export function importNseHolidays(
  text: string,
  meta: { year: number; sourceUrl: string; downloadedOn: string },
): MarketCalendar {
  let holidays: { date: string; description: string }[];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const cm = json.CM;
    if (!Array.isArray(cm)) throw new Error('NSE holiday JSON has no "CM" (capital market) list.');
    holidays = cm.map((h) => {
      const o = h as { tradingDate?: string; description?: string };
      if (!o.tradingDate || !o.description)
        throw new Error('NSE holiday entry missing tradingDate or description.');
      return { date: parseHolidayDate(o.tradingDate), description: o.description.trim() };
    });
  } else {
    const rows = parseCsv(trimmed);
    const dateKey = Object.keys(rows[0] ?? {}).find((k) => /date/i.test(k));
    const descKey = Object.keys(rows[0] ?? {}).find((k) => /desc|holiday/i.test(k));
    if (!dateKey || !descKey)
      throw new Error('Holiday CSV needs a Date column and a Description column.');
    holidays = rows.map((r) => ({ date: parseHolidayDate(r[dateKey]!), description: r[descKey]! }));
  }
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  return calendarSchema.parse({
    year: meta.year,
    exchange: 'NSE',
    segment: 'equity',
    source: 'NSE trading holidays (capital market segment)',
    sourceUrl: meta.sourceUrl,
    downloadedOn: meta.downloadedOn,
    holidays: holidays.filter((h) => h.date.startsWith(`${meta.year}-`)),
  });
}
