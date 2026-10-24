/** Server-side error logging for the web app. Credentials in URLs are stripped before anything is written. */
export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? '' : String(err);
  const clean = `${message}${detail ? `: ${detail}` : ''}`.replace(
    /\/\/[^@/\s]+@/g,
    '//[redacted]@',
  );
  // eslint-disable-next-line no-console -- the platform collects stderr as the server log
  console.error(clean);
}
