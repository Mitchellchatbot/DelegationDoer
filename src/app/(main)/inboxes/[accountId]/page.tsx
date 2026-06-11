import { notFound, redirect } from "next/navigation";
import { Mail, PenSquare } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listThreadsPaged, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";
import { InboxThreadsClient } from "@/components/InboxThreadsClient";
import { ComposeButton } from "@/components/ComposeButton";
import { InboxSplit } from "@/components/InboxSplit";

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
  let hasMore = false;
  let inboxLabel = "Inbox";
  let inboxEmail = "";
  let fetchError: string | null = null;
  try {
    // SSR the first 50 — the client component handles infinite scroll
    // + search via /api/inboxes/threads from there. mailboxId is
    // critical: without it, listThreadsPaged returns the whole
    // workspace, leaking other inboxes into this view.
    const [allAccounts, firstPage] = await Promise.all([
      listAccounts(),
      listThreadsPaged({ folder: "INBOX", limit: 50, mailboxId: params.accountId })
    ]);
    const account = allAccounts.find((a) => a.id === params.accountId);
    if (!account) notFound();
    inboxLabel = account.display_name || account.email;
    inboxEmail = account.email;
    threads = firstPage.threads;
    hasMore = firstPage.hasMore;
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
    <InboxSplit>
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

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't load threads: {fetchError}
        </div>
      )}

      {!fetchError && (
        <InboxThreadsClient
          initialThreads={decoratedThreads}
          initialHasMore={hasMore}
          linkAccountId={params.accountId}
          mailboxId={params.accountId}
          missiveAppUrl={missiveAppUrl || undefined}
        />
      )}
    </div>
    </InboxSplit>
  );
}
