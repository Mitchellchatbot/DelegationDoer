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
  countEnabledMailPinnedPrincipals: vi.fn(async () => 1)
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

import * as listRoute from "@/app/api/exec/drafts/route";
import * as draftRoute from "@/app/api/exec/drafts/[id]/route";
import * as openedRoute from "@/app/api/exec/drafts/[id]/outlook-opened/route";
import * as regenerateRoute from "@/app/api/exec/drafts/[id]/regenerate/route";
import * as resolveRoute from "@/app/api/exec/drafts/[id]/resolve/route";
import * as reviewRoute from "@/app/api/exec/drafts/[id]/review/route";
import * as saveRoute from "@/app/api/exec/drafts/[id]/save/route";
import * as sendRoute from "@/app/api/exec/drafts/[id]/send/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { loadClientMatcher } from "@/lib/exec/correlate";
import { previewReply, recipientSuggestions, screenDraftRow } from "@/lib/exec/drafts";
import { getEmailThread, listThreadScreenRows } from "@/lib/exec/email-store";
import type { ExecEmailThread } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { findSentCopy, listReplyArtifacts, loadScreeningPolicy, readPrincipalThread, screenHashesFor } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import { listUsers } from "@/lib/exec/sources/dd";
import { AuditUnavailableError } from "@/lib/exec/types";
import { cl2Error, readBackFixture } from "./__tests__/fake-clone";
import {
  CLIENT,
  GRAPH,
  HASH_A,
  HASH_B,
  HASH_C,
  HIS,
  ID1,
  ID2,
  ID3,
  OWN_EMAIL,
  PARENT,
  PRINCIPAL,
  THREAD,
  bodyOf,
  draftRow,
  gateAnswers,
  hisMessage,
  jsonRequest,
  minutesAgo,
  newDraftRow,
  policyOf,
  rowOf,
  rule,
  savedRow,
  setupDraftEnv,
  threadFixture,
  type DraftEnv
} from "./__tests__/drafts-harness";

// Area D's routes (P4 contract §3.12, §5.8 RO01-RO21). Every route module is
// imported as Next would call it; the clone is the CL2 fake behind the REAL
// sources/mail.ts draft functions; exec_drafts is Area A's fake DB.

const ENV = { ...process.env };
let env: DraftEnv;
const ctx = (id = ID1) => ({ params: { id } });
const P = (id = ID1) => `/api/exec/drafts/${id}`;
const draftRoutes = () => env.fake.requests.filter((r) => r.route !== "status" && r.route !== "auth_me" && r.route !== "other");

beforeEach(() => {
  env = setupDraftEnv();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ENV };
});

/** Every exported handler, with a request that would get past the gates. */
const HANDLERS: { name: string; mutation: boolean; call: (req: Request) => Promise<Response> }[] = [
  { name: "GET list", mutation: false, call: (r) => listRoute.GET(r) },
  { name: "POST create", mutation: true, call: (r) => listRoute.POST(r) },
  { name: "GET view", mutation: false, call: (r) => draftRoute.GET(r, ctx()) },
  { name: "PATCH edit", mutation: true, call: (r) => draftRoute.PATCH(r, ctx()) },
  { name: "DELETE discard", mutation: true, call: (r) => draftRoute.DELETE(r, ctx()) },
  { name: "POST regenerate", mutation: true, call: (r) => regenerateRoute.POST(r, ctx()) },
  { name: "POST save", mutation: true, call: (r) => saveRoute.POST(r, ctx()) },
  { name: "POST review", mutation: true, call: (r) => reviewRoute.POST(r, ctx()) },
  { name: "GET send probe", mutation: false, call: (r) => sendRoute.GET(r, ctx()) },
  { name: "POST send", mutation: true, call: (r) => sendRoute.POST(r, ctx()) },
  { name: "POST outlook-opened", mutation: true, call: (r) => openedRoute.POST(r, ctx()) },
  { name: "POST resolve", mutation: true, call: (r) => resolveRoute.POST(r, ctx()) }
];

describe("RO01 the owner gate with the step-up on every route", () => {
  it.each(HANDLERS.map((h) => [h.name, h] as const))("%s: a non-owner or link session gets 404, an outage 503, and the gate asks for the step-up", async (_n, h) => {
    gateAnswers(404);
    const res = await h.call(jsonRequest(h.mutation ? "POST" : "GET", P(), h.mutation ? {} : undefined));
    expect(res.status).toBe(404);
    expect(vi.mocked(requireExecPrincipal).mock.calls[0][2]).toEqual({ requireStrongSignIn: true });
    gateAnswers(503);
    expect((await h.call(jsonRequest("POST", P(), {}))).status).toBe(503);
    expect(env.db.requests).toHaveLength(0);
  });
});

describe("RO02 same-origin on every mutation", () => {
  const mutations = HANDLERS.filter((h) => h.mutation);
  it.each(mutations.map((h) => [h.name, h] as const))("%s: cross-site, same-site and no headers are 403; same-origin and a matching Origin pass", async (_n, h) => {
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
      const res = await h.call(jsonRequest("POST", P(), {}, headers));
      expect(res.status).toBe(403);
      expect(await bodyOf(res)).toEqual({ error: "forbidden" });
    }
    const bare = new Request(`https://ops.test${P()}`, { method: "POST", body: "{}" });
    expect((await h.call(bare)).status).toBe(403);
    expect(env.db.requests).toHaveLength(0);
    const same = await h.call(jsonRequest("POST", P(), {}));
    expect(same.status).not.toBe(403);
    const proxied = new Request(`https://ops.test${P()}`, {
      method: "POST",
      body: "{}",
      headers: { origin: "https://operations.scaledai.org", host: "internal:3000", "x-forwarded-host": "operations.scaledai.org, edge" }
    });
    expect((await h.call(proxied)).status).not.toBe(403);
  });
});

describe("RO03 ids and bodies", () => {
  it("a malformed id is 404 before anything is read", async () => {
    const res = await draftRoute.GET(jsonRequest("GET", P("ed_nothex")), ctx("ed_nothex"));
    expect(res.status).toBe(404);
    expect(env.db.requests).toHaveLength(0);
  });
  it("an oversized, malformed or unknown-key body is 400; a semantic problem is 422 with problems", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    const big = { version: 1, bodyDoc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(100_000) }] }] } };
    expect((await draftRoute.PATCH(jsonRequest("PATCH", P(), big), ctx())).status).toBe(400);
    expect((await draftRoute.PATCH(jsonRequest("PATCH", P(), "{not json"), ctx())).status).toBe(400);
    expect((await draftRoute.PATCH(jsonRequest("PATCH", P(), { version: 1, bodyHtml: "<b>x</b>" }), ctx())).status).toBe(400);
    expect((await saveRoute.POST(jsonRequest("POST", `${P()}/save`, { version: "1" }), ctx())).status).toBe(400);
    const res = await draftRoute.PATCH(jsonRequest("PATCH", P(), { version: 1, bodyDoc: { type: "doc", content: [{ type: "script", text: "x" }] } }), ctx());
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body.error).toBe("invalid");
    expect(Array.isArray(body.problems) && (body.problems as string[]).length).toBeGreaterThan(0);
    const long = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true, instruction: "x".repeat(2_001) }));
    expect(long.status).toBe(422);
    expect(await bodyOf(long)).toEqual({ error: "invalid", problems: ["instruction_too_long"] });
  });
});

describe("RO04 not installed and switched off", () => {
  it("not installed: the list is empty, a draft is 404, a create is 404", async () => {
    env = setupDraftEnv({ rows: [draftRow()], settings: { draftsSchemaReady: false, draftsEnabled: false } });
    const list = await listRoute.GET(jsonRequest("GET", "/api/exec/drafts"));
    expect(list.status).toBe(200);
    expect(await bodyOf(list)).toEqual({ items: [], nextCursor: null });
    expect((await draftRoute.GET(jsonRequest("GET", P()), ctx())).status).toBe(404);
    expect((await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: false }))).status).toBe(404);
  });
  it("drafts off: mutations are 409 drafts_off; send off: send is 409 send_off", async () => {
    env = setupDraftEnv({ rows: [draftRow()], settings: { draftsEnabled: false } });
    const res = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: false }));
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("drafts_off");
    expect((await bodyOf(await saveRoute.POST(jsonRequest("POST", `${P()}/save`, { version: 1 }), ctx()))).error).toBe("drafts_off");
    env = setupDraftEnv({ rows: [savedRow()], settings: { sendEnabled: false } });
    const send = await sendRoute.POST(jsonRequest("POST", `${P()}/send`, { reviewHash: HASH_A, acks: [] }), ctx());
    expect(send.status).toBe(409);
    expect((await bodyOf(send)).error).toBe("send_off");
  });
});

describe("RO05 the generation rate limit", () => {
  it("the 21st generation request in 10 minutes is 429 with Retry-After 60", async () => {
    const audit = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, principal_id: PRINCIPAL.id, action: "draft.generate.request", created_at: minutesAgo(1) }));
    env = setupDraftEnv({ audit });
    const res = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await bodyOf(res)).error).toBe("rate_limited");
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    // An older row doesn't count.
    env = setupDraftEnv({ audit: audit.map((a) => ({ ...a, created_at: minutesAgo(11) })) });
    expect((await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true }))).status).toBe(201);
  });
});

describe("RO06 readiness down", () => {
  it("409 drafts_unavailable with the reason, and no clone draft call", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    const res = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true }));
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "drafts_unavailable", reason: "token_missing" });
    expect(draftRoutes()).toHaveLength(0);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });
  it("cl2 not ready on the save route: 409 with that reason, nothing saved", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.defaultAnswer("status", { status: 200, body: { ok: true, cl2: { ready: false, send: "off" } } });
    const res = await saveRoute.POST(jsonRequest("POST", `${P()}/save`, { version: 1 }), ctx());
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "drafts_unavailable", reason: "cl2_not_ready" });
    expect(draftRoutes()).toHaveLength(0);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the create look-back and the lifecycle states
// ---------------------------------------------------------------------------

const KEY = (n = "nonce0123456789a") => `${ID1}:v1:send:${n}`;
const goneRow = (over: Record<string, unknown> = {}) => savedRow({
  id: ID2, status: "gone", gone_at: minutesAgo(60), gone_unconfirmed: false, terminal_at: minutesAgo(60), expires_at: minutesAgo(-100_000),
  created_at: minutesAgo(90), ...over
});
const discardedRow = (over: Record<string, unknown> = {}) => draftRow({
  id: ID2, status: "discarded", terminal_at: minutesAgo(60), expires_at: minutesAgo(-100_000), created_at: minutesAgo(90), ...over
});
const unknownRow = (over: Record<string, unknown> = {}) => savedRow({
  status: "unknown", send_attempt_key: KEY(), send_started_at: minutesAgo(31), confirm_hash: HASH_A, sent_audit_id: 7, ...over
});
const createReply = (body: Record<string, unknown> = {}) =>
  listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: false, ...body }));
const CLIENTS = [{ id: "c1", name: "Acme", status: "active", website: "acme.io", websites: [], contactEmails: [CLIENT], priority: null }];

describe("RO07 create a reply", () => {
  it("restricted → 404 and no row; not his → 404; no anchor → 409 thread_unavailable", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("acme.io")]));
    expect((await createReply()).status).toBe(404);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([]));
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_his" });
    expect((await createReply()).status).toBe(404);
    const outboundOnly = threadFixture();
    outboundOnly.his = [hisMessage({ id: "m_out", direction: "outbound", from: { name: null, email: OWN_EMAIL }, to: [] })];
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "ok", thread: outboundOnly });
    const res = await createReply();
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("thread_unavailable");
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });
  it("a P3 row that fails its stored screen (a tombstone) is 404", async () => {
    vi.mocked(getEmailThread).mockResolvedValue({ threadId: THREAD, accountId: HIS, state: "restricted_hidden", screenHashes: [], screenTruncated: false, screenedPolicyHash: null } as unknown as ExecEmailThread);
    expect((await createReply()).status).toBe(404);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });
  it("generate: one interactive job, maxAttempts 1, keyed per seq; the row is generating with hashes and the policy hash", async () => {
    const res = await createReply({ generate: true, instruction: "say thanks" });
    expect(res.status).toBe(201);
    const { id, status } = await bodyOf(res);
    expect(status).toBe("generating");
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({
      kind: "exec.draft-generate", lane: "interactive", maxAttempts: 1, payload: { draftId: id, seq: 1 }, dedupeKey: `draft-gen:${PRINCIPAL.id}:${id}:s1`
    });
    const row = rowOf(env.db, id as string);
    expect(row).toMatchObject({ status: "generating", generation_seq: 1, parent_message_id: PARENT, account_id: HIS, reply_mode: "reply", instruction: "say thanks" });
    expect(row.to_recipients).toEqual([{ address: CLIENT, name: "Client" }]);
    expect(row.screen_hashes).toEqual(screenHashesFor({ all: threadFixture().all, participants: [] }).hashes);
    expect(row.screened_policy_hash).toBe(policyOf([]).hash);
    expect(String(row.render_nonce)).toMatch(/^[0-9a-f]{24}$/);
    expect(vi.mocked(auditEvent).mock.calls.map((c) => c[1].action)).toEqual(["draft.generate.request"]);
  });
  it("an active draft on the thread answers 200 existing", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    const res = await createReply({ generate: true });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ id: ID1, status: "draft", existing: true });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });
  it("an enqueue failure → generation_failed (stale) and 503", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs down"));
    const res = await createReply({ generate: true });
    expect(res.status).toBe(503);
    const row = env.db.tables.exec_drafts[0];
    expect(row).toMatchObject({ status: "generation_failed", generation_error: "stale" });
  });
  it("the look-back: a confirmed-gone earlier draft without checkedOutlook → 409 hold and no row", async () => {
    env = setupDraftEnv({ rows: [goneRow()] });
    const res = await createReply();
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("hold");
    expect(env.db.tables.exec_drafts).toHaveLength(1);
  });
  it("the same with checkedOutlook and the sent copy not found → 201; the check reuses the thread the route read", async () => {
    env = setupDraftEnv({ rows: [goneRow()] });
    const res = await createReply({ checkedOutlook: true });
    expect(res.status).toBe(201);
    expect(vi.mocked(readPrincipalThread)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(findSentCopy).mock.calls[0][1];
    const read = (await vi.mocked(readPrincipalThread).mock.results[0].value) as { thread: unknown };
    expect(call.thread).toBe(read.thread);
    expect(call.internetMessageId).toBe("<draft.1@outlook.com>");
    expect(env.fake.of("other")).toHaveLength(0);
  });
  it("the sent copy found → 409 sent_copy_found; the gone row becomes sent (an attempt existed) or sent_external (none), unverified", async () => {
    env = setupDraftEnv({ rows: [goneRow({ send_attempt_key: KEY(), send_started_at: minutesAgo(80) })] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    const res = await createReply({ checkedOutlook: true });
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("sent_copy_found");
    expect(rowOf(env.db, ID2)).toMatchObject({ status: "sent", unverified: true });
    expect(env.db.tables.exec_drafts).toHaveLength(1);
    env = setupDraftEnv({ rows: [goneRow()] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    expect((await createReply()).status).toBe(409);
    expect(rowOf(env.db, ID2)).toMatchObject({ status: "sent_external", unverified: true });
  });
  it("a discarded earlier draft opened in Outlook and found sent → 409, the discarded row unchanged", async () => {
    const prior = discardedRow({ internet_message_id: "<d2@x>", opened_in_outlook_at: minutesAgo(70), outlook_graph_id: GRAPH });
    env = setupDraftEnv({ rows: [prior] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    expect((await createReply()).status).toBe(409);
    expect(rowOf(env.db, ID2).status).toBe("discarded");
    expect(rowOf(env.db, ID2).updated_at).toBe(prior.updated_at);
  });
  it("an earlier draft never in Outlook needs no check; a saved-then-discarded one with no copy found → 201", async () => {
    env = setupDraftEnv({ rows: [discardedRow()] });
    expect((await createReply()).status).toBe(201);
    expect(vi.mocked(findSentCopy)).not.toHaveBeenCalled();
    env = setupDraftEnv({ rows: [discardedRow({ internet_message_id: "<d2@x>", outlook_graph_id: GRAPH })] });
    expect((await createReply()).status).toBe(201);
    expect(vi.mocked(findSentCopy)).toHaveBeenCalledTimes(1);
  });
  it("a sent-copy read error → 503; an earlier draft on another parent → no check", async () => {
    env = setupDraftEnv({ rows: [goneRow()] });
    vi.mocked(findSentCopy).mockRejectedValue(new Error("clone down"));
    expect((await createReply({ checkedOutlook: true })).status).toBe(503);
    env = setupDraftEnv({ rows: [goneRow({ parent_message_id: "m_other" })] });
    expect((await createReply()).status).toBe(201);
    expect(vi.mocked(findSentCopy)).not.toHaveBeenCalled();
  });
});

describe("RO08 create a new email", () => {
  const createNew = (body: Record<string, unknown>) => listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "new", generate: false, ...body }));
  it("an address outside the allowed set → 422 recipients_blocked not_allowed; an allowed one → 201", async () => {
    vi.mocked(listUsers).mockResolvedValue([{ id: "u2", name: "Sam", email: "sam@scaledai.org", role: "member", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] }] as never);
    const res = await createNew({ to: [{ address: "stranger@else.io" }] });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({ error: "recipients_blocked", errors: [{ code: "not_allowed", address: "stranger@else.io" }] });
    expect(env.db.tables.exec_drafts).toHaveLength(0);
    const ok = await createNew({ to: [{ address: "Sam@ScaledAI.org", name: "Sam" }], subject: "Hi" });
    expect(ok.status).toBe(201);
    expect(env.db.tables.exec_drafts[0]).toMatchObject({ kind: "new", subject: "Hi", to_recipients: [{ address: "sam@scaledai.org", name: "Sam" }], screened_policy_hash: null });
  });
  it("generating without an instruction → 422 instruction_required", async () => {
    const res = await createNew({ generate: true, to: [{ address: "sam@scaledai.org" }] });
    expect(res.status).toBe(422);
    expect((await bodyOf(res)).error).toBe("instruction_required");
  });
});

describe("RO09 edit", () => {
  const patch = (body: Record<string, unknown>) => draftRoute.PATCH(jsonRequest("PATCH", P(), body), ctx());
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  it("text holding HTML is stored escaped; the server rebuilds the HTML", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    const res = await patch({ version: 1, bodyDoc: doc("<script>alert(1)</script> [date]") });
    expect(res.status).toBe(200);
    const row = rowOf(env.db);
    expect(String(row.body_html)).not.toContain("<script");
    expect(String(row.body_html)).toContain("&lt;script&gt;");
    expect(row).toMatchObject({ version: 2, body_text: "<script>alert(1)</script> [date]", placeholders: ["[date]"] });
  });
  it("a bodyHtml key → 400; a stale version → 409 version_conflict", async () => {
    env = setupDraftEnv({ rows: [draftRow({ version: 3 })] });
    expect((await patch({ version: 3, bodyHtml: "<p>x</p>" })).status).toBe(400);
    const res = await patch({ version: 2, bodyDoc: doc("x") });
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("version_conflict");
  });
  it("saved → draft with the review cleared and the link kept (now stale)", async () => {
    env = setupDraftEnv({ rows: [savedRow({ review_hash: HASH_A, review_at: new Date().toISOString() })] });
    const res = await patch({ version: 1, bodyDoc: doc("changed") });
    expect(res.status).toBe(200);
    const view = await bodyOf(res);
    expect(view).toMatchObject({ status: "draft", version: 2, staleLink: true });
    expect(rowOf(env.db)).toMatchObject({ status: "draft", version: 2, saved_version: 1, outlook_graph_id: GRAPH, review_hash: null, review_at: null });
  });
  it("adding an outside Cc to a facts draft is accepted here (the gate is at save, RO10)", async () => {
    env = setupDraftEnv({ rows: [draftRow({ facts_status: "used", client_id: "c1", thread_addresses: [CLIENT, OWN_EMAIL, "vendor@other.io"] })], clients: CLIENTS as never });
    const res = await patch({ version: 1, cc: [{ address: "vendor@other.io" }] });
    expect(res.status).toBe(200);
    expect(rowOf(env.db).cc_recipients).toEqual([{ address: "vendor@other.io", name: null }]);
  });
  it("a reply's To can't gain an address and its Cc can't take a stranger", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    const res = await patch({ version: 1, to: [{ address: CLIENT }, { address: "other@acme.io" }], cc: [{ address: "nobody@else.io" }] });
    expect(res.status).toBe(422);
    const codes = ((await bodyOf(res)).errors as { code: string }[]).map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["to_not_derived", "not_allowed"]));
  });
});

describe("RO10 save", () => {
  const save = (body: Record<string, unknown> = { version: 1 }) => saveRoute.POST(jsonRequest("POST", `${P()}/save`, body), ctx());
  const okCreate = (over = {}) => ({ status: 201, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A, ...over }) });
  const noSideEffects = () => {
    expect(draftRoutes()).toHaveLength(0);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  };
  it.each([
    ["empty", draftRow({ body_text: "  ", body_html: "<p></p>" }), "empty_body"],
    ["placeholders", draftRow({ body_text: "See you on [date]", body_html: "<p>See you on [date]</p>" }), "placeholders"],
    ["unsafe", draftRow({ body_html: "<p onclick=\"x()\">hi</p>" }), "unsafe_markup"],
    ["subject", newDraftRow({ subject: null, to_recipients: [{ address: "sam@scaledai.org", name: null }] }), "subject_required"],
    ["recipients", draftRow({ to_recipients: [{ address: OWN_EMAIL, name: null }] }), "recipients_blocked"]
  ])("%s → 422 with no clone call and no audit row", async (_n, row, code) => {
    env = setupDraftEnv({ rows: [row] });
    const res = await save();
    expect(res.status).toBe(422);
    expect((await bodyOf(res)).error).toBe(code);
    noSideEffects();
  });
  it("a facts draft with an outside Cc → 422 facts_recipient, no clone call; a matcher failure → 503", async () => {
    const row = draftRow({ facts_status: "used", client_id: "c1", thread_addresses: [CLIENT, OWN_EMAIL, "vendor@other.io"], cc_recipients: [{ address: "vendor@other.io", name: null }] });
    env = setupDraftEnv({ rows: [row], clients: CLIENTS as never });
    const res = await save();
    expect(res.status).toBe(422);
    // The facts client's DD name rides along for the "<client>" copy (integrator, §3.13.4).
    expect(await bodyOf(res)).toEqual({ error: "recipients_blocked", errors: [{ code: "facts_recipient", address: "vendor@other.io" }], clientName: "Acme" });
    noSideEffects();
    vi.mocked(loadClientMatcher).mockRejectedValue(new Error("matcher down"));
    expect((await save()).status).toBe(503);
    noSideEffects();
  });
  it("audit down → 503 audit_unavailable and no clone call", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    const res = await save();
    expect(res.status).toBe(503);
    expect((await bodyOf(res)).error).toBe("audit_unavailable");
    expect(draftRoutes()).toHaveLength(0);
    expect(rowOf(env.db).status).toBe("draft");
  });
  it("201 → saved: the reply body CL2 expects, the key, the link and the content hash", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.answer("create_reply", okCreate());
    const res = await save();
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ status: "saved", code: null });
    const req = env.fake.of("create_reply")[0];
    expect(req.json).toEqual({ parentMessageId: PARENT, to: [{ address: CLIENT, name: "Client" }], cc: [], bodyHtml: "<p>Thanks, we're on it.</p>", timezone: "America/New_York" });
    expect(req.idempotencyKey).toMatch(new RegExp(`^${ID1}:v1:save:[A-Za-z0-9_-]{16}$`));
    expect(rowOf(env.db)).toMatchObject({ status: "saved", saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A, observed_content_hash: HASH_A, save_attempt_key: req.idempotencyKey });
    expect(vi.mocked(auditFinish).mock.calls[0][1]).toMatchObject({ ok: true, result: { outcome: "saved", code: null, httpStatus: 200 } });
  });
  it("a recreate sends ifContentHash = content_hash, or seenContentHash when given, and stores it", async () => {
    const stale = draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, internet_message_id: "<d@x>", content_hash: HASH_A, observed_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    env.fake.answer("recreate", { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=", replaces: GRAPH, contentHash: HASH_B }) });
    expect((await save({ version: 2 })).status).toBe(200);
    expect(env.fake.of("recreate")[0].json).toMatchObject({ ifContentHash: HASH_A });
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: "AAMkNew=", saved_version: 2, content_hash: HASH_B, save_if_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    env.fake.answer("recreate", { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=", contentHash: HASH_B }) });
    expect((await save({ version: 2, seenContentHash: HASH_C })).status).toBe(200);
    expect(env.fake.of("recreate")[0].json).toMatchObject({ ifContentHash: HASH_C });
    expect(rowOf(env.db).save_if_content_hash).toBe(HASH_C);
  });
  it("save_started_at and the stale next_check_at come from the CAS, not the request's start (data-5, C4)", async () => {
    const t0 = new Date("2026-11-06T15:00:00.000Z");
    vi.useFakeTimers({ now: t0, toFake: ["Date"] });
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.answer("create_reply", { status: 201, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A }) });
    const next = vi.mocked(auditStart).getMockImplementation();
    vi.mocked(auditStart).mockImplementationOnce(async (...args) => {
      vi.setSystemTime(new Date(t0.getTime() + 20_000));
      return next ? next(...args) : 1;
    });
    await save();
    expect(Date.parse(String(rowOf(env.db).save_started_at))).toBe(t0.getTime() + 20_000);
  });
  it("a recreate answered 404 deleted + replacedBy links the replacement stale (data-3): never saved at this version, the next Save shows it first", async () => {
    const stale = draftRow({ version: 3, saved_version: 2, outlook_graph_id: GRAPH, internet_message_id: "<d@x>", content_hash: HASH_A, observed_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    env.fake.answer("recreate", cl2Error(404, "gone", { draftStatus: "deleted", replacedBy: "AAMkNew=" }));
    env.fake.defaultAnswer("get_draft", { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=", contentHash: HASH_C }) });
    const res = await save({ version: 3 });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ status: "draft" });
    expect(env.fake.of("get_draft").map((r) => r.graphId)).toEqual(["AAMkNew="]);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: "AAMkNew=", saved_version: 2, version: 3, content_hash: HASH_A, observed_content_hash: HASH_C });
    // The GET resolution of an answered recreate error follows the same rule.
    env = setupDraftEnv({ rows: [stale] });
    env.fake.answer("recreate", cl2Error(404, "gone"));
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "deleted", replacedBy: "AAMkNew=" }), { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=", contentHash: HASH_C }) });
    expect((await bodyOf(await save({ version: 3 }))).status).toBe("draft");
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: "AAMkNew=", saved_version: 2, content_hash: HASH_A });
  });
  it("409 changed → draft with the read-back and its hash, content_hash unchanged; a retry without the hash 409s again, with it goes through", async () => {
    const stale = draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, internet_message_id: "<d@x>", content_hash: HASH_A, observed_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    // The Outlook copy now hashes HASH_C: the clone refuses any other ifContentHash.
    env.fake.defaultAnswer("recreate", (r) => ((r.json as { ifContentHash?: string }).ifContentHash === HASH_C
      ? { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=", contentHash: HASH_B }) }
      : cl2Error(409, "changed", { draftStatus: "saved" })));
    env.fake.defaultAnswer("get_draft", { status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_C }) });
    const first = await save({ version: 2 });
    const body = await bodyOf(first);
    expect(body).toMatchObject({ status: "draft", code: "outlook_changed" });
    expect((body.readBack as { contentHash: string }).contentHash).toBe(HASH_C);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", content_hash: HASH_A, observed_content_hash: HASH_C, outlook_graph_id: GRAPH, last_error_code: "outlook_changed" });
    expect((await bodyOf(await save({ version: 2 }))).code).toBe("outlook_changed");
    const third = await save({ version: 2, seenContentHash: HASH_C });
    expect(await bodyOf(third)).toMatchObject({ status: "saved", code: null });
  });
  it("an idle GET that saw a delegate's edit doesn't move content_hash: the next Save → 409 changed, nothing deleted (clone-1)", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.defaultAnswer("get_draft", { status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_C }) });
    expect((await resolveRoute.POST(jsonRequest("POST", `${P()}/resolve`, { action: "check" }), ctx())).status).toBe(200);
    expect(rowOf(env.db)).toMatchObject({ content_hash: HASH_A, observed_content_hash: HASH_C });
    expect((await draftRoute.PATCH(jsonRequest("PATCH", P(), { version: 1, bodyDoc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2" }] }] } }), ctx())).status).toBe(200);
    env.fake.defaultAnswer("recreate", (r) => ((r.json as { ifContentHash?: string }).ifContentHash === HASH_C
      ? { status: 200, body: readBackFixture({ accountId: HIS, graphId: "AAMkNew=" }) }
      : cl2Error(409, "changed", { draftStatus: "saved" })));
    const res = await save({ version: 2 });
    expect((await bodyOf(res)).code).toBe("outlook_changed");
    expect(env.fake.of("recreate")[0].json).toMatchObject({ ifContentHash: HASH_A });
    expect(env.fake.of("delete")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: GRAPH });
  });
  it("no answer (an edge page) → 202 saving with outcome_unknown", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.answer("create_reply", new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const res = await save();
    expect(res.status).toBe(202);
    expect(await bodyOf(res)).toMatchObject({ status: "saving", code: "outcome_unknown" });
    expect(rowOf(env.db)).toMatchObject({ status: "saving", last_error_code: "outcome_unknown" });
  });
  it("the create waits 200 s and the recreate 340 s before outcome_unknown; aborting the request doesn't abort the clone call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.dropResponse.add("create_reply");
    const controller = new AbortController();
    const req = new Request(`https://ops.test${P()}/save`, {
      method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ version: 1 }), signal: controller.signal
    });
    let done: Response | null = null;
    const p = saveRoute.POST(req, ctx()).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(env.fake.of("create_reply")[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(198_000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect((done as unknown as Response).status).toBe(202);

    const stale = draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A, observed_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    env.fake.dropResponse.add("recreate");
    let second: Response | null = null;
    const q = save({ version: 2 }).then((r) => (second = r));
    await vi.advanceTimersByTimeAsync(339_000);
    expect(second).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await q;
    expect((second as unknown as Response).status).toBe(202);
    expect(rowOf(env.db).status).toBe("saving");
  });
});

// ---------------------------------------------------------------------------
// RO11-RO21
// ---------------------------------------------------------------------------

const ID4 = `ed_${"0".repeat(31)}4`;
const ID5 = `ed_${"0".repeat(31)}5`;
const liveRead = (over: Record<string, unknown> = {}) => ({ status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A, ...over }) });
const review = (version = 1) => reviewRoute.POST(jsonRequest("POST", `${P()}/review`, { version }), ctx());
const resolve = (body: Record<string, unknown>, id = ID1) => resolveRoute.POST(jsonRequest("POST", `${P(id)}/resolve`, body), ctx(id));
const discard = (body: Record<string, unknown>) => draftRoute.DELETE(jsonRequest("DELETE", P(), body), ctx());
const purgedContent = {
  thread_subject: null, reply_candidates: null, thread_addresses: [], to_recipients: [], cc_recipients: [], bcc_recipients: [],
  subject: null, body_doc: null, body_html: null, body_text: null, instruction: null, note_for_mitchell: null, placeholders: [],
  review_recipients: null, restricted_purged: true
};
const evilHashes = screenHashesFor({ all: [{ from: "x@evil.example", to: [], cc: [] }], participants: [] }).hashes;

describe("RO11 review", () => {
  it("one GET; a clean read-back stores review_hash and returns it with the read-back; content_hash is the shown one", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("get_draft", liveRead({ contentHash: HASH_C }));
    const res = await review();
    expect(res.status).toBe(200);
    const r = await bodyOf(res);
    expect(env.fake.of("get_draft")).toHaveLength(1);
    expect(r).toMatchObject({ status: "saved", reviewHash: HASH_C, errors: [] });
    expect((r.readBack as { contentHash: string; srcdoc: string }).contentHash).toBe(HASH_C);
    expect(r.blockers).toEqual(["changed_in_outlook"]);
    expect(rowOf(env.db)).toMatchObject({ review_hash: HASH_C, content_hash: HASH_C, observed_content_hash: HASH_C, review_blockers: ["changed_in_outlook"] });
    expect((rowOf(env.db).review_recipients as { to: unknown[] }).to).toEqual([{ address: CLIENT, name: "Client" }]);
  });
  it("blockers from fixtures: already_replied after the parent but before created_at, facts_outside_client, unexpected_content, reply_to_present, the legacy artifacts, a sibling sent", async () => {
    const thread = threadFixture({ extra: [hisMessage({ id: "m_mine", direction: "outbound", from: { name: null, email: OWN_EMAIL }, to: [{ name: null, email: CLIENT }], sentAt: minutesAgo(60) })] });
    const row = savedRow({ facts_status: "used", client_id: "c1", generation_flags: ["unexpected_url"], created_at: minutesAgo(30), opened_in_outlook_at: minutesAgo(40) });
    const sibling = discardedRow({ id: ID3, status: "sent", outlook_graph_id: GRAPH, sent_at: minutesAgo(50) });
    env = setupDraftEnv({ rows: [row, sibling], thread, clients: CLIENTS as never });
    vi.mocked(listReplyArtifacts).mockResolvedValue(new Map([[THREAD, { scheduledFor: minutesAgo(-60), draftPending: true }]]));
    env.fake.answer("get_draft", liveRead({ cc: [{ address: "vendor@other.io", name: "" }], replyTo: [{ address: "billing@acme.io", name: "" }], bodyHtml: "<div>Total is [price]</div>" }));
    const r = await bodyOf(await review());
    expect(r.blockers).toEqual(expect.arrayContaining([
      "already_replied", "reply_scheduled", "legacy_draft_pending", "opened_in_outlook", "reply_to_present", "placeholder_in_outlook",
      "facts_outside_client", "unexpected_content"
    ]));
    expect(r.reviewHash).toBe(HASH_A);
    // facts_outside_client names the facts client (integrator, §3.13.4 "<client>"); so does the view.
    expect(r.clientName).toBe("Acme");
    const v = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
    expect(v.clientName).toBe("Acme");
  });
  // Integrator (mutant MU32): the thread signal on its own, with no sibling draft to raise it.
  it("already_replied from the thread alone: his outbound after the parent's sentAt but before created_at (C48 (a), security-2)", async () => {
    const mine = hisMessage({ id: "m_mine", direction: "outbound", from: { name: null, email: OWN_EMAIL }, to: [{ name: null, email: CLIENT }], sentAt: minutesAgo(60) });
    env = setupDraftEnv({ rows: [savedRow({ created_at: minutesAgo(30) })], thread: threadFixture({ extra: [mine] }) });
    env.fake.answer("get_draft", liveRead());
    expect((await bodyOf(await review())).blockers).toContain("already_replied");
  });
  it("the client name is absent without a facts client (integrator, §3.13.4)", async () => {
    env = setupDraftEnv({ rows: [savedRow()], clients: CLIENTS as never });
    env.fake.answer("get_draft", liveRead());
    expect((await bodyOf(await review())).clientName).toBeUndefined();
    expect((await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()))).clientName).toBeUndefined();
  });
  it("newer_inbound, thread_unavailable and recipients_changed", async () => {
    const thread = threadFixture({ extra: [hisMessage({ id: "m_new", direction: "inbound", from: { name: null, email: CLIENT }, to: [{ name: null, email: OWN_EMAIL }], sentAt: minutesAgo(5) })] });
    const sig = (await import("@/lib/exec/recipients")).recipientsSignature({ to: [{ address: CLIENT, name: null }], cc: [], bcc: [] });
    env = setupDraftEnv({ rows: [savedRow({ recipients_sig: sig })], thread });
    env.fake.answer("get_draft", liveRead({ cc: [{ address: "x@acme.io", name: "" }] }));
    expect((await bodyOf(await review())).blockers).toEqual(expect.arrayContaining(["newer_inbound", "recipients_changed"]));
    env = setupDraftEnv({ rows: [savedRow()] });
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "not_found", readDoneAtMs: Date.now() });
    env.fake.answer("get_draft", liveRead());
    expect((await bodyOf(await review())).blockers).toEqual(["thread_unavailable"]);
  });
  it("errors (a From that isn't his) → no reviewHash and no review stored; the shown hash is still written", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("get_draft", liveRead({ from: { address: "someone@else.io", name: "" }, contentHash: HASH_C }));
    const r = await bodyOf(await review());
    expect(r).toMatchObject({ reviewHash: null, errors: ["from_mismatch"] });
    // ui-4: the address each error names, for the dialog's sentence.
    expect(r.errorEntries).toEqual([{ code: "from_mismatch", address: "someone@else.io" }]);
    expect(rowOf(env.db)).toMatchObject({ review_hash: null, review_at: null, content_hash: HASH_C });
  });
  it("restricted on the live read → 404 and the draft is purged", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("acme.io")]));
    expect((await review()).status).toBe(404);
    expect(rowOf(env.db)).toMatchObject({ restricted_purged: true, body_html: null, to_recipients: [] });
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
  it("a live saved read flagged send_status_unknown is mirrored to unknown, never reviewed (data-1, C76); the flag is written", async () => {
    env = setupDraftEnv({ rows: [savedRow({ send_started_at: minutesAgo(40) })] });
    env.fake.answer("get_draft", liveRead({ flags: ["send_status_unknown"], contentHash: HASH_C }));
    const res = await review();
    expect(res.status).toBe(200);
    const r = await bodyOf(res);
    expect(r).toMatchObject({ status: "unknown", reviewHash: null, readBack: null });
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", review_hash: null, review_at: null, clone_flags: ["send_status_unknown"] });
    // Keep-the-Outlook-version on a draft whose live read carries the flag: mirrored, refused.
    env = setupDraftEnv({ rows: [savedRow({ status: "draft", version: 2, saved_version: 1, last_error_code: "outlook_changed" })] });
    env.fake.answer("get_draft", liveRead({ flags: ["send_status_unknown"], contentHash: HASH_C }));
    const kept = await resolve({ action: "keep_outlook_version", seenContentHash: HASH_C });
    expect(kept.status).toBe(409);
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", clone_flags: ["send_status_unknown"], outlook_edited: false });
  });
  it("T27 writes the read's clone flags with the review (data-1)", async () => {
    env = setupDraftEnv({ rows: [savedRow({ clone_flags: [] })] });
    env.fake.answer("get_draft", liveRead({ flags: ["signature_skipped"] }));
    expect((await bodyOf(await review())).reviewHash).toBe(HASH_A);
    expect(rowOf(env.db)).toMatchObject({ clone_flags: ["signature_skipped"] });
  });
  it("a read-back that isn't a live saved draft is mirrored (gone) and answered with no reviewHash", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    const r = await bodyOf(await review());
    expect(r).toMatchObject({ status: "gone", reviewHash: null, readBack: null });
    expect(rowOf(env.db)).toMatchObject({ status: "gone", gone_unconfirmed: true });
  });
  it("the read-back GET waits 60 s, then 503", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.dropResponse.add("get_draft");
    env.fake.defaultAnswer("get_draft", (() => new Promise(() => undefined)) as never);
    let done: Response | null = null;
    const p = review().then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect((done as unknown as Response).status).toBe(503);
  });
});

describe("RO12 discard", () => {
  it("DD-only: discarded with no clone call", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    const res = await discard({ version: 1 });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).status).toBe("discarded");
    expect(draftRoutes()).toHaveLength(0);
  });
  it("linked: a DELETE with ifContentHash and the delete key; 200 → discarded", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    expect((await bodyOf(await discard({ version: 1 }))).status).toBe("discarded");
    const d = env.fake.of("delete")[0];
    expect(d.json).toEqual({ ifContentHash: HASH_A });
    expect(d.idempotencyKey).toMatch(new RegExp(`^${ID1}:g[0-9a-f]{16}:delete:[A-Za-z0-9_-]{16}$`));
  });
  it("after an idle GET saw an Outlook edit: Discard → 409 changed, the row back to saved with the read-back; Delete anyway with its hash → discarded", async () => {
    env = setupDraftEnv({ rows: [savedRow({ observed_content_hash: HASH_C })] });
    env.fake.defaultAnswer("delete", (r) => ((r.json as { ifContentHash?: string }).ifContentHash === HASH_C
      ? { status: 200, body: { graphId: GRAPH, status: "deleted" } }
      : cl2Error(409, "changed", { draftStatus: "saved" })));
    env.fake.defaultAnswer("get_draft", liveRead({ contentHash: HASH_C }));
    const first = await bodyOf(await discard({ version: 1 }));
    expect(first).toMatchObject({ status: "saved", code: "outlook_changed" });
    expect((first.readBack as { contentHash: string }).contentHash).toBe(HASH_C);
    expect(rowOf(env.db)).toMatchObject({ status: "saved", content_hash: HASH_A, prior_status: null });
    const again = await bodyOf(await discard({ version: 1, seenContentHash: HASH_C }));
    expect(again.status).toBe("discarded");
  });
  // Integrator (mutant MU23): the idle GET through the real check path (resolve "check" →
  // mirrorRegistry) rather than a seeded column: it records observed_content_hash only (C66),
  // so the next Discard still guards with the hash he was shown and the Outlook edit survives.
  it("a check that reads an Outlook edit records it as observed only; Discard then still guards with the shown hash (C66)", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.defaultAnswer("get_draft", liveRead({ contentHash: HASH_C }));
    env.fake.defaultAnswer("delete", (r) => ((r.json as { ifContentHash?: string }).ifContentHash === HASH_C
      ? { status: 200, body: { graphId: GRAPH, status: "deleted" } }
      : cl2Error(409, "changed", { draftStatus: "saved" })));
    expect((await resolve({ action: "check" })).status).toBe(200);
    expect(rowOf(env.db)).toMatchObject({ status: "saved", content_hash: HASH_A, observed_content_hash: HASH_C });
    const first = await bodyOf(await discard({ version: rowOf(env.db).version as number }));
    expect(first).toMatchObject({ status: "saved", code: "outlook_changed" });
    expect(env.fake.of("delete")[0].json).toEqual({ ifContentHash: HASH_A });
  });
  it("any other failure returns the row to its prior status (C76): saved stays saved, a stale draft stays draft", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("delete", cl2Error(500, "server_error"));
    expect(await bodyOf(await discard({ version: 1 }))).toMatchObject({ status: "saved", code: "clone_error" });
    env = setupDraftEnv({ rows: [draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A, observed_content_hash: HASH_A })] });
    env.fake.answer("delete", cl2Error(503, "not_ready", { draftStatus: "saved" }));
    expect((await bodyOf(await discardRoute2(2))).status).toBe("draft");
  });
});
const discardRoute2 = (version: number) => draftRoute.DELETE(jsonRequest("DELETE", P(), { version }), ctx());

describe("RO13 outlook-opened", () => {
  it("stamps, clears the review, schedules +25 s on a saved row and queues one kick", async () => {
    env = setupDraftEnv({ rows: [savedRow({ review_hash: HASH_A, review_at: new Date().toISOString() })] });
    const before = Date.now();
    const res = await openedRoute.POST(jsonRequest("POST", `${P()}/outlook-opened`, {}), ctx());
    expect(res.status).toBe(200);
    const row = rowOf(env.db);
    expect(row.review_hash).toBeNull();
    const opened = Date.parse(String(row.opened_in_outlook_at));
    expect(opened).toBeGreaterThanOrEqual(before);
    expect(Date.parse(String(row.next_check_at)) - opened).toBe(25_000);
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.draft-reconcile", lane: "interactive", maxAttempts: 1, payload: { kick: true } });
    expect(String(vi.mocked(enqueueJob).mock.calls[0][0].dedupeKey)).toMatch(new RegExp(`^draft-recon:${PRINCIPAL.id}:o${ID1}:[0-9]+$`));
  });
});

describe("RO14 resolve", () => {
  it("the view says when an unknown row is past its 30 min horizon (ui-8), whatever the capabilities", async () => {
    for (const [ago, past] of [[40, true], [10, false]] as const) {
      env = setupDraftEnv({ rows: [unknownRow({ send_started_at: minutesAgo(ago) })] });
      const v = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
      expect((v.sent as { pastHorizon: boolean }).pastHorizon, String(ago)).toBe(past);
    }
    env = setupDraftEnv({ rows: [savedRow()] });
    expect(((await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()))).sent as { pastHorizon: boolean }).pastHorizon).toBe(false);
  });
  it("mark_sent: before the horizon or without the checkbox → hold; on a draft → state_conflict; else sent + unverified", async () => {
    env = setupDraftEnv({ rows: [unknownRow({ send_started_at: minutesAgo(10) })] });
    expect((await bodyOf(await resolve({ action: "mark_sent", checkedOutlook: true }))).error).toBe("hold");
    env = setupDraftEnv({ rows: [unknownRow()] });
    expect((await bodyOf(await resolve({ action: "mark_sent" }))).error).toBe("hold");
    env = setupDraftEnv({ rows: [draftRow()] });
    expect((await bodyOf(await resolve({ action: "mark_sent", checkedOutlook: true }))).error).toBe("state_conflict");
    env = setupDraftEnv({ rows: [unknownRow()] });
    expect((await resolve({ action: "mark_sent", checkedOutlook: true })).status).toBe(200);
    expect(rowOf(env.db)).toMatchObject({ status: "sent", owner_resolution: "sent", unverified: true });
  });
  it("not_sent_new_draft: the sent copy found → 409 sent_copy_found and the row → sent", async () => {
    env = setupDraftEnv({ rows: [unknownRow()] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    const res = await resolve({ action: "not_sent_new_draft", checkedOutlook: true });
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("sent_copy_found");
    expect(rowOf(env.db)).toMatchObject({ status: "sent", unverified: true });
  });
  // Integrator (mutant MU29c): T43's direct path, when Outlook holds no draft for the row (the
  // registry answers not_found): no DELETE, discarded (not_sent) first, then the successor.
  it("not_sent_new_draft with no Outlook draft (registry not_found): no DELETE, discarded, and only then the new draft", async () => {
    env = setupDraftEnv({ rows: [unknownRow()] });
    env.fake.answer("get_draft", cl2Error(404, "not_found"));
    const r = await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }));
    expect(r.status).toBe("discarded");
    expect(env.fake.of("delete")).toHaveLength(0);
    expect(r.newDraftId).not.toBeNull();
    expect(r.newDraftId).not.toBe(ID1);
    expect(rowOf(env.db, r.newDraftId as string)).toMatchObject({ status: "draft", version: 1 });
    expect(rowOf(env.db)).toMatchObject({ status: "discarded", owner_resolution: "not_sent" });
    const log = env.db.log;
    expect(log.lastIndexOf("insert exec_drafts")).toBeGreaterThan(log.lastIndexOf("update exec_drafts"));
  });
  it("not_sent_new_draft: GET, DELETE, discarded (not_sent), and only then a new draft with the content, a fresh id and nonce; 30 min without the flag is enough (C68)", async () => {
    env = setupDraftEnv({ rows: [unknownRow()] });
    env.fake.answer("get_draft", liveRead({ flags: [] }));
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    const r = await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }));
    expect(r.status).toBe("discarded");
    const next = rowOf(env.db, r.newDraftId as string);
    expect(next).toMatchObject({ status: "draft", version: 1, body_html: "<p>Thanks, we're on it.</p>", thread_id: THREAD, parent_message_id: PARENT });
    expect(next.id).not.toBe(ID1);
    expect(next.render_nonce).not.toBe(rowOf(env.db).render_nonce);
    expect(rowOf(env.db)).toMatchObject({ status: "discarded", owner_resolution: "not_sent" });
    const log = env.db.log;
    expect(log.lastIndexOf("insert exec_drafts")).toBeGreaterThan(log.lastIndexOf("update exec_drafts"));
    expect(env.fake.of("delete")[0].json).toEqual({ ifContentHash: HASH_A });
    env = setupDraftEnv({ rows: [unknownRow({ send_started_at: minutesAgo(29) })] });
    expect((await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }))).error).toBe("hold");
  });
  it.each([
    ["409 changed", cl2Error(409, "changed", { draftStatus: "saved" })],
    ["429", cl2Error(429, "throttled", { draftStatus: "saved" }, { "retry-after": "5" })],
    ["500", cl2Error(500, "server_error")]
  ])("not_sent_new_draft: a DELETE answering %s → the row back to unknown, no successor, no Review offered", async (_n, answer) => {
    env = setupDraftEnv({ rows: [unknownRow()] });
    env.fake.answer("get_draft", liveRead());
    env.fake.answer("delete", answer);
    env.fake.defaultAnswer("get_draft", liveRead({ contentHash: HASH_C }));
    const r = await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }));
    expect(r.status).toBe("unknown");
    expect(r.newDraftId).toBeNull();
    expect(env.db.tables.exec_drafts).toHaveLength(1);
    expect((r.view as { capabilities: { canReview: boolean } }).capabilities.canReview).toBe(false);
    if (_n === "409 changed") expect((r.readBack as { contentHash: string }).contentHash).toBe(HASH_C);
  });
  it("copy_to_new_draft on an unconfirmed gone row: needs the checkbox; clears the flag (V) before the insert", async () => {
    const gone = goneRow({ id: ID1, gone_unconfirmed: true, gone_at: minutesAgo(3) });
    env = setupDraftEnv({ rows: [gone] });
    expect((await bodyOf(await resolve({ action: "copy_to_new_draft" }))).error).toBe("hold");
    env = setupDraftEnv({ rows: [gone] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    const r = await bodyOf(await resolve({ action: "copy_to_new_draft", checkedOutlook: true }));
    expect(r.newDraftId).not.toBe(ID1);
    expect(rowOf(env.db)).toMatchObject({ status: "gone", gone_unconfirmed: false });
    expect(rowOf(env.db, r.newDraftId as string)).toMatchObject({ status: "draft", body_text: "Thanks, we're on it." });
  });
  it("copy_to_new_draft: the draft live again → 409 state_conflict and the row back to saved; a CAS miss → 409 and no insert", async () => {
    const gone = goneRow({ id: ID1, gone_unconfirmed: true, gone_at: minutesAgo(3) });
    env = setupDraftEnv({ rows: [gone] });
    env.fake.answer("get_draft", liveRead());
    const res = await resolve({ action: "copy_to_new_draft", checkedOutlook: true });
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe("state_conflict");
    expect(rowOf(env.db)).toMatchObject({ status: "saved", gone_unconfirmed: false });
    let bumped = false;
    env = setupDraftEnv({
      rows: [gone],
      db: { before: (r, db) => {
        if (!bumped && r.kind === "update" && r.target === "exec_drafts") {
          bumped = true;
          db.tables.exec_drafts[0].version = 9;
        }
      } }
    });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    const miss = await resolve({ action: "copy_to_new_draft", checkedOutlook: true });
    expect(miss.status).toBe(409);
    expect(env.db.tables.exec_drafts).toHaveLength(1);
  });
  it("copy_to_new_draft twice on a new email's gone row (data-7): concurrent or one after the other, exactly one successor", async () => {
    const gone = goneRow({ id: ID1, kind: "new", thread_id: null, parent_message_id: null, reply_mode: null, thread_subject: null, reply_candidates: null,
      thread_addresses: [], subject: "Quick update", screened_policy_hash: null });
    env = setupDraftEnv({ rows: [gone] });
    env.fake.defaultAnswer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    const [a, b] = await Promise.all([resolve({ action: "copy_to_new_draft", checkedOutlook: true }), resolve({ action: "copy_to_new_draft", checkedOutlook: true })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(env.db.tables.exec_drafts).toHaveLength(2);
    expect(rowOf(env.db)).toMatchObject({ status: "gone", last_error_code: "copied", version: 2 });
    const again = await resolve({ action: "copy_to_new_draft", checkedOutlook: true });
    expect(again.status).toBe(409);
    expect(env.db.tables.exec_drafts).toHaveLength(2);
    const v = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
    expect((v.capabilities as { resolve: string[] }).resolve).not.toContain("copy_to_new_draft");
  });
  it("keep_outlook_version takes the hash of the read-back he was shown", async () => {
    const changed = draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A, observed_content_hash: HASH_C, last_error_code: "outlook_changed" });
    env = setupDraftEnv({ rows: [changed] });
    env.fake.defaultAnswer("get_draft", liveRead({ contentHash: HASH_C }));
    const r = await bodyOf(await resolve({ action: "keep_outlook_version", seenContentHash: HASH_C }));
    expect(r).toMatchObject({ status: "saved", code: null });
    expect(rowOf(env.db)).toMatchObject({ status: "saved", saved_version: 2, content_hash: HASH_C, outlook_edited: true, last_error_code: null });
    env = setupDraftEnv({ rows: [changed] });
    env.fake.defaultAnswer("get_draft", liveRead({ contentHash: HASH_B }));
    const again = await bodyOf(await resolve({ action: "keep_outlook_version", seenContentHash: HASH_C }));
    expect(again).toMatchObject({ status: "draft", code: "outlook_changed" });
    expect((again.readBack as { contentHash: string }).contentHash).toBe(HASH_B);
  });
});

describe("RO15 the send probe", () => {
  const probe = () => sendRoute.GET(jsonRequest("GET", `${P()}/send`), ctx());
  const verdict = (over: Record<string, unknown> = {}) => ({
    value: { ok: true, reason: null, checkedAt: new Date().toISOString(), cl2Ready: true, cl2Send: "all", sendEnabled: true, expiresAt: null, tokenFp: null, ...over },
    rev: 1
  });
  const withVerdict = (over: Record<string, unknown> = {}) =>
    vi.mocked(getSyncState).mockImplementation((async (_p: unknown, source: string, key: string) => (source === "clone-ea" && key === "ea-token" ? verdict(over) : null)) as never);
  it("each reason, and the send-token verdict is written on every call", async () => {
    env = setupDraftEnv({ rows: [savedRow()], settings: { sendEnabled: false } });
    expect(await bodyOf(await probe())).toEqual({ sendReady: false, reason: "send_off", draftsReady: true });
    // No stored verdict: proven here (ui-2); a missing token is its own reason.
    env = setupDraftEnv({ rows: [savedRow()] });
    delete process.env.MISSIVE_EA_TOKEN;
    expect(await bodyOf(await probe())).toEqual({ sendReady: false, reason: "token_missing", draftsReady: false });
    env = setupDraftEnv({ rows: [savedRow()] });
    withVerdict({ cl2Send: "off", sendEnabled: false });
    expect(await bodyOf(await probe())).toEqual({ sendReady: false, reason: "clone_send_off", draftsReady: true });
    withVerdict();
    expect(await bodyOf(await probe())).toEqual({ sendReady: true, reason: null, draftsReady: true });
    delete process.env.MISSIVE_EA_SEND_TOKEN;
    expect(await bodyOf(await probe())).toEqual({ sendReady: false, reason: "send_token", draftsReady: true });
    const { putSyncState } = await import("@/lib/exec/sync-state");
    const writes = vi.mocked(putSyncState).mock.calls.filter((c) => c[1] === "clone-ea" && c[2] === "send-token");
    expect(writes.length).toBeGreaterThanOrEqual(3); // one per probe since the last setupDraftEnv
    expect(writes[writes.length - 1][3]).toMatchObject({ ok: false, reason: "token_missing" });
  });
  it("a stored failed verdict is proven again (ui-2): the recovered clone gives Save back without another draft", async () => {
    env = setupDraftEnv({ rows: [savedRow({ status: "draft", version: 2, saved_version: 1 })] });
    withVerdict({ ok: false, reason: "cl2_not_ready", cl2Ready: false });
    const before = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
    expect((before.capabilities as { draftsUnavailable: string | null; canSave: boolean })).toMatchObject({ draftsUnavailable: "cl2_not_ready", canSave: false });
    expect(env.fake.of("auth_me")).toHaveLength(0); // the view stays DB-only (C19)
    const p = await bodyOf(await probe());
    expect(p).toMatchObject({ draftsReady: true });
    expect(env.fake.of("auth_me").length).toBeGreaterThanOrEqual(1);
    const after = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
    expect((after.capabilities as { draftsUnavailable: string | null; canSave: boolean })).toMatchObject({ draftsUnavailable: null, canSave: true });
    expect(env.db.tables.exec_drafts).toHaveLength(1);
    expect(draftRoutes()).toHaveLength(0);
  });
});

describe("RO16 the list", () => {
  it("attention first in C46's order (outlook_changed included); restricted rows carry no label or summary and are purged", async () => {
    const rows = [
      draftRow({ id: ID1, thread_id: "t1", updated_at: minutesAgo(1) }),
      unknownRow({ id: ID2, thread_id: "t2", updated_at: minutesAgo(50) }),
      savedRow({ id: ID3, thread_id: "t3", observed_content_hash: HASH_C, updated_at: minutesAgo(40) }),
      draftRow({ id: ID4, thread_id: "t4", status: "generation_failed", generation_error: "model_error", body_doc: null, body_html: null, body_text: null, updated_at: minutesAgo(30) }),
      savedRow({ id: ID5, thread_id: "t5", screen_hashes: evilHashes, updated_at: minutesAgo(20) })
    ];
    env = setupDraftEnv({ rows });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("evil.example")]));
    const res = await listRoute.GET(jsonRequest("GET", "/api/exec/drafts?view=active"));
    const { items } = (await bodyOf(res)) as { items: { id: string; attention: string | null; label: string | null; toSummary: string | null; restricted: boolean }[] };
    expect(items.map((i) => i.id)).toEqual([ID2, ID3, ID4, ID5, ID1]);
    expect(items.map((i) => i.attention)).toEqual(["unknown", "outlook_changed", "generation_failed", "restricted", null]);
    expect(items[3]).toMatchObject({ restricted: true, label: null, toSummary: null });
    expect(items[4]).toMatchObject({ label: "Website update", toSummary: CLIENT });
    expect(rowOf(env.db, ID5)).toMatchObject({ restricted_purged: true, to_recipients: [] });
  });
  it("a bad view or limit is 400", async () => {
    expect((await listRoute.GET(jsonRequest("GET", "/api/exec/drafts?view=everything"))).status).toBe(400);
    expect((await listRoute.GET(jsonRequest("GET", "/api/exec/drafts?view=all&limit=500"))).status).toBe(400);
    expect((await listRoute.GET(jsonRequest("GET", "/api/exec/drafts?view=all&cursor=nope"))).status).toBe(400);
  });
});

describe("RO17 Check again", () => {
  it.each([
    ["saved", savedRow()],
    ["draft with a stale link", draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A, observed_content_hash: HASH_A })],
    ["unknown", unknownRow()],
    ["sent_pending", savedRow({ status: "sent_pending", send_attempt_key: KEY(), send_started_at: minutesAgo(2), send_accepted_at: minutesAgo(2), confirm_hash: HASH_A })],
    ["gone unconfirmed", goneRow({ id: ID1, gone_unconfirmed: true, gone_at: minutesAgo(3) })]
  ])("%s: one GET, observed_content_hash written, content_hash untouched", async (_n, row) => {
    env = setupDraftEnv({ rows: [row] });
    env.fake.answer("get_draft", liveRead({ contentHash: HASH_C, status: row.status === "sent_pending" ? "sent_pending_verification" : row.status === "unknown" ? "unknown" : "saved" }));
    const res = await resolve({ action: "check" });
    expect(res.status).toBe(200);
    expect(env.fake.of("get_draft")).toHaveLength(1);
    expect(rowOf(env.db).content_hash).toBe(row.content_hash);
    expect(rowOf(env.db).observed_content_hash).toBe(HASH_C);
    expect(vi.mocked(auditEvent).mock.calls.at(-1)?.[1].action).toBe("draft.check");
  });
  it.each([
    ["generating", draftRow({ status: "generating", generation_seq: 1, body_doc: null, body_html: null, body_text: null })],
    ["saving", draftRow({ status: "saving", save_attempt_key: `${ID1}:v1:save:abcdefghijklmnop`, save_version: 1, save_started_at: minutesAgo(1) })],
    ["discarding", savedRow({ status: "discarding", prior_status: "saved", discard_attempt_key: `${ID1}:gabc:delete:x`, discard_started_at: minutesAgo(1) })],
    ["sending", savedRow({ status: "sending", send_attempt_key: KEY(), send_started_at: minutesAgo(1), confirm_hash: HASH_A })],
    ["sent", savedRow({ status: "sent", terminal_at: minutesAgo(5), expires_at: minutesAgo(-10_000), sent_at: minutesAgo(5) })]
  ])("%s → 409 and no GET", async (_n, row) => {
    env = setupDraftEnv({ rows: [row] });
    expect((await resolve({ action: "check" })).status).toBe(409);
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
  it("a gone row before +16 min keeps gone_unconfirmed; at +16 min a gone answer confirms it", async () => {
    env = setupDraftEnv({ rows: [goneRow({ id: ID1, gone_unconfirmed: true, gone_at: minutesAgo(10) })] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    await resolve({ action: "check" });
    expect(rowOf(env.db).gone_unconfirmed).toBe(true);
    env = setupDraftEnv({ rows: [goneRow({ id: ID1, gone_unconfirmed: true, gone_at: minutesAgo(17) })] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    await resolve({ action: "check" });
    expect(rowOf(env.db)).toMatchObject({ gone_unconfirmed: false, next_check_at: null });
  });
  it("the 31st check in 10 minutes → 429", async () => {
    const audit = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, principal_id: PRINCIPAL.id, action: "draft.check", created_at: minutesAgo(2) }));
    env = setupDraftEnv({ rows: [savedRow()], audit });
    expect((await resolve({ action: "check" })).status).toBe(429);
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
});

describe("RO18 Stop", () => {
  it("a first generation → generation_failed (stopped); a regenerate of a saved row → saved, content unchanged, generation_stopped; the job's late CAS misses", async () => {
    env = setupDraftEnv({ rows: [draftRow({ status: "generating", generation_seq: 1, body_doc: null, body_html: null, body_text: null })] });
    expect((await resolve({ action: "stop_generation" })).status).toBe(200);
    expect(rowOf(env.db)).toMatchObject({ status: "generation_failed", generation_error: "stopped" });
    env = setupDraftEnv({ rows: [savedRow({ status: "generating", prior_status: "saved", generation_seq: 2 })] });
    expect((await resolve({ action: "stop_generation" })).status).toBe(200);
    expect(rowOf(env.db)).toMatchObject({ status: "saved", last_error_code: "generation_stopped", body_text: "Thanks, we're on it." });
    const { casDraft } = await import("@/lib/exec/drafts-store");
    expect(await casDraft(PRINCIPAL, ID1, { status: "generating", version: 1, generationSeq: 2 }, { status: "draft", version: 2 })).toBe(false);
  });
});

describe("RO19 restricted rows by status (C13)", () => {
  it("Delete only on a restricted saved / linked draft row, with no ifContentHash and no GET", async () => {
    env = setupDraftEnv({ rows: [savedRow(purgedContent)] });
    expect((await discard({ version: 1 })).status).toBe(422);
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    const res = await discard({ version: 1, confirmRestrictedDelete: true });
    expect((await bodyOf(res)).status).toBe("discarded");
    expect(env.fake.of("delete")[0].json).toEqual({});
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
  it.each([
    ["sent", savedRow({ ...purgedContent, status: "sent", terminal_at: minutesAgo(5), expires_at: minutesAgo(-10_000), sent_at: minutesAgo(5) })],
    ["gone", goneRow({ ...purgedContent, id: ID1 })],
    ["sending", savedRow({ ...purgedContent, status: "sending", send_attempt_key: KEY(), send_started_at: minutesAgo(1), confirm_hash: HASH_A })]
  ])("a restricted %s row → 409", async (_n, row) => {
    env = setupDraftEnv({ rows: [row] });
    expect((await discard({ version: 1, confirmRestrictedDelete: true })).status).toBe(409);
    expect(draftRoutes()).toHaveLength(0);
  });
  it("a restricted unknown row's \"It wasn't sent\" deletes without ifContentHash and makes no new draft", async () => {
    env = setupDraftEnv({ rows: [unknownRow(purgedContent)] });
    env.fake.answer("get_draft", liveRead());
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    const r = await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }));
    expect(r).toMatchObject({ status: "discarded", newDraftId: null });
    expect(env.fake.of("delete")[0].json).toEqual({});
    expect(env.db.tables.exec_drafts).toHaveLength(1);
  });
});

describe("RO20 the new-draft page's previewReply", () => {
  it("thread_unavailable, hold and sent_copy_found each come back as their code; ok gives the seed; hold is passed by checkedOutlook on the create", async () => {
    const outboundOnly = threadFixture();
    outboundOnly.his = [hisMessage({ id: "m_out", direction: "outbound", from: { name: null, email: OWN_EMAIL }, to: [] })];
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "ok", thread: outboundOnly });
    expect(await previewReply(PRINCIPAL, THREAD)).toEqual({ ok: false, code: "thread_unavailable" });
    env = setupDraftEnv({ rows: [goneRow()] });
    expect(await previewReply(PRINCIPAL, THREAD)).toEqual({ ok: false, code: "hold" });
    expect((await createReply({ checkedOutlook: true })).status).toBe(201);
    env = setupDraftEnv({ rows: [goneRow()] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    expect(await previewReply(PRINCIPAL, THREAD)).toEqual({ ok: false, code: "sent_copy_found" });
    env = setupDraftEnv();
    const ok = await previewReply(PRINCIPAL, THREAD);
    expect(ok).toMatchObject({ ok: true, seed: { kind: "reply", threadId: THREAD, mode: "reply", to: [{ address: CLIENT, name: "Client" }], parentFrom: { address: CLIENT } } });
  });
  it("recipientSuggestions: users, client contacts, screened correspondents; never his own, no-reply or restricted addresses", async () => {
    vi.mocked(listUsers).mockResolvedValue([
      { id: "u1", name: "Mitchell", email: OWN_EMAIL }, { id: "u2", name: "Sam", email: "sam@scaledai.org" }
    ] as never);
    const { listCorrespondentRows } = await import("@/lib/exec/email-store");
    vi.mocked(listCorrespondentRows).mockResolvedValue([
      { threadId: "t9", accountId: HIS, state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: policyOf([rule("evil.example")]).hash, correspondents: ["pat@partner.io", "noreply@partner.io", "x@evil.example"] }
    ] as never);
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("evil.example")]));
    env.fake.reset();
    const list = await recipientSuggestions(PRINCIPAL);
    expect(list.map((s) => [s.address, s.source])).toEqual([["sam@scaledai.org", "internal"], ["pat@partner.io", "correspondent"]]);
  });
});

describe("RO21 the render-time screen (C11)", () => {
  const base = { kind: "reply" as const, restrictedPurged: false, screenHashes: [] as string[], screenTruncated: false, screenedPolicyHash: null as string | null };
  it("truncated with the current policy hash → clean; the policy moved → stale_truncated; truncated with no hash → restricted", () => {
    const p0 = policyOf([]);
    const p1 = policyOf([rule("new.example")]);
    expect(screenDraftRow({ ...base, screenTruncated: true, screenedPolicyHash: p0.hash }, p0, null)).toEqual({ restricted: false, reason: null });
    expect(screenDraftRow({ ...base, screenTruncated: true, screenedPolicyHash: p0.hash }, p1, null)).toEqual({ restricted: true, reason: "stale_truncated" });
    expect(screenDraftRow({ ...base, screenTruncated: true, screenedPolicyHash: null }, p0, null)).toEqual({ restricted: true, reason: "stale_truncated" });
  });
  it("untruncated hashes that match a new rule → rule_match; a new draft is clean unless purged; a failing P3 row → thread_row", () => {
    const p = policyOf([rule("evil.example")]);
    expect(screenDraftRow({ ...base, screenHashes: evilHashes, screenedPolicyHash: policyOf([]).hash }, p, null)).toEqual({ restricted: true, reason: "rule_match" });
    expect(screenDraftRow({ ...base, kind: "new" }, p, null)).toEqual({ restricted: false, reason: null });
    expect(screenDraftRow({ ...base, kind: "new", restrictedPurged: true }, p, null)).toEqual({ restricted: true, reason: "purged" });
    const tomb = { threadId: THREAD, accountId: HIS, state: "restricted_hidden" as const, screenHashes: [], screenTruncated: false, screenedPolicyHash: null };
    expect(screenDraftRow({ ...base, screenedPolicyHash: policyOf([]).hash }, policyOf([]), tomb)).toEqual({ restricted: true, reason: "thread_row" });
  });
  it("G10 purges a reply draft whose policy moved under a truncated hash set, and GET shows the restricted view", async () => {
    env = setupDraftEnv({ rows: [draftRow({ screen_truncated: true, screened_policy_hash: policyOf([]).hash })] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("new.example")]));
    const v = await bodyOf(await draftRoute.GET(jsonRequest("GET", P()), ctx()));
    expect(v).toMatchObject({ restricted: true, bodyText: null, to: [], threadSubject: null });
    expect(rowOf(env.db)).toMatchObject({ restricted_purged: true, status: "discarded" });
    expect(vi.mocked(auditEvent).mock.calls.map((c) => c[1].action)).toContain("draft.purge_restricted");
  });
  it("the review's hash write (T27) carries the policy hash of the rules it used", async () => {
    const p = policyOf([rule("unrelated.example")]);
    env = setupDraftEnv({ rows: [savedRow({ screened_policy_hash: policyOf([]).hash })] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(p);
    env.fake.answer("get_draft", liveRead());
    await review();
    expect(rowOf(env.db).screened_policy_hash).toBe(p.hash);
    expect((rowOf(env.db).screen_hashes as string[]).length).toBeGreaterThan(0);
  });
});
