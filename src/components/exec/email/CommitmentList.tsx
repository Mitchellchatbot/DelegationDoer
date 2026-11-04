import Link from "next/link";
import type { CommitmentView } from "@/lib/exec/email-view";
import { formatInZone } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { DIRECTION_LABEL, SUBJECT_FALLBACK, labelOf } from "./labels";
import { Chip } from "./parts";

// Promises found in his mail: what he owes, and what he is owed. The promise
// itself and its due date are the model's reading (AI-assessed); whether it
// is overdue is a fixed rule over that date (derived). Only commitments whose
// thread passed the restricted-sender screen reach this list.

/**
 * The due line. The model reads a due DATE, never a time (17:00 his time is
 * only the overdue rule's convention), so the line shows the date and, when
 * the email put it in words, what it said: "Due Nov 6 (the email said "by
 * 10am Friday")", as the attention item says it (ui-8).
 */
export function dueLine(c: Pick<CommitmentView, "status" | "dueAt" | "dueText" | "overdue">, tz: string, now: string): string {
  if (c.status === "followed_up") return "Followed up";
  if (c.status === "expired") return "Expired";
  if (c.dueAt) return `${c.overdue ? "Was due" : "Due"} ${formatInZone(c.dueAt, tz, "date", now)}${c.dueText ? ` (the email said "${c.dueText}")` : ""}`;
  if (c.dueText) return `Due: ${c.dueText}`;
  return "No due date";
}

export function CommitmentList({
  items,
  tz,
  now,
  showThread = true,
  showEvidence = false
}: {
  items: readonly CommitmentView[];
  tz: string;
  now: string;
  /** Link each to its thread (lists across threads); the thread page leaves it out. */
  showThread?: boolean;
  /** Show the verified quote each was read from (the thread page). */
  showEvidence?: boolean;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((c) => (
        <li key={c.id} className="px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <BasisLabel basis="ai" />
            <Chip tone={c.direction === "mitchell_owes" ? "indigo" : "sky"}>{labelOf(DIRECTION_LABEL, c.direction) ?? c.direction}</Chip>
            {c.counterparty && <span className="text-[11.5px] text-muted">{c.counterparty}</span>}
          </div>
          <p className="mt-1 break-words text-[13px] text-ink">{c.text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
            <BasisLabel basis="derived" />
            <span className={cn(c.overdue ? "font-semibold text-rose-700" : "text-muted")}>{dueLine(c, tz, now)}</span>
            {c.overdue && <Chip tone="rose">Overdue</Chip>}
            {showThread && (
              <Link href={c.threadHref} prefetch={false} className="min-w-0 truncate font-medium text-indigo-700 underline-offset-2 hover:underline">
                {c.threadSubject && c.threadSubject.trim() !== "" ? c.threadSubject : c.threadSubject === null ? "Open the thread" : SUBJECT_FALLBACK}
              </Link>
            )}
          </div>
          {showEvidence && c.evidence && (
            <blockquote className="mt-1.5 break-words border-l-2 border-slate-200 pl-2 text-[12px] italic text-slate-600">{`“${c.evidence}”`}</blockquote>
          )}
        </li>
      ))}
    </ul>
  );
}
