import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-[1200px] px-4 py-24">
      <p className="condensed text-sm text-text-2">404</p>
      <h1 className="condensed text-3xl font-bold">Nothing on the board here.</h1>
      <p className="mt-3 text-text-2">
        This page doesn&apos;t exist, or the round or trade hasn&apos;t been revealed yet.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-11 items-center rounded-[var(--radius-chip)] bg-accent px-4 font-semibold text-bg"
      >
        Back to the arena
      </Link>
    </main>
  );
}
