import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { getCurrentUserId } from "@/lib/session";
import { getSupabaseServer } from "@/lib/supabase-server";
import { getUserById } from "@/lib/server-data";
import { UserProvider } from "@/lib/user-context";

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
      <div className="app-shell flex">
        <Sidebar user={user} />
        <div className="flex-1 min-w-0">
          <Topbar user={user} />
          <main className="p-6">{children}</main>
        </div>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </UserProvider>
  );
}
