import Link from "next/link";
import { ExternalLink, TriangleAlert } from "lucide-react";
import type { DraftView } from "@/lib/exec/drafts-types";
import { draftReplyHref } from "@/lib/exec/drafts-links";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { cn } from "@/lib/utils";
import { changedInOutlook, unknownPastHorizon } from "./banner";
import { COPY, SEND_UNAVAILABLE_SENTENCE } from "./copy";
import { NEEDS_CHECKED_OUTLOOK, type DraftBusy, type DraftUiAction } from "./actions";

// The buttons a draft state offers (P4 contract §3.13.4). They come only
// from `capabilities` (the server's view of what the row allows) and only in
// a top-level window (null when !isTop, L16). Props only, server-renderable.
//
// "Open in Outlook" and "Open sent copy" are <button>s whose handlers the
// panel owns (C69): no href on this page ever holds the Outlook webLink.
// "View the thread" and "Draft again" are ordinary DD links.

export type { DraftBusy, DraftUiAction } from "./actions";

export interface ActionSpec {
  action: DraftUiAction;
  label: string;
  kind: "primary" | "secondary" | "danger";
  /** Needs the "I checked my Sent Items in Outlook" box ticked. */
  needsChecked: boolean;
  /** A confirm line before the action runs (the restricted delete). */
  confirm?: string;
}

const spec = (action: DraftUiAction, label: string, kind: ActionSpec["kind"] = "secondary", extra: Partial<ActionSpec> = {}): ActionSpec => ({
  action,
  label,
  kind,
  needsChecked: NEEDS_CHECKED_OUTLOOK.has(action),
  ...extra
});

/** The row's buttons, in order, from the view's capabilities (§3.13.4). Pure; exported for tests. */
export function actionsFor(view: DraftView, ctx: { outlookVersionShown?: boolean; sendReady?: boolean | null } = {}): ActionSpec[] {
  const c = view.capabilities;
  const can = (a: string) => c.resolve.includes(a as (typeof c.resolve)[number]);
  const out: ActionSpec[] = [];
  const checkAgain = () => {
    if (can("check")) out.push(spec("check_again", "Check again"));
  };
  const changedActions = () => {
    if (can("check")) out.push(spec("show_outlook_version", "Show the Outlook version"));
    if (ctx.outlookVersionShown) {
      if (c.canSave) out.push(spec("replace_with_dd", "Replace it with this version", "primary"));
      if (can("keep_outlook_version")) out.push(spec("resolve:keep_outlook_version", "Keep the Outlook version"));
      if (c.canDiscard) out.push(spec("delete_anyway", "Delete anyway", "danger"));
    }
  };

  if (view.restricted) {
    switch (view.status) {
      case "saved":
      case "draft":
        if (c.canDeleteRestricted) out.push(spec("delete_restricted", "Delete", "danger", { confirm: COPY.deleteRestrictedConfirm }));
        break;
      case "unknown":
        checkAgain();
        if (can("mark_sent")) out.push(spec("resolve:mark_sent", "It was sent"));
        if (can("not_sent_new_draft")) out.push(spec("resolve:not_sent_new_draft", "It wasn't sent: delete it from Outlook", "danger"));
        break;
      default:
        break;
    }
    return out;
  }

  switch (view.status) {
    case "generating":
      if (can("stop_generation")) out.push(spec("stop", "Stop"));
      break;
    case "generation_failed":
      if (c.canRegenerate) out.push(spec("regenerate", "Try again", "primary"));
      if (c.canEdit || c.canRegenerate) out.push(spec("write_myself", "Write it myself"));
      if (c.canDiscard) out.push(spec("discard", "Discard", "danger"));
      break;
    case "draft":
      if (changedInOutlook(view)) {
        changedActions();
        break;
      }
      if (view.staleLink) {
        if (c.canSave) out.push(spec("save", "Save again", "primary"));
        if (c.canRegenerate) out.push(spec("regenerate", "Regenerate"));
        checkAgain();
        if (c.canDiscard) out.push(spec("discard", "Discard", "danger"));
        break;
      }
      if (c.canRegenerate) out.push(spec("regenerate", "Regenerate"));
      if (c.canSave) out.push(spec("save", "Save to Outlook", "primary"));
      if (c.canDiscard) out.push(spec("discard", "Discard", "danger"));
      break;
    case "saved":
      // Display only (the send route re-checks): hidden while the persisted verdict or the live probe says no.
      if (c.canReview && c.sendUnavailable === null && ctx.sendReady !== false) out.push(spec("review", "Review & send", "primary"));
      if (c.canOpenInOutlook) out.push(spec("open_in_outlook", "Open in Outlook"));
      checkAgain();
      if (c.canRegenerate) out.push(spec("regenerate", "Regenerate"));
      if (c.canDiscard) out.push(spec("discard", "Discard", "danger"));
      if (view.outlook.changedSinceSaved) changedActions();
      break;
    case "sent_pending":
      if (view.outlook.webLink !== null) out.push(spec("open_in_outlook", "Open sent copy"));
      checkAgain();
      break;
    case "sent":
      if (view.outlook.webLink !== null) out.push(spec("open_in_outlook", "Open sent copy"));
      break;
    case "unknown":
      checkAgain();
      if (unknownPastHorizon(view)) {
        if (can("mark_sent")) out.push(spec("resolve:mark_sent", "It was sent"));
        if (can("not_sent_new_draft")) {
          out.push(spec("resolve:not_sent_new_draft", ctx.outlookVersionShown ? "Delete it anyway and make a new draft" : "It wasn't sent: make a new draft", "danger"));
        }
      } else if (c.canOpenInOutlook) {
        out.push(spec("open_in_outlook", "Open in Outlook"));
      }
      break;
    case "gone":
      if (view.lastError?.code === "outlook_reappeared") break;
      if (view.gone.unconfirmed) checkAgain();
      if (can("copy_to_new_draft")) out.push(spec("resolve:copy_to_new_draft", "Make a new draft from this text", "primary"));
      if (can("mark_sent")) out.push(spec("resolve:mark_sent", "It was sent"));
      break;
    default:
      break;
  }
  return out;
}

/** The actions that save to Outlook (R7): the ones P5b's private-refs confirmation gates (F5, C45). */
export const SAVE_ACTIONS: ReadonlySet<DraftUiAction> = new Set<DraftUiAction>(["save", "replace_with_dd"]);

/**
 * P5b F5 (C45): whether the row shows the private-refs notice and its "I've checked it" box: a draft started in a
 * chat that also read other private material, offering a save. The box gates every save action.
 */
export function showsPrivateRefsBox(view: DraftView, actions: readonly ActionSpec[]): boolean {
  return view.usesPrivateRefs && !view.restricted && actions.some((a) => SAVE_ACTIONS.has(a.action));
}

/** Whether the row shows the "I checked my Sent Items in Outlook" box (always on both `gone` rows, buildability-3). */
export function showsCheckedBox(view: DraftView, actions: readonly ActionSpec[]): boolean {
  if (view.status === "gone" && view.lastError?.code !== "outlook_reappeared") return true;
  return actions.some((a) => a.needsChecked);
}

// P9 F25: 40 px tap targets below sm (they were about 31 px); unchanged from sm up.
const BUTTON: Readonly<Record<ActionSpec["kind"], string>> = {
  primary: "inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
  secondary: "inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
  danger: "inline-flex min-h-10 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
};

export function DraftActions({
  view,
  isTop,
  busy,
  sendReady,
  onAction,
  checkedOutlook = false,
  onCheckedOutlook,
  outlookVersionShown = false,
  openBlocked = false,
  onOpenNow,
  privateRefsChecked = false,
  onPrivateRefsChecked,
  sendReason = null
}: {
  view: DraftView;
  isTop: boolean;
  busy: DraftBusy | null;
  /** The R9 probe's answer; null until it answered. Display only: the route re-checks. */
  sendReady: boolean | null;
  onAction: (a: DraftUiAction) => void;
  /** The "I checked my Sent Items in Outlook" box (the panel owns its state). */
  checkedOutlook?: boolean;
  onCheckedOutlook?: (checked: boolean) => void;
  /** The Outlook version was fetched and is shown (the three follow-up actions appear). */
  outlookVersionShown?: boolean;
  /** The popup was blocked: offer "Open it now" (C69). */
  openBlocked?: boolean;
  onOpenNow?: () => void;
  /** P5b F5 (C45): the "I've checked it" box of a usesPrivateRefs draft (the panel owns its state; saves post confirmPrivate). */
  privateRefsChecked?: boolean;
  onPrivateRefsChecked?: (checked: boolean) => void;
  /** P9 F24: the send probe's reason when it answered sendReady false (panel-logic sendProbeAnswer). */
  sendReason?: string | null;
}) {
  if (!isTop) return null;
  const actions = actionsFor(view, { outlookVersionShown, sendReady });
  const checkbox = showsCheckedBox(view, actions);
  const privateBox = showsPrivateRefsBox(view, actions);
  const threadHref = view.kind === "reply" && view.threadId !== null ? `/executive/email/${encodeURIComponent(view.threadId)}` : null;
  const againHref = view.kind === "reply" && view.threadId !== null ? draftReplyHref(view.threadId) : null;
  const sendHint =
    !view.restricted && view.status === "saved" && (view.capabilities.sendUnavailable !== null || sendReady === false)
      ? sendHintText(view.capabilities.sendUnavailable ?? sendReason)
      : null;
  const showsOpen = actions.some((a) => a.action === "open_in_outlook") && view.status === "saved";
  const outlookOk = view.outlook.webLink !== null && isAllowedLinkUrl(view.outlook.webLink);
  const disabled = busy !== null;
  const showThreadLink = threadHref !== null && !view.restricted && (view.status === "sent" || view.status === "sent_external");
  const showAgain = againHref !== null && !view.restricted && view.status === "discarded";

  return (
    <div data-actions={view.status} className="space-y-2">
      {privateBox && (
        <div data-private-refs className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <p role="status" className="flex items-start gap-2 text-[12.5px] text-amber-900">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{COPY.privateRefsNotice}</span>
          </p>
          <label className="flex items-start gap-2 text-[12.5px] text-slate-800">
            <input
              type="checkbox"
              required
              data-private-refs-check
              checked={privateRefsChecked}
              onChange={(e) => onPrivateRefsChecked?.(e.currentTarget.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
            />
            <span>{COPY.privateRefsCheck}</span>
          </label>
        </div>
      )}
      {checkbox && (
        <label className="flex items-start gap-2 text-[12.5px] text-slate-700">
          <input
            type="checkbox"
            checked={checkedOutlook}
            onChange={(e) => onCheckedOutlook?.(e.currentTarget.checked)}
            disabled={disabled}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>{COPY.checkedOutlook}</span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => {
          const isOpen = a.action === "open_in_outlook";
          if (isOpen && !outlookOk) return null;
          const gated = (a.needsChecked && !checkedOutlook) || (privateBox && SAVE_ACTIONS.has(a.action) && !privateRefsChecked);
          return (
            <button
              key={a.action}
              type="button"
              data-action={a.action}
              disabled={disabled || gated}
              onClick={() => {
                if (a.confirm && typeof window !== "undefined" && !window.confirm(a.confirm)) return;
                onAction(a.action);
              }}
              className={cn(BUTTON[a.kind], isOpen && "inline-flex items-center gap-1")}
            >
              {isOpen && <ExternalLink className="h-3.5 w-3.5" aria-hidden />}
              {busy !== null && busyLabel(a.action, busy) ? busyLabel(a.action, busy) : a.label}
            </button>
          );
        })}
        {openBlocked && outlookOk && (
          <button type="button" data-action="open_now" onClick={() => onOpenNow?.()} className={BUTTON.secondary}>
            Open it now
          </button>
        )}
        {showThreadLink && (
          <Link href={threadHref} prefetch={false} className={BUTTON.secondary}>
            View the thread
          </Link>
        )}
        {showAgain && (
          <Link href={againHref} prefetch={false} className={BUTTON.primary}>
            Draft again
          </Link>
        )}
      </div>
      {showsOpen && outlookOk && <p className="text-[12px] text-amber-800">{COPY.outlookEditWarning}</p>}
      {openBlocked && outlookOk && <p className="text-[12px] text-slate-600">{COPY.openItNow}</p>}
      {sendHint !== null && (
        <p data-send-hint className="text-[12px] text-slate-600">
          {sendHint}
        </p>
      )}
    </div>
  );
}

/**
 * P9 F24: why Send isn't offered, in words. Only "send_off" (the switch is off) reads "isn't switched on yet"; every other
 * reason (the sending key, the mail service, the drafting key) says what it is, then where to send from instead.
 */
export function sendHintText(reason: string | null | undefined): string {
  return reason === "send_off" ? COPY.sendOffHint : `${SEND_UNAVAILABLE_SENTENCE(reason)} Open it in Outlook to send.`;
}

/** The in-flight label of the button whose action is running. */
function busyLabel(action: DraftUiAction, busy: DraftBusy): string | null {
  switch (busy) {
    case "generating":
      return action === "generate" || action === "regenerate" || action === "write_myself" ? "Drafting…" : null;
    case "saving":
      return action === "save" || action === "replace_with_dd" ? "Saving…" : null;
    case "reviewing":
      return action === "review" ? "Reviewing…" : null;
    case "discarding":
      return action === "discard" || action === "delete_restricted" || action === "delete_anyway" ? "Removing…" : null;
    case "checking":
      return action === "check_again" || action === "show_outlook_version" ? "Checking…" : null;
    case "sending":
      return action === "review" ? "Sending…" : null;
    case "resolving":
      return action.startsWith("resolve:") ? "Working…" : null;
    default:
      return null;
  }
}
