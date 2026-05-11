import { redirect } from "next/navigation";

// Default landing page: bounce everyone — including the CEO — to the
// org chart. Used to drop CEOs onto /ceo and everyone else onto the
// personal dashboard at /; both still exist (CEO Console at /ceo, the
// dashboard at /dashboard) but they're no longer the home tile.
export default function RootRedirect() {
  redirect("/org-chart");
}
