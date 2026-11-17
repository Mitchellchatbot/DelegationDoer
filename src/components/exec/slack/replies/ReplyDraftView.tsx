import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { EXEC_TABS, ExecTabs } from "../../ExecTabs";
import { ExecHeader } from "../../ExecHeader";
import { ReplyDraftEditor } from "./ReplyDraftEditor";
import type { ReplyPageDraft } from "./reply-logic";

// The reply page (P10 contract §3.5.13, C42, C48; v1.1 product-5, -12; Area D). Server component: where the reply goes (the
// stored destination in words), the outside-people banner, the finance note, what it replies to (the AI summary, or "a message
// from {person}" when the item wasn't assessed) with "Open the message in Slack" for an allow-listed permalink, the style the
// draft used, then the client editor. Every string is React text.

const COPY = SLACK_P10_COPY.replies;
const SLACK_TAB_HREF = "/executive/slack";

/** The frame every reply page shares: the header, the Slack tab, the way back. */
export function ReplyPageFrame({ nowIso, tz, title, children }: { nowIso: string; tz: string; title: string; children: ReactNode }) {
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={nowIso} tz={tz} trailing={<ExecTabs active="slack" tabs={EXEC_TABS} />} />
      <Link href={SLACK_TAB_HREF} prefetch={false} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Slack
      </Link>
      <section className="rounded-2xl border border-slate-200/70 bg-white px-4 py-4 shadow-soft sm:px-5">
        <h2 className="break-words text-[17px] font-bold leading-snug text-slate-900">{title}</h2>
        <div className="mt-3">{children}</div>
      </section>
    </div>
  );
}

/** A whole-page line in the frame (not installed, off, gone). */
export function ReplyPageNotice({ nowIso, tz, message }: { nowIso: string; tz: string; message: string }) {
  return (
    <ReplyPageFrame nowIso={nowIso} tz={tz} title={COPY.pageTitle}>
      <p data-reply-notice className="text-[13px] text-slate-700">{message}</p>
    </ReplyPageFrame>
  );
}

export function ReplyDraftView({ draft, tz, nowIso, source }: { draft: ReplyPageDraft; tz: string; nowIso: string; source: { channelId: string; ts: string } | null }) {
  const permalink = draft.sourcePermalink !== null && isAllowedLinkUrl(draft.sourcePermalink) ? draft.sourcePermalink : null;
  const replyingTo = draft.summary !== null ? draft.summary : draft.authorLabel !== null ? fillP10(COPY.replyingToFrom, { person: draft.authorLabel }) : null;
  return (
    <ReplyPageFrame nowIso={nowIso} tz={tz} title={COPY.pageTitle}>
      <div className="space-y-3">
        <p data-reply-destination className="text-[13.5px] font-semibold text-ink">{draft.destination}</p>
        {draft.external && (
          <p data-reply-external className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{COPY.external}</span>
          </p>
        )}
        {draft.finance && (
          <p data-reply-finance className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-[12.5px] text-slate-700">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{COPY.finance}</span>
          </p>
        )}
        {(replyingTo !== null || permalink !== null) && (
          <p data-reply-replying-to className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px] text-slate-700">
            <span className="font-semibold text-slate-800">{`${COPY.replyingTo}:`}</span>
            {replyingTo !== null && <span className="min-w-0 break-words">{replyingTo}</span>}
            {permalink !== null && (
              <a href={permalink} target="_blank" rel="noopener noreferrer" data-reply-open-message className="font-semibold text-indigo-700 hover:text-indigo-900">
                {COPY.openMessage}
              </a>
            )}
          </p>
        )}
        {draft.voiceSource !== null && <p data-reply-style className="text-[12px] text-slate-600">{COPY.style[draft.voiceSource]}</p>}
        {draft.injection && (
          <p data-reply-injection className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{COPY.injection}</span>
          </p>
        )}
        {draft.flags.length > 0 && (
          <p data-reply-flags className="text-[12.5px] text-amber-900">
            {fillP10(COPY.flags, { list: draft.flags.map((f) => COPY.flagNames[f]).join(", ") })}
          </p>
        )}
        <ReplyDraftEditor initial={draft} tz={tz} nowIso={nowIso} source={source} />
      </div>
    </ReplyPageFrame>
  );
}
