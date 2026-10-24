/** Pure view-model computations shared by pages (no I/O). All money stays bigint paise. */
import type { MarkRow, Participant, ParticipantCounts, LedgerRow, Season } from '@arena/db/read';
import {
  totalReturn,
  maxDrawdown,
  tradeStats,
  cleanAnswers,
  uptime,
  acceptedActions,
  dailyReturns,
  sharpe,
} from '@arena/shared/metrics';

export interface Standing {
  participant: Participant;
  rank: number;
  rankYesterday: number | null;
  totalPaise: bigint | null;
  returnFrac: number | null;
  todayFrac: number | null;
  vsNiftyPts: number | null;
  maxDrawdown: number | null;
  trades: number;
  chargesPaise: bigint;
  turnoverPaise: bigint;
  winRate: number | null;
  cleanAnswers: number | null;
  acceptedActions: number | null;
  uptime: number | null;
  costUsd: number;
  sharpe: number | null;
  tradingDaysSoFar: number;
}

export function istDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function computeStandings(
  season: Season,
  participants: Participant[],
  marks: MarkRow[],
  counts: ParticipantCounts[],
  trades: LedgerRow[],
): Standing[] {
  const start = season.startingCashPaise;
  const byP = new Map<string, MarkRow[]>();
  for (const m of marks) {
    const l = byP.get(m.participantId) ?? [];
    l.push(m);
    byP.set(m.participantId, l);
  }
  const index = participants.find((p) => p.kind === 'index');
  const indexLatest = index ? byP.get(index.id)?.at(-1) : undefined;
  const indexReturn = indexLatest ? totalReturn(indexLatest.totalPaise, start) : null;
  const latestDay = marks.length ? istDate(marks.at(-1)!.markedAt) : null;
  const rows = participants.map((p) => {
    const ms = byP.get(p.id) ?? [];
    const latest = ms.at(-1);
    const eods = ms.filter((m) => m.kind === 'eod');
    const prevEod = [...eods]
      .reverse()
      .find((m) => latestDay !== null && istDate(m.markedAt) < latestDay);
    const prevEodBefore = (day: string) =>
      [...eods].reverse().find((m) => istDate(m.markedAt) < day);
    const ret = latest ? totalReturn(latest.totalPaise, start) : null;
    const c = counts.find((x) => x.participantId === p.id);
    const ts = tradeStats(
      trades
        .filter((t) => t.participantId === p.id)
        .map((t) => ({
          side: t.side as 'BUY' | 'SELL',
          grossPaise: t.grossPaise,
          chargesTotalPaise: t.chargesTotalPaise,
          realizedPnlPaise: t.realizedPnlPaise,
        })),
    );
    const eodDays = [...new Set(eods.map((m) => istDate(m.markedAt)))];
    return {
      participant: p,
      rank: 0,
      rankYesterday: null as number | null,
      totalPaise: latest?.totalPaise ?? null,
      returnFrac: ret,
      todayFrac:
        latest && prevEod && prevEod.totalPaise > 0n
          ? Number(latest.totalPaise - prevEod.totalPaise) / Number(prevEod.totalPaise)
          : null,
      vsNiftyPts:
        ret !== null && indexReturn !== null && p.kind !== 'index' ? ret - indexReturn : null,
      maxDrawdown: ms.length ? maxDrawdown(ms.map((m) => m.totalPaise)) : null,
      trades: ts.trades,
      chargesPaise: ts.chargesPaise,
      turnoverPaise: ts.turnoverPaise,
      winRate: ts.winRate,
      cleanAnswers: c && p.kind === 'model' ? cleanAnswers(c) : null,
      acceptedActions: c && p.kind !== 'index' ? acceptedActions(c) : null,
      uptime: c && p.kind === 'model' ? uptime(c) : null,
      costUsd: c?.costUsd ?? 0,
      sharpe: sharpe(
        dailyReturns(
          start,
          eodDays.map((d) => eods.filter((m) => istDate(m.markedAt) === d).at(-1)!.totalPaise),
        ),
      ),
      tradingDaysSoFar: eodDays.length,
      _yesterdayTotal: latestDay ? (prevEodBefore(latestDay)?.totalPaise ?? null) : null,
    };
  });
  const sorted = [...rows].sort(
    (a, b) =>
      cmp(b.totalPaise, a.totalPaise) || a.participant.slot.localeCompare(b.participant.slot),
  );
  sorted.forEach((r, i) => (r.rank = i + 1));
  const ySorted = rows
    .filter((r) => r._yesterdayTotal !== null)
    .sort((a, b) => cmp(b._yesterdayTotal, a._yesterdayTotal));
  ySorted.forEach((r, i) => (r.rankYesterday = i + 1));
  return sorted.map(({ _yesterdayTotal: _y, ...r }) => r);
}

function cmp(a: bigint | null, b: bigint | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a > b ? 1 : -1;
}

/** One-line verdict for a decision ("Bought 12 TCS", "Sold 30 ITC, bought 8 LT", "Held", …) (SPEC §16.3). */
export function verdict(
  status: string,
  actions: {
    status: string;
    side: string | null;
    quantity: number | null;
    symbol: string | null;
  }[],
): string {
  const map: Record<string, string> = {
    INVALID_RESPONSE: 'Unreadable answer',
    MISSED_PROVIDER: 'Missed round: provider timeout',
    MISSED_CONFIG: 'Missed round: model offline',
    MODEL_MISMATCH: 'Missed round: wrong model served',
    SKIPPED_BUDGET: 'Paused (budget)',
    SKIPPED_PAUSED: 'Paused',
    NOT_EXECUTED_DATA: 'Decisions made, not executed: market data failed',
    EXECUTION_FAILED: 'Not executed: recording failed',
    MISSED_ABORTED: 'Round aborted',
  };
  if (map[status]) return map[status]!;
  const done = actions.filter((a) => a.status === 'executed');
  const sells = done.filter((a) => a.side === 'SELL').map((a) => `${a.quantity} ${a.symbol}`);
  const buys = done.filter((a) => a.side === 'BUY').map((a) => `${a.quantity} ${a.symbol}`);
  const parts: string[] = [];
  if (sells.length) parts.push(`sold ${sells.join(', ')}`);
  if (buys.length) parts.push(`bought ${buys.join(', ')}`);
  if (status === 'RETIRED') return parts.length ? `Retired: ${parts.join(', ')}` : 'Retired';
  if (!parts.length) return actions.length ? 'Held (every action rejected)' : 'Held';
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Plain-words blunder: "Tried to sell 40 HDFCBANK, held 0". */
export function blunderText(a: {
  rejectDetail: string | null;
  rejectCode: string | null;
  sideRaw: string | null;
  symbolRaw: string | null;
  quantityRaw: unknown;
}): string {
  if (a.rejectDetail) return a.rejectDetail;
  return `${a.rejectCode ?? 'Rejected'}: ${a.sideRaw ?? '?'} ${String(a.quantityRaw ?? '?')} ${a.symbolRaw ?? '?'}`;
}

export function firstLine(s: string | null, max = 160): string {
  if (!s) return '';
  const line = s.split(/\n/)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
