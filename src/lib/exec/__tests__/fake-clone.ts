// Test support: a fake missive clone behind a stubbed global fetch, so tests
// run the real missive-client (URL building, error mapping, normalizers)
// against canned clone answers. Requests are recorded. A handler may return a
// promise that never settles; the request then ends only when its signal
// aborts, like a real hung connection.
//
// It takes the stubbing function rather than importing vitest: this file sits
// inside the app's tsconfig, which a production build type-checks.
//
//   const clone = installFakeClone((req) => json(200, { thread, messages }), vi.stubGlobal);
//   ...
//   afterEach(() => vi.unstubAllGlobals());

export const CLONE_URL = "https://clone.test";
export const CLONE_TOKEN = "clone-test-token";

export interface CloneRequest {
  url: URL;
  /** pathname, e.g. "/api/threads/t1" */
  path: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal | null;
}

export type CloneHandler = (req: CloneRequest) => Response | Promise<Response>;

export interface FakeClone {
  requests: CloneRequest[];
  setHandler(handler: CloneHandler): void;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

/** Express's default 404 for a route this clone build doesn't have. */
export function expressNotFound(path: string): Response {
  return new Response(`<!DOCTYPE html>\n<html><body><pre>Cannot GET ${path}</pre></body></html>`, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

export function installFakeClone(handler: CloneHandler, stubGlobal: (name: "fetch", value: typeof fetch) => unknown): FakeClone {
  process.env.MISSIVE_API_URL = CLONE_URL;
  process.env.MISSIVE_API_TOKEN = CLONE_TOKEN;
  let current = handler;
  const clone: FakeClone = {
    requests: [],
    setHandler(h) {
      current = h;
    }
  };
  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const signal = init.signal ?? null;
    const req: CloneRequest = { url, path: url.pathname, method: (init.method ?? "GET").toUpperCase(), headers, signal };
    clone.requests.push(req);
    if (signal?.aborted) throw signal.reason;
    const answer = Promise.resolve().then(() => current(req));
    if (!signal) return answer;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      answer.then(
        (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  };
  stubGlobal("fetch", fakeFetch as typeof fetch);
  return clone;
}
