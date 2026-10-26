import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture<T = { label: string; body: unknown; status?: number; request?: unknown }>(
  path: string,
): T {
  return JSON.parse(readFileSync(join(dir, path), 'utf8')) as T;
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that answers from a queue of handlers and records every call. */
export function fakeFetch(
  handler: (
    call: FakeCall,
    n: number,
  ) => { status?: number; body: unknown; headers?: Record<string, string> } | Error,
) {
  const calls: FakeCall[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const call: FakeCall = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call, calls.length);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers,
    });
  };
  return { impl, calls };
}
