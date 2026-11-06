// Row shapes the assistant reads from DD's own tables (company-wide, through
// the service role in sources/dd.ts). Exec carries its own minimal types and
// mappers: server-data.ts's mappers are module-private, and its getAllTasks()
// is unpaged and drops archived rows (p2b-helpers §0.2).
//
// Only the columns exec needs, never free text it doesn't use: no task
// descriptions, no comment bodies, no tokens (users has plaintext Slack and
// Google tokens; sources/dd.ts must never select them).
//
// Timestamps are ISO strings exactly as PostgREST returns them. numeric
// columns are converted with Number() in the mappers (they can arrive as strings).
//
// SEEDED by the lead with the shapes every P2b area shares. Area A (sources)
// owns this file from here and adds the remaining table shapes; it must not
// change the fields below (analysis, producers and the UI build against them).

export type TaskStatus = "pending" | "in_progress" | "urgent" | "waiting_on_client" | "done" | "rejected" | "pending_approval";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type UserRole = "leader" | "department_head" | "worker";

export interface DdTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  departmentId: string | null;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  stageId: string | null;
  /** Free text that equals clients.name when linked (exact match, no FK). */
  clientName: string | null;
  dueDate: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Bumped by most writes AND by the auto-archive sweep: not an activity signal on archived rows. */
  lastActivityAt: string;
  archivedAt: string | null;
  /** NULL while archivedAt is set = auto-archived by the overdue/done sweep, not shelved by a person. */
  archivedBy: string | null;
  isDraft: boolean;
  deletedAt: string | null;
  estimatedHours: number;
}

export interface DdUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isAdmin: boolean;
  workTimezone: string | null;
  managerUserId: string | null;
  /** From department_members, primary (earliest) first. */
  departmentIds: string[];
}

export interface DdDepartment {
  id: string;
  name: string;
  headUserId: string | null;
}

/** The six approval mechanisms (p2b-schema §5), in display order. */
export type ApprovalMechanism =
  | "draft_tasks"
  | "fb_proofs"
  | "email_drafts"
  | "unrouted_mail"
  | "eod_reviews"
  | "checkins";

export interface ApprovalBucket {
  mechanism: ApprovalMechanism;
  count: number;
  /** created_at (or equivalent) of the oldest pending item, ISO; null when count = 0 or unknown. */
  oldestAt: string | null;
}

// ---------------------------------------------------------------------------
// Added by Area A (sources/dd.ts). Same rules as above: ids, enums, numbers
// and timestamps only. Comment text, notes, summaries and message bodies are
// never part of these shapes.
// ---------------------------------------------------------------------------

/** projects has no status, owner, due date or client link (p2b-schema §2.10). */
export interface DdProject {
  id: string;
  name: string;
  departmentId: string | null;
  createdAt: string;
}

export type ProjectStageStatus = "locked" | "active" | "done";

export interface DdProjectStage {
  id: string;
  projectId: string;
  /** Unique per project; the flow engine walks stages in this order. */
  position: number;
  name: string;
  /** Free text in the DB (scope, architecture, frontend, backend, completed, custom in code). */
  kind: string;
  status: ProjectStageStatus;
  /** Set in code by note edits and status flips (no trigger). */
  updatedAt: string;
}

export type ClientHealthLabel = "thriving" | "steady" | "shaky" | "at_risk";
export type TouchpointLabel = "green" | "yellow" | "red";

/**
 * The client roster plus the stored health and touchpoint columns. The
 * effective health is healthOverrideLabel ?? healthLabel. Both health and
 * lastOutboundEmailAtExternal are refreshed only by a cron that doesn't run on
 * Railway, so show their timestamps next to them (p2b-schema §2.11).
 */
export interface DdClient {
  id: string;
  name: string;
  /** Free text with no app write path; "active" by default. */
  status: string;
  healthScore: number | null;
  healthLabel: ClientHealthLabel | null;
  healthSampleSize: number | null;
  healthComputedAt: string | null;
  healthOverrideLabel: ClientHealthLabel | null;
  healthOverrideBy: string | null;
  healthOverrideAt: string | null;
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointOverrideBy: string | null;
  touchpointOverrideAt: string | null;
  /**
   * The Missive SENT-folder half of "last emailed" only. Mail sent through
   * DD's composer (email_drafts status 'sent') is the other half.
   */
  lastOutboundEmailAtExternal: string | null;
  touchpointSyncedAt: string | null;
}

/** One activity_logs row without its free-text detail. */
export interface DdActivity {
  id: string;
  taskId: string;
  userId: string;
  /** No CHECK in the DB: created, status_change, comment, handoff, extended, ... (p2b-schema §2.5). */
  action: string;
  createdAt: string;
}

/** When a task last entered a status, from its status_change log (p2b-schema §6). */
export interface DdStatusEntry {
  taskId: string;
  enteredAt: string;
}

/** Legacy task_messages row, without its body. */
export interface DdTaskMessage {
  id: string;
  taskId: string;
  /** NULL once the author is off-boarded. */
  userId: string | null;
  createdAt: string;
}

export type TaskNotificationKind = "mention" | "notified";

/** A task_notifications row, without its note. seen_at is left out on purpose: the bell marks everything seen. */
export interface DdTaskNotification {
  id: string;
  /** The recipient. */
  userId: string;
  taskId: string;
  kind: TaskNotificationKind;
  /** from_user_id; NULL for system notifications or an off-boarded sender. */
  actorId: string | null;
  createdAt: string;
}

/** A due-date extension, without its reason. */
export interface DdTaskExtension {
  id: string;
  taskId: string;
  /** Who filed the extension (it is self-service, so in practice the assignee). */
  userId: string;
  /** The due date it replaced; NULL when the task had none. */
  previousDueDate: string | null;
  newDueDate: string;
  createdAt: string;
}

/**
 * An incident_logs row, without its description. The table has no status,
 * severity, task or client column, and resolved_at is never written, so it
 * can't say whether an incident is still open: its companion task
 * (tags ∋ incident) does (p2b-schema §2.14).
 */
export interface DdIncidentLog {
  id: string;
  issueType: string;
  affectedUrl: string | null;
  createdAt: string;
}

/** site_health_alerts.priority: high below 50, medium from 50 to 69. */
export type SiteAlertPriority = "high" | "medium";

/** A low site-score alert. Healthy scans (skipped_reason 'above-threshold') are never returned. */
export interface DdSiteHealthAlert {
  id: string;
  website: string;
  /** www-stripped host; NULL on rows the router couldn't parse. */
  domain: string | null;
  score: number;
  threshold: number;
  priority: SiteAlertPriority | null;
  /** The investigation task it opened, if any. */
  taskId: string | null;
  /** NULL when a task was opened; 'no-assignee' for a real low score with no owner. */
  skippedReason: string | null;
  createdAt: string;
}

/** A clock segment. A NULL taskId is general shift time; a NULL endedAt is still running. */
export interface DdTimeEntry {
  id: string;
  userId: string;
  taskId: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** An EOD note's status only, never its text. noteDate is the ET calendar day. */
export interface DdEodNote {
  userId: string;
  noteDate: string;
  /** NULL = saved but not submitted. */
  submittedAt: string | null;
  reviewedAt: string | null;
}

// ---------------------------------------------------------------------------
// Added by P3 Area E (email correlation and the email producers). Same rules:
// ids, enums, numbers and timestamps, plus the match signals the client
// matcher needs. No notes, summaries, email subjects or score reasons.
// ---------------------------------------------------------------------------

/**
 * What the client matcher needs from a client (correlate.ts, L14): the exact
 * contact addresses and the website hosts. Every client is returned; the
 * matcher keeps the active ones (status null or "active").
 */
export interface DdClientMatchSignals {
  id: string;
  name: string;
  /** Free text, as stored (NULL stays NULL here: the matcher decides what is active). */
  status: string | null;
  website: string | null;
  websites: string[];
  contactEmails: string[];
  /** low / medium / high bucket, free text in the DB. */
  priority: string | null;
}

/**
 * One inbound email_satisfaction_scores row reduced to numbers (L13): which
 * client, the AI score (0-100) and when. The sender and thread were used to
 * screen the row and are never part of it; the subject and the model's reason
 * are never read at all.
 */
export interface DdSatisfactionSignal {
  clientId: string;
  /** satisfaction_score, an AI assessment (Haiku): 0 hostile … 100 delighted. */
  score: number;
  deliveredAt: string;
  scoredAt: string;
}

/** A client meeting record without its transcript, summary or brief. */
export interface DdClientMeeting {
  id: string;
  title: string;
  /** client_meetings.meeting_date: when the meeting happened. */
  meetingAt: string;
}

// ---------------------------------------------------------------------------
// Added by P5a (contract §3.1.3; lead seed). Same rules: ids, enums, numbers,
// hours and timestamps. Never tokens, comment text, notes, reasons or mail
// content. The fields above are untouched.
// ---------------------------------------------------------------------------

/** A user's schedule and ritual flags (A3). Never tokens. */
export interface DdUserSchedule {
  userId: string;
  dailyCapacity: number;
  /** users.weekly_schedule validated: day key → {start,end} ("HH:MM") or null; {} when unset or malformed. */
  weeklySchedule: Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { start: string; end: string } | null>>;
  workHoursStart: string | null;
  workHoursEnd: string | null;
  dailyPromptsEnabled: boolean;
  dailyPromptsRequired: boolean;
  clockEnabled: boolean;
  createdAt: string;
}

/** A task's hour columns (capacity.ts's load math). */
export interface DdTaskHours {
  taskId: string;
  estimatedHours: number;
  actualHours: number;
  actualHoursOverride: number | null;
}

/** A project task in any state (drafts, deleted and rejected rows included: check the flags). */
export interface DdProjectTask extends DdTask {
  parallelGroup: number | null;
  stagePosition: number | null;
}

/** One status_change row, first line parsed; the text after it never leaves sources/dd.ts. */
export interface DdStatusTransition {
  id: string;
  taskId: string;
  userId: string;
  from: string;
  to: string;
  at: string;
}

/** A reply on an update (EOD), metadata only. */
export interface DdUpdateReply {
  id: string;
  targetId: string;
  userId: string;
  createdAt: string;
}

/** A task's links to its source mail (C25): the clone thread ids from tasks.missive_thread_url ("?thread=<id>") and from
 *  email_intake_log rows with this task_id, and tasks.client_email (the sender intake recorded). Never logged. Tasks with
 *  neither a thread nor a client_email are absent. */
export interface DdTaskThreadLink {
  taskId: string;
  threadIds: string[];
  clientEmail: string | null;
}

export type ApproverRule =
  | { kind: "leaders_or_department_heads"; departmentIds: string[] } // draft tasks: canActOnDraft; EOD reviews: eod/review route
  | { kind: "fb_managers_or_leaders"; excludeUserId: string | null } // FB proofs: isFbProofer, never the submitter
  | { kind: "email_approvers_or_department_head"; departmentId: string | null } // email drafts: isApprover + dept head
  | { kind: "leaders_or_any_department_head" }; // unrouted mail: routing-review route

export interface ApprovalItem {
  mechanism: ApprovalMechanism;
  /** task id (draft_tasks, fb_proofs), email draft id, routing decision id, or EOD note id. */
  id: string;
  /** A task title, or a fixed label (C19). Never mail content. */
  title: string;
  requesterId: string | null;
  /** ISO; null when unknown. */
  waitingSince: string | null;
  /** waitingSince is a lower bound (e.g. a proof with no fb_proof row: lastActivityAt). */
  waitingSinceIsLowerBound: boolean;
  approver: ApproverRule;
  taskId: string | null;
  clientName: string | null;
  departmentId: string | null;
}

export interface ApprovalItemList {
  mechanism: ApprovalMechanism;
  mode: "items" | "count_only";
  /** Oldest waiting first, at most `limit`. */
  items: ApprovalItem[];
  /** Everything pending under the same predicate as getPendingApprovals. */
  total: number;
  truncated: boolean;
}
