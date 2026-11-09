// DD text triage types (P5a contract §3.1.4; lead seed, Area D owns the file
// from here). Pure and client-safe: no imports. A DdtextItem's `text` lives in
// memory only; the stored shapes (DdtextItemRow, DdtextSignalRow) carry ids,
// enums, hashes, timestamps and the AI summary (≤200 characters), never the
// DD text itself (contract §0.3).

export const DDTEXT_VERSION = "ddtext-v1";
export type DdtextSourceType = "comment" | "status_comment" | "handoff_note" | "extension_reason" | "eod_note" | "sod_note";
export type DdtextKind = "blocker" | "waiting" | "decision" | "mention";
export type DdtextConfidence = "high" | "medium" | "deterministic";
export type DdtextOutcome = "signals" | "none" | "failed" | "deferred";
export type DdtextFailure = "refusal" | "truncated" | "invalid_output" | "input_too_large";
export const DDTEXT_ATTENTION_KINDS = ["ddtext_blocker", "ddtext_waiting", "ddtext_decision", "ddtext_mention"] as const;
/** The kinds whose substance is a model's reading: their rows show a visible AI-assessed label (C24, a-correct-11). */
export const DDTEXT_AI_KINDS = ["ddtext_blocker", "ddtext_waiting", "ddtext_decision"] as const;
/** Liveness windows (C17): task sources, notes. Also the attention-row deletion window (a-correct-1). */
export const DDTEXT_LIVE_DAYS = 14;
export const DDTEXT_NOTE_LIVE_DAYS = 3;

/** One DD text item ready to triage. `text` is sanitized and clipped; it lives in memory only. */
export interface DdtextItem {
  /** "i1".."iN" within a batch */
  ref: string;
  sourceType: DdtextSourceType;
  sourceId: string;
  taskId: string | null;
  authorUserId: string;
  /** comment created_at, or the note's submitted_at */
  sourceCreatedAt: string;
  /** notes only */
  noteDate: string | null;
  text: string;
  contentHash: string;
  /** deterministic (§3.12.3) */
  mentionsPrincipal: boolean;
}

export interface DdtextItemRow {
  principalId: string;
  sourceType: DdtextSourceType;
  sourceId: string;
  taskId: string | null;
  authorUserId: string;
  sourceCreatedAt: string;
  noteDate: string | null;
  outcome: DdtextOutcome;
  failure: DdtextFailure | null;
  contentHash: string;
  model: string | null;
  triageVersion: string;
  triagedAt: string;
  expiresAt: string;
}

export interface DdtextSignalRow {
  sourceType: DdtextSourceType;
  sourceId: string;
  kind: DdtextKind;
  summary: string | null;
  confidence: DdtextConfidence;
  taskId: string | null;
  authorUserId: string;
  sourceCreatedAt: string;
  createdAt: string;
}
