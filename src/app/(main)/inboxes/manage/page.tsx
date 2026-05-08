import { redirect } from "next/navigation";
import { ShieldAlert, ExternalLink, Layers } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listTeamMembers, type MissiveAccount } from "@/lib/missive-client";
import { canManageAssignments, getAllAssignments, syncMissiveOwnership, type InboxAssignment } from "@/lib/inbox-access";
import { users as mockUsers, departments as mockDepartments } from "@/lib/mock-data";
import { InboxAssignmentGraph } from "@/components/InboxAssignmentGraph";
import { BackPill } from "@/components/BackPill";

export const dynamic = "force-dynamic";

export default async function ManageInboxesPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  if (!canManageAssignments(me)) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">CEO only</div>
        <div className="text-sm text-muted mt-1">
          Only the CEO can reassign inboxes. Reach out if you need to grant or revoke access.
        </div>
      </div>
    );
  }

  let inboxes: MissiveAccount[] = [];
  let assignments: InboxAssignment[] = [];
  let fetchError: string | null = null;
  try {
    // Fetch missive accounts + team members in parallel; then mirror their
    // ownership relationships into our assignments table before reading it.
    const [fetchedInboxes, teamMembers] = await Promise.all([
      listAccounts(),
      listTeamMembers().catch(() => [])
    ]);
    inboxes = fetchedInboxes;
    if (teamMembers.length > 0) {
      await syncMissiveOwnership(fetchedInboxes, teamMembers);
    }
    // Read assignments AFTER the sync so the page reflects the merged state.
    assignments = await getAllAssignments();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <BackPill href="/inboxes" label="Inboxes" />

      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🔗</span>
            <div>
              <h1 className="text-xl font-semibold">Manage inbox assignments</h1>
              <p className="text-sm text-ink/60 mt-0.5 max-w-2xl">
                Drag from a person to an inbox to grant access. Click a string to remove it.
                Department heads inherit access to anything assigned to their team.
              </p>
            </div>
          </div>
          {missiveAppUrl && (
            <a
              href={missiveAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-white/80 text-ink/80 hover:text-accent transition-all hover:-translate-y-0.5 shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open Missive
            </a>
          )}
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm">
          <div className="font-medium text-urgent mb-1">Couldn't load inboxes from Missive</div>
          <div className="text-muted">
            {fetchError}
          </div>
          <div className="text-xs text-muted mt-2">
            Most often: <code>MISSIVE_API_TOKEN</code> expired (default JWT lifetime is 30 days). Grab a
            fresh token from the Missive UI's localStorage and update Railway's env vars.
          </div>
        </div>
      )}

      {!fetchError && inboxes.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center mx-auto mb-3">
            <Layers className="w-8 h-8" />
          </div>
          <div className="text-base font-medium">No inboxes connected in Missive yet</div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            Connect at least one IMAP mailbox over there, then come back to assign it to people.
          </div>
          {missiveAppUrl && (
            <a
              href={missiveAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              <ExternalLink className="w-4 h-4" /> Connect a mailbox in Missive
            </a>
          )}
        </div>
      ) : null}

      {!fetchError && inboxes.length > 0 && (
        <InboxAssignmentGraph
          users={mockUsers}
          inboxes={inboxes}
          departments={mockDepartments}
          initialAssignments={assignments}
        />
      )}
    </div>
  );
}
