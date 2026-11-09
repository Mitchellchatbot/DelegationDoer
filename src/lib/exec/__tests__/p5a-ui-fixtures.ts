import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import type { ProjectHealth } from "@/lib/exec/analysis/projects";
import type { ExecSettings, SourceRef } from "@/lib/exec/types";
import type {
  CountsValue,
  ProjectDetailView,
  ProjectListRow,
  ProjectsListView,
  RateValue,
  SettingsView,
  StageView,
  TeamDepartmentRow,
  TeamPersonRow,
  TeamView
} from "@/lib/exec/view-types";

// Fixtures for the P5a UI tests (Area E) and the static screenshot harness:
// feed items, a TeamView, project views and a SettingsView, each with one
// override object. Data only: no server-only module is imported at runtime.

export const NOW = "2026-11-06T15:00:00.000Z"; // Friday, 10:00 AM EST
export const TZ = "America/New_York";
export const SCRIPT = "<script>alert(1)</script>";
const ORIGIN = "https://operations.scaledai.org";

export const NNBSP = String.fromCharCode(0x202f);
/** Visible text: tags stripped, entities decoded, narrow spaces made plain, whitespace collapsed. */
export const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split(NNBSP)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

export const ddRef = (path: string, label: string, cls: SourceRef["class"] = "internal"): SourceRef => ({
  system: "dd",
  id: path,
  url: `${ORIGIN}${path}`,
  label,
  class: cls
});

const hex = (n: number) => n.toString(16).padStart(32, "0");
export const itemId = (n: number) => `ea_${hex(n)}`;

export function feedItem(over: Partial<AttentionFeedItem> = {}): AttentionFeedItem {
  return {
    id: itemId(1),
    principalId: "ep_owner",
    fingerprint: "dd:overdue:assignee:u_sam",
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Sam has 3 overdue tasks",
    whatHappened: "3 open tasks assigned to Sam are past their due date.",
    whyItMatters: "Two of them are client-facing.",
    recommendedNext: "Ask Sam for new dates or decide whether to reassign.",
    facts: [{ text: "Oldest is 14 days overdue", basis: "derived", refs: [ddRef("/tasks/t_1", "Fix the sitemap")] }],
    refs: [ddRef("/tasks/t_1", "Fix the sitemap")],
    priority: { score: 62, band: "high", reasons: ["Overdue tasks (base 25)", "Overdue 14 days (+28)", "Count 3 (+6)"] },
    stateHash: "abcd1234abcd1234",
    occurredAt: "2026-11-02T15:00:00.000Z",
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-06T13:00:00.000Z",
    lastSeenAt: "2026-11-06T14:50:00.000Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-06T14:50:00.000Z",
    version: "2026-11-06T14:50:00.123456+00:00",
    ...over
  };
}

export const emailItem = (over: Partial<AttentionFeedItem> = {}): AttentionFeedItem =>
  feedItem({
    id: itemId(2),
    fingerprint: "email:thread:t_thread1:m_anchor",
    source: "email",
    kind: "email_reply",
    category: "my_action",
    title: "Jane is waiting on a reply",
    whatHappened: "She asked about Thursday.",
    whyItMatters: "A client is waiting.",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 70, band: "high", reasons: ["Needs a reply (base 50)"] },
    ...over
  });

export const ddtextItem = (kind: "ddtext_blocker" | "ddtext_waiting" | "ddtext_decision" | "ddtext_mention", over: Partial<AttentionFeedItem> = {}): AttentionFeedItem =>
  feedItem({
    id: itemId(3),
    fingerprint: `dd:ddtext:${kind.slice(7)}:comment:a_1`,
    kind,
    category: kind === "ddtext_mention" ? "my_action" : "intervene",
    title: kind === "ddtext_mention" ? "Sam mentioned you on “Fix the sitemap”" : "Possible blocker on “Fix the sitemap”",
    whatHappened: "A comment on the task was flagged.",
    whyItMatters: "Work may be held up.",
    recommendedNext: "Check the task's comments.",
    facts: [{ text: "Waiting on the client's DNS access.", basis: "ai", refs: [] }],
    priority: { score: 60, band: "high", reasons: ["Possible blocker (base 60)"] },
    ...over
  });

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export const rate = (x: number, n: number): RateValue => ({ x, n, rate: n > 0 ? x / n : null, tooFew: n < 5 });

export const counts = (over: Partial<CountsValue> = {}): CountsValue => ({
  open: 6,
  inProgress: 2,
  overdue: 1,
  overdueAutoArchived: 0,
  stalled: 1,
  waitingOnClient: 1,
  pendingApproval: 1,
  pendingApprovalPastDue: 0,
  ...over
});

export function person(over: Partial<TeamPersonRow> = {}): TeamPersonRow {
  const userId = over.userId ?? "u_sam";
  const name = over.name ?? "Sam Lee";
  return {
    userId,
    name,
    role: "worker",
    isLeader: false,
    primaryDepartmentId: "d_web",
    departmentIds: ["d_web"],
    counts: { ok: true, value: counts() },
    completed: { ok: true, value: { thisWeek: 4, lastWeek: 6, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: 4, closedWithStage: 0, taskIds: ["t_9", "t_8", "t_7", "t_6"] } },
    capacity: { ok: true, value: { kind: "load", usedHours: 6.5, backlogHours: 0, pct: 0.81, todayHours: 8, overSoft: true, overBuffer: false, autoArchivedExcluded: 0 } },
    eod: { ok: true, value: { kind: "rate", otherDaysSubmitted: 0, ...rate(18, 20) } },
    onTime: { ok: true, value: rate(8, 10) },
    cycle: { ok: true, value: { n: 9, medianHours: 30.5, tooFew: false } },
    extensions: { ok: true, value: rate(1, 12) },
    ref: ddRef(`/team/${userId}`, name),
    ...over
  };
}

export function department(over: Partial<TeamDepartmentRow> = {}): TeamDepartmentRow {
  return {
    departmentId: "d_web",
    name: "Website",
    headUserId: "u_head",
    people: 4,
    counts: { ok: true, value: counts({ open: 21, inProgress: 7, overdue: 3 }) },
    completed: { ok: true, value: { thisWeek: 14, lastWeek: 17, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: 14, closedWithStage: 0, taskIds: [] } },
    capacity: { ok: true, value: { usedHours: 26, backlogHours: 3, todayHours: 32, offToday: 0 } },
    eod: { ok: true, value: rate(70, 80) },
    onTime: { ok: true, value: rate(30, 36) },
    cycle: { ok: true, value: { n: 33, medianHours: 52, tooFew: false } },
    extensions: { ok: true, value: rate(5, 40) },
    pool: { ok: true, value: counts({ open: 3, inProgress: 0, overdue: 1, stalled: 0, waitingOnClient: 0, pendingApproval: 0 }) },
    ...over
  };
}

export function teamView(over: Partial<TeamView> = {}): TeamView {
  return {
    generatedAt: NOW,
    timezone: TZ,
    windows: {
      thisWeekStart: "2026-11-02T05:00:00.000Z",
      lastWeekStart: "2026-10-26T04:00:00.000Z",
      indicatorsFrom: "2026-10-08T04:00:00.000Z",
      eodFromYmd: "2026-10-06",
      eodToYmd: "2026-11-05"
    },
    window: { key: "this_week", fromIso: "2026-11-02T05:00:00.000Z", toIso: NOW },
    people: {
      ok: true,
      data: [
        person(),
        person({
          userId: "u_ana",
          name: "Ana Diaz",
          counts: { ok: true, value: counts({ overdue: 5, overdueAutoArchived: 2, pendingApproval: 3, pendingApprovalPastDue: 1 }) },
          completed: { ok: true, value: { thisWeek: 4, lastWeek: 3, closedWithStage: { thisWeek: 2, lastWeek: 0 } } },
          capacity: { ok: true, value: { kind: "load", usedHours: 8, backlogHours: 3, pct: 1, todayHours: 8, overSoft: true, overBuffer: true, autoArchivedExcluded: 2 } },
          onTime: { ok: true, value: rate(2, 3) },
          cycle: { ok: true, value: { n: 3, medianHours: 20, tooFew: true } }
        }),
        person({
          userId: "u_raj",
          name: "Raj Patel",
          role: "leader",
          isLeader: true,
          primaryDepartmentId: "d_seo",
          departmentIds: ["d_seo"],
          capacity: { ok: true, value: { kind: "off_today", remainingHours: 5 } },
          eod: { ok: true, value: { kind: "not_expected" } }
        }),
        person({ userId: "u_kim", name: "Kim Wu", counts: { ok: false }, completed: { ok: false }, capacity: { ok: false }, eod: { ok: false }, onTime: { ok: false }, cycle: { ok: false }, extensions: { ok: false } })
      ]
    },
    departments: {
      ok: true,
      data: [department(), department({ departmentId: "d_seo", name: "SEO", headUserId: null, people: 2, pool: null, eod: { ok: true, value: rate(2, 3) } })]
    },
    unowned: {
      ok: true,
      data: { undispatchedPlaceholders: 12, orphans: 2, orphanSamples: [{ taskId: "t_o1", title: "Update the robots file", ref: ddRef("/tasks/t_o1", "Update the robots file") }] }
    },
    ...over
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function health(over: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    projectId: "p_acme",
    name: "Acme site rebuild",
    status: "at_risk",
    reasons: ["2 of 9 open tasks are overdue", "No activity for 9 days on 3 tasks"],
    stageProgress: { done: 2, total: 5 },
    openTasks: 9,
    undispatchedTasks: 3,
    overdueTasks: 2,
    stalledTasks: 3,
    waitingOnClient: 1,
    lastActivityAt: "2026-11-05T15:00:00.000Z",
    basis: "derived",
    ...over
  };
}

export const derivedClient = { clientId: "c_acme", clientName: "Acme", taskCount: 4, namedTaskCount: 5, share: 0.8, basis: "derived" as const };

export function projectRow(over: Partial<ProjectListRow> = {}): ProjectListRow {
  return {
    health: health(),
    departmentName: "Website",
    departmentHeadName: "Dana",
    // DD's stage positions are 0-based: Build is the third of five stages, two done.
    activeStage: { id: "s_3", name: "Build", position: 2, updatedAt: "2026-10-27T15:00:00.000Z" },
    stuck: [{ kind: "unfinishable_task_in_batch", stageId: "s_3", stageName: "Build", tasks: [{ taskId: "t_del", reason: "deleted" }] }],
    derivedClient,
    ref: ddRef("/projects/p_acme", "Acme site rebuild"),
    ...over
  };
}

export function projectsListView(over: Partial<ProjectsListView> = {}): ProjectsListView {
  return {
    generatedAt: NOW,
    timezone: TZ,
    filter: "all",
    rows: {
      ok: true,
      data: [
        projectRow(),
        projectRow({
          health: health({ projectId: "p_blog", name: "Blog refresh", status: "on_track", reasons: [], overdueTasks: 0, stalledTasks: 0, waitingOnClient: 0, undispatchedTasks: 0 }),
          stuck: [],
          derivedClient: null,
          activeStage: null,
          departmentName: null,
          departmentHeadName: null,
          ref: ddRef("/projects/p_blog", "Blog refresh")
        })
      ]
    },
    totalProjects: { ok: true, data: 2 },
    ...over
  };
}

export function stage(over: Partial<StageView> = {}): StageView {
  return {
    id: "s_3",
    name: "Build",
    position: 2,
    status: "active",
    updatedAt: "2026-10-27T15:00:00.000Z",
    work: { done: 2, total: 6 },
    currentBatch: {
      group: 1,
      tasks: [
        { taskId: "t_a", title: "Build the header", status: "in_progress", assigneeName: "Sam Lee", teamQueueName: null, deleted: false, ref: ddRef("/tasks/t_a", "Build the header") },
        { taskId: "t_del", title: "Old footer task", status: "pending", assigneeName: null, teamQueueName: null, deleted: true, ref: ddRef("/tasks/t_del", "Old footer task") },
        { taskId: "t_q", title: "Write the copy", status: "pending", assigneeName: null, teamQueueName: "Content", deleted: false, ref: ddRef("/tasks/t_q", "Write the copy") }
      ]
    },
    queuedBehind: 2,
    ...over
  };
}

export function projectDetailView(over: Partial<ProjectDetailView> = {}): ProjectDetailView {
  return {
    generatedAt: NOW,
    timezone: TZ,
    project: { id: "p_acme", name: "Acme site rebuild", departmentName: "Website", createdAt: "2026-10-01T15:00:00.000Z", ref: ddRef("/projects/p_acme", "Acme site rebuild") },
    summary: {
      ok: true,
      data: {
        health: health(),
        derivedClient,
        stuck: [
          { kind: "unfinishable_task_in_batch", stageId: "s_3", stageName: "Build", tasks: [{ taskId: "t_del", reason: "deleted" }] },
          { kind: "unassigned_task_in_batch", stageId: "s_3", stageName: "Build", taskIds: ["t_q"], teamQueued: 1 }
        ]
      }
    },
    stages: {
      ok: true,
      data: [
        stage({ id: "s_1", name: "Discovery", position: 0, status: "done", work: { done: 3, total: 3 }, currentBatch: null, queuedBehind: 0 }),
        stage(),
        stage({ id: "s_4", name: "Launch", position: 3, status: "locked", work: { done: 0, total: 4 }, currentBatch: null, queuedBehind: 0 })
      ]
    },
    delays: {
      ok: true,
      data: {
        overdue: [{ taskId: "t_a", title: "Build the header", assigneeName: "Sam Lee", overdueDays: 4, autoArchived: false, ref: ddRef("/tasks/t_a", "Build the header") }],
        extensions: [
          {
            taskId: "t_b",
            title: "Hero images",
            assigneeName: "Ana Diaz",
            count: 2,
            latestAt: "2026-11-03T15:00:00.000Z",
            latestNewDue: "2026-11-10",
            reDatedAfterDeadline: true,
            ref: ddRef("/tasks/t_b", "Hero images")
          }
        ]
      }
    },
    blockers: {
      ok: true,
      data: {
        derived: [{ text: "“Old footer task” in the current batch is deleted, so the batch can’t finish.", basis: "derived", refs: [ddRef("/tasks/t_del", "Old footer task")] }],
        ai: [{ kind: "blocker", summary: "Waiting on the client's DNS access before launch.", authorName: "Sam Lee", at: "2026-11-05T15:00:00.000Z", basis: "ai", ref: ddRef("/tasks/t_a", "Build the header") }],
        aiState: "ok"
      }
    },
    updates: {
      ok: true,
      data: [
        { kind: "status_changed", at: "2026-11-05T15:00:00.000Z", title: "Build the header", detail: "To do → In progress", actorName: "Sam Lee", ref: ddRef("/tasks/t_a", "Build the header") },
        { kind: "stage_closed", at: "2026-10-20T15:00:00.000Z", title: "Stage “Discovery” closed manually", detail: "3 tasks marked done", actorName: null, ref: ddRef("/projects/p_acme", "Acme site rebuild") },
        { kind: "project_created", at: "2026-10-12T15:00:00.000Z", title: "Project “Acme site rebuild” created", detail: "with 16 stage tasks", actorName: null, ref: ddRef("/projects/p_acme", "Acme site rebuild") }
      ]
    },
    meetingRisks: {
      ok: true,
      data: {
        state: "ok",
        rows: [
          {
            meetingId: "m_1",
            title: "Acme weekly",
            meetingAt: "2026-11-04T15:00:00.000Z",
            risks: ["Launch date may slip if DNS access isn't granted."],
            matchedBy: "client",
            basis: "ai",
            ref: ddRef("/clients/c_acme", "Acme weekly")
          }
        ]
      }
    },
    conversations: {
      ok: true,
      data: {
        state: "ok",
        rows: [
          {
            threadId: "t_thread1",
            subject: "DNS access for the launch",
            lastActivityAt: "2026-11-06T13:00:00.000Z",
            answered: "awaiting_reply",
            confidence: "high",
            ref: ddRef("/executive/email/t_thread1", "DNS access for the launch", "private")
          }
        ],
        hiddenRestricted: 1
      }
    },
    ...over
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return {
    principalId: "ep_owner",
    briefEnabled: true,
    briefLocalTime: "07:30",
    briefTimezone: null,
    supersedeLegacyBrief: false,
    checkinsEnabled: true,
    restrictedPolicy: "hidden",
    watchMode: "active_public",
    mutedChannelIds: ["C1"],
    retentionDaysSlack: 90,
    retentionDaysEmail: 180,
    retentionDaysChat: 90,
    dailyCostCapUsd: 15,
    emailEnabled: true,
    emailSchemaReady: true,
    draftsEnabled: true,
    sendEnabled: false,
    voiceEnabled: true,
    draftsSchemaReady: true,
    ddtextEnabled: false,
    retentionDaysDdtext: 90,
    ddtextSchemaReady: true,
    // P5b stage -1: chat not installed (P5a's pages render as before).
    chatEnabled: false,
    askAiUsesExec: false,
    chatDailyCapUsd: 9,
    chatSchemaReady: false,
    ...over
  };
}

export const voiceProfile = {
  principalId: "ep_owner",
  status: "ready" as const,
  formality: "casual" as const,
  typicalLength: "short" as const,
  greeting: "hi_first_name" as const,
  paragraphing: "short_paragraphs" as const,
  bullets: "sometimes" as const,
  emoji: "never" as const,
  signOff: "Thanks, Mitchell",
  sampleCount: 32,
  samplesHash: null,
  windowDays: 90,
  model: "claude-haiku",
  promptVersion: "voice-v1",
  builtAt: "2026-11-02T09:00:00.000Z",
  lastAttemptAt: "2026-11-02T09:00:00.000Z",
  lastAttemptError: null,
  updatedAt: "2026-11-02T09:00:00.000Z"
};

export function settingsView(over: Partial<SettingsView> = {}): SettingsView {
  return {
    generatedAt: NOW,
    timezone: TZ,
    version: "2026-11-05T12:00:00.123456+00:00",
    settings: settings(),
    // P5b: chat not installed (the settings() fixture above), so the view says so.
    schema: { email: true, drafts: true, ddtext: true, chat: false },
    pinnedMailbox: { ok: true, data: { accountIds: ["acc_1"], emails: ["mitchell@scaledai.org"] } },
    spend: { ok: true, data: { totalUsd: 0.42, capUsd: 15, byFeature: [{ feature: "triage", usd: 0.31 }, { feature: "draft", usd: 0.11 }] } },
    recentAccess: {
      ok: true,
      data: [
        { at: "2026-11-06T14:55:00.000Z", route: "GET /executive/settings", surface: "web", ip: "203.0.113.7", device: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", sessionTag: "a1b2c3d4" },
        { at: "2026-11-06T13:10:00.000Z", route: "GET /executive", surface: "web", ip: null, device: null, sessionTag: null }
      ]
    },
    feedback: {
      ok: true,
      data: {
        sinceIso: "2025-11-06T15:00:00.000Z",
        up: 12,
        down: 3,
        byKind: [{ kind: "overdue_tasks", up: 5, down: 1 }],
        byReason: [
          { reason: "useful", count: 12 },
          { reason: "wrong_priority", count: 2 },
          { reason: "duplicate", count: 1 }
        ]
      }
    },
    voice: { ok: true, data: { installed: true, profile: voiceProfile } },
    // min(9, 0.6 x 15) = 9 (C30).
    effectiveChatCapUsd: 9,
    ...over
  };
}
