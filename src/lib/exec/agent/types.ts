import type { ApprovalMechanism } from "@/lib/exec/sources/dd-types";
import type { SourceRef } from "@/lib/exec/types";

// P5b's shared chat types (contract §3.1; lead seed, frozen). Types and one
// constant: no I/O and no server-only, so client code may `import type` from
// it. Builders may add optional fields; a change to a frozen shape is stated
// in the builder's result and reconciled by the integrator.

export const CHAT_TOOL_NAMES = [
  "get_overview", "list_attention", "team_progress", "search_tasks", "get_task", "project_health",
  "pending_approvals", "recurring_issues", "client_overview", "search_email", "get_email_thread",
  "list_commitments", "get_eod_reports", "propose_task", "create_draft", "get_source"
] as const;
export type ToolName = (typeof CHAT_TOOL_NAMES)[number];

/** What a ref points at: enough to re-fetch it (get_source) and to redact by thread (C19). */
export type RefTarget =
  | { type: "task"; id: string }
  | { type: "client"; id: string }
  | { type: "project"; id: string }
  | { type: "person"; id: string }
  | { type: "department"; id: string }
  | { type: "attention"; id: string; threadId: string | null }
  | { type: "email_thread"; id: string }                       // id = clone thread id
  | { type: "commitment"; id: string; threadId: string }
  | { type: "eod_note"; userId: string; date: string }          // ET calendar date
  | { type: "sod_note"; userId: string; date: string }          // the user's own calendar date
  | { type: "approval"; mechanism: ApprovalMechanism; id: string | null }
  | { type: "meeting"; id: string; clientId: string }
  | { type: "page"; path: string };

export interface RefEntry { ref: string; target: RefTarget; source: SourceRef }   // ref = "r<n>"
export type CitedSource = RefEntry;                                                 // persisted in exec_messages.sources

export type ChatStatus = "running" | "complete" | "aborted" | "refused" | "failed" | "capped";
export type ChatStatusReason =
  | "round_cap" | "cost_ceiling" | "chat_budget" | "daily_budget" | "truncated" | "deadline"   // capped
  | "client_abort"                                                                              // aborted
  | "refusal"                                                                                   // refused
  | "model_error" | "protocol" | "empty_answer" | "stale" | "internal";                         // failed

export type ChatContextKind = "attention" | "project" | "client" | "thread";
export interface ChatContextInput { kind: ChatContextKind; id: string }
export interface ResolvedContext { kind: ChatContextKind; id: string; target: RefTarget; source: SourceRef }

export interface PersistedToolCall {
  round: number; name: ToolName; args: Record<string, unknown>;   // strings clipped to 500
  ok: boolean; error: ToolErrorCode | null; ms: number;
}
export type ToolErrorCode =
  | "dd_read" | "mail_read" | "rules_unavailable" | "not_found" | "timeout" | "bad_input" | "budget"
  | "too_many" | "unknown_tool" | "email_limit" | "limit" | "internal";

/** C24: what made a chat draft "private refs". */
export type PrivateRefKind = "other_threads" | "dd_text" | "other_clients";
export type ChatCard =
  | { kind: "task_proposal"; id: string }
  | { kind: "draft"; id: string; existing: boolean; privateRefKinds: PrivateRefKind[] };

export interface TurnUsage {
  modelCalls: number; toolCalls: number; toolCallsNotPersisted: number;   // C14: records past 100 are counted only
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; costUsd: number;
  transformations: number; unknownMarkers: number; partialRoundUncounted: boolean;
  promptVersion: string; toolsVersion: string;
}

export interface AgentEventSink {
  text(round: number, delta: string): void;
  tool(e: { round: number; callId: string; name: ToolName; label: string; state: "running" | "done" | "error" | "skipped" }): void;
  retract(): void;
}

/** C53 (b-agent-9): every list a tool caps; built by serialize.ts's capList. */
export interface CappedList<T> { items: T[]; total: number; truncated: boolean }
