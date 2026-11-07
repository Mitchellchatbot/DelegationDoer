import { ChatPageView } from "@/components/exec/chat/ChatPageView";
import type { ExecChatProps } from "@/components/exec/chat/ExecChat";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { resolveChatContext, storedMessageViews } from "@/lib/exec/agent/turn";
import type { ChatContextKind } from "@/lib/exec/agent/types";
import { listConversations, loadConversation } from "@/lib/exec/chat-store";
import { parseContextParam } from "@/lib/exec/chat/context-param";
import { chatEmailOn } from "@/lib/exec/chat/email-on";
import { BANNER_CONTEXT_CHECK_FAILED, BANNER_CONTEXT_UNAVAILABLE, CHAT_STARTERS, CONVERSATION_UNAVAILABLE_TEXT } from "@/lib/exec/chat/copy";
import type { ChatConversationView, ChatMessageView } from "@/lib/exec/chat/view-types";
import { loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// /executive/chat (P5b contract §3.19.7, C29): his conversations and the
// chat. The gate comes first, before any read or any output; a non-owner (or
// a session opened by a one-time sign-in link) gets Next's not-found page
// and nothing is read for them. Then the settings: chat not installed or off
// shows one line pointing at Settings and reads nothing else. Otherwise, in
// parallel and each failing on its own:
//   - the 50 newest web conversations (the list GET of the plan, C29);
//   - ?c=<id>: that conversation's newest 100 turns, as the GET route shows
//     them (a running answer older than 600 s reads failed / stale); a bad id,
//     a missing or foreign conversation, or a failed read shows the list
//     with "That conversation isn't available.";
//   - ?context=<kind>:<id>: resolved and screened on the server (P3's screen
//     for a thread, P5a's for an attention item), its label shown in the
//     chip; one that is gone, or couldn't be checked, is a note instead.
// The chat itself posts to /api/exec/chat, which checks everything again.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const CONVERSATION_ID = /^ecv_[0-9a-f]{32}$/;
const MAX_LIST = 50;
const MAX_TURNS = 100;

type SearchParams = Record<string, string | string[] | undefined> | undefined;

const single = (v: string | string[] | undefined): string | null => (typeof v === "string" && v !== "" ? v : null);

function conversationView(c: { id: string; title: string; createdAt: string; lastMessageAt: string; turnCount: number }): ChatConversationView {
  return { id: c.id, title: c.title, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt, turnCount: c.turnCount };
}

async function openConversation(
  principal: ExecPrincipal,
  id: string | null,
  now: Date
): Promise<{ conversation: { id: string; title: string }; messages: ChatMessageView[] } | "unavailable" | null> {
  if (id === null) return null;
  if (!CONVERSATION_ID.test(id)) return "unavailable";
  try {
    const loaded = await loadConversation(principal, id, { maxTurns: MAX_TURNS, surface: "web" });
    if (loaded === null) return "unavailable";
    const messages = await storedMessageViews(principal, loaded.turns, now);
    return { conversation: { id: loaded.conversation.id, title: loaded.conversation.title }, messages };
  } catch {
    return "unavailable";
  }
}

async function contextChip(
  principal: ExecPrincipal,
  settings: ExecSettings,
  raw: string | null,
  now: Date
): Promise<{ chip: { kind: ChatContextKind; id: string; label: string } | null; note: string | null }> {
  if (raw === null) return { chip: null, note: null };
  const input = parseContextParam(raw);
  if (input === null) return { chip: null, note: BANNER_CONTEXT_UNAVAILABLE };
  try {
    const r = await resolveChatContext(principal, settings, input, now);
    if (!r.ok) return { chip: null, note: r.reason === "check_failed" ? BANNER_CONTEXT_CHECK_FAILED : BANNER_CONTEXT_UNAVAILABLE };
    // An attention item's chip names the item (its title), not its first source (ui-1, §3.19.7).
    return { chip: { kind: r.context.kind, id: r.context.id, label: r.label ?? r.context.source.label }, note: null };
  } catch {
    return { chip: null, note: BANNER_CONTEXT_CHECK_FAILED };
  }
}

export default async function ExecutiveChatPage({ searchParams }: { searchParams?: SearchParams }) {
  const principal = await requireExecPrincipalForPage("GET /executive/chat");
  const now = new Date();
  const generatedAt = now.toISOString();
  const settings = await loadSettings(principal.id);
  if (!(settings.chatSchemaReady && settings.chatEnabled)) {
    // ui-7: not installed has its own line (Settings has no switch to point at then); installed but off points there.
    return <ChatPageView generatedAt={generatedAt} tz={principal.timezone} conversations={null} activeId={null} note={null} chat={null} notInstalled={!settings.chatSchemaReady} />;
  }

  const [list, opened, context] = await Promise.all([
    listConversations(principal, { surface: "web", limit: MAX_LIST })
      .then((rows) => rows.map(conversationView))
      .catch((): ChatConversationView[] | null => null),
    openConversation(principal, single(searchParams?.c), now),
    contextChip(principal, settings, single(searchParams?.context), now)
  ]);

  const open = opened !== null && opened !== "unavailable" ? opened : null;
  const note = opened === "unavailable" ? CONVERSATION_UNAVAILABLE_TEXT : context.note;
  const chat: ExecChatProps = {
    variant: "page",
    initialConversation: open?.conversation ?? null,
    initialMessages: open?.messages ?? [],
    initialContext: context.chip,
    starters: CHAT_STARTERS,
    tz: principal.timezone,
    nowIso: generatedAt,
    emailOn: chatEmailOn(settings, principal)
  };
  return <ChatPageView generatedAt={generatedAt} tz={principal.timezone} conversations={list} activeId={open?.conversation.id ?? null} note={note} chat={chat} />;
}
