import { redirect } from "next/navigation";

// Default landing page: bounce everyone — including the Leader — to the
// org chart. Used to drop CEOs onto /leader and everyone else onto the
// personal dashboard at /; both still exist (Leader Console at /leader, the
// dashboard at /dashboard) but they're no longer the home tile.
export default function RootRedirect() {
  redirect("/org-chart");
}
