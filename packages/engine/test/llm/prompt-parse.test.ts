import { describe, it, expect } from 'vitest';
import {
  renderSystemPrompt,
  renderMarketBlock,
  renderPrivateBlock,
  renderUserMessage,
  historyLine,
  pct2,
} from '../../src/llm/prompt';
import { parseDecisionContent, firstBalancedObject } from '../../src/llm/parse';
import { join } from 'node:path';
import { must, loadArena, loadFees } from '../../src/config/load';

/** The committed rules: intraday long-short, ₹20 brokerage per order (since 2026-10-26). */
const arena = must(loadArena());
const fees = must(loadFees());
/** S0's rules, kept as a fixture: long-only delivery. */
const DELIVERY = join(__dirname, '../fixtures/delivery');
const deliveryArena = must(loadArena(DELIVERY));
const deliveryFees = must(loadFees(DELIVERY));
const ROUND_TIMES = [
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
];

describe('prompt renderer (SPEC §10)', () => {
  it('renders the system message from config', () => {
    const s = renderSystemPrompt(deliveryArena, deliveryFees, {
      seasonStart: '2026-11-02',
      seasonEnd: '2026-11-30',
      seasonTradingDays: 20,
      roundTimes: ROUND_TIMES,
    });
    expect(s).toMatchSnapshot();
    expect(s).toContain(
      'about 0.119% of trade value on a BUY; about 0.104% on a SELL plus 15.93 INR per stock',
    );
    expect(s).toContain('above 25% of your total portfolio value');
    expect(s).toContain('2. Long-only cash delivery: no short selling');
    expect(s).not.toMatch(/OpenAI|Anthropic|Google|Meta|DeepSeek/);
  });
  it('renders the intraday long-short rules, the square-off and the ₹20 brokerage', () => {
    const s = renderSystemPrompt(arena, fees, {
      seasonStart: '2026-10-27',
      seasonEnd: '2026-11-24',
      seasonTradingDays: 20,
      roundTimes: ['09:30', '11:00', '12:30', '14:00'],
    });
    expect(s).toMatchSnapshot();
    expect(s).toContain(
      '2. Intraday only, long or short. BUY to open or add to a long position; SELL to open or add to a short position',
    );
    expect(s).toContain(
      '3. Square-off: from 15:00 IST (by 15:15 at the latest) every open position is closed automatically',
    );
    expect(s).toContain('Nothing is held overnight; every trading day starts in cash.');
    expect(s).toContain(
      'longs plus shorts at market value may not be more than 100% of your total value.',
    );
    expect(s).toContain(
      'Costs: 23.60 INR per order (brokerage with GST), plus about 0.007% of trade value on a BUY and about 0.029% on a SELL.',
    );
    expect(s).toContain('at 09:30, 11:00, 12:30, 14:00 IST, then the square-off at 15:00 IST.');
    expect(s).toContain('"strategy": "<your trading approach, up to 600 characters>"');
    expect(s).toContain(
      '"exit_plan": "<when you will close it: a target price, a stop price or a time',
    );
    expect(s).toContain('An exit plan is not an order: the engine never acts on it');
    expect(s).not.toMatch(/DP charge|per stock on each day|OpenAI|Anthropic|Google|Meta|DeepSeek/);
  });
  it('renders the per-round user message', () => {
    const market = renderMarketBlock({
      snapshotTimeIst: '11:29',
      niftyX100: 2_432_145n,
      niftyPrevCloseX100: 2_420_000n,
      vixX100: 1_322n,
      rows: [
        {
          symbol: 'TCS',
          ltpPaise: 341_250n,
          prevClosePaise: 340_000n,
          openPaise: 340_500n,
          highPaise: 342_000n,
          lowPaise: 339_900n,
          volume: 1_234_567n,
          avgVol20d: 2_000_000n,
          ret5d: 0.0123,
          ret20d: -0.0456,
          sma20Paise: 338_012n,
          sma50Paise: 335_500n,
          rsi14: 55.5,
        },
        {
          symbol: 'INFY',
          ltpPaise: 150_000n,
          prevClosePaise: 152_000n,
          openPaise: null,
          highPaise: null,
          lowPaise: null,
          volume: null,
          avgVol20d: null,
          ret5d: null,
          ret20d: null,
          sma20Paise: null,
          sma50Paise: null,
          rsi14: null,
        },
      ],
      noPrice: [{ symbol: 'ITC', reason: 'stale quote' }],
    });
    const priv = renderPrivateBlock({
      round: 5,
      roundsToday: 12,
      weekday: 'Tuesday',
      date: '2026-11-03',
      time: '11:30',
      seasonDay: 2,
      seasonDays: 20,
      nextRound: '12:00 IST',
      cashPaise: 6_000_000n,
      startingCashPaise: 10_000_000n,
      holdings: [{ symbol: 'TCS', quantity: 10, avgCostPaise: 330_000n, lastPricePaise: 341_250n }],
      history: [
        historyLine('2026-11-03 11:00', null, [
          {
            side: 'BUY',
            symbol: 'TCS',
            quantity: 10,
            status: 'executed',
            pricePaise: 341_250n,
            rejectDetail: null,
            sideRaw: 'BUY',
            symbolRaw: 'TCS',
          },
          {
            side: 'SELL',
            symbol: 'INFY',
            quantity: 5,
            status: 'rejected',
            pricePaise: null,
            rejectDetail: 'you held 0 INFY',
            sideRaw: 'SELL',
            symbolRaw: 'INFY',
          },
        ]),
        historyLine('2026-11-03 10:30', null, []),
        historyLine('2026-11-03 10:00', 'missed (provider timeout)', []),
      ],
      noteToSelf: 'Watch IT.',
    });
    const user = renderUserMessage(priv, market);
    expect(user).toMatchSnapshot();
    expect(market).toContain('INFY,1500.00,-1.32,,,,1520.00,,,,,,,');
    expect(market).toContain('NIFTY 50: 24321.45 (0.50% today), India VIX: 13.22');
    expect(user).toContain(
      '2026-11-03 11:00: BUY 10 TCS filled at 3412.50 | SELL 5 INFY rejected: you held 0 INFY',
    );
    expect(user).not.toMatch(/₹|,\d{2},\d{3}/);
  });
  it('handles an empty portfolio, no history and no note', () => {
    const p = renderPrivateBlock({
      round: 1,
      roundsToday: 12,
      weekday: 'Monday',
      date: '2026-11-02',
      time: '09:30',
      seasonDay: 1,
      seasonDays: 20,
      nextRound: '10:00 IST',
      cashPaise: 10_000_000n,
      startingCashPaise: 10_000_000n,
      holdings: [],
      history: [],
      noteToSelf: '  ',
    });
    expect(p).toContain(
      'Holdings (symbol, qty, avg_price, last_price, value, weight_pct, unrealized_pnl):\nnone',
    );
    expect(p).toContain('YOUR LAST 5 ROUNDS (newest first)\nnone');
    expect(p).toContain('YOUR NOTE TO SELF FROM LAST ROUND\nnone');
    expect(p).toContain('Total value: 100000.00 INR (0.00% since season start)');
    const m = renderMarketBlock({
      snapshotTimeIst: '09:29',
      niftyX100: 100n,
      niftyPrevCloseX100: 100n,
      vixX100: null,
      rows: [],
      noPrice: [],
    });
    expect(m).toContain('NO_PRICE this round: none');
    expect(m).not.toContain('VIX');
    expect(
      historyLine('x', null, [
        {
          side: null,
          symbol: null,
          quantity: null,
          status: 'rejected',
          pricePaise: null,
          rejectDetail: null,
          sideRaw: null,
          symbolRaw: null,
        },
      ]),
    ).toBe('x: ? ? ? rejected: invalid');
    expect(
      historyLine('x', null, [
        {
          side: 'BUY',
          symbol: 'A',
          quantity: 1,
          status: 'executed',
          pricePaise: null,
          rejectDetail: null,
          sideRaw: null,
          symbolRaw: null,
        },
      ]),
    ).toBe('x: BUY 1 A filled at ?');
    expect(pct2(-0.00001)).toBe('0.00');
  });
});

describe('intraday private block', () => {
  it('shows signed positions, exposure and the square-off time', () => {
    const b = renderPrivateBlock({
      round: 4,
      roundsToday: 4,
      weekday: 'Tuesday',
      date: '2026-10-27',
      time: '14:00',
      seasonDay: 1,
      seasonDays: 20,
      nextRound: 'Wednesday 2026-10-28 09:30 IST',
      cashPaise: 12_000_000n,
      startingCashPaise: 10_000_000n,
      holdings: [
        { symbol: 'TCS', quantity: -5, avgCostPaise: 341_000n, lastPricePaise: 340_000n },
        { symbol: 'INFY', quantity: 10, avgCostPaise: 150_000n, lastPricePaise: 151_000n },
      ],
      history: [],
      noteToSelf: null,
      squareOffAt: '15:00',
      maxGrossExposurePct: 100,
    });
    expect(b).toContain('Next round: Wednesday 2026-10-28 09:30 IST. Square-off: 15:00 IST today.');
    // Positions value: −5 × 3400 + 10 × 1510 = −1900; total 120000 − 1900 = 118100; exposure 17000 + 15100 = 32100.
    expect(b).toContain('Positions value (longs minus shorts): -1900.00 INR');
    expect(b).toContain('Total value: 118100.00 INR (18.10% since season start)');
    expect(b).toContain(
      'Exposure (longs plus shorts): 32100.00 INR (27.18% of total value; limit 100%)',
    );
    expect(b).toContain('a negative qty is a short');
    // A short gains when the price falls: (3400 − 3410) × −5 = +50.
    expect(b).toContain('TCS, -5, 3410.00, 3400.00, -17000.00, -14.39, 50.00');
    expect(b).toContain('INFY, 10, 1500.00, 1510.00, 15100.00, 12.79, 100.00');
  });
});

describe('output parser (SPEC §9.3)', () => {
  const good = {
    strategy: 's',
    reasoning: 'r',
    actions: [{ side: 'BUY', symbol: 'TCS', quantity: 1, why: 'w', exit_plan: 'e' }],
    note_to_self: 'n',
  };
  it('reads the whole content as JSON', () => {
    const r = parseDecisionContent(JSON.stringify(good));
    expect(r).toEqual({
      ok: true,
      decision: {
        strategy: 's',
        reasoning: 'r',
        actions: good.actions,
        noteToSelf: 'n',
        flags: [],
        method: 'whole',
      },
    });
  });
  it('reads a single fenced code block', () => {
    const r = parseDecisionContent(
      `Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nThanks`,
    );
    expect(r.ok && r.decision.method).toBe('fenced');
  });
  it('reads the first balanced object from prose, with braces inside strings', () => {
    const tricky = { ...good, reasoning: 'a } brace and "quotes" {' };
    const r = parseDecisionContent(
      `My answer is ${JSON.stringify(tricky)} and that is final {not json}`,
    );
    expect(r.ok && r.decision.reasoning).toBe('a } brace and "quotes" {');
    expect(r.ok && r.decision.method).toBe('braces');
  });
  it('falls through when two fenced blocks make the fence ambiguous', () => {
    const r = parseDecisionContent(
      `\`\`\`\n{"x":1}\n\`\`\`\n\`\`\`\n${JSON.stringify(good)}\n\`\`\``,
    );
    expect(r.ok).toBe(false); // first balanced object is {"x":1}, which has no actions
  });
  it.each([
    [null, /empty/],
    ['   ', /empty/],
    ['I would rather not trade today.', /no JSON object/],
    ['[1,2]', /not an object/],
    ['{"reasoning": "x"}', /no "actions" array/],
    ['{"actions": "BUY TCS"}', /no "actions" array/],
    ['{"actions": [', /no JSON object/],
  ])('rejects %j', (content, re) => {
    const r = parseDecisionContent(content as string | null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
  it('flags missing strategy, reasoning and note, and truncates long notes', () => {
    const r = parseDecisionContent(
      JSON.stringify({ strategy: 's', actions: [], reasoning: 5, note_to_self: 'é'.repeat(600) }),
    );
    expect(r.ok && r.decision.flags).toEqual(['missing_reasoning', 'note_truncated']);
    expect(r.ok && [...r.decision.noteToSelf].length).toBe(500);
    const r2 = parseDecisionContent('{"actions": []}');
    expect(r2.ok && r2.decision.flags).toEqual([
      'missing_strategy',
      'missing_reasoning',
      'missing_note_to_self',
    ]);
    // A missing strategy is published as missing; it never blocks the trades.
    const r3 = parseDecisionContent(
      JSON.stringify({ reasoning: 'r', actions: good.actions, note_to_self: 'n' }),
    );
    expect(r3.ok && r3.decision.strategy).toBe('');
    expect(r3.ok && r3.decision.actions).toEqual(good.actions);
  });
  it('firstBalancedObject handles escapes and unbalanced input', () => {
    expect(firstBalancedObject('x {"a":"\\"}"} y')).toBe('{"a":"\\"}"}');
    expect(firstBalancedObject('{"a": {')).toBeNull();
    expect(firstBalancedObject('none')).toBeNull();
  });
});
