// The P5a page models (contract §3.1.5; lead seed). Pure and client-safe:
// type-only imports, nothing at runtime, so client components (TeamTable,
// SettingsForm, FeedList) may import it (boundary rule 16; every import here is
// `import type` and is erased, including VoiceProfileRow from the server-only
// drafts-store.ts).
//
// Every number and fact carries its basis; a section or cell that couldn't be
// read is { ok: false }, never a zero (contract §0.2).

import type { MatchConfidence, StoredAnsweredState } from "@/lib/exec/email-types";
import type { ProjectHealth } from "@/lib/exec/analysis/projects";
import type { FeedbackReason } from "@/lib/exec/attention-types";
import type { VoiceProfileRow } from "@/lib/exec/drafts-store";
import type { SettingsSchemaKey } from "@/lib/exec/settings-fields";
import type { ProjectStageStatus, TaskStatus, UserRole } from "@/lib/exec/sources/dd-types";
import type { ExecSettings, ExecSurface, SourceRef } from "@/lib/exec/types";

/** = overview.ts OverviewSection<T> (structurally identical; overview.ts is server-only). */
export type Section<T> = { ok: true; data: T } | { ok: false; error: "unavailable" };
export type Cell<T> = { ok: true; value: T } | { ok: false };
/** tooFew = n < 5; rate null when n = 0 */
export interface RateValue { x: number; n: number; rate: number | null; tooFew: boolean }
export interface MedianValue { n: number; medianHours: number | null; tooFew: boolean }
export interface CountsValue {
  open: number;
  inProgress: number;
  /** isOverdueWork (C15): open, past due, not an incident, not waiting for a proof review; auto-archived included. */
  overdue: number;
  overdueAutoArchived: number;
  stalled: number;
  waitingOnClient: number;
  pendingApproval: number;
  /** Of pendingApproval: past the task's due date, waiting on the reviewer. Shown in that cell, never counted as overdue (a-correct-5). */
  pendingApprovalPastDue: number;
}
export interface CompletedValue {
  thisWeek: number;
  lastWeek: number;
  /** Left out of the two counts above: closed by a manual stage close (C30). */
  closedWithStage: { thisWeek: number; lastWeek: number };
}
/** The completion windows P5b's team_progress may ask for (coherence-10). Weeks start Monday 00:00 in his zone. */
export type TeamWindow = "this_week" | "last_week" | "last_7_days" | "last_30_days";
/** Completions in the requested window, closed-with-stage excluded; taskIds newest first by completed_at. The this_week and
 *  last_week counts equal CompletedValue's. */
export interface WindowCompleted { count: number; closedWithStage: number; taskIds: string[] }
export type CapacityValue =
  | { kind: "load"; usedHours: number; backlogHours: number; pct: number; todayHours: number; overSoft: boolean; overBuffer: boolean; autoArchivedExcluded: number }
  | { kind: "off_today"; remainingHours: number };
export type EodValue = { kind: "not_expected" } | ({ kind: "rate"; otherDaysSubmitted: number } & RateValue);
export interface TeamPersonRow {
  userId: string;
  name: string;
  role: UserRole;
  isLeader: boolean;
  primaryDepartmentId: string | null;
  departmentIds: string[];
  counts: Cell<CountsValue>;
  completed: Cell<CompletedValue>;
  completedInWindow: Cell<WindowCompleted>;
  capacity: Cell<CapacityValue>;
  eod: Cell<EodValue>;
  onTime: Cell<RateValue>;
  cycle: Cell<MedianValue>;
  extensions: Cell<RateValue>;
  /** ddPageRef(`/team/${userId}`, name) */
  ref: SourceRef;
}
export interface TeamDepartmentRow {
  departmentId: string | null;
  name: string;
  headUserId: string | null;
  people: number;
  /** completedInWindow: the members' completions attributed to their primary department, as every other rollup (no double counting). */
  counts: Cell<CountsValue>;
  completed: Cell<CompletedValue>;
  completedInWindow: Cell<WindowCompleted>;
  capacity: Cell<{ usedHours: number; backlogHours: number; todayHours: number; offToday: number }>;
  eod: Cell<RateValue>;
  onTime: Cell<RateValue>;
  cycle: Cell<MedianValue>;
  extensions: Cell<RateValue>;
  /** The department's unclaimed pool (workloadByPerson's team:<id>); null when it has none. */
  pool: Cell<CountsValue> | null;
}
export interface UnownedWork { undispatchedPlaceholders: number; orphans: number; orphanSamples: { taskId: string; title: string; ref: SourceRef }[] }
export interface TeamWindows { thisWeekStart: string; lastWeekStart: string; indicatorsFrom: string; eodFromYmd: string; eodToYmd: string }
export interface TeamView {
  generatedAt: string;
  timezone: string;
  windows: TeamWindows;
  /** The window of completedInWindow (default this_week). */
  window: { key: TeamWindow; fromIso: string; toIso: string };
  people: Section<TeamPersonRow[]>;
  departments: Section<TeamDepartmentRow[]>;
  unowned: Section<UnownedWork>;
}

export interface WorkingNowRow {
  userId: string;
  name: string;
  primaryDepartmentId: string | null;
  clockedInSince: string | null;
  clockTaskId: string | null;
  inProgress: { taskId: string; title: string; dueDate: string | null; ref: SourceRef }[];
}

export type StuckSignal =
  | { kind: "unfinishable_task_in_batch"; stageId: string; stageName: string; tasks: { taskId: string; reason: "deleted" | "rejected" | "draft" }[] }
  | { kind: "unassigned_task_in_batch"; stageId: string; stageName: string; taskIds: string[]; teamQueued: number };
/** K25: "Derived from <taskCount> of <namedTaskCount> tasks that name a client". namedTaskCount ≥ 3, share ≥ 0.6. */
export interface DerivedClient { clientId: string; clientName: string; taskCount: number; namedTaskCount: number; share: number; basis: "derived" }
export interface ProjectListRow {
  health: ProjectHealth;
  departmentName: string | null;
  departmentHeadName: string | null;
  activeStage: { id: string; name: string; position: number; updatedAt: string } | null;
  stuck: StuckSignal[];
  derivedClient: DerivedClient | null;
  ref: SourceRef;
}
export type ProjectsFilter = "all" | "problems" | "open";
export interface ProjectsListView { generatedAt: string; timezone: string; filter: ProjectsFilter; rows: Section<ProjectListRow[]>; totalProjects: Section<number> }
export interface StageView {
  id: string;
  name: string;
  position: number;
  status: ProjectStageStatus;
  updatedAt: string;
  work: { done: number; total: number };
  currentBatch: {
    group: number | null;
    tasks: { taskId: string; title: string; status: TaskStatus; assigneeName: string | null; teamQueueName: string | null; deleted: boolean; ref: SourceRef }[];
  } | null;
  queuedBehind: number;
}
export interface OverdueTaskRow { taskId: string; title: string; assigneeName: string | null; overdueDays: number; autoArchived: boolean; ref: SourceRef }
export interface ExtensionRow {
  taskId: string;
  title: string;
  assigneeName: string | null;
  count: number;
  latestAt: string;
  latestNewDue: string;
  reDatedAfterDeadline: boolean;
  ref: SourceRef;
}
export interface DerivedBlocker { text: string; basis: "derived"; refs: SourceRef[] }
export interface AiBlocker { kind: "blocker" | "waiting" | "decision"; summary: string; authorName: string | null; at: string; basis: "ai"; ref: SourceRef }
/** stage_closed (C30): one per manual stage close, actorName null. project_created's detail names the folded stage tasks. */
export interface ProjectUpdateEvent {
  kind: "project_created" | "task_created" | "status_changed" | "task_completed" | "stage_closed";
  at: string;
  title: string;
  detail: string;
  actorName: string | null;
  ref: SourceRef | null;
}
/** K26: matchedBy "client" = a meeting of the derived client; "task" = its task_ids overlap the project's tasks. */
export interface MeetingRiskRow { meetingId: string; title: string; meetingAt: string; risks: string[]; matchedBy: "client" | "task"; basis: "ai"; ref: SourceRef }
/** ref: execEmailThreadRef, class private */
export interface ConversationRow {
  threadId: string;
  subject: string;
  lastActivityAt: string | null;
  answered: StoredAnsweredState | null;
  confidence: MatchConfidence;
  ref: SourceRef;
}
export interface ProjectDetailView {
  generatedAt: string;
  timezone: string;
  project: { id: string; name: string; departmentName: string | null; createdAt: string; ref: SourceRef };
  summary: Section<{ health: ProjectHealth; derivedClient: DerivedClient | null; stuck: StuckSignal[] }>;
  stages: Section<StageView[]>;
  delays: Section<{ overdue: OverdueTaskRow[]; extensions: ExtensionRow[] }>;
  blockers: Section<{ derived: DerivedBlocker[]; ai: AiBlocker[]; aiState: "off" | "not_installed" | "ok" }>;
  updates: Section<ProjectUpdateEvent[]>;
  meetingRisks: Section<{ state: "no_client" | "ok"; rows: MeetingRiskRow[] }>;
  conversations: Section<{ state: "off" | "not_installed" | "no_client" | "screen_unavailable" | "ok"; rows: ConversationRow[]; hiddenRestricted: number }>;
}

export interface RecentAccessRow { at: string; route: string; surface: ExecSurface; ip: string | null; device: string | null; sessionTag: string | null }
export interface FeedbackTotals {
  sinceIso: string;
  up: number;
  down: number;
  byKind: { kind: string; up: number; down: number }[];
  byReason: { reason: FeedbackReason; count: number }[];
}
export interface SpendToday { totalUsd: number; capUsd: number; byFeature: { feature: string; usd: number }[] }
export interface SettingsView {
  generatedAt: string;
  timezone: string;
  /** CAS token for PATCH */
  version: string | null;
  settings: ExecSettings;
  /** One flag per SETTINGS_COLUMN_GROUPS key (settings-fields.ts), so P5b's "chat" appears without a type change (coherence-11). */
  schema: Record<SettingsSchemaKey, boolean>;
  pinnedMailbox: Section<{ accountIds: string[]; emails: string[] }>;
  spend: Section<SpendToday>;
  recentAccess: Section<RecentAccessRow[]>;
  /** null = not installed */
  feedback: Section<FeedbackTotals | null>;
  /** C20: P4's VoiceProfileRow (drafts-store.ts). installed false = P4's table isn't there; profile null = none built yet. */
  voice: Section<{ installed: boolean; profile: VoiceProfileRow | null }>;
  /**
   * P5b (C30, coherence-21): the chat cap that actually applies, min(chatDailyCapUsd, 0.6 x dailyCostCapUsd) rounded
   * down to the cent (agent/budget.ts effectiveChatCapUsd); shown beside the chat budget field. 0 = chat is paused.
   */
  effectiveChatCapUsd: number;
}
