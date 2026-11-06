import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, FileX, MessagesSquare } from "lucide-react";
import type { DraftAddress } from "@/lib/exec/drafts-types";
import { DRAFTS_BUCKET_HREF } from "@/lib/exec/drafts-links";
import { EmptyState } from "../EmptyState";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { COPY } from "./copy";

// The two draft pages' frame (P4 contract §3.13.2, C58): the assistant's
// header, a "Drafts" link back to the Email tab's Drafts view, and for a
// reply the email it answers, as the row stores it: the sender's address
// (name muted, C75) and the subject, with "View the thread" to P3's page.
// No message body is shown here; P3's thread page shows those, behind its
// own screens. Server component, text only.

export function DraftPageFrame({
  nowIso,
  tz,
  title,
  thread,
  children
}: {
  nowIso: string;
  tz: string;
  title: string;
  /** A reply's thread, as the draft row stores it. */
  thread?: { threadId: string; subject: string | null; from: DraftAddress | null } | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={nowIso} tz={tz} trailing={<ExecTabs active="email" tabs={EXEC_TABS} />} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={DRAFTS_BUCKET_HREF} prefetch={false} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {COPY.backToDrafts}
        </Link>
        {thread && (
          <Link
            href={`/executive/email/${encodeURIComponent(thread.threadId)}`}
            prefetch={false}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink"
          >
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
            {COPY.viewThread}
          </Link>
        )}
      </div>
      <section className="rounded-2xl border border-slate-200/70 bg-white px-5 py-4 shadow-soft">
        <h2 className="break-words text-[17px] font-bold leading-snug text-slate-900">{title}</h2>
        {thread && (thread.from || thread.subject) && (
          <p className="mt-1 break-words text-[12.5px] text-slate-600">
            {thread.from && (
              <>
                <span className="text-muted">Replying to </span>
                <span className="break-all font-medium text-slate-800">{thread.from.address}</span>
                {thread.from.name && thread.from.name.toLowerCase() !== thread.from.address && <span className="text-muted">{` (${thread.from.name})`}</span>}
              </>
            )}
            {thread.from && thread.subject && <span className="text-muted"> · </span>}
            {thread.subject && <span>{thread.subject}</span>}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </section>
    </div>
  );
}

/** A whole-page notice in the frame (drafts not set up, switched off, nothing to reply to, an error). */
export function DraftPageNotice({
  nowIso,
  tz,
  message,
  detail,
  threadId = null,
  retry = false
}: {
  nowIso: string;
  tz: string;
  message: string;
  detail?: string;
  threadId?: string | null;
  /** The new-draft page's `unavailable`: a reload link to try again. */
  retry?: boolean;
}) {
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={nowIso} tz={tz} trailing={<ExecTabs active="email" tabs={EXEC_TABS} />} />
      <Link href={DRAFTS_BUCKET_HREF} prefetch={false} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {COPY.backToDrafts}
      </Link>
      <section data-draft-notice className="rounded-2xl border border-slate-200/70 bg-white shadow-soft">
        <EmptyState
          icon={FileX}
          message={message}
          detail={detail}
          className="py-12"
          action={
            threadId !== null || retry ? (
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                {retry && (
                  <a href="" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300">
                    Retry
                  </a>
                )}
                {threadId !== null && (
                  <Link
                    href={`/executive/email/${encodeURIComponent(threadId)}`}
                    prefetch={false}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300"
                  >
                    {COPY.viewThread}
                  </Link>
                )}
              </span>
            ) : undefined
          }
        />
      </section>
    </div>
  );
}
