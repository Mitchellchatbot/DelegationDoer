import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { draftPageHref } from "@/lib/exec/drafts-links";
import type { EmailRowView } from "@/lib/exec/email-view";
import { pluralize } from "@/lib/exec/format";
import { BasisLabel } from "../BasisLabel";
import { draftChipLabel } from "../drafts/copy";
import { AssessButton } from "./AssessButton";
import {
  ATTEMPT_ERROR_LABEL,
  CATEGORY_LABEL,
  CLIENT_SIGNAL_LABEL,
  CONFIDENCE_LABEL,
  EARLIER_ASSESSMENT,
  FILTER_REASON_LABEL,
  MATCH_VIA_LABEL,
  SUBJECT_FALLBACK,
  TRIAGE_ERROR_LABEL,
  URGENCY_LABEL,
  answeredChipLabel,
  labelOf,
  personLabel
} from "./labels";
import { Ago, Chip, type ChipTone } from "./parts";

// One thread in an Email tab bucket. Every value sits on a line that says
// where it comes from: what he and the sender wrote (record), what a fixed
// rule worked out (derived: answered state, client match), and what the
// model read into it (AI-assessed: category, urgency, the summary, the
// decision it asks for). Text only; the subject links to the thread page.
//
// A thread whose newest mail wasn't assessed (set aside, failed, deferred)
// keeps the AI fields of its last assessment, and those still place it in
// the AI buckets; the row shows them, labeled as that earlier assessment, so
// it says why it is there.

const ANSWERED_TONE: Readonly<Record<string, ChipTone>> = {
  awaiting_reply: "indigo",
  answered: "emerald",
  no_inbound: "slate",
  handled_in_outlook: "slate",
  reply_scheduled: "sky",
  draft_pending: "sky",
  reply_sent_pending: "emerald"
};

/** Why a filtered, failed or deferred thread wasn't assessed, as words. */
/**
 * P9 F36: the client chip's words. Below high confidence the confidence is part of the visible text ("Client: Acme (low
 * confidence)"); it was only in the chip's title, which neither a touch screen nor a screen reader reliably shows.
 */
export function clientChipText(client: Pick<NonNullable<EmailRowView["client"]>, "name" | "confidence">): string {
  const shown = client.confidence !== null && client.confidence !== "high" ? labelOf(CONFIDENCE_LABEL, client.confidence) : null;
  return shown ? `Client: ${client.name} (${shown})` : `Client: ${client.name}`;
}

export function notAssessedReason(row: Pick<EmailRowView, "state" | "filterReason" | "triageError" | "lastAttemptError">): string {
  if (row.state === "filtered") return labelOf(FILTER_REASON_LABEL, row.filterReason) ?? "Set aside before assessment";
  if (row.state === "deferred_budget") return labelOf(ATTEMPT_ERROR_LABEL, "budget") ?? "Deferred";
  if (row.state === "triage_failed") return labelOf(TRIAGE_ERROR_LABEL, row.triageError) ?? "Not assessed";
  return labelOf(ATTEMPT_ERROR_LABEL, row.lastAttemptError) ?? "Not assessed";
}

export function EmailRowItem({ row, tz, now }: { row: EmailRowView; tz: string; now: string }) {
  const subject = row.subject && row.subject.trim() !== "" ? row.subject : SUBJECT_FALLBACK;
  const who = personLabel(row.counterpartName, row.counterpartEmail);
  const showAddress = row.counterpartName && row.counterpartEmail;
  const answered = answeredChipLabel(row);
  // P4 (L15): the thread's active assistant draft, as a chip that opens it.
  const draftChip = row.execDraft ? draftChipLabel(row.execDraft.status) : null;
  const assessed = row.state === "triaged";
  const aiChips: { text: string; tone: ChipTone }[] = [];
  const category = labelOf(CATEGORY_LABEL, row.category);
  if (category) aiChips.push({ text: category, tone: "slate" });
  if (row.urgency === "critical" || row.urgency === "high") aiChips.push({ text: labelOf(URGENCY_LABEL, row.urgency) ?? "", tone: "rose" });
  if (row.importance === "high") aiChips.push({ text: "High importance", tone: "amber" });
  if (row.clientSignal && row.clientSignal !== "none") aiChips.push({ text: labelOf(CLIENT_SIGNAL_LABEL, row.clientSignal) ?? "", tone: "violet" });
  if (row.needsReply === true) aiChips.push({ text: "Needs a reply", tone: "indigo" });
  const hasAi = aiChips.length > 0 || Boolean(row.summary) || Boolean(row.decisionQuestion);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={row.href} prefetch={false} className="min-w-0 break-words text-[13.5px] font-semibold text-ink hover:text-indigo-700">
          {subject}
        </Link>
        <Ago iso={row.lastActivityAt} now={now} tz={tz} className="shrink-0 pt-0.5 text-[11.5px] tabular-nums text-muted" />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-600">
        <BasisLabel basis="record" />
        <span className="min-w-0 break-all">
          {who}
          {showAddress ? <span className="text-muted">{` <${row.counterpartEmail}>`}</span> : null}
        </span>
        <span className="text-muted">{pluralize(row.messageCount, "message")}</span>
        {row.flagged && <Chip tone="amber">Flagged in Outlook</Chip>}
      </div>

      {(answered || draftChip || row.client || row.partialThread) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <BasisLabel basis="derived" />
          {answered && <Chip tone={row.answered === "awaiting_reply" && row.needsReply !== true ? "slate" : (ANSWERED_TONE[row.answered ?? ""] ?? "slate")}>{answered}</Chip>}
          {draftChip && row.execDraft && (
            <Link href={draftPageHref(row.execDraft.id)} prefetch={false} data-draft-chip={row.execDraft.status} className="inline-flex max-w-full">
              <Chip tone={row.execDraft.status === "unknown" ? "rose" : "violet"}>{draftChip}</Chip>
            </Link>
          )}
          {row.client && (
            <Chip
              tone="amber"
              title={[labelOf(MATCH_VIA_LABEL, row.client.via), labelOf(CONFIDENCE_LABEL, row.client.confidence)].filter(Boolean).join(", ")}
            >
              {clientChipText(row.client)}
            </Chip>
          )}
          {row.partialThread && <Chip>Part of the conversation isn&apos;t synced</Chip>}
        </div>
      )}

      {hasAi && (
        <div className="mt-1.5 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <BasisLabel basis="ai" />
            {!assessed && <span className="text-[11.5px] font-medium text-slate-600">{EARLIER_ASSESSMENT}</span>}
            {aiChips.map((c) => (
              <Chip key={c.text} tone={c.tone}>
                {c.text}
              </Chip>
            ))}
          </div>
          {row.summary && <p className="break-words text-[12.5px] leading-snug text-slate-700">{row.summary}</p>}
          {row.decisionQuestion && (
            <p className="break-words text-[12.5px] leading-snug text-slate-700">
              <span className="font-semibold text-ink">Decision asked: </span>
              {row.decisionQuestion}
            </p>
          )}
        </div>
      )}

      {row.assessable && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-600">
          <BasisLabel basis="derived" />
          <span>{notAssessedReason(row)}</span>
          <AssessButton threadId={row.threadId} />
        </div>
      )}

      {row.injectionSuspected && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-rose-700">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>This email seems to contain instructions aimed at the assistant. Its assessment may be off; read it yourself.</span>
        </p>
      )}
    </li>
  );
}
