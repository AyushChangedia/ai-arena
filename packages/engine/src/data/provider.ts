/** Market data provider interface (SPEC §8). The engine depends only on this. */
export interface Instrument {
  symbol: string; // universe symbol, e.g. TCS
  brokerToken: string;
  exchange: string;
  name: string;
  tickSizePaise: number;
}

export interface IndexInstrument {
  name: string; // e.g. "Nifty 50"
  brokerToken: string;
  exchange: string;
}

export interface InstrumentMaster {
  /** Each universe symbol mapped to exactly one instrument, or the reason it couldn't be. */
  equities: Map<string, Instrument | { error: 'NOT_FOUND' | 'AMBIGUOUS'; candidates: number }>;
  indices: Map<string, IndexInstrument | { error: 'NOT_FOUND' | 'AMBIGUOUS'; candidates: number }>;
}

/** A raw provider quote converted to integer units, before validation. Missing fields are null. */
export interface RawQuote {
  symbol: string;
  ltpPaise: bigint | null;
  bidPaise: bigint | null;
  askPaise: bigint | null;
  openPaise: bigint | null;
  highPaise: bigint | null;
  lowPaise: bigint | null;
  prevClosePaise: bigint | null;
  volume: bigint | null;
  exchangeTime: Date | null;
  parseError: string | null;
}

export interface RawIndexQuote {
  name: string;
  valueX100: bigint | null;
  prevCloseX100: bigint | null;
  exchangeTime: Date | null;
  parseError: string | null;
}

export interface QuoteBatch {
  quotes: RawQuote[];
  indices: RawIndexQuote[];
  /** Sanitised provider responses (no tokens), stored with the snapshot. */
  raw: unknown[];
}

export interface Candle {
  date: string; // YYYY-MM-DD (IST trading date)
  openPaise: bigint;
  highPaise: bigint;
  lowPaise: bigint;
  closePaise: bigint;
  volume: bigint;
}

export interface MarketDataSession {
  quotes(equities: Instrument[], indices: IndexInstrument[]): Promise<QuoteBatch>;
  dailyCandles(instrument: Instrument, fromDate: string, toDate: string): Promise<Candle[]>;
}

export interface MarketDataProvider {
  readonly source: string;
  login(): Promise<MarketDataSession>;
  instruments(universe: string[], indexNames: string[]): Promise<InstrumentMaster>;
}

/** Market data failures, classified for SPEC §13. */
export type DataErrorKind =
  'DATA_LOGIN_FAILED' | 'DATA_SESSION_EXPIRED' | 'DATA_SHAPE_CHANGED' | 'DATA_REQUEST_FAILED';

export class DataError extends Error {
  constructor(
    readonly kind: DataErrorKind,
    message: string,
    readonly fieldPath?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DataError';
  }
}
