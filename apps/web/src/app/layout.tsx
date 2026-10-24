import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Archivo variable (weight 400–700, width 75–100), self-hosted (SPEC §16.1). Axes trimmed from the OFL release
// to the ranges the site uses; the 1 KB rupee file carries ₹ (U+20B9) from Archivo's latin-ext subset.
const archivo = localFont({
  src: '../fonts/archivo-latin.woff2',
  variable: '--font-archivo',
  display: 'swap',
  weight: '400 700',
  style: 'normal',
  declarations: [{ prop: 'font-stretch', value: '75% 100%' }],
});
const archivoExt = localFont({
  src: '../fonts/archivo-rupee.woff2',
  variable: '--font-archivo-ext',
  display: 'swap',
  weight: '400 700',
  style: 'normal',
  declarations: [{ prop: 'font-stretch', value: '75% 100%' }],
});

const shadow = process.env.ARENA_MODE !== 'live';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: { default: 'AI Arena', template: '%s | AI Arena' },
  description:
    'Five AI models trade Nifty 50 stocks with paper money at real NSE prices. Every trade, rejection and reason is public and verifiable.',
  robots: shadow ? { index: false, follow: false } : { index: true, follow: true },
  openGraph: { siteName: 'AI Arena', type: 'website' },
};

export const viewport: Viewport = { themeColor: '#0d1a2b', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${archivo.variable} ${archivoExt.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-bg"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
