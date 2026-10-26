import type { TradeNote } from '@arena/db/read';
import { arena } from '@/lib/config';
import { Missing } from '@/components/num';

/**
 * Why a trade happened: the model's reason and exit plan, or the engine's square-off. The model's
 * words are shown as written (italic, quoted); the exit plan was published, never acted on.
 */
export function TradeReason({ reason }: { reason: TradeNote | null }) {
  if (!reason) return <Missing reason="No reason recorded for this trade" />;
  if (reason.decisionStatus === 'SQUARE_OFF')
    return (
      <span className="text-text-2">
        Square-off: the engine closed the position (intraday rule, nothing is held overnight).
      </span>
    );
  if (reason.decisionStatus === 'RETIRED')
    return <span className="text-text-2">Retired: the engine closed the position.</span>;
  return (
    <span className="block">
      {reason.why ? (
        <span className="model-text block">
          “{reason.why.slice(0, arena.display.whyDisplayChars)}”
        </span>
      ) : (
        <span className="block text-text-2">No reason given.</span>
      )}
      {reason.exitPlan ? (
        <span className="model-text block text-text-2">
          Exit plan: {reason.exitPlan.slice(0, arena.display.exitPlanDisplayChars)}
        </span>
      ) : null}
    </span>
  );
}
