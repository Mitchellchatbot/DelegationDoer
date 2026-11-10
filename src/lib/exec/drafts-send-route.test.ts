import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/access", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/access")>()), requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/audit")>()),
  auditStart: vi.fn(),
  auditFinish: vi.fn(),
  auditEvent: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn(),
  countEnabledMailPinnedPrincipals: vi.fn(async () => 1),
  // P9 (F1): the real-gate cases below hand the gate its principal; nothing else in the send path loads one.
  loadPrincipalForUser: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn(async () => null),
  putSyncState: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/email-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/email-store")>()),
  getEmailThread: vi.fn(),
  listCorrespondentRows: vi.fn(),
  listThreadScreenRows: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  getMailTimezone: vi.fn(),
  listUsers: vi.fn(),
  listClientMatchSignals: vi.fn()
}));
vi.mock("@/lib/exec/correlate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/correlate")>()), loadClientMatcher: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/mail")>()),
  readPrincipalThread: vi.fn(),
  loadScreeningPolicy: vi.fn(),
  findSentCopy: vi.fn(),
  listInternalAddresses: vi.fn(),
  listReplyArtifacts: vi.fn()
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { POST as SEND } from "@/app/api/exec/drafts/[id]/send/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import { OWNER_AUTH_ID, linkWithOwnFactorToken, settle, strongToken } from "./__tests__/step-up-fixtures";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { recipientsSignature } from "@/lib/exec/recipients";
import { loadScreeningPolicy, screenHashesFor } from "@/lib/exec/sources/mail";
import { AuditUnavailableError } from "@/lib/exec/types";
import { cl2Error, type Cl2Reply } from "./__tests__/fake-clone";
import {
  CLIENT,
  DRAFT_TOKEN,
  GRAPH,
  HASH_A,
  HASH_B,
  ID1,
  SEND_TOKEN,
  bodyOf,
  jsonRequest,
  minutesAgo,
  policyOf,
  reviewedRow,
  rowOf,
  rule,
  setupDraftEnv,
  type DraftEnv
} from "./__tests__/drafts-harness";

// The send route (P4 contract §3.12.4, §2.6.5; §5.8 RS01-RS14): the fixed
// order, audit first, one counted CAS, exactly one /send with the stored
// review hash, the mapped outcome on the attempt key, never the request's
// signal, never a retry.

const ENV = { ...process.env };
let env: DraftEnv;
const ctx = { params: { id: ID1 } };
const send = (body: Record<string, unknown> = { reviewHash: HASH_A, acks: [] }, init?: RequestInit) =>
  SEND(init ? new Request(`https://ops.test/api/exec/drafts/${ID1}/send`, init) : jsonRequest("POST", `/api/exec/drafts/${ID1}/send`, body), ctx);
const accepted: Cl2Reply = { status: 202, body: { graphId: GRAPH, status: "sent_pending_verification", internetMessageId: "<sent.1@outlook.com>" } };

beforeEach(() => {
  env = setupDraftEnv({ rows: [reviewedRow()] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ENV };
});

describe("RS01 the order", () => {
  it("gate → settings → readiness → row → screens → auditStart → CAS → send → CAS → auditFinish", async () => {
    const events: string[] = [];
    env = setupDraftEnv({ rows: [reviewedRow()], db: { before: (r) => void events.push(`db:${r.kind} ${r.target}`) } });
    vi.mocked(requireExecPrincipal).mockImplementation((async () => {
      events.push("gate");
      const { PRINCIPAL } = await import("./__tests__/drafts-harness");
      return { ok: true, principal: PRINCIPAL };
    }) as never);
    const settings = await vi.mocked(loadSettings).getMockImplementation()?.("x");
    vi.mocked(loadSettings).mockImplementation(async () => {
      events.push("settings");
      return settings as never;
    });
    vi.mocked(loadScreeningPolicy).mockImplementation(async () => {
      events.push("screens");
      return policyOf([]);
    });
    vi.mocked(auditStart).mockImplementation(async () => {
      events.push("auditStart");
      return 501;
    });
    vi.mocked(auditFinish).mockImplementation(async () => void events.push("auditFinish"));
    env.fake.defaultAnswer("status", () => {
      events.push("readiness");
      return { status: 200, body: { ok: true, cl2: { ready: true, send: "all" } } };
    });
    env.fake.answer("send", () => {
      events.push("send");
      return accepted as never;
    });
    const res = await send();
    expect(res.status).toBe(202);
    const wanted = ["gate", "settings", "readiness", "db:select exec_drafts", "screens", "auditStart", "db:update exec_drafts", "send", "db:update exec_drafts", "auditFinish"];
    let at = -1;
    for (const w of wanted) {
      const next = events.indexOf(w, at + 1);
      expect(next, `${w} after ${events.slice(0, at + 1).join(",")}`).toBeGreaterThan(at);
      at = next;
    }
  });
});

describe("RS02-RS03 audit first, the counted CAS", () => {
  it("RS02 audit down → 503 audit_unavailable; no CAS, no send", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    const res = await send();
    expect(res.status).toBe(503);
    expect((await bodyOf(res)).error).toBe("audit_unavailable");
    expect(env.fake.of("send")).toHaveLength(0);
    expect(env.db.log.filter((l) => l === "update exec_drafts")).toHaveLength(0);
    expect(rowOf(env.db).status).toBe("saved");
  });
  it("RS03 the CAS takes 0 rows → 409 state_conflict, auditFinish(ok: false), no send", async () => {
    let bumped = false;
    env = setupDraftEnv({
      rows: [reviewedRow()],
      db: { before: (r, db) => {
        if (!bumped && r.kind === "update" && r.target === "exec_drafts") {
          bumped = true;
          db.tables.exec_drafts[0].version = 5;
        }
      } }
    });
    const res = await send();
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("state_conflict");
    expect(env.fake.of("send")).toHaveLength(0);
    expect(vi.mocked(auditFinish).mock.calls[0][1]).toEqual({ ok: false, error: "not_saved" });
  });
});

describe("the attempt clock (data-5, C4)", () => {
  it("send_started_at and the stale next_check_at come from the CAS, not the request's start", async () => {
    const t0 = new Date("2026-11-06T15:00:00.000Z");
    vi.useFakeTimers({ now: t0, toFake: ["Date"] });
    env = setupDraftEnv({ rows: [reviewedRow({ review_at: t0.toISOString() })] });
    const next = vi.mocked(auditStart).getMockImplementation();
    vi.mocked(auditStart).mockImplementationOnce(async (...args) => {
      vi.setSystemTime(new Date(t0.getTime() + 20_000)); // a slow path before the CAS
      return next ? next(...args) : 1;
    });
    await send();
    expect(Date.parse(String(rowOf(env.db).send_started_at))).toBe(t0.getTime() + 20_000);
  });
});

describe("the confirmed recipients (ui-9, L10)", () => {
  it("the row keeps the reviewed read-back's recipients through the send: the sent banner names who it went to", async () => {
    const reviewed = { from: null, sender: null, replyTo: [], to: [{ address: CLIENT, name: "Client" }, { address: "boss@x.example", name: null }], cc: [{ address: "cc@x.example", name: null }], bcc: [] };
    env = setupDraftEnv({ rows: [reviewedRow({ review_recipients: reviewed, to_recipients: [{ address: CLIENT, name: "Client" }], cc_recipients: [] })] });
    env.fake.answer("send", accepted);
    expect((await send()).status).toBe(202);
    const row = rowOf(env.db);
    expect(row.to_recipients).toEqual(reviewed.to);
    expect(row.cc_recipients).toEqual(reviewed.cc);
    expect(row.bcc_recipients).toEqual([]);
    expect(row.recipients_sig).toBe(recipientsSignature({ to: reviewed.to, cc: reviewed.cc, bcc: [] }));
    expect(row.review_recipients).toBeNull(); // the review itself is cleared on the status change
  });
});

describe("RS04 a double click", () => {
  it("two concurrent POSTs with the same reviewHash → exactly one /send; the other 409", async () => {
    env.fake.defaultAnswer("send", accepted);
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(env.fake.of("send")).toHaveLength(1);
  });
});

describe("RS05 the review", () => {
  it("stale by 1 ms → review_expired; another hash → review_required; opened after the review → review_required; a missing ack → acks_missing", async () => {
    env = setupDraftEnv({ rows: [reviewedRow({ review_at: new Date(Date.now() - 600_001).toISOString() })] });
    expect((await bodyOf(await send())).error).toBe("review_expired");
    env = setupDraftEnv({ rows: [reviewedRow()] });
    expect((await bodyOf(await send({ reviewHash: HASH_B, acks: [] }))).error).toBe("review_required");
    env = setupDraftEnv({ rows: [reviewedRow({ review_at: minutesAgo(2), opened_in_outlook_at: minutesAgo(1) })] });
    expect((await bodyOf(await send())).error).toBe("review_required");
    env = setupDraftEnv({ rows: [reviewedRow({ review_blockers: ["already_replied", "reply_to_present"] })] });
    const res = await send({ reviewHash: HASH_A, acks: ["reply_to_present"] });
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "acks_missing", blockers: ["already_replied"] });
    expect(env.fake.of("send")).toHaveLength(0);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  });
});

describe("RS06-RS07 the last checks before the audit row", () => {
  it("RS06 a restricted rule added after the review that matches a To → 422, the review cleared, no send", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule(CLIENT, "exact")]));
    const res = await send();
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({ error: "recipients_blocked", errors: [{ code: "restricted_recipient", address: CLIENT }] });
    expect(rowOf(env.db)).toMatchObject({ status: "saved", review_hash: null, review_at: null });
    expect(env.fake.of("send")).toHaveLength(0);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  });
  it("RS07 a placeholder in body_text → 422", async () => {
    env = setupDraftEnv({ rows: [reviewedRow({ body_text: "Call me on [phone]", body_html: "<p>Call me on [phone]</p>" })] });
    const res = await send();
    expect(res.status).toBe(422);
    expect((await bodyOf(res)).error).toBe("placeholders");
    expect(env.fake.of("send")).toHaveLength(0);
  });
});

// §2.6.5 row by row: the clone's answer → (final status, response code, HTTP, review kept, ops alert, kick).
const ROWS: [string, Cl2Reply, string, string, number, boolean, string | null, boolean][] = [
  ["202 accepted", accepted, "sent_pending", "accepted", 202, false, null, true],
  ["409 changed", cl2Error(409, "changed", { draftStatus: "saved" }), "saved", "changed", 200, false, null, false],
  ["409 already_sending", cl2Error(409, "already_sending", { draftStatus: "sending" }), "unknown", "already_sending", 200, false, null, true],
  ["409 already_sending, provisional", cl2Error(409, "already_sending"), "unknown", "already_sending", 200, false, null, true],
  ["409 already_sent pending", cl2Error(409, "already_sent", { draftStatus: "sent_pending_verification" }), "sent_pending", "already_sent", 200, false, null, true],
  ["409 already_sent sent", cl2Error(409, "already_sent", { draftStatus: "sent" }), "sent", "already_sent", 200, false, null, false],
  ["409 already_sent mismatch", cl2Error(409, "already_sent", { draftStatus: "sent_mismatch" }), "sent", "already_sent", 200, false, "draft-sent-mismatch", false],
  ["409 sent_externally", cl2Error(409, "sent_externally", { draftStatus: "sent_external" }), "sent_external", "sent_externally", 200, false, null, false],
  ["409 parent_missing", cl2Error(409, "parent_missing", { draftStatus: "saved" }), "saved", "clone_anomaly", 200, true, "clone-anomaly", false],
  ["403 send_disabled", cl2Error(403, "forbidden_scope", { detail: "send_disabled" }), "saved", "send_disabled", 200, true, null, false],
  ["401", cl2Error(401, "invalid_token"), "saved", "ea_auth", 200, true, "clone-ea-auth", false],
  ["400", cl2Error(400, "bad_request", { detail: "confirmHash" }), "saved", "bad_request", 200, true, "clone-ea-bug", false],
  ["404 not_found", cl2Error(404, "not_found"), "saved", "clone_anomaly", 200, false, "draft-registry-missing", false],
  ["404 gone", cl2Error(404, "gone", { draftStatus: "gone" }), "gone", "gone", 200, false, null, false],
  ["404 gone saved", cl2Error(404, "gone", { draftStatus: "saved" }), "saved", "outlook_not_found", 200, false, null, false],
  ["422", cl2Error(422, "idempotency_mismatch"), "unknown", "idempotency_mismatch", 200, false, "clone-ea-bug", true],
  ["429", cl2Error(429, "throttled", { draftStatus: "saved" }, { "retry-after": "7" }), "saved", "throttled", 200, true, null, false],
  ["502 saved", cl2Error(502, "graph_error", { draftStatus: "saved", graphStatus: 503 }), "saved", "graph_error", 200, true, "clone-anomaly", false],
  ["502 unknown", cl2Error(502, "graph_error", { draftStatus: "unknown", graphStatus: 500 }), "unknown", "graph_error", 200, false, "draft-send-unknown", true],
  ["503", cl2Error(503, "not_ready", { draftStatus: "saved" }), "saved", "clone_not_ready", 200, true, "clone-anomaly", false],
  ["504 saved", cl2Error(504, "graph_timeout", { draftStatus: "saved" }), "saved", "timeout_nothing_sent", 200, true, null, false],
  ["504 unknown", cl2Error(504, "graph_timeout", { draftStatus: "unknown" }), "unknown", "timeout", 200, false, "draft-send-unknown", true],
  ["500", cl2Error(500, "server_error"), "unknown", "clone_error", 200, false, "draft-send-unknown", true]
];

describe("RS08 every §2.6.5 row end to end", () => {
  it.each(ROWS)("%s → the row, the answer, the audit, the kick and the alert", async (_n, reply, status, code, http, kept, alert, kick) => {
    env.fake.answer("send", reply);
    const res = await send();
    expect(res.status).toBe(http);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ status, code });
    if (code === "throttled") expect(body.retryAfterSec).toBe(7);
    const row = rowOf(env.db);
    expect(row.status).toBe(status);
    expect(row.review_hash).toBe(kept ? HASH_A : null);
    const finish = vi.mocked(auditFinish).mock.calls[0][1];
    expect(finish).toMatchObject({ ok: status === "sent_pending" || status === "sent", result: { outcome: status, code } });
    expect(Object.keys(finish.result as object).sort()).toEqual(["code", "draftStatus", "httpStatus", "outcome", "replay"]);
    const kicks = vi.mocked(enqueueJob).mock.calls.map((c) => c[0]).filter((j) => j.kind === "exec.draft-reconcile");
    expect(kicks).toHaveLength(kick ? 1 : 0);
    if (kick) expect(String(kicks[0].dedupeKey)).toMatch(/^draft-recon:ep_owner:a[0-9a-f]{16}$/);
    const alerts = vi.mocked(notifyOps).mock.calls.map((c) => c[0].key);
    if (alert === null) expect(alerts.filter((k) => /^(draft-|clone-)/.test(k) && !k.startsWith("clone-ea-readiness"))).toEqual([]);
    else expect(alerts).toContain(`${alert}:send`);
    if (code === "outlook_not_found") expect(row.next_check_at).not.toBeNull();
    if (code === "accepted") expect(row.internet_message_id).toBe("<sent.1@outlook.com>");
  });
  it("no answer within 150 s → unknown with transport, the review cleared, a kick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    env.fake.dropResponse.add("send");
    env.fake.answer("send", accepted);
    let done: Response | null = null;
    const p = send().then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(149_000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(await bodyOf(done as unknown as Response)).toMatchObject({ status: "unknown", code: "transport" });
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", review_hash: null });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
  });
  // Integrator (mutant MU02): §2.6's precedence end to end. The registry's draftStatus decides
  // the status even where the error kind alone would say otherwise.
  it("draftStatus outranks the HTTP answer: 409 changed + sent → sent; 502 graph_error + sent_pending_verification → sent_pending", async () => {
    env.fake.answer("send", cl2Error(409, "changed", { draftStatus: "sent" }));
    expect(await bodyOf(await send())).toMatchObject({ status: "sent" });
    expect(rowOf(env.db)).toMatchObject({ status: "sent", review_hash: null });
    expect(vi.mocked(auditFinish).mock.calls[0][1]).toMatchObject({ ok: true, result: { outcome: "sent" } });
    env = setupDraftEnv({ rows: [reviewedRow()] });
    env.fake.answer("send", cl2Error(502, "graph_error", { draftStatus: "sent_pending_verification", graphStatus: 500 }));
    expect(await bodyOf(await send())).toMatchObject({ status: "sent_pending" });
    expect(rowOf(env.db).status).toBe("sent_pending");
  });
});

describe("RS09-RS11 the one request", () => {
  it("RS09 the confirmHash is the stored review hash; no GET between the CAS and /send", async () => {
    env.fake.answer("send", accepted);
    await send();
    const s = env.fake.of("send")[0];
    expect(s.json).toEqual({ confirmHash: HASH_A, idempotencyKey: s.idempotencyKey });
    expect(s.bearer).toBe(SEND_TOKEN);
    expect(env.fake.of("get_draft")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ confirm_hash: HASH_A, send_attempt_key: s.idempotencyKey });
  });
  it("RS10 each click gets a new key (after a 429 too) in the <id>:v<version>:send:<nonce> form", async () => {
    env.fake.answer("send", cl2Error(429, "throttled", { draftStatus: "saved" }), accepted);
    await send();
    await send();
    const keys = env.fake.of("send").map((r) => r.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) expect(k).toMatch(new RegExp(`^${ID1}:v1:send:[A-Za-z0-9_-]{16}$`));
    expect(rowOf(env.db).status).toBe("sent_pending");
  });
  it("RS11 aborting the incoming request mid-send doesn't abort the send fetch", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    env.fake.answer("send", async () => {
      await gate;
      return accepted as never;
    });
    const controller = new AbortController();
    const p = send(undefined, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ reviewHash: HASH_A, acks: [] }),
      signal: controller.signal
    });
    await vi.waitFor(() => expect(env.fake.of("send")).toHaveLength(1));
    controller.abort();
    expect(env.fake.of("send")[0].signal?.aborted).toBe(false);
    release();
    expect((await p).status).toBe(202);
    expect(rowOf(env.db).status).toBe("sent_pending");
  });
});

describe("RS12 restricted and send-off at the send", () => {
  it("restricted at send → 404 and the row purged, no send", async () => {
    const hashes = screenHashesFor({ all: [{ from: "x@evil.example", to: [], cc: [] }], participants: [] }).hashes;
    env = setupDraftEnv({ rows: [reviewedRow({ screen_hashes: hashes })] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("evil.example")]));
    expect((await send()).status).toBe(404);
    expect(rowOf(env.db)).toMatchObject({ restricted_purged: true, status: "saved", body_html: null });
    expect(env.fake.of("send")).toHaveLength(0);
  });
  it.each([
    ["send off", () => setupDraftEnv({ rows: [reviewedRow()], settings: { sendEnabled: false } }), "send_off", null],
    ["no send token", () => {
      const e = setupDraftEnv({ rows: [reviewedRow()] });
      delete process.env.MISSIVE_EA_SEND_TOKEN;
      return e;
    }, "send_unavailable", "send_token"],
    ["cl2.send off", () => setupDraftEnv({ rows: [reviewedRow()], clone: { send: "off" } }), "send_unavailable", "clone_send_off"],
    ["auth.sendEnabled false", () => {
      const e = setupDraftEnv({ rows: [reviewedRow()] });
      e.fake.defaultAnswer("auth_me", { status: 200, body: { user: { id: "u_ea" }, auth: { kind: "scoped", scopes: ["draft", "read"], accounts: ["acc_his"], jti: "jti_0123456789abcdef", expiresAt: "2027-11-04T00:00:00.000Z", sendEnabled: false } } });
      return e;
    }, "send_unavailable", "clone_send_off"]
  ])("%s → 409 with the reason, no audit row, no send", async (_n, setup, error, reason) => {
    env = setup();
    const res = await send();
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(body.error).toBe(error);
    if (reason !== null) expect(body.reason).toBe(reason);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
    expect(env.fake.of("send")).toHaveLength(0);
  });
});

describe("RS13 what an answer may carry", () => {
  it.each(ROWS)("%s: a status and a code (and Retry-After), never clone text, a token, the read-back or recipients", async (_n, reply) => {
    env.fake.answer("send", reply);
    const res = await send();
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).every((k) => ["status", "code", "retryAfterSec"].includes(k))).toBe(true);
    for (const secret of [CLIENT, DRAFT_TOKEN, SEND_TOKEN, "bodyHtml", "Thanks, we're on it", "detail", "<sent.1@outlook.com>"]) expect(text).not.toContain(secret);
  });
});

// P9 F1: the route's own gate call, run for real (vi.importActual) over a faked session, in front of a reviewed, sendable
// draft. A leader-minted link session that enrolled its own authenticator (aal2, amr [totp, otp]) must get the gate's 404:
// no audit row, no CAS, and no /send to the clone. His password sign-in (aal1, amr [password]) is what the gate admits.
describe("P9 F1: the real step-up in front of POST /send", () => {
  async function realGate(token: string) {
    const real = await vi.importActual<typeof import("@/lib/exec/access")>("@/lib/exec/access");
    vi.mocked(requireExecPrincipal).mockImplementation(real.requireExecPrincipal);
    vi.stubEnv("EXEC_ENABLED", "true");
    const auth = {
      getUser: vi.fn(async () => ({ data: { user: { id: OWNER_AUTH_ID } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: token } }, error: null }))
    };
    vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
    const drafts = env.db.client as { from(table: string): unknown; rpc(name: string, args?: unknown): unknown };
    const logRows: Record<string, unknown>[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from(table: string) {
        if (table === "users") {
          const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: "u_ep_owner", email: "mitchell@scaledai.org" }, error: null }) };
          return b;
        }
        if (table === "exec_access_log") return { insert: async (row: Record<string, unknown>) => (logRows.push(row), { error: null }) };
        return drafts.from(table);
      },
      rpc: (name: string, args?: unknown) => drafts.rpc(name, args)
    } as unknown as SupabaseClient);
    const { PRINCIPAL } = await import("./__tests__/drafts-harness");
    vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
    return { logRows };
  }

  it("F1: a link session with its own second factor (aal2, amr [totp, otp]) → 404; no audit row, no CAS, no /send", async () => {
    const gate = await realGate(linkWithOwnFactorToken("sess-link-mfa", OWNER_AUTH_ID));
    env.fake.defaultAnswer("send", accepted);
    const res = await send();
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toEqual({ error: "not found" });
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
    expect(env.fake.of("send")).toHaveLength(0);
    expect(env.db.log.filter((l) => l === "update exec_drafts")).toHaveLength(0);
    expect(rowOf(env.db).status).toBe("saved");
    await settle();
    expect(gate.logRows).toEqual([expect.objectContaining({ route: "POST /api/exec/drafts/:id/send step_up_refused", session_id: "sess-link-mfa" })]);
  });

  it("control: his password sign-in (aal1, amr [password]) passes the same gate, and the one /send goes out (202)", async () => {
    const gate = await realGate(strongToken("sess-his", OWNER_AUTH_ID));
    env.fake.answer("send", accepted);
    const res = await send();
    expect(res.status).toBe(202);
    expect(env.fake.of("send")).toHaveLength(1);
    expect(gate.logRows).toEqual([expect.objectContaining({ route: "POST /api/exec/drafts/:id/send", session_id: "sess-his" })]);
  });
});

describe("RS14 the §2.6.5 default (security-8)", () => {
  it.each([
    ["a 202 with an unparseable body", { status: 202, body: { nope: true } }],
    ["a 200 that isn't JSON", new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })],
    ["a 409 with an unknown code", cl2Error(409, "brand_new_code", { draftStatus: null })],
    ["a 502 edge page", new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["a 418", cl2Error(418, "teapot")]
  ] as [string, Cl2Reply][])("%s → unknown with clone_anomaly, the review cleared, draft-send-unknown and a kick; never saved", async (_n, reply) => {
    env.fake.answer("send", reply);
    const body = await bodyOf(await send());
    expect(body).toMatchObject({ status: "unknown", code: "clone_anomaly" });
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", review_hash: null, last_error_code: "clone_anomaly" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toContain("draft-send-unknown:send");
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
  });
  it("a 404 gone with draftStatus saved ends saved with outlook_not_found and a follow-up check", async () => {
    env.fake.answer("send", cl2Error(404, "gone", { draftStatus: "saved" }));
    const before = Date.now();
    expect(await bodyOf(await send())).toMatchObject({ status: "saved", code: "outlook_not_found" });
    const row = rowOf(env.db);
    expect(row).toMatchObject({ status: "saved", last_error_code: "outlook_not_found" });
    const next = Date.parse(String(row.next_check_at));
    expect(next - before).toBeGreaterThanOrEqual(119_000);
    expect(next - before).toBeLessThanOrEqual(125_000);
  });
});
