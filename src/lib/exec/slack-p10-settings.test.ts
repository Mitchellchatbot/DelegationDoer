import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/slack-install", () => ({ getReadingHalf: vi.fn() }));
vi.mock("@/lib/exec/slack-leads-store", () => ({ purgeLeadCounts: vi.fn(async () => ({ counts: 3, channels: 1 })) }));
vi.mock("@/lib/exec/brief-store", () => ({ stripBriefLeads: vi.fn(async () => 2) }));
vi.mock("@/lib/exec/slack-reply-store", () => ({ deleteSlackVoiceProfile: vi.fn(async () => true) }));

import { stripBriefLeads } from "@/lib/exec/brief-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { purgeLeadCounts } from "@/lib/exec/slack-leads-store";
import { afterSlackP10Settings } from "@/lib/exec/slack-p10-settings";
import { deleteSlackVoiceProfile } from "@/lib/exec/slack-reply-store";
import type { EnqueueJobInput, ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 §5.1 RA10 (the switch's side) and §5.12 ST06 (contract §3.3.4, §3.7.4, C3, C23, C25, C60; Area B):
// afterSlackP10Settings: what each switch change does, keyed so two saves in a minute make one job, best effort.

const NOW = new Date("2026-11-10T15:00:30.000Z");
const MINUTE = Math.floor(NOW.getTime() / 60_000);
const INST = `esi_${"a".repeat(32)}`;
const P = { id: "ep_1" } as unknown as ExecPrincipal;
const S = (over: Partial<ExecSettings> = {}): ExecSettings => ({ principalId: "ep_1", ...DEFAULT_SETTINGS, slackP10SchemaReady: true, slackReadingSchemaReady: true,
  slackReadingEnabled: true, ...over });
const half = (state: "discovering" | "ready" | "revoked" | "none") => ({ row: { id: INST }, reading: { state } }) as never;
const NONE = { rediscover: false, leadBackfill: false, leadPurged: false, voiceDropped: false, tokenCheck: false };

let jobs: EnqueueJobInput[];
const logs: unknown[][] = [];
beforeEach(() => {
  vi.clearAllMocks();
  jobs = [];
  const keys = new Set<string>();
  vi.mocked(enqueueJob).mockImplementation(async (j) => {
    if (j.dedupeKey && keys.has(j.dedupeKey)) return { enqueued: false, id: null };
    if (j.dedupeKey) keys.add(j.dedupeKey);
    jobs.push(j);
    return { enqueued: true, id: jobs.length };
  });
  vi.mocked(getReadingHalf).mockResolvedValue(half("ready"));
  logs.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a); });
});

describe("RA10 read-all changed → one rediscovery (C3)", () => {
  it("a live reading half (ready or discovering) → exactly one exec.slack-discover, settings reason, keyed by installation and minute", async () => {
    expect(await afterSlackP10Settings(P, S({ slackReadAll: false }), S({ slackReadAll: true }), NOW)).toEqual({ ...NONE, rediscover: true });
    expect(jobs).toEqual([{ kind: "exec.slack-discover", lane: "bulk", principalId: "ep_1", payload: { installation_id: INST, reason: "settings" },
      dedupeKey: `slack-discover:settings:${INST}:${MINUTE}`, maxAttempts: 3 }]);
    vi.mocked(getReadingHalf).mockResolvedValue(half("discovering"));
    await afterSlackP10Settings(P, S({ slackReadAll: true }), S({ slackReadAll: false }), NOW);
    expect(jobs).toHaveLength(1);   // two calls in one minute → one job
  });
  it("a revoked or absent half → none; unchanged → none (and no half read)", async () => {
    vi.mocked(getReadingHalf).mockResolvedValue(half("revoked"));
    expect(await afterSlackP10Settings(P, S(), S({ slackReadAll: true }), NOW)).toEqual(NONE);
    vi.mocked(getReadingHalf).mockResolvedValue(null);
    expect(await afterSlackP10Settings(P, S(), S({ slackReadAll: true }), NOW)).toEqual(NONE);
    vi.mocked(getReadingHalf).mockClear();
    expect(await afterSlackP10Settings(P, S({ slackReadAll: true }), S({ slackReadAll: true }), NOW)).toEqual(NONE);
    expect(vi.mocked(getReadingHalf)).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });
});

describe("ST06 each switch's side effect", () => {
  it("lead counts on → the 7-day backfill job (settings reason, one attempt)", async () => {
    expect(await afterSlackP10Settings(P, S(), S({ slackLeadCountsEnabled: true }), NOW)).toEqual({ ...NONE, leadBackfill: true });
    expect(jobs).toEqual([{ kind: "exec.slack-lead-count", lane: "bulk", principalId: "ep_1", payload: { reason: "settings" },
      dedupeKey: `slack-lead-count:ep_1:settings:${MINUTE}`, maxAttempts: 1 }]);
  });
  it("lead counts off → the lead rows purged, then the leads stripped from his stored briefs (C23)", async () => {
    expect(await afterSlackP10Settings(P, S({ slackLeadCountsEnabled: true }), S(), NOW)).toEqual({ ...NONE, leadPurged: true });
    expect(vi.mocked(purgeLeadCounts)).toHaveBeenCalledWith(P);
    expect(vi.mocked(stripBriefLeads)).toHaveBeenCalledWith(P);
    expect(vi.mocked(purgeLeadCounts).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stripBriefLeads).mock.invocationCallOrder[0]);
    expect(jobs).toHaveLength(0);
  });
  it("style learning off → the profile deleted; replies off → nothing deleted", async () => {
    expect(await afterSlackP10Settings(P, S({ slackVoiceEnabled: true }), S({ slackVoiceEnabled: false }), NOW)).toEqual({ ...NONE, voiceDropped: true });
    expect(vi.mocked(deleteSlackVoiceProfile)).toHaveBeenCalledWith(P);
    vi.clearAllMocks();
    expect(await afterSlackP10Settings(P, S({ slackRepliesEnabled: true, slackReplySendEnabled: true }), S({ slackRepliesEnabled: false }), NOW)).toEqual(NONE);
    expect(vi.mocked(deleteSlackVoiceProfile)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeLeadCounts)).not.toHaveBeenCalled();
  });
  it("sending on → the token check (v1.1 product-4, C60), two attempts", async () => {
    expect(await afterSlackP10Settings(P, S({ slackRepliesEnabled: true }), S({ slackRepliesEnabled: true, slackReplySendEnabled: true }), NOW))
      .toEqual({ ...NONE, tokenCheck: true });
    expect(jobs).toEqual([{ kind: "exec.slack-reply-token-check", lane: "bulk", principalId: "ep_1", payload: { reason: "settings" },
      dedupeKey: `slack-reply-token-check:ep_1:settings:${MINUTE}`, maxAttempts: 2 }]);
  });
  it("best effort: a failing step logs its code by principal id and never throws; the other steps still run", async () => {
    vi.mocked(purgeLeadCounts).mockRejectedValueOnce(Object.assign(new Error("exec slack leads store: purgeLeadCounts failed (57014)"), { code: "57014" }));
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("exec_jobs enqueue failed (exec.slack-discover): down"));
    const r = await afterSlackP10Settings(P, S({ slackLeadCountsEnabled: true }), S({ slackReadAll: true, slackVoiceEnabled: false }), NOW);
    expect(r).toEqual({ ...NONE, voiceDropped: true });
    expect(vi.mocked(stripBriefLeads)).toHaveBeenCalled();
    expect(logs.map((l) => String(l[0]))).toEqual([
      "[exec-slack-p10] settings side effect rediscover failed for ep_1 (Error)",
      "[exec-slack-p10] settings side effect lead_purge failed for ep_1 (57014)"
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/down|failed \(/);
  });
});
