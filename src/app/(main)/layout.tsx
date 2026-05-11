import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { getCurrentUserId } from "@/lib/session";
import { getSupabaseServer } from "@/lib/supabase-server";
import { getUserById } from "@/lib/server-data";
import { UserProvider } from "@/lib/user-context";
import { PresenceProvider } from "@/lib/presence-context";
import { ClockProvider } from "@/components/ClockContext";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // Three legitimate states:
  //   1) signed out -> middleware redirected to /login, never gets here.
  //   2) signed in + linked public.users row -> render normally.
  //   3) signed in but NO matching public.users row (orphaned session: e.g.
  //      the on_auth_user_created trigger never ran). If we just redirect
  //      to /login here, middleware sees the auth cookie and bounces back
  //      to /, infinite loop. Sign out server-side first to drop the cookie,
  //      THEN redirect.
  const userId = await getCurrentUserId();
  if (!userId) {
    await getSupabaseServer().auth.signOut();
    redirect("/login");
  }
  const user = await getUserById(userId);
  if (!user) {
    await getSupabaseServer().auth.signOut();
    redirect("/login");
  }

  return (
    <UserProvider user={user}>
      <PresenceProvider>
      <ClockProvider>
      {/* Floating-panels layout: sidebar, topbar, and main are each their
          own rounded card with a 12px gutter between them. The page bg
          (app-shell gradient) shows through the gaps so each panel feels
          like it's floating on the canvas. */}
      <div className="app-shell flex gap-3 p-3 min-h-screen">
        <Sidebar user={user} />
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <Topbar user={user} />
          {/* No `backdrop-filter` on this panel — it creates a containing
              block for position:fixed descendants, which breaks
              @hello-pangea/dnd's drag clone positioning (the dragged item
              "teleports" to the wrong coords). bg-white/40 alone is
              enough; the orbs inside provide the soft visual depth. */}
          {/* No bg fill on the main panel — lets the app-shell's grid
              pattern show through as the canvas. Content sits on white
              cards on top of the grid. */}
          <div className="relative flex-1">
            <main className="relative z-10 p-6">{children}</main>
          </div>
        </div>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
      </ClockProvider>
      </PresenceProvider>
    </UserProvider>
  );
}
