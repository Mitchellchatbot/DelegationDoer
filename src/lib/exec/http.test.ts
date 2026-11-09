import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn() }));

import { auditFinish, auditStart } from "@/lib/exec/audit";
import type { DraftErrorCode } from "@/lib/exec/drafts-types";
import {
  RATE_BUCKETS,
  assertSameOrigin,
  auditNthNewestAt,
  isSameOriginRequest,
  jsonAnswer,
  jsonError,
  rateLimit,
  readJsonBody,
  readJsonBodyOrError,
  runAudited
} from "@/lib/exec/http";
import { principalFromRows } from "@/lib/exec/principal";
import { AuditUnavailableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// src/lib/exec/http.ts: P4's bounded body reader, error answer and the
// same-origin check (P4 contract §3.12.1, C39, C56; P3's rule, moved here at
// P5a, bindings AM1), and P5a's additions (contract §3.2, S2, C11-C13; tests
// 1-4): assertSameOrigin, readJsonBodyOrError, the audit-backed rate limit and
// runAudited.

const URL_ = "https://ops.example/api/exec/drafts";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

/** A body sent in chunks with no Content-Length (chunked transfer). */
function streamed(chunks: string[]): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    }
  });
  return new Request(URL_, { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit);
}

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readJsonBody (C56; P5a adds the reason)", () => {
  it("parses a body within the cap, the cap itself included", async () => {
    expect(await readJsonBody(post(JSON.stringify({ version: 3 })), 64)).toEqual({ ok: true, value: { version: 3 } });
    const exact = JSON.stringify({ a: "x".repeat(10) });
    expect(await readJsonBody(post(exact), Buffer.byteLength(exact, "utf8"))).toEqual({ ok: true, value: { a: "x".repeat(10) } });
  });
  it("refuses a body over the cap as too_large, by its Content-Length or by what arrives", async () => {
    expect(await readJsonBody(post("{}", { "content-length": "100000" }), 8_192)).toEqual({ ok: false, reason: "too_large" });
    expect(await readJsonBody(post(JSON.stringify({ a: "x".repeat(9_000) })), 8_192)).toEqual({ ok: false, reason: "too_large" });
    expect(await readJsonBody(streamed(["{\"a\":\"", "x".repeat(5_000), "x".repeat(5_000), "\"}"]), 8_192)).toEqual({ ok: false, reason: "too_large" });
  });
  it("counts bytes, not characters", async () => {
    const wide = JSON.stringify({ a: String.fromCharCode(0x20ac).repeat(10) }); // 3 bytes each
    expect(await readJsonBody(post(wide), wide.length + 5)).toEqual({ ok: false, reason: "too_large" });
    expect((await readJsonBody(post(wide), Buffer.byteLength(wide, "utf8"))).ok).toBe(true);
  });
  it("reads a chunked body within the cap", async () => {
    expect(await readJsonBody(streamed(["{\"vers", "ion\":", "7}"]), 64)).toEqual({ ok: true, value: { version: 7 } });
  });
  it("refuses malformed JSON, an empty body and invalid UTF-8 as syntax", async () => {
    expect(await readJsonBody(post("{\"version\":"), 64)).toEqual({ ok: false, reason: "syntax" });
    expect(await readJsonBody(post(null), 64)).toEqual({ ok: false, reason: "syntax" });
    expect(await readJsonBody(post(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])), 64)).toEqual({ ok: false, reason: "syntax" });
  });
  it("refuses a nonsensical cap (nothing fits)", async () => {
    expect(await readJsonBody(post("{}"), -1)).toEqual({ ok: false, reason: "too_large" });
    expect(await readJsonBody(post("{}"), Number.NaN)).toEqual({ ok: false, reason: "too_large" });
  });
  it("test 3: 4,097 bytes against a 4,096 cap is too_large; a non-JSON body is syntax", async () => {
    const big = JSON.stringify({ a: "x".repeat(4_097 - 8) });
    expect(Buffer.byteLength(big, "utf8")).toBe(4_097);
    expect(await readJsonBody(post(big), 4_096)).toEqual({ ok: false, reason: "too_large" });
    expect(await readJsonBody(post("action=seen"), 4_096)).toEqual({ ok: false, reason: "syntax" });
    expect(await readJsonBody(post(JSON.stringify({ action: "seen" })), 4_096)).toEqual({ ok: true, value: { action: "seen" } });
  });
});

describe("readJsonBodyOrError (C12)", () => {
  it("413 too_large, 400 invalid with detail body, or the value; 4096 by default", async () => {
    let r = await readJsonBodyOrError(post(JSON.stringify({ a: "x".repeat(4_100) })));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(413);
      expect(await r.response.json()).toEqual({ error: "too_large" });
    }
    r = await readJsonBodyOrError(post("{nope"), 4_096);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json()).toEqual({ error: "invalid", detail: "body" });
      expect(r.response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await readJsonBodyOrError(post(JSON.stringify({ vote: 1 })))).toEqual({ ok: true, value: { vote: 1 } });
    r = await readJsonBodyOrError(post(JSON.stringify({ a: "x".repeat(100) })), 64);
    expect(!r.ok && r.response.status).toBe(413);
  });
});

describe("jsonError / jsonAnswer", () => {
  it("answers { error: code, ...extra }, never cached (P4's no-store, bindings AM2)", async () => {
    const r = jsonError(409, "state_conflict", { status: "saving" });
    expect(r.status).toBe(409);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("retry-after")).toBeNull();
    expect(await r.json()).toEqual({ error: "state_conflict", status: "saving" });
  });
  it("a 429 carries Retry-After: 60 by default, or the route's retryAfterSec rounded up", async () => {
    expect(jsonError(429, "rate_limited").headers.get("retry-after")).toBe("60");
    expect(jsonError(429, "rate_limited", { retryAfterSec: 2.2 }).headers.get("retry-after")).toBe("3");
    expect(jsonError(429, "rate_limited", { retryAfterSec: 0 }).headers.get("retry-after")).toBe("60");
  });
  it("P5a: a 429 with retryAfterSeconds in the body sends the same Retry-After", async () => {
    const r = jsonError(429, "rate_limited", { retryAfterSeconds: 17 });
    expect(r.headers.get("retry-after")).toBe("17");
    expect(await r.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 17 });
  });
  it("accepts every P4 DraftErrorCode and a plain string (the code is widened, test 3)", async () => {
    // Typed as DraftErrorCode, so the list can't hold anything P4 doesn't define.
    const P4_CODES: DraftErrorCode[] = [
      "not_found", "forbidden", "bad_request", "invalid", "drafts_off", "send_off", "drafts_unavailable", "send_unavailable",
      "rate_limited", "version_conflict", "state_conflict", "review_required", "review_expired", "acks_missing",
      "recipients_blocked", "placeholders", "empty_body", "unsafe_markup", "instruction_required", "subject_required",
      "thread_unavailable", "mailbox_problem", "audit_unavailable", "unavailable", "hold", "sent_copy_found"
    ];
    for (const code of P4_CODES) {
      const r = jsonError(409, code);
      expect(await r.json()).toEqual({ error: code });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    for (const code of ["not_found", "invalid", "invalid_cursor", "conflict", "invalid_transition", "not_installed", "unavailable", "too_large"]) {
      const r = jsonError(400, code);
      expect(await r.json()).toEqual({ error: code });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("jsonAnswer passes the body through, never cached", async () => {
    const r = jsonAnswer(202, { status: "sent_pending", code: "accepted" });
    expect(r.status).toBe(202);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ status: "sent_pending", code: "accepted" });
  });
});

describe("isSameOriginRequest and assertSameOrigin (C13, AM1, test 1)", () => {
  const req = (h: Record<string, string>) => new Request(URL_, { method: "POST", headers: h });
  const CASES: [string, Record<string, string>, boolean][] = [
    ["sec-fetch-site same-origin", { "sec-fetch-site": "same-origin" }, true],
    ["sec-fetch-site same-origin, any case and padding", { "sec-fetch-site": " Same-Origin " }, true],
    ["sec-fetch-site same-origin wins over a foreign Origin", { "sec-fetch-site": "same-origin", origin: "https://evil.example" }, true],
    ["sec-fetch-site same-site", { "sec-fetch-site": "same-site", origin: "https://ops.example", host: "ops.example" }, false],
    ["sec-fetch-site cross-site", { "sec-fetch-site": "cross-site" }, false],
    ["sec-fetch-site none", { "sec-fetch-site": "none", origin: "https://ops.example", host: "ops.example" }, false],
    ["no header, Origin host = Host", { origin: "https://ops.example", host: "ops.example" }, true],
    ["no header, Origin host = Host, any case", { origin: "https://OPS.Example", host: "ops.example" }, true],
    ["no header, Origin host = the first X-Forwarded-Host entry", { origin: "https://ops.example", host: "internal:3000", "x-forwarded-host": "ops.example" }, true],
    // P3's variant shipped (bindings AM1): any X-Forwarded-Host entry counts.
    ["no header, Origin host = a later X-Forwarded-Host entry", { origin: "https://ops.example", host: "internal:3000", "x-forwarded-host": "proxy.internal, ops.example" }, true],
    ["no header, a different Origin", { origin: "https://evil.example", host: "ops.example" }, false],
    ["no header, a suffix lookalike", { origin: "https://ops.example.evil.example", host: "ops.example" }, false],
    ["no header, Origin with another port", { origin: "https://ops.example:8443", host: "ops.example" }, false],
    ["no header, Origin null", { origin: "null", host: "ops.example" }, false],
    ["no header, Origin not a URL", { origin: "not a url", host: "ops.example" }, false],
    ["neither header nor Origin", { host: "ops.example" }, false],
    ["nothing at all", {}, false]
  ];
  it.each(CASES)("%s", async (_name, headers, expected) => {
    expect(isSameOriginRequest(req(headers))).toBe(expected);
    const guard = assertSameOrigin(req(headers));
    // One implementation: the wrapper agrees with the check on every case (a-build-1).
    expect(guard.ok).toBe(isSameOriginRequest(req(headers)));
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
      expect(await guard.response.json()).toEqual({ error: "forbidden" });
      expect(guard.response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

// ---------------------------------------------------------------------------
// rateLimit (C11, test 2)
// ---------------------------------------------------------------------------

interface RateQuery {
  table: string;
  columns: string | null;
  calls: [string, ...unknown[]][];
}
let rateQueries: RateQuery[];
let rateResult: (q: RateQuery) => { data: unknown; error: { message: string } | null };

function fakeAdmin() {
  return {
    from(table: string) {
      const q: RateQuery = { table, columns: null, calls: [] };
      rateQueries.push(q);
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => ((q.columns = cols), b);
      for (const m of ["eq", "gte", "in", "order", "range", "abortSignal"]) b[m] = (...args: unknown[]) => (q.calls.push([m, ...args]), b);
      b.then = <A, B>(ok?: (v: unknown) => A, bad?: (e: unknown) => B) => Promise.resolve().then(() => rateResult(q)).then(ok, bad);
      return b;
    }
  };
}

describe("rateLimit (S2, C11, test 2)", () => {
  const NOW = new Date("2026-11-06T12:00:00.000Z");
  beforeEach(() => {
    rateQueries = [];
    rateResult = () => ({ data: [], error: null });
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAdmin() as unknown as SupabaseClient);
  });

  it("under the limit: ok, reading the limit-th newest audit row of the bucket's actions in the window", async () => {
    expect(await rateLimit(principal, "attention_action", 120, 600_000, { now: NOW })).toEqual({ ok: true });
    expect(rateQueries).toHaveLength(1);
    const [q] = rateQueries;
    expect(q.table).toBe("exec_audit_log");
    expect(q.columns).toBe("created_at");
    expect(q.calls).toEqual([
      ["eq", "principal_id", "ep_owner"],
      ["gte", "created_at", "2026-11-06T11:50:00.000Z"],
      ["in", "action", ["attention.seen", "attention.snooze", "attention.dismiss", "attention.resolve", "attention.reopen"]],
      ["order", "created_at", { ascending: false }],
      ["range", 119, 119]
    ]);
  });

  it("at the limit: 429 rate_limited with retryAfterSeconds = the nth row's age out of the window, and Retry-After", async () => {
    rateResult = () => ({ data: [{ created_at: "2026-11-06T11:52:30.250Z" }], error: null });
    const r = await rateLimit(principal, "attention_feedback", 60, 600_000, { now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(429);
    // 11:52:30.25 + 10 min = 12:02:30.25 → 150.25 s → 151.
    expect(await r.response.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 151 });
    expect(r.response.headers.get("retry-after")).toBe("151");
    expect(rateQueries[0].calls).toContainEqual(["in", "action", ["attention.feedback"]]);
    expect(rateQueries[0].calls).toContainEqual(["range", 59, 59]);
  });

  it("Retry-After is at least 1 s, even for a row right at the window's edge", async () => {
    rateResult = () => ({ data: [{ created_at: "2026-11-06T11:50:00.000Z" }], error: null });
    const r = await rateLimit(principal, "settings_update", 30, 600_000, { now: NOW });
    expect(!r.ok && (await r.response.json())).toEqual({ error: "rate_limited", retryAfterSeconds: 1 });
    expect(!r.ok && r.response.headers.get("retry-after")).toBe("1");
    expect(rateQueries[0].calls).toContainEqual(["in", "action", ["settings.update", "settings.voice_reset"]]);
  });

  it("a read error fails closed: 503 unavailable, never ok (M17)", async () => {
    rateResult = () => ({ data: null, error: { message: "timeout reading exec_audit_log" } });
    const r = await rateLimit(principal, "assess", 20, 600_000, { now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    expect(await r.response.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("timeout reading");
  });

  it("a malformed answer or a throwing client also fails closed", async () => {
    rateResult = () => ({ data: [{ created_at: "not a time" }], error: null });
    expect((await rateLimit(principal, "assess", 20, 600_000, { now: NOW })).ok).toBe(false);
    rateResult = () => ({ data: null, error: null });
    expect((await rateLimit(principal, "assess", 20, 600_000, { now: NOW })).ok).toBe(false);
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no client");
    });
    const r = await rateLimit(principal, "assess", 20, 600_000, { now: NOW });
    expect(!r.ok && r.response.status).toBe(503);
  });

  it("refuses a nonsensical limit or window as unavailable rather than letting it through", async () => {
    for (const [limit, windowMs] of [[0, 600_000], [1.5, 600_000], [10, 0], [10, Number.NaN]] as const) {
      const r = await rateLimit(principal, "assess", limit, windowMs, { now: NOW });
      expect(!r.ok && r.response.status).toBe(503);
    }
    expect(rateQueries).toEqual([]);
  });

  it("passes the signal to the read", async () => {
    const signal = new AbortController().signal;
    await rateLimit(principal, "assess", 20, 600_000, { now: NOW, signal });
    expect(rateQueries[0].calls).toContainEqual(["abortSignal", signal]);
  });

  it("registers the four buckets; auditNthNewestAt needs at least one action", () => {
    expect(Object.keys(RATE_BUCKETS).sort()).toEqual(["assess", "attention_action", "attention_feedback", "settings_update"]);
    expect(() => auditNthNewestAt([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runAudited (a-build-10, test 4)
// ---------------------------------------------------------------------------

describe("runAudited (a-build-10, test 4)", () => {
  const ENTRY = { actor: "owner" as const, action: "attention.dismiss", target: "exec_attention_items:ea_1", input: { action: "dismiss" } };
  afterEach(() => {
    vi.mocked(auditStart).mockReset();
    vi.mocked(auditFinish).mockReset();
  });

  it("the audit row can't be written: 503 unavailable and fn never runs", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable: timeout"));
    const fn = vi.fn(async () => "x");
    const r = await runAudited(principal, ENTRY, fn, () => ({ ok: true, outcome: "applied" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    expect(await r.response.json()).toEqual({ error: "unavailable" });
    expect(fn).not.toHaveBeenCalled();
    expect(auditFinish).not.toHaveBeenCalled();
  });

  it("fn throws: 503 with no message echoed, and the row finished ok = false, error = exception", async () => {
    vi.mocked(auditStart).mockResolvedValue(77);
    const r = await runAudited(
      principal,
      ENTRY,
      async () => {
        throw new Error("SECRET row text from the database");
      },
      () => ({ ok: true, outcome: "applied" })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    const body = await r.response.json();
    expect(body).toEqual({ error: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, error: "exception" });
  });

  it.each([
    ["applied", true],
    ["unchanged", true],
    ["conflict", false],
    ["invalid_transition", false],
    ["not_found", false]
  ] as const)("a returned %s finishes the row with outcomeOf's verdict (ok %s) and returns the value", async (outcome, ok) => {
    vi.mocked(auditStart).mockResolvedValue(5);
    const value = { outcome };
    const r = await runAudited(principal, ENTRY, async () => value, (v) => ({ ok: v.outcome === "applied" || v.outcome === "unchanged", outcome: v.outcome }));
    expect(r).toEqual({ ok: true, value });
    // Never withAudit's blanket { ok: true } (M35).
    expect(auditFinish).toHaveBeenCalledWith(5, { ok, result: { outcome } });
    expect(auditStart).toHaveBeenCalledWith(principal, ENTRY);
    expect(vi.mocked(auditStart).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(auditFinish).mock.invocationCallOrder[0]);
  });

  it("starts the row before fn runs", async () => {
    const order: string[] = [];
    vi.mocked(auditStart).mockImplementation(async () => (order.push("start"), 9));
    vi.mocked(auditFinish).mockImplementation(async () => void order.push("finish"));
    await runAudited(principal, ENTRY, async () => (order.push("act"), 1), () => ({ ok: true, outcome: "applied" }));
    expect(order).toEqual(["start", "act", "finish"]);
  });
});
