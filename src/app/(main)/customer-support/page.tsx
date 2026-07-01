import { redirect } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeCustomerSupport } from "@/lib/auth";
import { PageHero } from "@/components/PageHero";
import { CustomerSupportInbox } from "@/components/CustomerSupportInbox";

export const dynamic = "force-dynamic";

// /customer-support — the inbound-SMS support inbox for the shared Blooio
// number. Scoped to Mujtaba + stealth admins (canSeeCustomerSupport); the
// Sidebar hides the nav item for everyone else, and this server check is the
// belt-and-braces redirect for a direct URL hit.
export default async function CustomerSupportPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!canSeeCustomerSupport(me)) redirect("/");

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Customer Support"
        headline={["Every text in ", { accent: "one inbox" }]}
        subtitle="Inbound messages to the Blooio number, AI-sorted. Reply here; genuine leads route into the outbound funnel; unclear ones wait in Needs Review."
        icon={<LifeBuoy />}
        iconTone="teal"
      />
      <CustomerSupportInbox />
    </div>
  );
}
