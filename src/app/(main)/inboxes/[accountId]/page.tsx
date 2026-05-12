import { notFound, redirect } from "next/navigation";
import { Mail, PenSquare } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listThreads, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";
import { ThreadFilters } from "@/components/ThreadFilters";
import { ThreadList } from "@/components/ThreadList";
import { ComposeButton } from "@/components/ComposeButton";

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
          You don't have access to this inbox. Ask your Leader or department head to assign it.
        </div>
      </div>
    );
  }

  let threads: MissiveThread[] = [];
  let inboxLabel = "Inbox";
  let inboxEmail = "";
  let fetchError: string | null = null;
  try {
    // Fetch every thread once (no status/q filter) — flipping the
    // filter pills filters this set client-side, so we never wait on
    // Missive again after the first load.
    const [allAccounts, fetched] = await Promise.all([
      listAccounts(),
      // Scope server-side to this connected account. Without
      // mailbox_id, listThreads returns every thread in the
      // workspace, leaking other inboxes.
      listThreads({ folder: "INBOX", limit: 200, mailboxId: params.accountId })
    ]);
    const account = allAccounts.find((a) => a.id === params.accountId);
    if (!account) notFound();
    inboxLabel = account.display_name || account.email;
    inboxEmail = account.email;
    threads = fetched;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  // Read-state lookup — one batched query for every thread on the page.
  // Threads without a row are unread by definition.
  const readByThread = await readStateForThreads(userId, threads.map((t) => t.id));
  const decoratedThreads = threads.map((t) => ({
    thread: t,
    unread: isThreadUnread(t.last_message_at, readByThread.get(t.id))
  }));
  const unreadCount = decoratedThreads.filter((d) => d.unread).length;

  return (
    <div className="space-y-5">
      <header
        className="relative overflow-hidden rounded-2xl border border-border shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 35%, #C7D2FE 70%, #DBEAFE 100%)" }}
      >
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-xl bg-white/60 backdrop-blur border border-white/60 grid place-items-center shrink-0">
              <Mail className="w-6 h-6 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold truncate">{inboxLabel}</h1>
              <div className="flex items-center gap-2 text-xs">
                {inboxEmail && inboxEmail !== inboxLabel && (
                  <span className="text-ink/60 truncate">{inboxEmail}</span>
                )}
                {unreadCount > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/25 font-semibold tabular-nums">
                    {unreadCount} unread
                  </span>
                )}
              </div>
            </div>
          </div>
          <ComposeButton accountId={params.accountId} accountEmail={inboxEmail} />
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

      {!fetchError && (
        <ThreadList
          threads={decoratedThreads}
          linkAccountId={params.accountId}
          missiveAppUrl={missiveAppUrl || undefined}
        />
      )}
    </div>
  );
}
