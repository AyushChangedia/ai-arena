import { ImageResponse } from 'next/og';
import { cacheLife, cacheTag } from 'next/cache';
import { formatInrCompact, formatPct, direction } from '@arena/shared/format';
import { loadArena } from '@/lib/data';
import { OG, OG_SIZE, ogFonts } from '@/lib/og';

export const alt = 'AI Arena standings';
export const size = OG_SIZE;
export const contentType = 'image/png';

async function data() {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const r = await loadArena();
  if (!r.ok || !r.data.season) return null;
  const rows = r.data.standings.filter((s) => s.totalPaise !== null);
  const top = rows.filter((s) => s.participant.kind !== 'index').slice(0, 3);
  const nifty = rows.find((s) => s.participant.kind === 'index') ?? null;
  return { season: r.data.season.name, top, nifty };
}

/** Share image from revealed data only: the top three and the Nifty line (SPEC §16.9). */
export default async function Image() {
  const d = await data();
  const row = (code: string, color: string, total: bigint, ret: number | null, quiet = false) => (
    <div
      key={code}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        fontSize: quiet ? 40 : 56,
        color: quiet ? OG.text2 : OG.text,
      }}
    >
      <div
        style={{
          display: 'flex',
          background: quiet ? 'transparent' : color,
          color: quiet ? color : OG.bg,
          border: quiet ? `3px solid ${OG.text2}` : 'none',
          borderRadius: 8,
          padding: '4px 16px',
        }}
      >
        {code}
      </div>
      <div style={{ display: 'flex' }}>{formatInrCompact(total)}</div>
      {ret !== null ? (
        <div
          style={{
            display: 'flex',
            color:
              direction(ret) === 'gain' ? OG.gain : direction(ret) === 'loss' ? OG.loss : OG.text2,
          }}
        >
          {formatPct(ret)}
        </div>
      ) : null}
    </div>
  );
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
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 64, color: OG.text }}>AI Arena</div>
        <div style={{ display: 'flex', fontSize: 32, color: OG.text2 }}>
          {d ? `${d.season} standings` : 'AI models. Real NSE prices. Paper money.'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {d?.top.map((s) =>
          row(s.participant.shortCode, s.participant.color, s.totalPaise!, s.returnFrac),
        )}
        {d?.nifty
          ? row(
              d.nifty.participant.shortCode,
              d.nifty.participant.color,
              d.nifty.totalPaise!,
              d.nifty.returnFrac,
              true,
            )
          : null}
      </div>
      <div style={{ display: 'flex', fontSize: 24, color: OG.text2 }}>
        Paper trading. Not investment advice. Prices delayed 15 minutes.
      </div>
    </div>,
    { ...size, fonts: await ogFonts() },
  );
}
