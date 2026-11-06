import type { DraftView } from "@/lib/exec/drafts-types";

// Which body surface a draft state gets (P4 contract §3.13.4, C74): the
// editor only in the editable states, a static preview of DraftView.bodyText
// in every read-only state, and nothing where the table says "hidden". The
// editor is never mounted read-only (it has no such mode), so a state that
// must not be edited shows DraftBodyPreview instead.
export type BodyMode = "editor" | "preview" | "hidden";

/**
 * Whether the editor's changes go to the autosave queue (ui-1, C74): whenever
 * the editor is mounted on an editable row, also while an action is running.
 * The editor can't be locked, so dropping a change typed during a Save would
 * lose it; queued, it is PATCHed after the action (T14 on a saved row, a 409
 * with the "changed elsewhere" notice on a row the action left in flight).
 */
export function acceptsTyping(o: { isTop: boolean; mode: BodyMode; canEdit: boolean; busy: unknown }): boolean {
  // `busy` (a running action) deliberately doesn't gate it.
  return o.isTop && o.mode === "editor" && o.canEdit;
}

/**
 * Whether a view re-seeds the editor (ui-1): only a server view, only in editor
 * mode, and never while an edit he typed is still unsent: the server's answer
 * to a running action must not overwrite text the queue hasn't sent yet.
 */
export function seedsEditorFrom(o: { from: "edit" | "server"; mode: BodyMode; unsentEdit: boolean }): boolean {
  return o.from === "server" && o.mode === "editor" && !o.unsentEdit;
}

export function bodyModeFor(view: DraftView | null): BodyMode {
  if (view === null) return "hidden";
  if (view.restricted) return "hidden";
  switch (view.status) {
    case "generating":
      // A regenerate keeps the previous text in view; a first generation has none.
      return view.bodyText !== null && view.bodyText.trim() !== "" ? "preview" : "hidden";
    case "generation_failed":
    case "discarded":
      return "hidden";
    case "draft":
    case "saved":
      // "drafts unavailable" (§3.13.4): a read-only preview until the clone path is proven again.
      return view.capabilities.canEdit ? "editor" : "preview";
    case "saving":
    case "sending":
    case "sent_pending":
    case "sent":
    case "sent_external":
    case "unknown":
    case "gone":
    case "discarding":
      return "preview";
    default:
      return "preview";
  }
}
