import { requireExecPrincipal } from "@/lib/exec/access";
import { storedMessageViews } from "@/lib/exec/agent/turn";
import { loadConversation } from "@/lib/exec/chat-store";
import type { ChatConversationView } from "@/lib/exec/chat/view-types";
import { jsonAnswer, jsonError } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import type { ExecSettings } from "@/lib/exec/types";

// GET /api/exec/conversations/:id (P5b contract §3.16.2, C29, S1; Area D): one web
// conversation with its newest 100 turns, for the chat's stream-drop recovery and
// the busy poll. Gate (strong) → the id's shape (400 bad_request) → settings
// (P5b not installed → 404) → the read (not found → 404, a DB error → 503) →
// 200 { conversation, messages, hasEarlier }. A running answer older than 600 s
// is shown failed / stale (storedMessageViews). A read: no same-origin check, no
// rate limit and no audit row (the gate's access log records it). Answers and
// logs carry codes and ids only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "GET /api/exec/conversations/:id";
const CONVERSATION_ID = /^ecv_[0-9a-f]{32}$/;
const MAX_TURNS = 100;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;
  const conversationId = params?.id;
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return jsonError(400, "bad_request");

  let settings: ExecSettings;
  try {
    settings = await loadSettings(principal.id);
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: settings read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }
  if (!settings.chatSchemaReady) return jsonError(404, "not_found");

  const now = new Date();
  try {
    // Web conversations only: a Slack thread (P6) isn't the web chat's to show.
    const loaded = await loadConversation(principal, conversationId, { maxTurns: MAX_TURNS, surface: "web", signal: req.signal });
    if (!loaded) return jsonError(404, "not_found");
    const messages = await storedMessageViews(principal, loaded.turns, now, { signal: req.signal });
    const c = loaded.conversation;
    const conversation: ChatConversationView = { id: c.id, title: c.title, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt, turnCount: c.turnCount };
    return jsonAnswer(200, { conversation, messages, hasEarlier: loaded.hasEarlier });
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }
}
