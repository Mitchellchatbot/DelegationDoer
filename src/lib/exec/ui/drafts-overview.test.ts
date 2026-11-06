import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({
  getPendingApprovals: vi.fn(),
  listActivitySince: vi.fn(),
  listDepartments: vi.fn(),
  listEodNotesForDate: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listTasksByIds: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listTasksCreatedBetween: vi.fn(),
  listTimeEntriesBetween: vi.fn(),
  listUsers: vi.fn(),
  listTasksForThread: vi.fn(),
  listClients: vi.fn(),
  listClientMeetings: vi.fn()
}));
vi.mock("@/lib/exec/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention")>()),
  listAttention: vi.fn(),
  lastAttentionRefresh: vi.fn(),
  syncAttention: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn()
}));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  listBucketRows: vi.fn(),
  listCommitments: vi.fn(),
  listSignalsForMessages: vi.fn(),
  listThreadScreenRows: vi.fn(),
  listTombstonedThreadIds: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn(),
  listAllReplyArtifacts: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn()
}));
vi.mock("@/lib/exec/drafts-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/drafts-store")>()),
  countDraftsForSystem: vi.fn(),
  getVoiceProfile: vi.fn()
}));

import { DraftsRows } from "@/components/exec/overview/SystemSection";
import { lastAttentionRefresh, listAttention } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { countDraftsForSystem, getVoiceProfile, type DraftSystemCounts, type VoiceProfileRow } from "@/lib/exec/drafts-store";
import { DRAFT_JOB_KINDS } from "@/lib/exec/drafts-types";
import { listBucketRows, listCommitments, listSignalsForMessages, listThreadScreenRows, listTombstonedThreadIds } from "@/lib/exec/email-store";
import { EMAIL_TRACKED_JOB_KINDS, TRACKED_JOB_KINDS, getOverview, type ExecOverview, type OverviewDraftsSystem, type OverviewSection } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import * as dd from "@/lib/exec/sources/dd";
import { listAllReplyArtifacts, loadScreeningPolicy, restrictedPolicyHash } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// PX12 (data side) and Y7/Y9 in getOverview: the System card's drafts rows
// are read only once the drafts schema exists, each one fails on its own
// ("couldn't load", never a zero), TRACKED_JOB_KINDS stays as it was (the
// reconcile and voice jobs run only while a row is due, or weekly), and the
// Needs Attention section says when email items may offer "Draft reply".

const NOW = new Date("2026-11-06T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();
const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_owner",
  ...DEFAULT_SETTINGS,
  mutedChannelIds: [],
  emailEnabled: true,
  emailSchemaReady: true,
  ...over
});
const DRAFTS_ON = { draftsSchemaReady: true, draftsEnabled: true, voiceEnabled: true } as const;
const H = restrictedPolicyHash("hidden", []);

const emailItem: AttentionItem = {
  id: "ea_mail",
  principalId: "ep_owner",
  fingerprint: "email:thread:t_ok:t_ok_m",
  source: "email",
  kind: "important_email",
  category: "my_action",
  title: "Reply to Jane",
  whatHappened: "",
  whyItMatters: "",
  recommendedNext: null,
  facts: [],
  refs: [],
  priority: { score: 50, band: "normal", reasons: [] },
  stateHash: "0123456789abcdef",
  occurredAt: null,
  status: "open",
  snoozeUntil: null,
  firstSeenAt: minutesAgo(60),
  lastSeenAt: minutesAgo(1),
  resolvedAt: null,
  resolution: null,
  updatedAt: minutesAgo(1)
};

const COUNTS: DraftSystemCounts = { active: 4, unknown: 1, sentMismatch7d: 0, goneUnconfirmed: 1, generationFailed24h: 2, restrictedLinked: 0, oldestDueAt: null };
const VOICE: VoiceProfileRow = {
  principalId: "ep_owner",
  status: "ready",
  formality: "neutral",
  typicalLength: "short",
  greeting: "first_name",
  paragraphing: "short",
  bullets: "rare",
  emoji: "never",
  signOff: "Thanks",
  sampleCount: 30,
  samplesHash: "a".repeat(64),
  windowDays: 90,
  model: "claude-haiku-5-5",
  promptVersion: "voice-v1",
  builtAt: "2026-11-01T09:00:00.000Z",
  lastAttemptAt: "2026-11-01T09:00:00.000Z",
  lastAttemptError: null,
  updatedAt: "2026-11-01T09:00:00.000Z"
} as unknown as VoiceProfileRow;

let jobsByStatus: Record<string, Record<string, unknown>[]> = {};
let tablesRead: string[] = [];
function fakeAdmin() {
  return {
    from: (table: string) => {
      tablesRead.push(table);
      if (table !== "exec_jobs") throw new Error(`unexpected table ${table}`);
      let status = "";
      const b: Record<string, unknown> = {};
      for (const m of ["select", "gte", "or", "order", "range", "abortSignal", "in", "lt", "not", "is", "limit"]) b[m] = () => b;
      b.eq = (column: string, value: unknown) => {
        if (column === "status") status = String(value);
        return b;
      };
      b.then = <A, B>(ok?: (v: unknown) => A, bad?: (e: unknown) => B) => Promise.resolve({ data: jobsByStatus[status] ?? [], error: null }).then(ok, bad);
      return b;
    }
  };
}

let syncValues: Record<string, unknown>;

beforeEach(() => {
  jobsByStatus = {};
  tablesRead = [];
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAdmin() as unknown as SupabaseClient);
  for (const fn of Object.values(dd)) if (typeof fn === "function" && "mockResolvedValue" in fn) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(listAttention).mockResolvedValue([emailItem]);
  vi.mocked(lastAttentionRefresh).mockResolvedValue(minutesAgo(1));
  vi.mocked(loadSettings).mockResolvedValue(settings(DRAFTS_ON));
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: H });
  vi.mocked(listBucketRows).mockResolvedValue([]);
  vi.mocked(listAllReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(listSignalsForMessages).mockResolvedValue(new Map());
  vi.mocked(listTombstonedThreadIds).mockResolvedValue([]);
  vi.mocked(listCommitments).mockResolvedValue([]);
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) =>
    new Map(
      ids.map((id) => [id, { threadId: id, accountId: "acc_his", state: "triaged" as const, screenHashes: [], screenTruncated: false, screenedPolicyHash: H }])
    )
  );
  vi.mocked(countDraftsForSystem).mockResolvedValue(COUNTS);
  vi.mocked(getVoiceProfile).mockResolvedValue(VOICE);
  syncValues = {
    accounts: { value: { checkedAt: minutesAgo(1), accounts: [{ id: "acc_his", email: "mitchell@scaledai.org", lastSyncedAt: minutesAgo(1), lastSyncError: null, lastSyncErrorAt: null }], problems: [] }, rev: 1 },
    socket: { value: { connected: true, lastEventAt: null, observedAt: minutesAgo(0.5) }, rev: 1 },
    "ea-token": {
      value: { ok: true, reason: null, checkedAt: minutesAgo(2), cl2Ready: true, cl2Send: "some", sendEnabled: true, expiresAt: "2027-02-01T00:00:00.000Z", tokenFp: "abcdef012345" },
      rev: 1
    }
  };
  vi.mocked(getSyncState).mockImplementation(async (_p, _s, key) => {
    const v = syncValues[key];
    if (v instanceof Error) throw v;
    return (v ?? null) as never;
  });
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function data<T>(s: OverviewSection<T>): T {
  if (!s.ok) throw new Error("expected the section to load");
  return s.data;
}
async function draftsOf(o: ExecOverview): Promise<OverviewDraftsSystem | null | undefined> {
  return data(o.sections.system).drafts;
}

describe("PX12: the System card's drafts fields (getOverview)", () => {
  it("before the drafts schema exists: no drafts rows, no drafts read, no Draft reply on attention items", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings());
    const o = await getOverview(principal, NOW);
    expect(await draftsOf(o)).toBeUndefined();
    expect(countDraftsForSystem).not.toHaveBeenCalled();
    expect(getVoiceProfile).not.toHaveBeenCalled();
    expect(vi.mocked(getSyncState).mock.calls.map((c) => c[2])).not.toContain("ea-token");
    expect(data(o.sections.attention).draftsEnabled).toBeUndefined();
  });

  it("installed and on: every verdict, count and the voice row; email items may offer Draft reply", async () => {
    jobsByStatus = { succeeded: [{ id: 1, kind: DRAFT_JOB_KINDS.reconcile, finished_at: minutesAgo(4) }] };
    const o = await getOverview(principal, NOW);
    const d = await draftsOf(o);
    expect(d).toEqual({
      installed: true,
      draftsEnabled: true,
      sendEnabled: false,
      voiceEnabled: true,
      eaToken: { ok: true, reason: null, checkedAt: minutesAgo(2), expiresAt: "2027-02-01T00:00:00.000Z" },
      sendToken: { ok: false, reason: "not_checked", checkedAt: null, expiresAt: null },
      cl2: { ready: true, send: "some" },
      counts: COUNTS,
      reconcile: { lastSucceededAt: minutesAgo(4), overdueSince: null },
      voice: { status: "ready", builtAt: VOICE.builtAt, lastAttemptAt: VOICE.lastAttemptAt, lastAttemptError: null }
    });
    expect(data(o.sections.attention).draftsEnabled).toBe(true);
    // Codes, counts and times only: nothing but exec_jobs goes through the admin client here.
    expect(new Set(tablesRead)).toEqual(new Set(["exec_jobs"]));
  });

  it("drafts installed but switched off: the rows say off; email items offer no Draft reply", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ draftsSchemaReady: true, draftsEnabled: false, sendEnabled: true }));
    const o = await getOverview(principal, NOW);
    const d = await draftsOf(o);
    expect(d?.draftsEnabled).toBe(false);
    expect(d?.sendEnabled).toBe(false);
    expect(data(o.sections.attention).draftsEnabled).toBeUndefined();
  });

  it("each field fails on its own: a failed count, voice or token read is null, the rest still show", async () => {
    vi.mocked(countDraftsForSystem).mockRejectedValue(new Error("exec_drafts read failed"));
    vi.mocked(getVoiceProfile).mockRejectedValue(new Error("exec_voice_profile read failed"));
    syncValues["ea-token"] = new Error("exec_sync_state read failed");
    const o = await getOverview(principal, NOW);
    const d = await draftsOf(o);
    expect(d).not.toBeNull();
    expect(d?.counts).toBeNull();
    expect(d?.reconcile).toBeNull();
    expect(d?.voice).toBeNull();
    expect(d?.eaToken).toBeNull();
    expect(d?.cl2).toEqual({ ready: null, send: null });
    expect(d?.sendToken).toEqual({ ok: false, reason: "not_checked", checkedAt: null, expiresAt: null });
    expect(d?.draftsEnabled).toBe(true);
    // The rest of the card still loads.
    expect(data(o.sections.system).kinds.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(createElement(DraftsRows, { drafts: d ?? null, now: NOW.toISOString(), tz: "America/New_York" }));
    // The Draft token, Clone (the same failed clone-ea/ea-token read, ui-7), attention, checks and voice rows.
    expect(html.match(/couldn&#x27;t load/g)?.length).toBe(5);
    const cloneRow = html.match(/<li data-drafts-row="clone"[^>]*>(.*?)<\/li>/)?.[1] ?? "";
    expect(cloneRow).toContain("couldn&#x27;t load");
    expect(cloneRow).not.toContain("not checked yet");
    expect(html).not.toMatch(/>0 unknown/);
  });

  it("TRACKED_JOB_KINDS gains neither the reconcile nor the voice job: with drafts on and no run for 48 h, no amber", async () => {
    for (const kind of [DRAFT_JOB_KINDS.reconcile, DRAFT_JOB_KINDS.voice]) {
      expect(TRACKED_JOB_KINDS).not.toContain(kind);
      expect(EMAIL_TRACKED_JOB_KINDS).not.toContain(kind);
    }
    const o = await getOverview(principal, NOW);
    const sys = data(o.sections.system);
    expect(sys.kinds.map((k) => k.kind)).toEqual([...TRACKED_JOB_KINDS, ...EMAIL_TRACKED_JOB_KINDS]);
    const html = renderToStaticMarkup(createElement(DraftsRows, { drafts: sys.drafts ?? null, now: NOW.toISOString(), tz: "America/New_York" }));
    const checks = /<li[^>]*data-drafts-row="checks"[^]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(checks).toContain("no run in the last 48 h");
    expect(checks).not.toContain("text-amber-700");
  });

  it("a check due for more than 15 minutes with no reconcile success since turns the Draft checks row amber", async () => {
    vi.mocked(countDraftsForSystem).mockResolvedValue({ ...COUNTS, oldestDueAt: minutesAgo(20) });
    jobsByStatus = { succeeded: [{ id: 1, kind: DRAFT_JOB_KINDS.reconcile, finished_at: minutesAgo(30) }] };
    const o = await getOverview(principal, NOW);
    const d = await draftsOf(o);
    expect(d?.reconcile).toEqual({ lastSucceededAt: minutesAgo(30), overdueSince: minutesAgo(20) });
    const html = renderToStaticMarkup(createElement(DraftsRows, { drafts: d ?? null, now: NOW.toISOString(), tz: "America/New_York" }));
    const checks = /<li[^>]*data-drafts-row="checks"[^]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(checks).toContain("text-amber-700");
  });

  it("a voice profile that failed shows last_attempt_error, and one never built shows as such", async () => {
    vi.mocked(getVoiceProfile).mockResolvedValue({ ...VOICE, status: "failed", lastAttemptError: "read_failed" } as VoiceProfileRow);
    const failed = await draftsOf(await getOverview(principal, NOW));
    expect(failed?.voice).toEqual({ status: "failed", builtAt: null, lastAttemptAt: VOICE.lastAttemptAt, lastAttemptError: "read_failed" });
    vi.mocked(getVoiceProfile).mockResolvedValue(null);
    const none = await draftsOf(await getOverview(principal, NOW));
    expect(none?.voice).toEqual({ status: null, builtAt: null, lastAttemptAt: null, lastAttemptError: null });
  });
});
