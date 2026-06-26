// Client-safe stage configuration for the outbound sales pipeline.
//
// This module is deliberately FREE of any server-only imports (no supabase,
// no `import "server-only"`) so it can be imported by BOTH the server data
// layer (lib/outbound-leads.ts, lib/outbound-transitions.ts) AND client
// components (the kanban board, the leads table). It is the single source of
// truth for: the LeadStatus union, the state-machine transition map, which
// transitions a rep may drive by hand, and the per-stage display metadata
// (labels + colors) shared across the table, the funnel strip, and the board.

export type LeadStatus =
  | "warm_lead" | "booked" | "showed" | "no_show" | "contract" | "success" | "lost";

// Full state machine. transitionLead enforces this on every write; anything
// outside the map is rejected. Booking (warm_lead → booked) and the
// booked → warm_lead revert live here because the Calendly webhook drives
// them — reps do NOT trigger those by hand (see MANUAL_TRANSITIONS).
export const ALLOWED_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  warm_lead: ["booked", "lost"],
  booked:    ["showed", "no_show", "warm_lead", "contract", "success", "lost"],
  showed:    ["contract", "success", "lost"],
  no_show:   ["contract", "success", "lost"],
  contract:  ["success", "lost", "showed"],  // showed = contract retracted
  success:   [],  // terminal
  lost:      ["warm_lead"]  // resurrect-from-lost (rare)
};

// The subset of transitions a rep can drive manually — by dragging a card on
// the kanban board or clicking a detail-page button. Differs from the full
// machine in two ways: `booked` is never a manual target (booking comes from
// Calendly so the meeting time + reminders exist), and a booked lead can't be
// manually shoved back to warm_lead (only a Calendly cancel does that, which
// also restarts the recovery drip).
export const MANUAL_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  warm_lead: ["lost"],
  booked:    ["showed", "no_show", "contract", "success", "lost"],
  showed:    ["contract", "success", "lost"],
  no_show:   ["contract", "success", "lost"],
  contract:  ["showed", "success", "lost"],
  success:   [],
  lost:      ["warm_lead"]
};

export function manualTransitionTargets(from: LeadStatus): LeadStatus[] {
  return MANUAL_TRANSITIONS[from] ?? [];
}

export function canManuallyTransition(from: LeadStatus, to: LeadStatus): boolean {
  return manualTransitionTargets(from).includes(to);
}

// Per-stage display metadata, shared everywhere a stage is rendered.
//   - label   : human label (matches the funnel + filter chips)
//   - pill    : badge classes for the small status pill (table rows + cards)
//   - ring / countBg / countText : board-column tints (mirror MyTasksKanban)
//   - emptyHint : placeholder copy for an empty board column
export interface StageMeta {
  label: string;
  pill: string;
  ring: string;
  countBg: string;
  countText: string;
  emptyHint: string;
}

export const STAGE_META: Record<LeadStatus, StageMeta> = {
  warm_lead: {
    label: "Warm",
    pill: "bg-amber-50 text-amber-700 border-amber-200/60",
    ring: "border-amber-200/70", countBg: "bg-amber-100", countText: "text-amber-700",
    emptyHint: "No new leads."
  },
  booked: {
    label: "Booked",
    pill: "bg-sky-50 text-sky-700 border-sky-200/60",
    ring: "border-sky-200/70", countBg: "bg-sky-100", countText: "text-sky-700",
    emptyHint: "No meetings booked."
  },
  showed: {
    label: "Showed",
    pill: "bg-indigo-50 text-indigo-700 border-indigo-200/60",
    ring: "border-indigo-200/70", countBg: "bg-indigo-100", countText: "text-indigo-700",
    emptyHint: "Nobody's shown yet."
  },
  contract: {
    label: "Contract",
    pill: "bg-violet-50 text-violet-700 border-violet-200/60",
    ring: "border-violet-200/70", countBg: "bg-violet-100", countText: "text-violet-700",
    emptyHint: "No contracts out."
  },
  no_show: {
    label: "No show",
    pill: "bg-rose-50 text-rose-700 border-rose-200/60",
    ring: "border-rose-200/70", countBg: "bg-rose-100", countText: "text-rose-700",
    emptyHint: "No no-shows."
  },
  success: {
    label: "Won",
    pill: "bg-emerald-50 text-emerald-700 border-emerald-200/60",
    ring: "border-emerald-200/70", countBg: "bg-emerald-100", countText: "text-emerald-700",
    emptyHint: "Close one 🚀"
  },
  lost: {
    label: "Lost",
    pill: "bg-slate-100 text-slate-600 border-slate-300/60",
    ring: "border-slate-200/70", countBg: "bg-slate-100", countText: "text-slate-700",
    emptyHint: "Nothing lost."
  }
};

// Left-to-right column order on the board: the happy path first
// (Warm → Booked → Showed → Contract → Won), then the off-ramps.
export const BOARD_COLUMN_ORDER: LeadStatus[] = [
  "warm_lead", "booked", "showed", "contract", "success", "no_show", "lost"
];
