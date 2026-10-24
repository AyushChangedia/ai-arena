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
import { must, loadArena, loadFees } from '../../src/config/load';

const arena = must(loadArena());
const fees = must(loadFees());
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
    const s = renderSystemPrompt(arena, fees, {
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
    expect(s).not.toMatch(/OpenAI|Anthropic|Google|Meta|DeepSeek/);
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

describe('output parser (SPEC §9.3)', () => {
  const good = {
    reasoning: 'r',
    actions: [{ side: 'BUY', symbol: 'TCS', quantity: 1, why: 'w' }],
    note_to_self: 'n',
  };
  it('reads the whole content as JSON', () => {
    const r = parseDecisionContent(JSON.stringify(good));
    expect(r).toEqual({
      ok: true,
      decision: {
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
  it('flags missing reasoning and note, and truncates long notes', () => {
    const r = parseDecisionContent(
      JSON.stringify({ actions: [], reasoning: 5, note_to_self: 'é'.repeat(600) }),
    );
    expect(r.ok && r.decision.flags).toEqual(['missing_reasoning', 'note_truncated']);
    expect(r.ok && [...r.decision.noteToSelf].length).toBe(500);
    const r2 = parseDecisionContent('{"actions": []}');
    expect(r2.ok && r2.decision.flags).toEqual(['missing_reasoning', 'missing_note_to_self']);
  });
  it('firstBalancedObject handles escapes and unbalanced input', () => {
    expect(firstBalancedObject('x {"a":"\\"}"} y')).toBe('{"a":"\\"}"}');
    expect(firstBalancedObject('{"a": {')).toBeNull();
    expect(firstBalancedObject('none')).toBeNull();
  });
});
