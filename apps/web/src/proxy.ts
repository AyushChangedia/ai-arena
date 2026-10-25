import { NextResponse, type NextRequest } from 'next/server';
import { PARTICIPANT_SLUGS } from './lib/slugs';

/**
 * Cheap, database-free 404s for malformed URLs, so they return a real 404 status (SPEC §16.3 item 9).
 * Well-formed IDs that don't exist yet get the site's 404 page, streamed with a noindex tag.
 */
const SLUGS = new Set(PARTICIPANT_SLUGS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function proxy(req: NextRequest) {
  const [, section, id, extra] = req.nextUrl.pathname.split('/');
  const bad =
    (section === 'rounds' && id !== undefined && !UUID.test(id)) ||
    (section === 'trades' && id !== undefined && !/^\d{1,18}$/.test(id)) ||
    (section === 'models' && id !== undefined && !SLUGS.has(id)) ||
    (section === 'seasons' && id !== undefined && !/^S\d{1,3}$/.test(id));
  if (bad && extra !== 'opengraph-image') {
    // The 404 page is prerendered; serve its HTML with a real 404 status.
    const page = await fetch(new URL('/missing', req.url));
    return new Response(await page.text(), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/rounds/:id*', '/trades/:id*', '/models/:id*', '/seasons/:id*'],
};
