import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn() }));
vi.mock("@/lib/exec/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/http")>()),
  rateLimit: vi.fn()
}));
vi.mock("@/lib/exec/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention")>()),
  applyOwnerAction: vi.fn(),
  getAttentionItemIdentity: vi.fn()
}));
vi.mock("@/lib/exec/attention-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention-read")>()),
  listScreenedAttention: vi.fn(),
  screenAttentionItems: vi.fn()
}));
vi.mock("@/lib/exec/attention-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention-feedback")>()),
  recordAttentionFeedback: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn()
}));

import * as listRoute from "@/app/api/exec/attention/route";
import * as itemRoute from "@/app/api/exec/attention/[id]/route";
import * as feedbackRoute from "@/app/api/exec/attention/[id]/feedback/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { applyOwnerAction, getAttentionItemIdentity, type AttentionPageRow } from "@/lib/exec/attention";
import { encodeAttentionCursor, listScreenedAttention, screenAttentionItems } from "@/lib/exec/attention-read";
import { recordAttentionFeedback } from "@/lib/exec/attention-feedback";
import type { AttentionFeedItem, AttentionItem } from "@/lib/exec/attention-types";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { AuditUnavailableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";

// The attention routes (P5a contract §3.6, S1, S2, A1, C3, C10-C12; tests 17,
// 18, 19): the gate with the step-up first, same-origin, the id, the body,
// the installed check, the limit, then the audit with the act inside it, and
// every answer's status and body.

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
const ITEM_ID = `ea_${"1".repeat(32)}`;
const VERSION = "2026-11-04T10:00:00.123456+00:00";
const BASE = "https://operations.scaledai.org/api/exec/attention";

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: ITEM_ID,
    principalId: "ep_owner",
    fingerprint: "dd:overdue:assignee:u_1",
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Sam has 3 overdue tasks",
    whatHappened: "",
    whyItMatters: "",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 50, band: "normal", reasons: [] },
    stateHash: "abcdef0123456789",
    occurredAt: null,
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-01T09:00:00.000Z",
    lastSeenAt: "2026-11-04T12:50:00.000Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-04T10:00:00.123Z",
    ...over
  };
}
const row = (over: Partial<AttentionItem> = {}, version = VERSION): AttentionPageRow => ({ item: item(over), version, firstSeenRaw: "2026-11-01T09:00:00+00:00" });
const feed = (over: Partial<AttentionItem> = {}, version = VERSION): AttentionFeedItem => ({ ...item(over), version });
const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({ principalId: "ep_owner", ...DEFAULT_SETTINGS, mutedChannelIds: [], ddtextSchemaReady: true, ...over });

const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const patchReq = (body: unknown, headers: Record<string, string> = SAME) =>
  new Request(`${BASE}/${ITEM_ID}`, { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const feedbackReq = (body: unknown, headers: Record<string, string> = SAME) =>
  new Request(`${BASE}/${ITEM_ID}/feedback`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const patch = (req: Request, id = ITEM_ID) => itemRoute.PATCH(req, { params: { id } });
const vote = (req: Request, id = ITEM_ID) => feedbackRoute.POST(req, { params: { id } });
const answer = async (res: Response | Promise<Response>) => {
  const r = await res;
  return [r.status, await r.json()] as const;
};

beforeEach(() => {
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
  vi.mocked(rateLimit).mockResolvedValue({ ok: true });
  vi.mocked(auditStart).mockResolvedValue(41);
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "applied", row: row({ status: "dismissed" }, "2026-11-06T12:00:00.000001+00:00") });
  vi.mocked(screenAttentionItems).mockImplementation(async (_p, items) => ({ items: [...items], hiddenEmail: 0, emailScreen: "none" }));
  vi.mocked(listScreenedAttention).mockResolvedValue({ items: [feed()], nextCursor: null, hiddenEmail: 0, emailScreen: "none" });
  vi.mocked(getAttentionItemIdentity).mockResolvedValue({ id: ITEM_ID, fingerprint: "dd:overdue:assignee:u_1", source: "dd", kind: "overdue_tasks" });
  vi.mocked(recordAttentionFeedback).mockImplementation(async (_p, itemId, input) => ({ outcome: "recorded", itemId, vote: input.vote, reason: input.reason }));
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const gateFails = () => vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) });
const order = (...fns: unknown[]) => fns.map((f) => (f as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

describe("the route files", () => {
  it("export only their handler and the route config", () => {
    expect(Object.keys(listRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["PATCH", "dynamic", "runtime"]);
    expect(Object.keys(feedbackRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
    for (const m of [listRoute, itemRoute, feedbackRoute]) {
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 17: GET /api/exec/attention
// ---------------------------------------------------------------------------

describe("GET /api/exec/attention (test 17)", () => {
  const get = (qs = "") => listRoute.GET(new Request(`${BASE}${qs}`));

  it("gates with the step-up; a refusal is the gate's own answer and nothing is read", async () => {
    gateFails();
    expect((await get()).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "GET /api/exec/attention", { requireStrongSignIn: true });
    expect(listScreenedAttention).not.toHaveBeenCalled();
  });

  it("200 with the page through the screened accessor", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: [feed()], nextCursor: "abc.def", hiddenEmail: 2, emailScreen: "ok" });
    const res = await get("?status=snoozed&band=high&limit=20");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["emailScreen", "generatedAt", "hiddenEmail", "items", "nextCursor"]);
    expect(body).toMatchObject({ nextCursor: "abc.def", hiddenEmail: 2, emailScreen: "ok" });
    expect(body.items[0]).toMatchObject({ id: ITEM_ID, version: VERSION });
    expect(listScreenedAttention).toHaveBeenCalledWith(principal, { status: "snoozed", band: "high", limit: 20 }, { now: expect.any(Date), signal: expect.any(AbortSignal) });
  });

  it.each([
    ["?status=archived", "status"],
    ["?category=urgent", "category"],
    ["?limit=500", "limit"],
    ["?firstSeenAfter=yesterday", "firstSeenAfter"],
    ["?band=high&band=normal", "band"],
    ["?kind=Bad-Kind", "kind"]
  ])("400 invalid for %s", async (qs, detail) => {
    expect(await answer(get(qs))).toEqual([400, { error: "invalid", detail }]);
    expect(listScreenedAttention).not.toHaveBeenCalled();
  });

  it("400 invalid_cursor for a cursor made for other filters or edited", async () => {
    const cursor = encodeAttentionCursor({ score: 5, firstSeenRaw: "2026-11-01T00:00:00+00:00", id: ITEM_ID }, { status: "open" });
    expect(await answer(get(`?cursor=${cursor}`))).toEqual([400, { error: "invalid_cursor" }]);
    expect(await answer(get(`?status=open&cursor=${cursor}x`))).toEqual([400, { error: "invalid_cursor" }]);
    expect(listScreenedAttention).not.toHaveBeenCalled();
    expect((await get(`?status=open&cursor=${cursor}`)).status).toBe(200);
  });

  it("503 unavailable when the store can't be read, the error never echoed", async () => {
    vi.mocked(listScreenedAttention).mockRejectedValue(new Error("exec_attention_items read failed: SECRET"));
    const [status, body] = await answer(get());
    expect([status, body]).toEqual([503, { error: "unavailable" }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("writes no audit row and checks no rate limit (a read)", async () => {
    await get();
    expect(auditStart).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 18: PATCH /api/exec/attention/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/exec/attention/:id: order (test 18)", () => {
  const OK_BODY = { action: "dismiss", expectedUpdatedAt: VERSION };

  it("a gate failure calls nothing else", async () => {
    gateFails();
    const req = patchReq(OK_BODY, { "sec-fetch-site": "cross-site" });
    expect((await patch(req, "bad")).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "PATCH /api/exec/attention/:id", { requireStrongSignIn: true });
    expect(req.bodyUsed).toBe(false);
    for (const fn of [rateLimit, auditStart, applyOwnerAction]) expect(fn).not.toHaveBeenCalled();
  });

  it("a cross-site request is 403 forbidden before the id or the body is read (M1)", async () => {
    const crossSite: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example", host: "operations.scaledai.org" }, {}];
    for (const headers of crossSite) {
      const req = patchReq(OK_BODY, headers);
      expect(await answer(patch(req, "not-an-id"))).toEqual([403, { error: "forbidden" }]);
      expect(req.bodyUsed).toBe(false);
    }
    for (const fn of [rateLimit, auditStart, applyOwnerAction]) expect(fn).not.toHaveBeenCalled();
  });

  it("a malformed id is 404 before the body is read", async () => {
    for (const id of ["ea_1", "x", `${ITEM_ID}0`, `EA_${"1".repeat(32)}`]) {
      const req = patchReq("{not json");
      expect(await answer(patch(req, id))).toEqual([404, { error: "not_found" }]);
      expect(req.bodyUsed).toBe(false);
    }
  });

  it("413 too_large, 400 invalid body, 400 invalid with the field path; nothing audited, no rate slot used", async () => {
    expect(await answer(patch(patchReq({ action: "dismiss", expectedUpdatedAt: VERSION, pad: "x".repeat(5000) })))).toEqual([413, { error: "too_large" }]);
    expect(await answer(patch(patchReq("{nope")))).toEqual([400, { error: "invalid", detail: "body" }]);
    expect(await answer(patch(patchReq({ action: "archive", expectedUpdatedAt: VERSION })))).toEqual([400, { error: "invalid", detail: "action" }]);
    expect(await answer(patch(patchReq({ action: "dismiss" })))).toEqual([400, { error: "invalid", detail: "expectedUpdatedAt" }]);
    expect(await answer(patch(patchReq({ action: "dismiss", expectedUpdatedAt: "yesterday" })))).toEqual([400, { error: "invalid", detail: "expectedUpdatedAt" }]);
    expect(await answer(patch(patchReq({ action: "dismiss", expectedUpdatedAt: VERSION, extra: 1 })))).toEqual([400, { error: "invalid", detail: "extra" }]);
    expect(await answer(patch(patchReq([1, 2])))).toEqual([400, { error: "invalid", detail: "body" }]);
    for (const fn of [rateLimit, auditStart, applyOwnerAction]) expect(fn).not.toHaveBeenCalled();
  });

  it("snoozeUntil: required with snooze and only then, more than 60 s and at most 90 days ahead (C4)", async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const far = new Date(Date.now() + 91 * 86_400_000).toISOString();
    for (const body of [
      { action: "snooze", expectedUpdatedAt: VERSION },
      { action: "snooze", expectedUpdatedAt: VERSION, snoozeUntil: soon },
      { action: "snooze", expectedUpdatedAt: VERSION, snoozeUntil: far },
      { action: "snooze", expectedUpdatedAt: VERSION, snoozeUntil: "tomorrow" },
      { action: "dismiss", expectedUpdatedAt: VERSION, snoozeUntil: new Date(Date.now() + 3_600_000).toISOString() }
    ]) {
      expect(await answer(patch(patchReq(body)))).toEqual([400, { error: "invalid", detail: "snoozeUntil" }]);
    }
    expect(applyOwnerAction).not.toHaveBeenCalled();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await patch(patchReq({ action: "snooze", expectedUpdatedAt: VERSION, snoozeUntil: until }))).status).toBe(200);
    expect(applyOwnerAction).toHaveBeenCalledWith(principal, ITEM_ID, "snooze", { snoozeUntil: until, expectedUpdatedAt: VERSION, now: expect.any(Date) });
  });

  it("the rate limit runs before the audit: 429 and 503 pass through and nothing is audited or written (M2)", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    const res = await patch(patchReq(OK_BODY));
    expect([res.status, await res.json()]).toEqual([429, { error: "rate_limited", retryAfterSeconds: 42 }]);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(rateLimit).toHaveBeenCalledWith(principal, "attention_action", 120, 600_000, { now: expect.any(Date) });
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(503, "unavailable") });
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([503, { error: "unavailable" }]);
    expect(auditStart).not.toHaveBeenCalled();
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it("an unwritable audit row is 503 and nothing is written", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([503, { error: "unavailable" }]);
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it("gate → same-origin → body → limit → audit → act, in that order", async () => {
    expect((await patch(patchReq(OK_BODY))).status).toBe(200);
    const [g, l, a, act, finish] = order(requireExecPrincipal, rateLimit, auditStart, applyOwnerAction, auditFinish);
    expect(g < l && l < a && a < act && act < finish).toBe(true);
    expect(auditStart).toHaveBeenCalledWith(principal, {
      actor: "owner",
      action: "attention.dismiss",
      target: `exec_attention_items:${ITEM_ID}`,
      input: { action: "dismiss", snoozeUntil: null }
    });
  });
});

describe("PATCH /api/exec/attention/:id: outcomes (test 18, a-build-10)", () => {
  const OK_BODY = { action: "resolve", expectedUpdatedAt: VERSION };

  it("applied → 200 changed: true with the screened item and its new version; the audit row ok", async () => {
    const [status, body] = await answer(patch(patchReq(OK_BODY)));
    expect(status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.item).toMatchObject({ id: ITEM_ID, status: "dismissed", version: "2026-11-06T12:00:00.000001+00:00" });
    expect(body.hidden).toBeUndefined();
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: true, result: { outcome: "applied" } });
    expect(screenAttentionItems).toHaveBeenCalledTimes(1);
  });

  it("unchanged → 200 changed: false; the audit row ok", async () => {
    vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "unchanged", row: row({ status: "resolved", resolution: "owner", resolvedAt: "2026-11-05T00:00:00.000Z" }) });
    const [status, body] = await answer(patch(patchReq(OK_BODY)));
    expect([status, body.changed, body.item.status]).toEqual([200, false, "resolved"]);
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: true, result: { outcome: "unchanged" } });
  });

  it("conflict → 409 with the current item; the audit row ok = false, outcome conflict", async () => {
    vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "conflict", row: row({ title: "Changed" }, "2026-11-06T11:00:00+00:00") });
    const [status, body] = await answer(patch(patchReq(OK_BODY)));
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "conflict", item: { title: "Changed", version: "2026-11-06T11:00:00+00:00" } });
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: false, result: { outcome: "conflict" } });
  });

  it("invalid_transition → 409 with the item; the audit row ok = false", async () => {
    vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "invalid_transition", row: row({ status: "resolved", resolution: "auto", resolvedAt: "2026-11-05T00:00:00.000Z" }) });
    const [status, body] = await answer(patch(patchReq({ action: "reopen", expectedUpdatedAt: VERSION })));
    expect([status, body.error, body.item.id]).toEqual([409, "invalid_transition", ITEM_ID]);
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: false, result: { outcome: "invalid_transition" } });
  });

  it("not_found → 404; the audit row ok = false", async () => {
    vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "not_found" });
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([404, { error: "not_found" }]);
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: false, result: { outcome: "not_found" } });
  });

  it("an item the screen now withholds comes back as item: null, hidden: true, in every outcome", async () => {
    vi.mocked(screenAttentionItems).mockResolvedValue({ items: [], hiddenEmail: 1, emailScreen: "ok" });
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([200, { changed: true, item: null, hidden: true }]);
    vi.mocked(applyOwnerAction).mockResolvedValue({ outcome: "conflict", row: row() });
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([409, { error: "conflict", item: null, hidden: true }]);
    vi.mocked(screenAttentionItems).mockRejectedValue(new Error("aborted"));
    expect(await answer(patch(patchReq(OK_BODY)))).toEqual([409, { error: "conflict", item: null, hidden: true }]);
  });

  it("the act throwing is 503, the audit row finished as an exception, the message never echoed", async () => {
    vi.mocked(applyOwnerAction).mockRejectedValue(new Error("exec_attention_items update failed: SECRET"));
    const [status, body] = await answer(patch(patchReq(OK_BODY)));
    expect([status, body]).toEqual([503, { error: "unavailable" }]);
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: false, error: "exception" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Test 19: POST /api/exec/attention/:id/feedback
// ---------------------------------------------------------------------------

describe("POST /api/exec/attention/:id/feedback (test 19)", () => {
  it("a gate failure calls nothing else; cross-site is 403 before the body; a bad id 404 before the body", async () => {
    gateFails();
    expect((await vote(feedbackReq({ vote: 1 }))).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "POST /api/exec/attention/:id/feedback", { requireStrongSignIn: true });
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
    const cross = feedbackReq({ vote: 1 }, { "sec-fetch-site": "cross-site" });
    expect(await answer(vote(cross))).toEqual([403, { error: "forbidden" }]);
    expect(cross.bodyUsed).toBe(false);
    const badId = feedbackReq({ vote: 1 });
    expect(await answer(vote(badId, "ea_x"))).toEqual([404, { error: "not_found" }]);
    expect(badId.bodyUsed).toBe(false);
    for (const fn of [loadSettings, rateLimit, auditStart, recordAttentionFeedback]) expect(fn).not.toHaveBeenCalled();
  });

  it("body: 413, 400 body, 400 field path, and the C10 pairing as 400 reason", async () => {
    expect(await answer(vote(feedbackReq({ vote: 1, pad: "x".repeat(5000) })))).toEqual([413, { error: "too_large" }]);
    expect(await answer(vote(feedbackReq("nope")))).toEqual([400, { error: "invalid", detail: "body" }]);
    expect(await answer(vote(feedbackReq({ vote: 2 })))).toEqual([400, { error: "invalid", detail: "vote" }]);
    expect(await answer(vote(feedbackReq({ vote: 1, reason: "spam" })))).toEqual([400, { error: "invalid", detail: "reason" }]);
    expect(await answer(vote(feedbackReq({ vote: 1, comment: "x" })))).toEqual([400, { error: "invalid", detail: "comment" }]);
    expect(await answer(vote(feedbackReq({ vote: -1, reason: "useful" })))).toEqual([400, { error: "invalid", detail: "reason" }]);
    expect(await answer(vote(feedbackReq({ vote: 1, reason: "duplicate" })))).toEqual([400, { error: "invalid", detail: "reason" }]);
    for (const fn of [loadSettings, rateLimit, auditStart, recordAttentionFeedback]) expect(fn).not.toHaveBeenCalled();
  });

  it("not installed → 409 before the limit; settings unreadable → 503", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ ddtextSchemaReady: false }));
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([409, { error: "not_installed" }]);
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([503, { error: "unavailable" }]);
    for (const fn of [rateLimit, auditStart, recordAttentionFeedback]) expect(fn).not.toHaveBeenCalled();
  });

  it("the limit (60 per 10 min) runs before the audit", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 7 }) });
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([429, { error: "rate_limited", retryAfterSeconds: 7 }]);
    expect(rateLimit).toHaveBeenCalledWith(principal, "attention_feedback", 60, 600_000, { now: expect.any(Date) });
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("records the vote inside the audit row (ids and enums only): 200 { itemId, vote, reason }", async () => {
    expect(await answer(vote(feedbackReq({ vote: -1, reason: "wrong_priority" })))).toEqual([200, { itemId: ITEM_ID, vote: -1, reason: "wrong_priority" }]);
    expect(auditStart).toHaveBeenCalledWith(principal, {
      actor: "owner",
      action: "attention.feedback",
      target: `exec_attention_items:${ITEM_ID}`,
      input: { vote: -1, reason: "wrong_priority", kind: "overdue_tasks" }
    });
    expect(recordAttentionFeedback).toHaveBeenCalledWith(principal, ITEM_ID, { vote: -1, reason: "wrong_priority" }, { now: expect.any(Date) });
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: true, result: { outcome: "recorded" } });
    const [g, s, l, a, act] = order(requireExecPrincipal, loadSettings, rateLimit, auditStart, recordAttentionFeedback);
    expect(g < s && s < l && l < a && a < act).toBe(true);
    // A vote with no reason is null, not absent.
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([200, { itemId: ITEM_ID, vote: 1, reason: null }]);
  });

  it("an unknown item is 404 with nothing audited; one gone by the write is 404 with the row ok = false", async () => {
    vi.mocked(getAttentionItemIdentity).mockResolvedValue(null);
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([404, { error: "not_found" }]);
    expect(auditStart).not.toHaveBeenCalled();
    vi.mocked(getAttentionItemIdentity).mockResolvedValue({ id: ITEM_ID, fingerprint: "dd:x", source: "dd", kind: "overdue_tasks" });
    vi.mocked(recordAttentionFeedback).mockResolvedValue({ outcome: "not_found" });
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([404, { error: "not_found" }]);
    expect(auditFinish).toHaveBeenCalledWith(41, { ok: false, result: { outcome: "not_found" } });
  });

  it("the item read or the write failing is 503", async () => {
    vi.mocked(getAttentionItemIdentity).mockRejectedValue(new Error("x"));
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([503, { error: "unavailable" }]);
    vi.mocked(getAttentionItemIdentity).mockResolvedValue({ id: ITEM_ID, fingerprint: "dd:x", source: "dd", kind: "overdue_tasks" });
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    expect(await answer(vote(feedbackReq({ vote: 1 })))).toEqual([503, { error: "unavailable" }]);
    expect(recordAttentionFeedback).not.toHaveBeenCalled();
  });
});
