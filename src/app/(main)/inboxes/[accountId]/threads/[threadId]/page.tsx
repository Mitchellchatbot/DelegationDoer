import { redirect } from "next/navigation";
import { AtSign, SendHorizontal, Inbox, Send, ExternalLink, Reply } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getThread, type MissiveMessage } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { BackPill } from "@/components/BackPill";
import { Avatar } from "@/components/Avatar";

export const dynamic = "force-dynamic";

// Pull "Name" out of "Name <email>", or fall back to the local-part of the
// address. Used to label the avatar + sender pill.
function shortName(addr: string): string {
  const m = addr.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  if (m) return m[1].trim();
  const at = addr.indexOf("@");
  return at > 0 ? addr.slice(0, at) : addr;
}

function rawEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return m ? m[1] : addr;
}

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
    thread = detail.thread;
    messages = detail.messages;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  const missiveThreadUrl = missiveAppUrl
    ? `${missiveAppUrl}/?thread=${encodeURIComponent(params.threadId)}`
    : null;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <BackPill
          href={`/inboxes/${encodeURIComponent(params.accountId)}`}
          label="Threads"
        />
        {missiveThreadUrl && (
          <div className="flex items-center gap-2">
            <a
              href={missiveThreadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in Missive
            </a>
            <a
              href={missiveThreadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)" }}
            >
              <Reply className="w-3.5 h-3.5" /> Reply in Missive
            </a>
          </div>
        )}
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
            style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #DDD6FE 100%)" }}
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

          {/* Messages */}
          <div className="space-y-4">
            {messages.map((m, i) => {
              const senderName = shortName(m.from_addr);
              const senderEmail = rawEmail(m.from_addr);
              const outbound = m.direction === "outbound";
              return (
                <article
                  key={m.id}
                  className={
                    "relative overflow-hidden rounded-2xl border shadow-soft hover:shadow-lift transition-shadow animate-rise " +
                    (outbound
                      ? "border-blue-200/60 bg-gradient-to-br from-blue-50 to-white"
                      : "border-violet-200/60 bg-white")
                  }
                  style={{ animationDelay: `${Math.min(i * 0.05, 0.5)}s` }}
                >
                  {/* left accent stripe (color-codes direction) */}
                  <span
                    aria-hidden
                    className={
                      "absolute left-0 top-0 bottom-0 w-1 " +
                      (outbound ? "bg-blue-400" : "bg-violet-400")
                    }
                  />

                  {/* Header band */}
                  <header
                    className="flex items-start gap-3 p-4 border-b border-border/60"
                    style={{
                      background: outbound
                        ? "linear-gradient(90deg, rgba(219,234,254,0.4) 0%, rgba(255,255,255,0) 60%)"
                        : "linear-gradient(90deg, rgba(237,233,254,0.5) 0%, rgba(255,255,255,0) 60%)"
                    }}
                  >
                    <Avatar name={senderName} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-semibold truncate">{senderName}</div>
                        <span
                          className={
                            "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border " +
                            (outbound
                              ? "bg-blue-100 text-blue-700 border-blue-200/60"
                              : "bg-violet-100 text-violet-700 border-violet-200/60")
                          }
                        >
                          {outbound ? <Send className="w-2.5 h-2.5" /> : <Inbox className="w-2.5 h-2.5" />}
                          {outbound ? "Sent" : "Received"}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted truncate">{senderEmail}</div>

                      {/* Recipient pills */}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {m.to_addrs.length > 0 && (
                          <RecipientPill label="to" addrs={m.to_addrs} />
                        )}
                        {m.cc_addrs.length > 0 && (
                          <RecipientPill label="cc" addrs={m.cc_addrs} />
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] bg-white/70 border border-border/60 text-ink/70 tabular-nums">
                        {new Date(m.sent_at).toLocaleString(undefined, {
                          month: "short", day: "numeric", year: "numeric",
                          hour: "numeric", minute: "2-digit"
                        })}
                      </div>
                    </div>
                  </header>

                  {/* Body */}
                  <div className="p-5">
                    {m.body_html ? (
                      <div
                        className="email-body text-sm leading-relaxed prose prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: m.body_html }}
                      />
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">
                        {m.body_text || "(empty)"}
                      </pre>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function RecipientPill({ label, addrs }: { label: "to" | "cc"; addrs: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200/60">
      <SendHorizontal className="w-3 h-3" />
      <span className="text-slate-500 mr-0.5">{label}</span>
      <span className="truncate max-w-[220px]">
        {addrs.slice(0, 2).map(shortName).join(", ")}
        {addrs.length > 2 ? ` +${addrs.length - 2}` : ""}
      </span>
    </span>
  );
}
