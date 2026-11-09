import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import { CHAT_NOT_INSTALLED_TEXT, CHAT_OFF_PAGE_TEXT } from "@/lib/exec/chat/copy";
import type { ChatConversationView } from "@/lib/exec/chat/view-types";
import { EmptyState } from "../EmptyState";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { ConversationList } from "./ConversationList";
import { ExecChat, type ExecChatProps } from "./ExecChat";

// /executive/chat (P5b contract §3.19.7), drawn from what the page read and
// nothing else: the header and tabs, then his conversations beside the chat
// (a select above it on a phone), with a note when the conversation or the
// item he asked to open isn't available. Chat off: one line pointing at
// Settings, and no chat at all. Not installed (ui-7): Settings' own sentence,
// with no link, since Settings has no switch to turn until the migration runs.

export const CHAT_PAGE_COPY = {
  openSettings: "Open Settings"
} as const;

export function ChatPageView({
  generatedAt,
  tz,
  conversations,
  activeId,
  note,
  chat,
  notInstalled = false
}: {
  generatedAt: string;
  tz: string;
  /** null: the list couldn't be read. */
  conversations: readonly ChatConversationView[] | null;
  activeId: string | null;
  /** "That conversation isn't available." or a context note; plain words only. */
  note: string | null;
  /** null: chat is off or not installed. */
  chat: ExecChatProps | null;
  /** With chat null: the P5b migration isn't applied (ui-7). */
  notInstalled?: boolean;
}) {
  const header = <ExecHeader updatedAt={generatedAt} tz={tz} trailing={<ExecTabs active="chat" tabs={EXEC_TABS} />} />;
  if (chat === null) {
    return (
      <div className="space-y-5">
        {header}
        <section data-chat-off={notInstalled ? "not_installed" : "off"} className="rounded-2xl border border-slate-200/70 bg-white shadow-soft">
          {notInstalled ? (
            <EmptyState icon={MessageSquareOff} message={CHAT_NOT_INSTALLED_TEXT} />
          ) : (
            <EmptyState
              icon={MessageSquareOff}
              message={CHAT_OFF_PAGE_TEXT}
              action={
                <Link href="/executive/settings" prefetch={false} className="text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900">
                  {CHAT_PAGE_COPY.openSettings}
                </Link>
              }
            />
          )}
        </section>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {header}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <ConversationList conversations={conversations} activeId={activeId} tz={tz} nowIso={generatedAt} className="lg:sticky lg:top-4" />
        <section className="min-w-0 space-y-3 rounded-2xl border border-slate-200/70 bg-white px-4 py-4 shadow-soft">
          {note && (
            <p role="status" data-chat-page-note className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
              {note}
            </p>
          )}
          <ExecChat key={activeId ?? "new"} {...chat} />
        </section>
      </div>
    </div>
  );
}
