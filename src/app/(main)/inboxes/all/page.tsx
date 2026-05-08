import { redirect } from "next/navigation";
import { Mail, Inbox } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listThreads, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { BackPill } from "@/components/BackPill";
import { ThreadFilters } from "@/components/ThreadFilters";
import { ThreadCard } from "@/components/ThreadCard";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: "open" | "pending" | "closed";
  q?: string;
  sort?: "recent" | "oldest";
}

// Combined "every inbox the actor is allowed to see" view. CEO gets the
// whole workspace; dept heads get their team's inboxes; workers get only
// their assignments. Threads are fetched once from Missive (the API is
// already workspace-scoped) and rendered in one big card grid.
export default async function AllInboxesPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  let inboxes: { id: string; email: string; display_name: string | null }[] = [];
  let threads: MissiveThread[] = [];
  let fetchError: string | null = null;
  try {
    const [allAccounts, fetched, visibleIds] = await Promise.all([
      listAccounts(),
      listThreads({
        folder: "INBOX",
        status: searchParams.status,
        q: searchParams.q,
        limit: 200
      }),
      visibleAccountIdsFor(me)
    ]);

    inboxes = visibleIds === null
      ? allAccounts
      : allAccounts.filter((a) => visibleIds.has(a.id));
    threads = fetched;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  // Sort client-side (Missive's threads endpoint returns recent-first by default).
  if (searchParams.sort === "oldest") {
    threads = [...threads].reverse();
  }

  const inboxCount = inboxes.length;
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <BackPill href="/inboxes" label="Inboxes" />

      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-white/60 backdrop-blur border border-white/60 grid place-items-center">
            <Inbox className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">
              {me.role === "ceo" ? "Every inbox" : "All your inboxes"}
            </h1>
            <p className="text-xs text-ink/60 mt-0.5">
              {inboxCount === 0
                ? "No inboxes you can see yet."
                : `Combined view across ${inboxCount} inbox${inboxCount === 1 ? "" : "es"}`}
              {inboxCount > 0 && (
                <span className="text-ink/50">
                  {" · "}
                  {inboxes.slice(0, 4).map((a) => a.email).join(", ")}
                  {inboxCount > 4 ? ` +${inboxCount - 4}` : ""}
                </span>
              )}
            </p>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      <ThreadFilters totalCount={threads.length} />

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't load threads: {fetchError}
        </div>
      )}

      {!fetchError && threads.length === 0 && (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center mx-auto mb-3">
            <Mail className="w-8 h-8" />
          </div>
          <div className="text-base font-medium">No threads match</div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            Try clearing the filter or search.
          </div>
        </div>
      )}

      {threads.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {threads.map((t, i) => (
            <ThreadCard
              key={t.id}
              thread={t}
              // No specific accountId here — link via the first visible account
              // so the user lands on a consistent breadcrumb. Falls back to the
              // first inbox the actor can see.
              href={`/inboxes/${encodeURIComponent(inboxes[0]?.id ?? "all")}/threads/${encodeURIComponent(t.id)}`}
              missiveUrl={missiveAppUrl ? `${missiveAppUrl}/?thread=${encodeURIComponent(t.id)}` : undefined}
              animationDelay={Math.min(i * 0.02, 0.5)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
