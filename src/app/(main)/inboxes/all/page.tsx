import { redirect } from "next/navigation";
import { Mail, Inbox } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts, listThreads, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { ThreadFilters } from "@/components/ThreadFilters";
import { ThreadList } from "@/components/ThreadList";
import { ComposeButton } from "@/components/ComposeButton";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: "open" | "pending" | "closed";
  q?: string;
  sort?: "recent" | "oldest";
}

// Combined "every inbox the actor is allowed to see" view. Leader gets the
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
    // Always fetch every thread — flipping filter pills filters this
    // set client-side so we never round-trip Missive on a filter change.
    const [allAccounts, fetched, visibleIds] = await Promise.all([
      listAccounts(),
      // 1000 instead of 200 — the page filters client-side so we want
      // a big enough working set that "All inboxes" actually shows
      // weeks of history, not just the last day or two of a busy team.
      listThreads({ folder: "INBOX", limit: 1000 }),
      visibleAccountIdsFor(me)
    ]);

    inboxes = visibleIds === null
      ? allAccounts
      : allAccounts.filter((a) => visibleIds.has(a.id));
    // Critical: also filter the threads themselves. listThreads is
    // workspace-scoped on the Missive side, so without this every
    // user with access to the page would see every thread regardless
    // of which inboxes they're actually in. Threads expose the
    // emails of every connected account they touch via
    // account_emails — match against the inboxes this user can see.
    if (visibleIds === null) {
      threads = fetched;
    } else {
      const visibleEmails = new Set(
        inboxes.map((a) => a.email.toLowerCase())
      );
      threads = fetched.filter((t) =>
        (t.account_emails ?? []).some((ae) =>
          visibleEmails.has(ae.email.toLowerCase())
        )
      );
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const inboxCount = inboxes.length;
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  const readByThread = await readStateForThreads(userId, threads.map((t) => t.id));
  const decoratedThreads = threads.map((t) => ({
    thread: t,
    unread: isThreadUnread(t.last_message_at, readByThread.get(t.id))
  }));
  const unreadCount = decoratedThreads.filter((d) => d.unread).length;

  return (
    <div className="space-y-5">
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
              {me.role === "leader" ? "Every inbox" : "All your inboxes"}
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
        {inboxCount > 0 && (
          <div className="relative mt-3 flex items-center justify-end">
            <ComposeButton accounts={inboxes} />
          </div>
        )}
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

      {!fetchError && unreadCount > 0 && (
        <div className="text-xs text-ink/60 px-1">
          <span className="font-semibold text-accent">{unreadCount}</span> unread of {threads.length}
        </div>
      )}

      {!fetchError && (
        <ThreadList
          threads={decoratedThreads}
          linkAccountId={inboxes[0]?.id ?? "all"}
          accountIdByEmail={Object.fromEntries(
            inboxes.map((a) => [a.email.toLowerCase(), a.id])
          )}
          missiveAppUrl={missiveAppUrl || undefined}
        />
      )}
    </div>
  );
}
