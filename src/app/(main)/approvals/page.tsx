import { redirect } from "next/navigation";

// /approvals has been merged into /emails — the unified Outbound emails
// page surfaces the approval queue (Pending / Needs revision) inline on
// actionable rows. This redirect keeps existing deep-links (Slack DMs,
// bookmarks, in-app links) working and pins the landing filter to
// pending so the approver still lands in the action queue.
export default function ApprovalsRedirect() {
  redirect("/emails?status=pending");
}
