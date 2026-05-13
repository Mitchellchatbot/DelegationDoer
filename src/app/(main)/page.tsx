import { redirect } from "next/navigation";

// Default landing page: bounce everyone to the People tab's org chart view.
export default function RootRedirect() {
  redirect("/people/org-chart");
}
