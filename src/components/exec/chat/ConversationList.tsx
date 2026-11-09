import Link from "next/link";
import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import type { ChatConversationView } from "@/lib/exec/chat/view-types";
import { formatInZone, pluralize } from "@/lib/exec/format";
import { cn } from "@/lib/utils";

// His conversations on /executive/chat (P5b contract §3.19.7, C29): links to
// ?c=<id>, newest first as the page read them, the open one marked. At lg and
// up a list beside the chat; on a phone a select at the top that opens the
// chosen one with a plain GET form, so it needs no script. Pure. A title is
// his own first question, clipped, shown as text.

export const CONVERSATION_LIST_COPY = {
  heading: "Conversations",
  newConversation: "New conversation",
  none: "No conversations yet.",
  open: "Open",
  selectLabel: "Conversation",
  error: "Couldn't load your conversations."
} as const;

const href = (id: string) => `/executive/chat?c=${encodeURIComponent(id)}`;

export function ConversationList({
  conversations,
  activeId,
  tz,
  nowIso,
  className
}: {
  /** null: the list couldn't be read. */
  conversations: readonly ChatConversationView[] | null;
  activeId: string | null;
  tz: string;
  nowIso: string;
  className?: string;
}) {
  const rows = conversations ?? [];
  return (
    <div data-conversation-list className={cn("min-w-0", className)}>
      {/* Phones: a select and a GET form (no script needed). */}
      <form method="get" action="/executive/chat" data-conversation-select className="flex min-w-0 items-center gap-2 lg:hidden">
        <label htmlFor="exec-chat-conversation" className="sr-only">
          {CONVERSATION_LIST_COPY.selectLabel}
        </label>
        <select
          id="exec-chat-conversation"
          name="c"
          defaultValue={activeId ?? ""}
          className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px] text-ink"
        >
          <option value="">{CONVERSATION_LIST_COPY.newConversation}</option>
          {rows.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button type="submit" className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink">
          {CONVERSATION_LIST_COPY.open}
        </button>
      </form>
      {conversations === null && <p className="mt-1.5 text-[12px] text-amber-800 lg:mt-0">{CONVERSATION_LIST_COPY.error}</p>}

      {/* lg and up: the list. */}
      <nav aria-label={CONVERSATION_LIST_COPY.heading} className="hidden min-w-0 lg:block">
        <div className="flex items-center justify-between gap-2 pb-2">
          <h2 className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
            {CONVERSATION_LIST_COPY.heading}
          </h2>
        </div>
        <Link
          href="/executive/chat"
          prefetch={false}
          data-new-conversation-link
          aria-current={activeId === null ? "page" : undefined}
          className={cn(
            "mb-2 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12.5px] font-semibold",
            activeId === null ? "border-indigo-200 bg-indigo-50 text-indigo-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-ink"
          )}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
          {CONVERSATION_LIST_COPY.newConversation}
        </Link>
        {conversations !== null && rows.length === 0 && <p className="px-1 text-[12px] text-muted">{CONVERSATION_LIST_COPY.none}</p>}
        <ul className="space-y-1">
          {rows.map((c) => {
            const active = c.id === activeId;
            return (
              <li key={c.id}>
                <Link
                  href={href(c.id)}
                  prefetch={false}
                  data-conversation={c.id}
                  aria-current={active ? "page" : undefined}
                  className={cn("block min-w-0 rounded-xl px-3 py-2", active ? "bg-indigo-50 text-indigo-900" : "text-slate-700 hover:bg-slate-50 hover:text-ink")}
                >
                  <span className="line-clamp-2 text-[12.5px] font-medium [overflow-wrap:anywhere]">{c.title}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {`${formatInZone(c.lastMessageAt, tz, "datetime", nowIso)} · ${pluralize(c.turnCount, "question")}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
