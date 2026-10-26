import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  computeCharges,
  costPctString,
  chargesToJson,
  flatPerOrderPaise,
} from '../../src/core/fees';
import { fillPrice } from '../../src/core/prices';
import { must, loadFees } from '../../src/config/load';

/** The equity-delivery profile S0 ran under, kept as a fixture: the engine still supports it. */
const fees = must(loadFees(join(__dirname, '../fixtures/delivery')));
/** The committed profile: equity intraday with ₹20 brokerage per order (owner's choice, 2026-10-26). */
const intraday = must(loadFees());

describe('charges, intraday golden cases (paise)', () => {
  // Brokerage ₹20 flat per order; STT 1/4000 on sells; exchange 297/10^7; SEBI 1/10^6; IPFT 1/10^6;
  // stamp 3/100000 on buys; GST 18% of (brokerage + exchange + SEBI + IPFT); no DP charge.
  it('is the committed profile', () => {
    expect(intraday.profile).toBe('discount_broker_equity_intraday');
    expect(intraday.dpCharge).toBeNull();
  });
  it('BUY ₹1,00,000', () => {
    const c = computeCharges(intraday, 'BUY', 10_000_000n, { dpApplies: false });
    // brokerage 20.00; exch 2.97; SEBI 0.10; IPFT 0.10; stamp 3.00; GST 18% × 23.17 = 4.1706 → 4.17
    expect(c.lines).toEqual({
      brokerage: 2000n,
      stt: 0n,
      exchange: 297n,
      sebi: 10n,
      ipft: 10n,
      stamp: 300n,
      gst: 417n,
      dp: 0n,
    });
    expect(c.total).toBe(3034n);
  });
  it('SELL ₹1,00,000: STT on the sell side, no DP charge even on the first sell', () => {
    const c = computeCharges(intraday, 'SELL', 10_000_000n, { dpApplies: true });
    // brokerage 20.00; STT 25.00; exch 2.97; SEBI 0.10; IPFT 0.10; GST 4.17
    expect(c.lines).toEqual({
      brokerage: 2000n,
      stt: 2500n,
      exchange: 297n,
      sebi: 10n,
      ipft: 10n,
      stamp: 0n,
      gst: 417n,
      dp: 0n,
    });
    expect(c.total).toBe(5234n);
  });
  it('SELL 1 at ₹100.25: the ₹20 brokerage dominates a small order', () => {
    const c = computeCharges(intraday, 'SELL', 10_025n, { dpApplies: true });
    // STT 2.50625 → 3 paise; exch 0.30, SEBI 0.01, IPFT 0.01 paise → 0; GST 18% × 2000.3178 = 360.06 → 360
    expect(c.lines).toEqual({
      brokerage: 2000n,
      stt: 3n,
      exchange: 0n,
      sebi: 0n,
      ipft: 0n,
      stamp: 0n,
      gst: 360n,
      dp: 0n,
    });
    expect(c.total).toBe(2363n);
  });
  it('charges the flat brokerage on a zero-value order too (it is per order)', () => {
    expect(computeCharges(intraday, 'BUY', 0n, { dpApplies: false }).total).toBe(2360n);
  });
  it('reports the flat amount and the percentages separately for the prompt', () => {
    expect(flatPerOrderPaise(intraday, 'BUY')).toBe(2360n); // ₹20 + 18% GST
    expect(flatPerOrderPaise(intraday, 'SELL')).toBe(2360n);
    expect(costPctString(intraday, 'BUY')).toBe('0.007'); // 0.0067406%
    expect(costPctString(intraday, 'SELL')).toBe('0.029'); // 0.0287406%
    expect(flatPerOrderPaise(fees, 'BUY')).toBe(0n);
  });
});

/**
 * Delivery golden cases, computed by hand from the SPEC §11.5 rates (see docs in PROGRESS.md):
 * STT 1/1000, exchange 297/10^7, SEBI 1/10^6, IPFT 1/10^6, stamp 3/20000 (buy), GST 18% of
 * (brokerage + exchange + SEBI + IPFT) on the unrounded base, DP ₹15.93 on the first sell per symbol per day.
 */
describe('charges, delivery golden cases (paise)', () => {
  it('BUY ₹1,00,000', () => {
    const c = computeCharges(fees, 'BUY', 10_000_000n, { dpApplies: false });
    // STT 100.00, exch 2.97, SEBI 0.10, IPFT 0.10, stamp 15.00, GST 18% × 3.17 = 0.5706 → 0.57
    expect(c.lines).toEqual({
      brokerage: 0n,
      stt: 10000n,
      exchange: 297n,
      sebi: 10n,
      ipft: 10n,
      stamp: 1500n,
      gst: 57n,
      dp: 0n,
    });
    expect(c.total).toBe(11874n);
  });
  it('SELL ₹1,00,000, first sell of the day', () => {
    const c = computeCharges(fees, 'SELL', 10_000_000n, { dpApplies: true });
    expect(c.lines).toEqual({
      brokerage: 0n,
      stt: 10000n,
      exchange: 297n,
      sebi: 10n,
      ipft: 10n,
      stamp: 0n,
      gst: 57n,
      dp: 1593n,
    });
    expect(c.total).toBe(11967n);
  });
  it('SELL ₹1,00,000, second sell of the same symbol that day: no DP', () => {
    expect(computeCharges(fees, 'SELL', 10_000_000n, { dpApplies: false }).total).toBe(10374n);
  });
  it('BUY 12 at ₹3,412.50 (₹40,950)', () => {
    const c = computeCharges(fees, 'BUY', 4_095_000n, { dpApplies: false });
    // STT 40.95; exch 1.216215 → 1.22; SEBI 0.04095 → 0.04; IPFT 0.04; stamp 6.1425 → 6.14; GST 18% × 1.298115 = 0.2336607 → 0.23
    expect(c.lines).toEqual({
      brokerage: 0n,
      stt: 4095n,
      exchange: 122n,
      sebi: 4n,
      ipft: 4n,
      stamp: 614n,
      gst: 23n,
      dp: 0n,
    });
    expect(c.total).toBe(4862n);
  });
  it('SELL 1 at ₹100.25: most charges round to zero, DP dominates', () => {
    const c = computeCharges(fees, 'SELL', 10_025n, { dpApplies: true });
    expect(c.lines).toEqual({
      brokerage: 0n,
      stt: 10n,
      exchange: 0n,
      sebi: 0n,
      ipft: 0n,
      stamp: 0n,
      gst: 0n,
      dp: 1593n,
    });
  });
  it('BUY ₹10,00,000: large order', () => {
    const c = computeCharges(fees, 'BUY', 100_000_000n, { dpApplies: false });
    // STT 1000.00; exch 29.70; SEBI 1.00; IPFT 1.00; stamp 150.00; GST 18% × 31.70 = 5.706 → 5.71
    expect(c.lines).toEqual({
      brokerage: 0n,
      stt: 100000n,
      exchange: 2970n,
      sebi: 100n,
      ipft: 100n,
      stamp: 15000n,
      gst: 571n,
      dp: 0n,
    });
  });
  it('rounds each charge half-up per order', () => {
    expect(computeCharges(fees, 'BUY', 1_500n, { dpApplies: false }).lines.stt).toBe(2n); // 1.5 → 2
    expect(computeCharges(fees, 'BUY', 1_499n, { dpApplies: false }).lines.stt).toBe(1n);
    expect(computeCharges(fees, 'BUY', 0n, { dpApplies: false }).total).toBe(0n);
    expect(() => computeCharges(fees, 'BUY', -1n, { dpApplies: false })).toThrow();
  });
  it('renders the approximate cost percentages for the prompt', () => {
    expect(costPctString(fees, 'BUY')).toBe('0.119'); // 0.118737%
    expect(costPctString(fees, 'SELL')).toBe('0.104'); // 0.103737%
  });
  it('serialises charges as strings', () => {
    expect(
      chargesToJson(computeCharges(fees, 'BUY', 10_000_000n, { dpApplies: false }).lines).stt,
    ).toBe('10000');
  });
});

describe('fill prices (SPEC §11.4)', () => {
  const q = { ltpPaise: 100_000n, bidPaise: 99_950n, askPaise: 100_050n, depthAvailable: true };
  it('uses the best ask for buys and best bid for sells', () => {
    expect(fillPrice(q, 'BUY', 5)).toEqual({ pricePaise: 100_050n, source: 'ask' });
    expect(fillPrice(q, 'SELL', 5)).toEqual({ pricePaise: 99_950n, source: 'bid' });
  });
  it('falls back to LTP ± 5 bps rounded to the nearest paisa', () => {
    const nd = { ...q, depthAvailable: false, bidPaise: null, askPaise: null };
    expect(fillPrice(nd, 'BUY', 5)).toEqual({ pricePaise: 100_050n, source: 'ltp_slippage' });
    expect(fillPrice(nd, 'SELL', 5)).toEqual({ pricePaise: 99_950n, source: 'ltp_slippage' });
    expect(fillPrice({ ...nd, ltpPaise: 341_250n }, 'BUY', 5).pricePaise).toBe(341_421n); // 3414.20625 → 3414.21
  });
});
