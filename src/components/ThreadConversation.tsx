"use client";

import { useEffect, useMemo, useState } from "react";
import { AtSign, Inbox, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { MissiveThread, MissiveMessage } from "@/lib/missive-client";
import { rawEmail } from "@/lib/email-format";
import { CreateTaskFromThreadButton } from "@/components/CreateTaskFromThreadButton";
import { ReplyComposer } from "@/components/ReplyComposer";
import { ThreadAutoMarkRead } from "@/components/ThreadAutoMarkRead";
import { ScrollToLatestMessage } from "@/components/ScrollToLatestMessage";
import { ThreadMessages } from "@/components/ThreadMessages";

const LATEST_MESSAGE_ID = "thread-latest-message";

// The serializable thread payload the reading pane / API hand to this view.
// Kept here (a client component with no server deps) so both the server loader
// and the client pane can share the type without crossing the server boundary.
export interface ThreadDetailData {
  thread: MissiveThread;
  messages: MissiveMessage[];
  replyAllTo: string;
  replyAllCc: string;
  defaultTo: string | null;
  missiveThreadUrl: string | null;
  // Connected accounts (access-scoped) the user may send replies FROM.
  fromAccounts: {
    id: string;
    email: string;
    display_name: string | null;
    // Set when the mailbox's Microsoft grant is revoked — the From picker
    // flags it so a reply isn't written against a mailbox that can't send.
    needsReauth?: boolean;
  }[];
}

// The conversation UI for a single thread. Extracted verbatim from the thread
// detail page so it renders identically whether shown as a full page or inside
// the inbox reading pane. Pure props — no route params.
export function ThreadConversation({
  thread,
  messages,
  accountId,
  threadId,
  replyAllTo,
  replyAllCc,
  defaultTo,
  missiveThreadUrl,
  fromAccounts
}: ThreadDetailData & { accountId: string; threadId: string }) {
  // Which message the user is replying to. null = the default bottom composer,
  // which threads under the latest message. Picking a message from the list
  // (its per-message Reply button) pins the reply to that specific email.
  const [replyTarget, setReplyTarget] = useState<MissiveMessage | null>(null);
  // Outlook-style "pop out": render the whole conversation in a fullscreen
  // overlay so long emails read full-width. Per-thread local state — the
  // reading pane remounts this component per thread (key={threadId}), so it
  // resets to false automatically when switching conversations.
  const [maximized, setMaximized] = useState(false);

  // While maximized, lock body scroll and close on Escape.
  useEffect(() => {
    if (!maximized) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [maximized]);

  // Every address that appears anywhere in this thread (senders + recipients +
  // participants), deduped and lower-cased. Handed to the reply composer so it
  // can warn before a reply goes to someone who isn't part of the conversation.
  const threadAddresses = useMemo(() => {
    const set = new Set<string>();
    const add = (addr: string | null | undefined) => {
      const e = addr ? rawEmail(addr).toLowerCase() : "";
      if (e) set.add(e);
    };
    for (const m of messages) {
      add(m.from_addr);
      m.to_addrs?.forEach(add);
      m.cc_addrs?.forEach(add);
    }
    thread.participants?.forEach(add);
    return [...set];
  }, [messages, thread.participants]);

  const body = (
    <div className="space-y-5">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <CreateTaskFromThreadButton accountId={accountId} threadId={threadId} />
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
          {!maximized && (
            <button
              type="button"
              onClick={() => setMaximized(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm"
            >
              <Maximize2 className="w-3.5 h-3.5" /> Maximize
            </button>
          )}
        </div>
      </div>

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
        accountId={accountId}
        threadId={threadId}
        threadSubject={thread.subject || ""}
        latestMessageId={LATEST_MESSAGE_ID}
        onReplyToMessage={setReplyTarget}
      />

      {/* Inline reply — Gmail-style folded composer that expands when clicked. */}
      <ReplyComposer
        threadId={threadId}
        accountId={accountId}
        defaultTo={defaultTo}
        defaultSubject={thread.subject ?? null}
        replyAllTo={replyAllTo}
        replyAllCc={replyAllCc}
        replyTarget={replyTarget}
        onClearReplyTarget={() => setReplyTarget(null)}
        quoteSource={replyTarget ?? messages.at(-1) ?? null}
        accounts={fromAccounts}
        threadAddresses={threadAddresses}
      />

      {/* Mark-as-read upsert fires on mount — silent. refresh={false}: the
          reading pane updates the list's unread badge locally, so we skip the
          router.refresh that would re-run the (mounted) list's SSR. */}
      <ThreadAutoMarkRead
        threadId={threadId}
        accountId={accountId}
        readThroughAt={messages.at(-1)?.sent_at ?? null}
        refresh={false}
      />

      {/* Open scrolled to the newest message instead of the oldest. */}
      {messages.length > 1 && <ScrollToLatestMessage targetId={LATEST_MESSAGE_ID} />}
    </div>
  );

  // Maximized: pop the same conversation into a centered fullscreen overlay so
  // long emails read full-width (the Outlook-style "open up"). `body` keeps its
  // exact tree position whether inline or maximized — only its wrapper's class
  // changes — so the message iframes, reply draft, and scroll position survive
  // toggling (a remount would reload every iframe and drop an in-progress reply).
  return (
    <>
      {/* Backdrop — separate fixed sibling so it doesn't shift `body`'s slot.
          Animated mount/unmount; click anywhere to close. */}
      <AnimatePresence>
        {maximized && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setMaximized(false)}
            className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-md cursor-zoom-out"
          />
        )}
      </AnimatePresence>

      <div
        className={
          maximized
            ? // Start below the sticky Topbar (h-16, ~z-30) — `main` sits in a
              // z-10 stacking context, so a fixed overlay can't paint over the
              // Topbar; anchoring at top-24 keeps the card's Minimize bar clear
              // of it. (The Sidebar is z-auto and paints below, so it's covered.)
              "fixed left-1/2 top-24 z-50 -translate-x-1/2 w-[calc(100%-2rem)] max-h-[calc(100vh-7rem)] overflow-y-auto rounded-3xl bg-white shadow-[0_30px_80px_-15px_rgba(0,0,0,0.6)]"
            : ""
        }
      >
        {/* Sticky bar with a persistent close — only when maximized. Conditional
            slot keeps `body` (rendered just below) in a stable position. */}
        {maximized && (
          <div className="sticky top-0 z-10 flex items-center gap-3 px-6 py-3 bg-white/90 backdrop-blur border-b border-border/60">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {thread.subject || "(no subject)"}
            </h2>
            <button
              type="button"
              onClick={() => setMaximized(false)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm shrink-0"
            >
              <Minimize2 className="w-3.5 h-3.5" /> Minimize
            </button>
          </div>
        )}
        <div className={maximized ? "p-6" : ""}>{body}</div>
      </div>
    </>
  );
}
