import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/sources/dd-text", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig(), ["submittedTextIsCurrent"]));
vi.mock("@/lib/exec/sources/mail", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy", "readPrincipalThread", "loadHisBodies", "listAllReplyArtifacts", "searchPrincipalThreads"])
);
vi.mock("@/lib/exec/email-store", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listBucketRows", "listCommitments", "listSignalsForMessages", "listThreadScreenRows"])
);
vi.mock("@/lib/exec/sync-state", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getSyncState"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
// P7a fixer ui-2: the Slack reading state (the chat's Slack source).
vi.mock("@/lib/exec/slack-reading", () => ({ getSlackReadingState: vi.fn() }));
vi.mock("@/lib/exec/team", () => ({ getTeamView: vi.fn(), getWorkingNow: vi.fn() }));
vi.mock("@/lib/exec/projects-view", () => ({ getProjectsListView: vi.fn(), getProjectDetail: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({
  loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn(), intakeThreadIdsForTasks: vi.fn(), listScreenedApprovalItems: vi.fn()
}));
vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ insertProposal: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ createChatReplyDraft: vi.fn() }));
// Area C's real neutralizeTaskText (chat/answer.ts) runs unmocked.

import { overviewWindow } from "@/lib/exec/agent/tools";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import { getSlackReadingState } from "@/lib/exec/slack-reading";
import { listBucketRows } from "@/lib/exec/email-store";
import { intakeThreadIdsForTasks, listScreenedApprovalItems, restrictedIntakeTaskIds, loadIntakeScreeningPolicy } from "@/lib/exec/intake-screen";
import { getOverview, type ExecOverview } from "@/lib/exec/overview";
import { getProjectDetail, getProjectsListView } from "@/lib/exec/projects-view";
import { ddPageRef, ddProjectRef, ddTaskRef, execEmailThreadRef } from "@/lib/exec/refs";
import {
  getPendingApprovals,
  listDepartments,
  listIncidentLogsSince,
  listOpenTasks,
  listTaskExtensionsForTasks,
  listTaskExtensionsSince,
  listTasksByIds,
  listTasksCompletedBetween,
  listTasksCreatedBetween,
  listUsers,
  listUserSchedules
} from "@/lib/exec/sources/dd";
import { getTaskDescriptions, listSubmittedNotesText, listTaskMessagesText, listTaskTimelineText, type SubmittedNoteText } from "@/lib/exec/sources/dd-text";
import { getTeamView, getWorkingNow } from "@/lib/exec/team";
import { CLIP_MARKER } from "@/lib/exec/text/untrusted";
import type { Cell, CountsValue, ProjectDetailView, ProjectListRow, TeamDepartmentRow, TeamPersonRow, TeamView } from "@/lib/exec/view-types";
import { DEPARTMENTS, feedItem, installDefaults, makeCtx, NOW, principal, runTool, schedule, settings, task, user, USERS } from "./__tests__/b-tools-harness";

// P5b contract §3.11.3 tools 1-8 and 13 against fakes of every source (tests 19-26, 31, 112, 122-125, 127).

beforeEach(() => {
  installDefaults();
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "not_consented", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
});

const counts = (over: Partial<CountsValue> = {}): Cell<CountsValue> => ({
  ok: true,
  value: { open: 3, inProgress: 1, overdue: 1, overdueAutoArchived: 0, stalled: 0, waitingOnClient: 0, pendingApproval: 0, pendingApprovalPastDue: 0, ...over }
});
const rate = (x: number, n: number) => ({ ok: true as const, value: { x, n, rate: n === 0 ? null : x / n, tooFew: n < 5 } });

function personRow(over: Partial<TeamPersonRow> & { userId: string; name: string }): TeamPersonRow {
  return {
    role: "worker",
    isLeader: false,
    primaryDepartmentId: "d_seo",
    departmentIds: ["d_seo"],
    counts: counts(),
    completed: { ok: true, value: { thisWeek: 1, lastWeek: 2, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: 0, closedWithStage: 0, taskIds: [] } },
    capacity: { ok: true, value: { kind: "load", usedHours: 4, backlogHours: 2, pct: 50, todayHours: 4, overSoft: false, overBuffer: false, autoArchivedExcluded: 0 } },
    eod: { ok: true, value: { kind: "rate", otherDaysSubmitted: 0, x: 18, n: 20, rate: 0.9, tooFew: false } },
    onTime: rate(9, 10),
    cycle: { ok: true, value: { n: 10, medianHours: 20, tooFew: false } },
    extensions: rate(1, 10),
    ref: ddPageRef(`/team/${over.userId}`, over.name),
    ...over
  };
}

function deptRow(over: Partial<TeamDepartmentRow> & { departmentId: string; name: string }): TeamDepartmentRow {
  return {
    headUserId: null,
    people: 2,
    counts: counts(),
    completed: { ok: true, value: { thisWeek: 1, lastWeek: 2, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: 0, closedWithStage: 0, taskIds: [] } },
    capacity: { ok: true, value: { usedHours: 8, backlogHours: 2, todayHours: 8, offToday: 0 } },
    eod: rate(10, 12),
    onTime: rate(9, 10),
    cycle: { ok: true, value: { n: 10, medianHours: 20, tooFew: false } },
    extensions: rate(1, 10),
    pool: null,
    ...over
  };
}

function teamView(people: TeamPersonRow[], departments: TeamDepartmentRow[], window: TeamView["window"]["key"] = "this_week"): TeamView {
  return {
    generatedAt: NOW.toISOString(),
    timezone: "America/New_York",
    windows: { thisWeekStart: "2026-11-02T05:00:00.000Z", lastWeekStart: "2026-10-26T04:00:00.000Z", indicatorsFrom: "2026-10-05T04:00:00.000Z", eodFromYmd: "2026-10-05", eodToYmd: "2026-11-03" },
    window: { key: window, fromIso: "2026-11-02T05:00:00.000Z", toIso: NOW.toISOString() },
    people: { ok: true, data: people },
    departments: { ok: true, data: departments },
    unowned: { ok: false, error: "unavailable" }
  };
}

// ---------------------------------------------------------------------------
// 1. get_overview (tests 19, 125)
// ---------------------------------------------------------------------------

function overviewFixture(): ExecOverview {
  return {
    generatedAt: NOW.toISOString(),
    timezone: "America/New_York",
    sections: {
      tiles: {
        ok: true,
        data: {
          localDate: "2026-11-04",
          eodDate: "2026-11-04",
          completedToday: { ok: true, data: { count: 3, basis: "record", last7Days: [] } },
          createdToday: { ok: true, data: { count: 5, basis: "record" } },
          openOverdue: { ok: true, data: { count: 4, basis: "derived", autoArchived: 1 } },
          activePeople: { ok: false, error: "unavailable" },
          eodSubmitted: { ok: true, data: { count: 7, basis: "record" } },
          hoursLogged: { ok: true, data: { hours: 12.5, clockedIn: 2, basis: "record" } }
        }
      },
      attention: { ok: false, error: "unavailable" },
      approvals: { ok: true, data: { buckets: [{ mechanism: "draft_tasks", count: 2, oldestAt: "2026-11-01T00:00:00.000Z" }, { mechanism: "checkins", count: 1, oldestAt: null }], total: 3 } },
      deadlines: { ok: false, error: "unavailable" },
      projects: {
        ok: true,
        data: {
          items: [
            { projectId: "p_site", name: "Zenith Site Rebuild", status: "off_track", reasons: ["3 tasks overdue"], stageProgress: { done: 1, total: 4 }, openTasks: 6, undispatchedTasks: 0, overdueTasks: 3, stalledTasks: 0, waitingOnClient: 0, lastActivityAt: null, basis: "derived" },
            { projectId: "p_ok", name: "Fine", status: "on_track", reasons: [], stageProgress: { done: 2, total: 2 }, openTasks: 1, undispatchedTasks: 0, overdueTasks: 0, stalledTasks: 0, waitingOnClient: 0, lastActivityAt: null, basis: "derived" }
          ],
          total: 2,
          limit: 8
        }
      },
      system: { ok: true, data: { kinds: [{ kind: "exec.purge", lastSuccessAt: null, dead24h: 0 }, { kind: "exec.dd-attention", lastSuccessAt: NOW.toISOString(), dead24h: 0 }], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null } },
      email: { ok: false, error: "unavailable" }
    }
  } as ExecOverview;
}

describe("get_overview (tests 19, 125)", () => {
  it("windows: today, yesterday, last_24h and last_7_days in his zone, across the DST change", () => {
    const tz = "America/New_York";
    expect(overviewWindow("today", NOW, tz)).toEqual({ from: new Date("2026-11-04T05:00:00.000Z"), to: NOW });
    expect(overviewWindow("yesterday", NOW, tz)).toEqual({ from: new Date("2026-11-03T05:00:00.000Z"), to: new Date("2026-11-04T05:00:00.000Z") });
    expect(overviewWindow("last_24h", NOW, tz)).toEqual({ from: new Date("2026-11-03T15:00:00.000Z"), to: NOW });
    // Nov 1 2026 ends daylight time: six local days back from Nov 4 is Oct 29, 00:00 EDT (04:00Z).
    expect(overviewWindow("last_7_days", NOW, tz)).toEqual({ from: new Date("2026-10-29T04:00:00.000Z"), to: NOW });
    const monday = new Date("2026-11-02T15:00:00.000Z");
    expect(overviewWindow("yesterday", monday, tz).from).toEqual(new Date("2026-11-01T04:00:00.000Z"));
  });

  it("a throwing read voids only its section, named in unavailable; email off reads no bucket", async () => {
    vi.mocked(getOverview).mockResolvedValue(overviewFixture());
    vi.mocked(listTasksCompletedBetween).mockResolvedValue([task({ id: "t_done", title: "Shipped", status: "done", completedAt: "2026-11-04T14:00:00.000Z" })]);
    vi.mocked(listTasksCreatedBetween).mockRejectedValue(new Error("boom"));
    const r = await runTool(makeCtx({ settings: settings({ emailEnabled: false }) }), "get_overview", { since: "today" });
    expect(r.isError).toBe(false);
    const now = r.json.now as Record<string, unknown>;
    expect(now.overdue_open).toEqual({ count: 4, auto_archived: 1, basis: "derived" });
    expect(now.today).toEqual({ completed: 3, created: 5, active_people: "unavailable", eod_submitted: 7, hours_logged: 12.5 });
    const activity = r.json.window_activity as Record<string, unknown>;
    expect(activity.created).toBe("unavailable");
    expect((activity.completed as { total: number }).total).toBe(1);
    expect(r.json.unavailable).toEqual(expect.arrayContaining(["created", "today.active_people"]));
    expect(r.json.sources).toEqual({ dd: "connected", email: "off", slack: "not_connected" });
    // Fixer ui-2: the Slack source is the reading state's (set up → its state; unreadable → unavailable).
    vi.mocked(getSlackReadingState).mockResolvedValueOnce({ state: "on", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect((await runTool(makeCtx({ settings: settings({ emailEnabled: false }) }), "get_overview", { since: "today" })).json.sources).toMatchObject({ slack: "on" });
    vi.mocked(getSlackReadingState).mockRejectedValueOnce(new Error("boom"));
    expect((await runTool(makeCtx({ settings: settings({ emailEnabled: false }) }), "get_overview", { since: "today" })).json.sources).toMatchObject({ slack: "unavailable" });
    expect(now).not.toHaveProperty("email_buckets");
    expect(vi.mocked(listBucketRows)).not.toHaveBeenCalled();
    const projects = now.projects_needing_attention as { items: { name: string; status: string }[]; total: number };
    expect(projects.items.map((p) => p.status)).toEqual(["off_track"]);
    expect((now.approvals as { mechanism: string; ref: string | null }[]).map((a) => [a.mechanism, a.ref === null])).toEqual([
      ["draft_tasks", false],
      ["checkins", true]
    ]);
    expect((r.json.system as { stale_jobs: { kind: string }[] }).stale_jobs.map((k) => k.kind)).toEqual(["exec.purge"]);
  });

  it("new_attention: firstSeenAfter = the window start, the upper bound in memory, a 5th page with a cursor is a lower bound", async () => {
    vi.mocked(getOverview).mockResolvedValue(overviewFixture());
    vi.mocked(listScreenedAttention).mockImplementation(async (_p, filters) => ({
      items: [
        feedItem({ id: `ea_${String(filters.cursor ?? "0").padStart(32, "0")}`, firstSeenAt: "2026-11-03T12:00:00.000Z" }),
        feedItem({ id: `ea_${String(filters.cursor ?? "0").padStart(31, "0")}9`, firstSeenAt: "2026-11-04T06:00:00.000Z" })
      ],
      nextCursor: `${Number(filters.cursor ?? 0) + 1}`,
      hiddenEmail: 1,
      emailScreen: "ok"
    }));
    const r = await runTool(makeCtx({ settings: settings({ emailEnabled: false }) }), "get_overview", { since: "yesterday" });
    const calls = vi.mocked(listScreenedAttention).mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls[0][1]).toMatchObject({ firstSeenAfter: "2026-11-03T05:00:00.000Z", limit: 50 });
    const na = (r.json.window_activity as Record<string, unknown>).new_attention as Record<string, unknown>;
    expect(na.total).toBe(5);
    expect(na.truncated).toBe(true);
    expect(na.total_is_lower_bound).toBe(true);
    expect(na.email_hidden).toBe(5);
    expect(na.email_screen).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2. list_attention (tests 20, 122)
// ---------------------------------------------------------------------------

describe("list_attention (tests 20, 122)", () => {
  it("maps status and drops the any filters before the accessor", async () => {
    await runTool(makeCtx(), "list_attention", { status: "active", category: "any", band: "any", source: "any", limit: 10 });
    expect(vi.mocked(listScreenedAttention).mock.calls[0][1]).toEqual({ limit: 10 });
    await runTool(makeCtx(), "list_attention", { status: "snoozed", category: "approval", band: "critical", source: "email", limit: 25 });
    expect(vi.mocked(listScreenedAttention).mock.calls[1][1]).toEqual({ status: "snoozed", category: "approval", band: "critical", source: "email", limit: 25 });
  });

  it("source slack → empty with the note, no accessor call", async () => {
    const r = await runTool(makeCtx(), "list_attention", { status: "active", category: "any", band: "any", source: "slack", limit: 10 });
    expect(vi.mocked(listScreenedAttention)).not.toHaveBeenCalled();
    expect((r.json.items as { items: unknown[] }).items).toEqual([]);
    // P7b (fact (e)): the note says only what is true (reading isn't on), never "isn't connected yet".
    expect(r.json.notes).toContain("Slack reading isn't on, so there are no Slack items. Say so; don't guess about Slack.");
  });

  it("(fixer ui-2) source slack once reading is set up → the Slack Needs Attention items through the screen, no 'isn't connected' note", async () => {
    for (const state of ["on", "paused", "discovering", "error"] as const) {
      vi.mocked(listScreenedAttention).mockClear();
      vi.mocked(getSlackReadingState).mockResolvedValue({ state, discoveredAt: null, lastSweepAt: null, lastEventAt: null });
      vi.mocked(listScreenedAttention).mockResolvedValue({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" } as never);
      const r = await runTool(makeCtx(), "list_attention", { status: "active", category: "any", band: "any", source: "slack", limit: 10 });
      expect(vi.mocked(listScreenedAttention).mock.calls[0][1], state).toEqual({ source: "slack", limit: 10 });
      expect(r.json.notes ?? [], state).not.toContain("Slack reading isn't on, so there are no Slack items. Say so; don't guess about Slack.");
    }
  });

  it("(fixer security-4) a Slack DM turn screens as surface slack (finance Slack items are never relayed into Slack); a web turn as web", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" } as never);
    await runTool({ ...makeCtx(), surface: "slack" }, "list_attention", { status: "active", category: "any", band: "any", source: "any", limit: 10 });
    expect(vi.mocked(listScreenedAttention).mock.calls[0][2]).toMatchObject({ surface: "slack" });
    await runTool(makeCtx(), "list_attention", { status: "active", category: "any", band: "any", source: "any", limit: 10 });
    expect(vi.mocked(listScreenedAttention).mock.calls[1][2]).toMatchObject({ surface: "web" });
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: false, reason: "withheld" } as never);
    const contexts = [{ ref: "r1", target: { type: "attention" as const, id: "ea_" + "a".repeat(32), threadId: null }, source: ddPageRef("/executive", "Needs Attention") }];
    await runTool({ ...makeCtx({ refSeq: 1, contexts }), surface: "slack" }, "get_source", { ref: "r1" });
    expect(vi.mocked(getScreenedAttentionItem).mock.calls[0][2]).toMatchObject({ surface: "slack" });
    await runTool(makeCtx({ refSeq: 1, contexts }), "get_source", { ref: "r1" });
    expect(vi.mocked(getScreenedAttentionItem).mock.calls[1][2]).toMatchObject({ surface: "web" });
  });

  it("email_screen unavailable passes through with its note; refs and excerpts", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: [feedItem({ id: "ea_" + "1".repeat(32) })], nextCursor: "next", hiddenEmail: 4, emailScreen: "unavailable" });
    const r = await runTool(makeCtx(), "list_attention", { status: "active", category: "any", band: "any", source: "any", limit: 10 });
    expect(r.json.email_screen).toBe("unavailable");
    expect(r.json.email_hidden).toBe(4);
    expect(r.json.more).toBe(true);
    expect(r.json.notes).toContain("Email items couldn't be screened just now, so none are shown; say email couldn't be checked.");
    const item = (r.json.items as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ title: "Two tasks are overdue", what_happened: "Two SEO tasks passed their due date.", suggested_next: "Ask Ann for a new date.", band: "high" });
    expect(r.all).not.toContain("SECRET EXCERPT");
  });
});

// ---------------------------------------------------------------------------
// 3. team_progress (tests 21, 112, 123, 124, 127)
// ---------------------------------------------------------------------------

describe("team_progress", () => {
  it("progress: person rows in NAME order, too_few, Cell ok:false → unavailable, indicators and EOD windows (tests 21, 123)", async () => {
    vi.mocked(getTeamView).mockResolvedValue(
      teamView(
        [
          personRow({ userId: "u_bob", name: "Bob Stone", primaryDepartmentId: "d_web", departmentIds: ["d_web"], counts: counts({ open: 1 }), onTime: rate(1, 2) }),
          personRow({ userId: "u_ann", name: "Ann Lee", counts: counts({ open: 9 }), cycle: { ok: false } }),
          personRow({ userId: "u_ana", name: "Ana Diaz", primaryDepartmentId: "d_web", departmentIds: ["d_web", "d_seo"], counts: counts({ open: 5 }) })
        ],
        []
      )
    );
    const r = await runTool(makeCtx(), "team_progress", { view: "progress", window: "last_30_days", group_by: "person", department: "" });
    expect(vi.mocked(getTeamView).mock.calls[0][1]).toMatchObject({ window: "last_30_days", now: NOW });
    const rows = (r.json.rows as { items: Record<string, unknown>[] }).items;
    expect(rows.map((x) => x.name)).toEqual(["Ana Diaz", "Ann Lee", "Bob Stone"]);
    expect(rows[2].on_time).toBe("too_few");
    expect(rows[0].on_time).toEqual({ value: 0.9, n: 10 });
    expect(rows[1].typical_turnaround_hours).toBe("unavailable");
    expect(r.json.unavailable).toEqual(["typical_turnaround_hours (Ann Lee)"]);
    expect(rows[0]).not.toHaveProperty("completed");
    expect(r.json.indicators_window).toMatchObject({ from: expect.stringContaining("2026-10-05T04:00:00.000Z") });
    expect(r.json.eod_window).toEqual({ from: "2026-10-05", to: "2026-11-03" });
    expect(String(r.json.notes)).toContain("There is no ranking or score.");
  });

  it("department rows: completed.total equals completedInWindow.count, items are its taskIds (≤ 25, in order); person rows get completed with a department (test 123)", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `t_c${String(i).padStart(2, "0")}`);
    vi.mocked(listTasksByIds).mockImplementation(async (_p, wanted) => wanted.map((id) => task({ id, title: `Done ${id}`, status: "done", completedAt: "2026-11-03T10:00:00.000Z" })));
    for (const window of ["this_week", "last_30_days"] as const) {
      vi.mocked(getTeamView).mockResolvedValue(
        teamView(
          [personRow({ userId: "u_ann", name: "Ann Lee", completedInWindow: { ok: true, value: { count: 3, closedWithStage: 0, taskIds: ids.slice(0, 3) } } })],
          [deptRow({ departmentId: "d_seo", name: "SEO", completedInWindow: { ok: true, value: { count: 31, closedWithStage: 2, taskIds: ids } } }), deptRow({ departmentId: "d_web", name: "Website" })],
          window
        )
      );
      const r = await runTool(makeCtx(), "team_progress", { view: "progress", window, group_by: "department", department: "" });
      const rows = r.json.rows as Record<string, unknown>[];
      const seo = rows[0].completed as { items: { title: string }[]; total: number; truncated: boolean };
      expect(seo.total).toBe(31);
      expect(seo.truncated).toBe(true);
      expect(seo.items.map((x) => x.title)).toEqual(ids.slice(0, 25).map((id) => `Done ${id}`));
      expect(rows[0].finished_in_window).toBe(31);
      expect(r.json.notes).toContain("2 tasks closed with their stage aren't counted.");
      expect((rows[1].completed as { truncated: boolean }).truncated).toBe(false);
    }
    const withDept = await runTool(makeCtx(), "team_progress", { view: "progress", window: "this_week", group_by: "person", department: "SEO" });
    const ann = (withDept.json.rows as { items: Record<string, unknown>[] }).items[0];
    expect((ann.completed as { total: number; items: unknown[] }).total).toBe(3);
  });

  it("department filter, ambiguous department → needs_choice, a missing one → not_found, a prefix → resolved note", async () => {
    vi.mocked(getTeamView).mockResolvedValue(teamView([personRow({ userId: "u_ann", name: "Ann Lee" }), personRow({ userId: "u_bob", name: "Bob Stone", departmentIds: ["d_web"] })], []));
    const seo = await runTool(makeCtx(), "team_progress", { view: "progress", window: "this_week", group_by: "person", department: "d_seo" });
    expect((seo.json.rows as { items: { name: string }[] }).items.map((x) => x.name)).toEqual(["Ann Lee"]);
    const web = await runTool(makeCtx(), "team_progress", { view: "progress", window: "this_week", group_by: "person", department: "Web" });
    expect(web.json.resolved).toEqual([{ param: "department", by: "prefix", name: "Website" }]);
    expect(web.json.notes).toContain("Took 'Web' to mean Website; say so in the answer.");
    vi.mocked(listDepartments).mockResolvedValue([...DEPARTMENTS, { id: "d_seo2", name: "SEO Ops", headUserId: null }]);
    const amb = await runTool(makeCtx(), "team_progress", { view: "progress", window: "this_week", group_by: "person", department: "SE" });
    expect(amb.json.needs_choice).toMatchObject({ param: "department", matches: [{ id: "d_seo", name: "SEO" }, { id: "d_seo2", name: "SEO Ops" }] });
    const none = await runTool(makeCtx(), "team_progress", { view: "progress", window: "this_week", group_by: "person", department: "Finance" });
    expect(none.record.error).toBe("not_found");
    expect(none.text).toBe("Nothing matches 'Finance' for department. Check the spelling or search first.");
  });

  it("working_now: getWorkingNow plus SOD on each person's own date; unsubmitted absent; text wrapped and clipped; edited → no text (tests 21, 124, 127)", async () => {
    vi.mocked(listUsers).mockResolvedValue([...USERS, user({ id: "u_kiri", name: "Kai Kiri", workTimezone: "Pacific/Kiritimati" })]);
    vi.mocked(getWorkingNow).mockResolvedValue({
      generatedAt: NOW.toISOString(),
      rows: [
        { userId: "u_kiri", name: "Kai Kiri", primaryDepartmentId: "d_seo", clockedInSince: "2026-11-04T13:00:00.000Z", clockTaskId: "t_1", inProgress: [] },
        { userId: "u_ann", name: "Ann Lee", primaryDepartmentId: "d_seo", clockedInSince: null, clockTaskId: null, inProgress: [{ taskId: "t_1", title: "One", dueDate: null, ref: ddTaskRef({ id: "t_1" }) }] },
        { userId: "u_bob", name: "Bob Stone", primaryDepartmentId: "d_web", clockedInSince: null, clockTaskId: null, inProgress: [] }
      ]
    });
    const note = (userId: string, noteDate: string, over: Partial<SubmittedNoteText> = {}): SubmittedNoteText => ({
      kind: "sod",
      id: `sod_${userId}`,
      userId,
      noteDate,
      submittedAt: "2026-11-04T13:30:00.000Z",
      reviewedAt: null,
      editedAfterSubmit: false,
      fields: [
        { label: "Top priority", text: "Finish the audit " + "x".repeat(2000) },
        { label: "Tasks planned", text: "Audit" },
        { label: "Blockers", text: "SECRET BLOCKER" }
      ],
      ...over
    });
    vi.mocked(listSubmittedNotesText).mockResolvedValue([note("u_ann", "2026-11-04"), note("u_kiri", "2026-11-05", { editedAfterSubmit: true, fields: [] })]);
    const ctx = makeCtx();
    const r = await runTool(ctx, "team_progress", { view: "working_now", window: "this_week", group_by: "person", department: "" });
    expect(vi.mocked(getWorkingNow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getTeamView)).not.toHaveBeenCalled();
    expect(vi.mocked(listSubmittedNotesText).mock.calls[0][1]).toEqual({
      kind: "sod",
      pairs: [
        { userId: "u_ann", noteDate: "2026-11-04" },
        { userId: "u_bob", noteDate: "2026-11-04" },
        { userId: "u_kiri", noteDate: "2026-11-05" }
      ]
    });
    const people = (r.json.people as { items: Record<string, unknown>[] }).items;
    expect(people.map((p) => p.name)).toEqual(["Ann Lee", "Bob Stone", "Kai Kiri"]);
    expect(people[1].sod).toBeNull();
    expect(people[2].sod).toMatchObject({ edited_after_submission: true });
    expect(people[2].clocked_in).toMatchObject({ task_ref: expect.stringMatching(/^r\d+$/) });
    const annSod = people[0].sod as { text: string; ref: string };
    expect(annSod.text).toBe("U1");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toContain('kind="sod_note"');
    expect(r.blocks[0]).toContain("Top priority: Finish the audit");
    expect(r.blocks[0]).toContain(CLIP_MARKER);
    expect(r.blocks[0]).not.toContain("SECRET BLOCKER");
    expect(r.json.notes).toContain("Edited after submission; not shown until it is submitted again.");
    expect(ctx.markDdText).toHaveBeenCalled();
    expect(ctx.refs.isCitable(annSod.ref)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. search_tasks (tests 22, 112)
// ---------------------------------------------------------------------------

describe("search_tasks (tests 22, 112)", () => {
  const base = { query: "", assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 10 };
  const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

  beforeEach(() => {
    vi.mocked(listOpenTasks).mockResolvedValue([
      task({ id: "t_1", title: "Fix sitemap for Acme", assigneeId: "u_ann", clientName: "Acme Dental", lastActivityAt: iso(1) }),
      task({ id: "t_2", title: "Sitemap audit", assigneeId: "u_mitchell", clientName: "Acme Dental Group", lastActivityAt: iso(2) }),
      task({ id: "t_3", title: "Waiting on logins", status: "waiting_on_client", assigneeId: null, lastActivityAt: iso(9) }),
      task({ id: "t_4", title: "Idle work", status: "in_progress", lastActivityAt: iso(9) }),
      task({ id: "t_5", title: "Old overdue", dueDate: iso(5), archivedAt: iso(1), archivedBy: null, lastActivityAt: iso(1) }),
      task({ id: "t_6", title: "Team pool task", assigneeId: null, departmentId: "d_web", tags: ["auto-team"], lastActivityAt: iso(3) })
    ]);
  });

  it("all query words; assignee me / unassigned / a name; client by exact name (a near-miss excluded)", async () => {
    const words = await runTool(makeCtx(), "search_tasks", { ...base, query: "sitemap acme" });
    expect((words.json.items as { items: { id: string }[] }).items.map((t) => t.id)).toEqual(["t_1"]);
    const me = await runTool(makeCtx(), "search_tasks", { ...base, assignee: "me" });
    expect((me.json.items as { items: { id: string }[] }).items.map((t) => t.id)).toEqual(["t_2"]);
    const un = await runTool(makeCtx(), "search_tasks", { ...base, assignee: "unassigned" });
    expect((un.json.items as { items: { id: string; assignee: string | null }[] }).items.map((t) => [t.id, t.assignee])).toEqual([
      ["t_6", "team: Website"],
      ["t_3", null]
    ]);
    const ann = await runTool(makeCtx(), "search_tasks", { ...base, assignee: "Ann Lee" });
    expect(ann.json.total).toBe(3);
    const client = await runTool(makeCtx(), "search_tasks", { ...base, client: "Acme Dental" });
    expect((client.json.items as { items: { id: string }[] }).items.map((t) => t.id)).toEqual(["t_1"]);
  });

  it("an ambiguous assignee → needs_choice; a prefix assignee is taken with the resolved note", async () => {
    const amb = await runTool(makeCtx(), "search_tasks", { ...base, assignee: "An" });
    expect(amb.json.needs_choice).toMatchObject({ param: "assignee", matches: [{ id: "u_ana", name: "Ana Diaz" }, { id: "u_ann", name: "Ann Lee" }] });
    expect(amb.json.note).toBe("Several match 'An'. Ask him which one, or call again with the id.");
    const pre = await runTool(makeCtx(), "search_tasks", { ...base, assignee: "Bob S" });
    expect(pre.json.resolved).toEqual([{ param: "assignee", by: "prefix", name: "Bob Stone" }]);
  });

  it("stalled = isStalledWork (waiting on the client 9 days is not stalled); overdue includes auto-archived with the note", async () => {
    const stalled = await runTool(makeCtx(), "search_tasks", { ...base, status: "stalled" });
    expect((stalled.json.items as { items: { id: string }[] }).items.map((t) => t.id)).toEqual(["t_4"]);
    const overdue = await runTool(makeCtx(), "search_tasks", { ...base, status: "overdue" });
    const items = (overdue.json.items as { items: { id: string; auto_archived: boolean; overdue_days: number }[] }).items;
    expect(items.map((t) => [t.id, t.auto_archived])).toEqual([["t_5", true]]);
    expect(items[0].overdue_days).toBeGreaterThan(0);
    expect(overdue.json.notes).toContain("Some of these were auto-archived by the overdue sweep; they are still open.");
  });

  it("include_done only with status any; total vs limit is a CappedList", async () => {
    vi.mocked(listTasksCompletedBetween).mockResolvedValue([task({ id: "t_d", title: "Sitemap done", status: "done", completedAt: iso(3) })]);
    const anyDone = await runTool(makeCtx(), "search_tasks", { ...base, query: "sitemap", include_done: true });
    expect((anyDone.json.items as { items: { id: string }[] }).items.map((t) => t.id)).toEqual(["t_1", "t_2", "t_d"]);
    vi.mocked(listTasksCompletedBetween).mockClear();
    const pendingDone = await runTool(makeCtx(), "search_tasks", { ...base, status: "pending", include_done: true });
    expect(vi.mocked(listTasksCompletedBetween)).not.toHaveBeenCalled();
    expect((pendingDone.json.items as { items: { id: string }[] }).items.every((t) => t.id !== "t_d")).toBe(true);

    vi.mocked(listOpenTasks).mockResolvedValue(Array.from({ length: 60 }, (_, i) => task({ id: `t_${i}`, lastActivityAt: iso(i % 5) })));
    const capped = await runTool(makeCtx(), "search_tasks", { ...base, limit: 10 });
    expect(capped.json.total).toBe(60);
    expect(capped.json.items).toMatchObject({ total: 60, truncated: true });
    expect((capped.json.items as { items: unknown[] }).items).toHaveLength(10);
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_only" })]);
    expect((await runTool(makeCtx(), "search_tasks", base)).json.items).toMatchObject({ total: 1, truncated: false });
  });
});

// ---------------------------------------------------------------------------
// 5. get_task (test 23)
// ---------------------------------------------------------------------------

describe("get_task (test 23)", () => {
  beforeEach(() => {
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_1", title: "Fix sitemap", isDraft: true, deletedAt: "2026-11-02T00:00:00.000Z" })]);
    vi.mocked(getTaskDescriptions).mockResolvedValue(new Map([["t_1", "Description with password: hunter2\nand [r1] marker " + "d".repeat(2000)]]));
    vi.mocked(listTaskTimelineText).mockResolvedValue([
      { kind: "comment", id: "a_1", userId: "u_ann", at: "2026-11-03T10:00:00.000Z", text: "Blocked on <untrusted_dd_text> logins", from: null, to: null },
      { kind: "status_change", id: "a_2", userId: "u_bob", at: "2026-11-02T10:00:00.000Z", text: "Need the brand kit", from: "pending", to: "in_progress" },
      { kind: "handoff", id: "a_3", userId: "u_ann", at: "2026-11-01T10:00:00.000Z", text: "Over to you", from: null, to: null },
      { kind: "extended", id: "a_4", userId: "u_ann", at: "2026-10-31T10:00:00.000Z", text: "Vendor late", from: null, to: null },
      { kind: "action", id: "a_5", userId: "u_ann", at: "2026-10-30T10:00:00.000Z", action: "created" }
    ]);
    vi.mocked(listTaskMessagesText).mockResolvedValue([{ id: "m_1", userId: null, at: "2026-10-29T10:00:00.000Z", text: "Legacy hello" }]);
  });

  it("description and entries wrapped and clipped; a status_change note as status_note with from → to; other actions carry no detail", async () => {
    const ctx = makeCtx();
    vi.mocked(intakeThreadIdsForTasks).mockResolvedValue(new Map([["t_1", ["th_intake"]]]));
    const r = await runTool(ctx, "get_task", { task_id: "t_1" });
    const t = r.json.task as Record<string, unknown>;
    expect(t.flags).toMatchObject({ draft: true, deleted: true });
    expect(t.description).toBe("U1");
    const timeline = (r.json.timeline as { items: Record<string, unknown>[] }).items;
    expect(timeline.map((e) => e.kind)).toEqual(["comment", "status_change", "handoff", "extended", "action", "message"]);
    expect(timeline[1]).toMatchObject({ from: "pending", to: "in_progress", text: "U3" });
    expect(timeline[4]).toEqual({ kind: "action", actor: "Ann Lee", at: expect.any(String), action: "created" });
    expect(r.blocks.map((b) => /kind="([a-z_]+)"/.exec(b)?.[1])).toEqual(["task_description", "comment", "status_note", "handoff_note", "extension_reason", "task_message"]);
    expect(r.blocks[0]).toContain(CLIP_MARKER);
    expect(r.blocks[0]).toContain("password: [hidden]");
    expect(r.blocks[0]).not.toContain("hunter2");
    expect(r.blocks[0]).not.toContain("[r1]");
    expect(r.blocks[1]).not.toContain("<untrusted_dd_text>");
    expect(r.json.notes).toContain("Some credential-like text was hidden.");
    expect(ctx.consulted.values()).toEqual(["th_intake"]);
    expect(ctx.markDdText).toHaveBeenCalled();
  });

  it.each([
    ["restricted_sender", "restricted_sender_mail"],
    ["restricted_thread", "restricted_sender_mail"],
    ["thread_gone", "restricted_sender_mail"],
    ["unscreened", "check_failed"]
  ] as const)("C25: %s withholds every text block (%s) and reads no text", async (reason, shown) => {
    vi.mocked(restrictedIntakeTaskIds).mockResolvedValue(new Map([["t_1", reason]]));
    const ctx = makeCtx();
    const r = await runTool(ctx, "get_task", { task_id: "t_1" });
    expect(r.json.text_withheld).toBe(shown);
    expect(r.blocks).toEqual([]);
    expect((r.json.task as Record<string, unknown>).description).toBeNull();
    expect(r.json.notes).toContain("This task's text is withheld: it came from mail that is restricted or couldn't be checked.");
    expect(vi.mocked(getTaskDescriptions)).not.toHaveBeenCalled();
    expect(vi.mocked(listTaskTimelineText)).not.toHaveBeenCalled();
    expect(vi.mocked(listTaskMessagesText)).not.toHaveBeenCalled();
    expect(ctx.markDdText).not.toHaveBeenCalled();
  });

  it("the policy load failing (null) is passed to the shared verdict; a thread-link read failure withholds; unknown id → not_found", async () => {
    vi.mocked(loadIntakeScreeningPolicy).mockResolvedValue(null);
    vi.mocked(restrictedIntakeTaskIds).mockImplementation(async (_p, ids, policy) => new Map(policy === null ? ids.map((id) => [id, "unscreened" as const]) : []));
    expect((await runTool(makeCtx(), "get_task", { task_id: "t_1" })).json.text_withheld).toBe("check_failed");
    vi.mocked(restrictedIntakeTaskIds).mockResolvedValue(new Map());
    vi.mocked(intakeThreadIdsForTasks).mockRejectedValue(new Error("links down"));
    expect((await runTool(makeCtx(), "get_task", { task_id: "t_1" })).json.text_withheld).toBe("check_failed");
    vi.mocked(listTasksByIds).mockResolvedValue([]);
    const missing = await runTool(makeCtx(), "get_task", { task_id: "t_nope" });
    expect(missing.record.error).toBe("not_found");
    expect(missing.text).toBe("No task has id t_nope. Use search_tasks to find it.");
    expect((await runTool(makeCtx(), "get_task", { task_id: "bad id!" })).record.error).toBe("bad_input");
  });
});

describe("capped lists say so (test 112)", () => {
  it("get_task's timeline (> 40) and extensions (> 10), project_health's rows (> 30) and working_now's in_progress (> 5)", async () => {
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_1" })]);
    vi.mocked(listTaskTimelineText).mockResolvedValue(
      Array.from({ length: 45 }, (_, i) => ({ kind: "action" as const, id: `a_${i}`, userId: "u_ann", at: new Date(Date.parse("2026-11-03T00:00:00.000Z") - i * 60_000).toISOString(), action: "updated" }))
    );
    vi.mocked(listTaskExtensionsForTasks).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `x_${i}`, taskId: "t_1", userId: "u_ann", previousDueDate: null, newDueDate: "2026-11-10", createdAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` }))
    );
    const t = await runTool(makeCtx(), "get_task", { task_id: "t_1" });
    expect(t.json.timeline).toMatchObject({ total: 45, truncated: true });
    expect((t.json.timeline as { items: unknown[] }).items).toHaveLength(40);
    expect(t.json.extensions).toMatchObject({ total: 12, truncated: true });

    vi.mocked(getProjectsListView).mockResolvedValue({
      generatedAt: NOW.toISOString(),
      timezone: "America/New_York",
      filter: "all",
      rows: { ok: true, data: Array.from({ length: 33 }, (_, i) => listRow(`p_${i}`, `Project ${i}`, "at_risk")) },
      totalProjects: { ok: true, data: 33 }
    });
    const p = await runTool(makeCtx(), "project_health", { project_id: "", only_problems: false });
    expect(p.json.rows).toMatchObject({ total: 33, truncated: true });
    expect(p.json.totals).toMatchObject({ at_risk: 33 });

    vi.mocked(getWorkingNow).mockResolvedValue({
      generatedAt: NOW.toISOString(),
      rows: [{ userId: "u_ann", name: "Ann Lee", primaryDepartmentId: "d_seo", clockedInSince: null, clockTaskId: null, inProgress: Array.from({ length: 7 }, (_, i) => ({ taskId: `t_${i}`, title: `T${i}`, dueDate: null, ref: ddTaskRef({ id: `t_${i}` }) })) }]
    });
    const w = await runTool(makeCtx(), "team_progress", { view: "working_now", window: "this_week", group_by: "person", department: "" });
    const person = (w.json.people as { items: Record<string, unknown>[]; truncated: boolean }).items[0];
    expect(person.in_progress).toMatchObject({ total: 7, truncated: true });
    expect(w.json.people).toMatchObject({ total: 1, truncated: false });
  });
});

// ---------------------------------------------------------------------------
// 6. project_health (test 24)
// ---------------------------------------------------------------------------

function listRow(id: string, name: string, status: ProjectListRow["health"]["status"]): ProjectListRow {
  return {
    health: { projectId: id, name, status, reasons: status === "on_track" ? [] : ["3 tasks overdue"], stageProgress: { done: 1, total: 3 }, openTasks: 4, undispatchedTasks: 0, overdueTasks: 3, stalledTasks: 0, waitingOnClient: 0, lastActivityAt: null, basis: "derived" },
    departmentName: "Website",
    departmentHeadName: null,
    activeStage: { id: "s_1", name: "Build", position: 2, updatedAt: "2026-11-01T00:00:00.000Z" },
    stuck: [{ kind: "unassigned_task_in_batch", stageId: "s_1", stageName: "Build", taskIds: ["t_1"], teamQueued: 0 }],
    derivedClient: null,
    ref: ddProjectRef({ id, name })
  };
}

describe("project_health (test 24)", () => {
  it("list: worst first as P5a ordered it, only_problems → the problems filter, totals per status", async () => {
    vi.mocked(getProjectsListView).mockResolvedValue({
      generatedAt: NOW.toISOString(),
      timezone: "America/New_York",
      filter: "problems",
      rows: { ok: true, data: [listRow("p_a", "Alpha", "off_track"), listRow("p_b", "Beta", "at_risk")] },
      totalProjects: { ok: true, data: 7 }
    });
    const r = await runTool(makeCtx(), "project_health", { project_id: "", only_problems: true });
    expect(vi.mocked(getProjectsListView).mock.calls[0][1]).toBe("problems");
    expect((r.json.rows as { items: { name: string; stuck: string[] }[] }).items.map((x) => [x.name, x.stuck])).toEqual([
      ["Alpha", ["unassigned_task_in_batch"]],
      ["Beta", ["unassigned_task_in_batch"]]
    ]);
    expect(r.json.total_projects).toBe(7);
    expect(r.json.notes).toContain("DD has no dependency links; blockers are signals.");
    vi.mocked(getProjectsListView).mockResolvedValue({ generatedAt: "", timezone: "", filter: "all", rows: { ok: false, error: "unavailable" }, totalProjects: { ok: false, error: "unavailable" } });
    const off = await runTool(makeCtx(), "project_health", { project_id: "", only_problems: false });
    expect(off.json.rows).toBe("unavailable");
    expect(off.json.total_projects).toBe("unavailable");
  });

  it("detail by exact name; ddtext and meeting text wrapped (AI-assessed); conversations consulted; ok:false → unavailable; screen_unavailable note", async () => {
    const detail: ProjectDetailView = {
      generatedAt: NOW.toISOString(),
      timezone: "America/New_York",
      project: { id: "p_site", name: "Zenith Site Rebuild", departmentName: "Website", createdAt: "2026-09-01T00:00:00.000Z", ref: ddProjectRef({ id: "p_site", name: "Zenith Site Rebuild" }) },
      summary: { ok: true, data: { health: listRow("p_site", "Zenith Site Rebuild", "at_risk").health, derivedClient: null, stuck: [] } },
      stages: { ok: false, error: "unavailable" },
      delays: { ok: true, data: { overdue: [], extensions: [] } },
      blockers: { ok: true, data: { derived: [], ai: [{ kind: "blocker", summary: "Waiting on DNS access from the client", authorName: "Bob Stone", at: "2026-11-03T10:00:00.000Z", basis: "ai", ref: ddTaskRef({ id: "t_9" }) }], aiState: "ok" } },
      updates: { ok: true, data: [] },
      meetingRisks: { ok: true, data: { state: "ok", rows: [{ meetingId: "mt_1", title: "Kickoff", meetingAt: "2026-10-20T15:00:00.000Z", risks: ["Budget unclear"], matchedBy: "client", basis: "ai", ref: ddPageRef("/clients/c_zen", "Zenith") }] } },
      conversations: { ok: true, data: { state: "screen_unavailable", rows: [{ threadId: "th_p1", subject: "Launch date", lastActivityAt: null, answered: null, confidence: "high", ref: execEmailThreadRef("th_p1", "Launch date") }], hiddenRestricted: 1 } }
    };
    vi.mocked(getProjectDetail).mockResolvedValue(detail);
    const ctx = makeCtx();
    const r = await runTool(ctx, "project_health", { project_id: "Zenith Site Rebuild", only_problems: false });
    expect(vi.mocked(getProjectDetail).mock.calls[0][1]).toBe("p_site");
    expect(r.json.stages).toBe("unavailable");
    expect(r.json.unavailable).toEqual(["stages"]);
    const ai = ((r.json.blockers as Record<string, unknown>).ai as { items: Record<string, unknown>[] }).items[0];
    expect(ai).toMatchObject({ basis: "ai", label: "AI-assessed", text: "U1" });
    expect(r.blocks[0]).toContain('kind="ai_summary"');
    expect(r.blocks[0]).toContain('author="Bob Stone"');
    expect(r.blocks[1]).toContain('kind="meeting_brief"');
    expect(r.blocks[1]).toContain("Budget unclear");
    expect(ctx.consulted.values()).toEqual(["th_p1"]);
    expect(r.json.notes).toEqual(expect.arrayContaining(["Related email couldn't be screened; say email wasn't checked.", "1 related threads from restricted senders aren't shown."]));
    vi.mocked(getProjectDetail).mockResolvedValue(null);
    expect((await runTool(makeCtx(), "project_health", { project_id: "p_site", only_problems: false })).record.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 7. pending_approvals (test 25)
// ---------------------------------------------------------------------------

describe("pending_approvals (test 25)", () => {
  // producers/dd.ts:705-756, as strings.
  const PRODUCER_PAGES: Record<string, string[]> = {
    draft_tasks: ["/approvals?tab=routing", "/approvals?tab=meetings"],
    fb_proofs: ["/tasks/board?status=pending_approval&groupBy=status"],
    email_drafts: ["/approvals?tab=emails"],
    unrouted_mail: ["/approvals?tab=routing"],
    eod_reviews: ["/eod/history"],
    checkins: []
  };

  it("all six counts; items through the screened list; count_only → counts only; hidden → the note; page paths equal the producer's", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([
      { mechanism: "draft_tasks", count: 3, oldestAt: "2026-11-01T00:00:00.000Z" },
      { mechanism: "fb_proofs", count: 0, oldestAt: null },
      { mechanism: "email_drafts", count: 2, oldestAt: "2026-11-02T00:00:00.000Z" },
      { mechanism: "unrouted_mail", count: 0, oldestAt: null },
      { mechanism: "eod_reviews", count: 4, oldestAt: "2026-10-30T00:00:00.000Z" },
      { mechanism: "checkins", count: 1, oldestAt: null }
    ]);
    vi.mocked(listScreenedApprovalItems).mockImplementation(async (_p, mechanism) =>
      mechanism === "draft_tasks"
        ? { mechanism, mode: "items", total: 3, truncated: false, hiddenRestricted: 1, items: [
            { mechanism, id: "t_d1", title: "Draft: call Acme", requesterId: "u_ann", waitingSince: "2026-11-01T00:00:00.000Z", waitingSinceIsLowerBound: false, approver: { kind: "leaders_or_department_heads", departmentIds: ["d_seo"] }, taskId: "t_d1", clientName: null, departmentId: "d_seo" },
            { mechanism, id: "t_d2", title: "Draft two", requesterId: null, waitingSince: "2026-11-02T00:00:00.000Z", waitingSinceIsLowerBound: true, approver: { kind: "leaders_or_any_department_head" }, taskId: "t_d2", clientName: null, departmentId: null }
          ] }
        : mechanism === "eod_reviews"
          ? { mechanism, mode: "count_only", total: 4, truncated: false, hiddenRestricted: 0, items: [] }
          : { mechanism, mode: "items", total: 2, truncated: false, hiddenRestricted: 0, items: [{ mechanism, id: "ed_1", title: "Email draft", requesterId: "u_bob", waitingSince: null, waitingSinceIsLowerBound: false, approver: { kind: "email_approvers_or_department_head", departmentId: null }, taskId: null, clientName: null, departmentId: null }] }
    );
    const ctx = makeCtx();
    const r = await runTool(ctx, "pending_approvals", { mechanism: "any" });
    const mechs = r.json.mechanisms as Record<string, unknown>[];
    expect(mechs.map((m) => [m.mechanism, m.count])).toEqual([["draft_tasks", 3], ["fb_proofs", 0], ["email_drafts", 2], ["unrouted_mail", 0], ["eod_reviews", 4], ["checkins", 1]]);
    expect(vi.mocked(listScreenedApprovalItems).mock.calls.map((c) => [c[1], c[3]?.limit])).toEqual([["draft_tasks", 10], ["email_drafts", 10], ["eod_reviews", 10]]);
    const drafts = mechs[0].items as { items: Record<string, unknown>[]; total: number };
    expect(drafts.items[0]).toMatchObject({ title: "Draft: call Acme", requester: "Ann Lee", approver: "Any leader, or a head of SEO", waiting_since_is_lower_bound: false });
    expect(drafts.items[1].waiting_since).toMatch(/^at least /);
    expect(mechs[4]).toMatchObject({ items_supported: false, items: { items: [], total: 4 } });
    expect(r.json.notes).toEqual(["'Who must approve' follows DD's rule for each kind of approval.", "1 items from restricted or unchecked mail aren't listed."]);
    for (const m of mechs) {
      const refs = m.page_refs as string[];
      const paths = refs.map((ref) => (ctx.refs.citable(ref)?.source.id ?? ""));
      expect(paths).toEqual(PRODUCER_PAGES[m.mechanism as string]);
    }
    await runTool(makeCtx(), "pending_approvals", { mechanism: "email_drafts" });
    expect(vi.mocked(listScreenedApprovalItems).mock.calls.at(-1)?.[3]?.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 8. recurring_issues (tests 26, 112)
// ---------------------------------------------------------------------------

describe("recurring_issues (test 26)", () => {
  it("30 vs 90 filter and sort; extension people labelled filed_by; capped lists say so", async () => {
    const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    vi.mocked(listIncidentLogsSince).mockResolvedValue([
      ...[5, 10].map((d, i) => ({ id: `il_a${i}`, issueType: "Site down", affectedUrl: "https://a.example", createdAt: day(d) })),
      ...[40, 50, 60].map((d, i) => ({ id: `il_b${i}`, issueType: "Form broken", affectedUrl: "https://b.example", createdAt: day(d) }))
    ]);
    vi.mocked(listTaskExtensionsSince).mockResolvedValue(
      [1, 2, 3, 4].map((d, i) => ({ id: `x_${i}`, taskId: i < 2 ? "t_ext" : `t_o${i}`, userId: "u_ann", previousDueDate: null, newDueDate: day(-d), createdAt: day(d) }))
    );
    vi.mocked(listOpenTasks).mockResolvedValue(Array.from({ length: 12 }, (_, i) => task({ id: `t_inc${i}`, tags: ["incident"] })));
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_ext", title: "Extended task" })]);
    const r30 = await runTool(makeCtx(), "recurring_issues", { window_days: 30 });
    const inc30 = (r30.json.incidents as { items: { count_30: number; count_90: number }[] }).items;
    expect(inc30.every((g) => g.count_30 > 0)).toBe(true);
    const r90 = await runTool(makeCtx(), "recurring_issues", { window_days: 90 });
    const inc90 = (r90.json.incidents as { items: { count_90: number }[] }).items.map((g) => g.count_90);
    expect(inc90).toEqual([...inc90].sort((a, b) => b - a));
    expect(inc90.length).toBeGreaterThanOrEqual(inc30.length);
    const ext = r30.json.extensions as { tasks: { items: { title: string }[] }; filed_by: { items: { name: string; count_30: number }[] } };
    expect(ext.filed_by.items[0]).toMatchObject({ name: "Ann Lee", count_30: 4 });
    expect(ext.tasks.items[0].title).toBe("Extended task");
    expect(r30.json.notes).toContain("Extension groups by person count who filed them (filed_by), not who is assigned.");
    expect(r30.json.open_incident_tasks).toMatchObject({ total: 12, truncated: true });
  });
});

// ---------------------------------------------------------------------------
// 13. get_eod_reports (tests 31, 124, 127)
// ---------------------------------------------------------------------------

describe("get_eod_reports (tests 31, 124, 127)", () => {
  const eod = (userId: string, over: Partial<SubmittedNoteText> = {}): SubmittedNoteText => ({
    kind: "eod",
    id: `eod_${userId}`,
    userId,
    noteDate: "2026-11-04",
    submittedAt: "2026-11-04T22:00:00.000Z",
    reviewedAt: null,
    editedAfterSubmit: false,
    fields: [
      { label: "Worked on", text: "Audit " + "w".repeat(1600) },
      { label: "Blockers", text: "None" }
    ],
    ...over
  });

  it("today and yesterday on the ET day; a future or malformed date → bad_input", async () => {
    await runTool(makeCtx(), "get_eod_reports", { date: "today", person: "" });
    expect(vi.mocked(listSubmittedNotesText).mock.calls[0][1]).toEqual({ kind: "eod", noteDate: "2026-11-04", userId: null });
    await runTool(makeCtx(), "get_eod_reports", { date: "yesterday", person: "Ann Lee" });
    expect(vi.mocked(listSubmittedNotesText).mock.calls[1][1]).toEqual({ kind: "eod", noteDate: "2026-11-03", userId: "u_ann" });
    // 03:00Z on Nov 5 is still Nov 4 in ET.
    await runTool(makeCtx({ now: new Date("2026-11-05T03:00:00.000Z") }), "get_eod_reports", { date: "today", person: "" });
    expect(vi.mocked(listSubmittedNotesText).mock.calls[2][1]).toMatchObject({ noteDate: "2026-11-04" });
    expect((await runTool(makeCtx(), "get_eod_reports", { date: "2026-11-05", person: "" })).record.error).toBe("bad_input");
    expect((await runTool(makeCtx(), "get_eod_reports", { date: "2026-02-30", person: "" })).record.error).toBe("bad_input");
  });

  it("1,500 per note, 12,000 per result with text_omitted and the note; an edited note has no text and still counts as submitted", async () => {
    const people = Array.from({ length: 10 }, (_, i) => user({ id: `u_p${i}`, name: `Person ${String(i).padStart(2, "0")}` }));
    vi.mocked(listUsers).mockResolvedValue([...USERS, ...people]);
    vi.mocked(listSubmittedNotesText).mockResolvedValue([...people.map((p) => eod(p.id)), eod("u_ann", { editedAfterSubmit: true, fields: [] })]);
    const r = await runTool(makeCtx(), "get_eod_reports", { date: "today", person: "" });
    const reports = (r.json.reports as { items: Record<string, unknown>[] }).items;
    const withText = reports.filter((x) => typeof x.text === "string");
    const omitted = reports.filter((x) => x.text_omitted === true);
    expect(withText).toHaveLength(8);
    expect(omitted).toHaveLength(2);
    for (const b of r.blocks) expect(b.length).toBeLessThan(1500 + 300);
    expect(r.json.notes).toContain("Some reports were left out of this answer's text budget; ask for one person to read the rest.");
    const ann = reports.find((x) => x.person === "Ann Lee");
    expect(ann).toMatchObject({ edited_after_submission: true });
    expect(ann).not.toHaveProperty("text");
    expect(r.json.notes).toContain("Edited after submission; not shown until it is submitted again.");
    expect((r.json.not_submitted as { items: { name: string }[] }).items.map((x) => x.name)).not.toContain("Ann Lee");
  });

  it("expected = isRitualExpected + expectedEodDays: creation day, a day off, a leader, and daily_prompts_required (test 124)", async () => {
    vi.mocked(listUsers).mockResolvedValue([
      user({ id: "u_new", name: "New Hire" }),
      user({ id: "u_off", name: "Day Off" }),
      user({ id: "u_lead", name: "A Leader", role: "leader" }),
      user({ id: "u_req", name: "Required Leader", role: "leader" }),
      user({ id: "u_norm", name: "Normal Worker" })
    ]);
    vi.mocked(listUserSchedules).mockResolvedValue([
      // Created at 15:00 ET on Nov 4: not expected on Nov 3.
      schedule("u_new", { createdAt: "2026-11-04T20:00:00.000Z" }),
      // Tuesday (Nov 3) is a scheduled day off.
      schedule("u_off", { weeklySchedule: { mon: { start: "09:00", end: "17:00" }, tue: null, wed: { start: "09:00", end: "17:00" } } }),
      schedule("u_lead"),
      schedule("u_req", { dailyPromptsRequired: true }),
      schedule("u_norm")
    ]);
    const r = await runTool(makeCtx(), "get_eod_reports", { date: "yesterday", person: "" });
    expect((r.json.not_submitted as { items: { name: string }[] }).items.map((x) => x.name)).toEqual(["Normal Worker", "Required Leader"]);
    expect(String(r.json.notes)).toContain("ET calendar day");
  });

  it("get_source on an edited note's eod_note ref shows no text; after a resubmit the text is back (test 127)", async () => {
    vi.mocked(listSubmittedNotesText).mockResolvedValue([eod("u_ann", { editedAfterSubmit: true, fields: [] })]);
    const ctx = makeCtx();
    const first = await runTool(ctx, "get_eod_reports", { date: "today", person: "Ann Lee" });
    const ref = ((first.json.reports as { items: { ref: string }[] }).items[0]).ref;
    const again = await runTool(ctx, "get_source", { ref });
    expect(again.blocks).toEqual([]);
    expect((again.json.reports as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ edited_after_submission: true });
    vi.mocked(listSubmittedNotesText).mockResolvedValue([eod("u_ann", { submittedAt: "2026-11-04T23:00:00.000Z" })]);
    const back = await runTool(ctx, "get_source", { ref });
    expect(back.blocks).toHaveLength(1);
    expect(back.blocks[0]).toContain("Worked on: Audit");
    void principal;
    void DEPARTMENTS;
    void listTasksCreatedBetween;
  });
});

// ---------------------------------------------------------------------------
// 16. get_source dispatch (test 34)
// ---------------------------------------------------------------------------

describe("get_source dispatches each target to its reader (test 34)", () => {
  it("client, project, person, department, email_thread, sod_note, approval and meeting", async () => {
    const { RefRegistry } = await import("@/lib/exec/agent/refs");
    void RefRegistry;
    const { readPrincipalThread } = await import("@/lib/exec/sources/mail");
    const { listMeetingBriefRisks } = await import("@/lib/exec/sources/dd-text");
    const { getPendingApprovals } = await import("@/lib/exec/sources/dd");
    const prior = [
      { ref: "r1", target: { type: "client" as const, id: "c_zen" }, source: ddPageRef("/clients/c_zen", "Zenith") },
      { ref: "r2", target: { type: "project" as const, id: "p_site" }, source: ddProjectRef({ id: "p_site" }) },
      { ref: "r3", target: { type: "person" as const, id: "u_ann" }, source: ddPageRef("/team/u_ann", "Ann Lee") },
      { ref: "r4", target: { type: "department" as const, id: "d_seo" }, source: ddPageRef("/team", "SEO") },
      { ref: "r5", target: { type: "email_thread" as const, id: "th_1" }, source: execEmailThreadRef("th_1") },
      { ref: "r6", target: { type: "sod_note" as const, userId: "u_ann", date: "2026-11-04" }, source: ddPageRef("/sod/history", "SOD history") },
      { ref: "r7", target: { type: "approval" as const, mechanism: "fb_proofs" as const, id: null }, source: ddPageRef("/tasks/board", "Board") },
      { ref: "r8", target: { type: "meeting" as const, id: "mt_1", clientId: "c_zen" }, source: ddPageRef("/clients/c_zen", "Zenith") }
    ];
    vi.mocked(getTeamView).mockResolvedValue(teamView([personRow({ userId: "u_ann", name: "Ann Lee" })], [deptRow({ departmentId: "d_seo", name: "SEO" })]));
    vi.mocked(getProjectDetail).mockResolvedValue(null);
    const ctx = makeCtx({ refSeq: 8, prior });
    const client = await runTool(ctx, "get_source", { ref: "r1" });
    expect((client.json.client as Record<string, unknown>).name).toBe("Zenith Law");
    expect(client.json.ref).toBe("r1");
    expect((await runTool(ctx, "get_source", { ref: "r2" })).record.error).toBe("not_found");
    expect(vi.mocked(getProjectDetail).mock.calls[0][1]).toBe("p_site");
    const person = await runTool(ctx, "get_source", { ref: "r3" });
    expect((person.json.person as Record<string, unknown>).name).toBe("Ann Lee");
    expect(person.json.open_tasks).toMatchObject({ total: 0 });
    const dept = await runTool(ctx, "get_source", { ref: "r4" });
    expect((dept.json.rows as Record<string, unknown>[]).map((r) => r.name)).toEqual(["SEO"]);
    await runTool(ctx, "get_source", { ref: "r5" });
    expect(vi.mocked(readPrincipalThread).mock.calls[0][1]).toBe("th_1");
    await runTool(ctx, "get_source", { ref: "r6" });
    expect(vi.mocked(listSubmittedNotesText).mock.calls[0][1]).toEqual({ kind: "sod", pairs: [{ userId: "u_ann", noteDate: "2026-11-04" }] });
    const approval = await runTool(ctx, "get_source", { ref: "r7" });
    expect(vi.mocked(getPendingApprovals)).toHaveBeenCalled();
    expect((approval.json.mechanisms as Record<string, unknown>[]).map((m) => m.mechanism)).toEqual(["fb_proofs"]);
    const meeting = await runTool(ctx, "get_source", { ref: "r8" });
    expect(vi.mocked(listMeetingBriefRisks).mock.calls[0][1]).toMatchObject({ clientId: "c_zen" });
    expect(meeting.json.note).toBe("No risks are recorded for this meeting in the last year.");
  });
});
