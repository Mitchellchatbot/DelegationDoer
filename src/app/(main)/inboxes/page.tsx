import { redirect } from "next/navigation";

// Inbox surface defaults to the combined view. The tree on the left
// gives one-click access to individual accounts.
export default function InboxesIndex() {
  redirect("/inboxes/all");
}
