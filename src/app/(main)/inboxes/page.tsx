import Link from "next/link";
import { redirect } from "next/navigation";
import { Mail, Settings as SettingsIcon, Inbox, Layers } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, type MissiveAccount } from "@/lib/missive-client";
import { visibleAccountIdsFor, canManageAssignments } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// Cycle a small palette across the inbox cards. Restricted to the
// blue→indigo→violet→purple family so the surface stays tonally unified.
const PALETTE = [
  { ring: "ring-blue-400/30",   bg: "from-blue-100 to-blue-50",     iconBg: "bg-blue-500 text-white" },
  { ring: "ring-indigo-400/30", bg: "from-indigo-100 to-indigo-50", iconBg: "bg-indigo-500 text-white" },
  { ring: "ring-violet-400/30", bg: "from-violet-100 to-violet-50", iconBg: "bg-violet-500 text-white" },
  { ring: "ring-purple-400/30", bg: "from-purple-100 to-purple-50", iconBg: "bg-purple-500 text-white" }
];

export default async function InboxesPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  let inboxes: MissiveAccount[] = [];
  let fetchError: string | null = null;
  try {
    const [accounts, visibleIds] = await Promise.all([
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);
    inboxes = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <header
        className="relative overflow-hidden rounded-2xl border border-border shadow-soft p-6"
        style={{
          background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 35%, #DDD6FE 70%, #E9D5FF 100%)"
        }}
      >
        <div className="relative flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">📬</span>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink/60">Inboxes</div>
              <h1 className="text-2xl font-semibold mt-0.5">
                {me.role === "ceo"
                  ? "Every shared inbox"
                  : me.role === "department_head"
                    ? "Your team's inboxes"
                    : "Your assigned inboxes"}
              </h1>
              <p className="text-sm text-ink/60 mt-1">
                {me.role === "ceo"
                  ? "All shared inboxes connected through Missive."
                  : me.role === "department_head"
                    ? "Inboxes assigned to anyone on your team. Click to read threads."
                    : "Open a card to read its threads. Need access to another? Ask your CEO or department head."}
              </p>
            </div>
          </div>
          {canManageAssignments(me) && (
            <Link
              href="/inboxes/manage"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/70 hover:bg-white border border-white/60 backdrop-blur transition-all hover:-translate-y-0.5"
            >
              <SettingsIcon className="w-3.5 h-3.5" /> Manage assignments
            </Link>
          )}
        </div>
        <div
          aria-hidden
          className="absolute -top-12 right-12 w-44 h-44 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
        <div
          aria-hidden
          className="absolute -bottom-10 -left-8 w-36 h-36 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(167,139,250,0.25), transparent 70%)" }}
        />
      </header>

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't reach the Missive API: {fetchError}
        </div>
      )}

      {!fetchError && inboxes.length === 0 && (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-accent/10 text-accent grid place-items-center mx-auto mb-3">
            <Inbox className="w-8 h-8" />
          </div>
          <div className="text-base font-medium">
            {me.role === "ceo" ? "No inboxes connected yet" : "No inboxes assigned to you"}
          </div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            {me.role === "ceo"
              ? "Connect one in the Missive app, then it'll show up here."
              : "Ask your CEO or department head to grant access."}
          </div>
        </div>
      )}

      {/* Combined "All inboxes" entry — only meaningful when there's
          more than one visible inbox, but always available to the CEO so
          they can drop straight into the merged view. */}
      {inboxes.length > 0 && (inboxes.length > 1 || me.role === "ceo") && (
        <Link
          href="/inboxes/all"
          className="group relative overflow-hidden rounded-2xl border border-white/60 ring-1 ring-violet-300/40 shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 p-4 flex items-center gap-3 animate-rise"
          style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #DDD6FE 60%, #E9D5FF 100%)" }}
        >
          <div className="w-12 h-12 rounded-xl bg-white/70 border border-white/80 grid place-items-center shadow-sm shrink-0">
            <Layers className="w-6 h-6 text-violet-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">
              {me.role === "ceo" ? "Every inbox" : "All your inboxes"}
            </div>
            <div className="text-xs text-ink/60 mt-0.5">
              Combined view across {inboxes.length} inbox{inboxes.length === 1 ? "" : "es"} · with status / search filters
            </div>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-violet-700 bg-white/70 px-2 py-0.5 rounded-full border border-violet-200/60">
            Merged
          </span>
        </Link>
      )}

      {inboxes.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {inboxes.map((inbox, i) => {
            const tone = PALETTE[i % PALETTE.length];
            return (
              <Link
                key={inbox.id}
                href={`/inboxes/${encodeURIComponent(inbox.id)}`}
                className={`group relative overflow-hidden rounded-2xl border border-white/40 ring-1 ${tone.ring} shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 bg-gradient-to-br ${tone.bg} p-4 animate-rise`}
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-11 h-11 rounded-xl shadow-sm grid place-items-center shrink-0 ${tone.iconBg}`}>
                    <Mail className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-ink truncate">
                      {inbox.display_name || inbox.email}
                    </div>
                    <div className="text-xs text-ink/60 truncate mt-0.5">{inbox.email}</div>
                    {inbox.last_synced_at && (
                      <div className="text-[11px] text-ink/50 mt-2">
                        Last synced {new Date(inbox.last_synced_at).toLocaleString(undefined, {
                          month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div
                  aria-hidden
                  className="absolute -bottom-6 -right-6 w-24 h-24 rounded-full opacity-50 group-hover:opacity-80 transition-opacity"
                  style={{ background: "radial-gradient(circle, rgba(255,255,255,0.6), transparent 70%)" }}
                />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
