import { notFound } from "next/navigation";
import { ReplyDraftView, ReplyPageNotice } from "@/components/exec/slack/replies/ReplyDraftView";
import { REPLY_UI_COPY } from "@/components/exec/slack/replies/reply-logic";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { getReplyDraftPageView, replyDraftSource } from "@/lib/exec/slack-reply-view";

// /executive/slack/replies/[id]: one Slack reply draft (P10 contract §3.5.13, C42, C48, C59; Area D).
//
// The gate comes first, before any read or any output (requireExecPrincipalForPage: his password and his code; anything else
// gets Next's not-found page and nothing is read). A malformed id, a draft that doesn't exist and one that isn't his are all
// the same not-found page. Before the P10 schema exists the page says so and reads no reply table; with replies switched
// off it says that. The view is DB reads only: no Slack call on a render (the send dialog's review is the one live read).
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const DRAFT_ID = /^esr_[0-9a-f]{32}$/;

export default async function ExecutiveSlackReplyPage({ params }: { params: { id: string } }) {
  const principal = await requireExecPrincipalForPage("GET /executive/slack/replies/:id");
  if (typeof params?.id !== "string" || !DRAFT_ID.test(params.id)) notFound();
  const now = new Date();
  const nowIso = now.toISOString();
  const tz = principal.timezone;
  const view = await getReplyDraftPageView(principal, params.id, now);
  if (view.state === "not_installed") return <ReplyPageNotice nowIso={nowIso} tz={tz} message={SLACK_P10_COPY.settings.notInstalled} />;
  if (view.state === "off") return <ReplyPageNotice nowIso={nowIso} tz={tz} message={REPLY_UI_COPY.off} />;
  if (view.state !== "ok" || view.draft === null) notFound();
  // "Start a new draft with this text" needs the same message in the create body (RPC 13 re-checks it in SQL).
  const source = view.draft.status === "failed" && view.draft.ownerResolution === "not_posted" ? await replyDraftSource(principal, params.id) : null;
  return <ReplyDraftView draft={view.draft} tz={tz} nowIso={nowIso} source={source} />;
}
