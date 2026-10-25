/**
 * Participant page slugs: every lab slot in config/roster-rules.json, then the two benchmarks.
 * Imported by the proxy too, so it reads the JSON directly instead of pulling in the zod schemas.
 */
import rules from '../../../../config/roster-rules.json';

export const LAB_SLUGS: readonly string[] = Object.keys(rules.slots);
export const PARTICIPANT_SLUGS: readonly string[] = [...LAB_SLUGS, 'monkey', 'nifty50'];
