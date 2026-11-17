import Link from "next/link";
import { FilePen, MessagesSquare } from "lucide-react";
import { formatCount, formatInZone } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { CatchUpRow, SlackPageView } from "@/lib/exec/slack-page";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { REPLY_OFFER_KINDS } from "@/lib/exec/slack-p10-types";
import { slackNewReplyHref, slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import { replyStatusLabel } from "./replies/reply-logic";
import { BasisLabel } from "../BasisLabel";
import { SectionCard } from "../SectionCard";
import { OpenInSlack, fill, kindLabel } from "./parts";
import { SlackPrivacyChip } from "./SlackPrivacyChip";

// Catch-up on /executive/slack (P7b contract §3.12.1, C7, UI02, UI03, UI15): the open items to him that need a response,
// newest first, ≤ 50. Each row: the privacy chip, the kind, the conversation's label, the time, then the AI summary
// (labelled AI-assessed) or "Not assessed", then P7a's stored quote when there is one (never for an external author; this
// list is the only place a quote is shown), then "Open in Slack" for an allowed permalink. No author anywhere (C29).
// The muted/unwatched line counts what the policy kept back. A failed read is this card's "Couldn't load" only. Server.
//
// P10 (§3.5.13, C45, v1.1 product-16; Area D): while reply drafts are on (repliesOn), a row whose message has a draft shows
// that draft's status label (replies.statusLabels; "Replied {time}" once sent) linking to its page; otherwise a request,
// question or decision offers "Draft reply" (the new-reply page; nothing is created until he presses its button).

type CatchUp = SlackPageView["catchUp"];
/** P10 (v1.1 product-16): the row's reply link: its draft's status label and page, else "Draft reply" for the kinds C45 offers. */
export function catchUpReplyLink(r: Pick<CatchUpRow, "kind" | "channelId" | "ts" | "reply">, repliesOn: boolean, tz: string, now: string):
  { href: string; label: string; kind: "status" | "new" } | null {
  if (!repliesOn) return null;
  if (r.reply !== null) {
    const label = replyStatusLabel(r.reply.status, r.reply.sentAt, tz, now);
    if (label !== null) return { href: slackReplyPageHref(r.reply.id), label, kind: "status" };
  }
  if (!(REPLY_OFFER_KINDS as readonly string[]).includes(r.kind)) return null;
  return { href: slackNewReplyHref(r.channelId, r.ts), label: SLACK_P10_COPY.replies.draftReply, kind: "new" };
}

/** P9 F30: "Showing the newest 50 of 73". */
export function catchUpShownText(shown: number, total: number): string {
  return `Showing the newest ${formatCount(shown)} of ${formatCount(total)}`;
}

export function CatchUpList({ section, tz, now, repliesOn = false }: { section: CatchUp; tz: string; now: string; repliesOn?: boolean }) {
  if (!section.ok) return <SectionCard title={SLACK_INTEL_COPY.catchUpTitle} icon={MessagesSquare} error />;
  const { rows, hiddenMuted, total } = section.data;
  return (
    <SectionCard title={SLACK_INTEL_COPY.catchUpTitle} icon={MessagesSquare} padded={false}>
      <div data-catchup>
        {rows.length === 0 ? (
          <p data-catchup-empty className="px-4 py-6 text-center text-[13px] font-medium text-slate-600">
            {SLACK_INTEL_COPY.catchUpEmpty}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.itemId} data-catchup-row={r.itemId} data-assessed={r.assessed ? "true" : "false"} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
                  <SlackPrivacyChip privacy={r.privacy} />
                  <span data-catchup-kind className="font-semibold text-slate-700">
                    {kindLabel(r.kind)}
                  </span>
                  <span className="min-w-0 break-all">{r.channelLabel}</span>
                  <span className="tabular-nums">
                    <time dateTime={r.at}>{formatInZone(r.at, tz, "datetime", now)}</time>
                    {` · ${r.ageLabel}`}
                  </span>
                </div>
                {r.assessed && r.summary !== null ? (
                  <p className="flex flex-wrap items-start gap-2 text-[13px] leading-relaxed text-ink">
                    <span data-catchup-summary className="min-w-0 flex-1 basis-48 break-words">
                      {r.summary}
                    </span>
                    <BasisLabel basis="ai" />
                  </p>
                ) : (
                  <p data-catchup-not-assessed className="text-[12.5px] text-amber-800">
                    {SLACK_INTEL_COPY.notAssessed}
                  </p>
                )}
                {r.quote !== null && (
                  <blockquote data-catchup-quote className="break-words border-l-2 border-slate-200 pl-2.5 text-[12.5px] italic leading-relaxed text-slate-600">
                    {r.quote}
                  </blockquote>
                )}
                <OpenInSlack permalink={r.permalink} />
                <ReplyLink link={catchUpReplyLink(r, repliesOn, tz, now)} />
              </li>
            ))}
          </ul>
        )}
        {/* P9 F30: the list stops at the newest 50; say how many there are in all. */}
        {total > rows.length && rows.length > 0 && (
          <p data-catchup-shown className="border-t border-slate-100 px-4 py-2 text-[12px] text-slate-600">
            {catchUpShownText(rows.length, total)}
          </p>
        )}
        {hiddenMuted > 0 && (
          <p data-catchup-hidden-muted className="border-t border-slate-100 px-4 py-2 text-[12px] text-slate-600">
            {fill(SLACK_INTEL_COPY.catchUpHiddenMuted, { n: hiddenMuted })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function ReplyLink({ link }: { link: ReturnType<typeof catchUpReplyLink> }) {
  if (link === null) return null;
  return (
    <Link
      href={link.href}
      prefetch={false}
      data-catchup-reply={link.kind}
      className="inline-flex min-h-10 items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-0.5 text-[11.5px] font-semibold text-indigo-700 hover:border-indigo-300 hover:text-indigo-900 sm:min-h-0"
    >
      <FilePen className="h-3 w-3" aria-hidden />
      {link.label}
    </Link>
  );
}
