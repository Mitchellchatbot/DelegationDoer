import { redirect } from "next/navigation";
import { AtSign, Inbox, ExternalLink } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getThread, listAccounts, type MissiveMessage } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { rawEmail } from "@/lib/email-format";
import { CreateTaskFromThreadButton } from "@/components/CreateTaskFromThreadButton";
import { ReplyComposer } from "@/components/ReplyComposer";
import { ThreadAutoMarkRead } from "@/components/ThreadAutoMarkRead";
import { ScrollToLatestMessage } from "@/components/ScrollToLatestMessage";
import { ThreadMessages } from "@/components/ThreadMessages";

const LATEST_MESSAGE_ID = "thread-latest-message";

export const dynamic = "force-dynamic";

export default async function ThreadDetailPage({
  params
}: { params: { accountId: string; threadId: string } }) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const visibleIds = await visibleAccountIdsFor(me);
  if (visibleIds !== null && !visibleIds.has(params.accountId)) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <div className="text-base font-medium">Access denied</div>
      </div>
    );
  }

  let thread = null;
  let messages: MissiveMessage[] = [];
  let fetchError: string | null = null;
  try {
    const detail = await getThread(params.threadId);
    // Make sure the thread actually belongs to the accountId in the
    // URL — otherwise someone with access to inbox A could view
    // any thread by pasting its id into /inboxes/<A>/threads/<id>.
    // Threads can span multiple accounts, so we check the per-message
    // account_ids against the URL's accountId.
    const threadAccountIds = new Set(
      detail.messages.map((m) => m.account_id)
    );
    if (!threadAccountIds.has(params.accountId)) {
      return (
        <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
          <div className="text-base font-medium">Access denied</div>
        </div>
      );
    }
    thread = detail.thread;
    messages = detail.messages;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  const missiveThreadUrl = missiveAppUrl
    ? `${missiveAppUrl}/?thread=${encodeURIComponent(params.threadId)}`
    : null;

  // Reply-all recipient sets, derived from the last inbound message. We
  // need the current inbox's own address so we can drop it — replying-all
  // shouldn't loop the reply back to yourself.
  const ownEmail = (await listAccounts().catch(() => []))
    .find((a) => a.id === params.accountId)?.email ?? "";
  const ownEmailLower = ownEmail.toLowerCase();
  const lastInboundForReplyAll = [...messages].reverse().find((m) => m.direction === "inbound");
  // To = original sender + everyone on the original To line.
  // Cc = the original Cc line. Both: normalize, drop self, de-dupe; and
  // strip anything from Cc that's already in To.
  const dedupe = (addrs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of addrs) {
      const e = rawEmail(a).trim();
      if (!e) continue;
      const lower = e.toLowerCase();
      if (lower === ownEmailLower || seen.has(lower)) continue;
      seen.add(lower);
      out.push(e);
    }
    return out;
  };
  const replyAllTo = lastInboundForReplyAll
    ? dedupe([lastInboundForReplyAll.from_addr, ...lastInboundForReplyAll.to_addrs])
    : [];
  const replyAllToLower = new Set(replyAllTo.map((e) => e.toLowerCase()));
  const replyAllCc = lastInboundForReplyAll
    ? dedupe(lastInboundForReplyAll.cc_addrs).filter((e) => !replyAllToLower.has(e.toLowerCase()))
    : [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <CreateTaskFromThreadButton
            accountId={params.accountId}
            threadId={params.threadId}
          />
          {missiveThreadUrl && (
            <a
              href={missiveThreadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in Missive
            </a>
          )}
        </div>
      </div>

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't load thread: {fetchError}
        </div>
      )}

      {thread && (
        <>
          {/* Subject hero — gradient header sets the visual tone for the
              whole conversation. */}
          <header
            className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
            style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
          >
            <div className="relative">
              <h1 className="text-xl font-semibold text-ink">
                {thread.subject || "(no subject)"}
              </h1>
              <div className="text-xs text-ink/60 mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <AtSign className="w-3 h-3" />
                  {thread.participants.length} participant{thread.participants.length === 1 ? "" : "s"}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <Inbox className="w-3 h-3" />
                  {messages.length} message{messages.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <div
              aria-hidden
              className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
              style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
            />
          </header>

          {/* Messages — Gmail-style: latest expanded, older ones collapsed
              into clickable stubs. Client component owns the collapse state. */}
          <ThreadMessages
            messages={messages}
            accountId={params.accountId}
            threadId={params.threadId}
            threadSubject={thread.subject || ""}
            latestMessageId={LATEST_MESSAGE_ID}
          />

          {/* Inline reply — Gmail-style folded composer that expands
              when the user clicks. */}
          <ReplyComposer
            threadId={params.threadId}
            accountId={params.accountId}
            defaultTo={(() => {
              const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
              return lastInbound ? rawEmail(lastInbound.from_addr) : null;
            })()}
            defaultSubject={thread.subject ?? null}
            replyAllTo={replyAllTo.join(", ")}
            replyAllCc={replyAllCc.join(", ")}
          />

          {/* Mark-as-read upsert fires on mount — silent. */}
          <ThreadAutoMarkRead
            threadId={params.threadId}
            accountId={params.accountId}
            readThroughAt={messages.at(-1)?.sent_at ?? null}
          />

          {/* Open scrolled to the newest message instead of the oldest. */}
          {messages.length > 1 && (
            <ScrollToLatestMessage targetId={LATEST_MESSAGE_ID} />
          )}
        </>
      )}
    </div>
  );
}
