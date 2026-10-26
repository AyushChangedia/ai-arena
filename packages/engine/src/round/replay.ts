/**
 * Replay (SPEC §19.4): recompute a stored round from its stored fill snapshot and stored model answers,
 * and compare the resulting ledger hashes with the stored ones.
 */
import type pg from 'pg';
import type { FeesConfig, ArenaConfig } from '@arena/shared/schemas';
import { computeEntryHash, type LedgerEntry } from '@arena/shared/ledger-hash';
import { executeActions } from '../core/execute';
import { rebuildFromLedger, tradeDraft, adjustDraft, type LedgerDraft } from '../core/ledger';
import { parseDecisionContent } from '../llm/parse';
import { loadSnapshot } from '../data/snapshot';
import { monkeyDecide } from '../core/monkey';
import { loadLedger } from './ledger-store';
import { pricesWithFallback } from './context';
import { tradingLimits } from './runner';

export interface ReplayResult {
  roundId: string;
  compared: number;
  mismatches: string[];
  ok: boolean;
}

export async function replayRound(
  db: pg.Pool,
  roundId: string,
  arena: ArenaConfig,
  fees: FeesConfig,
  universeAtRound: string[],
): Promise<ReplayResult> {
  const mismatches: string[] = [];
  const round = (
    await db.query(
      "SELECT id, season_id, to_char(trading_date,'YYYY-MM-DD') AS d, decision_snapshot_id, fill_snapshot_id, started_at FROM rounds WHERE id = $1",
      [roundId],
    )
  ).rows[0];
  if (!round) throw new Error(`round ${roundId} not found`);
  if (!round.fill_snapshot_id)
    return {
      roundId,
      compared: 0,
      mismatches: ['round has no fill snapshot (nothing was executed)'],
      ok: false,
    };
  const fill = (await loadSnapshot(db, round.fill_snapshot_id))!;
  const decisionSnap = round.decision_snapshot_id
    ? await loadSnapshot(db, round.decision_snapshot_id)
    : null;
  const all = await loadLedger(db);
  const inRound = all.filter((e) => e.round_id === roundId && e.entry_type !== 'SEASON_START');
  const firstSeq = inRound.length ? BigInt(inRound[0]!.seq) : null;
  const decisions = (
    await db.query(
      "SELECT id, participant_id, status, raw_response, parsed, rng_seed FROM decisions WHERE round_id = $1 AND status IN ('OK','RETIRED','SQUARE_OFF')",
      [roundId],
    )
  ).rows;
  const fillQuotes = new Map(
    fill.quotes
      .filter((q) => q.valid)
      .map((q) => [
        q.symbol,
        {
          ltpPaise: q.ltpPaise!,
          bidPaise: q.bidPaise,
          askPaise: q.askPaise,
          depthAvailable: q.depthAvailable,
        },
      ]),
  );
  const symbols = [...new Set([...universeAtRound, ...fill.quotes.map((q) => q.symbol)])];
  const valuation = await pricesWithFallback(db, fill, symbols);
  const flags = (
    await db.query<{ symbol: string }>(
      'SELECT symbol FROM symbol_flags WHERE set_at <= $1 AND (cleared_at IS NULL OR cleared_at > $1)',
      [fill.finishedAt],
    )
  ).rows.map((r) => r.symbol);
  const corp = (
    await db.query<{ symbol: string }>(
      'SELECT symbol FROM corporate_actions WHERE ex_date = $1 AND (applied_at IS NULL OR applied_at > $2)',
      [round.d, fill.finishedAt],
    )
  ).rows.map((r) => r.symbol);
  let compared = 0;
  for (const d of decisions) {
    const before = all.filter(
      (e) =>
        e.participant_id === d.participant_id && (firstSeq === null || BigInt(e.seq) < firstSeq),
    );
    const portfolio = rebuildFromLedger(before).get(d.participant_id) ?? {
      cashPaise: 0n,
      positions: new Map(),
    };
    let actions: unknown[];
    const forced = d.status === 'RETIRED' || d.status === 'SQUARE_OFF';
    if (forced) actions = (d.parsed?.liquidation as unknown[]) ?? [];
    else if (d.rng_seed) {
      // The Monkey: regenerate from its seed and the decision snapshot, and check it matches what was stored.
      const tradeable = new Map(
        (decisionSnap?.quotes ?? [])
          .filter(
            (q) =>
              q.valid &&
              universeAtRound.includes(q.symbol) &&
              !flags.includes(q.symbol) &&
              !corp.includes(q.symbol),
          )
          .map((q) => [q.symbol, q.ltpPaise!]),
      );
      const m = await monkeyDecide({
        roundId,
        portfolio,
        tradeable,
        ltp: (s) => decisionSnap?.quotes.find((q) => q.symbol === s && q.valid)?.ltpPaise ?? null,
        allowShort: tradingLimits(arena).allowShort,
      });
      if (m.seedHex !== d.rng_seed)
        mismatches.push(`monkey seed ${m.seedHex} != stored ${d.rng_seed}`);
      actions = m.actions;
    } else {
      const parsed = parseDecisionContent(d.parsed?.content ?? null, {
        noteMaxChars: arena.display.noteToSelfMaxChars,
      });
      if (!parsed.ok) {
        mismatches.push(`${d.participant_id}: stored answer no longer parses (${parsed.error})`);
        continue;
      }
      actions = parsed.decision.actions;
    }
    const soldBefore = new Set(
      all
        .filter(
          (e) =>
            e.participant_id === d.participant_id &&
            e.entry_type === 'SELL' &&
            (firstSeq === null || BigInt(e.seq) < firstSeq) &&
            e.round_id !== null &&
            e.symbol,
        )
        .filter((e) => isSameDay(e, round.d))
        .map((e) => e.symbol!),
    );
    const res = executeActions(actions, portfolio, {
      universe: new Set(forced ? symbols : universeAtRound),
      fillQuotes,
      valuationPrice: (s) => valuation.get(s) ?? null,
      suspended: forced ? new Set() : new Set([...flags, ...corp]),
      soldToday: soldBefore,
      ...tradingLimits(arena),
      maxActions: forced
        ? Math.max(arena.limits.maxActionsPerRound, actions.length, 1)
        : arena.limits.maxActionsPerRound,
      forced,
      fees,
    });
    const stored = inRound.filter((e) => e.participant_id === d.participant_id);
    const storedActions = (
      await db.query<{ id: string; position: number }>(
        'SELECT id, position FROM actions WHERE decision_id = $1',
        [d.id],
      )
    ).rows;
    const drafts: LedgerDraft[] = [];
    let i = 0;
    for (const o of res.outcomes.filter((x) => x.fill)) {
      const s = stored[i++];
      const actionId = storedActions.find((a) => a.position === o.position)?.id ?? 'missing';
      if (!s) {
        mismatches.push(
          `${d.participant_id}: replay produced an extra fill (${o.side} ${o.symbol})`,
        );
        continue;
      }
      drafts.push(
        tradeDraft(
          {
            id: s.id,
            seasonId: s.season_id,
            participantId: s.participant_id,
            roundId,
            occurredAt: new Date(s.occurred_at),
            revealAt: new Date(s.reveal_at),
          },
          {
            actionId,
            side: o.side!,
            symbol: o.symbol!,
            quantity: o.quantity!,
            pricePaise: o.fill!.pricePaise,
            priceSource: o.fill!.priceSource,
            snapshotId: fill.id,
            grossPaise: o.fill!.grossPaise,
            charges: o.fill!.charges,
            chargesTotalPaise: o.fill!.chargesTotalPaise,
            cashDeltaPaise: o.fill!.cashDeltaPaise,
            cashAfterPaise: o.fill!.cashAfterPaise,
            positionAfter: o.fill!.positionAfter,
            avgCostAfterPaise: o.fill!.avgCostAfterPaise,
            realizedPnlPaise: o.fill!.realizedPnlPaise,
          },
        ),
      );
    }
    const retire = stored.find((e) => e.entry_type === 'RETIRE');
    if (retire)
      drafts.push(
        adjustDraft(
          {
            id: retire.id,
            seasonId: retire.season_id,
            participantId: retire.participant_id,
            roundId,
            occurredAt: new Date(retire.occurred_at),
            revealAt: new Date(retire.reveal_at),
          },
          {
            type: 'RETIRE',
            symbol: null,
            quantityDelta: null,
            grossPaise: 0n,
            cashDeltaPaise: 0n,
            cashAfterPaise: res.state.cashPaise,
            positionAfter: null,
            avgCostAfterPaise: null,
            note: retire.note ?? '',
          },
        ),
      );
    if (drafts.length !== stored.length)
      mismatches.push(
        `${d.participant_id}: replay produced ${drafts.length} entries, stored ${stored.length}`,
      );
    for (const [j, dr] of drafts.entries()) {
      const s = stored[j];
      if (!s) continue;
      const e: LedgerEntry = { ...dr, seq: s.seq, prev_hash: s.prev_hash };
      const h = await computeEntryHash(e);
      compared++;
      if (h !== s.hash)
        mismatches.push(
          `seq ${String(s.seq)}: replay hash ${h.slice(0, 12)}… != stored ${s.hash!.slice(0, 12)}…`,
        );
    }
  }
  return { roundId, compared, mismatches, ok: mismatches.length === 0 };
}

function isSameDay(e: LedgerEntry, isoDate: string): boolean {
  const d = new Date(e.occurred_at);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === isoDate;
}
