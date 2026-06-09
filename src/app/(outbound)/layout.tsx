import { notFound, redirect } from "next/navigation";
import { Toaster } from "sonner";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { OutboundSidebar } from "@/components/OutboundSidebar";
import { OutboundShellIntro } from "@/components/OutboundShellIntro";

// (outbound) — separate route group with its own layout. The whole
// surface swaps to a purple-sidebar dashboard mode for the outbound
// cohort. Sits parallel to (main) rather than nested inside it so the
// blue sidebar/topbar chrome of the main app is absent here.
//
// Auth gate is the same one used by the in-app /outbound/facebook-ads
// route — server-side notFound() for anyone outside the cohort.

export default async function OutboundLayout({ children }: { children: React.ReactNode }) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!user) redirect("/login");
  if (!canSeeOutbound(user)) notFound();

  return (
    <div className="app-shell flex gap-3 p-3 min-h-screen">
      <OutboundSidebar user={user} />
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Intro flourish — a brief purple radial flash from the center
            when the dashboard first mounts. Pairs with the wipe
            animation in EnterOutboundDashboardButton so the transition
            feels continuous from click → arrival. */}
        <OutboundShellIntro />
        <main className="relative z-10 p-6">{children}</main>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
