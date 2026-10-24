import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Alerter, TelegramSink, type AlertSink } from '../../src/ops/alerts';
import { Healthchecks } from '../../src/ops/heartbeat';
import { revalidateIfDue } from '../../src/ops/revalidate';
import { writeStepSummary, mdTable } from '../../src/ops/summary';
import { flagRequired, flagString, parseArgs } from '../../src/ops/args';
import { FixtureRecorder } from '../../src/ops/fixtures';
import {
  slotTimes,
  dueSlot,
  expiredSlots,
  nextRoundText,
  isBetween,
  isAfter,
  weekdayName,
  minutesOfDay,
} from '../../src/round/schedule';
import { must, loadArena, loadJson } from '../../src/config/load';
import { arenaConfigSchema } from '@arena/shared/schemas';
import { CALENDAR } from '../helpers/world';
import { fakeFetch } from '../helpers/fixtures';

const log = pino({ level: 'silent' });
const arena = must(loadArena());

class Sink implements AlertSink {
  sent: string[] = [];
  fail = false;
  async send(t: string) {
    if (this.fail) throw new Error('down');
    this.sent.push(t);
  }
}

describe('alerts (SPEC §17)', () => {
  it('sends criticals now, batches warnings per tick, logs info only, and survives sink failures', async () => {
    const sink = new Sink();
    const a = new Alerter(null, sink, log, {
      runUrl: 'https://gh/run/1',
      statusUrl: 'https://site/status',
    });
    await a.raise({ key: 'k1', severity: 'critical', text: 'boom' });
    await a.raise({ key: 'k2', severity: 'warn', text: 'w1' });
    await a.raise({ key: 'k3', severity: 'warn', text: 'w2' });
    await a.raise({ key: 'k4', severity: 'info', text: 'fyi' });
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toBe(
      'CRITICAL: boom\n\nRun: https://gh/run/1\nStatus: https://site/status',
    );
    await a.flush();
    expect(sink.sent[1]).toContain('Warnings:\n- w1\n- w2');
    await a.flush();
    expect(sink.sent).toHaveLength(2);
    sink.fail = true;
    await a.digest('daily');
    const none = new Alerter(null, null, log, { runUrl: null, statusUrl: null });
    await none.raise({ key: 'x', severity: 'critical', text: 'no sink' });
    expect(none.sent).toEqual(['CRITICAL: no sink']);
  });
  it('Telegram sink posts to the bot API and reports failures', async () => {
    const f = fakeFetch(() => ({ body: { ok: true } }));
    await new TelegramSink('123:abc', '42', f.impl).send('hi');
    expect(f.calls[0]!.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(f.calls[0]!.body).toEqual({ chat_id: '42', text: 'hi', disable_web_page_preview: true });
    const bad = fakeFetch(() => ({ status: 401, body: {} }));
    await expect(new TelegramSink('t', 'c', bad.impl).send('x')).rejects.toThrow(/401/);
  });
});

describe('heartbeat and summaries', () => {
  it('pings Healthchecks start/success/fail and never throws', async () => {
    const f = fakeFetch(() => ({ body: 'OK' }));
    const h = new Healthchecks('https://hc-ping.com/uuid-x', log, f.impl);
    await h.ping('start');
    await h.ping('success', 'summary');
    await h.ping('fail');
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://hc-ping.com/uuid-x/start',
      'https://hc-ping.com/uuid-x',
      'https://hc-ping.com/uuid-x/fail',
    ]);
    await new Healthchecks(undefined, log).ping('start');
    await new Healthchecks(
      'https://hc.test/x',
      log,
      fakeFetch(() => ({ status: 404, body: '' })).impl,
    ).ping('start');
    await new Healthchecks('https://hc.test/x', log, fakeFetch(() => new Error('down')).impl).ping(
      'start',
    );
  });
  it('writes the GitHub step summary when set', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sum-')), 'summary.md');
    writeFileSync(f, '');
    const prev = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = f;
    writeStepSummary('## hi');
    process.env.GITHUB_STEP_SUMMARY = prev;
    expect(readFileSync(f, 'utf8')).toBe('## hi\n');
    expect(mdTable(['a'], [['x|y\nz']])).toBe('| a |\n| --- |\n| x\\|y z |');
  });
  it('args helpers', () => {
    const a = parseArgs(['--x', 'v', '--flag']);
    expect(flagString(a, 'x')).toBe('v');
    expect(flagString(a, 'flag')).toBeUndefined();
    expect(flagRequired(a, 'x')).toBe('v');
    expect(() => flagRequired(a, 'nope')).toThrow(/--nope is required/);
  });
  it('fixture recorder writes sanitised, numbered files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-'));
    const r = new FixtureRecorder(dir);
    r.record('quote call', { response: { jwtToken: 'secret', ltp: 1 } });
    const body = JSON.parse(readFileSync(r.files[0]!, 'utf8'));
    expect(body.response).toEqual({ jwtToken: '[removed]', ltp: 1 });
    expect(r.files[0]).toMatch(/01-quote-call\.recorded\.json$/);
  });
  it('config loader reports invalid JSON and invalid fields with a fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'a.json'), '{nope');
    writeFileSync(join(dir, 'b.json'), '{}');
    const a = loadJson('a.json', arenaConfigSchema, 'fix', dir);
    const b = loadJson('b.json', arenaConfigSchema, 'fix', dir);
    expect(a.ok || a.error).toMatch(/not valid JSON/);
    expect(b.ok || b.error).toMatch(/invalid/);
  });
});

describe('schedule (SPEC §12.2)', () => {
  const day = '2026-10-19';
  const t = (hhmm: string, sec = 0) =>
    new Date(new Date(`${day}T${hhmm}:00+05:30`).getTime() + sec * 1000);
  it('has 12 slots from 09:30 to 15:00', () => {
    expect(slotTimes(arena)).toEqual([
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
    ]);
  });
  it('finds the due slot within 20 minutes of grace across the whole day', () => {
    expect(dueSlot(arena, day, t('09:29', 59))).toBeNull();
    expect(dueSlot(arena, day, t('09:30'))).toBe('09:30');
    expect(dueSlot(arena, day, t('09:49', 59))).toBe('09:30');
    expect(dueSlot(arena, day, t('09:50'))).toBeNull();
    expect(dueSlot(arena, day, t('15:12'))).toBe('15:00');
    expect(dueSlot(arena, day, t('15:20'))).toBeNull();
    for (let m = 8 * 60; m < 17 * 60; m += 1) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const s = dueSlot(arena, day, t(`${hh}:${mm}`));
      if (s) expect(m - (Number(s.slice(0, 2)) * 60 + Number(s.slice(3)))).toBeLessThan(20);
    }
  });
  it('lists slots whose grace has passed', () => {
    expect(expiredSlots(arena, day, t('10:20'))).toEqual(['09:30', '10:00']);
    expect(expiredSlots(arena, day, t('09:00'))).toEqual([]);
  });
  it('describes the next round', () => {
    expect(nextRoundText(arena, CALENDAR, day, '10:00', null)).toBe('10:30 IST');
    expect(nextRoundText(arena, CALENDAR, '2026-10-23', '15:00', null)).toBe(
      'Monday 2026-10-26 09:30 IST',
    );
    expect(nextRoundText(arena, CALENDAR, day, '15:00', day)).toBe('none (the season ends today)');
  });
  it('window helpers', () => {
    expect(isBetween(t('08:45'), '08:30', '09:25')).toBe(true);
    expect(isBetween(t('09:25'), '08:30', '09:25')).toBe(false);
    expect(isAfter(t('15:40'), '15:40')).toBe(true);
    expect(weekdayName(day)).toBe('Monday');
    expect(minutesOfDay(t('00:00'))).toBe(0);
  });
});

describe('revalidation (unconfigured)', () => {
  it('is skipped with a log line while WEB_BASE_URL is unset', async () => {
    expect(
      await revalidateIfDue({ query: async () => ({ rows: [], rowCount: 0 }) } as never, {
        log,
        now: new Date(),
      }),
    ).toBe('skipped-unconfigured');
  });
});
