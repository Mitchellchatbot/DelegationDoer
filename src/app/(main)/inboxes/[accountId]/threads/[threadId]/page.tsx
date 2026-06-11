import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The thread now opens in the inbox reading pane (see ThreadReadingPane), not as
// its own page. Keep this route so existing deep links / "open in new tab" /
// bookmarks still work: redirect into the split view with the pane open.
export default function ThreadDetailRedirect({
  params
}: {
  params: { accountId: string; threadId: string };
}) {
  redirect(
    `/inboxes/${encodeURIComponent(params.accountId)}?thread=${encodeURIComponent(
      params.threadId
    )}&acct=${encodeURIComponent(params.accountId)}`
  );
}
