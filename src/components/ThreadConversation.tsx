"use client";

import { AtSign, Inbox, ExternalLink } from "lucide-react";
import type { MissiveThread, MissiveMessage } from "@/lib/missive-client";
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
  missiveThreadUrl
}: ThreadDetailData & { accountId: string; threadId: string }) {
  return (
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
      />

      {/* Inline reply — Gmail-style folded composer that expands when clicked. */}
      <ReplyComposer
        threadId={threadId}
        accountId={accountId}
        defaultTo={defaultTo}
        defaultSubject={thread.subject ?? null}
        replyAllTo={replyAllTo}
        replyAllCc={replyAllCc}
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
}
