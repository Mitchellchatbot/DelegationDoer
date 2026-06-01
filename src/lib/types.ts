export type Role = "leader" | "department_head" | "worker";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "urgent"
  | "waiting_on_client"
  | "done"
  // Soft-delete state for denied drafts: keeps the row (and its
  // routing_decisions back-reference) intact for audit instead of
  // dropping it from the table.
  | "rejected";
export type Priority = "low" | "medium" | "high" | "critical";
export type MilestoneStatus = "pending" | "in_progress" | "done" | "delayed";
export type RaciRole = "responsible" | "accountable" | "consulted" | "informed";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Departments the user belongs to. For workers this is typically one home
  // department. For department_heads, the departments they lead (one or many).
  // For the Leader this can be empty.
  departmentIds: string[];
  skills: string[];
  dailyCapacity: number;
  throughput: Record<string, number>;
  avatarUrl?: string;
  // Stealth admin: passes every leader-equivalent permission gate
  // (canManageTask, canViewTask, etc.) without changing what the UI
  // shows for `role`. Used for a builder who needs full access while
  // appearing as a regular worker. Default false.
  isAdmin?: boolean;
  // The user's stated timezone (IANA). Used by capacity + clock to
  // decide which day-of-week "today" is for them. Falls back to UTC
  // when missing.
  workTimezone?: string | null;
  // Optional per-day schedule. Keyed by mon|tue|wed|thu|fri|sat|sun.
  // `null` (or missing key) = day off. When the whole object is empty
  // or undefined, callers fall back to dailyCapacity for every weekday
  // and treat weekends as off.
  weeklySchedule?: Partial<Record<
    "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
    { start: string; end: string } | null
  >>;
  // Optional explicit reporting line. When set, the OrgChart nests this
  // user under `managerId` (used for team-lead trees inside a dept).
  // When null/undefined, the renderer falls back to the dept head, which
  // preserves the original flat layout.
  managerId?: string | null;
  // Optional SECOND manager — for pods where two team-leads share the
  // same reports (e.g. SEO's Tabrez + Farez both managing Samir/Saif/
  // Bismah). The chart renders this user under both managers; the
  // duplicate node makes the dual-report relationship visible.
  secondaryManagerId?: string | null;
  // Per-user opt-out for SOD/EOD daily prompts (home bookend card,
  // widget EOD client-checkin nudge). Default true — flip off in the
  // DB for executives who don't run that ritual themselves.
  dailyPromptsEnabled?: boolean;
}

export interface Department {
  id: string;
  name: string;
  description: string;
  taskTypes: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  estimatedHours: number;
  // The "displayed" actual hours: override if set, else derived from the
  // time_entries log. Reads should treat this as the truth.
  actualHours: number;
  // When set, the user has manually pinned actuals (off-clock work or
  // historical backfill) and the time-log sum is ignored. Lets the UI
  // surface "overridden" affordances and offer a clear-override action.
  actualHoursOverride?: number | null;
  tags: string[];
  departmentId: string | null;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  dueDate: string | null;
  inactiveFlag: boolean;
  lastActivityAt: string;
  createdAt: string;
  blocksTaskIds: string[];
  clientName?: string | null;
  website?: string | null;
  // Notion-style project fields, all optional.
  clientEmail?: string | null;
  clientFolderUrl?: string | null;
  stagingServer?: string | null;
  markupLink?: string | null;
  hostingAccess?: string | null;
  missiveThreadUrl?: string | null;
  // Org-wide custom field values, keyed by field id. Shape per value
  // depends on the matching CustomField.type (string for text/url/date/
  // select, number for number, boolean for checkbox, string[] for
  // multiselect).
  custom?: Record<string, unknown>;
  // Files attached to the task — images, audio, etc. Persistent across
  // edits. New entries can come from the create form, the edit dialog,
  // or the widget's status-update flow. Each entry is the upload URL plus
  // best-effort metadata for rendering.
  mediaUrls?: TaskMedia[];
  // Soft-delete stamps. Non-null `deletedAt` means the task is hidden from
  // every normal view but retained for audit and recoverable by admins.
  // `deletedBy` is the user id that performed the deletion.
  deletedAt?: string | null;
  deletedBy?: string | null;
  // When the task crossed into `done` (stamped on the done transition,
  // cleared on reopen). The canonical completion date — drives the
  // "done more than 7 days ago" archive rule and is shown on the card.
  completedAt?: string | null;
  // Archive stamps. Non-null `archivedAt` means the task is hidden from the
  // active board/mine/search lists but still visible on the Archived view and
  // still counted in historical analytics — it is NOT deleted. `archivedBy`
  // is the user who archived it manually, or null when the cron auto-archived.
  archivedAt?: string | null;
  archivedBy?: string | null;
}

export interface TaskMedia {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

// Org-wide custom field definition. Managed in Settings; rendered on the
// new-task form and task detail.
export type CustomFieldType =
  | "text" | "number" | "url" | "date" | "checkbox" | "select" | "multiselect";

export interface CustomFieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface CustomField {
  id: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  departmentId: string | null;
}

export type ProjectStageStatus = "locked" | "active" | "done";
export type ProjectStageKind =
  | "scope"
  | "architecture"
  | "frontend"
  | "backend"
  | "completed"
  | "custom";

export interface ProjectStage {
  id: string;
  projectId: string;
  position: number;
  name: string;
  kind: ProjectStageKind;
  status: ProjectStageStatus;
  isIt: string[];
  isNot: string[];
  imageUrls: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  dueDate: string;
  deliverables: string[];
  status: MilestoneStatus;
}

export interface RACIEntry {
  id: string;
  projectId: string;
  userId: string;
  area: string;
  role: RaciRole;
}

export interface IncidentLog {
  id: string;
  issueType: string;
  affectedUrl: string;
  description: string;
  assignedToId: string | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SkillProfile {
  id: string;
  userId: string;
  skillName: string;
  experienceLevel: number;
  taskTypes: string[];
}

export interface ActivityLog {
  id: string;
  taskId: string;
  userId: string;
  action: string;
  detail: string;
  imageUrl?: string | null;
  createdAt: string;
}

// One row per runEmailIntake invocation. Persists the AI classifier
// output, matched rule (if any), and ranker top candidates so the
// dept-head review dashboard can show "AI reasoning" without re-running
// the pipeline. needs_review = true + task_id IS NULL = unrouted thread
// that landed in the fallback queue.
export interface RoutingDecision {
  id: string;
  taskId: string | null;
  accountId: string;
  threadId: string;
  classifierOutput: {
    title: string;
    description: string;
    priority: Priority;
    tags: string[];
    departmentHint: string | null;
    confidence: "low" | "medium" | "high";
  } | null;
  matchedRuleId: string | null;
  matchedRuleLabel: string | null;
  rankerTop: Array<{ userId: string; score: number; reason: string }> | null;
  routedVia: string;
  routedToUserId: string | null;
  reason: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  createdAt: string;
}
