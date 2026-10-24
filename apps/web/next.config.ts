import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@arena/shared', '@arena/db'],
  serverExternalPackages: ['pg'],
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: { '/*': ['../../config/**/*.json'] },
  turbopack: { root: repoRoot },
  cacheLife: {
    // Pages refresh on demand when the engine calls /api/revalidate; this is the 1-hour safety net (SPEC §16.8).
    arena: { stale: 300, revalidate: 3600, expire: 86400 },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
