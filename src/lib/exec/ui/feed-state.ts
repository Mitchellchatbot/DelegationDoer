import type {
  AttentionFeedItem,
  AttentionStatus,
  AttentionStatusFilter,
  EmailScreenState,
  OwnerAction
} from "@/lib/exec/attention-types";
import { formatInZone } from "@/lib/exec/format";
import { FEED_COPY, type FeedMessage } from "./feed-api";

// The feed list's state, as a pure reducer (P5a contract §3.13.2, test 66).
// FeedList dispatches what happened; this decides what each row shows:
//   - an action in flight marks its row pending (the button says "Saving…");
//   - an applied action replaces the item with the server's copy, and so its
//     version (the next action's CAS token, C3);
//   - an item the action moved out of this view (a dismiss in the active
//     list, say) becomes a one-line stub with Undo (reopen, at the new
//     version) instead of vanishing without a word;
//   - a 409 merges the server's current item into the row and says why;
//   - a 404 removes the row, with a list-level notice;
//   - Load more appends, skipping ids already shown (a row whose priority
//     moved can come round again, C5).
// Pure and client-safe: no I/O, no clock (each event carries its `now`).

export interface FeedRow {
  item: AttentionFeedItem;
  pending: OwnerAction | "feedback" | null;
  message: FeedMessage | null;
  /** The last action moved the item out of this view: the row shows only its message (and Undo). */
  outOfView: boolean;
}

export interface FeedState {
  /** The view's status filter: decides whether an acted-on item still belongs here. */
  status: AttentionStatusFilter;
  tz: string;
  rows: FeedRow[];
  cursor: string | null;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  hiddenEmail: number;
  emailScreen: EmailScreenState;
  /** A list-level line: an item that is gone, or hidden by the screen after an action. */
  notice: FeedMessage | null;
}

export type FeedEvent =
  | { type: "action_started"; id: string; action: OwnerAction }
  | { type: "action_applied"; id: string; action: OwnerAction; changed: boolean; item: AttentionFeedItem | null; now: string }
  | { type: "action_conflict"; id: string; item: AttentionFeedItem | null; message: FeedMessage }
  | { type: "action_gone"; id: string; message: FeedMessage }
  | { type: "action_failed"; id: string; message: FeedMessage }
  | { type: "feedback_started"; id: string }
  | { type: "feedback_recorded"; id: string }
  | { type: "feedback_failed"; id: string; message: FeedMessage }
  | { type: "load_more_started" }
  | { type: "load_more_succeeded"; items: readonly AttentionFeedItem[]; nextCursor: string | null; hiddenEmail: number; emailScreen: EmailScreenState }
  | { type: "load_more_failed" };

export const HIDDEN_AFTER_ACTION = FEED_COPY.hiddenNow;
export const HIDDEN_NOW = "This item is hidden now: restricted sender.";

export function initialFeedState(input: {
  items: readonly AttentionFeedItem[];
  cursor: string | null;
  status?: AttentionStatusFilter;
  tz: string;
  hiddenEmail?: number;
  emailScreen?: EmailScreenState;
}): FeedState {
  const seen = new Set<string>();
  const rows: FeedRow[] = [];
  for (const item of input.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push({ item, pending: null, message: null, outOfView: false });
  }
  return {
    status: input.status ?? "default",
    tz: input.tz,
    rows,
    cursor: input.cursor,
    loadingMore: false,
    loadMoreFailed: false,
    hiddenEmail: input.hiddenEmail ?? 0,
    emailScreen: input.emailScreen ?? "none",
    notice: null
  };
}

/** The status the item is in for him now: a snooze that has run out is open again (attention.ts's rule). */
export function effectiveStatus(item: Pick<AttentionFeedItem, "status" | "snoozeUntil">, nowMs: number): AttentionStatus {
  if (item.status === "snoozed") {
    const until = item.snoozeUntil ? Date.parse(item.snoozeUntil) : Number.NaN;
    if (!Number.isFinite(until) || until <= nowMs) return "open";
  }
  return item.status;
}

/** Whether an item belongs in a view with this status filter (C6). */
export function inView(item: Pick<AttentionFeedItem, "status" | "snoozeUntil">, status: AttentionStatusFilter, nowMs: number): boolean {
  const s = effectiveStatus(item, nowMs);
  switch (status) {
    case "default":
      return s === "open" || s === "seen";
    case "open":
    case "seen":
    case "snoozed":
    case "dismissed":
    case "resolved":
      return s === status;
    default:
      return true;
  }
}

/** The stub's words when an action took the item out of view: "Dismissed." + Undo, "Snoozed until <time>." + Undo, "Marked seen." */
export function outOfViewMessage(action: OwnerAction, item: Pick<AttentionFeedItem, "snoozeUntil">, tz: string, now: string): FeedMessage {
  switch (action) {
    case "dismiss":
      return { tone: "ok", text: "Dismissed.", undo: true };
    case "resolve":
      return { tone: "ok", text: "Resolved.", undo: true };
    case "snooze":
      return { tone: "ok", text: `Snoozed until ${formatInZone(item.snoozeUntil, tz, "datetime", now)}.`, undo: true };
    case "seen":
      return { tone: "ok", text: "Marked seen." };
    case "reopen":
      return { tone: "ok", text: "Reopened." };
    default:
      return { tone: "ok", text: "Saved." };
  }
}

const SCREEN_RANK: Readonly<Record<EmailScreenState, number>> = { none: 0, ok: 1, unavailable: 2 };

function worseScreen(a: EmailScreenState, b: EmailScreenState): EmailScreenState {
  return (SCREEN_RANK[b] ?? 2) > (SCREEN_RANK[a] ?? 2) ? b : a;
}

function updateRow(state: FeedState, id: string, patch: (row: FeedRow) => FeedRow): FeedState {
  let hit = false;
  const rows = state.rows.map((row) => {
    if (row.item.id !== id) return row;
    hit = true;
    return patch(row);
  });
  return hit ? { ...state, rows } : state;
}

function removeRow(state: FeedState, id: string, notice: FeedMessage | null): FeedState {
  const rows = state.rows.filter((row) => row.item.id !== id);
  return rows.length === state.rows.length ? state : { ...state, rows, notice };
}

export function feedReducer(state: FeedState, event: FeedEvent): FeedState {
  switch (event.type) {
    case "action_started":
      // An out-of-view stub keeps its line (and Undo, which shows Saving…) while the undo is in flight.
      return updateRow(state, event.id, (row) => ({ ...row, pending: event.action, message: row.outOfView ? row.message : null }));
    case "action_applied": {
      if (event.item === null) return removeRow(state, event.id, { tone: "ok", text: HIDDEN_AFTER_ACTION });
      const item = event.item;
      const nowMs = Date.parse(event.now);
      return updateRow(state, event.id, () =>
        inView(item, state.status, Number.isFinite(nowMs) ? nowMs : Date.now())
          ? { item, pending: null, message: null, outOfView: false }
          : { item, pending: null, message: outOfViewMessage(event.action, item, state.tz, event.now), outOfView: true }
      );
    }
    case "action_conflict":
      if (event.item === null) return removeRow(state, event.id, { tone: "error", text: HIDDEN_NOW });
      return updateRow(state, event.id, () => ({ item: event.item as AttentionFeedItem, pending: null, message: event.message, outOfView: false }));
    case "action_gone":
      return removeRow(state, event.id, event.message);
    case "action_failed":
      // A failed undo leaves the stub with its Undo, so he can try again.
      return updateRow(state, event.id, (row) => ({ ...row, pending: null, message: row.outOfView ? { ...event.message, undo: true } : event.message }));
    case "feedback_started":
      return updateRow(state, event.id, (row) => ({ ...row, pending: "feedback", message: null }));
    case "feedback_recorded":
      return updateRow(state, event.id, (row) => ({ ...row, pending: null, message: { tone: "ok", text: FEED_COPY.thanks } }));
    case "feedback_failed":
      return updateRow(state, event.id, (row) => ({ ...row, pending: null, message: event.message }));
    case "load_more_started":
      return { ...state, loadingMore: true, loadMoreFailed: false };
    case "load_more_succeeded": {
      const ids = new Set(state.rows.map((row) => row.item.id));
      const added: FeedRow[] = [];
      for (const item of event.items) {
        if (ids.has(item.id)) continue;
        ids.add(item.id);
        added.push({ item, pending: null, message: null, outOfView: false });
      }
      return {
        ...state,
        rows: [...state.rows, ...added],
        cursor: event.nextCursor,
        loadingMore: false,
        loadMoreFailed: false,
        hiddenEmail: state.hiddenEmail + Math.max(0, Math.floor(event.hiddenEmail) || 0),
        emailScreen: worseScreen(state.emailScreen, event.emailScreen)
      };
    }
    case "load_more_failed":
      return { ...state, loadingMore: false, loadMoreFailed: true };
    default:
      return state;
  }
}
