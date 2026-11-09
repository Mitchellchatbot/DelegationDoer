import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/brief-gather", () => ({ gatherBrief: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/brief-checkins", () => ({ selectCheckinRecipients: vi.fn(), generateCheckins: vi.fn() }));
vi.mock("@/lib/exec/brief-deliver", () => ({ checkinsMessageParts: vi.fn() }));
vi.mock("@/lib/exec/slack-install", () => ({ openActiveInstallation: vi.fn() }));
vi.mock("@/lib/exec/slack-dm", () => ({ dmUpdate: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ listPurgeLog: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/mail")>()), loadScreeningPolicy: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelState: vi.fn() }));

import gatherFixture from "@/lib/exec/__tests__/fixtures/brief-gather.json";
import validOut from "@/lib/exec/__tests__/fixtures/brief-model-output/valid.json";
import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole, resolveFixtureAliases } from "@/lib/exec/__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { parseEmailFingerprint } from "@/lib/exec/attention";
import { runBriefBuild, prettyLocalDate, type BuildRequest } from "@/lib/exec/brief-build";
import { generateCheckins, selectCheckinRecipients } from "@/lib/exec/brief-checkins";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { checkinsMessageParts } from "@/lib/exec/brief-deliver";
import { gatherBrief } from "@/lib/exec/brief-gather";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { assembleSections, gatherItems, type AssembleInput } from "@/lib/exec/brief-sections";
import { __resetBriefStoreForTests, claimBuild, getBriefByDate } from "@/lib/exec/brief-store";
import type { BriefContent, BriefGather, BriefOwnerReason, BriefOwner, NewCheckin } from "@/lib/exec/brief-types";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { notifyOps } from "@/lib/exec/ops";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import { dmUpdate } from "@/lib/exec/slack-dm";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { listPurgeLog } from "@/lib/exec/slack-reading";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import type { ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 contract §5.8 BB01-BB12, BB15-BB17 and §5.6 NV08-NV11 (M2-M4, M8, C5, C11, C12, C29, C34; intel-13, intel-16; Area C): the build
// pipeline over the standalone brief store fake (§5.19, whose RPCs mirror the migration), the model mocked at callModel, the
// gather, ownership, check-in, Slack and job modules mocked at their boundaries. The screen's reads are mocked too; the catch-up
// itself (brief-screen.ts) and the store run for real.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, briefEnabled: true, supersedeLegacyBrief: true, checkinsEnabled: true };
const DAY = "2026-11-06";
const SCHED = new Date("2026-11-06T13:00:00.000Z");   // 08:00 EST
const NOW = new Date("2026-11-06T13:05:00.000Z");
const CONTENT_EXP = "2026-12-07T05:00:00.000Z";
const ROW_EXP = "2027-05-06T04:00:00.000Z";

let db: FakeBriefDb;
let events: string[];
let verdict: { owner: BriefOwner; reason: BriefOwnerReason };
let consoleSpy: ReturnType<typeof captureConsole>;
let gatherHook: (() => void) | null;
let screenRows: Map<string, ThreadScreenRow>;
let purgeRows: { id: number; scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null; reason: string; createdAt: string }[];

function fixtureGather(): BriefGather {
  const raw = structuredClone(gatherFixture.input) as unknown as Omit<AssembleInput, "now" | "parseEmailFingerprint"> & { now: string };
  return assembleSections({ ...raw, now: new Date(raw.now), parseEmailFingerprint: (fp) => {
    const p = parseEmailFingerprint(fp);
    return p !== null && typeof p.threadId === "string" ? { threadId: p.threadId } : null;
  } } as AssembleInput);
}
const GATHER = fixtureGather();
const modelResult = (text = resolveFixtureAliases(validOut, GATHER)): CallModelResult =>
  ({ message: { content: [{ type: "text", text }] } as unknown as CallModelResult["message"], refused: false, truncated: false, costUsd: 0.5,
    latencyMs: 5, requestId: "req_1" });
const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow =>
  ({ threadId, accountId: "acc_1", state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: "h1", ...over });
const newCheckin = (briefId: string, briefRev: number, n: number): NewCheckin => ({
  briefId, localDate: DAY, briefRev, recipientUserId: `u_p${n}`, recipientSlackId: `U0P${n}AAAA`, text: `Hi there ${n}, ${BRIEF_TEXT_SENTINELS.checkinText}`,
  expiresAt: new Date(NOW.getTime() + 48 * 3_600_000).toISOString(), purgeAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString()
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  __resetBriefStoreForTests();
  events = [];
  gatherHook = null;
  purgeRows = [];
  screenRows = new Map();
  db = createFakeBriefDb({ now: () => new Date(), before: (call) => { if (call.kind !== "select") events.push(`${call.kind}:${call.target}`); } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  verdict = { owner: "exec", reason: "owns" };
  vi.mocked(loadBriefOwnership).mockImplementation(async (p, _s, localDate) => ({
    verdict, facts: {} as never, localDate, brief: await getBriefByDate(p, localDate), installation: null
  }));
  vi.mocked(gatherBrief).mockImplementation(async () => {
    events.push("gather");
    const g = structuredClone(GATHER);
    gatherHook?.();
    return g;
  });
  vi.mocked(callModel).mockImplementation(async () => {
    events.push("model");
    return modelResult();
  });
  vi.mocked(openActiveInstallation).mockResolvedValue({ row: { teamId: "T0SCALED" } as never, target: { token: "test-bot-token", dmChannelId: "D0MITCH" } });
  vi.mocked(selectCheckinRecipients).mockResolvedValue({
    candidates: [1, 2, 3].map((n) => ({ userId: `u_p${n}`, firstName: `P${n}`, departments: [], role: "worker" as const, daysSinceLast: null, openTasks: 2,
      slackUserId: `U0P${n}AAAA` })),
    skipped: { leaders: 0, owner: 0, noWork: 0, recent: 0, noSlack: 0, guest: 0 }
  });
  vi.mocked(generateCheckins).mockImplementation(async (_p, input) => {
    events.push("generate");
    return input.candidates.map((_, i) => newCheckin(input.briefId, input.briefRev, i + 1));
  });
  vi.mocked(checkinsMessageParts).mockResolvedValue({ blocks: [{ type: "divider" }] as never, text: BRIEF_COPY.checkinsFallbackText });
  vi.mocked(dmUpdate).mockImplementation(async () => { events.push("dmUpdate"); });
  vi.mocked(enqueueJob).mockImplementation(async () => {
    events.push("enqueue");
    return { enqueued: true, id: 1 };
  });
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.mocked(listPurgeLog).mockImplementation(async (_p, afterId) => purgeRows.filter((r) => r.id > afterId));
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, screenRows.get(id) ?? screenRow(id)])));
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  consoleSpy = captureConsole();
});
afterEach(() => {
  vi.useRealTimers();
  assertNoBriefText([consoleSpy.calls(), vi.mocked(notifyOps), vi.mocked(enqueueJob)], { label: "logs, alerts and job payloads" });
});

const req = (over: Partial<BuildRequest> = {}): BuildRequest => ({
  principal, settings, localDate: DAY, scheduledAt: SCHED, trigger: "schedule", claimed: null, dryRun: false, now: new Date(), signal: new AbortController().signal,
  ...over
});
const briefRow = () => db.tables.exec_briefs.find((r) => r.local_date === DAY) as Row;
const contentOf = () => briefRow().content as BriefContent;
const mentionRows = () => db.tables.exec_brief_mentions;
const finishCalls = () => db.calls.filter((c) => c.kind === "rpc" && c.target === "exec_brief_finish_build");

async function seedRow(over: Row): Promise<Row> {
  const { data, error } = await (db.client as SupabaseClient).from("exec_briefs").insert({
    principal_id: principal.id, local_date: DAY, tz: "America/New_York", scheduled_at: SCHED.toISOString(), content_expires_at: CONTENT_EXP, expires_at: ROW_EXP,
    ...over
  }).select("*");
  if (error) throw new Error(`seed: ${error.code} ${error.message}`);
  return (data as Row[])[0];
}
/** A row a schedule build finished earlier, delivered to his DM (with its check-ins message when checkinsTs is set). */
async function deliveredRow(checkinsTs: string | null = null): Promise<Row> {
  await runBriefBuild(req());
  const id = briefRow().id as string;
  const r = briefRow();
  Object.assign(r, { status: "delivered", delivery_started_at: NOW.toISOString(), post_attempts: 1, delivered_at: NOW.toISOString(),
    slack_channel_id: "D0MITCH", slack_ts: "1794100000.000100", checkins_ts: checkinsTs });
  vi.mocked(enqueueJob).mockClear();
  vi.mocked(selectCheckinRecipients).mockClear();
  vi.mocked(generateCheckins).mockClear();
  events.length = 0;
  void id;
  return r;
}
async function regenClaim(): Promise<{ id: string; rev: number }> {
  const c = await claimBuild(principal, { localDate: DAY, tz: "America/New_York", scheduledAt: SCHED, trigger: "regenerate", expectedRev: briefRow().rev as number,
    contentExpiresAt: new Date(CONTENT_EXP), expiresAt: new Date(ROW_EXP) });
  if (c.outcome !== "claimed") throw new Error(`regenerate claim: ${c.outcome}`);
  return { id: c.id, rev: c.rev };
}

describe("BB01-BB06 ownership, status and the claim", () => {
  it("BB01 verdict legacy → skipped legacy_owns, no row written, no model call", async () => {
    verdict = { owner: "legacy", reason: "brief_off" };
    expect(await runBriefBuild(req())).toEqual({ outcome: "skipped", reason: "legacy_owns" });
    expect(db.mutations()).toBe(0);
    expect(callModel).not.toHaveBeenCalled();
    expect(gatherBrief).not.toHaveBeenCalled();
  });

  it("BB02 exec, before the cutoff, no fallback → built; check-ins generated, then ONE deliver job (full, the key format)", async () => {
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "built", statusReason: null, mode: "ai", modeReason: null, deliver: "full", checkins: 3, rev: 1 });
    const id = briefRow().id as string;
    expect(r).toMatchObject({ briefId: id });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toEqual({
      kind: "exec.brief-deliver", lane: "interactive", principalId: principal.id, payload: { brief_id: id, local_date: DAY, rev: 1, mode: "full" },
      dedupeKey: `exec.brief-deliver:${principal.id}:${DAY}:1:full`, maxAttempts: 1
    });
    expect(events.indexOf("generate")).toBeLessThan(events.indexOf("enqueue"));
    expect(events.indexOf("insert:exec_brief_checkins")).toBeLessThan(events.indexOf("enqueue"));
    expect(db.tables.exec_brief_checkins).toHaveLength(3);
    expect(db.tables.exec_brief_checkins.every((c) => c.brief_rev === 1 && c.status === "proposed")).toBe(true);
    expect(briefRow()).toMatchObject({ status: "built", owner: "exec", owner_reason: "owns", mode: "ai" });
    expect(contentOf().mode).toBe("ai");
    expect(vi.mocked(selectCheckinRecipients).mock.calls[0][1]).toBe("test-bot-token");
    expect(vi.mocked(selectCheckinRecipients).mock.calls[0][2]).toMatchObject({ localDate: DAY, tz: "America/New_York", teamId: "T0SCALED" });
    // The earlier days' proposed rows are expired by the build (C45).
    expect(db.calls.some((c) => c.kind === "update" && c.target === "exec_brief_checkins" && (c.payload as Row).status_reason === "next_brief")).toBe(true);
  });

  it("BB03 exec_page_only (not_superseding) → page_only, no deliver job, NO check-ins (C11)", async () => {
    verdict = { owner: "exec_page_only", reason: "not_superseding" };
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "page_only", statusReason: "not_superseding", deliver: null, checkins: 0 });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(selectCheckinRecipients).not.toHaveBeenCalled();
    expect(generateCheckins).not.toHaveBeenCalled();
    expect(briefRow()).toMatchObject({ status: "page_only", status_reason: "not_superseding", owner: "exec_page_only" });
    expect(notifyOps).not.toHaveBeenCalled();
    // No installation while he asked to supersede → the not-owned alert.
    __resetBriefStoreForTests();
    db.tables.exec_briefs.length = 0;
    verdict = { owner: "exec_page_only", reason: "no_installation" };
    await runBriefBuild(req());
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.notOwned.key(principal.id)]);
  });

  it("BB04 after the cutoff → page_only after_cutoff + BRIEF_OPS.late", async () => {
    const r = await runBriefBuild(req({ now: new Date("2026-11-06T17:30:00.000Z") }));
    expect(r).toMatchObject({ outcome: "built", status: "page_only", statusReason: "after_cutoff", deliver: null, checkins: 0 });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toEqual({ key: BRIEF_OPS.late.key(principal.id), title: BRIEF_OPS.late.title,
      detail: `principal ${principal.id}, ${DAY}: after_cutoff` });
  });

  it("BB05 the claim finds the watchdog already sent → page_only after_fallback, deliver mode late (C34)", async () => {
    await seedRow({ status: "building", fallback_sent_at: "2026-11-06T13:46:00.000Z", fallback_error_code: "fatal" });
    const r = await runBriefBuild(req({ now: new Date("2026-11-06T14:00:00.000Z") }));
    expect(r).toMatchObject({ outcome: "built", status: "page_only", statusReason: "after_fallback", deliver: "late" });
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ payload: { mode: "late" }, dedupeKey: `exec.brief-deliver:${principal.id}:${DAY}:1:late` });
  });

  it("BB06 the claim answers exists (a second scheduled job) → skipped exists, no model call", async () => {
    await runBriefBuild(req());
    vi.mocked(callModel).mockClear();
    vi.mocked(gatherBrief).mockClear();
    expect(await runBriefBuild(req())).toEqual({ outcome: "skipped", reason: "exists" });
    expect(callModel).not.toHaveBeenCalled();
    expect(gatherBrief).not.toHaveBeenCalled();
  });
});

describe("BB07 / BB08 failures (C5)", () => {
  it("BB07 a failure before the model call fails the claimed row pre_model; before the claim nothing is written", async () => {
    vi.mocked(loadBriefOwnership).mockRejectedValueOnce(new Error("ownership read"));
    expect(await runBriefBuild(req())).toEqual({ outcome: "failed", stage: "pre_model", code: "ownership_read" });
    expect(db.tables.exec_briefs).toHaveLength(0);
    db.failNext("select:exec_brief_mentions", "XX000");
    expect(await runBriefBuild(req())).toEqual({ outcome: "failed", stage: "pre_model", code: "mentions_read" });
    expect(briefRow()).toMatchObject({ status: "failed", status_reason: "pre_model", error_code: "mentions_read" });
    expect(callModel).not.toHaveBeenCalled();
    // The retry (trigger retry) re-claims that row and builds it.
    const r = await runBriefBuild(req({ trigger: "retry" }));
    expect(r).toMatchObject({ outcome: "built", status: "built" });
  });

  it("BB08 a failure after the model call (finishBuild throws) → failed post_model, no retry, the ops alert, no delivery", async () => {
    db.failNext("exec_brief_finish_build", "XX000");
    expect(await runBriefBuild(req())).toEqual({ outcome: "failed", stage: "post_model", code: "finish_write" });
    expect(briefRow()).toMatchObject({ status: "failed", status_reason: "post_model", error_code: "finish_write" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0])).toEqual([{ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title,
      detail: `principal ${principal.id}, ${DAY}: finish_write` }]);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("only the job's abort escapes", async () => {
    const job = new AbortController();
    const reason = new Error("job timeout");
    reason.name = "TimeoutError";
    vi.mocked(gatherBrief).mockImplementationOnce(async () => {
      job.abort(reason);
      throw reason;
    });
    await expect(runBriefBuild(req({ signal: job.signal }))).rejects.toBe(reason);
  });
});

describe("BB09-BB12 regenerate, dry run, check-in failure", () => {
  it("BB09 regenerate (claimed by the route): rev + 1, delivery status unchanged, no deliver job, mentions untouched, stored verdicts reused", async () => {
    await deliveredRow();
    const stored = contentOf().novelty;
    const fp = "dd:incident:task:t_incident7";
    expect(stored[fp]).toBe("new");
    const marked = JSON.stringify(mentionRows());
    const claimed = await regenClaim();
    const r = await runBriefBuild(req({ trigger: "regenerate", claimed }));
    expect(r).toMatchObject({ outcome: "built", rev: 2, status: "delivered", statusReason: null, deliver: null });
    expect(briefRow()).toMatchObject({ rev: 2, status: "delivered", regen_lock_until: null });
    expect(contentOf()).toMatchObject({ rev: 2, trigger: "regenerate" });
    // The first build marked the incident; a fresh judgment would say "unchanged", the stored verdict says "new".
    expect(contentOf().novelty[fp]).toBe("new");
    expect(JSON.stringify(mentionRows())).toBe(marked);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(selectCheckinRecipients).not.toHaveBeenCalled();   // no check-ins message on the day
  });

  it("BB10 regenerate with checkins_ts: old proposed rows expired superseded, new rows with the new brief_rev, ONE chat.update; sent rows kept", async () => {
    await deliveredRow("1794100000.000200");
    const briefId = briefRow().id as string;
    const [a, b] = db.tables.exec_brief_checkins;
    Object.assign(a, { status: "sent", sent_at: NOW.toISOString(), sending_at: NOW.toISOString(), slack_channel_id: "D0P1AAAAA", slack_ts: "1794100000.000300" });
    // The selection skips anyone checked in on recently (Area D's rule), so the regenerate's candidates are other people.
    vi.mocked(selectCheckinRecipients).mockResolvedValueOnce({
      candidates: [4, 5, 6].map((n) => ({ userId: `u_p${n}`, firstName: `P${n}`, departments: [], role: "worker" as const, daysSinceLast: null, openTasks: 1,
        slackUserId: `U0P${n}AAAA` })),
      skipped: { leaders: 0, owner: 0, noWork: 0, recent: 0, noSlack: 0, guest: 0 }
    });
    vi.mocked(generateCheckins).mockImplementationOnce(async (_p, input) =>
      input.candidates.map((c, i) => ({ ...newCheckin(input.briefId, input.briefRev, i + 4), recipientUserId: c.userId, recipientSlackId: c.slackUserId })));
    const claimed = await regenClaim();
    const r = await runBriefBuild(req({ trigger: "regenerate", claimed }));
    expect(r).toMatchObject({ outcome: "built", rev: 2, checkins: 2 });
    const rows = db.tables.exec_brief_checkins;
    expect(rows.find((x) => x.id === a.id)).toMatchObject({ status: "sent" });
    expect(rows.find((x) => x.id === b.id)).toMatchObject({ status: "expired", status_reason: "superseded" });
    const fresh = rows.filter((x) => x.brief_rev === 2);
    expect(fresh).toHaveLength(2);   // ≤ 3 live per brief: one was already sent
    expect(fresh.every((x) => x.status === "proposed")).toBe(true);
    expect(vi.mocked(selectCheckinRecipients)).toHaveBeenCalledTimes(1);
    expect(checkinsMessageParts).toHaveBeenCalledWith(principal, briefId, expect.objectContaining({ paused: null, tz: "America/New_York" }));
    expect(dmUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dmUpdate).mock.calls[0][1]).toBe("1794100000.000200");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("BB11 dry run → no store write of any kind, the content returned, nothing generated, enqueued or posted (C29)", async () => {
    const r = await runBriefBuild(req({ dryRun: true }));
    expect(r).toMatchObject({ outcome: "dry_run", mode: "ai", modeReason: null });
    if (r.outcome !== "dry_run") throw new Error("dry run");
    expect(r.content.sections.length).toBe(10);
    expect(db.mutations()).toBe(0);
    expect(db.tables.exec_briefs).toHaveLength(0);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(generateCheckins).not.toHaveBeenCalled();
    expect(dmUpdate).not.toHaveBeenCalled();
    // A dry run on a day that has a brief: still nothing written (a preview of a regenerate needs no claim).
    await runBriefBuild(req());
    const before = db.mutations();
    expect((await runBriefBuild(req({ dryRun: true, trigger: "regenerate" }))).outcome).toBe("dry_run");
    expect(db.mutations()).toBe(before);
  });

  it("BB12 check-in generation failing → the brief still builds and is delivered, with no check-ins", async () => {
    vi.mocked(generateCheckins).mockRejectedValueOnce(new Error("model down"));
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "built", deliver: "full", checkins: 0 });
    expect(db.tables.exec_brief_checkins).toHaveLength(0);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(consoleSpy.calls().some((c) => String(c[0]).includes("checkins_skipped"))).toBe(true);
    // His DD token known not to be his → no check-ins at all (C19).
    __resetBriefStoreForTests();
    db.tables.exec_briefs.length = 0;
    vi.mocked(getSyncState).mockResolvedValue({ value: { state: "mismatch", checkedAt: NOW.toISOString() }, rev: 1 });
    vi.mocked(selectCheckinRecipients).mockClear();
    expect(await runBriefBuild(req())).toMatchObject({ outcome: "built", checkins: 0 });
    expect(selectCheckinRecipients).not.toHaveBeenCalled();
  });
});

describe("BB18 (fixer correctness-2) the optional check-ins never cost the delivery", () => {
  it("BB18 the job's signal aborting during check-ins → the full deliver job is still enqueued, then the abort is rethrown", async () => {
    const job = new AbortController();
    const reason = new Error("job timeout");
    reason.name = "TimeoutError";
    vi.mocked(generateCheckins).mockImplementationOnce(async () => {
      job.abort(reason);
      throw reason;
    });
    await expect(runBriefBuild(req({ signal: job.signal }))).rejects.toBe(reason);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const id = briefRow().id as string;
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.brief-deliver", payload: { brief_id: id, local_date: DAY, rev: 1, mode: "full" } });
    expect(briefRow()).toMatchObject({ status: "built" });
    expect(db.tables.exec_brief_checkins).toHaveLength(0);
  });

  it("BB18 too little of the job's 240 s left (a slow gather and model) → check-ins skipped for budget; the deliver job enqueued", async () => {
    vi.mocked(gatherBrief).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 222_000));
      return structuredClone(GATHER);
    });
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "built", deliver: "full", checkins: 0 });
    expect(selectCheckinRecipients).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(consoleSpy.calls().some((c) => String(c[0]).includes("checkins_skipped (budget)"))).toBe(true);
  });
});

describe("BB15-BB17 the post-write catch-up and the first successful build (intel-13, intel-16)", () => {
  const SALES = "slack:msg:C0SALES01:1794148000.000100";

  it("BB15 a purge-log message row and a tombstone landing between the gather and finishBuild are scrubbed into the row before delivery", async () => {
    gatherHook = () => {
      purgeRows.push({ id: 7, scope: "message", channelId: "C0SALES01", ts: "1794148000.000100", reason: "deleted_event", createdAt: NOW.toISOString() });
      screenRows.set("th_imp1", screenRow("th_imp1", { state: "restricted_hidden" }));
    };
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "built", deliver: "full" });
    const c = contentOf();
    const lines = c.sections.flatMap((s) => s.items);
    const slack = c.sections.find((s) => s.key === "slack")!.items[0];
    expect(slack).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true, slackKeys: [] });
    const emails = c.sections.find((s) => s.key === "emails")!.items;
    expect(emails.every((i) => i.text === BRIEF_COPY.removedRestricted)).toBe(true);
    expect(c.headline).toBeNull();
    expect(c.top3.map((t) => t.fp)).not.toContain("email:thread:th_imp1:msg_i1");
    expect(briefRow().ref_thread_ids).not.toContain("th_imp1");
    expect(briefRow().ref_slack_keys).not.toContain("m:C0SALES01:1794148000.000100");
    expect(JSON.stringify(lines)).not.toContain(BRIEF_TEXT_SENTINELS.briefLine);
    // Order: the content write, then both scrubs, then (check-ins and) the delivery job.
    const finish = events.indexOf("rpc:exec_brief_finish_build");
    const slackScrub = events.indexOf("rpc:exec_brief_scrub_slack");
    const threadScrub = events.indexOf("rpc:exec_brief_scrub_threads");
    expect(finish).toBeGreaterThan(-1);
    expect(slackScrub).toBeGreaterThan(finish);
    expect(threadScrub).toBeGreaterThan(slackScrub);
    expect(events.indexOf("enqueue")).toBeGreaterThan(threadScrub);
    // The sweep's cursor is never moved by the build.
    expect(putSyncState).not.toHaveBeenCalled();
    void SALES;
  });

  it("BB16 the catch-up failing → still built and delivered; catchup_failed logged by id only", async () => {
    vi.mocked(listPurgeLog).mockRejectedValue(new Error("log down"));
    const r = await runBriefBuild(req());
    expect(r).toMatchObject({ outcome: "built", status: "built", deliver: "full" });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const line = consoleSpy.calls().map((c) => String(c[0])).find((l) => l.includes("catchup_failed"))!;
    expect(line).toBe(`[exec-brief] brief ${briefRow().id} catchup_failed (screen_unavailable)`);
  });

  it("BB17 / NV11 a regenerate that is the day's first successful build (failed post_model) marks the mentions", async () => {
    db.failNext("exec_brief_finish_build", "XX000");
    await runBriefBuild(req());
    expect(briefRow()).toMatchObject({ status: "failed", status_reason: "post_model", novelty_marked_at: null });
    expect(mentionRows()).toHaveLength(0);
    const claimed = await regenClaim();
    const r = await runBriefBuild(req({ trigger: "regenerate", claimed }));
    expect(r).toMatchObject({ outcome: "built", status: "page_only", statusReason: "regenerated" });
    expect(finishCalls().at(-1)!.payload).toMatchObject({ p_trigger: "regenerate" });
    expect(((finishCalls().at(-1)!.payload as Row).p_mentions as unknown[]).length).toBeGreaterThan(0);
    expect(mentionRows().length).toBeGreaterThan(0);
    expect(briefRow().novelty_marked_at).not.toBeNull();
  });

  it("NV11 a never_built placeholder regenerated marks too; a regenerate after a successful build sends its mentions and marks nothing", async () => {
    await seedRow({ status: "failed", status_reason: "never_built" });
    const claimed = await regenClaim();
    await runBriefBuild(req({ trigger: "regenerate", claimed }));
    const after = mentionRows().length;
    expect(after).toBeGreaterThan(0);
    const again = await regenClaim();
    const before = JSON.stringify(mentionRows());
    await runBriefBuild(req({ trigger: "regenerate", claimed: again }));
    expect(((finishCalls().at(-1)!.payload as Row).p_mentions as unknown[]).length).toBeGreaterThan(0);   // never [] because of the trigger
    expect(JSON.stringify(mentionRows())).toBe(before);
  });
});

describe("NV08-NV10 what a build marks (M8)", () => {
  it("NV08 the first build marks; a second build of the same day (regenerate) marks nothing", async () => {
    await runBriefBuild(req());
    const marked = mentionRows();
    expect(marked.length).toBe(gatherItems(GATHER).length);
    expect(marked.every((m) => m.last_mentioned_on === DAY)).toBe(true);
    const snapshot = JSON.stringify(marked);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));   // a fresh 'built' row is still about to be delivered (C48)
    const claimed = await regenClaim();
    await runBriefBuild(req({ trigger: "regenerate", claimed }));
    expect(JSON.stringify(mentionRows())).toBe(snapshot);
  });

  it("NV09 a page-only build marks too", async () => {
    verdict = { owner: "exec_page_only", reason: "legacy_delivered" };
    await runBriefBuild(req());
    expect(briefRow().status).toBe("page_only");
    expect(mentionRows().length).toBeGreaterThan(0);
  });

  it("NV10 a dry run marks nothing", async () => {
    await runBriefBuild(req({ dryRun: true }));
    expect(mentionRows()).toHaveLength(0);
  });
});

describe("prettyLocalDate", () => {
  it("is the calendar date, whatever the zone", () => {
    expect(prettyLocalDate("2026-11-06")).toBe("Friday, Nov 6");
    expect(prettyLocalDate("bad")).toBe("bad");
  });
});
