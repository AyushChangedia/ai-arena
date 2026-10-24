import type { ArenaData } from './data';
import type { ScoreItem } from '@/components/score-bug';
import type { StandingRow } from '@/components/standings-table';
import type { ChartSeries } from '@/components/chart-types';
import { formatInrCompact, formatPct } from '@arena/shared/format';

export function participantStatus(s: {
  kind: string;
  status: string;
  retiredAt: Date | null;
}): string {
  if (s.kind === 'index') return 'Benchmark';
  if (s.status === 'retired') return 'Retired';
  if (s.status === 'paused_budget') return 'Paused (budget)';
  return 'Active';
}

export function scoreItems(a: ArenaData): ScoreItem[] {
  return a.standings.map((s) => ({
    id: s.participant.id,
    slot: s.participant.slot,
    rank: s.rank,
    shortCode: s.participant.shortCode,
    color: s.participant.color,
    kind: s.participant.kind,
    name: s.participant.kind === 'monkey' ? 'Monkey (random)' : s.participant.displayName,
    totalPaise: s.totalPaise,
    returnFrac: s.returnFrac,
  }));
}

export function standingRows(a: { standings: ArenaData['standings'] }): StandingRow[] {
  return a.standings.map((s) => ({
    id: s.participant.id,
    slot: s.participant.slot,
    rank: s.rank,
    movement: s.rankYesterday === null ? null : s.rankYesterday - s.rank,
    name: s.participant.kind === 'monkey' ? 'Monkey (random)' : s.participant.displayName,
    shortCode: s.participant.shortCode,
    color: s.participant.color,
    kind: s.participant.kind,
    totalPaise: s.totalPaise === null ? null : s.totalPaise.toString(),
    returnFrac: s.returnFrac,
    todayFrac: s.todayFrac,
    vsNifty: s.vsNiftyPts,
    maxDrawdown: s.maxDrawdown,
    trades: s.trades,
    status: participantStatus(s.participant),
  }));
}

export function chartSeries(
  a: Pick<ArenaData, 'participants' | 'marks'>,
  only?: string[],
): ChartSeries[] {
  return a.participants
    .filter((p) => !only || only.includes(p.id))
    .map((p) => ({
      id: p.id,
      shortCode: p.shortCode,
      name: p.displayName,
      color: p.color,
      kind: p.kind,
      points: dedupe(
        a.marks
          .filter((m) => m.participantId === p.id)
          .map(
            (m) =>
              [Math.floor(m.markedAt.getTime() / 1000), m.totalPaise.toString()] as [
                number,
                string,
              ],
          ),
      ),
    }));
}

function dedupe(points: [number, string][]): [number, string][] {
  const out: [number, string][] = [];
  for (const p of points) {
    if (out.length && out[out.length - 1]![0] >= p[0])
      out[out.length - 1] = [out[out.length - 1]![0], p[1]];
    else out.push(p);
  }
  return out;
}

export function chartSummary(a: ArenaData): string {
  if (!a.standings.length || a.standings[0]!.totalPaise === null)
    return 'Portfolio value chart: no marks yet.';
  const top = a.standings
    .slice(0, 3)
    .map(
      (s) =>
        `${s.participant.shortCode} ${formatInrCompact(s.totalPaise!)} (${s.returnFrac === null ? 'no return yet' : formatPct(s.returnFrac, { arrow: false })})`,
    );
  return `Portfolio value over the season for every participant. Leaders now: ${top.join(', ')}.`;
}
