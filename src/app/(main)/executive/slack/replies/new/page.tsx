import { notFound, redirect } from "next/navigation";
import { NewReplyForm } from "@/components/exec/slack/replies/NewReplyForm";
import { ReplyPageFrame, ReplyPageNotice } from "@/components/exec/slack/replies/ReplyDraftView";
import { REPLY_UI_COPY } from "@/components/exec/slack/replies/reply-logic";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import { getNewReplyView } from "@/lib/exec/slack-reply-view";

// /executive/slack/replies/new?c=<channel>&t=<ts>: start a Slack reply draft (P10 contract §3.5.13, C45, C46; Area D).
//
// The gate comes first. A malformed channel or ts is Next's not-found page. An active draft for the message goes straight to
// its page (one active draft per message); a message that can't get a draft (not stored, withheld by the screen, a
// conversation he left) says so; otherwise the form, which POSTs and navigates. No GET creates anything (RU09): this page
// only reads. The view is DB reads only (no Slack call on a render).
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const SLACK_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const COPY = SLACK_P10_COPY.replies;

export default async function ExecutiveNewSlackReplyPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/slack/replies/new");
  const c = searchParams?.c;
  const t = searchParams?.t;
  if (typeof c !== "string" || !CHANNEL_ID.test(c) || typeof t !== "string" || !SLACK_TS.test(t)) notFound();
  const nowIso = new Date().toISOString();
  const tz = principal.timezone;
  const view = await getNewReplyView(principal, { channelId: c, ts: t });
  if (view.state === "not_installed") return <ReplyPageNotice nowIso={nowIso} tz={tz} message={SLACK_P10_COPY.settings.notInstalled} />;
  if (view.state === "off") return <ReplyPageNotice nowIso={nowIso} tz={tz} message={REPLY_UI_COPY.off} />;
  if (view.existingId !== null) redirect(slackReplyPageHref(view.existingId));
  if (view.state === "not_allowed") return <ReplyPageNotice nowIso={nowIso} tz={tz} message={REPLY_UI_COPY.notAllowed} />;
  return (
    <ReplyPageFrame nowIso={nowIso} tz={tz} title={COPY.newTitle}>
      <div className="space-y-3">
        {view.destination !== null && <p data-reply-destination className="text-[13.5px] font-semibold text-ink">{view.destination}</p>}
        {view.summary !== null && (
          <p data-reply-replying-to className="text-[12.5px] text-slate-700">
            <span className="font-semibold text-slate-800">{`${COPY.replyingTo}: `}</span>
            <span className="break-words">{view.summary}</span>
          </p>
        )}
        <NewReplyForm channelId={c} ts={t} />
      </div>
    </ReplyPageFrame>
  );
}
