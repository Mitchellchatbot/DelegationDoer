import type { ResolveAction } from "@/lib/exec/drafts-types";

// The panel's actions and busy states (P4 contract §3.13.3). Pure types and
// the few constants the presentational pieces share; client-safe.
//
// "check_again" is the resolve route's `check` (C70); "stop" is
// `stop_generation` (C71). The four "changed in Outlook" actions of §3.13.4:
// show_outlook_version (a check that returns the read-back), replace_with_dd
// (save with seenContentHash), resolve:keep_outlook_version, delete_anyway
// (discard with seenContentHash).
export type DraftUiAction =
  | "generate"
  | "write_myself"
  | "regenerate"
  | "save"
  | "review"
  | "discard"
  | "delete_restricted"
  | "open_in_outlook"
  | "check_again"
  | "stop"
  | "show_outlook_version"
  | "replace_with_dd"
  | "delete_anyway"
  | `resolve:${ResolveAction}`;

export type DraftBusy = "generating" | "saving" | "reviewing" | "sending" | "discarding" | "resolving" | "checking";

/** The actions that need the "I checked my Sent Items in Outlook" box ticked first (§3.13.4). */
export const NEEDS_CHECKED_OUTLOOK: ReadonlySet<DraftUiAction> = new Set<DraftUiAction>([
  "resolve:mark_sent",
  "resolve:not_sent_new_draft",
  "resolve:copy_to_new_draft"
]);

/** The busy state an action puts the panel in while its request runs. */
export function busyFor(action: DraftUiAction): DraftBusy {
  switch (action) {
    case "generate":
    case "write_myself":
    case "regenerate":
      return "generating";
    case "save":
    case "replace_with_dd":
      return "saving";
    case "review":
      return "reviewing";
    case "discard":
    case "delete_restricted":
    case "delete_anyway":
      return "discarding";
    case "check_again":
    case "show_outlook_version":
      return "checking";
    default:
      return "resolving";
  }
}
