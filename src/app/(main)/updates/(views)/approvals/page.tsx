import { redirect } from "next/navigation";

// Meeting approvals consolidated under the unified /approvals page.
// Old URL preserved as a redirect so any bookmarks survive.
export default function MeetingApprovalsRedirect() {
  redirect("/approvals?tab=meetings");
}
