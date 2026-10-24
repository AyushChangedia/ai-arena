import { canonicalJson } from '@arena/shared/canonical';
import { hashableEntry, type LedgerEntry } from '@arena/shared/ledger-hash';
import { loadLedgerDay } from '@/lib/data';

/** A day's revealed ledger entries in canonical form, one per line (the same form as public-data/…/ledger.jsonl). */
export async function GET(_req: Request, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Bad date', { status: 400 });
  const r = await loadLedgerDay(date);
  if (!r.ok)
    return new Response("The arena's records aren't reachable right now.", { status: 503 });
  const body = r.data
    .map((e) => {
      const entry: LedgerEntry = {
        seq: e.seq,
        id: e.id,
        season_id: e.seasonId,
        participant_id: e.participantId,
        round_id: e.roundId,
        action_id: e.actionId,
        entry_type: e.entryType as LedgerEntry['entry_type'],
        symbol: e.symbol,
        side: e.side,
        quantity: e.quantity,
        price_paise: e.pricePaise,
        price_source: e.priceSource,
        snapshot_id: e.snapshotId,
        gross_paise: e.grossPaise,
        charges: e.charges,
        charges_total_paise: e.chargesTotalPaise,
        cash_delta_paise: e.cashDeltaPaise,
        cash_after_paise: e.cashAfterPaise,
        position_after: e.positionAfter,
        avg_cost_after_paise: e.avgCostAfterPaise,
        realized_pnl_paise: e.realizedPnlPaise,
        note: e.note,
        ref_seq: e.refSeq,
        occurred_at: e.occurredAt,
        reveal_at: e.revealAt,
        prev_hash: e.prevHash,
      };
      return canonicalJson({ ...hashableEntry(entry), hash: e.hash });
    })
    .join('\n');
  return new Response(body ? `${body}\n` : '', {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="ledger-${date}.jsonl"`,
    },
  });
}
