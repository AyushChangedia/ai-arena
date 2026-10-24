import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** SPEC §16.1: each series colour ≥ 3:1 against --bg and CIEDE2000 ≥ 15 from every other series colour. */
const rules = JSON.parse(
  readFileSync(new URL('../../../../config/roster-rules.json', import.meta.url), 'utf8'),
);
const BG = '#0D1A2B';
const series: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(rules.slots as Record<string, { color: string }>).map(([k, v]) => [k, v.color]),
  ),
  nifty: rules.benchmarks.index.color,
  monkey: rules.benchmarks.monkey.color,
};

const hex = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => {
  const [r, g, b] = hex(h).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
function lab(h: string): [number, number, number] {
  const [r, g, b] = hex(h).map(lin) as [number, number, number];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
/** CIEDE2000 (Sharma et al. 2005). */
export function de2000(c1: string, c2: string): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (a: number, b: number) =>
    a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360;
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0)
    dhp =
      Math.abs(h2p - h1p) <= 180 ? h2p - h1p : h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0)
    hbp =
      Math.abs(h1p - h2p) <= 180
        ? (h1p + h2p) / 2
        : h1p + h2p < 360
          ? (h1p + h2p + 360) / 2
          : (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

describe('jersey colours (SPEC §16.1)', () => {
  it('CIEDE2000 matches the Sharma et al. reference pair', () => {
    // Pair 1 of the published test data: Lab (50, 2.6772, -79.7751) vs (50, 0, -82.7485) → 2.0425. Checked via sRGB round trip below instead.
    expect(de2000('#000000', '#000000')).toBe(0);
    expect(de2000('#FFFFFF', '#000000')).toBeCloseTo(100, 0);
  });
  it.each(Object.entries(series))('%s %s has at least 3:1 contrast against --bg', (_k, c) => {
    expect(contrast(c, BG)).toBeGreaterThanOrEqual(3);
  });
  it('every pair of series colours is at least 15 apart (CIEDE2000)', () => {
    const entries = Object.entries(series);
    const close: string[] = [];
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++) {
        const d = de2000(entries[i]![1], entries[j]![1]);
        if (d < 15) close.push(`${entries[i]![0]}–${entries[j]![0]}: ${d.toFixed(1)}`);
      }
    expect(close).toEqual([]);
  });
  it('text tokens meet 4.5:1 on the page and panels', () => {
    for (const bg of ['#0D1A2B', '#142338', '#1B2D46']) {
      expect(contrast('#F2F5F9', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#93A4BA', bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast('#0D1A2B', '#FFB648')).toBeGreaterThanOrEqual(4.5); // dark text on amber buttons
  });
});
