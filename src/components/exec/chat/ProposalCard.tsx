"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ClipboardList, ShieldAlert } from "lucide-react";
import {
  BANNER_CHAT_OFF,
  CONFIRM_BUTTON,
  DISMISS_BUTTON,
  FRAMED_TEXT,
  OPEN_TASK_LINK,
  PROPOSAL_ASSIGNEE_GONE,
  PROPOSAL_CHANGED,
  PROPOSAL_CHECK_AGAIN,
  PROPOSAL_CONFIRMED,
  PROPOSAL_CONFIRMING,
  PROPOSAL_DISMISS_ERROR,
  PROPOSAL_DISMISSED,
  PROPOSAL_ERROR,
  PROPOSAL_EXPIRED,
  PROPOSAL_PRIVACY_NOTICE,
  PROPOSAL_REMOVED,
  PROPOSAL_UNASSIGNED,
  proposalExpiresText
} from "@/lib/exec/chat/copy";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import { MISSING, ageLabel, formatInZone } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { focusFirst, focusLost } from "@/lib/exec/ui/focus";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { postProposalAction, type ProposalActionOutcome } from "./transport";

// A task the assistant staged (P5b contract §3.19.5, C23, C42, C43,
// b-security-4). Nothing is created until he clicks Confirm, and Confirm
// creates exactly what the card shows: the FULL title and description, as
// plain text (never markdown, never clipped; the description scrolls), the
// assignee, department, client, priority and due date. Confirm posts the
// card's contentHash; if the stored proposal changed since (a redaction, say)
// the server answers 409 changed with the current one, the card re-renders
// it and says so, and nothing is created. Buttons only in a top-level window
// (P4's frame guard); framed, the card says to open DD.

const PRIORITY_LABEL: Readonly<Record<ProposalView["priority"], string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical"
};

const DEFAULT_TZ = "America/New_York";

type Phase = "idle" | "confirming" | "dismissing";

/**
 * The card's line after an answer (ui-8): "error" a failed Confirm (try again), "dismiss_error" a failed Dismiss,
 * "assignee_unavailable" a Confirm that can never succeed (the assignee left DD: Confirm is hidden), "chat_off" both
 * routes refuse until chat is on again (both buttons hidden).
 */
export type ProposalNote = "changed" | "error" | "dismiss_error" | "assignee_unavailable" | "chat_off";

/** The card's next view and its line after a Confirm or Dismiss answer (pure, for tests). */
export function proposalAfter(outcome: ProposalActionOutcome, current: ProposalView, action: "confirm" | "dismiss" = "confirm"): { proposal: ProposalView; note: ProposalNote | null } {
  if (outcome.kind === "changed") return { proposal: outcome.proposal, note: "changed" };
  if (outcome.kind === "updated") return { proposal: outcome.proposal, note: null };
  if (outcome.status === 403 && outcome.error === "chat_off") return { proposal: current, note: "chat_off" };
  if (action === "confirm" && outcome.status === 409 && outcome.error === "assignee_unavailable") return { proposal: current, note: "assignee_unavailable" };
  return { proposal: current, note: action === "dismiss" ? "dismiss_error" : "error" };
}

/** The note's sentence and whether it is an error (role alert) rather than news (role status). */
export function proposalNoteText(note: ProposalNote): { text: string; alert: boolean } {
  switch (note) {
    case "changed":
      return { text: PROPOSAL_CHANGED, alert: false };
    case "error":
      return { text: PROPOSAL_ERROR, alert: true };
    case "dismiss_error":
      return { text: PROPOSAL_DISMISS_ERROR, alert: true };
    case "assignee_unavailable":
      return { text: PROPOSAL_ASSIGNEE_GONE, alert: true };
    case "chat_off":
      return { text: BANNER_CHAT_OFF, alert: true };
  }
}

/** ui-5: after an action, where focus goes when the clicked button is gone: the task link, the status line, the note. */
export const PROPOSAL_FOCUS_SELECTORS: readonly string[] = Object.freeze(["[data-open-task]", "[data-proposal-line]", "[data-proposal-check]", "[data-proposal-note]"]);

/** The line a non-pending card shows instead of its buttons. */
export function proposalStatusText(p: Pick<ProposalView, "status" | "redacted">): string | null {
  // ui-9: a confirmed task survives a redaction (C20 keeps the status and the task id): the card says so.
  if (p.redacted && p.status === "confirmed") return PROPOSAL_CONFIRMED;
  if (p.redacted || p.status === "withdrawn") return PROPOSAL_REMOVED;
  switch (p.status) {
    case "confirming":
      return PROPOSAL_CONFIRMING;
    case "confirmed":
      return PROPOSAL_CONFIRMED;
    case "dismissed":
      return PROPOSAL_DISMISSED;
    case "expired":
      return PROPOSAL_EXPIRED;
    default:
      return null;
  }
}

function Detail({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 font-medium text-slate-800 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function ProposalCard({
  proposal: initial,
  nowIso,
  tz,
  isTop: isTopProp,
  onProposal,
  initialNote = null
}: {
  proposal: ProposalView;
  /** The page's time (ISO), for "Expires in …". */
  nowIso: string;
  /** The principal's zone, for the due date; null in the drawer (a date-only due is zone-free). */
  tz: string | null;
  /** The frame guard, when the caller already has it; else this card asks useIsTopWindow. */
  isTop?: boolean;
  /** The card's new state, so the transcript keeps it. */
  onProposal?: (p: ProposalView) => void;
  /** Static renders only (tests and screenshots): the line after a 409 changed or an error. */
  initialNote?: ProposalNote | null;
}) {
  const hookTop = useIsTopWindow();
  const isTop = isTopProp ?? hookTop;
  const [proposal, setProposal] = useState<ProposalView>(initial);
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<ProposalNote | null>(initialNote);
  const rootRef = useRef<HTMLDivElement>(null);
  const [acted, setActed] = useState(0);

  // A newer copy from the transcript (a recovery, a reload of the turn) wins.
  useEffect(() => {
    setProposal(initial);
  }, [initial]);

  // ui-5: the clicked button is replaced by the status line (or the note): focus goes there, not to the page.
  useEffect(() => {
    if (acted === 0 || typeof document === "undefined") return;
    if (focusLost(document.activeElement, document.body)) focusFirst(rootRef.current, PROPOSAL_FOCUS_SELECTORS);
  }, [acted]);

  async function act(action: "confirm" | "dismiss") {
    if (phase !== "idle") return;
    setPhase(action === "confirm" ? "confirming" : "dismissing");
    setNote(null);
    const outcome = await postProposalAction(proposal, action);
    const next = proposalAfter(outcome, proposal, action);
    setProposal(next.proposal);
    setNote(next.note);
    setPhase("idle");
    setActed((n) => n + 1);
    if (next.proposal !== proposal) onProposal?.(next.proposal);
  }

  const status = proposalStatusText(proposal);
  const removed = proposal.redacted || proposal.status === "withdrawn";
  // ui-9: a confirmed task outlives a redaction; its content is gone, the link isn't.
  const confirmedTask = proposal.status === "confirmed";
  const pending = proposal.status === "pending" && !removed;
  const confirmBlocked = note === "assignee_unavailable" || note === "chat_off";
  const dismissBlocked = note === "chat_off";
  const task = confirmedTask ? safeLink(proposal.taskHref) : null;
  const due = proposal.dueOn ? formatInZone(proposal.dueOn, tz ?? DEFAULT_TZ, "date", nowIso) : MISSING;
  const expiresIn = ageLabel(nowIso, proposal.expiresAt);
  const busy = phase !== "idle";

  return (
    <div ref={rootRef} data-proposal-card={proposal.id} data-proposal-status={removed ? "removed" : proposal.status} className="min-w-0 space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/40 px-3 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">
        <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Proposed task
      </p>
      {removed ? (
        <p data-proposal-line className="text-[12.5px] font-medium text-slate-600">
          {PROPOSAL_REMOVED}
        </p>
      ) : (
        <>
          <p data-proposal-title className="whitespace-pre-wrap text-[13.5px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">
            {proposal.title}
          </p>
          {proposal.description !== "" && (
            <div
              data-proposal-description
              tabIndex={0}
              className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[12.5px] leading-relaxed text-slate-700 [overflow-wrap:anywhere]"
            >
              {proposal.description}
            </div>
          )}
          <dl className="grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
            <Detail label="Assignee">{proposal.assigneeName ?? PROPOSAL_UNASSIGNED}</Detail>
            <Detail label="Department">{proposal.departmentName ?? MISSING}</Detail>
            <Detail label="Client">{proposal.clientName ?? MISSING}</Detail>
            <Detail label="Priority">{PRIORITY_LABEL[proposal.priority] ?? proposal.priority}</Detail>
            <Detail label="Due">{due}</Detail>
          </dl>
          {proposal.privacyNotice && (
            <p data-proposal-privacy className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-900">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{PROPOSAL_PRIVACY_NOTICE}</span>
            </p>
          )}
          {pending && <p className="text-[11.5px] text-muted">{proposalExpiresText(`in ${expiresIn}`)}</p>}
        </>
      )}
      {note !== null && (
        <p
          role={proposalNoteText(note).alert ? "alert" : "status"}
          tabIndex={-1}
          data-proposal-note={note}
          className={cn("text-[12px] font-medium", note === "changed" ? "text-amber-800" : "text-rose-700")}
        >
          {proposalNoteText(note).text}
        </p>
      )}
      {pending ? (
        isTop ? (
          (!confirmBlocked || !dismissBlocked) && (
            <div className="flex flex-wrap gap-2">
              {!confirmBlocked && (
                <button
                  type="button"
                  data-proposal-action="confirm"
                  disabled={busy}
                  onClick={() => void act("confirm")}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {phase === "confirming" ? PROPOSAL_CONFIRMING : CONFIRM_BUTTON}
                </button>
              )}
              {!dismissBlocked && (
                <button
                  type="button"
                  data-proposal-action="dismiss"
                  disabled={busy}
                  onClick={() => void act("dismiss")}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {DISMISS_BUTTON}
                </button>
              )}
            </div>
          )
        ) : (
          <p data-framed-note className="text-[12px] text-muted">
            {FRAMED_TEXT}
          </p>
        )
      ) : (
        (!removed || confirmedTask) &&
        status !== null && (
          <p
            role="status"
            tabIndex={-1}
            data-proposal-line
            className={cn("flex flex-wrap items-center gap-x-2 text-[12.5px] font-medium", proposal.status === "confirmed" ? "text-emerald-700" : "text-slate-600")}
          >
            <span>{status}</span>
            {/* ui-9: a card stuck in confirming (a confirm that timed out after its CAS) can ask again: the confirm is
                idempotent and resumes it, or answers that it's still in progress. */}
            {proposal.status === "confirming" && isTop && (
              <button
                type="button"
                data-proposal-check
                disabled={busy}
                onClick={() => void act("confirm")}
                className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {PROPOSAL_CHECK_AGAIN}
              </button>
            )}
            {task &&
              (task.external ? (
                <a href={task.href} target="_blank" rel="noopener noreferrer" data-open-task className="font-semibold text-indigo-700 hover:text-indigo-900">
                  {OPEN_TASK_LINK}
                </a>
              ) : (
                <Link href={task.href} prefetch={false} data-open-task className="font-semibold text-indigo-700 hover:text-indigo-900">
                  {OPEN_TASK_LINK}
                </Link>
              ))}
          </p>
        )
      )}
    </div>
  );
}
