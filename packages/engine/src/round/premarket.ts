/** Pre-market job (SPEC §12.4), once per trading day between 08:30 and 09:25 IST. */
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '@arena/db';
import { freshMapping, backfillBars, refreshIndicators } from '../data/market';
import {
  storeInstruments,
  recordUniverseVersion,
  isRebalanceReminderWindow,
} from '../data/universe';
import { applyCorporateAction } from '../core/corporate';
import { adjustDraft } from '../core/ledger';
import { openIncident, resolveIncidentsByPrefix } from '../ops/incidents';
import { appendLedger, applyPositions } from './ledger-store';
import { heldSymbols } from './store';
import { IST } from './schedule';
import type { Deps } from './deps';
import type { SeasonRow } from './store';

export async function startJob(d: Deps, date: string, job: string): Promise<boolean> {
  const r = await d.db.query(
    `INSERT INTO daily_jobs (date, job, status, started_at) VALUES ($1,$2,'running',$3)
     ON CONFLICT (date, job) DO UPDATE SET status = 'running', started_at = EXCLUDED.started_at, finished_at = NULL
     WHERE daily_jobs.status = 'failed' OR (daily_jobs.status = 'running' AND daily_jobs.started_at < $3::timestamptz - interval '15 minutes')
     RETURNING date`,
    [date, job, d.now()],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function endJob(
  d: Deps,
  date: string,
  job: string,
  status: 'ok' | 'failed',
  detail: Record<string, unknown>,
): Promise<void> {
  await d.db.query(
    'UPDATE daily_jobs SET status = $3, finished_at = $4, detail = $5 WHERE date = $1 AND job = $2',
    [date, job, status, d.now(), JSON.stringify(detail)],
  );
}

export async function jobStatus(d: Deps, date: string, job: string): Promise<string | null> {
  const r = await d.db.query<{ status: string }>(
    'SELECT status FROM daily_jobs WHERE date = $1 AND job = $2',
    [date, job],
  );
  return r.rows[0]?.status ?? null;
}

/** Applies corporate actions whose ex-date is today, for every participant holding the stock at the previous close. */
export async function applyCorporateActions(
  d: Deps,
  season: SeasonRow,
  date: string,
): Promise<string[]> {
  const due = await d.db.query<{
    id: string;
    symbol: string;
    type: 'split' | 'bonus' | 'dividend';
    ratio_num: number | null;
    ratio_den: number | null;
    amount_paise_per_share: string | null;
    source_url: string;
  }>(
    'SELECT id, symbol, type, ratio_num, ratio_den, amount_paise_per_share, source_url FROM corporate_actions WHERE ex_date = $1 AND applied_at IS NULL',
    [date],
  );
  const applied: string[] = [];
  const at = d.now();
  const revealAt = new Date(at.getTime() + d.arena.season.publicDelayMinutes * 60_000);
  for (const ca of due.rows) {
    await withTransaction(d.db, async (tx) => {
      const holders = await tx.query<{
        participant_id: string;
        quantity: number;
        avg_cost_paise: string;
      }>(
        'SELECT p.participant_id, p.quantity, p.avg_cost_paise FROM positions p JOIN participants pa ON pa.id = p.participant_id WHERE pa.season_id = $1 AND p.symbol = $2 AND p.quantity > 0',
        [season.id, ca.symbol],
      );
      const drafts = [];
      for (const h of holders.rows) {
        const cash = await tx.query<{ c: string }>(
          'SELECT cash_after_paise AS c FROM ledger WHERE participant_id = $1 ORDER BY seq DESC LIMIT 1',
          [h.participant_id],
        );
        const adj = applyCorporateAction(
          { quantity: h.quantity, avgCostPaise: BigInt(h.avg_cost_paise) },
          {
            type: ca.type,
            ratioNum: ca.ratio_num,
            ratioDen: ca.ratio_den,
            amountPaisePerShare:
              ca.amount_paise_per_share === null ? null : BigInt(ca.amount_paise_per_share),
          },
        );
        const cashAfter = BigInt(cash.rows[0]!.c) + adj.cashDeltaPaise;
        drafts.push(
          adjustDraft(
            {
              id: randomUUID(),
              seasonId: season.id,
              participantId: h.participant_id,
              roundId: null,
              occurredAt: at,
              revealAt,
            },
            {
              type:
                ca.type === 'dividend'
                  ? 'DIVIDEND'
                  : ca.type === 'split'
                    ? 'SPLIT_ADJUST'
                    : 'BONUS_ADJUST',
              symbol: ca.symbol,
              quantityDelta: adj.quantityDelta,
              grossPaise: adj.cashDeltaPaise,
              cashDeltaPaise: adj.cashDeltaPaise,
              cashAfterPaise: cashAfter,
              positionAfter: adj.quantityAfter,
              avgCostAfterPaise: adj.avgCostAfterPaise,
              note: `${ca.type} (${ca.type === 'dividend' ? `${ca.amount_paise_per_share} paise per share` : `${ca.ratio_num}:${ca.ratio_den}`}), source ${ca.source_url}`,
            },
          ),
        );
      }
      const entries = await appendLedger(tx, drafts);
      await applyPositions(tx, entries);
      await tx.query('UPDATE corporate_actions SET applied_at = $2 WHERE id = $1', [ca.id, at]);
    });
    applied.push(`${ca.symbol} ${ca.type}`);
  }
  return applied;
}

export async function runPreMarket(
  d: Deps,
  season: SeasonRow | null,
  date: string,
): Promise<Record<string, unknown>> {
  const detail: Record<string, unknown> = {};
  const provider = d.provider();
  // Instruments and universe mapping.
  await recordUniverseVersion(d.db, d.universe);
  const held = season ? await heldSymbols(d.db, season.id) : [];
  const symbols = [...new Set([...d.universe.constituents.map((c) => c.symbol), ...held])];
  const mapping = await freshMapping(
    provider,
    {
      ...d.universe,
      constituents: symbols.map((s) => ({ symbol: s, name: s })),
    } as typeof d.universe,
    d.arena,
  );
  await storeInstruments(d.db, mapping.equities, mapping.indices, date);
  await resolveIncidentsByPrefix(d.db, 'universe:unmapped:');
  for (const u of mapping.unmapped) {
    await openIncident(
      d.db,
      {
        key: `universe:unmapped:${u.symbol}`,
        severity: 'warn',
        title: `${u.symbol} could not be mapped to one instrument`,
        detail: u.reason,
        publicMessage: `${u.symbol} can't be traded today: its instrument couldn't be identified.`,
        scope: 'symbol',
      },
      d.now(),
    );
  }
  detail.mapped = mapping.equities.length;
  detail.unmapped = mapping.unmapped.map((u) => u.symbol);
  // Daily bars: backfill when history is short, otherwise append the previous trading day.
  const prev = d.calendar.previousTradingDay(date);
  const counts = await d.db.query<{ symbol: string; n: number }>(
    'SELECT symbol, count(*)::int AS n FROM daily_bars WHERE date < $1 GROUP BY symbol',
    [date],
  );
  const have = new Map(counts.rows.map((r) => [r.symbol, r.n]));
  const short = mapping.equities.filter(
    (e) => (have.get(e.symbol) ?? 0) < d.arena.marketData.historyTradingDays,
  );
  const ok = mapping.equities.filter((e) => !short.includes(e));
  const session = await provider.login();
  const longFrom = DateTime.fromISO(date, { zone: IST })
    .minus({ days: Math.ceil(d.arena.marketData.historyTradingDays * 1.6) + 10 })
    .toISODate()!;
  const shortFrom = DateTime.fromISO(prev, { zone: IST }).minus({ days: 7 }).toISODate()!;
  const b1 = await backfillBars(d.db, session, short, longFrom, prev);
  const b2 = await backfillBars(d.db, session, ok, shortFrom, prev);
  const barErrors = [...b1, ...b2].filter((b) => b.error);
  detail.bars = {
    backfilled: short.length,
    appended: ok.length,
    errors: barErrors.map((b) => `${b.symbol}: ${b.error}`),
  };
  await refreshIndicators(
    d.db,
    mapping.equities.map((e) => e.symbol),
    date,
  );
  if (barErrors.length) {
    await openIncident(
      d.db,
      {
        key: `bars:${date}`,
        severity: 'warn',
        title: 'Some daily bars could not be fetched',
        detail: barErrors
          .slice(0, 10)
          .map((b) => `${b.symbol}: ${b.error}`)
          .join('\n'),
        publicMessage: 'Some indicators may be missing today.',
        scope: 'arena',
      },
      d.now(),
    );
  }
  // Corporate actions due today.
  detail.corporateActions = season ? await applyCorporateActions(d, season, date) : [];
  // OpenRouter credit.
  try {
    const credit = await d.llm().remainingCreditUsd();
    detail.creditUsd = credit.remainingUsd;
    if (credit.remainingUsd !== null && credit.remainingUsd < d.arena.llm.creditWarnUsd) {
      const critical = credit.remainingUsd < d.arena.llm.creditCriticalUsd;
      await openIncident(
        d.db,
        {
          key: 'llm:credit-low',
          severity: critical ? 'critical' : 'warn',
          title: `OpenRouter credit low: $${credit.remainingUsd.toFixed(2)}`,
          detail: 'Top up credit on openrouter.ai.',
          publicMessage: 'The arena is running low on API credit.',
          scope: 'arena',
        },
        d.now(),
      );
      await d.alerts.raise({
        key: 'llm:credit-low',
        severity: critical ? 'critical' : 'warn',
        text: `OpenRouter credit is $${credit.remainingUsd.toFixed(2)}.`,
      });
    }
  } catch (e) {
    detail.creditError = (e as Error).message;
  }
  // Reminders.
  if (isRebalanceReminderWindow(date)) {
    await openIncident(
      d.db,
      {
        key: `reminder:rebalance:${date.slice(0, 7)}`,
        severity: 'warn',
        title: 'Nifty 50 rebalance due',
        detail:
          'NSE rebalances the index at the end of March and September. Check niftyindices.com and update config/universe/nifty50.json.',
        publicMessage: 'The Nifty 50 list is due for its scheduled review.',
        scope: 'arena',
      },
      d.now(),
    );
  }
  const year = Number(date.slice(0, 4));
  if (date.slice(5) >= '12-01' && !d.calendar.hasYear(year + 1)) {
    await openIncident(
      d.db,
      {
        key: `reminder:calendar:${year + 1}`,
        severity: 'warn',
        title: `NSE ${year + 1} holiday list missing`,
        detail: `Add config/calendar/nse-${year + 1}.json (SETUP.md).`,
        publicMessage: 'The trading calendar for next year has not been loaded yet.',
        scope: 'arena',
      },
      d.now(),
    );
  }
  return detail;
}
