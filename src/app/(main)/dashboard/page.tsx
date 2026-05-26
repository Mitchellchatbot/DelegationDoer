import { redirect } from "next/navigation";

// /dashboard was the worker-first 2x2 widget grid. The widgets folded
// into /home (which now branches by role). This redirect keeps old
// bookmarks and the Electron widget's "Open dashboard" deep-link from
// 404'ing — they all bounce to the new surface instead.
export default function DashboardRedirect() {
  redirect("/home");
}
