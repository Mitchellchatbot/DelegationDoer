import { redirect } from "next/navigation";
import { Mail, Inbox } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccountsCached, listThreadsPaged, INBOX_SSR_PAGE, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { restrictionsFor } from "@/lib/restricted-senders";
import { InboxThreadsClient } from "@/components/InboxThreadsClient";
import { ComposeButton } from "@/components/ComposeButton";
import { InboxSplit } from "@/components/InboxSplit";
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
  let hasMore = false;
  let fetchError: string | null = null;
  try {
    // Resolve which inboxes the actor can see BEFORE fetching threads, so
    // we can scope the query server-side instead of pulling the whole
    // workspace and filtering in JS (which broke offset/hasMore and left
    // the combined view stuck on "Loading more…" forever).
    const [allAccounts, visibleIds] = await Promise.all([
      listAccountsCached(),
      visibleAccountIdsFor(me)
    ]);

    inboxes = visibleIds === null
      ? allAccounts
      : allAccounts.filter((a) => visibleIds.has(a.id));

    if (visibleIds !== null && inboxes.length === 0) {
      // Non-leader with no inboxes assigned — nothing to show, and an
      // empty mailbox_ids must NOT fall through to a whole-workspace fetch.
      threads = [];
      hasMore = false;
    } else {
      // SSR only the first page (50 threads). The client component streams
      // in more on scroll via /api/inboxes/threads with the same scope.
      // Leaders (visibleIds === null) get the whole workspace; everyone
      // else is scoped to exactly their visible inbox ids.
      const firstPage = await listThreadsPaged({
        folder: "INBOX",
        limit: INBOX_SSR_PAGE,
        mailboxIds: visibleIds === null ? undefined : inboxes.map((a) => a.id)
      });
      // Defensive backstop (no-op against an up-to-date backend that honors
      // mailbox_ids): only matters if a stale backend ignores the scope, so
      // a non-leader can never be served inboxes they can't see. Mirrors the
      // /api/inboxes/threads guard so SSR and infinite-scroll agree.
      let inScope: MissiveThread[];
      if (visibleIds === null) {
        inScope = firstPage.threads;
      } else {
        const visibleEmails = new Set(inboxes.map((a) => a.email.toLowerCase()));
        inScope = firstPage.threads.filter((t) =>
          (t.account_emails ?? []).some((ae) =>
            visibleEmails.has(ae.email.toLowerCase())
          )
        );
      }
      // Sender-scoped privacy (see src/lib/restricted-senders.ts). Applied to
      // BOTH branches on purpose: a leader who isn't a viewer on the rule is
      // restricted too, exactly like a private inbox. hasMore stays the
      // backend's raw answer — same contract as /api/inboxes/threads.
      const restrict = await restrictionsFor(me);
      threads = restrict ? inScope.filter((t) => !restrict.blocksThread(t)) : inScope;
      hasMore = firstPage.hasMore;
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

  return (
    <InboxSplit>
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

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't load threads: {fetchError}
        </div>
      )}

      {!fetchError && (
        <InboxThreadsClient
          initialThreads={decoratedThreads}
          initialHasMore={hasMore}
          linkAccountId={inboxes[0]?.id ?? "all"}
          accountIdByEmail={Object.fromEntries(
            inboxes.map((a) => [a.email.toLowerCase(), a.id])
          )}
          missiveAppUrl={missiveAppUrl || undefined}
        />
      )}
    </div>
    </InboxSplit>
  );
}
