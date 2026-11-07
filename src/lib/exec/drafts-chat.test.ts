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
import * as regenerateRoute from "@/app/api/exec/drafts/[id]/regenerate/route";
import * as resolveRoute from "@/app/api/exec/drafts/[id]/resolve/route";
import * as reviewRoute from "@/app/api/exec/drafts/[id]/review/route";
import * as saveRoute from "@/app/api/exec/drafts/[id]/save/route";
import * as sendRoute from "@/app/api/exec/drafts/[id]/send/route";
import { auditEvent, auditStart } from "@/lib/exec/audit";
import { SaveBody, createChatReplyDraft, getDraftView } from "@/lib/exec/drafts";
import { DRAFT_COLUMNS, DraftStoreError, casDraft, draftFromDb, getDraft, insertDraft, listDrafts, purgeDraftsByIds, type NewDraftRow } from "@/lib/exec/drafts-store";
import { AUDIT_INPUT_KEYS, REVIEW_BLOCKERS } from "@/lib/exec/drafts-types";
import { getEmailThread } from "@/lib/exec/email-store";
import type { ExecEmailThread } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { findSentCopy, loadScreeningPolicy, readPrincipalThread } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError } from "@/lib/exec/types";
import { cl2Error, readBackFixture, type Cl2Reply } from "./__tests__/fake-clone";
import { createFakeDraftsDb, draftDefaults, purgeRestrictedRows, purgeRowsByIds, type Row } from "./__tests__/fake-drafts-db";
import {
  CLIENT,
  GRAPH,
  HASH_A,
  HIS,
  ID1,
  ID2,
  OWN_EMAIL,
  PARENT,
  PRINCIPAL,
  THREAD,
  bodyOf,
  draftRow,
  hisMessage,
  jsonRequest,
  minutesAgo,
  mintPrincipal,
  policyOf,
  reviewedRow,
  rowOf,
  rule,
  savedRow,
  setupDraftEnv,
  threadFixture,
  type DraftEnv,
  type DraftEnvOptions
} from "./__tests__/drafts-harness";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";

// P5b Area F (contract §3.23): TF1 createChatReplyDraft (F1), TF3 Save's private-refs confirmation (F3), TF4 the
// private_refs review blocker at Review and Send (F4), TF7 instruction_by (F7, plus the late-migration fallback the
// store adds for it) and TF8 purgeDraftsByIds (F8). The real drafts.ts and drafts-store.ts run over the fake
// exec_drafts (fake-drafts-db), the CL2 fake behind the real EA readiness, and the harness's mocks.

const ENV = { ...process.env };
let env: DraftEnv;
const ctx = (id = ID1) => ({ params: { id } });
const P = (id = ID1) => `/api/exec/drafts/${id}`;
const INSTRUCTION = "Tell her Thursday at 2pm works and ask for the agenda.";
/** The chat's drafts need P5b's migration (chatSchemaReady) on top of P4's. */
const CHAT_ON = { chatSchemaReady: true };
const chatEnv = (opts: DraftEnvOptions = {}) => setupDraftEnv({ ...opts, settings: { ...CHAT_ON, ...(opts.settings ?? {}) } });
const chat = (over: Partial<{ threadId: string; instruction: string; usesPrivateRefs: boolean; chatMessageId: string | null }> = {}, signal?: AbortSignal) =>
  createChatReplyDraft(PRINCIPAL, { threadId: THREAD, instruction: INSTRUCTION, usesPrivateRefs: false, ...over }, signal ? { signal } : {});
const generationRows = (n: number, ago = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, principal_id: PRINCIPAL.id, action: "draft.generate.request", created_at: minutesAgo(ago) }));
/** Nothing past the gates ran: no audit count, no readiness call, no thread read, no row. */
const nothingAfterGates = () => {
  expect(env.db.log).not.toContain("select exec_audit_log");
  expect(env.fake.requests).toHaveLength(0);
  expect(vi.mocked(readPrincipalThread)).not.toHaveBeenCalled();
  expect(env.db.tables.exec_drafts ?? []).toHaveLength(0);
};
const draftInserts = () => env.db.requests.filter((r) => r.kind === "insert" && r.target === "exec_drafts");

beforeEach(() => {
  env = chatEnv();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ENV };
});

// ---------------------------------------------------------------------------
// TF1 createChatReplyDraft (F1)
// ---------------------------------------------------------------------------

describe("TF1 createChatReplyDraft: P4's gates in P4's order, each a refusal value", () => {
  it("G5: drafts not installed, or P5b's columns not installed → drafts_unavailable before anything else runs", async () => {
    env = chatEnv({ settings: { draftsSchemaReady: false, draftsEnabled: false, emailEnabled: false } });
    expect(await chat()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    nothingAfterGates();
    env = chatEnv({ settings: { chatSchemaReady: false } });
    expect(await chat()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    nothingAfterGates();
  });

  it("G5b: drafts off → drafts_off (before the email switch); email off or not installed → email_off", async () => {
    env = chatEnv({ settings: { draftsEnabled: false, emailEnabled: false } });
    expect(await chat()).toEqual({ kind: "refused", reason: "drafts_off" });
    nothingAfterGates();
    env = chatEnv({ settings: { emailEnabled: false } });
    expect(await chat()).toEqual({ kind: "refused", reason: "email_off" });
    nothingAfterGates();
    env = chatEnv({ settings: { emailSchemaReady: false } });
    expect(await chat()).toEqual({ kind: "refused", reason: "email_off" });
    nothingAfterGates();
  });

  it("G6: an empty pin → no_pin; no usable account → mailbox_problem", async () => {
    const unpinned = mintPrincipal([]);
    expect(await createChatReplyDraft(unpinned, { threadId: THREAD, instruction: INSTRUCTION, usesPrivateRefs: false })).toEqual({ kind: "refused", reason: "no_pin" });
    nothingAfterGates();
    vi.mocked(getSyncState).mockImplementation((async (_p: unknown, source: string, key: string) =>
      source === "mail" && key === "accounts"
        ? { value: { checkedAt: minutesAgo(1), accounts: [], problems: [{ accountId: HIS, reason: "auth_failed" }] }, rev: 1 }
        : null) as never);
    expect(await chat()).toEqual({ kind: "refused", reason: "mailbox_problem" });
    nothingAfterGates();
  });

  it("G7: 20 draft.generate.request rows in 10 minutes → rate_limited, before readiness and the thread read; 19, or older rows, pass", async () => {
    env = chatEnv({ audit: generationRows(20) });
    expect(await chat()).toEqual({ kind: "refused", reason: "rate_limited" });
    expect(env.db.log).toContain("select exec_audit_log");
    expect(env.fake.requests).toHaveLength(0);
    expect(vi.mocked(readPrincipalThread)).not.toHaveBeenCalled();
    env = chatEnv({ audit: generationRows(20, 11) });
    expect((await chat()).kind).toBe("created");
    env = chatEnv({ audit: generationRows(19) });
    expect((await chat()).kind).toBe("created");
  });

  it("G8: EA readiness not ok → drafts_unavailable, before the thread read", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    expect(await chat()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    expect(vi.mocked(readPrincipalThread)).not.toHaveBeenCalled();
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });

  it("restricted, missing, not-his, tombstoned, malformed and anchorless threads all answer the same unavailable_thread, with no row", async () => {
    const same = { kind: "refused", reason: "unavailable_thread" };
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("acme.io")]));
    expect(await chat()).toEqual(same);
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([]));
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_found", readDoneAtMs: Date.now() });
    expect(await chat()).toEqual(same);
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_his" });
    expect(await chat()).toEqual(same);
    vi.mocked(getEmailThread).mockResolvedValueOnce({ threadId: THREAD, accountId: HIS, state: "restricted_hidden", screenHashes: [], screenTruncated: false, screenedPolicyHash: null } as unknown as ExecEmailThread);
    expect(await chat()).toEqual(same);
    const calls = vi.mocked(readPrincipalThread).mock.calls.length;
    expect(await chat({ threadId: "not a thread id!" })).toEqual(same);
    expect(vi.mocked(readPrincipalThread).mock.calls.length).toBe(calls);
    const outboundOnly = threadFixture();
    outboundOnly.his = [hisMessage({ id: "m_out", direction: "outbound", from: { name: null, email: OWN_EMAIL }, to: [] })];
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "ok", thread: outboundOnly });
    expect(await chat()).toEqual(same);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it("the parent on an account that isn't usable → mailbox_problem", async () => {
    const elsewhere = threadFixture();
    elsewhere.his = elsewhere.his.map((m) => ({ ...m, accountId: "acc_other" }));
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "ok", thread: elsewhere });
    expect(await chat()).toEqual({ kind: "refused", reason: "mailbox_problem" });
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });

  it("the read passes the chat's signal and the route's 15 s timeout; a thrown read or screen throws (not a refusal)", async () => {
    const signal = new AbortController().signal;
    await chat({}, signal);
    expect(vi.mocked(readPrincipalThread).mock.calls[0][2]).toEqual({ usable: [HIS], timeoutMs: 15_000, signal });
    expect(vi.mocked(loadScreeningPolicy).mock.calls[0][1]).toEqual({ signal });
    env = chatEnv();
    const clone = Object.assign(new Error("clone 502"), { name: "CloneHttpError" });
    vi.mocked(readPrincipalThread).mockRejectedValueOnce(clone);
    await expect(chat()).rejects.toBe(clone);
    const rules = new Error("rules unreadable");
    vi.mocked(loadScreeningPolicy).mockRejectedValueOnce(rules);
    await expect(chat()).rejects.toBe(rules);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });

  it("an aborted signal throws before any write", async () => {
    const c = new AbortController();
    c.abort();
    await expect(chat({}, c.signal)).rejects.toThrow();
    expect(env.db.tables.exec_drafts).toHaveLength(0);
    expect(vi.mocked(auditEvent)).not.toHaveBeenCalled();
  });

  it("the look-back: hold and sent_copy_found are both needs_check, and no row is started", async () => {
    const gone = savedRow({ id: ID2, status: "gone", gone_at: minutesAgo(60), gone_unconfirmed: false, terminal_at: minutesAgo(60), expires_at: minutesAgo(-100_000), created_at: minutesAgo(90) });
    env = chatEnv({ rows: [gone] });
    expect(await chat()).toEqual({ kind: "refused", reason: "needs_check" });
    expect(env.db.tables.exec_drafts).toHaveLength(1);
    env = chatEnv({ rows: [gone] });
    vi.mocked(findSentCopy).mockResolvedValue("found");
    expect(await chat()).toEqual({ kind: "refused", reason: "needs_check" });
    expect(env.db.tables.exec_drafts).toHaveLength(1);
    // A sent-copy read that fails is P4's 503; chat gets a value, never the route error.
    env = chatEnv({ rows: [gone] });
    vi.mocked(findSentCopy).mockRejectedValue(new Error("clone down"));
    expect(await chat()).toEqual({ kind: "refused", reason: "unavailable" });
  });

  it("an active draft on the thread → existing, unchanged: its instruction untouched, nothing written or enqueued", async () => {
    env = chatEnv({ rows: [draftRow({ instruction: "His own words." })] });
    expect(await chat({ usesPrivateRefs: true })).toEqual({ kind: "existing", draftId: ID1, status: "draft" });
    expect(rowOf(env.db)).toMatchObject({ instruction: "His own words.", instruction_by: "owner", uses_private_refs: false, origin: "web", version: 1 });
    expect(draftInserts()).toHaveLength(0);
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    expect(vi.mocked(auditEvent)).not.toHaveBeenCalled();
  });

  it("an insert that loses the one-active race (23505) → existing with the winner's id", async () => {
    let raced = false;
    env = chatEnv({
      db: {
        before: (r, db) => {
          if (!raced && r.kind === "insert" && r.target === "exec_drafts") {
            raced = true;
            db.tables.exec_drafts.push(draftRow({ id: ID2, status: "saved", saved_version: 1, outlook_graph_id: GRAPH }));
          }
        }
      }
    });
    expect(await chat()).toEqual({ kind: "existing", draftId: ID2, status: "saved" });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it("created: origin chat, instruction_by assistant, uses_private_refs as passed, the instruction, generating; one job", async () => {
    const r = await chat({ usesPrivateRefs: true });
    expect(r).toMatchObject({ kind: "created", status: "generating" });
    const id = (r as { draftId: string }).draftId;
    expect(rowOf(env.db, id)).toMatchObject({
      origin: "chat", instruction_by: "assistant", uses_private_refs: true, instruction: INSTRUCTION, kind: "reply", status: "generating",
      generation_seq: 1, thread_id: THREAD, parent_message_id: PARENT, account_id: HIS, reply_mode: "reply", body_html: null
    });
    expect(rowOf(env.db, id).to_recipients).toEqual([{ address: CLIENT, name: "Client" }]);
    expect(rowOf(env.db, id).cc_recipients).toEqual([]);
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.draft-generate", payload: { draftId: id, seq: 1 } });
    env = chatEnv();
    const off = await chat({ usesPrivateRefs: false, instruction: "   Short.   " });
    expect(rowOf(env.db, (off as { draftId: string }).draftId)).toMatchObject({ uses_private_refs: false, instruction: "Short.", instruction_by: "assistant" });
  });

  it("security-2: the row is linked to the answer that asked (chat_message_id); a malformed id is refused before any write", async () => {
    const MSG = `ecm_${"e".repeat(32)}`;
    const r = await chat({ chatMessageId: MSG });
    expect(rowOf(env.db, (r as { draftId: string }).draftId)).toMatchObject({ origin: "chat", chat_message_id: MSG });
    env = chatEnv();
    const unlinked = await chat();
    expect(rowOf(env.db, (unlinked as { draftId: string }).draftId)).toMatchObject({ chat_message_id: null });
    env = chatEnv();
    await expect(chat({ chatMessageId: "msg_1" })).rejects.toThrow(/chat message id is malformed/);
    expect(env.db.tables.exec_drafts).toHaveLength(0);
  });

  it("the insert carries the identical key set a web create sends (rule 11)", async () => {
    await chat();
    const chatKeys = Object.keys(draftInserts()[0].payload as Row).sort();
    env = setupDraftEnv();
    expect((await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true, instruction: "say thanks" }))).status).toBe(201);
    const webKeys = Object.keys(draftInserts()[0].payload as Row).sort();
    expect(chatKeys).toEqual(webKeys);
    expect(chatKeys).toContain("instruction_by");
    expect(chatKeys).toContain("uses_private_refs");
    expect(chatKeys).toContain("origin");
  });

  it("writes draft.create and draft.generate.request, with ids and codes only (keys within AUDIT_INPUT_KEYS)", async () => {
    const r = (await chat()) as { draftId: string };
    const calls = vi.mocked(auditEvent).mock.calls.map((c) => c[1]);
    expect(calls.map((e) => e.action)).toEqual(["draft.create", "draft.generate.request"]);
    for (const e of calls) {
      expect(e).toMatchObject({ actor: "owner", target: `exec_drafts:${r.draftId}` });
      expect(e.input).toEqual({ draftId: r.draftId, threadId: THREAD, accountId: HIS, kind: "reply", origin: "chat" });
      for (const k of Object.keys(e.input as Record<string, unknown>)) expect(AUDIT_INPUT_KEYS).toContain(k);
      expect(JSON.stringify(e)).not.toContain("Thursday");
    }
  });

  it("an enqueue failure → unavailable, the attempt closed as T06 (generation_failed, stale)", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs down"));
    expect(await chat()).toEqual({ kind: "refused", reason: "unavailable" });
    expect(env.db.tables.exec_drafts[0]).toMatchObject({ status: "generation_failed", generation_error: "stale", origin: "chat", instruction_by: "assistant" });
  });

  it("chat and web share one generation limit: a chat generation counts toward the web's 20", async () => {
    const audit = generationRows(19);
    env = chatEnv({ audit });
    let n = 100;
    vi.mocked(auditEvent).mockImplementation(async (p, e) => {
      env.db.tables.exec_audit_log.push({ id: (n += 1), principal_id: p?.id ?? null, action: e.action, created_at: new Date().toISOString() });
    });
    expect((await chat()).kind).toBe("created");
    const res = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: "t2", generate: true }));
    expect(res.status).toBe(429);
    expect((await bodyOf(res)).error).toBe("rate_limited");
  });

  it("a malformed input is a caller's bug: NonRetryableError, nothing read", async () => {
    await expect(chat({ instruction: "x".repeat(2_001) })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(createChatReplyDraft(PRINCIPAL, { threadId: THREAD, instruction: INSTRUCTION, usesPrivateRefs: "yes" as unknown as boolean })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(createChatReplyDraft(PRINCIPAL, { threadId: 7 as unknown as string, instruction: INSTRUCTION, usesPrivateRefs: false })).rejects.toBeInstanceOf(NonRetryableError);
    expect(vi.mocked(loadScreeningPolicy)).not.toHaveBeenCalled();
    expect(env.db.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TF3 Save asks for the second confirmation (F3)
// ---------------------------------------------------------------------------

describe("TF3 Save: confirmPrivate on a draft that uses private refs (R7, C45)", () => {
  const save = (body: Record<string, unknown>) => saveRoute.POST(jsonRequest("POST", `${P()}/save`, body), ctx());
  const okCreate = () => ({ status: 201, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A }) });
  const chatRow = (over: Row = {}) => draftRow({ origin: "chat", instruction_by: "assistant", uses_private_refs: true, ...over });

  it("without confirmPrivate → 409 private_refs_unconfirmed: no audit row, no CAS, no clone call", async () => {
    env = chatEnv({ rows: [chatRow()] });
    const res = await save({ version: 1 });
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "private_refs_unconfirmed" });
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
    expect(env.db.log).not.toContain("update exec_drafts");
    expect(env.fake.of("create_reply")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", version: 1 });
  });

  it("with confirmPrivate: true → it proceeds and saves", async () => {
    env = chatEnv({ rows: [chatRow()] });
    env.fake.answer("create_reply", okCreate());
    const res = await save({ version: 1, confirmPrivate: true });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ status: "saved" });
    expect(rowOf(env.db)).toMatchObject({ status: "saved", uses_private_refs: true });
  });

  it("a web draft never needs it; confirmPrivate on one is accepted and changes nothing", async () => {
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.answer("create_reply", okCreate());
    expect((await save({ version: 1 })).status).toBe(200);
    env = setupDraftEnv({ rows: [draftRow()] });
    env.fake.answer("create_reply", okCreate());
    expect((await save({ version: 1, confirmPrivate: true })).status).toBe(200);
  });

  it("SaveBody still rejects unknown keys, and confirmPrivate is true or absent only", async () => {
    expect(SaveBody.safeParse({ version: 1, confirmPrivate: true }).success).toBe(true);
    expect(SaveBody.safeParse({ version: 1 }).success).toBe(true);
    expect(SaveBody.safeParse({ version: 1, confirmPrivate: false }).success).toBe(false);
    expect(SaveBody.safeParse({ version: 1, usesPrivateRefs: false }).success).toBe(false);
    expect(SaveBody.safeParse({ version: 1, instructionBy: "owner" }).success).toBe(false);
    env = chatEnv({ rows: [chatRow()] });
    const res = await save({ version: 1, confirmPrivate: true, origin: "web" });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("bad_request");
  });
});

// ---------------------------------------------------------------------------
// TF4 the private_refs review blocker (F4)
// ---------------------------------------------------------------------------

describe("TF4 private_refs at Review and Send (R9, R10, C45)", () => {
  const liveRead = () => ({ status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A }) });
  const review = () => reviewRoute.POST(jsonRequest("POST", `${P()}/review`, { version: 1 }), ctx());
  const send = (acks: string[]) => sendRoute.POST(jsonRequest("POST", `${P()}/send`, { reviewHash: HASH_A, acks }), ctx());
  const accepted: Cl2Reply = { status: 202, body: { graphId: GRAPH, status: "sent_pending_verification", internetMessageId: "<sent.1@outlook.com>" } };

  it("the review of a draft that uses private refs raises private_refs (last); a web draft's doesn't", async () => {
    env = chatEnv({ rows: [savedRow({ uses_private_refs: true, origin: "chat", instruction_by: "assistant" })] });
    env.fake.answer("get_draft", liveRead());
    const r = await bodyOf(await review());
    expect(r.blockers).toEqual(["private_refs"]);
    expect(rowOf(env.db).review_blockers).toEqual(["private_refs"]);
    env = setupDraftEnv({ rows: [savedRow()] });
    env.fake.answer("get_draft", liveRead());
    expect((await bodyOf(await review())).blockers).toEqual([]);
    expect(REVIEW_BLOCKERS[REVIEW_BLOCKERS.length - 1]).toBe("private_refs");
  });

  it("Send without the ack → 409 acks_missing naming it (no audit row, no send); with it → sent", async () => {
    const row = reviewedRow({ uses_private_refs: true, origin: "chat", instruction_by: "assistant", review_blockers: ["private_refs"] });
    env = chatEnv({ rows: [row] });
    const res = await send([]);
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "acks_missing", blockers: ["private_refs"] });
    expect(env.fake.of("send")).toHaveLength(0);
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
    env = chatEnv({ rows: [row] });
    env.fake.answer("send", accepted);
    expect((await send(["private_refs"])).status).toBe(202);
    expect(env.fake.of("send")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TF7 instruction_by (F7)
// ---------------------------------------------------------------------------

describe("TF7 instruction_by: who wrote the current instruction", () => {
  const regenerate = (body: Record<string, unknown>) => regenerateRoute.POST(jsonRequest("POST", `${P()}/regenerate`, body), ctx());
  const chatRow = (over: Row = {}) => draftRow({ origin: "chat", instruction_by: "assistant", instruction: "Assistant words.", uses_private_refs: true, ...over });

  it("R2 inserts owner; F1 inserts assistant", async () => {
    env = setupDraftEnv();
    const res = await listRoute.POST(jsonRequest("POST", "/api/exec/drafts", { kind: "reply", threadId: THREAD, generate: true, instruction: "say thanks" }));
    const { id } = await bodyOf(res);
    expect(rowOf(env.db, id as string)).toMatchObject({ instruction_by: "owner", origin: "web", uses_private_refs: false });
    env = chatEnv();
    const r = (await chat()) as { draftId: string };
    expect(rowOf(env.db, r.draftId)).toMatchObject({ instruction_by: "assistant", origin: "chat" });
  });

  it("R6 with an instruction (a string, or null to clear it) → owner; without one → unchanged", async () => {
    env = chatEnv({ rows: [chatRow()] });
    expect((await regenerate({ version: 1, instruction: "My own words." })).status).toBe(202);
    expect(rowOf(env.db)).toMatchObject({ instruction_by: "owner", instruction: "My own words.", status: "generating" });
    env = chatEnv({ rows: [chatRow()] });
    expect((await regenerate({ version: 1, instruction: null })).status).toBe(202);
    expect(rowOf(env.db)).toMatchObject({ instruction_by: "owner", instruction: null });
    env = chatEnv({ rows: [chatRow()] });
    expect((await regenerate({ version: 1 })).status).toBe(202);
    expect(rowOf(env.db)).toMatchObject({ instruction_by: "assistant", instruction: "Assistant words.", status: "generating" });
  });

  it("the view carries instructionBy and usesPrivateRefs, also on a restricted row", async () => {
    env = chatEnv({ rows: [chatRow()] });
    expect(await getDraftView(PRINCIPAL, ID1)).toMatchObject({ instructionBy: "assistant", usesPrivateRefs: true, instruction: "Assistant words." });
    env = chatEnv({ rows: [chatRow({ ...purged })] });
    expect(await getDraftView(PRINCIPAL, ID1)).toMatchObject({ restricted: true, instruction: null, instructionBy: "assistant", usesPrivateRefs: true });
  });

  it("T45 and T43 successors copy instruction_by with the instruction (and the private-refs flag with the text)", async () => {
    const MSG = `ecm_${"f".repeat(32)}`;
    const gone = savedRow({ origin: "chat", instruction_by: "assistant", instruction: "Assistant words.", uses_private_refs: true, status: "gone",
      gone_at: minutesAgo(3), gone_unconfirmed: true, terminal_at: minutesAgo(3), expires_at: minutesAgo(-100_000), chat_message_id: MSG });
    env = chatEnv({ rows: [gone] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    const copy = await bodyOf(await resolve({ action: "copy_to_new_draft", checkedOutlook: true }));
    expect(rowOf(env.db, copy.newDraftId as string)).toMatchObject({ instruction_by: "assistant", instruction: "Assistant words.", uses_private_refs: true, status: "draft" });
    // security-2: the successor is a web row no card names; the link to the answer travels with it, so the purge by id
    // (exec_chat_draft_ids_for_threads, then RPC 5) still reaches it.
    expect(rowOf(env.db, copy.newDraftId as string)).toMatchObject({ origin: "web", chat_message_id: MSG });

    const unknown = savedRow({ origin: "chat", instruction_by: "owner", instruction: "His words.", uses_private_refs: true, status: "unknown",
      send_attempt_key: `${ID1}:v1:send:nonce0123456789a`, send_started_at: minutesAgo(31), confirm_hash: HASH_A, sent_audit_id: 7 });
    env = chatEnv({ rows: [unknown] });
    env.fake.answer("get_draft", cl2Error(404, "not_found"));
    const next = await bodyOf(await resolve({ action: "not_sent_new_draft", checkedOutlook: true }));
    expect(rowOf(env.db, next.newDraftId as string)).toMatchObject({ instruction_by: "owner", instruction: "His words.", uses_private_refs: true });
  });

  it("draftFromDb maps instruction_by strictly; DRAFT_COLUMNS maps it", () => {
    const raw = draftRow();
    expect(DRAFT_COLUMNS.instructionBy).toBe("instruction_by");
    expect(draftFromDb(raw).instructionBy).toBe("owner");
    expect(draftFromDb({ ...raw, instruction_by: "assistant" }).instructionBy).toBe("assistant");
    expect(() => draftFromDb({ ...raw, instruction_by: "robot" })).toThrow(DraftStoreError);
    expect(() => draftFromDb({ ...raw, instruction_by: null })).toThrow(DraftStoreError);
    const { instruction_by: _gone, ...without } = raw;
    void _gone;
    expect(() => draftFromDb(without)).toThrow(DraftStoreError);
  });

  it("a P4 restricted purge leaves instruction_by (the instruction goes)", () => {
    const tables = { exec_drafts: [chatRow()] };
    expect(purgeRestrictedRows(tables, { p_principal: PRINCIPAL.id, p_thread_ids: [THREAD] }, new Date())).toBe(1);
    expect(tables.exec_drafts[0]).toMatchObject({ instruction: null, instruction_by: "assistant", restricted_purged: true });
  });
});

const resolve = (body: Record<string, unknown>, id = ID1) => resolveRoute.POST(jsonRequest("POST", `${P(id)}/resolve`, body), ctx(id));
const purged = {
  thread_subject: null, reply_candidates: null, thread_addresses: [], to_recipients: [], cc_recipients: [], bcc_recipients: [],
  subject: null, body_doc: null, body_html: null, body_text: null, instruction: null, note_for_mitchell: null, placeholders: [],
  review_recipients: null, restricted_purged: true, content_purged_at: minutesAgo(1)
};

describe("TF7 the store before P5b's migration: instruction_by missing, P4's drafts keep working", () => {
  /** A database without the column: every row lacks it, and a write naming it is refused as PostgREST does. */
  const legacyDb = (rows: Row[] = []) => {
    // Both of P5b's columns are missing there (instruction_by, and chat_message_id: security-2).
    const stripped = rows.map(({ instruction_by: _x, chat_message_id: _y, ...rest }) => (void _x, void _y, rest));
    const db = createFakeDraftsDb({
      tables: { exec_drafts: stripped },
      fail: (r) => {
        const body = r.payload as Row | null;
        if ((r.kind === "insert" || r.kind === "update") && body !== null && typeof body === "object") {
          const named = ["instruction_by", "chat_message_id"].find((c) => c in body);
          if (named) return { code: "PGRST204", message: `Could not find the '${named}' column of 'exec_drafts' in the schema cache` };
        }
        return null;
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    return db;
  };
  const newRow = (over: Partial<NewDraftRow> = {}): NewDraftRow => {
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = draftFromDb(draftRow());
    void _i; void _c; void _u;
    return { ...rest, ...over };
  };

  it("reads fall back to the legacy column list once and fill in 'owner'", async () => {
    const db = legacyDb([draftRow()]);
    const row = await getDraft(PRINCIPAL, ID1);
    expect(row).toMatchObject({ id: ID1, instructionBy: "owner" });
    const selects = db.requests.filter((r) => r.kind === "select");
    expect(selects).toHaveLength(2);
    expect(String(selects[0].columns)).toContain("instruction_by");
    expect(String(selects[1].columns)).not.toContain("instruction_by");
    expect((await listDrafts(PRINCIPAL, { view: "active" }, new Date())).rows.map((r) => r.instructionBy)).toEqual(["owner"]);
  });

  it("an owner insert and an owner CAS are retried without the column; an assistant insert can't be stored and throws", async () => {
    const db = legacyDb();
    const r = await insertDraft(PRINCIPAL, newRow({ threadId: "t9" }));
    expect(r.inserted).toBe(true);
    expect((r as { row: { instructionBy: string } }).row.instructionBy).toBe("owner");
    const inserts = db.requests.filter((q) => q.kind === "insert");
    expect(inserts).toHaveLength(2);
    expect("instruction_by" in (inserts[1].payload as Row)).toBe(false);
    const id = (r as { row: { id: string } }).row.id;
    expect(await casDraft(PRINCIPAL, id, { status: "draft", version: 1 }, { instruction_by: "owner", instruction: "x", version: 2 })).toBe(true);
    expect(db.tables.exec_drafts.find((x) => x.id === id)).toMatchObject({ version: 2, instruction: "x" });
    await expect(insertDraft(PRINCIPAL, newRow({ threadId: "t8", instructionBy: "assistant", origin: "chat" }))).rejects.toBeInstanceOf(DraftStoreError);
    expect(db.tables.exec_drafts.some((x) => x.thread_id === "t8")).toBe(false);
  });

  it("a database error that isn't the missing column still fails the read", async () => {
    const db = createFakeDraftsDb({ tables: { exec_drafts: [draftRow()] }, fail: (r) => (r.kind === "select" ? { code: "42703", message: "column exec_drafts.bogus does not exist" } : null) });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await expect(getDraft(PRINCIPAL, ID1)).rejects.toBeInstanceOf(DraftStoreError);
    expect(db.requests.filter((r) => r.kind === "select")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TF8 purgeDraftsByIds (F8)
// ---------------------------------------------------------------------------

describe("TF8 purgeDraftsByIds: RPC 5 by id, chat drafts only", () => {
  const idN = (n: number) => `ed_${n.toString(16).padStart(32, "0")}`;
  const useDb = (cfg: Parameters<typeof createFakeDraftsDb>[0] = {}) => {
    const db = createFakeDraftsDb(cfg);
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    return db;
  };
  const rpcs = (db: ReturnType<typeof createFakeDraftsDb>) => db.requests.filter((r) => r.kind === "rpc");

  it("an empty list → 0 without a call; ids are checked and de-duplicated before any call", async () => {
    const db = useDb();
    expect(await purgeDraftsByIds(PRINCIPAL, [])).toBe(0);
    expect(db.requests).toHaveLength(0);
    await expect(purgeDraftsByIds(PRINCIPAL, ["ed_1"])).rejects.toBeInstanceOf(NonRetryableError);
    await expect(purgeDraftsByIds(PRINCIPAL, [idN(1), "not-an-id"])).rejects.toBeInstanceOf(NonRetryableError);
    expect(db.requests).toHaveLength(0);
    await purgeDraftsByIds(PRINCIPAL, [idN(1), idN(1), idN(2)]);
    expect((rpcs(db)[0].payload as Row).p_draft_ids).toEqual([idN(1), idN(2)]);
  });

  it("chunks of 200, summed; the principal goes with every chunk", async () => {
    const db = useDb();
    const ids = Array.from({ length: 450 }, (_, i) => idN(i + 1));
    expect(await purgeDraftsByIds(PRINCIPAL, ids)).toBe(0);
    expect(rpcs(db).map((r) => r.target)).toEqual(["exec_drafts_purge_by_ids", "exec_drafts_purge_by_ids", "exec_drafts_purge_by_ids"]);
    expect(rpcs(db).map((r) => ((r.payload as Row).p_draft_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(rpcs(db).every((r) => (r.payload as Row).p_principal === PRINCIPAL.id)).toBe(true);
    expect(((rpcs(db)[2].payload as Row).p_draft_ids as string[])[49]).toBe(idN(450));
  });

  it("not installed: PGRST202 or 42883 → null; any other error throws (retryable); a non-count answer throws", async () => {
    useDb({ missing: ["exec_drafts_purge_by_ids"] });
    expect(await purgeDraftsByIds(PRINCIPAL, [idN(1)])).toBeNull();
    useDb({ fail: () => ({ code: "42883", message: "function public.exec_drafts_purge_by_ids(text, text[]) does not exist" }) });
    expect(await purgeDraftsByIds(PRINCIPAL, [idN(1)])).toBeNull();
    useDb({ fail: () => ({ code: "57014", message: "canceling statement due to statement timeout" }) });
    const err = await purgeDraftsByIds(PRINCIPAL, [idN(1)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftStoreError);
    expect((err as DraftStoreError).errorClass).toBe("retryable");
    useDb({ fail: () => ({ code: "P0001", message: "exec_drafts_purge_by_ids: at most 200 draft ids per call" }) });
    await expect(purgeDraftsByIds(PRINCIPAL, [idN(1)])).rejects.toBeInstanceOf(DraftStoreError);
    const odd = useDb();
    odd.client = { rpc: () => ({ abortSignal() { return this; }, then: (f: (v: unknown) => unknown) => Promise.resolve({ data: "3", error: null }).then(f) }) };
    vi.mocked(getSupabaseAdmin).mockReturnValue(odd.client as SupabaseClient);
    await expect(purgeDraftsByIds(PRINCIPAL, [idN(1)])).rejects.toBeInstanceOf(DraftStoreError);
  });

  it("on the RPC's mirror: his chat drafts get P4's C12 purge plus chat_source_restricted; web rows, others' rows and purged rows aren't touched", async () => {
    const base = (n: number, over: Row = {}): Row => ({
      ...draftDefaults(new Date()), id: idN(n), principal_id: PRINCIPAL.id, account_id: HIS, kind: "reply", status: "draft", thread_id: `t${n}`,
      parent_message_id: "m1", reply_mode: "reply", thread_subject: "Subject", to_recipients: [{ address: CLIENT, name: null }], body_text: "Hi",
      body_html: "<p>Hi</p>", instruction: "Assistant words.", render_nonce: "abcdefabcdefabcdef012345", origin: "chat", instruction_by: "assistant", ...over
    });
    const db = useDb({
      tables: {
        exec_drafts: [
          base(1),
          base(2, { status: "saved", saved_version: 1, outlook_graph_id: GRAPH, content_hash: HASH_A }),
          base(3, { origin: "web", instruction_by: "owner" }),
          base(4, { principal_id: "ep_other" })
        ]
      }
    });
    expect(await purgeDraftsByIds(PRINCIPAL, [idN(1), idN(2), idN(3), idN(4)])).toBe(2);
    const [dd, linked, web, foreign] = db.tables.exec_drafts;
    expect(dd).toMatchObject({ status: "discarded", restricted_purged: true, instruction: null, body_html: null, to_recipients: [], last_error_code: "chat_source_restricted", version: 2, instruction_by: "assistant" });
    expect(dd.terminal_at).not.toBeNull();
    expect(linked).toMatchObject({ status: "saved", restricted_purged: true, outlook_graph_id: GRAPH, last_error_code: "chat_source_restricted" });
    expect(web).toMatchObject({ restricted_purged: false, instruction: "Assistant words.", last_error_code: null });
    expect(foreign).toMatchObject({ restricted_purged: false, instruction: "Assistant words." });
    expect(await purgeDraftsByIds(PRINCIPAL, [idN(1), idN(2)])).toBe(0);
    expect(() => purgeRowsByIds(db.tables, { p_principal: PRINCIPAL.id, p_draft_ids: Array.from({ length: 201 }, (_, i) => idN(i)) }, new Date())).toThrow(/at most 200/);
  });
});
