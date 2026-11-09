// Shared contracts for the Executive AI Assistant layer (src/lib/exec).
//
// Every exec module codes against these types. They carry no runtime code
// except the error classes at the bottom, so any module can import them
// without pulling in Supabase, Next or the Anthropic SDK.
//
// Plan: ~/.claude/plans/project-scaled-ai-executive-serene-waterfall.md (§2).

// ---------------------------------------------------------------------------
// Principal: the executive an exec request/job acts for.
// ---------------------------------------------------------------------------

declare const principalBrand: unique symbol;

export interface ExecPrincipalData {
  /** exec_principals.id */
  id: string;
  /** users.id */
  userId: string;
  /** users.email, trimmed + lowercased */
  email: string;
  name: string;
  /** Resolved IANA zone: settings.brief_timezone → users.work_timezone → America/New_York */
  timezone: string;
  /** Missive (missiveclone) account ids this principal's mail access is pinned to. */
  mailAccountIds: readonly string[];
  /** Unused: the Slack binding is exec_slack_installations, P6 K6. */
  slackTeamId: string | null;
  /** Unused: the Slack binding is exec_slack_installations, P6 K6. */
  slackUserId: string | null;
}

/**
 * A principal that a TRUSTED path produced: requireExecPrincipal (verified web
 * session), the job runner (job row → principal) or, later, the Slack
 * verifier. Only src/lib/exec/principal.ts may produce one: boundary.test.ts
 * flags every other way to get the brand (casts, spreads of a real principal,
 * type guards, imports of the loaders outside the trusted paths). Exec
 * services take an ExecPrincipal, never a bare user id.
 */
export type ExecPrincipal = Readonly<ExecPrincipalData> & { readonly [principalBrand]: true };

export type RestrictedPolicy = "hidden" | "dd_only";
export type WatchMode = "active_public" | "member_only";

/** exec_settings, camel-cased. Defaults live in principal.ts (DEFAULT_SETTINGS). */
export interface ExecSettings {
  principalId: string;
  briefEnabled: boolean;
  /** "HH:MM", 24h, in the principal's timezone */
  briefLocalTime: string;
  /** null = use users.work_timezone, then America/New_York */
  briefTimezone: string | null;
  supersedeLegacyBrief: boolean;
  checkinsEnabled: boolean;
  restrictedPolicy: RestrictedPolicy;
  watchMode: WatchMode;
  mutedChannelIds: string[];
  retentionDaysSlack: number;
  retentionDaysEmail: number;
  retentionDaysChat: number;
  dailyCostCapUsd: number;
  /**
   * exec_settings.email_enabled (P3, L1). Email work runs only when this,
   * emailSchemaReady, EXEC_ENABLED and a non-empty mail pin all hold.
   */
  emailEnabled: boolean;
  /**
   * The P3 migration is applied: the settings read found the email_enabled
   * column. False means P3 code is running ahead of its hand-applied
   * migration, so every email path skips instead of failing (L1).
   */
  emailSchemaReady: boolean;
  /**
   * exec_settings.drafts_enabled (P4, L1): reply and new drafts, generation,
   * save to Outlook. On only with draftsSchemaReady, email on and a pin.
   */
  draftsEnabled: boolean;
  /** exec_settings.send_enabled (P4, L1, L23): Send from DD, on top of draftsEnabled. */
  sendEnabled: boolean;
  /** exec_settings.voice_enabled (P4, L17): the weekly style profile. */
  voiceEnabled: boolean;
  /**
   * The P4 migration is applied: the settings read found the drafts_enabled,
   * send_enabled and voice_enabled columns. False means P4 code is running
   * ahead of its hand-applied migration, so every drafts path skips (L1).
   */
  draftsSchemaReady: boolean;
  /** exec_settings.ddtext_enabled (P5a, A5). DD text triage runs only when this and ddtextSchemaReady hold. */
  ddtextEnabled: boolean;
  /** exec_settings.retention_days_ddtext (P5a, A5), default 90. */
  retentionDaysDdtext: number;
  /** The P5a migration is applied: the settings read found its columns, so exec_attention_feedback and exec_ddtext_* exist too. */
  ddtextSchemaReady: boolean;
  /** exec_settings.chat_enabled (P5b). False when the column is missing. */
  chatEnabled: boolean;
  /** exec_settings.ask_ai_uses_exec (P5b, B10). */
  askAiUsesExec: boolean;
  /** exec_settings.chat_daily_cap_usd (P5b, B8). Default 9. */
  chatDailyCapUsd: number;
  /** The settings read found the P5b columns (the P5b migration is applied). */
  chatSchemaReady: boolean;
}

// ---------------------------------------------------------------------------
// Surfaces, actors, audit
// ---------------------------------------------------------------------------

export type ExecSurface = "web" | "slack" | "cron" | "job";
export type ExecActor = "owner" | "system" | "slack" | "job";

export interface AuditEntry {
  actor: ExecActor;
  /** dotted verb, e.g. "draft.save", "settings.update", "tool.call" */
  action: string;
  /** what it acted on, e.g. "exec_drafts:123" or a tool name */
  target?: string | null;
  input?: unknown;
}

// ---------------------------------------------------------------------------
// Background jobs (table exec_jobs, RPCs exec_claim_jobs / exec_heartbeat_job
// / exec_finish_job / exec_reap_expired_leases)
// ---------------------------------------------------------------------------

export type JobLane = "interactive" | "bulk";
export type JobStatus = "queued" | "running" | "succeeded" | "dead" | "cancelled";

/** A row of public.exec_jobs exactly as PostgREST returns it. */
export interface ExecJobRow {
  id: number;
  kind: string;
  lane: JobLane;
  principal_id: string | null;
  /** References only (ids, event ids, cursors) — never message bodies. */
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_until: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  result: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnqueueJobInput {
  kind: string;
  lane: JobLane;
  principalId: string | null;
  payload?: Record<string, unknown>;
  /** Unique across exec_jobs. A duplicate enqueue is a silent no-op. */
  dedupeKey?: string | null;
  runAfter?: Date;
  maxAttempts?: number;
}

export interface JobContext {
  job: ExecJobRow;
  /** Loaded from job.principal_id by the runner; null for system jobs. */
  principal: ExecPrincipal | null;
  /** Aborted on handler timeout or when the lease is lost. Pass it to fetch / the SDK. */
  signal: AbortSignal;
  workerId: string;
}

export interface JobHandler {
  kind: string;
  lane: JobLane;
  /** Hard ceiling for one run; the signal aborts when it elapses. */
  timeoutMs: number;
  run: (ctx: JobContext) => Promise<unknown>;
}

/** How the runner treats a thrown error. */
export type ErrorClass =
  /** network, 429, 5xx, timeout: back off and retry until max_attempts */
  | "retryable"
  /** 400-class request errors, model refusal, bad data: dead immediately */
  | "fatal"
  /** 401/403 from an upstream: dead immediately AND raise a health flag */
  | "auth";

// ---------------------------------------------------------------------------
// Source references — every fact the assistant shows carries one.
// ---------------------------------------------------------------------------

export type SourceSystem = "dd" | "outlook" | "slack" | "meeting" | "web";

/**
 * Drives what may flow where. Draft bodies to third parties may only use
 * "public" and status-level "internal" facts; "private" (Slack private
 * channels/DMs), "finance" and "restricted" stay in DD (plan §8).
 */
export type SourceClass = "public" | "private" | "internal" | "finance" | "restricted";

export interface SourceRef {
  system: SourceSystem;
  /** Stable id in that system (task id, Graph id, `${channel}:${ts}`, ...) */
  id: string;
  /** Deep link, already validated by isAllowedLinkUrl, or null when none exists. */
  url: string | null;
  label: string;
  class: SourceClass;
  /** Short quote, ≤280 chars, only where the UI needs one. */
  excerpt?: string;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type ExecLlmFeature = "chat" | "draft" | "brief" | "triage" | "digest" | "voice" | "spike" | "ddtext";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// ---------------------------------------------------------------------------
// Errors shared across modules
// ---------------------------------------------------------------------------

/** Throw from a job handler to make the runner skip retries (dead now). */
export class NonRetryableError extends Error {
  readonly errorClass: ErrorClass;
  constructor(message: string, errorClass: Exclude<ErrorClass, "retryable"> = "fatal") {
    super(message);
    this.name = "NonRetryableError";
    this.errorClass = errorClass;
  }
}

/** The principal's daily AI spend cap is reached. Not retryable today. */
export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly capUsd: number;
  constructor(spentUsd: number, capUsd: number) {
    super(`daily AI cost cap reached ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)})`);
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

/** The audit row for a side effect couldn't be written, so the side effect must not run. */
export class AuditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}
