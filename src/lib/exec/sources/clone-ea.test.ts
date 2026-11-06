import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloneEaError } from "@/lib/exec/clone-ea-types";
import { CLONE_EA_MAX_RESPONSE_BYTES, CLONE_EA_PATHS, cloneEaBaseUrl, cloneEaFetch, type CloneEaCall } from "@/lib/exec/sources/clone-ea";
import { NonRetryableError } from "@/lib/exec/types";
import { CLONE_URL, expressNotFound, installFakeClone, json, type FakeClone } from "../__tests__/fake-clone";

// The CL2 fetch wrapper against a stubbed fetch: headers, encoding, the own
// timeout, failure mapping, the 4 MB cap, the base URL and what it logs.
// Contract §3.2.2, §5.2 CE01-CE10.

const TOKEN = "tok-SECRET-draft";
const base = (over: Partial<CloneEaCall> = {}): CloneEaCall => ({
  route: "get_draft",
  method: "GET",
  path: CLONE_EA_PATHS.draft("AAMk="),
  token: TOKEN,
  timeoutMs: 5_000,
  ...over
});

let clone: FakeClone;
const ENV = { ...process.env };

beforeEach(() => {
  clone = installFakeClone(() => json(200, { ok: true }), vi.stubGlobal);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

async function failure(call: CloneEaCall): Promise<CloneEaError> {
  try {
    await cloneEaFetch(call);
  } catch (err) {
    if (err instanceof CloneEaError) return err;
    throw err;
  }
  throw new Error("the call did not fail");
}

describe("CE01 headers and fetch options", () => {
  it("sends the bearer, the key, the JSON content type, Accept and cache: no-store", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit = {}) => {
      inits.push(init);
      return json(201, { ok: true });
    });
    await cloneEaFetch(base({ route: "create_new", method: "POST", path: CLONE_EA_PATHS.createNew(), json: { subject: "x" }, idempotencyKey: "ed_1:v1:save:abc" }));
    expect(inits).toHaveLength(1);
    const init = inits[0];
    expect(init.cache).toBe("no-store");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("idempotency-key")).toBe("ed_1:v1:save:abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ subject: "x" }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("no Authorization header without a token (/api/status), no key or content type on a GET", async () => {
    await cloneEaFetch(base({ route: "status", path: CLONE_EA_PATHS.status(), token: null }));
    const req = clone.requests[0];
    expect(req.method).toBe("GET");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers["idempotency-key"]).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.headers.accept).toBe("application/json");
    expect(req.body).toBeNull();
  });
});

describe("CE02 path ids", () => {
  it("are encoded with their case kept", async () => {
    expect(CLONE_EA_PATHS.draft("AAkA=b-C_")).toBe("/api/outlook-drafts/AAkA%3Db-C_");
    expect(CLONE_EA_PATHS.send("AAkA=b-C_")).toBe("/api/outlook-drafts/AAkA%3Db-C_/send");
    expect(CLONE_EA_PATHS.createReply("t/1 x")).toBe("/api/threads/t%2F1%20x/outlook-draft");
    await cloneEaFetch(base({ path: CLONE_EA_PATHS.draft("AAkA=b-C_") }));
    expect(clone.requests[0].url.href).toBe(`${CLONE_URL}/api/outlook-drafts/AAkA%3Db-C_`);
    expect(decodeURIComponent(clone.requests[0].path)).toBe("/api/outlook-drafts/AAkA=b-C_");
  });
});

describe("CE03 a bad idempotency key", () => {
  it.each(["bad key", "a".repeat(129), "", "k/slash", "ключ"])("%j is refused before any fetch", async (key) => {
    await expect(cloneEaFetch(base({ idempotencyKey: key }))).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
  });

  it("a path outside /api and a bad timeout are refused too", async () => {
    await expect(cloneEaFetch(base({ path: "https://evil.example/x" }))).rejects.toBeInstanceOf(NonRetryableError);
    await expect(cloneEaFetch(base({ timeoutMs: 0 }))).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
  });
});

describe("CE04 the own timeout", () => {
  it("fires after timeoutMs with kind timeout; the fetch's signal is the module's own", async () => {
    vi.useFakeTimers();
    clone.setHandler(() => new Promise<Response>(() => undefined));
    const pending = failure(base({ timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(clone.requests[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect([err.kind, err.errorClass, err.status, err.code]).toEqual(["timeout", "retryable", null, "timeout"]);
    expect(clone.requests[0].signal?.aborted).toBe(true);
    expect((clone.requests[0].signal?.reason as Error).name).toBe("TimeoutError");
    // The call shape has no signal field: nothing a caller passes can reach the fetch.
    expect(Object.keys(base())).not.toContain("signal");
  });
});

describe("CE05 a rejected fetch", () => {
  it("is transport, retryable, with the undici cause code in the log line only", async () => {
    clone.setHandler(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) });
    });
    const err = await failure(base());
    expect([err.kind, err.errorClass, err.status, err.code]).toEqual(["transport", "retryable", null, "transport"]);
    expect(err.message).toBe("clone get_draft answered no status transport");
    const warned = vi.mocked(console.warn).mock.calls.map((c) => c.join(" "));
    expect(warned.some((w) => w.includes("get_draft") && w.includes("transport") && w.includes("ECONNREFUSED"))).toBe(true);
  });
});

describe("CE06 Idempotent-Replay", () => {
  it("is read on a 2xx and on an error answer", async () => {
    clone.setHandler(() => json(201, { ok: true }, { "idempotent-replay": "true" }));
    expect((await cloneEaFetch(base())).replay).toBe(true);
    clone.setHandler(() => json(201, { ok: true }));
    expect((await cloneEaFetch(base())).replay).toBe(false);
    clone.setHandler(() => json(409, { error: "changed", draftStatus: "saved" }, { "Idempotent-Replay": "True" }));
    const err = await failure(base({ route: "recreate" }));
    expect([err.replay, err.kind, err.draftStatus]).toEqual([true, "changed", "saved"]);
  });
});

describe("CE07 a 2xx that isn't JSON", () => {
  it("is invalid_body with the status kept", async () => {
    clone.setHandler(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));
    const err = await failure(base());
    expect([err.kind, err.errorClass, err.status, err.code]).toEqual(["invalid_body", "retryable", 200, "invalid_body"]);
    clone.setHandler(() => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await failure(base())).kind).toBe("invalid_body");
    clone.setHandler(() => new Response(null, { status: 204 }));
    expect((await failure(base())).kind).toBe("invalid_body");
  });
});

describe("CE08 a response over 4 MB", () => {
  it("is cut and reported as invalid_body on a 2xx, edge on an error status", async () => {
    const huge = `{"bodyHtml":"${"x".repeat(CLONE_EA_MAX_RESPONSE_BYTES)}"}`;
    clone.setHandler(() => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }));
    const err = await failure(base());
    expect([err.kind, err.status]).toEqual(["invalid_body", 200]);
    clone.setHandler(() => new Response(huge, { status: 502, headers: { "content-type": "application/json" } }));
    const edge = await failure(base());
    expect([edge.kind, edge.status, edge.code]).toEqual(["edge", 502, "edge"]);
  });

  it("reads a body just under the cap", async () => {
    const big = `{"bodyHtml":"${"x".repeat(CLONE_EA_MAX_RESPONSE_BYTES - 20)}"}`;
    clone.setHandler(() => new Response(big, { status: 200, headers: { "content-type": "application/json" } }));
    const res = await cloneEaFetch(base());
    expect((res.body as { bodyHtml: string }).bodyHtml.length).toBe(CLONE_EA_MAX_RESPONSE_BYTES - 20);
  });
});

describe("CE09 the base URL", () => {
  it("is trimmed with trailing slashes stripped; missing is a config error before any fetch", async () => {
    process.env.MISSIVE_API_URL = "  https://clone.test///  ";
    expect(cloneEaBaseUrl()).toBe("https://clone.test");
    await cloneEaFetch(base());
    expect(clone.requests[0].url.href).toBe("https://clone.test/api/outlook-drafts/AAMk%3D");
    delete process.env.MISSIVE_API_URL;
    expect(() => cloneEaBaseUrl()).toThrow(NonRetryableError);
    let caught: unknown;
    try {
      cloneEaBaseUrl();
    } catch (err) {
      caught = err;
    }
    expect((caught as NonRetryableError).errorClass).toBe("auth");
    await expect(cloneEaFetch(base())).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(1);
    process.env.MISSIVE_API_URL = "   ";
    await expect(cloneEaFetch(base())).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("non-2xx answers", () => {
  it("map the clone's JSON error body, Retry-After and the edge page", async () => {
    clone.setHandler(() => json(429, { error: "throttled" }, { "retry-after": "7" }));
    const throttled = await failure(base({ route: "send" }));
    expect([throttled.kind, throttled.retryAfterMs, throttled.status]).toEqual(["throttled", 7_000, 429]);
    clone.setHandler(() => json(429, { error: "throttled" }));
    expect((await failure(base({ route: "send" }))).retryAfterMs).toBe(30_000);
    clone.setHandler((req) => expressNotFound(req.path));
    const edge = await failure(base());
    expect([edge.kind, edge.code, edge.status, edge.errorClass]).toEqual(["edge", "edge", 404, "retryable"]);
    clone.setHandler(() => json(404, { error: "gone", draftStatus: "deleted", replacedBy: "AAMkNew=" }));
    const gone = await failure(base());
    expect([gone.kind, gone.draftStatus, gone.replacedBy, gone.errorClass]).toEqual(["gone", "deleted", "AAMkNew=", "fatal"]);
    clone.setHandler(() => json(401, { error: "invalid_token" }));
    expect((await failure(base())).errorClass).toBe("auth");
  });
});

describe("CE10 nothing sensitive is logged", () => {
  it("no console line carries the token, a request or response body, or a detail", async () => {
    const detail = "Bearer eyJSECRETDETAIL";
    const requestBody = { bodyHtml: "<p>SECRETREQUEST</p>", to: [{ address: "secret@example.com" }] };
    const cases: Array<() => Response | Promise<Response>> = [
      () => json(401, { error: "invalid_token", detail }),
      () => json(500, { error: "server_error", detail: "SECRETRESPONSE" }),
      () => new Response("SECRETHTML", { status: 502, headers: { "content-type": "text/html" } }),
      () => new Response("SECRETBAD", { status: 200, headers: { "content-type": "application/json" } }),
      () => {
        throw Object.assign(new Error("boom SECRETERR"), { code: "ECONNRESET" });
      }
    ];
    for (const handler of cases) {
      clone.setHandler(handler);
      await failure(base({ route: "create_new", method: "POST", path: CLONE_EA_PATHS.createNew(), json: requestBody, idempotencyKey: "ed_1:v1:save:x" }));
    }
    vi.useFakeTimers();
    clone.setHandler(() => new Promise<Response>(() => undefined));
    const pending = failure(base({ timeoutMs: 10, json: requestBody }));
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    const logged = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]
      .map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      .join("\n");
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, "SECRET", "secret@example.com", "eyJ"]) expect(logged).not.toContain(secret);
  });
});
