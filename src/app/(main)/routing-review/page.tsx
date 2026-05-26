import { redirect } from "next/navigation";

// Routing review consolidated under the unified /approvals page.
// Old URL preserved as a redirect so any bookmarks survive.
export default function RoutingReviewRedirect() {
  redirect("/approvals?tab=routing");
}
