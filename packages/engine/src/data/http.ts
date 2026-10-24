/**
 * Native fetch with our own timeout. No automatic retries here: each caller owns its retry policy.
 */
export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export async function httpJson(req: HttpRequest): Promise<HttpResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), req.timeoutMs);
  const onOuterAbort = () => ctrl.abort(new Error('aborted'));
  req.signal?.addEventListener('abort', onOuterAbort);
  const f = req.fetchImpl ?? globalThis.fetch;
  try {
    const res = await f(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text.length) {
      try {
        json = JSON.parse(text);
      } catch {
        // Not JSON: callers see json === undefined and the raw text, and classify it themselves.
        json = undefined;
      }
    }
    return { status: res.status, ok: res.ok, text, json, headers: res.headers };
  } catch (e) {
    if (ctrl.signal.aborted)
      throw new HttpError(
        'timeout',
        `request timed out after ${req.timeoutMs} ms: ${redactUrl(req.url)}`,
        { cause: e },
      );
    throw new HttpError(
      'network',
      `network error calling ${redactUrl(req.url)}: ${(e as Error).message}`,
      { cause: e },
    );
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Drops query strings and path segments that look like tokens before a URL reaches a message. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/bot[^/]+/, '/bot[redacted]').replace(/\/[0-9a-f-]{30,}/gi, '/[redacted]')}`;
  } catch {
    return '[url]';
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
