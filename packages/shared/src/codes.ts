/** Rejection codes (SPEC §11.3). `modelFault` decides whether a code counts against the model. */
export const REJECTION_CODES = {
  MALFORMED_ACTION: { modelFault: true, label: 'Malformed action' },
  INVALID_SIDE: { modelFault: true, label: 'Side was not BUY or SELL' },
  INVALID_QUANTITY: { modelFault: true, label: 'Quantity was not a whole number of at least 1' },
  UNKNOWN_SYMBOL: { modelFault: true, label: 'Unknown symbol' },
  NOT_IN_UNIVERSE_FOR_BUY: { modelFault: true, label: 'Stock left the index: can sell, can’t buy' },
  DUPLICATE_ACTION: { modelFault: true, label: 'Duplicate action' },
  CONFLICTING_SIDES: { modelFault: true, label: 'Bought a stock it was also selling' },
  TOO_MANY_ACTIONS: { modelFault: true, label: 'Too many actions' },
  INSUFFICIENT_HOLDINGS: { modelFault: true, label: 'Sold more than it held' },
  INSUFFICIENT_CASH: { modelFault: true, label: 'Not enough cash' },
  CONCENTRATION_LIMIT: { modelFault: true, label: 'Over the 25% limit' },
  PRICE_UNAVAILABLE: { modelFault: false, label: 'No price this round' },
  SYMBOL_SUSPENDED: { modelFault: false, label: 'Stock under review' },
} as const;
export type RejectionCode = keyof typeof REJECTION_CODES;

/** Decision statuses (SPEC §9.5, §12, §13). */
export const DECISION_STATUSES = [
  'PENDING',
  'OK',
  'INVALID_RESPONSE',
  'MISSED_CONFIG',
  'MISSED_PROVIDER',
  'MODEL_MISMATCH',
  'SKIPPED_BUDGET',
  'SKIPPED_PAUSED',
  'NOT_EXECUTED_DATA',
  'EXECUTION_FAILED',
  'MISSED_ABORTED',
  'RETIRED',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Round statuses. */
export const ROUND_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'SKIPPED_DATA',
  'SKIPPED_PAUSED',
  'MISSED_SCHEDULE',
  'ABORTED',
] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** Reasons a round was skipped for data (SPEC §13). */
export const DATA_SKIP_REASONS = [
  'DATA_LOGIN_FAILED',
  'DATA_DEGRADED',
  'MARKET_CLOSED_UNSCHEDULED',
  'DATA_SHAPE_CHANGED',
] as const;
export type DataSkipReason = (typeof DATA_SKIP_REASONS)[number];

/** LLM error classes (SPEC §9.5). */
export const LLM_ERROR_CLASSES = [
  'CONFIG_AUTH',
  'CREDITS_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'TRANSIENT',
  'BAD_OUTPUT',
  'MODEL_MISMATCH',
] as const;
export type LlmErrorClass = (typeof LLM_ERROR_CLASSES)[number];

/** Plain-words verdicts for a decision status (SPEC §16.4 vocabulary). */
export const STATUS_PUBLIC_TEXT: Record<DecisionStatus, string> = {
  PENDING: 'Waiting',
  OK: 'Answered',
  INVALID_RESPONSE: 'Unreadable answer',
  MISSED_CONFIG: 'Missed round: model offline',
  MISSED_PROVIDER: 'Missed round: provider timeout',
  MODEL_MISMATCH: 'Missed round: wrong model served',
  SKIPPED_BUDGET: 'Paused (budget)',
  SKIPPED_PAUSED: 'Paused',
  NOT_EXECUTED_DATA: 'Decisions made, not executed: market data failed',
  EXECUTION_FAILED: 'Not executed: recording failed',
  MISSED_ABORTED: 'Round aborted',
  RETIRED: 'Retired',
};
