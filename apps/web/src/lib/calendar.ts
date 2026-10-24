import 'server-only';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { calendarSchema } from '@arena/shared/schemas';

export interface Holiday {
  date: string;
  description: string;
}

/** Reads config/calendar/nse-<year>.json. Missing or invalid files yield null: the site says so, never guesses. */
export function loadHolidays(year: number): { holidays: Holiday[]; source: string } | null {
  const candidates = [
    join(process.cwd(), '..', '..', 'config', 'calendar', `nse-${year}.json`),
    join(process.cwd(), 'config', 'calendar', `nse-${year}.json`),
  ];
  for (const p of candidates) {
    if (!existsSync(/*turbopackIgnore: true*/ p)) continue;
    // Config files are traced explicitly in next.config.ts (outputFileTracingIncludes).
    const parsed = calendarSchema.safeParse(
      JSON.parse(readFileSync(/*turbopackIgnore: true*/ p, 'utf8')),
    );
    if (parsed.success) return { holidays: parsed.data.holidays, source: parsed.data.source };
  }
  return null;
}
