/**
 * Alerts (SPEC §17): Telegram is optional. Critical alerts go immediately, warnings are batched per
 * tick, one message per incident key per hour. Never throws: an alert failure is logged and reported.
 */
import type { Logger } from 'pino';
import type { Queryable } from '@arena/db';
import { httpJson, type FetchLike } from '../data/http';

export interface Alert {
  key: string;
  severity: 'info' | 'warn' | 'critical';
  text: string;
}

export interface AlertSink {
  send(text: string): Promise<void>;
}

export class TelegramSink implements AlertSink {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl?: FetchLike,
  ) {}
  async send(text: string): Promise<void> {
    const res = await httpJson({
      url: `https://api.telegram.org/bot${this.token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true },
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  }
}

export class Alerter {
  private warnings: Alert[] = [];
  readonly sent: string[] = [];
  constructor(
    private readonly db: Queryable | null,
    private readonly sink: AlertSink | null,
    private readonly log: Logger,
    private readonly links: { runUrl: string | null; statusUrl: string | null },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async recentlySent(key: string): Promise<boolean> {
    if (!this.db) return false;
    const r = await this.db.query(
      "SELECT 1 FROM heartbeats WHERE outcome = 'alert' AND detail->>'key' = $1 AND at > $2::timestamptz - interval '1 hour' LIMIT 1",
      [key, this.now()],
    );
    return (r.rowCount ?? 0) > 0;
  }

  private async markSent(keys: string[]): Promise<void> {
    if (!this.db) return;
    for (const key of keys)
      await this.db.query("INSERT INTO heartbeats (at, outcome, detail) VALUES ($1, 'alert', $2)", [
        this.now(),
        JSON.stringify({ key }),
      ]);
  }

  private footer(): string {
    return [
      this.links.runUrl ? `Run: ${this.links.runUrl}` : null,
      this.links.statusUrl ? `Status: ${this.links.statusUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async deliver(text: string, keys: string[]): Promise<void> {
    const msg = `${text}${this.footer() ? `\n\n${this.footer()}` : ''}`;
    this.sent.push(msg);
    if (!this.sink) {
      this.log.info({ keys }, 'alert (Telegram not configured)');
      return;
    }
    try {
      await this.sink.send(msg);
      await this.markSent(keys);
    } catch (e) {
      this.log.error({ err: e, keys }, 'alert delivery failed');
    }
  }

  async raise(a: Alert): Promise<void> {
    if (a.severity === 'info') {
      this.log.info({ key: a.key }, a.text);
      return;
    }
    if (await this.recentlySent(a.key)) return;
    if (a.severity === 'warn') {
      this.warnings.push(a);
      return;
    }
    await this.deliver(`CRITICAL: ${a.text}`, [a.key]);
  }

  /** Sends the batched warnings once per tick. */
  async flush(): Promise<void> {
    if (!this.warnings.length) return;
    const ws = this.warnings;
    this.warnings = [];
    await this.deliver(
      `Warnings:\n${ws.map((w) => `- ${w.text}`).join('\n')}`,
      ws.map((w) => w.key),
    );
  }

  async digest(text: string): Promise<void> {
    await this.deliver(text, ['digest']);
  }
}
