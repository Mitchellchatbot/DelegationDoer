"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Inbox, Paperclip, SendHorizontal, Reply, Loader2 } from "lucide-react";
import type { MissiveMessage } from "@/lib/missive-client";
import { shortName, rawEmail, formatBytes, messageSnippet } from "@/lib/email-format";
import { fetchDeferredBody } from "@/lib/message-body-cache";
import { Avatar } from "@/components/Avatar";
import { ForwardButton } from "@/components/ForwardButton";
import { EmailBody } from "@/components/EmailBody";

// Gmail-style thread collapse. A thread can hold many messages; rendering every
// one fully expanded turns it into a wall of email. Instead we show only the
// latest message expanded and collapse the rest into one-line clickable stubs.
// The body iframe is not mounted while a message is collapsed, which also speeds
// up opening long threads. Mirrors missiveclone's ThreadView behaviour, in
// DelegationDoer's Tailwind style.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function ThreadMessages({
  messages,
  accountId,
  threadId,
  threadSubject,
  latestMessageId,
  onReplyToMessage
}: {
  messages: MissiveMessage[];
  accountId: string;
  threadId: string;
  threadSubject: string;
  latestMessageId: string;
  // Pin the bottom composer to a specific message in the chain.
  onReplyToMessage: (m: MissiveMessage) => void;
}) {
  // Set of message ids shown expanded; null = not initialised yet (default to
  // the latest). Keyed on the message-id signature so unrelated re-renders don't
  // discard the user's manual expand/collapse choices.
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  const sigRef = useRef<string>("");
  useEffect(() => {
    const sig = messages.map((m) => m.id).join(",");
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setExpandedIds(
      messages.length ? new Set([messages[messages.length - 1].id]) : null
    );
  }, [messages]);

  const lastId = messages.length ? messages[messages.length - 1].id : null;
  const toggleMsg = useCallback(
    (id: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev ?? (lastId ? [lastId] : []));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [lastId]
  );

  const effectiveExpanded =
    expandedIds ?? new Set<string>(lastId ? [lastId] : []);

  return (
    <div className="space-y-4">
      {messages.map((m, i) => {
        const senderName = shortName(m.from_addr);
        const senderEmail = rawEmail(m.from_addr);
        const outbound = m.direction === "outbound";
        const isLatest = i === messages.length - 1;
        const expanded = effectiveExpanded.has(m.id);
        const hasAttachments = (m.attachments ?? []).length > 0;

        // Anchor wrapper keeps the scroll-to-latest target stable regardless of
        // whether the latest message is expanded or collapsed.
        return (
          <div key={m.id} id={isLatest ? latestMessageId : undefined}>
            {!expanded ? (
              // Collapsed stub
              <button
                type="button"
                onClick={() => toggleMsg(m.id)}
                title="Expand message"
                className={
                  "w-full text-left flex items-center gap-3 rounded-2xl border shadow-soft hover:shadow-lift transition-shadow px-4 py-3 " +
                  (outbound
                    ? "border-blue-200/60 bg-gradient-to-br from-blue-50 to-white"
                    : "border-indigo-200/60 bg-white")
                }
              >
                <Avatar name={senderName} size={28} />
                <span className="text-sm font-semibold shrink-0">{senderName}</span>
                <span className="text-sm text-ink/55 truncate flex-1 min-w-0">
                  {messageSnippet(m)}
                </span>
                {hasAttachments && (
                  <Paperclip className="w-3.5 h-3.5 text-muted shrink-0" />
                )}
                <span className="text-[11px] text-muted shrink-0 tabular-nums">
                  {fmtDate(m.sent_at)}
                </span>
              </button>
            ) : (
              // Expanded message card
              <article
                className={
                  "relative overflow-hidden rounded-2xl border shadow-soft hover:shadow-lift transition-shadow animate-rise " +
                  (outbound
                    ? "border-blue-200/60 bg-gradient-to-br from-blue-50 to-white"
                    : "border-indigo-200/60 bg-white")
                }
                style={{ animationDelay: `${Math.min(i * 0.05, 0.5)}s` }}
              >
                {/* left accent stripe (color-codes direction) */}
                <span
                  aria-hidden
                  className={
                    "absolute left-0 top-0 bottom-0 w-1 " +
                    (outbound ? "bg-blue-400" : "bg-indigo-400")
                  }
                />

                {/* Header band — click to collapse */}
                <header
                  onClick={() => toggleMsg(m.id)}
                  title="Collapse message"
                  className="flex items-start gap-3 p-4 border-b border-border/60 cursor-pointer"
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
                            : "bg-indigo-100 text-indigo-700 border-indigo-200/60")
                        }
                      >
                        {outbound ? <Send className="w-2.5 h-2.5" /> : <Inbox className="w-2.5 h-2.5" />}
                        {outbound ? "Sent" : "Received"}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted truncate">{senderEmail}</div>

                    {/* Recipient pills */}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {m.to_addrs.length > 0 && <RecipientPill label="to" addrs={m.to_addrs} />}
                      {m.cc_addrs.length > 0 && <RecipientPill label="cc" addrs={m.cc_addrs} />}
                    </div>
                  </div>
                  <div
                    className="shrink-0 text-right flex flex-col items-end gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] bg-white/70 border border-border/60 text-ink/70 tabular-nums">
                      {fmtDate(m.sent_at)}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Reply to THIS specific message. Pins the bottom
                          composer so the reply threads under this email (and
                          pre-fills its sender), instead of always the latest. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onReplyToMessage(m); }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white/70 border border-border/60 text-ink/70 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm"
                        title="Reply to this email"
                      >
                        <Reply className="w-3 h-3" /> Reply
                      </button>
                      {/* Forward this specific message. Sends from the inbox in
                          view (accountId); the server rebuilds the quoted body +
                          re-attaches the originals. */}
                      <ForwardButton
                        accountId={accountId}
                        threadId={threadId}
                        messageId={m.id}
                        sourceSubject={m.subject || threadSubject || ""}
                        sourceFrom={m.from_addr}
                        sourceDate={fmtDate(m.sent_at)}
                        attachmentCount={(m.attachments ?? []).length}
                      />
                    </div>
                  </div>
                </header>

                {/* Body — sandboxed iframe so the email's <style> + font rules
                    can't cascade into the app. Plain-text fallback gets prose.
                    Deferred bodies (older messages, withheld on thread open) are
                    fetched on expand — this card only mounts when expanded. */}
                <div className="p-5">
                  {m.body_html ? (
                    <EmailBody html={m.body_html} />
                  ) : m.body_deferred ? (
                    <DeferredMessageBody
                      messageId={m.id}
                      accountId={accountId}
                      threadId={threadId}
                      fallbackText={m.body_text}
                    />
                  ) : (
                    <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">
                      {m.body_text || "(empty)"}
                    </pre>
                  )}
                </div>

                {/* Attachments — one chip per file. We deliberately do NOT
                    filter out "inline" (cid) images: the sandboxed iframe can't
                    resolve cid: refs, so hiding them would make real attachments
                    vanish. Each chip links to the proxy that streams bytes from
                    the clone with an access check. */}
                {hasAttachments && (
                  <div className="px-5 pb-5 -mt-1 flex flex-wrap gap-2">
                    {(m.attachments ?? []).map((a) => (
                      <a
                        key={a.id}
                        href={`/api/inboxes/attachments/${encodeURIComponent(a.id)}?account=${encodeURIComponent(accountId)}&thread=${encodeURIComponent(threadId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border/60 bg-white/70 hover:border-accent/40 hover:text-accent transition-all hover:-translate-y-0.5 shadow-sm max-w-full"
                        title={`Download ${a.filename}`}
                      >
                        <Paperclip className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-xs font-medium truncate max-w-[200px]">{a.filename}</span>
                        {a.size_bytes > 0 && (
                          <span className="text-[10px] text-muted shrink-0 tabular-nums">{formatBytes(a.size_bytes)}</span>
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </article>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Renders a message body that was deferred on thread open. Mounts only when its
// message is expanded (the expanded card is conditionally rendered), so it
// fetches on first expand; the module cache makes collapse→re-expand instant and
// shares the request with a reply that quotes the same message.
function DeferredMessageBody({
  messageId,
  accountId,
  threadId,
  fallbackText
}: {
  messageId: string;
  accountId: string;
  threadId: string;
  fallbackText: string | null;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; html: string | null; text: string | null }
  >({ status: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    fetchDeferredBody(messageId, accountId, threadId, ac.signal)
      .then((body) =>
        setState({ status: "ready", html: body.body_html, text: body.body_text })
      )
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ac.abort();
  }, [messageId, accountId, threadId]);

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-ink/50 py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading message…
      </div>
    );
  }
  if (state.status === "error") {
    // Fall back to whatever text we have (usually none) rather than a blank body.
    return (
      <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed text-ink/70">
        {fallbackText || "Couldn't load this message."}
      </pre>
    );
  }
  if (state.html) return <EmailBody html={state.html} />;
  return (
    <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">
      {state.text || fallbackText || "(empty)"}
    </pre>
  );
}

function RecipientPill({ label, addrs }: { label: "to" | "cc"; addrs: string[] }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200/60"
      title={addrs.join("\n")}
    >
      <SendHorizontal className="w-3 h-3" />
      <span className="text-slate-500 mr-0.5">{label}</span>
      <span className="truncate max-w-[220px]">
        {addrs.slice(0, 2).map(shortName).join(", ")}
        {addrs.length > 2 ? ` +${addrs.length - 2}` : ""}
      </span>
    </span>
  );
}
