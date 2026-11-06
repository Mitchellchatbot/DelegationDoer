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

import * as openedRoute from "@/app/api/exec/drafts/[id]/outlook-opened/route";
import * as saveRoute from "@/app/api/exec/drafts/[id]/save/route";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { draftReconcileJobHandler, draftReconcileKick, draftReconcileScheduledWork, runDraftReconcile } from "@/lib/exec/handlers/draft-reconcile";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { AuditUnavailableError } from "@/lib/exec/types";
import { cl2Error, readBackFixture } from "../__tests__/fake-clone";
import type { Row } from "../__tests__/fake-drafts-db";
import {
  CLIENT,
  GRAPH,
  HASH_A,
  HASH_C,
  HIS,
  ID1,
  PARENT,
  PRINCIPAL,
  bodyOf,
  draftRow,
  jsonRequest,
  minutesAgo,
  policyOf,
  rowOf,
  rule,
  savedRow,
  settingsOn,
  setupDraftEnv,
  type DraftEnv
} from "../__tests__/drafts-harness";

// The draft reconcile sweep (P4 contract §3.11, C14-C18, C41, C67-C69; §5.8
// SW01-SW11): claims, one audited same-key replay per run, the per-status GET
// mirror, the schedules, the budget, never /send.

const ENV = { ...process.env };
let env: DraftEnv;
const MIN = 60_000;
const SAVE_KEY = `${ID1}:v1:save:abcdefghijklmnop`;
const SEND_KEY = `${ID1}:v1:send:abcdefghijklmnop`;
const idN = (n: number) => `ed_${n.toString(16).padStart(32, "0")}`;
const run = (now?: () => Date) => runDraftReconcile({ principal: PRINCIPAL, signal: new AbortController().signal, ...(now ? { now } : {}) });
const at = (offsetMs: number) => () => new Date(Date.now() + offsetMs);
const live = (over: Record<string, unknown> = {}) => ({ status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A, ...over }) });
const due = (over: Row = {}): Row => ({ next_check_at: minutesAgo(1), ...over });
const savingCreate = (over: Row = {}) => draftRow(due({
  status: "saving", save_attempt_key: SAVE_KEY, save_version: 1, save_timezone: "America/Chicago", save_started_at: minutesAgo(7), ...over
}));
const savingRecreate = (over: Row = {}) => savingCreate({
  version: 2, saved_version: 1, save_version: 2, save_attempt_key: `${ID1}:v2:save:abcdefghijklmnop`, outlook_graph_id: GRAPH,
  content_hash: HASH_A, observed_content_hash: HASH_A, save_if_content_hash: HASH_A, ...over
});
const sending = (over: Row = {}) => savedRow(due({ status: "sending", send_attempt_key: SEND_KEY, send_started_at: minutesAgo(4), confirm_hash: HASH_A, sent_audit_id: 77, ...over }));
const sentPending = (over: Row = {}) => savedRow(due({ status: "sent_pending", send_attempt_key: SEND_KEY, send_started_at: minutesAgo(3), send_accepted_at: minutesAgo(3), confirm_hash: HASH_A, ...over }));
const unknownRow = (over: Row = {}) => savedRow(due({ status: "unknown", send_attempt_key: SEND_KEY, send_started_at: minutesAgo(10), confirm_hash: HASH_A, ...over }));
const goneRow = (goneMinutesAgo: number, over: Row = {}) => savedRow(due({
  status: "gone", gone_unconfirmed: true, gone_at: minutesAgo(goneMinutesAgo), terminal_at: minutesAgo(goneMinutesAgo), expires_at: minutesAgo(-100_000), ...over
}));
const discarding = (over: Row = {}) => savedRow(due({ status: "discarding", prior_status: "saved", discard_attempt_key: `${ID1}:g0123456789abcdef:delete:abcdefghijklmnop`, discard_started_at: minutesAgo(7), ...over }));
const nextMs = (r: Row) => Date.parse(String(r.next_check_at));

beforeEach(() => {
  env = setupDraftEnv();
  env.fake.defaultAnswer("send", () => {
    throw new Error("the sweep called /send");
  });
});
afterEach(() => {
  expect(env.fake.of("send")).toHaveLength(0); // SW04: never /send, whatever the test
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ENV };
});

describe("SW01 the schedule's `when`", () => {
  it("false with no due rows, true with one; the schedule is interval 5 on the bulk lane, 2 attempts, gated on the schema", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    expect(await draftReconcileScheduledWork.when?.(PRINCIPAL, settingsOn(), new Date())).toBe(false);
    env = setupDraftEnv({ rows: [sending()] });
    expect(await draftReconcileScheduledWork.when?.(PRINCIPAL, settingsOn(), new Date())).toBe(true);
    expect(draftReconcileScheduledWork).toMatchObject({ kind: "exec.draft-reconcile", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 2 });
    expect(draftReconcileScheduledWork.enabled?.(settingsOn({ draftsSchemaReady: false }))).toBe(false);
    expect(draftReconcileJobHandler).toMatchObject({ kind: "exec.draft-reconcile", lane: "bulk", timeoutMs: 240_000 });
  });
});

describe("SW02 the per-status dispatch", () => {
  it("generating, stale (T09): a first generation fails as stale; a regenerate returns to its prior status", async () => {
    env = setupDraftEnv({ rows: [draftRow(due({ status: "generating", generation_seq: 1, body_doc: null, body_html: null, body_text: null }))] });
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "generation_failed", generation_error: "stale", next_check_at: null });
    env = setupDraftEnv({ rows: [savedRow(due({ status: "generating", prior_status: "saved", generation_seq: 2 }))] });
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "saved", last_error_code: "generation_stale", body_text: "Thanks, we're on it." });
  });
  it("saving create: a same-key replay of the stored body and timezone, audited first; 201 → saved", async () => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.answer("create_reply", live());
    await run();
    const req = env.fake.of("create_reply")[0];
    expect(req.idempotencyKey).toBe(SAVE_KEY);
    expect(req.json).toEqual({ parentMessageId: PARENT, to: [{ address: CLIENT, name: "Client" }], cc: [], bodyHtml: "<p>Thanks, we're on it.</p>", timezone: "America/Chicago" });
    expect(vi.mocked(auditStart).mock.calls[0][1]).toMatchObject({ actor: "job", action: "draft.save", input: { draftId: ID1, version: 1, replay: true } });
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: GRAPH, content_hash: HASH_A, saved_version: 1 });
  });
  it("saving recreate: a same-key replay with the stored body and save_if_content_hash", async () => {
    env = setupDraftEnv({ rows: [savingRecreate()] });
    env.fake.answer("recreate", live({ graphId: "AAMkNew=", replaces: GRAPH, contentHash: HASH_C }));
    await run();
    const req = env.fake.of("recreate")[0];
    expect(req.graphId).toBe(GRAPH);
    expect(req.idempotencyKey).toBe(`${ID1}:v2:save:abcdefghijklmnop`);
    expect(req.body).toBe(JSON.stringify({ to: [{ address: CLIENT, name: "Client" }], cc: [], bodyHtml: "<p>Thanks, we're on it.</p>", timezone: "America/Chicago", ifContentHash: HASH_A }));
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: "AAMkNew=", content_hash: HASH_C, saved_version: 2 });
  });
  it.each([
    ["deleted", cl2Error(404, "gone", { draftStatus: "deleted" }), { status: "discarded", prior_status: null }],
    ["gone", cl2Error(404, "gone", { draftStatus: "gone" }), { status: "gone", gone_unconfirmed: true }],
    ["saved", live(), { status: "saved", prior_status: null }]
  ])("discarding, stale (T40): %s", async (_n, answer, expected) => {
    env = setupDraftEnv({ rows: [discarding()] });
    env.fake.answer("get_draft", answer);
    await run();
    expect(rowOf(env.db)).toMatchObject(expected);
  });
  it("sending, stale (T32): clone saved without the flag → saved (C15); with send_status_unknown → unknown; the crashed send's audit row is finished (SW06)", async () => {
    env = setupDraftEnv({ rows: [sending({ review_hash: HASH_A, review_at: minutesAgo(5) })] });
    env.fake.answer("get_draft", live({ flags: [] }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "saved", review_hash: null });
    expect(vi.mocked(auditFinish).mock.calls[0]).toEqual([77, { ok: false, result: { outcome: "saved", code: null }, error: "other" }]);
    env = setupDraftEnv({ rows: [sending()] });
    env.fake.answer("get_draft", live({ flags: ["send_status_unknown"] }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", clone_flags: ["send_status_unknown"] });
    env = setupDraftEnv({ rows: [sending()] });
    env.fake.answer("get_draft", live({ status: "sent_pending_verification" }));
    await run();
    expect(rowOf(env.db).status).toBe("sent_pending");
    expect(vi.mocked(auditFinish).mock.calls[0]).toEqual([77, { ok: true, result: { outcome: "sent_pending", code: null }, error: undefined }]);
  });
  it.each([
    ["sent", live({ status: "sent", sentAt: "2026-11-05T12:30:00Z" }), { status: "sent", sent_mismatch: false, unverified: false }],
    ["sent_mismatch", live({ status: "sent_mismatch" }), { status: "sent", sent_mismatch: true }],
    ["sent, unverified", live({ status: "sent", flags: ["unverified"] }), { status: "sent", unverified: true }]
  ])("sent_pending (T33): %s", async (_n, answer, expected) => {
    env = setupDraftEnv({ rows: [sentPending()] });
    env.fake.answer("get_draft", answer);
    await run();
    expect(rowOf(env.db)).toMatchObject(expected);
  });
  it("sent_pending for 24 h → sent + unverified + verify_overdue with no GET (C16)", async () => {
    env = setupDraftEnv({ rows: [sentPending({ send_accepted_at: minutesAgo(24 * 60 + 1), send_started_at: minutesAgo(24 * 60 + 2) })] });
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "sent", unverified: true, clone_flags: ["verify_overdue"] });
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
  it("unknown (T34): mirrored; past 24 h the next check is 6 h out (C68)", async () => {
    env = setupDraftEnv({ rows: [unknownRow()] });
    env.fake.answer("get_draft", live({ status: "unknown", flags: ["send_status_unknown"] }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "unknown", clone_flags: ["send_status_unknown"], check_count: 1 });
    env = setupDraftEnv({ rows: [unknownRow({ send_started_at: minutesAgo(25 * 60) })] });
    env.fake.answer("get_draft", live({ status: "unknown" }));
    const before = Date.now();
    await run();
    expect(nextMs(rowOf(env.db)) - before).toBeGreaterThanOrEqual(6 * 60 * MIN - 1_000);
    expect(nextMs(rowOf(env.db)) - before).toBeLessThanOrEqual(6 * 60 * MIN + 5_000);
  });
  it("gone unconfirmed (T35): +2 / +6 / +16 min, confirmed only by a successful GET at +16; a failed final check → +5 min, still unconfirmed", async () => {
    env = setupDraftEnv({ rows: [goneRow(2)] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    await run();
    const goneAt = Date.parse(String(rowOf(env.db).gone_at));
    expect(rowOf(env.db).gone_unconfirmed).toBe(true);
    expect(nextMs(rowOf(env.db)) - goneAt).toBe(6 * MIN);
    env = setupDraftEnv({ rows: [goneRow(16.5)] });
    env.fake.answer("get_draft", cl2Error(502, "graph_error"));
    const before = Date.now();
    await run();
    expect(rowOf(env.db).gone_unconfirmed).toBe(true);
    expect(nextMs(rowOf(env.db)) - before).toBeGreaterThanOrEqual(5 * MIN - 1_000);
    env = setupDraftEnv({ rows: [goneRow(16.5)] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ gone_unconfirmed: false, next_check_at: null, status: "gone" });
  });
  it("the idle linked check (C41): saved, unknown and gone + unconfirmed rows due now get one GET (observed only)", async () => {
    env = setupDraftEnv({ rows: [savedRow(due())] });
    env.fake.answer("get_draft", live({ contentHash: HASH_C }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "saved", content_hash: HASH_A, observed_content_hash: HASH_C, next_check_at: null });
    env = setupDraftEnv({ rows: [unknownRow({ send_started_at: minutesAgo(20 * 24 * 60) })] });
    env.fake.answer("get_draft", live({ status: "unknown" }));
    await run();
    expect(env.fake.of("get_draft")).toHaveLength(1);
    expect(rowOf(env.db).next_check_at).toBeNull();
    env = setupDraftEnv({ rows: [goneRow(31 * 24 * 60)] });
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "gone" }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ gone_unconfirmed: false });
  });
});

describe("SW03 readiness down", () => {
  it("clone rows move +5 min with no clone call; generating rows are still handled", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    env = setupDraftEnv({ rows: [sending(), draftRow(due({ id: idN(9), thread_id: "t9", status: "generating", generation_seq: 1, body_doc: null, body_html: null, body_text: null }))] });
    delete process.env.MISSIVE_EA_TOKEN;
    const before = Date.now();
    await run();
    expect(rowOf(env.db).status).toBe("sending");
    expect(nextMs(rowOf(env.db)) - before).toBeGreaterThanOrEqual(5 * MIN - 1_000);
    expect(rowOf(env.db, idN(9)).status).toBe("generation_failed");
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
  it("a save unresolved 24 h after it started gives up (T52) even while readiness is down (data-6); a younger one waits", async () => {
    env = setupDraftEnv({ rows: [savingCreate({ save_started_at: minutesAgo(24 * 60 + 5) }), savingCreate({ id: idN(8), thread_id: "t8", save_started_at: minutesAgo(30) })] });
    delete process.env.MISSIVE_EA_TOKEN;
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "draft", last_error_code: "outlook_unknown" });
    expect(rowOf(env.db, idN(8)).status).toBe("saving");
    expect(env.fake.requests.filter((r) => r.route !== "status" && r.route !== "auth_me" && r.route !== "other")).toHaveLength(0);
  });
});

describe("SW05 the follow-up kick", () => {
  it("one kick for the earliest row due within 5 min: interactive, maxAttempts 1, tag t<floor(dueMs / 10 000)>", async () => {
    env = setupDraftEnv({ rows: [sentPending()] });
    env.fake.answer("get_draft", live({ status: "sent_pending_verification" }));
    const out = await run();
    expect(out.kicked).toBe(true);
    const kick = vi.mocked(enqueueJob).mock.calls[0][0];
    const dueMs = nextMs(rowOf(env.db));
    expect(kick).toMatchObject({ kind: "exec.draft-reconcile", lane: "interactive", maxAttempts: 1, payload: { kick: true }, dedupeKey: `draft-recon:${PRINCIPAL.id}:t${Math.floor(dueMs / 10_000)}` });
    expect(draftReconcileKick(PRINCIPAL, new Date(), "a0123456789abcdef").dedupeKey).toBe(`draft-recon:${PRINCIPAL.id}:a0123456789abcdef`);
  });
});

describe("SW07 the run's bounds", () => {
  it("≤ 20 rows per run; check_count + 1 and next_check_at recomputed on each", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => savedRow(due({ id: idN(i + 1), thread_id: `t${i + 1}`, next_check_at: minutesAgo(30 - i) })));
    env = setupDraftEnv({ rows });
    env.fake.defaultAnswer("get_draft", live());
    const out = await run();
    expect(out.checked).toBe(20);
    expect(env.fake.of("get_draft")).toHaveLength(20);
    const checked = env.db.tables.exec_drafts.filter((r) => r.check_count === 1);
    expect(checked).toHaveLength(20);
    for (const r of checked) expect(r.next_check_at).toBeNull();
  });
  it("the budget: no row starts after 170 s, the rest stay due, and the run ends well inside 240 s", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => savedRow(due({ id: idN(i + 1), thread_id: `t${i + 1}`, next_check_at: minutesAgo(30 - i) })));
    env = setupDraftEnv({ rows });
    env.fake.defaultAnswer("get_draft", live());
    const t0 = Date.now();
    let calls = 0;
    const clock = () => new Date(t0 + (calls++) * 10_000);
    const out = await run(clock);
    const started = env.db.tables.exec_drafts.filter((r) => r.check_count === 1).length;
    expect(started).toBeLessThan(10);
    expect(out.checked).toBe(started);
    for (const r of env.db.tables.exec_drafts.filter((x) => x.check_count === 0)) expect(nextMs(r)).toBeLessThan(t0);
    expect((calls - 1) * 10_000).toBeLessThan(240_000);
  });
  it("at most one replay per run, and none started after 60 s (the row is left due)", async () => {
    const second = savingCreate({ id: idN(9), thread_id: "t9", save_attempt_key: `${idN(9)}:v1:save:abcdefghijklmnop` });
    env = setupDraftEnv({ rows: [savingCreate(), second] });
    env.fake.defaultAnswer("create_reply", live());
    await run();
    expect(env.fake.of("create_reply")).toHaveLength(1);
    expect(env.db.tables.exec_drafts.filter((r) => r.status === "saving")).toHaveLength(1);
    const left = env.db.tables.exec_drafts.find((r) => r.status === "saving") as Row;
    expect(nextMs(left)).toBeLessThan(Date.now());
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.defaultAnswer("create_reply", live());
    const t0 = Date.now();
    let first = true;
    await run(() => {
      const t = first ? t0 : t0 + 61_000;
      first = false;
      return new Date(t);
    });
    expect(env.fake.of("create_reply")).toHaveLength(0);
    expect(rowOf(env.db).status).toBe("saving");
  });
});

describe("SW08 claims (C67 (1))", () => {
  it("two overlapping runs on one stale create → exactly one replay request, and the row ends linked", async () => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.defaultAnswer("create_reply", live());
    await Promise.all([run(), run()]);
    expect(env.fake.of("create_reply")).toHaveLength(1);
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: GRAPH });
  });
  it("a row whose next_check_at moved between the list and the claim is skipped", async () => {
    let moved = false;
    env = setupDraftEnv({
      rows: [sending()],
      db: { before: (r, db) => {
        if (!moved && r.kind === "update" && r.target === "exec_drafts") {
          moved = true;
          db.tables.exec_drafts[0].next_check_at = minutesAgo(-3);
        }
      } }
    });
    const out = await run();
    expect(out).toMatchObject({ checked: 0, skipped: 1 });
    expect(env.fake.of("get_draft")).toHaveLength(0);
  });
});

describe("SW09 replay answers (C67 (3))", () => {
  it.each([
    ["429 in progress", cl2Error(429, "throttled", {}, { "retry-after": "2" })],
    ["503", cl2Error(503, "not_ready")],
    ["500", cl2Error(500, "server_error")],
    ["401", cl2Error(401, "invalid_token")]
  ])("%s → stays saving (never draft), next +5 min", async (_n, answer) => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.answer("create_reply", answer);
    const before = Date.now();
    await run();
    expect(rowOf(env.db).status).toBe("saving");
    expect(nextMs(rowOf(env.db)) - before).toBeGreaterThanOrEqual(5 * MIN - 1_000);
  });
  it("no answer within 150 s → stays saving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.dropResponse.add("create_reply");
    env.fake.answer("create_reply", live());
    const p = run();
    await vi.advanceTimersByTimeAsync(151_000);
    await p;
    expect(rowOf(env.db)).toMatchObject({ status: "saving", last_error_code: "outcome_unknown" });
  });
  it("a definitive 400 → draft with the code; unresolved 24 h after save_started_at → T52 outlook_unknown", async () => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    env.fake.answer("create_reply", cl2Error(400, "bad_request", { detail: "bodyHtml" }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "draft", last_error_code: "bad_request" });
    env = setupDraftEnv({ rows: [savingCreate({ save_started_at: minutesAgo(24 * 60 + 5) })] });
    env.fake.answer("create_reply", cl2Error(503, "not_ready"));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "draft", last_error_code: "outlook_unknown" });
  });
  it("a replay that ran long skips the post-replay GET when a whole GET no longer fits the run (data-5): stays saving, the next replay reads the stored 2xx", async () => {
    let t = Date.now();
    env = setupDraftEnv({ rows: [savingRecreate()] });
    env.fake.answer("recreate", () => {
      t += 200_000; // the replay answered 200 s into the run
      return { ...live({ graphId: "AAMkNew=", contentHash: HASH_C }), headers: { "idempotent-replay": "true" } };
    });
    env.fake.defaultAnswer("get_draft", live({ graphId: "AAMkNew=", contentHash: HASH_C }));
    await run(() => new Date(t));
    expect(env.fake.of("recreate")).toHaveLength(1);
    expect(env.fake.of("get_draft")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ status: "saving", last_error_code: "outcome_unknown" });
    // With room for the GET, the same stored 2xx links the new draft.
    t = Date.now();
    env = setupDraftEnv({ rows: [savingRecreate()] });
    env.fake.answer("recreate", { ...live({ graphId: "AAMkNew=", contentHash: HASH_C }), headers: { "idempotent-replay": "true" } });
    env.fake.defaultAnswer("get_draft", live({ graphId: "AAMkNew=", contentHash: HASH_C }));
    await run(() => new Date(t));
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: "AAMkNew=", saved_version: 2 });
  });
  it("a replay answered 404 deleted + replacedBy follows the replacement as a stale link (data-3): an earlier attempt's draft is never saved at this version", async () => {
    env = setupDraftEnv({ rows: [savingRecreate()] });
    env.fake.answer("recreate", cl2Error(404, "gone", { draftStatus: "deleted", replacedBy: "AAMkNew=" }));
    env.fake.defaultAnswer("get_draft", live({ graphId: "AAMkNew=", contentHash: HASH_C }));
    await run();
    expect(env.fake.of("get_draft").map((r) => r.graphId)).toEqual(["AAMkNew="]);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: "AAMkNew=", saved_version: 1, version: 2, content_hash: HASH_A, observed_content_hash: HASH_C });
  });
});

describe("SW10 replay safety", () => {
  it("the audit row precedes the replay; an audit outage skips the row with no clone call", async () => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    await run();
    expect(env.fake.of("create_reply")).toHaveLength(0);
    expect(rowOf(env.db).status).toBe("saving");
  });
  it("a purged create → T51 with no clone call; a purged recreate → the GET resolution, no PATCH", async () => {
    const purged = { to_recipients: [], thread_subject: null, reply_candidates: null, thread_addresses: [], body_doc: null, body_html: null, body_text: null, restricted_purged: true };
    env = setupDraftEnv({ rows: [savingCreate(purged)] });
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "discarded", last_error_code: "outlook_unknown_restricted" });
    expect(env.fake.requests.filter((r) => r.route === "create_reply" || r.route === "get_draft")).toHaveLength(0);
    env = setupDraftEnv({ rows: [savingRecreate(purged)] });
    env.fake.answer("get_draft", live());
    await run();
    expect(env.fake.of("recreate")).toHaveLength(0);
    expect(env.fake.of("get_draft")).toHaveLength(1);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: GRAPH });
  });
  it("a recipient that turned restricted → T52 with no clone call", async () => {
    env = setupDraftEnv({ rows: [savingCreate()] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule(CLIENT, "exact")]));
    await run();
    expect(env.fake.of("create_reply")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", last_error_code: "outlook_unknown" });
  });
  it("T52 on a recreate resolves the old graphId by GET first (data-3): a replacement is linked stale, a draft still there keeps its link, no answer keeps the old link", async () => {
    // The replay is refused (a recipient turned restricted) after an earlier attempt replaced the draft.
    env = setupDraftEnv({ rows: [savingRecreate()] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule(CLIENT, "exact")]));
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "deleted", replacedBy: "AAMkNew=" }), live({ graphId: "AAMkNew=", contentHash: HASH_C }));
    await run();
    expect(env.fake.of("recreate")).toHaveLength(0);
    expect(env.fake.of("get_draft").map((r) => r.graphId)).toEqual([GRAPH, "AAMkNew="]);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: "AAMkNew=", saved_version: 1, content_hash: HASH_A, observed_content_hash: HASH_C });
    // The old draft is still there: T52 with the link kept.
    env = setupDraftEnv({ rows: [savingRecreate()] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule(CLIENT, "exact")]));
    env.fake.answer("get_draft", live({ contentHash: HASH_A }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: GRAPH, last_error_code: "outlook_unknown" });
    // Deleted with no replacement: the link is cleared.
    env = setupDraftEnv({ rows: [savingRecreate()] });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule(CLIENT, "exact")]));
    env.fake.answer("get_draft", cl2Error(404, "gone", { draftStatus: "deleted" }));
    await run();
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: null, last_error_code: "recreate_failed" });
    // 24 h unresolved with no GET answer: T52, the old link kept.
    env = setupDraftEnv({ rows: [savingRecreate({ save_started_at: minutesAgo(24 * 60 + 5) })] });
    env.fake.answer("recreate", cl2Error(503, "not_ready"));
    env.fake.defaultAnswer("get_draft", cl2Error(503, "not_ready"));
    await run();
    expect(env.fake.of("get_draft")).toHaveLength(1);
    expect(rowOf(env.db)).toMatchObject({ status: "draft", outlook_graph_id: GRAPH, last_error_code: "outlook_unknown" });
  });
  it("a lost PATCH response (clone-2): the replay gets the stored 200, GETs the new graphId and links it; no second create, no Save-again state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stale = draftRow({ version: 2, saved_version: 1, outlook_graph_id: GRAPH, internet_message_id: "<d@x>", content_hash: HASH_A, observed_content_hash: HASH_A });
    env = setupDraftEnv({ rows: [stale] });
    env.fake.dropResponse.add("recreate");
    env.fake.defaultAnswer("recreate", live({ graphId: "AAMkNew=", replaces: GRAPH, contentHash: HASH_C }));
    let res: Response | null = null;
    const p = saveRoute.POST(jsonRequest("POST", `/api/exec/drafts/${ID1}/save`, { version: 2 }), { params: { id: ID1 } }).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(341_000);
    await p;
    expect((res as unknown as Response).status).toBe(202);
    expect(rowOf(env.db).status).toBe("saving");
    vi.useRealTimers();
    env.fake.dropResponse.delete("recreate");
    env.fake.defaultAnswer("get_draft", live({ graphId: "AAMkNew=", contentHash: HASH_C }));
    await run(at(7 * MIN));
    const [first, replay] = env.fake.of("recreate");
    expect(replay.body).toBe(first.body);
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect(env.fake.of("get_draft").map((r) => r.graphId)).toEqual(["AAMkNew="]);
    expect(env.fake.requests.filter((r) => r.route === "create_reply" || r.route === "create_new")).toHaveLength(0);
    expect(rowOf(env.db)).toMatchObject({ status: "saved", outlook_graph_id: "AAMkNew=", content_hash: HASH_C, saved_version: 2 });
    expect(rowOf(env.db).last_error_code).not.toBe("recreate_failed");
  });
});

describe("SW11 Open in Outlook, then a send from Outlook (clone-8)", () => {
  it("due at +25 s; one kick's GET answering sent_external closes it", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    expect((await openedRoute.POST(jsonRequest("POST", `/api/exec/drafts/${ID1}/outlook-opened`, {}), { params: { id: ID1 } })).status).toBe(200);
    expect(await bodyOf(await openedRoute.POST(jsonRequest("POST", `/api/exec/drafts/${ID1}/outlook-opened`, "{\"x\":1}"), { params: { id: ID1 } }))).toEqual({ error: "bad_request" });
    env.fake.answer("get_draft", live({ status: "sent_external", isDraft: false }));
    await run(at(26_000));
    expect(rowOf(env.db).status).toBe("sent_external");
  });
  it("without a send: the follow-ups at +2 and +10 min run, then next_check_at is null", async () => {
    env = setupDraftEnv({ rows: [savedRow()] });
    await openedRoute.POST(jsonRequest("POST", `/api/exec/drafts/${ID1}/outlook-opened`, {}), { params: { id: ID1 } });
    const opened = Date.parse(String(rowOf(env.db).opened_in_outlook_at));
    env.fake.defaultAnswer("get_draft", live());
    await run(() => new Date(opened + 26_000));
    expect(nextMs(rowOf(env.db)) - opened).toBe(2 * MIN);
    await run(() => new Date(opened + 2 * MIN + 1_000));
    expect(nextMs(rowOf(env.db)) - opened).toBe(10 * MIN);
    await run(() => new Date(opened + 10 * MIN + 1_000));
    expect(rowOf(env.db).next_check_at).toBeNull();
    expect(env.fake.of("get_draft")).toHaveLength(3);
  });
});
