import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { RoutingReviewBoard } from "@/components/RoutingReviewBoard";

export const dynamic = "force-dynamic";

// Dept-head review surface. Auto-intake produces draft tasks (and an
// unrouted fallback queue) that need a human to sanity-check the AI
// routing before the work goes live. Workers are bounced — there's
// nothing on this page they can act on.
export default async function RoutingReviewPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/signin");
  const me = await getUserById(userId);
  if (!me) redirect("/signin");

  const canSee = me.role === "leader" || me.role === "department_head" || me.isAdmin === true;
  if (!canSee) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Department heads only</div>
        <div className="text-sm text-muted mt-1">
          This page surfaces AI-routed tasks for review. You're a worker —
          check <a href="/tasks/mine" className="text-accent underline">My Tasks</a> instead.
        </div>
      </div>
    );
  }

  const isLeader = me.role === "leader" || me.isAdmin === true;
  return (
    <RoutingReviewBoard
      initialUser={{
        id: me.id,
        name: me.name,
        role: me.role,
        isAdmin: !!me.isAdmin,
        departmentIds: me.departmentIds ?? [],
        isLeader
      }}
    />
  );
}
