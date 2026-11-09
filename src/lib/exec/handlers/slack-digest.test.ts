import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJobs: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn() }));
// P7a's facade and Area A's store at their module boundaries (§4 stage 1).
vi.mock("@/lib/exec/slack-reading", async () => ({
  SLACK_CAP_FEATURES: (await import("@/lib/exec/slack-read-types")).SLACK_CAP_FEATURES,
  listIntelChannels: vi.fn(), getDdBotIdentity: vi.fn(), listAuthorOptouts: vi.fn(), listOpenSlackItems: vi.fn()
}));
vi.mock("@/lib/exec/slack-intel-store", () => ({
  slackIntelState: vi.fn(), getDigests: vi.fn(), claimDigest: vi.fn(), finishDigest: vi.fn(), listChannelLinks: vi.fn()
}));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), featureSpentTodayUsd: vi.fn() }));

import { installFakeSlack } from "@/lib/exec/__tests__/fake-slack-api";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { NOW, PID, historyPage, jobCtx, readingInstallation, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import {
  SLACK_DIGEST_PLAN_TIMEOUT_MS,
  SLACK_DIGEST_TIMEOUT_MS,
  parseDigestPayload,
  runSlackDigestJob,
  runSlackDigestPlanJob,
  slackDigestJobHandler,
  slackDigestPlanJobHandler,
  slackDigestPlanScheduledWork
} from "@/lib/exec/handlers/slack-digest";
import { enqueueJobs } from "@/lib/exec/jobs";
import { callModel } from "@/lib/exec/llm/client";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { claimDigest, finishDigest, getDigests, listChannelLinks, slackIntelState } from "@/lib/exec/slack-intel-store";
import type { ChannelRow, SlackDigestRow, SlackIntelState } from "@/lib/exec/slack-intel-types";
import { openReader } from "@/lib/exec/slack-read";
import { getDdBotIdentity, listAuthorOptouts, listIntelChannels } from "@/lib/exec/slack-reading";
import { takeSlackBudget } from "@/lib/exec/slack-rate";
import type { EnqueueJobInput, ExecSettings } from "@/lib/exec/types";

// P7b Area C: exec.slack-digest and exec.slack-digest-plan (contract §3.11.2–3, C15, intel-1, intel-4; §5.4 DG19, DG25,
// DG29, DG32, and the handlers' gates). The digest job runs the real buildDigest over Slack's fake API (P7a's paced glue,
// the limiter mocked) with Area A's store and P7a's facade mocked at their module boundaries; the plan runs the real
// runDigestPlan / enqueueDigestRebuilds over the same mocks, the job queue recorded.

const CH = (JSON.parse(readFileSync(new URL("../__tests__/fixtures/slack-intel/channels.json", import.meta.url), "utf8")) as { rows: Record<string, ChannelRow> }).rows;
type DayMessage = { ts: string; expect: string; raw: Record<string, unknown> };
const DAY = JSON.parse(readFileSync(new URL("../__tests__/fixtures/slack-intel/history-day.json", import.meta.url), "utf8")) as
  { channelId: string; localDate: string; history: DayMessage[]; replies: Record<string, DayMessage[]> };

let channels: ChannelRow[];
let seenKeys: Set<string>;
let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];
const PLAN_NOW = new Date("2026-11-08T05:30:00.000Z"); // 00:30 in New York

function digestRow(channelId: string, localDate: string, over: Partial<SlackDigestRow> = {}): SlackDigestRow {
  return {
    id: `esd_${channelId.toLowerCase().padEnd(16, "0")}${localDate.replace(/-/g, "").padEnd(16, "0")}`.slice(0, 36), channelId, localDate, tz: "America/New_York",
    fromTs: "1793764800.000000", toTs: "1793851200.000000", status: "built", summary: "x", highlights: [], decisions: [], openQuestions: [], sourceTs: [],
    counts: { human: 1, bot: 0, ddPost: 0, external: 0, threads: 0 }, privacy: "public", partial: false, fullDay: true, injectionSuspected: false, rebuilds: 0,
    model: null, costUsd: null, requestedAt: NOW.toISOString(), builtAt: NOW.toISOString(), expiresAt: "2027-02-01T00:00:00.000Z", ...over
  };
}
const jobsOf = (call = 0): EnqueueJobInput[] => vi.mocked(enqueueJobs).mock.calls[call]?.[0] as EnqueueJobInput[] ?? [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  results.length = 0;
  seenKeys = new Set();
  channels = Object.values(CH).filter((c) => c.class !== "deny");
  vi.mocked(listIntelChannels).mockReset().mockImplementation(async (_p, opts) =>
    (opts?.channelIds !== undefined ? channels.filter((c) => opts.channelIds!.includes(c.channelId)) : channels).map((c) => ({ ...c })));
  vi.mocked(slackIntelState).mockReset().mockResolvedValue("ok");
  vi.mocked(getDigests).mockReset().mockResolvedValue([]);
  vi.mocked(claimDigest).mockReset().mockResolvedValue({ outcome: "claimed", id: `esd_${"1".repeat(32)}`, rebuilds: 0 });
  vi.mocked(finishDigest).mockReset().mockResolvedValue("ok");
  vi.mocked(listChannelLinks).mockReset().mockResolvedValue(new Map());
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(openReader).mockReset().mockResolvedValue(readingInstallation());
  vi.mocked(getDdBotIdentity).mockReset().mockResolvedValue({ teamId: "T0SCALED", userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: NOW.toISOString() });
  vi.mocked(listAuthorOptouts).mockReset().mockResolvedValue(["U0OPTOUT"]);
  vi.mocked(takeSlackBudget).mockReset().mockResolvedValue(undefined);
  vi.mocked(featureSpentTodayUsd).mockReset().mockResolvedValue(0.1);
  // The queue's dedupe: a key already queued inserts nothing.
  vi.mocked(enqueueJobs).mockReset().mockImplementation(async (inputs: readonly EnqueueJobInput[]) => {
    const inserted = inputs.filter((j) => j.dedupeKey && !seenKeys.has(j.dedupeKey)).map((j, i) => {
      seenKeys.add(j.dedupeKey as string);
      return { id: i + 1, dedupeKey: j.dedupeKey ?? null };
    });
    return { enqueued: inserted.length, inserted };
  });
  vi.mocked(callModel).mockReset().mockResolvedValue({ message: { content: [{ type: "text", text: JSON.stringify({
    summary: `The launch moved to Friday. ${S.summary}`, highlights: [{ msg: "S0", text: `A highlight. ${S.summary}` }], decisions: [], open_questions: [],
    injection_suspected: false }) }], stop_details: null } as never, refused: false, truncated: false, costUsd: 0.003, latencyMs: 5, requestId: "req_1" });
});

afterEach(() => {
  // DG25: results, logs and job payloads hold ids, dates, counts and codes only.
  assertNoSlackLeak({ console: out, jobs: vi.mocked(enqueueJobs), results }, { label: "slack-digest handlers" });
  vi.useRealTimers();
});

describe("the handlers and the schedule", () => {
  it("exec.slack-digest: bulk, 120 s; exec.slack-digest-plan: bulk, 60 s, daily from 00:30 while reading is on and installed", () => {
    expect(slackDigestJobHandler).toMatchObject({ kind: "exec.slack-digest", lane: "bulk", timeoutMs: 120_000 });
    expect(SLACK_DIGEST_TIMEOUT_MS).toBe(120_000);
    expect(slackDigestPlanJobHandler).toMatchObject({ kind: "exec.slack-digest-plan", lane: "bulk", timeoutMs: 60_000 });
    expect(SLACK_DIGEST_PLAN_TIMEOUT_MS).toBe(60_000);
    expect(slackDigestPlanScheduledWork).toMatchObject({ kind: "exec.slack-digest-plan", lane: "bulk", maxAttempts: 2 });
    const cadence = slackDigestPlanScheduledWork.cadence;
    expect(cadence.kind).toBe("daily");
    if (cadence.kind === "daily") expect(cadence.at(settings())).toBe("00:30");
    const s = (over: Partial<ExecSettings>) => settings(over);
    expect(slackDigestPlanScheduledWork.enabled?.(s({}))).toBe(true);
    expect(slackDigestPlanScheduledWork.enabled?.(s({ slackReadingEnabled: false }))).toBe(false);
    expect(slackDigestPlanScheduledWork.enabled?.(s({ slackReadingSchemaReady: false }))).toBe(false);
    expect(slackDigestPlanScheduledWork.payload).toBeUndefined();
  });

  it("parseDigestPayload: references only; anything else is refused", () => {
    expect(parseDigestPayload({ channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "plan" })).toEqual({ channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "plan" });
    for (const bad of [null, [], "x", { channel_id: "general", local_date: "2026-11-07", mode: "plan" }, { channel_id: "C0ACMESEO", local_date: "07/11/2026", mode: "plan" },
      { channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "now" }, { channel_id: "C0ACMESEO", local_date: "2026-11-07" }]) {
      expect(parseDigestPayload(bad)).toBeNull();
    }
  });
});

describe("exec.slack-digest", () => {
  it("no principal or a bad payload → skipped before any read", async () => {
    expect(await runSlackDigestJob(jobCtx("exec.slack-digest", { channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "plan" }, { principal: null }))).toEqual({ skipped: "no_principal" });
    expect(await runSlackDigestJob(jobCtx("exec.slack-digest", { channel_id: "C0ACMESEO", mode: "plan" }))).toEqual({ skipped: "bad_payload" });
    expect(loadSettings).not.toHaveBeenCalled();
    expect(slackIntelState).not.toHaveBeenCalled();
  });

  it.each(["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as SlackIntelState[])(
    "state %s → skipped with the state; no channel read, no claim, no Slack call", async (state) => {
      vi.mocked(slackIntelState).mockResolvedValue(state);
      const slack = installFakeSlack({});
      expect(await runSlackDigestJob(jobCtx("exec.slack-digest", { channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "plan" }))).toEqual({ skipped: state });
      expect(listIntelChannels).not.toHaveBeenCalled();
      expect(claimDigest).not.toHaveBeenCalled();
      expect(slack.calls).toEqual([]);
    });

  it("DG25 a full build through the job: the result is the outcome, counts, flags, the cost and codes; no text anywhere", async () => {
    installFakeSlack({
      "conversations.history": () => historyPage(DAY.history.map((h) => h.raw)),
      "conversations.replies": (body) => historyPage((DAY.replies[String(body.ts)] ?? []).map((r) => r.raw))
    });
    const r = await slackDigestJobHandler.run(jobCtx("exec.slack-digest", { channel_id: DAY.channelId, local_date: DAY.localDate, mode: "plan" }));
    results.push(r);
    expect(r).toEqual({ outcome: "built", humanCount: 5, partial: false, fullDay: true, costUsd: 0.003 });
    expect(Object.keys(r as object).sort()).toEqual(["costUsd", "fullDay", "humanCount", "outcome", "partial"]);
    // The summary went to the store (finishDigest), and only there.
    expect(vi.mocked(finishDigest).mock.calls[0][1]).toMatchObject({ status: "built", summary: expect.stringContaining(S.summary) });
  });

  it("DG25 a failure carries its code; a not-allowed channel its policy reason", async () => {
    installFakeSlack({ "conversations.history": () => historyPage(DAY.history.map((h) => h.raw)), "conversations.replies": () => historyPage([]) });
    vi.mocked(callModel).mockResolvedValueOnce({ message: { content: [{ type: "text", text: "{}" }], stop_details: null } as never, refused: true, truncated: false,
      costUsd: 0.001, latencyMs: 5, requestId: "req_2" });
    const failed = await runSlackDigestJob(jobCtx("exec.slack-digest", { channel_id: DAY.channelId, local_date: DAY.localDate, mode: "plan" }));
    results.push(failed);
    expect(failed).toEqual({ outcome: "failed", humanCount: 3, partial: false, fullDay: true, costUsd: 0.001, code: "refused" });
    const denied = await runSlackDigestJob(jobCtx("exec.slack-digest", { channel_id: CH.publicMuted.channelId, local_date: DAY.localDate, mode: "plan" }));
    results.push(denied);
    expect(denied).toEqual({ outcome: "not_allowed", humanCount: 0, partial: false, fullDay: false, costUsd: null, code: "muted" });
  });
});

describe("exec.slack-digest-plan (DG19, DG29, DG32)", () => {
  const plan = async (now = PLAN_NOW) => {
    const r = await runSlackDigestPlanJob(jobCtx("exec.slack-digest-plan", {}), now);
    results.push(r);
    return r;
  };

  it("DG19 yesterday for every watched, digestible conversation active since yesterday began; newest first, staggered, p0 keys", async () => {
    const at = (ts: string) => ({ lastActivityTs: ts });
    channels = channels.map((c) => ({ ...c, ...(c.channelId === "C0PRIVOPS" ? at("1794100000.000100") : c.channelId === "C0PARTNER" ? at("1794050000.000100")
      : c.channelId === "C0EXEVER" ? at("1794020000.000100") /* before yesterday began: no activity yesterday */ : {}) }));
    const r = await plan();
    expect(r).toEqual({ eligible: 6, planned: 6, retried: 0 });
    const jobs = jobsOf();
    // Same activity → channel id; the eligible set: watched public, private, group DM, finance (watched), shared, archived.
    expect(jobs.map((j) => (j.payload as { channel_id: string }).channel_id)).toEqual(["C0ACMESEO", "C0OLDLAUNCH", "C0PAYROLL", "G0MPIMTEAM", "C0PRIVOPS", "C0PARTNER"]);
    expect(jobs[0]).toEqual({ kind: "exec.slack-digest", lane: "bulk", principalId: PID, payload: { channel_id: "C0ACMESEO", local_date: "2026-11-07", mode: "plan" },
      dedupeKey: `slkdig:${PID}:C0ACMESEO:2026-11-07:p0`, runAfter: PLAN_NOW, maxAttempts: 2 });
    expect(jobs.map((j) => (j.runAfter as Date).getTime() - PLAN_NOW.getTime())).toEqual([0, 20_000, 40_000, 60_000, 80_000, 100_000]);
    // Never: the 1:1 DM, muted (owner, Slack, finance default), unwatched, left, hubs, unclassified, deny.
    for (const id of ["D0JANE", "C0DESIGN", "C0LAUNCH", "C0FINANCE", "C0EXTBOOKS", "C0RANDOM", "C0LEFTPRIV", "C0OUTBOUND", "C0EMAILHUB", "C0UNCLASS", "C0FBLEADS"]) {
      expect(jobs.map((j) => (j.payload as { channel_id: string }).channel_id)).not.toContain(id);
    }
    // The nightly retry read the six days before yesterday.
    expect(vi.mocked(getDigests).mock.calls[0][1]).toEqual({ dates: ["2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02", "2026-11-01"] });
  });

  it("DG19 at most 60 conversations, the newest activity first", async () => {
    channels = Array.from({ length: 70 }, (_v, i) => ({ ...CH.publicWatched, channelId: `C0BULK${String(i).padStart(3, "0")}`, lastActivityTs: `${1794100000 + i}.000100` }));
    expect(await plan()).toEqual({ eligible: 70, planned: 60, retried: 0 });
    const ids = jobsOf().map((j) => (j.payload as { channel_id: string }).channel_id);
    expect(ids).toHaveLength(60);
    expect(ids[0]).toBe("C0BULK069");
    expect(ids[59]).toBe("C0BULK010");
  });

  it("DG19 yesterday is DST-correct: 00:30 on the day after spring-forward plans that day (not the one before)", async () => {
    await plan(new Date("2026-03-09T04:30:00.000Z"));
    expect(new Set(jobsOf().map((j) => (j.payload as { local_date: string }).local_date))).toEqual(new Set(["2026-03-08"]));
    vi.mocked(enqueueJobs).mockClear();
    await plan(new Date("2026-11-02T05:30:00.000Z"));
    expect(new Set(jobsOf().map((j) => (j.payload as { local_date: string }).local_date))).toEqual(new Set(["2026-11-01"]));
  });

  it("DG29 (intel-1) an unwatched public channel with activity and a left private channel: the plan enqueues nothing for them", async () => {
    channels = channels.map((c) => (c.channelId === "C0RANDOM" || c.channelId === "C0LEFTPRIV" ? { ...c, lastActivityTs: "1794149000.000100" } : c));
    await plan();
    const ids = jobsOf().map((j) => (j.payload as { channel_id: string }).channel_id);
    expect(ids).not.toContain("C0RANDOM");
    expect(ids).not.toContain("C0LEFTPRIV");
  });

  it("DG32 (intel-4) the nightly retry: failed, skipped_cap and not-full-day rows → rebuild jobs keyed q<yesterday>, once per plan date", async () => {
    vi.mocked(getDigests).mockResolvedValue([
      digestRow("C0ACMESEO", "2026-11-04", { status: "failed", summary: null }),
      digestRow("C0PRIVOPS", "2026-11-04", { status: "skipped_cap", summary: null, rebuilds: 2 }),
      digestRow("G0MPIMTEAM", "2026-11-04", { status: "built", fullDay: false }),
      digestRow("C0PARTNER", "2026-11-04", { status: "built", fullDay: true }),
      digestRow("C0PAYROLL", "2026-11-04", { status: "empty", fullDay: true, summary: null }),
      digestRow("C0OLDLAUNCH", "2026-11-04", { status: "stale", summary: null }),
      // A muted channel's failed row is not retried (the policy still decides); a row 8 days old is outside the window.
      digestRow("C0DESIGN", "2026-11-04", { status: "failed", summary: null }),
      digestRow("C0ACMESEO", "2026-10-31", { status: "failed", summary: null })
    ]);
    channels = channels.map((c) => ({ ...c, lastActivityTs: null }));
    expect(await plan()).toEqual({ eligible: 0, planned: 0, retried: 3 });
    const jobs = vi.mocked(enqueueJobs).mock.calls.flatMap((c) => c[0] as EnqueueJobInput[]);
    expect(jobs.map((j) => [j.dedupeKey, (j.payload as { mode: string }).mode])).toEqual([
      [`slkdig:${PID}:C0ACMESEO:2026-11-04:q2026-11-07`, "rebuild"],
      [`slkdig:${PID}:C0PRIVOPS:2026-11-04:q2026-11-07`, "rebuild"],
      [`slkdig:${PID}:G0MPIMTEAM:2026-11-04:q2026-11-07`, "rebuild"]
    ]);
    // The same plan date again (a retried plan job): nothing new.
    expect(await plan()).toEqual({ eligible: 0, planned: 0, retried: 0 });
    // The next night retries each still-failing row once more, under the new plan date.
    const next = await plan(new Date("2026-11-09T05:30:00.000Z"));
    expect(next).toMatchObject({ retried: 3 });
    expect(vi.mocked(enqueueJobs).mock.calls.at(-1)![0].map((j) => j.dedupeKey)).toEqual([
      `slkdig:${PID}:C0ACMESEO:2026-11-04:q2026-11-08`, `slkdig:${PID}:C0PRIVOPS:2026-11-04:q2026-11-08`, `slkdig:${PID}:G0MPIMTEAM:2026-11-04:q2026-11-08`
    ]);
  });

  it("the plan skips (no reads) for every state but ok, and with no principal", async () => {
    for (const state of ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as SlackIntelState[]) {
      vi.mocked(slackIntelState).mockResolvedValueOnce(state);
      expect(await plan()).toEqual({ skipped: state });
    }
    expect(await runSlackDigestPlanJob(jobCtx("exec.slack-digest-plan", {}, { principal: null }), PLAN_NOW)).toEqual({ skipped: "no_principal" });
    expect(listIntelChannels).not.toHaveBeenCalled();
    expect(getDigests).not.toHaveBeenCalled();
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it("a failed channel read throws (the job retries; nothing is enqueued)", async () => {
    vi.mocked(listIntelChannels).mockRejectedValueOnce(new Error("store down"));
    await expect(runSlackDigestPlanJob(jobCtx("exec.slack-digest-plan", {}), PLAN_NOW)).rejects.toThrow();
    expect(enqueueJobs).not.toHaveBeenCalled();
  });
});
