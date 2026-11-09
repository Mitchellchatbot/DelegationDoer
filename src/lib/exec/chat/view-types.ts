import type { SourceRef } from "@/lib/exec/types";

// P5b's chat view types (contract §3.1; lead seed, frozen): what the routes
// and the SSE stream send and what the UI renders. Pure and client-safe: no
// server-only, types only (every import is `import type`).

export type ChatStatusView = "running" | "complete" | "aborted" | "refused" | "failed" | "capped";
export interface DisplaySource { n: number; ref: string; source: SourceRef }
export interface ProposalView {
  id: string;
  status: "pending" | "confirming" | "confirmed" | "dismissed" | "withdrawn" | "expired";
  title: string; description: string;           // the FULL stored text (≤ 4,000), never clipped (C23)
  assigneeName: string | null; departmentName: string | null; dueOn: string | null; clientName: string | null;
  priority: "low" | "medium" | "high" | "critical";
  taskHref: string | null; expiresAt: string;
  /** C23/C43: sha256 hex of [title, description, assigneeUserId, departmentId, clientName, dueAt, priority]; echoed by Confirm. */
  contentHash: string;
  /** C23: the proposal's turn consulted email or S4 DD text. */
  privacyNotice: boolean;
  /** C20: a redaction cleared the content (any status). */
  redacted: boolean;
}
export type CardView =
  | { kind: "task_proposal"; proposal: ProposalView }
  | { kind: "draft"; draftId: string; href: string; existing: boolean; privateRefKinds: ("other_threads" | "dd_text" | "other_clients" | "private_slack")[] };   // P7b: + private_slack (stage-0 seed)
export interface ChatMessageView {
  id: string; turnId: string; role: "user" | "assistant";
  status: ChatStatusView; statusReason: string | null;
  text: string; recommendations: string; sources: DisplaySource[]; cards: CardView[];
  createdAt: string; finishedAt: string | null; redacted: boolean;
  contextKind: "attention" | "project" | "client" | "thread" | null;   // user rows only; never a label
}
export interface ChatConversationView { id: string; title: string; createdAt: string; lastMessageAt: string; turnCount: number }
export interface ChatDonePayload {
  messageId: string; conversationId: string; turnId: string; conversationTitle: string;
  status: ChatStatusView; statusReason: string | null;
  answer: string; recommendations: string; sources: DisplaySource[]; cards: CardView[];
  /** false when the finish write failed: the answer was shown but not stored (the stale sweep fails the row). */
  saved: boolean;
}
export type ChatSseEvent =
  | { event: "hello"; data: { turnId: string; conversationId: string; messageId: string; created: boolean } }
  | { event: "text"; data: { round: number; delta: string } }
  | { event: "tool"; data: { round: number; callId: string; name: string; label: string; state: "running" | "done" | "error" | "skipped" } }
  | { event: "retract"; data: Record<string, never> }
  | { event: "done"; data: ChatDonePayload }
  | { event: "error"; data: { code: "internal" } };            // a failure after hello and before done; never a message
