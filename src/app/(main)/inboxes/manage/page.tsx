import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ShieldAlert, ExternalLink, Layers } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listTeamMembers, type MissiveAccount } from "@/lib/missive-client";
import { canManageAssignments, getAllAssignments, syncMissiveOwnership, type InboxAssignment } from "@/lib/inbox-access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { users as mockUsers } from "@/lib/mock-data";
import { InboxAssignmentCards } from "@/components/InboxAssignmentCards";
import { AutoIntakeToggleSection } from "@/components/AutoIntakeToggleSection";
import { ConnectInboxDialog } from "@/components/ConnectInboxDialog";
import { Plug } from "lucide-react";

interface AutoIntakeRow {
  account_id: string;
  auto_intake_enabled: boolean;
  last_polled_at: string | null;
}

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
  let autoIntakeSettings: AutoIntakeRow[] = [];
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

    // Auto-intake settings — degrade silently if migration hasn't shipped.
    const { data: settings } = await getSupabaseAdmin()
      .from("missive_account_settings")
      .select("account_id, auto_intake_enabled, last_polled_at");
    autoIntakeSettings = (settings ?? []) as AutoIntakeRow[];
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  return (
    <div className="space-y-5">
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
          <div className="shrink-0 flex items-center gap-2 flex-wrap">
            <ConnectInboxDialog
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
                  style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                >
                  <Plug className="w-3.5 h-3.5" /> Connect inbox
                </button>
              }
            />
            {missiveAppUrl && (
              <a
                href={missiveAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-white/80 text-ink/80 hover:text-accent transition-all hover:-translate-y-0.5 shadow-sm"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open Missive
              </a>
            )}
          </div>
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
          <div className="text-base font-medium">No inboxes connected yet</div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            Hit "Connect inbox" above to link a mailbox over IMAP/SMTP.
          </div>
        </div>
      ) : null}

      {!fetchError && inboxes.length > 0 && (
        <>
          {/* Suspense boundary required because InboxAssignmentCards calls
              useSearchParams() (for the ?connectedAccount=... deep-link
              after OAuth). Next 14 hydration breaks without this. */}
          <Suspense fallback={<div className="card p-6 text-sm text-muted">Loading inboxes…</div>}>
            <InboxAssignmentCards
              users={mockUsers}
              inboxes={inboxes.map((a) => ({
                id: a.id,
                email: a.email,
                display_name: a.display_name
              }))}
              initialAssignments={assignments}
            />
          </Suspense>
          <AutoIntakeToggleSection
            inboxes={inboxes}
            initialSettings={autoIntakeSettings}
          />
        </>
      )}
    </div>
  );
}
