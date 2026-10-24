'use client';
import dynamic from 'next/dynamic';
import type { ChartSeries } from './chart-types';

/** Lazily loads the chart library; the page works without it (there is always "View as table"). */
const Impl = dynamic(() => import('./portfolio-chart-impl'), {
  ssr: false,
  loading: () => (
    <div className="h-[280px] rounded-[var(--radius-panel)] bg-surface lg:h-[360px]" aria-hidden />
  ),
});

export function PortfolioChart(props: {
  series: ChartSeries[];
  startingCashPaise: string;
  summary: string;
  tableId: string;
}) {
  return <Impl {...props} />;
}
