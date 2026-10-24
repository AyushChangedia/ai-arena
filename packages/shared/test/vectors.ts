import { GENESIS_HASH, type LedgerEntry } from '../src/ledger-hash';

/** Fixed hash test vector (SPEC §19.1). The canonical form is written out by hand. */
export const VECTOR_ENTRY: LedgerEntry = {
  seq: 1n,
  id: '00000000-0000-4000-8000-000000000001',
  season_id: 'S0',
  participant_id: 'S0-openai',
  round_id: null,
  action_id: null,
  entry_type: 'SEASON_START',
  symbol: null,
  side: null,
  quantity: null,
  price_paise: null,
  price_source: null,
  snapshot_id: null,
  gross_paise: 0n,
  charges: {},
  charges_total_paise: 0n,
  cash_delta_paise: 10000000n,
  cash_after_paise: 10000000n,
  position_after: null,
  avg_cost_after_paise: null,
  realized_pnl_paise: null,
  note: 'Season start',
  ref_seq: null,
  occurred_at: '2026-11-02T04:00:00.000Z',
  reveal_at: new Date('2026-11-02T04:15:00.000Z'),
  prev_hash: GENESIS_HASH,
};

export const VECTOR_CANONICAL =
  '{"action_id":null,"avg_cost_after_paise":null,"cash_after_paise":"10000000","cash_delta_paise":"10000000","charges":{},"charges_total_paise":"0","entry_type":"SEASON_START","gross_paise":"0","id":"00000000-0000-4000-8000-000000000001","note":"Season start","occurred_at":"2026-11-02T04:00:00.000Z","participant_id":"S0-openai","position_after":null,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","price_paise":null,"price_source":null,"quantity":null,"realized_pnl_paise":null,"ref_seq":null,"reveal_at":"2026-11-02T04:15:00.000Z","round_id":null,"season_id":"S0","seq":"1","side":null,"snapshot_id":null,"symbol":null}';
