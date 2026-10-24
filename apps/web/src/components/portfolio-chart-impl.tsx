'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartSeries } from './chart-types';

type Range = 'today' | '5d' | 'season';
type Unit = 'inr' | 'pct';

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const IST = 330 * 60;

export default function PortfolioChartImpl({
  series,
  startingCashPaise,
  summary,
  tableId,
}: {
  series: ChartSeries[];
  startingCashPaise: string;
  summary: string;
  tableId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef(new Map<string, ISeriesApi<'Line'>>());
  const [range, setRange] = useState<Range>('season');
  const [unit, setUnit] = useState<Unit>('inr');
  const [tip, setTip] = useState<{
    time: string;
    rows: { code: string; color: string; text: string }[];
  } | null>(null);
  const start = Number(startingCashPaise) / 100;
  const unitRef = useRef(unit);
  unitRef.current = unit;

  const days = useMemo(() => {
    const all = new Set<string>();
    for (const s of series)
      for (const [t] of s.points) all.add(new Date((t + IST) * 1000).toISOString().slice(0, 10));
    return [...all].sort();
  }, [series]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: css('--text-2'),
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16),
      },
      localization: {
        timeFormatter: (t: number) =>
          `${new Date((t + IST) * 1000).toISOString().slice(0, 16).replace('T', ' ')} IST`,
        priceFormatter: (v: number) =>
          unitRef.current === 'pct'
            ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`
            : `₹${Math.round(v).toLocaleString('en-IN')}`,
      },
      crosshair: { horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    chart.current = c;
    const ls = lines.current;
    for (const s of series) {
      const l = c.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.kind === 'model' ? 2 : 1,
        lineStyle:
          s.kind === 'index'
            ? LineStyle.Dashed
            : s.kind === 'monkey'
              ? LineStyle.Dotted
              : LineStyle.Solid,
        title: s.shortCode,
        lastValueVisible: true,
        priceLineVisible: false,
      });
      ls.set(s.id, l);
    }
    c.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) return setTip(null);
      const rows = series
        .map((s) => {
          const d = param.seriesData.get(ls.get(s.id)!) as { value?: number } | undefined;
          return d?.value === undefined
            ? null
            : { code: s.shortCode, color: s.color, value: d.value };
        })
        .filter((x): x is { code: string; color: string; value: number } => x !== null)
        .sort((a, b) => b.value - a.value);
      setTip({
        time: `${new Date(((param.time as number) + IST) * 1000).toISOString().slice(0, 16).replace('T', ' ')} IST`,
        rows: rows.map((r) => ({
          code: r.code,
          color: r.color,
          text:
            unitRef.current === 'pct'
              ? `${r.value >= 0 ? '+' : '−'}${Math.abs(r.value).toFixed(2)}%`
              : `₹${r.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
        })),
      });
    });
    return () => {
      c.remove();
      chart.current = null;
      ls.clear();
    };
  }, [series]);

  useEffect(() => {
    const keep = range === 'season' ? days : range === '5d' ? days.slice(-5) : days.slice(-1);
    for (const s of series) {
      const l = lines.current.get(s.id);
      if (!l) continue;
      const data = s.points
        .filter(([t]) => keep.includes(new Date((t + IST) * 1000).toISOString().slice(0, 10)))
        .map(([t, v]) => {
          const rupees = Number(v) / 100;
          return {
            time: t as UTCTimestamp,
            value: unit === 'pct' ? (rupees / start - 1) * 100 : rupees,
          };
        });
      l.setData(data);
    }
    chart.current?.timeScale().fitContent();
  }, [series, range, unit, days, start]);

  const btn = (active: boolean) =>
    `min-h-11 min-w-11 rounded-[var(--radius-chip)] px-3 text-sm ${active ? 'bg-surface-2 text-text' : 'text-text-2'}`;
  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Range" className="flex gap-1">
          {(['today', '5d', 'season'] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={btn(range === r)}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r === 'today' ? 'Today' : r === '5d' ? '5D' : 'Season'}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Units" className="flex gap-1">
          <button
            type="button"
            className={btn(unit === 'inr')}
            aria-pressed={unit === 'inr'}
            onClick={() => setUnit('inr')}
          >
            ₹
          </button>
          <button
            type="button"
            className={btn(unit === 'pct')}
            aria-pressed={unit === 'pct'}
            onClick={() => setUnit('pct')}
          >
            %
          </button>
        </div>
      </div>
      <div className="relative">
        <p className="sr-only">{summary}</p>
        {/* The chart is visual only; the summary above and "View as table" carry the same information. */}
        <div ref={box} inert className="h-[280px] lg:h-[360px]" />
        {tip ? (
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-[var(--radius-chip)] border border-line bg-surface px-2 py-1 text-xs">
            <div className="num text-text-2">{tip.time}</div>
            {tip.rows.map((r) => (
              <div key={r.code} className="num flex justify-between gap-3">
                <span style={{ color: r.color }} className="font-semibold">
                  {r.code}
                </span>
                <span>{r.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <figcaption className="mt-1 text-sm">
        <a className="link inline-flex min-h-11 items-center" href={`#${tableId}`}>
          View as table
        </a>
      </figcaption>
    </figure>
  );
}
