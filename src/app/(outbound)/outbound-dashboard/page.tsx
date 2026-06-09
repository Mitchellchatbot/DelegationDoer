import { redirect } from "next/navigation";

// Bare /outbound-dashboard lands on Facebook Ads (the only fully-built
// channel right now). Calendly / LinkedIn Leads / Team are accessible
// from the sidebar.
export default function OutboundDashboardLanding() {
  redirect("/outbound-dashboard/facebook-ads");
}
