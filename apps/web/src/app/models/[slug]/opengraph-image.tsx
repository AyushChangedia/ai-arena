import { ImageResponse } from 'next/og';
import { cacheLife, cacheTag } from 'next/cache';
import { formatInr, formatPct, direction } from '@arena/shared/format';
import { loadModel } from '@/lib/data';
import { OG, OG_SIZE, ogFonts } from '@/lib/og';

export const alt = 'AI Arena model';
export const size = OG_SIZE;
export const contentType = 'image/png';

async function data(slug: string) {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const r = await loadModel(slug);
  if (!r.ok || !r.data) return null;
  return {
    name: r.data.participant.displayName,
    code: r.data.participant.shortCode,
    color: r.data.participant.color,
    total: r.data.standing?.totalPaise ?? null,
    ret: r.data.standing?.returnFrac ?? null,
  };
}

/** Share image for a model page: its value and return (SPEC §16.9). */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const d = await data((await params).slug);
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: OG.bg,
        padding: 72,
        fontFamily: 'Archivo',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', fontSize: 40, color: OG.text2 }}>AI Arena</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          {d ? (
            <div
              style={{
                display: 'flex',
                background: d.color,
                color: OG.bg,
                borderRadius: 8,
                padding: '4px 16px',
                fontSize: 56,
              }}
            >
              {d.code}
            </div>
          ) : null}
          <div style={{ display: 'flex', fontSize: 56, color: OG.text }}>{d?.name ?? 'Model'}</div>
        </div>
        <div style={{ display: 'flex', gap: 32, fontSize: 96, color: OG.text }}>
          <div style={{ display: 'flex' }}>
            {d?.total !== null && d?.total !== undefined
              ? formatInr(d.total, { decimals: 0 })
              : '—'}
          </div>
          {d?.ret !== null && d?.ret !== undefined ? (
            <div
              style={{
                display: 'flex',
                color:
                  direction(d.ret) === 'gain'
                    ? OG.gain
                    : direction(d.ret) === 'loss'
                      ? OG.loss
                      : OG.text2,
              }}
            >
              {formatPct(d.ret)}
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', fontSize: 24, color: OG.text2 }}>
        Paper trading. Not investment advice. Prices delayed 15 minutes.
      </div>
    </div>,
    { ...size, fonts: await ogFonts() },
  );
}
