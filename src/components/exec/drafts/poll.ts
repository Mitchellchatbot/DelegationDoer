import type { DraftView } from "@/lib/exec/drafts-types";
import { COPY } from "./copy";

// DraftPanel's polling plan (P4 contract C42): how often to re-read the draft
// while something is in flight, and nothing otherwise. Pure, so the
// schedule is unit-tested; the panel stops the timer while the tab is hidden.
//
//   generating                          every 2 s for 3 min, then every 10 s
//   saving / discarding / sending        every 3 s
//   sent_pending / unknown / gone+unconfirmed
//                                        every 5 s for 2 min, then every 30 s
//   anything else                        no polling
//
// A failed poll keeps the last view and backs off to 30 s.

export const POLL_FAIL_BACKOFF_MS = 30_000;
export const POLL_GIVE_UP_FAILURES = 3;

/** Milliseconds until the next poll, or null when the state needs none. `elapsedMs` is since the state was entered. */
export function pollIntervalFor(view: DraftView | null, elapsedMs: number, failures = 0): number | null {
  if (view === null) return null;
  const base = baseIntervalFor(view, elapsedMs);
  if (base === null) return null;
  return failures > 0 ? Math.max(base, POLL_FAIL_BACKOFF_MS) : base;
}

function baseIntervalFor(view: DraftView, elapsedMs: number): number | null {
  switch (view.status) {
    case "generating":
      return elapsedMs < 180_000 ? 2_000 : 10_000;
    case "saving":
    case "discarding":
    case "sending":
      return 3_000;
    case "sent_pending":
    case "unknown":
      return elapsedMs < 120_000 ? 5_000 : 30_000;
    case "gone":
      return view.gone.unconfirmed ? (elapsedMs < 120_000 ? 5_000 : 30_000) : null;
    default:
      return null;
  }
}

/** The banner above the last view after `failures` polls in a row failed; null while none did. */
export function pollErrorCopy(failures: number): string | null {
  if (failures <= 0) return null;
  return failures >= POLL_GIVE_UP_FAILURES ? COPY.pollGiveUp : COPY.pollRetrying;
}

/** When the current state was entered, from the view (the last status change bumps updated_at). */
export function stateEnteredAtMs(view: DraftView): number {
  const t = Date.parse(view.updatedAt);
  return Number.isFinite(t) ? t : Date.parse(view.createdAt);
}
