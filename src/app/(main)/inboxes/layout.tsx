import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, type MissiveAccount } from "@/lib/missive-client";
import {
  visibleAccountIdsFor, canManageAssignments
} from "@/lib/inbox-access";
import { InboxTree, type InboxNode } from "@/components/InboxTree";
import { InboxFocusProvider } from "@/components/InboxFocusProvider";

export const dynamic = "force-dynamic";

// Shared shell for every page under /inboxes — left rail with the inbox
// tree, content on the right. Pages opt out by short-circuiting their
// own width constraints.
export default async function InboxesLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  let accounts: MissiveAccount[] = [];
  try {
    const [fetched, visibleIds] = await Promise.all([
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);
    accounts =
      visibleIds === null
        ? fetched
        : fetched.filter((a) => visibleIds.has(a.id));
  } catch {
    // Missive unreachable — let the children render their own error
    // message. The tree shows an empty Inboxes section.
  }

  const nodes: InboxNode[] = accounts.map((a) => ({
    id: a.id,
    label: a.display_name || a.email,
    email: a.email
  }));

  return (
    // Full-width email shell: the inbox tree (left rail) + content fill all
    // the available space rather than being capped to a centered column. The
    // focus provider wraps both so the reply composer's Focus Mode can collapse
    // the rail AND the thread list together (see InboxTree + InboxSplit).
    <InboxFocusProvider>
      <div className="flex gap-5 w-full">
        <InboxTree accounts={nodes} canManage={canManageAssignments(me)} />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </InboxFocusProvider>
  );
}
