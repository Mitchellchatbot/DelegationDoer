import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// RPC 9's caller is Area A's real finishTurnV2Rpc in slack-intel-store.ts (B-P7b-1: the only module that may name it; added
// at integration). The mock passes the real module through and only lets one test take the caller away (`hasCaller`), to
// prove chat-store fails closed when the export is absent.
const intel = vi.hoisted(() => ({ hasCaller: true }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-intel-store")>();
  const mod: Record<string, unknown> = { ...real };
  Object.defineProperty(mod, "finishTurnV2Rpc", { enumerable: true, get: () => (intel.hasCaller ? real.finishTurnV2Rpc : undefined) });
  return mod;
});

import { createChatFakeDb, type ChatFakeConfig, type ChatFakeDb, type Row } from "@/lib/exec/__tests__/fake-chat-store-db";
import { assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import type { TurnUsage } from "@/lib/exec/agent/types";
import { REDACTED_TEXT } from "@/lib/exec/chat/copy";
import {
  __resetChatStoreColumnsForTests,
  finishTurn,
  listRedactedSince,
  loadConversation,
  loadTurnByMessageId,
  redactChatMessage,
  type FinishTurnInput
} from "@/lib/exec/chat-store";
import { principalFromRows } from "@/lib/exec/principal";
import { SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import { SlackIntelStoreError, __resetSlackIntelStoreForTests } from "@/lib/exec/slack-intel-store";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area D: chat-store.ts's D6 (contract §3.17.3 D6, §2.5 item 2, N15; §5.9 RD01-RD03 and the stored-message half of C24).

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CONV = `ecv_${hex(1)}`;
const MSG = (n: number) => `ecm_${hex(n)}`;
const TURN = (n: number) => `ect_${hex(n)}`;
const P = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
) as ExecPrincipal;

const usage: TurnUsage = {
  modelCalls: 1, toolCalls: 1, toolCallsNotPersisted: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
  transformations: 0, unknownMarkers: 0, partialRoundUncounted: false, promptVersion: "exec-chat-v3", toolsVersion: "t"
};
const FINISH: FinishTurnInput = {
  messageId: MSG(2), status: "complete", statusReason: null, refusalCategory: null, text: "Done.", recommendations: "", sources: [], cards: [], toolCalls: [],
  consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, usage, model: "claude-opus-5-5", refSeq: 2
};
const SLACK = { slackRefs: ["m:C0ACMESEO:1794140000.000100", "d:C0ACMESEO:2026-11-07:0"], slackChannels: ["C0ACMESEO"], privateSlack: true };

let db: ChatFakeDb;
function useDb(cfg: ChatFakeConfig = {}): ChatFakeDb {
  db = createChatFakeDb(cfg);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  intel.hasCaller = true;
  __resetSlackIntelStoreForTests();
  __resetChatStoreColumnsForTests();
});

afterEach(() => {
  // The store logs nothing, and an RPC's payload never reaches a log or an error message.
  assertNoSlackLeak({ console: out });
});

describe("finishTurn's v2 path (D6, RD01-RD03)", () => {
  it("RD01 a turn that consulted Slack finishes through RPC 9 with the snapshot (and RPC 2's arguments unchanged)", async () => {
    useDb({ rpc: { exec_chat_finish_turn_v2: (a) => (a.p_message_id === "" ? false : true) } });
    const signal = new AbortController().signal;
    expect(await finishTurn(P, { ...FINISH, ...SLACK }, { signal })).toBe(true);
    const calls = db.on("exec_chat_finish_turn_v2");
    // The availability probe (a no-op call), then the finish.
    expect(calls).toHaveLength(2);
    expect(calls[1].payload).toEqual({
      p_principal: "ep_1", p_message_id: MSG(2), p_status: "complete", p_status_reason: null, p_refusal_category: null, p_text: "Done.", p_recommendations: "",
      p_sources: [], p_cards: [], p_tool_calls: [], p_consulted: [], p_consulted_clients: [], p_consulted_dd_text: false, p_usage: usage,
      p_model: "claude-opus-5-5", p_ref_seq: 2, p_slack_refs: SLACK.slackRefs, p_slack_channels: SLACK.slackChannels, p_private_slack: true
    });
    expect(calls[1].signal).toBe(signal);
    expect(db.on("exec_chat_finish_turn")).toEqual([]);
    // The probe is cached: the next finish calls RPC 9 once.
    await finishTurn(P, { ...FINISH, ...SLACK }, { signal });
    expect(db.on("exec_chat_finish_turn_v2")).toHaveLength(3);
  });

  it("RD01 the private flag alone (no keys) still takes v2", async () => {
    useDb({ rpc: { exec_chat_finish_turn_v2: () => true } });
    await finishTurn(P, { ...FINISH, slackRefs: [], slackChannels: [], privateSlack: true }, { signal: new AbortController().signal });
    expect(db.on("exec_chat_finish_turn_v2").at(-1)?.payload).toMatchObject({ p_private_slack: true, p_slack_refs: [], p_slack_channels: [] });
  });

  it("RD02 no Slack consult → P5b's RPC 2 exactly, with no probe (v2 present or not)", async () => {
    useDb({ rpc: { exec_chat_finish_turn: () => true, exec_chat_finish_turn_v2: () => true } });
    expect(await finishTurn(P, FINISH, { signal: new AbortController().signal })).toBe(true);
    expect(await finishTurn(P, { ...FINISH, slackRefs: [], slackChannels: [], privateSlack: false }, { signal: new AbortController().signal })).toBe(true);
    expect(db.on("exec_chat_finish_turn")).toHaveLength(2);
    expect(db.on("exec_chat_finish_turn_v2")).toEqual([]);
  });

  it("RD03 v2 missing with a non-empty snapshot → throws finish_v2_missing (the consults are never dropped by a v1 finish)", async () => {
    useDb({ rpc: { exec_chat_finish_turn: () => true } });   // RPC 9 → PGRST202
    const err = await finishTurn(P, { ...FINISH, ...SLACK }, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackIntelStoreError);
    expect((err as SlackIntelStoreError).op).toBe("finish_v2_missing");
    expect(db.on("exec_chat_finish_turn")).toEqual([]);
  });

  it("RD03 the store without RPC 9's caller (the tree before Area A adds it) fails the same way, closed", async () => {
    intel.hasCaller = false;
    useDb({ rpc: { exec_chat_finish_turn: () => true, exec_chat_finish_turn_v2: () => true } });
    const err = await finishTurn(P, { ...FINISH, ...SLACK }, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((err as SlackIntelStoreError).op).toBe("finish_v2_missing");
    expect(db.on("exec_chat_finish_turn")).toEqual([]);
  });

  it("an RPC 9 error throws a SlackIntelStoreError with the code only", async () => {
    let n = 0;
    useDb({ rpc: { exec_chat_finish_turn_v2: () => (++n === 1 ? false : { error: { code: "23514", message: "violates exec_messages_slack_pair_check SECRET" } }) } });
    const err = await finishTurn(P, { ...FINISH, ...SLACK }, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackIntelStoreError);
    expect(String((err as Error).message)).not.toContain("SECRET");
  });
});

function messageRow(n: number, over: Row = {}): Row {
  return {
    id: MSG(n), conversation_id: CONV, principal_id: "ep_1", turn_id: TURN(Math.ceil(n / 2)), role: n % 2 === 1 ? "user" : "assistant", status: "complete",
    status_reason: null, text: `text ${n}`, recommendations: "", context: null, sources: [], cards: [], consulted_email_thread_ids: [], consulted_client_ids: [],
    consulted_dd_text: false, created_at: new Date(Date.parse("2026-11-07T12:00:00.000Z") + n * 1000).toISOString(), finished_at: null, redacted_at: null, ...over
  };
}
const conversationRow = (): Row => ({ id: CONV, principal_id: "ep_1", surface: "web", title: "Slack", ref_seq: 2, turn_count: 1, created_at: "2026-11-07T12:00:00.000Z", last_message_at: "2026-11-07T12:00:02.000Z" });

describe("StoredMessage.consultedPrivateSlack (D6, N15, C24)", () => {
  it("read when the P7b column exists (true / false per row)", async () => {
    useDb({ tables: { exec_conversations: [conversationRow()], exec_messages: [messageRow(1, { consulted_private_slack: false }), messageRow(2, { consulted_private_slack: true })] } });
    const loaded = await loadConversation(P, CONV, { maxTurns: 5 });
    expect(loaded?.turns[0].assistant?.consultedPrivateSlack).toBe(true);
    expect(loaded?.turns[0].user.consultedPrivateSlack).toBe(false);
    expect(db.on("exec_messages")[0].columns).toContain("consulted_private_slack");
  });

  it("a database without the P7b column: the read retries without it, the field is absent, and the next reads skip it", async () => {
    useDb({ tables: { exec_conversations: [conversationRow()], exec_messages: [messageRow(1), messageRow(2)] } });
    const loaded = await loadConversation(P, CONV, { maxTurns: 5 });
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0].assistant).not.toHaveProperty("consultedPrivateSlack");
    const reads = db.on("exec_messages");
    expect(reads).toHaveLength(2);
    expect(reads[0].columns).toContain("consulted_private_slack");
    expect(reads[1].columns).not.toContain("consulted_private_slack");
    const again = await loadTurnByMessageId(P, MSG(2));
    expect(again?.assistant?.id).toBe(MSG(2));
    expect(db.on("exec_messages").slice(2).every((r) => !String(r.columns).includes("consulted_private_slack"))).toBe(true);
  });

  it("a stored draft card keeps its private_slack kind", async () => {
    useDb({ tables: { exec_conversations: [conversationRow()], exec_messages: [messageRow(1), messageRow(2, {
      cards: [{ kind: "draft", id: `ed_${hex(9)}`, existing: false, privateRefKinds: ["private_slack", "dd_text", "bogus"] }]
    })] } });
    const loaded = await loadConversation(P, CONV, { maxTurns: 5 });
    expect(loaded?.turns[0].assistant?.cards).toEqual([{ kind: "draft", id: `ed_${hex(9)}`, existing: false, privateRefKinds: ["private_slack", "dd_text"] }]);
  });
});

describe("the Slack redaction sentences (§3.9, C27)", () => {
  it("redactChatMessage takes the two Slack sentences as well as P5b's two, and nothing else", async () => {
    useDb({ rpc: { exec_chat_redact_message: () => true } });
    for (const text of [SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT, REDACTED_TEXT]) expect(await redactChatMessage(P, MSG(2), text)).toBe(true);
    await expect(redactChatMessage(P, MSG(2), "anything else")).rejects.toThrow(TypeError);
  });

  it("listRedactedSince: a Slack removal is verified and flagged slack; the unchecked one is flagged, not verified", async () => {
    useDb({ tables: { exec_messages: [
      messageRow(2, { text: SLACK_REDACTED_TEXT, redacted_at: "2026-11-07T12:10:00.000Z" }),
      messageRow(4, { text: SLACK_UNCHECKED_TEXT, redacted_at: "2026-11-07T12:11:00.000Z" }),
      messageRow(6, { text: REDACTED_TEXT, redacted_at: "2026-11-07T12:12:00.000Z" })
    ] } });
    expect(await listRedactedSince(P, CONV, "2026-11-07T12:00:00.000Z")).toEqual([
      { id: MSG(2), verified: true, slack: true },
      { id: MSG(4), verified: false, slack: true },
      { id: MSG(6), verified: true }
    ]);
  });
});
