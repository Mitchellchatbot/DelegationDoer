"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { CircleCheck, Filter, Inbox } from "lucide-react";
import type {
  AttentionFeedItem,
  AttentionFilters,
  EmailScreenState,
  FeedbackReason,
  OwnerAction
} from "@/lib/exec/attention-types";
import { draftReplyHrefFor } from "@/lib/exec/drafts-links";
import { formatInZone, pluralize } from "@/lib/exec/format";
import { fetchAttentionPage, patchAttention, postFeedback } from "@/lib/exec/ui/feed-api";
import { feedFocusSelectors, focusFirst, focusLost } from "@/lib/exec/ui/focus";
import type { FeedMessage } from "@/lib/exec/ui/feed-api";
import { feedReducer, initialFeedState, type FeedRow } from "@/lib/exec/ui/feed-state";
import { snoozePresets, type SnoozePreset } from "@/lib/exec/ui/snooze-presets";
import { AttentionRow } from "../AttentionRow";
import { useIsTopWindow } from "../drafts/frame-guard";
import { EmptyState } from "../EmptyState";
import { ago } from "../overview/labels";
import { FeedMessageLine, FeedRowActions } from "./FeedRowActions";

// The Needs Attention list with its row actions (P5a contract §3.13.2, A1,
// A2, S2): the Overview card ("overview") and the full feed page ("full",
// with Load more). It renders AttentionRow for every item and fills the row's
// actions slot only in a top-level window (P4's useIsTopWindow: false on the
// server and the first client render, so the server HTML never carries a
// control; a framed page gets a muted line instead). State lives in the pure
// reducer (ui/feed-state.ts); calls go through ui/feed-api.ts. Client-safe
// imports only: never attention.ts or any server-only module (rule 16).
//
// Draft reply comes from P4's client-safe draftReplyHrefFor through
// AttentionRow's draftReplyHref (K14): the one Draft reply link, also for
// items Load more fetched. Ask AI is P5b's (askAiEnabled, default off).

export interface FeedListProps {
  mode: "overview" | "full";
  initialItems: AttentionFeedItem[];
  initialCursor: string | null;
  filters: AttentionFilters;
  /** The page's time (ISO): every age and time on the list is measured from it. */
  now: string;
  tz: string;
  /** When the feed was last checked (ISO), or null if never. */
  checkedAt: string | null;
  /** When DD text triage last ran, while it is on (a-correct-16). */
  ddtextCheckedAt: string | null;
  hiddenEmail: number;
  emailScreen: EmailScreenState;
  /** P4's G5b predicate: email items offer Draft reply. */
  draftsAvailable: boolean;
  /** P5b: chatSchemaReady && chatEnabled. Default false: no Ask AI link. */
  askAiEnabled?: boolean;
  /**
   * Review ui-4 (additive): the feed's freshness couldn't be read, so an empty
   * list claims neither "nothing needs you" nor "no scan yet".
   */
  freshnessUnknown?: boolean;
  /**
   * Review ui-5 (additive, default true): exec_attention_feedback exists (the
   * P5a migration is applied, settings.ddtextSchemaReady). False: rows offer
   * no Useful / Not useful controls, which could only fail.
   */
  feedbackAvailable?: boolean;
}

export const FEED_LIST_COPY = {
  framed: "Actions are off in an embedded view.",
  emailUnavailable: "Email items are hidden: the restricted-sender check couldn't run. Reload to try again.",
  noMatch: "No items match these filters.",
  clearFilters: "Clear filters",
  loadMore: "Load more",
  loading: "Loading…",
  loadFailed: "Couldn't load more. Try again.",
  // Review ui-4: an empty list while the freshness or the email screen is unknown.
  noItems: "No items to show.",
  orderNote: "Items whose priority changed after this list loaded may have moved. Reload to see the current order."
} as const;

export const FULL_FEED_HREF = "/executive/attention";

/** Any filter beyond the default view is set. */
export function hasActiveFilters(f: AttentionFilters): boolean {
  return (f.status !== undefined && f.status !== "default") || Boolean(f.category || f.band || f.source || f.kind || f.firstSeenAfter || f.updatedAfter);
}

export type FeedEmptyKind = "no_match" | "unknown" | "checked" | "never_checked";

/**
 * Which empty state an empty list shows. A filtered view says no item
 * matches. Otherwise it claims "Nothing needs you right now" only when it
 * knows when the feed was checked and no email item was withheld unchecked;
 * with the freshness unreadable or the email screen unavailable it says only
 * that there are no items to show (review ui-4); never checked: "Items
 * appear after the first scan".
 */
export function feedEmptyKind(p: { filtered: boolean; freshnessUnknown: boolean; emailScreen: EmailScreenState; checkedAt: string | null }): FeedEmptyKind {
  if (p.filtered) return "no_match";
  if (p.freshnessUnknown || p.emailScreen === "unavailable") return "unknown";
  return p.checkedAt ? "checked" : "never_checked";
}

/**
 * P9 F27: the text of the newest row message that changed since the last render (a message object a row didn't have
 * before), or null when none did. Pure.
 */
export function latestRowMessage(before: ReadonlyMap<string, FeedMessage | null>, rows: readonly Pick<FeedRow, "item" | "message">[]): string | null {
  let text: string | null = null;
  for (const r of rows) {
    if (r.message !== null && r.message !== before.get(r.item.id)) text = r.message.text;
  }
  return text;
}

/** U+00A0 NO-BREAK SPACE (built, never typed as an escape). */
const NBSP = String.fromCodePoint(0xa0);

/**
 * P9 fixer ui-7: the live region's text for the nth announcement: the text itself, with a trailing no-break space on every
 * second one, so the same text twice in a row still changes the region (and is read out again). Pure.
 */
export function announceText(a: { text: string; n: number }): string {
  return a.n > 0 && a.n % 2 === 0 ? `${a.text}${NBSP}` : a.text;
}

/** "/executive/chat?context=attention:<id>" while Ask AI is on (coherence-16); else null. */
export function askAiHrefFor(itemId: string, askAiEnabled: boolean): string | null {
  return askAiEnabled ? `/executive/chat?context=attention:${itemId}` : null;
}

export function FeedList({
  mode,
  initialItems,
  initialCursor,
  filters,
  now,
  tz,
  checkedAt,
  ddtextCheckedAt,
  hiddenEmail,
  emailScreen,
  draftsAvailable,
  askAiEnabled = false,
  freshnessUnknown = false,
  feedbackAvailable = true
}: FeedListProps) {
  const isTop = useIsTopWindow();
  // Review ui-7: an action that moves a row out of view (or remounts its
  // controls on the new version) unmounts the focused button. Once the row
  // settles, focus goes to the stub's Undo (else the stub), or to the row's
  // first action when it is still in view, if focus was lost with it.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const [state, dispatch] = useReducer(feedReducer, null, () =>
    initialFeedState({ items: initialItems, cursor: initialCursor, status: filters.status ?? "default", tz, hiddenEmail, emailScreen })
  );
  // P9 F27: a row's outcome (Dismissed, Snoozed, Thanks, a failure) is read out by ONE live region that is always in the
  // list; the row's own message line remounts with the row's controls (or appears in a new stub), and a region that
  // arrives already holding its text isn't reliably announced.
  // P9 fixer ui-7: { text, n }, n counting the announcements. Two outcomes in a row with the same text ("Dismissed." twice)
  // would set the same string, React would skip the render and the region would say nothing the second time; so every
  // second announcement carries a trailing no-break space (U+00A0, built with fromCodePoint), which changes the region's
  // text without changing what is read out.
  const [announced, setAnnounced] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const setAnnouncement = (text: string) => setAnnounced((prev) => ({ text, n: prev.n + 1 }));
  const announcement = announceText(announced);
  const lastMessages = useRef(new Map<string, FeedMessage | null>());
  // Computed only once the actions show (a top-level window, after mount);
  // the click handler recomputes the chosen preset from the clock it has then (C4).
  const presets: SnoozePreset[] = isTop ? snoozePresets(new Date(), tz) : [];

  async function act(row: FeedRow, action: OwnerAction, snoozeUntil?: string) {
    if (row.pending !== null) return;
    const id = row.item.id;
    let until = snoozeUntil;
    if (action === "snooze" && until !== undefined) {
      const key = presets.find((p) => p.until === until)?.key;
      until = snoozePresets(new Date(), tz).find((p) => p.key === key)?.until ?? until;
    }
    focusAfter.current = id;
    dispatch({ type: "action_started", id, action });
    const res = await patchAttention(id, { action, snoozeUntil: until, expectedUpdatedAt: row.item.version });
    switch (res.kind) {
      case "applied":
        dispatch({ type: "action_applied", id, action, changed: res.changed, item: res.item, now: new Date().toISOString() });
        break;
      case "conflict":
        dispatch({ type: "action_conflict", id, item: res.item, message: res.message });
        break;
      case "gone":
        dispatch({ type: "action_gone", id, message: res.message });
        break;
      default:
        dispatch({ type: "action_failed", id, message: res.message });
    }
  }

  async function vote(row: FeedRow, value: 1 | -1, reason: FeedbackReason | null) {
    if (row.pending !== null) return;
    const id = row.item.id;
    dispatch({ type: "feedback_started", id });
    const res = await postFeedback(id, value, reason);
    if (res.kind === "recorded") dispatch({ type: "feedback_recorded", id });
    else if (res.kind === "gone") dispatch({ type: "action_gone", id, message: res.message });
    else dispatch({ type: "feedback_failed", id, message: res.message });
  }

  async function loadMore() {
    if (state.cursor === null || state.loadingMore) return;
    dispatch({ type: "load_more_started" });
    const res = await fetchAttentionPage(filters, state.cursor);
    if (res.ok) dispatch({ type: "load_more_succeeded", items: res.items, nextCursor: res.nextCursor, hiddenEmail: res.hiddenEmail, emailScreen: res.emailScreen });
    else dispatch({ type: "load_more_failed" });
  }

  useEffect(() => {
    const text = latestRowMessage(lastMessages.current, state.rows);
    lastMessages.current = new Map(state.rows.map((r) => [r.item.id, r.message]));
    if (text !== null) setAnnouncement(text);
  }, [state.rows]);

  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    const row = state.rows.find((r) => r.item.id === id);
    if (row && row.pending !== null) return;
    focusAfter.current = null;
    if (!row || typeof document === "undefined" || !focusLost(document.activeElement, document.body)) return;
    focusFirst(rootRef.current, feedFocusSelectors(id, row.outOfView));
  }, [state.rows]);

  const rows = state.rows;
  const filtered = mode === "full" && hasActiveFilters(filters);
  const emptyKind = feedEmptyKind({ filtered, freshnessUnknown, emailScreen: state.emailScreen, checkedAt });
  const emailNotice: { key: "email-unavailable" | "email-hidden"; text: string } | null =
    state.emailScreen === "unavailable"
      ? { key: "email-unavailable", text: FEED_LIST_COPY.emailUnavailable }
      : state.hiddenEmail > 0
        ? { key: "email-hidden", text: `${pluralize(state.hiddenEmail, "email item")} hidden: restricted sender.` }
        : null;

  return (
    <div ref={rootRef} data-feed-list={mode} className="min-w-0">
      {(ddtextCheckedAt || emailNotice) && (
        <div className="space-y-1 border-b border-slate-100 px-4 py-2">
          {ddtextCheckedAt && (
            <p data-ddtext-checked className="text-[11.5px] text-muted">
              DD text checked{" "}
              <time dateTime={ddtextCheckedAt} title={formatInZone(ddtextCheckedAt, tz, "datetime", now)}>
                {ago(ddtextCheckedAt, now)}
              </time>
            </p>
          )}
          {emailNotice && (
            <p
              role="status"
              data-email-notice={emailNotice.key}
              className={
                emailNotice.key === "email-unavailable" ? "rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900" : "text-[12px] text-slate-600"
              }
            >
              {emailNotice.text}
            </p>
          )}
        </div>
      )}
      <div aria-live="polite" role="status" className={state.notice ? "border-b border-slate-100 px-4 py-2 text-[12px] text-slate-700" : "sr-only"}>
        {state.notice?.text ?? ""}
      </div>
      <p aria-live="polite" role="status" data-feed-announce className="sr-only">
        {announcement}
      </p>
      {rows.length === 0 ? (
        emptyKind === "no_match" ? (
          <EmptyState
            icon={Filter}
            message={FEED_LIST_COPY.noMatch}
            action={
              <Link href={FULL_FEED_HREF} prefetch={false} className="text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900">
                {FEED_LIST_COPY.clearFilters}
              </Link>
            }
          />
        ) : emptyKind === "unknown" ? (
          <EmptyState icon={Inbox} message={FEED_LIST_COPY.noItems} />
        ) : emptyKind === "checked" && checkedAt ? (
          <EmptyState
            icon={CircleCheck}
            message="Nothing needs you right now."
            detail={
              <>
                Last checked <time dateTime={checkedAt}>{formatInZone(checkedAt, tz, "datetime", now)}</time>
              </>
            }
          />
        ) : (
          <EmptyState icon={Inbox} message="Nothing here yet." detail="Items appear after the first scan." />
        )
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((row) =>
            row.outOfView ? (
              <li key={row.item.id} data-feed-stub={row.item.id} tabIndex={-1} className="px-4 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200">
                <p className="truncate text-[12.5px] text-slate-500">{row.item.title}</p>
                <FeedMessageLine message={row.message} onUndo={isTop ? () => void act(row, "reopen") : undefined} pending={row.pending !== null} />
              </li>
            ) : (
              <li key={row.item.id} data-feed-row={row.item.id}>
                <AttentionRow
                  item={row.item}
                  now={now}
                  tz={tz}
                  draftReplyHref={draftsAvailable ? draftReplyHrefFor(row.item) : null}
                  reasonsDisclosure
                  actions={
                    isTop ? (
                      <FeedRowActions
                        key={row.item.version}
                        item={row.item}
                        pending={row.pending}
                        message={row.message}
                        askAiHref={askAiHrefFor(row.item.id, askAiEnabled)}
                        onAction={(action, until) => void act(row, action, until)}
                        onFeedback={(v, reason) => void vote(row, v, reason)}
                        feedbackAvailable={feedbackAvailable}
                        presets={presets}
                        now={now}
                        tz={tz}
                      />
                    ) : null
                  }
                />
              </li>
            )
          )}
        </ol>
      )}
      {!isTop && rows.length > 0 && (
        <p data-framed-note className="border-t border-slate-100 px-4 py-2 text-[11.5px] text-muted">
          {FEED_LIST_COPY.framed}
        </p>
      )}
      {mode === "full" && state.cursor !== null && (
        <div className="space-y-1.5 border-t border-slate-100 px-4 py-3 text-center">
          <button
            type="button"
            data-load-more
            onClick={() => void loadMore()}
            disabled={state.loadingMore}
            className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0"
          >
            {state.loadingMore ? FEED_LIST_COPY.loading : FEED_LIST_COPY.loadMore}
          </button>
          {state.loadMoreFailed && (
            <p role="alert" className="text-[12px] text-rose-700">
              {FEED_LIST_COPY.loadFailed}
            </p>
          )}
          <p className="text-[11.5px] text-muted">{FEED_LIST_COPY.orderNote}</p>
        </div>
      )}
    </div>
  );
}
