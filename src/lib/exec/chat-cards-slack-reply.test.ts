import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
// Area D's href builder (a stage-0 stub until it lands) at its module boundary.
vi.mock("@/lib/exec/slack-reply-links", () => ({ slackReplyPageHref: vi.fn(), slackNewReplyHref: vi.fn(), slackReplyHrefForAttention: vi.fn() }));

import { createChatFakeDb, type Row } from "@/lib/exec/__tests__/fake-chat-store-db";
import { storedMessageViews } from "@/lib/exec/agent/turn";
import type { ChatCard } from "@/lib/exec/agent/types";
import { loadConversation, type StoredTurn } from "@/lib/exec/chat-store";
import { principalFromRows } from "@/lib/exec/principal";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 contract §3.6.1, AM-P10-21 (Area C): a chat answer's slack_reply card is stored as { kind, id, existing } and shown as
// CardView { kind: "slack_reply", draftId, href, existing }, in chat-store.ts' cardsOf (stored JSON → ChatCard) and agent/turn.ts'
// resolveCards (ChatCard → CardView). The card never carries the draft's text: the chat card reads it from DD.

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CONV = `ecv_${hex(1)}`;
const DRAFT = `esr_${"9".repeat(32)}`;
const NOW = new Date("2026-11-10T15:00:00.000Z");
const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();

const msgRow = (n: number, over: Row = {}): Row => ({
  id: `ecm_${hex(n)}`, principal_id: "ep_1", conversation_id: CONV, turn_id: `ect_${hex(Math.ceil(n / 2))}`, role: n % 2 === 1 ? "user" : "assistant",
  client_turn_id: `ctid-${Math.ceil(n / 2)}`, status: "complete", status_reason: null, text: n % 2 === 1 ? "Draft a reply to Jane" : "Drafted.",
  recommendations: "", context: null, sources: [], cards: [], tool_calls: [], consulted_email_thread_ids: [], consulted_client_ids: [],
  consulted_dd_text: false, usage: null, model: null, created_at: at(n), finished_at: at(n), redacted_at: null, expires_at: at(90 * 86400), ...over
});
const convRow: Row = {
  id: CONV, principal_id: "ep_1", surface: "web", title: "Slack replies", create_client_turn_id: "ctid-1", ref_seq: 2, turn_count: 1,
  created_at: at(0), last_message_at: at(2), updated_at: at(2), expires_at: at(90 * 86400)
};

beforeEach(() => {
  vi.mocked(slackReplyPageHref).mockImplementation((id: string) => `/executive/slack/replies/${id}`);
});

describe("chat-store cardsOf: the stored slack_reply card", () => {
  it("is read back as { kind: slack_reply, id, existing }; a malformed id is left out; the other kinds are unchanged", async () => {
    const db = createChatFakeDb({ tables: { exec_conversations: [convRow], exec_messages: [msgRow(1), msgRow(2, { cards: [
      { kind: "slack_reply", id: DRAFT, existing: true },
      { kind: "slack_reply", id: "esr_nope", existing: false },
      { kind: "slack_reply", id: DRAFT.replace("9", "8"), existing: "yes", text: "SENTINEL-NOT-A-CARD-FIELD" },
      { kind: "draft", id: `ed_${hex(3)}`, existing: false, privateRefKinds: ["private_slack"] }
    ] })] } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const out = await loadConversation(P, CONV, { maxTurns: 5 });
    expect(out?.turns[0].assistant?.cards).toEqual([
      { kind: "slack_reply", id: DRAFT, existing: true },
      { kind: "slack_reply", id: DRAFT.replace("9", "8"), existing: false },
      { kind: "draft", id: `ed_${hex(3)}`, existing: false, privateRefKinds: ["private_slack"] }
    ]);
    expect(JSON.stringify(out)).not.toContain("SENTINEL-NOT-A-CARD-FIELD");
  });
});

describe("agent/turn.ts resolveCards: ChatCard slack_reply → CardView", () => {
  it("draftId, the page href (Area D's builder) and existing; no read needed; email draft cards unchanged beside it", async () => {
    const cards: ChatCard[] = [{ kind: "slack_reply", id: DRAFT, existing: false }, { kind: "draft", id: `ed_${hex(4)}`, existing: true, privateRefKinds: [] }];
    const base = { status: "complete", statusReason: null, recommendations: "", context: null, sources: [], consultedEmailThreadIds: [], consultedClientIds: [],
      consultedDdText: false, consultedPrivateSlack: false, createdAt: at(1), finishedAt: at(1), redactedAt: null };
    const turn = {
      turnId: `ect_${hex(1)}`,
      user: { ...base, id: `ecm_${hex(1)}`, role: "user", text: "Draft a reply to Jane", cards: [] },
      assistant: { ...base, id: `ecm_${hex(2)}`, role: "assistant", text: "Drafted.", cards }
    } as unknown as StoredTurn;
    const views = await storedMessageViews(P, [turn], NOW);
    expect(views[1].cards).toEqual([
      { kind: "slack_reply", draftId: DRAFT, href: `/executive/slack/replies/${DRAFT}`, existing: false },
      { kind: "draft", draftId: `ed_${hex(4)}`, href: `/executive/email/drafts/ed_${hex(4)}`, existing: true, privateRefKinds: [] }
    ]);
    expect(slackReplyPageHref).toHaveBeenCalledWith(DRAFT);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });
});
