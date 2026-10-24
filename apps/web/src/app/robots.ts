import type { MetadataRoute } from 'next';

/** Shadow mode is never indexed (SPEC §12.9, §16.9). */
export default function robots(): MetadataRoute.Robots {
  if (process.env.ARENA_MODE !== 'live') return { rules: { userAgent: '*', disallow: '/' } };
  return { rules: { userAgent: '*', allow: '/', disallow: '/api/' } };
}
