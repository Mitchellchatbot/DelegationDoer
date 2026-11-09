import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { getCurrentUserId } from "@/lib/session";
import { getSupabaseServer } from "@/lib/supabase-server";
import { getUserById } from "@/lib/server-data";
import { UserProvider } from "@/lib/user-context";
import { PresenceProvider } from "@/lib/presence-context";
import { TeamProvider } from "@/lib/team-context";
import { ClockProvider } from "@/components/ClockContext";
import { OnboardingDialog } from "@/components/OnboardingDialog";
import { SodGate } from "@/components/SodGate";
import { AIAssistantFab } from "@/components/AIAssistantFab";
import { TooltipRoot } from "@/components/Tooltip";
import { NavDrawerProvider } from "@/components/NavDrawerProvider";
import { ToastSuccessIcon, ToastErrorIcon, ToastWarningIcon } from "@/components/ToastIcons";
import { MultitaskBubbles } from "@/components/multitask/MultitaskBubbles";
import { primaryDepartment } from "@/lib/departments";
import { execAskAiRoutingStateFor, execNavItemFor } from "@/lib/exec/access";
import { AskAiRoutingProvider } from "@/components/AskAiRouting";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // Three legitimate states:
  //   1) signed out -> middleware redirected to /login, never gets here.
  //   2) signed in + linked public.users row -> render normally.
  //   3) signed in but NO matching public.users row (orphaned session: e.g.
  //      the on_auth_user_created trigger never ran). If we just redirect
  //      to /login here, middleware sees the auth cookie and bounces back
  //      to /, infinite loop. Sign out server-side first to drop the cookie,
  //      THEN redirect.
  //
  // scope: "local" is load-bearing. signOut() defaults to scope: "global",
  // which revokes the user's refresh tokens on EVERY device. All this needs is
  // to drop the cookie on THIS one so middleware stops bouncing — and case (3)
  // is a server-side data problem, not evidence the session is compromised.
  // With the default, one unreadable users row logs somebody out of their phone
  // and desktop app too, and a transient read failure does it to the whole team
  // at once.
  const userId = await getCurrentUserId();
  if (!userId) {
    await getSupabaseServer().auth.signOut({ scope: "local" });
    redirect("/login");
  }
  const user = await getUserById(userId);
  if (!user) {
    await getSupabaseServer().auth.signOut({ scope: "local" });
    redirect("/login");
  }
  // The Executive AI row, or null: EXEC_ENABLED, the owner, and a session the
  // page gate would admit. It only decides whether the row is drawn (it never
  // throws); the page's own gate is what keeps everyone else out. Its label
  // and link exist only in this value, so no other browser receives them.
  // askAiRouted (same checks, plus the owner's own Settings switch) says
  // whether the Ask AI drawer answers through the assistant on this load;
  // it is one boolean, and false for everyone else and on any error. With
  // it, whether his mailbox can be read (one more boolean, false likewise),
  // so the routed drawer doesn't claim a mailbox that is off.
  const [ownerNavItem, askAiRouting] = await Promise.all([execNavItemFor(user), execAskAiRoutingStateFor(user)]);

  return (
    <UserProvider user={user}>
      <AskAiRoutingProvider routed={askAiRouting.routed} emailOn={askAiRouting.emailOn}>
      <PresenceProvider>
      <TeamProvider>
      <ClockProvider>
      <TooltipRoot>
      {/* Floating-panels layout: sidebar, topbar, and main are each their
          own rounded card with a 12px gutter between them. The page bg
          (app-shell gradient) shows through the gaps so each panel feels
          like it's floating on the canvas. */}
      {/* NavDrawerProvider shares open/close state between the Topbar
          hamburger and the Sidebar (which is an off-canvas drawer on mobile,
          a static rail on md+). It also renders the scrim + owns scroll-lock. */}
      <NavDrawerProvider>
      <div className="app-shell flex gap-3 p-3 min-h-screen">
        <Sidebar user={user} ownerItem={ownerNavItem} />
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {user.role !== "leader" && (() => {
            const dept = primaryDepartment(user.departmentIds);
            return dept ? (
              <div aria-hidden className={`h-[2px] rounded-full ${dept.hairline}`} />
            ) : null;
          })()}
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
            <main className="relative z-10 px-3 py-4 md:p-6">{children}</main>
          </div>
        </div>
      </div>
      </NavDrawerProvider>
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        // Lift the toast stack above the bottom-right "Ask AI" launcher so
        // they don't sit on top of it.
        offset={{ bottom: 92, right: 24 }}
        icons={{
          success: <ToastSuccessIcon />,
          error: <ToastErrorIcon />,
          warning: <ToastWarningIcon />
        }}
      />
      <AIAssistantFab />
      {/* Floats above the shell; hidden until toggled with Option+M or the
          "Multitask" button in the sidebar. (Cmd/Ctrl+Shift+M is unusable —
          Chrome on macOS reserves it for the profile switcher.) */}
      <MultitaskBubbles user={user} />
      <OnboardingDialog />
      <SodGate />
      </TooltipRoot>
      </ClockProvider>
      </TeamProvider>
      </PresenceProvider>
      </AskAiRoutingProvider>
    </UserProvider>
  );
}
