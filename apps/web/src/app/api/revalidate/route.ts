import { revalidateTag } from 'next/cache';
import { timingSafeEqual } from 'node:crypto';

/**
 * On-demand revalidation (SPEC §16.8). Called by the engine after reveals with
 * Authorization: Bearer <REVALIDATE_SECRET> and {"tags": ["live"] | ["detail"]}.
 * Rejects bad secrets and is rate limited per instance.
 */
const ALLOWED = new Set(['live', 'detail']);
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits: number[] = [];

function secretOk(header: string | null): boolean {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const now = Date.now();
  while (hits.length && now - hits[0]! > WINDOW_MS) hits.shift();
  if (hits.length >= MAX_PER_WINDOW)
    return Response.json(
      { error: 'rate limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  hits.push(now);
  if (!secretOk(req.headers.get('authorization')))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  let tags: string[] = ['live'];
  try {
    const body = (await req.json()) as { tags?: unknown };
    if (Array.isArray(body.tags))
      tags = body.tags.filter((t): t is string => typeof t === 'string');
  } catch {
    // No or invalid JSON body: default to the live tag.
    tags = ['live'];
  }
  const valid = tags.filter((t) => ALLOWED.has(t));
  if (!valid.length) return Response.json({ error: 'no valid tags' }, { status: 400 });
  // Expire immediately so a revealed round appears on the next request (SPEC §21 Phase 5 acceptance).
  for (const t of valid) revalidateTag(t, { expire: 0 });
  return Response.json({ revalidated: valid });
}
