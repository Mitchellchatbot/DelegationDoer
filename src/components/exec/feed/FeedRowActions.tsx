import { ChevronDown, Sparkles, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import type { AttentionFeedItem, FeedbackReason, OwnerAction } from "@/lib/exec/attention-types";
import { formatInZone } from "@/lib/exec/format";
import type { FeedMessage } from "@/lib/exec/ui/feed-api";
import { effectiveStatus } from "@/lib/exec/ui/feed-state";
import type { SnoozePreset } from "@/lib/exec/ui/snooze-presets";
import { cn } from "@/lib/utils";
import { ago } from "../overview/labels";

// One feed row's controls (P5a contract §3.13.2, C2, C9, C10). Presentational:
// no hooks and no fetch; FeedList owns the state and renders this only in a
// top-level window (S2), so a framed page never gets a control. The buttons
// follow the item's effective status (an expired snooze is open again):
//   open       Mark seen · Snooze · Dismiss · Resolve
//   seen       Snooze · Dismiss · Resolve · Mark new
//   snoozed    "Snoozed until <time>" · Unsnooze · Dismiss · Resolve
//   dismissed  Reopen · Resolve
//   resolved   Reopen (resolved by him) / "Resolved automatically <when>" (no buttons)
// Feedback: Useful / Not useful (with a reason). Menus are native <details>,
// opened inline (no popover a card could clip). Ask AI is P5b's: P5a always
// passes askAiHref null, and nothing renders for it. Every message is in an
// aria-live region.

export const FEEDBACK_REASON_LABELS: Readonly<Record<Exclude<FeedbackReason, "useful">, string>> = {
  not_relevant: "Not relevant",
  wrong_priority: "Wrong priority",
  already_handled: "Already handled",
  duplicate: "Duplicate",
  wrong_facts: "Facts are wrong",
  other: "Other"
};

const NOT_USEFUL_REASONS = Object.keys(FEEDBACK_REASON_LABELS) as Exclude<FeedbackReason, "useful">[];

export type RowButton = { action: OwnerAction; label: string } | { action: "snooze_menu"; label: string };

/** The action buttons an item offers in its effective status (C2), in order. Exported for tests. */
export function rowButtons(item: Pick<AttentionFeedItem, "status" | "snoozeUntil" | "resolution">, nowMs: number): RowButton[] {
  switch (effectiveStatus(item, nowMs)) {
    case "open":
      return [
        { action: "seen", label: "Mark seen" },
        { action: "snooze_menu", label: "Snooze" },
        { action: "dismiss", label: "Dismiss" },
        { action: "resolve", label: "Resolve" }
      ];
    case "seen":
      return [
        { action: "snooze_menu", label: "Snooze" },
        { action: "dismiss", label: "Dismiss" },
        { action: "resolve", label: "Resolve" },
        { action: "reopen", label: "Mark new" }
      ];
    case "snoozed":
      return [
        { action: "reopen", label: "Unsnooze" },
        { action: "dismiss", label: "Dismiss" },
        { action: "resolve", label: "Resolve" }
      ];
    case "dismissed":
      return [
        { action: "reopen", label: "Reopen" },
        { action: "resolve", label: "Resolve" }
      ];
    case "resolved":
      return item.resolution === "owner" ? [{ action: "reopen", label: "Reopen" }] : [];
    default:
      return [];
  }
}

// P9 F25: below sm every row control is a 40 px tap target (they were about 29 px); unchanged from sm up.
const BUTTON =
  "inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-[12px] font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-2.5";
const MENU_SUMMARY = cn(BUTTON, "cursor-pointer list-none [&::-webkit-details-marker]:hidden");
const MENU_ITEM =
  "inline-flex min-h-10 items-center rounded-md border border-slate-200 bg-white px-3 py-1 text-[11.5px] font-medium text-slate-700 hover:border-indigo-200 hover:text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-2";
const SAVING = "Saving…";

/** The row's aria-live line: the message, and Undo on an out-of-view stub. */
export function FeedMessageLine({ message, onUndo, pending }: { message: FeedMessage | null; onUndo?: () => void; pending?: boolean }) {
  return (
    <p aria-live="polite" role="status" className={cn("min-h-0 text-[12px]", message?.tone === "error" ? "text-rose-700" : "text-emerald-700")}>
      {message && <span>{message.text}</span>}
      {message?.undo && onUndo && (
        <button
          type="button"
          data-undo
          onClick={onUndo}
          disabled={pending}
          className="ml-2 inline-flex min-h-10 items-center gap-1 px-1 font-semibold text-indigo-700 underline-offset-2 hover:underline disabled:opacity-50 sm:min-h-0 sm:px-0"
        >
          <Undo2 className="h-3 w-3" aria-hidden />
          {pending ? SAVING : "Undo"}
        </button>
      )}
    </p>
  );
}

export function FeedRowActions({
  item,
  pending,
  message,
  askAiHref,
  onAction,
  onFeedback,
  presets,
  now,
  tz = "America/New_York",
  feedbackAvailable = true
}: {
  item: AttentionFeedItem;
  pending: OwnerAction | "feedback" | null;
  message: FeedMessage | null;
  /** P5b (coherence-16): "/executive/chat?context=attention:<id>" when Ask AI is on; null renders nothing. */
  askAiHref: string | null;
  onAction: (action: OwnerAction, snoozeUntil?: string) => void;
  onFeedback: (vote: 1 | -1, reason: FeedbackReason | null) => void;
  presets: SnoozePreset[];
  /** The page's time (ISO), for the effective status and the times shown. Defaults to the item's own update time. */
  now?: string;
  tz?: string;
  /** Review ui-5 (additive, default true): false while exec_attention_feedback doesn't exist; no feedback controls then. */
  feedbackAvailable?: boolean;
}) {
  const nowIso = now ?? item.updatedAt;
  const nowMs = Date.parse(nowIso);
  const status = effectiveStatus(item, Number.isFinite(nowMs) ? nowMs : Date.now());
  const buttons = rowButtons(item, Number.isFinite(nowMs) ? nowMs : Date.now());
  const busy = pending !== null;
  return (
    <div data-row-actions={item.id} className="space-y-1.5 pt-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {status === "snoozed" && (
          <span data-snoozed-until className="text-[11.5px] text-muted">
            {`Snoozed until ${formatInZone(item.snoozeUntil, tz, "datetime", nowIso)}`}
          </span>
        )}
        {status === "resolved" && item.resolution !== "owner" && (
          <span data-auto-resolved className="text-[11.5px] text-muted">
            {`Resolved automatically ${item.resolvedAt ? ago(item.resolvedAt, nowIso) : ""}`.trim()}
          </span>
        )}
        {buttons.map((b) =>
          b.action === "snooze_menu" ? (
            pending === "snooze" ? (
              <button key="snooze" type="button" data-action="snooze" disabled className={BUTTON}>
                {SAVING}
              </button>
            ) : (
              <details key="snooze" data-snooze-menu className="group max-w-full">
                <summary data-action="snooze" aria-disabled={busy || undefined} className={cn(MENU_SUMMARY, busy && "pointer-events-none opacity-50")}>
                  Snooze
                  <ChevronDown className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-180" aria-hidden />
                </summary>
                <div role="group" aria-label="Snooze until" className="flex flex-wrap gap-1.5 pt-1.5">
                  {presets.map((p) => (
                    <button key={p.key} type="button" data-snooze-preset={p.key} disabled={busy} onClick={() => onAction("snooze", p.until)} className={MENU_ITEM}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </details>
            )
          ) : (
            <button key={`${b.action}:${b.label}`} type="button" data-action={b.action} disabled={busy} onClick={() => onAction(b.action as OwnerAction)} className={BUTTON}>
              {pending === b.action ? SAVING : b.label}
            </button>
          )
        )}
        {askAiHref !== null && (
          <a
            href={askAiHref}
            data-exec-ask-ai={item.id}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-indigo-200 bg-white px-3 py-1 text-[12px] font-semibold text-indigo-700 hover:border-indigo-300 sm:min-h-0 sm:px-2.5"
          >
            <Sparkles className="h-3 w-3" aria-hidden />
            Ask AI
          </a>
        )}
      </div>
      {feedbackAvailable && (
      <div className="flex flex-wrap items-center gap-1.5" data-feedback-controls>
        <button type="button" data-feedback="up" disabled={busy} onClick={() => onFeedback(1, "useful")} className={cn(BUTTON, "font-medium")}>
          <ThumbsUp className="h-3 w-3" aria-hidden />
          {pending === "feedback" ? SAVING : "Useful"}
        </button>
        <details data-feedback-menu className="group max-w-full">
          <summary data-feedback="down" aria-disabled={busy || undefined} className={cn(MENU_SUMMARY, "font-medium", busy && "pointer-events-none opacity-50")}>
            <ThumbsDown className="h-3 w-3" aria-hidden />
            Not useful
            <ChevronDown className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-180" aria-hidden />
          </summary>
          <div role="group" aria-label="Why not useful" className="flex flex-wrap gap-1.5 pt-1.5">
            {NOT_USEFUL_REASONS.map((reason) => (
              <button key={reason} type="button" data-feedback-reason={reason} disabled={busy} onClick={() => onFeedback(-1, reason)} className={MENU_ITEM}>
                {FEEDBACK_REASON_LABELS[reason]}
              </button>
            ))}
          </div>
        </details>
      </div>
      )}
      <FeedMessageLine message={message} />
    </div>
  );
}
