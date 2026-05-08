import { notFound, redirect } from "next/navigation";
import { Mail } from "lucide-react";
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

export default async function InboxThreadsPage({
  params,
  searchParams
}: {
  params: { accountId: string };
  searchParams: SearchParams;
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const visibleIds = await visibleAccountIdsFor(me);
  if (visibleIds !== null && !visibleIds.has(params.accountId)) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <div className="text-base font-medium">Access denied</div>
        <div className="text-sm text-muted mt-1">
          You don't have access to this inbox. Ask your CEO or department head to assign it.
        </div>
      </div>
    );
  }

  let threads: MissiveThread[] = [];
  let inboxLabel = "Inbox";
  let inboxEmail = "";
  let fetchError: string | null = null;
  try {
    const [allAccounts, fetched] = await Promise.all([
      listAccounts(),
      listThreads({
        folder: "INBOX",
        status: searchParams.status,
        q: searchParams.q,
        limit: 200
      })
    ]);
    const account = allAccounts.find((a) => a.id === params.accountId);
    if (!account) notFound();
    inboxLabel = account.display_name || account.email;
    inboxEmail = account.email;
    threads = fetched;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  if (searchParams.sort === "oldest") {
    threads = [...threads].reverse();
  }

  // Server-side env var is fine to read here; we pass the resolved URL down
  // as a string so the ThreadCard (server component output) doesn't need it.
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <BackPill href="/inboxes" label="Inboxes" />

      <header
        className="relative overflow-hidden rounded-2xl border border-border shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 35%, #C7D2FE 70%, #DBEAFE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-white/60 backdrop-blur border border-white/60 grid place-items-center">
            <Mail className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{inboxLabel}</h1>
            {inboxEmail && inboxEmail !== inboxLabel && (
              <p className="text-xs text-ink/60">{inboxEmail}</p>
            )}
          </div>
        </div>
        <div
          aria-hidden
          className="absolute -top-8 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.16), transparent 70%)" }}
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
          <div className="text-base font-medium">
            {searchParams.q || searchParams.status ? "No threads match" : "No threads yet"}
          </div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            {searchParams.q || searchParams.status
              ? "Try clearing the filter or search."
              : "Once Missive syncs new mail, conversations will show up here."}
          </div>
        </div>
      )}

      {threads.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {threads.map((t, i) => (
            <ThreadCard
              key={t.id}
              thread={t}
              href={`/inboxes/${encodeURIComponent(params.accountId)}/threads/${encodeURIComponent(t.id)}`}
              missiveUrl={missiveAppUrl ? `${missiveAppUrl}/?thread=${encodeURIComponent(t.id)}` : undefined}
              animationDelay={Math.min(i * 0.02, 0.5)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
