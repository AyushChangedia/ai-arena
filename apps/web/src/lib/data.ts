import 'server-only';
import { cacheLife, cacheTag } from 'next/cache';
import * as read from '@arena/db/read';
import { getSql } from './db';
import { siteMode } from './config';
import { logError } from './log';
import { computeStandings, istDate, type Standing } from './view';

export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: string };

/** Wraps a read in the cache. Failures are cached for seconds only, so an outage never sticks. */
async function guarded<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    cacheLife('seconds');
    logError('data read failed', e);
    return { ok: false, reason: 'unreachable' };
  }
}

export interface ArenaData {
  season: read.Season | null;
  participants: read.Participant[];
  status: read.StatusRow | null;
  marks: read.MarkRow[];
  standings: Standing[];
  latestRound: read.RoundRow | null;
  latestDecisions: read.DecisionRow[];
  blunders: read.Blunder[];
  /** Holdings of every trading participant, from the delayed public view. */
  holdings: read.HoldingRow[];
  lastUpdated: Date | null;
  mode: 'shadow' | 'live';
}

export async function loadArena(): Promise<Loaded<ArenaData>> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const mode = siteMode();
  return guarded(async () => {
    const sql = await getSql();
    const season = await read.getSiteSeason(sql, mode);
    const status = await read.getStatus(sql);
    if (!season)
      return {
        season,
        participants: [],
        status,
        marks: [],
        standings: [],
        latestRound: null,
        latestDecisions: [],
        blunders: [],
        holdings: [],
        lastUpdated: null,
        mode,
      };
    const [participants, marks, counts, trades, latestRound, blunders] = await Promise.all([
      read.getParticipants(sql, season.id),
      read.getMarks(sql, season.id),
      read.getParticipantCounts(sql, season.id),
      read.getTradesForSeason(sql, season.id),
      read.getLatestDecisionRound(sql, season.id),
      read.getBlunders(sql, season.id, 10),
    ]);
    const traders = participants.filter((p) => p.kind !== 'index').map((p) => p.id);
    const [latestDecisions, holdings] = await Promise.all([
      latestRound ? read.getRoundDecisions(sql, latestRound.id) : Promise.resolve([]),
      traders.length ? read.getHoldings(sql, traders) : Promise.resolve([]),
    ]);
    return {
      season,
      participants,
      status,
      marks,
      standings: computeStandings(season, participants, marks, counts, trades),
      latestRound,
      latestDecisions,
      blunders,
      holdings,
      lastUpdated: status?.lastRevealedAt ?? null,
      mode,
    };
  });
}

export interface ModelData {
  arena: ArenaData;
  participant: read.Participant;
  standing: Standing | null;
  holdings: read.HoldingRow[];
  /** Newest first, each with the model's reason and exit plan (or the square-off's). */
  trades: (read.LedgerRow & { reason: read.TradeNote | null })[];
  decisions: (read.DecisionRow & { tradingDate: string; slotTime: string })[];
  blunders: read.Blunder[];
  strip: Awaited<ReturnType<typeof read.getRecentStatuses>>;
  counts: read.ParticipantCounts | null;
}

export async function loadModel(slug: string): Promise<Loaded<ModelData | null>> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const a = await loadArena();
  if (!a.ok) {
    cacheLife('seconds');
    return a;
  }
  return guarded(async () => {
    const participant = a.data.participants.find((p) => p.slot === slug);
    if (!participant || !a.data.season) return null;
    const sql = await getSql();
    const [holdings, ledger, notes, decisions, blunders, strip, counts] = await Promise.all([
      read.getHoldings(sql, [participant.id]),
      read.getParticipantLedger(sql, participant.id),
      read.getTradeNotes(sql, participant.id),
      read.getParticipantDecisions(sql, participant.id, 60),
      read.getBlunders(sql, a.data.season.id, 50, participant.id),
      read.getRecentStatuses(sql, a.data.season.id, 60),
      read.getParticipantCounts(sql, a.data.season.id),
    ]);
    return {
      arena: a.data,
      participant,
      standing: a.data.standings.find((s) => s.participant.id === participant.id) ?? null,
      holdings,
      trades: ledger
        .filter((l) => l.entryType === 'BUY' || l.entryType === 'SELL')
        .reverse()
        .map((l) => ({ ...l, reason: (l.actionId && notes.get(l.actionId)) || null })),
      decisions,
      blunders,
      strip,
      counts: counts.find((c) => c.participantId === participant.id) ?? null,
    };
  });
}

export interface RoundsData {
  season: read.Season | null;
  rounds: read.RoundRow[];
  mode: 'shadow' | 'live';
}

export async function loadRounds(): Promise<Loaded<RoundsData>> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const mode = siteMode();
  return guarded(async () => {
    const sql = await getSql();
    const season = await read.getSiteSeason(sql, mode);
    return { season, rounds: season ? await read.getRounds(sql, season.id) : [], mode };
  });
}

export interface RoundDetail {
  round: read.RoundRow;
  season: read.Season | null;
  participants: read.Participant[];
  decisions: read.DecisionRow[];
  marketTable: string | null;
  fills: read.LedgerRow[];
}

export async function loadRound(id: string): Promise<Loaded<RoundDetail | null>> {
  'use cache';
  cacheTag('detail', 'live');
  cacheLife('arena');
  return guarded(async () => {
    const sql = await getSql();
    const round = await read.getRound(sql, id);
    if (!round) return null;
    const [season, participants, decisions, marketTable, fills] = await Promise.all([
      read.getSeasonById(sql, round.seasonId),
      read.getParticipants(sql, round.seasonId),
      read.getRoundDecisions(sql, round.id),
      read.getMarketTable(sql, round.id),
      read
        .getLedgerForDate(sql, round.tradingDate)
        .then((l) => l.filter((e) => e.roundId === round.id)),
    ]);
    return { round, season, participants, decisions, marketTable, fills };
  });
}

export interface TradeDetail {
  entry: read.LedgerRow;
  neighbours: { prev: string | null; next: string | null };
  participant: read.Participant | null;
  action: read.ActionRow | null;
  cashBeforePaise: bigint;
  snapshotAt: Date | null;
  round: read.RoundRow | null;
}

export async function loadTrade(seq: string): Promise<Loaded<TradeDetail | null>> {
  'use cache';
  cacheTag('detail');
  cacheLife('arena');
  return guarded(async () => {
    const sql = await getSql();
    const entry = await read.getLedgerEntry(sql, seq);
    if (!entry) return null;
    const [neighbours, participants, round] = await Promise.all([
      read.getNeighbourSeqs(sql, seq),
      read.getParticipants(sql, entry.seasonId),
      entry.roundId ? read.getRound(sql, entry.roundId) : Promise.resolve(null),
    ]);
    const decisions = entry.roundId ? await read.getRoundDecisions(sql, entry.roundId) : [];
    const action = decisions.flatMap((d) => d.actions).find((a) => a.id === entry.actionId) ?? null;
    return {
      entry,
      neighbours,
      participant: participants.find((p) => p.id === entry.participantId) ?? null,
      action,
      cashBeforePaise: entry.cashAfterPaise - entry.cashDeltaPaise,
      snapshotAt: round?.fillSnapshotAt ?? null,
      round,
    };
  });
}

export interface VerifyData {
  head: { seq: string; hash: string; occurredAt: Date } | null;
  anchors: Awaited<ReturnType<typeof read.getAnchors>>;
}

export async function loadVerify(): Promise<Loaded<VerifyData>> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  return guarded(async () => {
    const sql = await getSql();
    const [head, anchors] = await Promise.all([read.getLedgerHead(sql), read.getAnchors(sql)]);
    return { head, anchors };
  });
}

export interface StatusData {
  arena: ArenaData;
  incidents: read.IncidentRow[];
  admin: Awaited<ReturnType<typeof read.getAdminLog>>;
  strips: Awaited<ReturnType<typeof read.getRecentStatuses>>;
  flags: Awaited<ReturnType<typeof read.getFlags>>;
}

export async function loadStatus(): Promise<Loaded<StatusData>> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const a = await loadArena();
  if (!a.ok) {
    cacheLife('seconds');
    return a;
  }
  return guarded(async () => {
    const sql = await getSql();
    const [incidents, admin, strips, flags] = await Promise.all([
      read.getIncidents(sql, 50),
      read.getAdminLog(sql, 30),
      a.data.season ? read.getRecentStatuses(sql, a.data.season.id, 24) : Promise.resolve([]),
      read.getFlags(sql),
    ]);
    return { arena: a.data, incidents, admin, strips, flags };
  });
}

export async function loadSeason(id: string): Promise<
  Loaded<{
    season: read.Season;
    standings: Standing[];
    marks: read.MarkRow[];
    participants: read.Participant[];
  } | null>
> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  return guarded(async () => {
    const sql = await getSql();
    const season = await read.getSeasonById(sql, id);
    if (!season || season.mode !== siteMode()) return null;
    const [participants, marks, counts, trades] = await Promise.all([
      read.getParticipants(sql, id),
      read.getMarks(sql, id),
      read.getParticipantCounts(sql, id),
      read.getTradesForSeason(sql, id),
    ]);
    return {
      season,
      participants,
      marks,
      standings: computeStandings(season, participants, marks, counts, trades),
    };
  });
}

export async function loadLedgerDay(day: string): Promise<Loaded<read.LedgerRow[]>> {
  'use cache';
  cacheTag('detail', 'live');
  cacheLife('arena');
  return guarded(async () => read.getLedgerForDate(await getSql(), day));
}

export { istDate };
