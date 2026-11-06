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

import { createHash } from "node:crypto";
import type { CloneReadBack } from "@/lib/exec/clone-ea-types";

export const CLONE_URL = "https://clone.test";
export const CLONE_TOKEN = "clone-test-token";

export interface CloneRequest {
  url: URL;
  /** pathname, e.g. "/api/threads/t1" */
  path: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal | null;
  /** The request body when it was sent as a string, else null (P4: the CL2 routes' JSON). */
  body: string | null;
  /** `body` parsed when the request's content type is JSON and it parses; else undefined. */
  json: unknown;
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
    const body = typeof init.body === "string" ? init.body : null;
    let parsedJson: unknown = undefined;
    if (body !== null && /json/i.test(headers["content-type"] ?? "")) {
      try {
        parsedJson = JSON.parse(body);
      } catch {
        parsedJson = undefined;
      }
    }
    const req: CloneRequest = { url, path: url.pathname, method: (init.method ?? "GET").toUpperCase(), headers, signal, body, json: parsedJson };
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

// ---------------------------------------------------------------------------
// The CL2 (Outlook drafts) fake for the P4 tests (contract §5 "Fakes"): the
// routes of CL2C §3, the idempotency protocol of §3.0.4 (a key store per
// (route, key): a same-key replay returns the stored answer with
// Idempotent-Replay: true, a key still in progress answers the provisional 409
// on /send and 429 throttled elsewhere, the same key with another body 422),
// scripted answers per route, a recorder of every request with its headers
// and body, a "fail every /send" switch and a "complete, then drop the
// response" mode (the handler runs and the key is stored, but the fetch never
// settles until DD's own timeout aborts it). Tests set the EA env tokens
// themselves; the fake checks bearers against the tokens it is given.
// ---------------------------------------------------------------------------

export type Cl2Route = "status" | "auth_me" | "create_reply" | "create_new" | "get_draft" | "recreate" | "delete" | "send" | "other";
export interface Cl2Answer { status: number; body?: unknown; headers?: Record<string, string> }
/** A scripted answer: a JSON answer, a raw Response (an edge page, say), or a function of the request returning either. */
export type Cl2Reply = Cl2Answer | Response | ((req: Cl2Request) => Cl2Answer | Response | Promise<Cl2Answer | Response>);
export interface Cl2Request extends CloneRequest {
  route: Cl2Route;
  threadId: string | null;
  graphId: string | null;
  idempotencyKey: string | null;
  bearer: string | null;
}
export interface Cl2KeyEntry { route: Cl2Route; key: string; requestHash: string; status: "in_progress" | "completed"; answer: Cl2Answer | null }
export interface FakeCl2Options {
  /** The bearer the draft routes and /api/auth/me accept; omit for no auth check. */
  draftToken?: string;
  /** The bearer /send accepts; omit for no auth check. */
  sendToken?: string;
  /** auth.accounts of the built-in /api/auth/me answer. */
  accounts?: string[];
  /** cl2.send of the built-in /api/status answer; auth.sendEnabled is true unless "off". */
  send?: "off" | "all" | "some";
}
export interface FakeCl2 {
  requests: Cl2Request[];
  keys: Map<string, Cl2KeyEntry>;
  /** Every /send answers 500 server_error (stored under its key, so a replay reads it). */
  failSends: boolean;
  /** Routes whose handler runs (and stores its key) but whose response never arrives. */
  dropResponse: Set<Cl2Route>;
  /** Queue scripted answers for a route, used once each in order; a function sees the request. */
  answer(route: Cl2Route, ...replies: Cl2Reply[]): void;
  /** The standing answer for a route once its queue is empty (null restores the built-in one). */
  defaultAnswer(route: Cl2Route, reply: Cl2Reply | null): void;
  of(route: Cl2Route): Cl2Request[];
  /** Forget requests, queues, defaults and keys (not the switches). */
  reset(): void;
}

const CL2_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CL2_MUTATING: ReadonlySet<Cl2Route> = new Set<Cl2Route>(["create_reply", "create_new", "recreate", "delete", "send"]);
const CL2_STORED_ERRORS: ReadonlySet<number> = new Set([400, 404, 409]);
const CL2_PROVISIONAL: Cl2Answer = {
  status: 409,
  body: { error: "already_sending", detail: "a send with this Idempotency-Key is in progress or ended without a recorded outcome; read the draft" }
};

export function cl2Error(status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Cl2Answer {
  return { status, body: { error, ...extra }, ...(headers ? { headers } : {}) };
}

/** A canonical read-back (CL2C §3.0.5) with every field set; override what a test needs. */
export function readBackFixture(over: Partial<CloneReadBack> = {}): CloneReadBack {
  return {
    live: true,
    graphId: "AAMkAGraphId=",
    status: "saved",
    kind: "reply",
    accountId: "acc_1",
    threadId: "t1",
    parentMessageId: "m_in",
    replaces: null,
    changeKey: "CQAAABYAAA",
    contentHash: "a".repeat(64),
    internetMessageId: "MW4PR.draft@outlook.com",
    conversationId: "AAQk",
    webLink: "https://outlook.office365.com/owa/?ItemID=x",
    isDraft: true,
    lastModified: "2026-11-05T12:00:00Z",
    sentAt: null,
    from: null,
    sender: null,
    replyTo: [],
    to: [{ address: "client@acme.io", name: "Client" }],
    cc: [],
    bcc: [],
    subject: "RE: hello",
    bodyHtml: "<html><body><div>hi</div></body></html>",
    attachments: [],
    flags: [],
    ...over
  };
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function cl2RouteOf(method: string, path: string): { route: Cl2Route; threadId: string | null; graphId: string | null } {
  const none = { threadId: null, graphId: null };
  if (method === "GET" && path === "/api/status") return { route: "status", ...none };
  if (method === "GET" && path === "/api/auth/me") return { route: "auth_me", ...none };
  if (method === "POST" && path === "/api/compose/outlook-draft") return { route: "create_new", ...none };
  const reply = /^\/api\/threads\/([^/]+)\/outlook-draft$/.exec(path);
  if (method === "POST" && reply) return { route: "create_reply", threadId: decodeURIComponent(reply[1]), graphId: null };
  const send = /^\/api\/outlook-drafts\/([^/]+)\/send$/.exec(path);
  if (method === "POST" && send) return { route: "send", threadId: null, graphId: decodeURIComponent(send[1]) };
  const draft = /^\/api\/outlook-drafts\/([^/]+)$/.exec(path);
  if (draft) {
    const graphId = decodeURIComponent(draft[1]);
    if (method === "GET") return { route: "get_draft", threadId: null, graphId };
    if (method === "PATCH") return { route: "recreate", threadId: null, graphId };
    if (method === "DELETE") return { route: "delete", threadId: null, graphId };
  }
  return { route: "other", ...none };
}

function bearerOf(authorization: string | undefined): string | null {
  const m = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  return m ? m[1] : null;
}

export function installFakeCl2(stubGlobal: (name: "fetch", value: typeof fetch) => unknown, options: FakeCl2Options = {}): FakeCl2 {
  const queues = new Map<Cl2Route, Cl2Reply[]>();
  const defaults = new Map<Cl2Route, Cl2Reply>();
  const fake: FakeCl2 = {
    requests: [],
    keys: new Map(),
    failSends: false,
    dropResponse: new Set(),
    answer(route, ...replies) {
      queues.set(route, [...(queues.get(route) ?? []), ...replies]);
    },
    defaultAnswer(route, reply) {
      if (reply === null) defaults.delete(route);
      else defaults.set(route, reply);
    },
    of(route) {
      return fake.requests.filter((r) => r.route === route);
    },
    reset() {
      fake.requests.length = 0;
      fake.keys.clear();
      queues.clear();
      defaults.clear();
    }
  };
  const builtIn = (route: Cl2Route): Cl2Answer => {
    switch (route) {
      case "status":
        return { status: 200, body: { ok: true, cl2: { ready: true, send: options.send ?? "all" } } };
      case "auth_me":
        return {
          status: 200,
          body: {
            user: { id: "u_ea" },
            auth: {
              kind: "scoped",
              scopes: ["draft", "read"],
              accounts: options.accounts ?? [],
              jti: "jti_0123456789abcdef",
              expiresAt: "2027-11-04T00:00:00.000Z",
              sendEnabled: (options.send ?? "all") !== "off"
            }
          }
        };
      default:
        return cl2Error(500, "server_error");
    }
  };
  const resolve = async (route: Cl2Route, req: Cl2Request): Promise<Cl2Answer | Response> => {
    const queue = queues.get(route);
    const reply = queue && queue.length > 0 ? (queue.shift() as Cl2Reply) : defaults.get(route);
    if (reply === undefined) return builtIn(route);
    return typeof reply === "function" ? reply(req) : reply;
  };
  const checkAuth = (route: Cl2Route, req: Cl2Request): Cl2Answer | null => {
    if (route === "status" || route === "other") return null;
    const expected = route === "send" ? options.sendToken : options.draftToken;
    const other = route === "send" ? options.draftToken : options.sendToken;
    if (expected === undefined || req.bearer === expected) return null;
    return req.bearer !== null && req.bearer === other ? cl2Error(403, "forbidden_scope") : cl2Error(401, "invalid_token");
  };
  const respond = (answer: Cl2Answer, replay = false): Response =>
    json(answer.status, answer.body, { ...(answer.headers ?? {}), ...(replay ? { "idempotent-replay": "true" } : {}) });

  const handler: CloneHandler = async (base) => {
    const { route, threadId, graphId } = cl2RouteOf(base.method, base.path);
    const req: Cl2Request = { ...base, route, threadId, graphId, idempotencyKey: base.headers["idempotency-key"] ?? null, bearer: bearerOf(base.headers.authorization) };
    fake.requests.push(req);
    const refused = checkAuth(route, req);
    if (refused) return respond(refused);
    if (!CL2_MUTATING.has(route)) {
      const answer = await resolve(route, req);
      return answer instanceof Response ? answer : respond(answer);
    }
    const key = req.idempotencyKey;
    if (key === null || !CL2_KEY_RE.test(key)) return respond(cl2Error(400, "bad_request", { detail: "Idempotency-Key" }));
    const isSend = route === "send";
    const requestHash = createHash("sha256").update(stableJson({ m: req.method, r: route, p: { threadId, graphId }, b: req.json ?? null })).digest("hex");
    const k = `${route}\n${key}`;
    const entry = fake.keys.get(k);
    if (entry) {
      if (entry.requestHash !== requestHash) return respond(cl2Error(422, "idempotency_mismatch"));
      if (entry.status === "completed" && entry.answer) return respond(entry.answer, true);
      if (isSend) return respond(CL2_PROVISIONAL, true);
      return respond(cl2Error(429, "throttled", {}, { "retry-after": "2" }));
    }
    const mine: Cl2KeyEntry = { route, key, requestHash, status: "in_progress", answer: isSend ? CL2_PROVISIONAL : null };
    fake.keys.set(k, mine);
    let answer: Cl2Answer | Response;
    try {
      answer = isSend && fake.failSends ? cl2Error(500, "server_error") : await resolve(route, req);
    } catch {
      if (!isSend) fake.keys.delete(k);
      return respond(cl2Error(500, "server_error"));
    }
    if (answer instanceof Response) {
      fake.keys.delete(k);
      if (fake.dropResponse.has(route)) return new Promise<Response>(() => undefined);
      return answer;
    }
    if (isSend || (answer.status >= 200 && answer.status < 300) || CL2_STORED_ERRORS.has(answer.status)) {
      mine.status = "completed";
      mine.answer = answer;
    } else {
      fake.keys.delete(k);
    }
    if (fake.dropResponse.has(route)) return new Promise<Response>(() => undefined);
    return respond(answer);
  };
  installFakeClone(handler, stubGlobal);
  return fake;
}
