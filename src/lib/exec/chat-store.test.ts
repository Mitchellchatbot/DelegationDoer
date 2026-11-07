import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createChatFakeDb, type ChatFakeConfig, type ChatFakeDb, type Row } from "@/lib/exec/__tests__/fake-chat-store-db";
import type { TurnUsage } from "@/lib/exec/agent/types";
import { REDACTED_TEXT, UNCHECKED_TEXT } from "@/lib/exec/chat/copy";
import {
  CHAT_REDACT_CHUNK,
  ChatStoreError,
  beginTurn,
  casProposal,
  finishTurn,
  getProposal,
  insertProposal,
  listChatDraftIdsForThreads,
  listConversations,
  listProposalsForMessages,
  listRedactedSince,
  loadConversation,
  loadTurnByMessageId,
  proposalContentHash,
  proposalInsertRow,
  purgeExpiredChatRows,
  redactChatForThreads,
  redactChatMessage,
  type FinishTurnInput,
  type NewProposal
} from "@/lib/exec/chat-store";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The chat store (P5b contract §3.3; T69 and T71's store half) against an
// in-memory PostgREST. The RPCs' own SQL is the SQL suite's (S1-S19); here
// only the mapping, the guards, the chunking and the not-installed rule.

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CONV = `ecv_${hex(1)}`;
const TURN = (n: number) => `ect_${hex(n)}`;
const MSG = (n: number) => `ecm_${hex(n)}`;
const PROP = (n: number) => `etp_${hex(n)}`;
const DRAFT = (n: number) => `ed_${hex(n)}`;
const NOW = new Date("2026-11-07T12:00:00.000Z");
const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();

function mint(id = "ep_1"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();

let db: ChatFakeDb;
function useDb(cfg: ChatFakeConfig = {}): ChatFakeDb {
  db = createChatFakeDb(cfg);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
});

const msgRow = (n: number, over: Row = {}): Row => ({
  id: MSG(n),
  principal_id: "ep_1",
  conversation_id: CONV,
  turn_id: TURN(Math.ceil(n / 2)),
  role: n % 2 === 1 ? "user" : "assistant",
  client_turn_id: `ctid-${Math.ceil(n / 2)}`,
  status: "complete",
  status_reason: null,
  text: n % 2 === 1 ? "A question" : "An answer [r1].",
  recommendations: "",
  context: null,
  sources: [],
  cards: [],
  tool_calls: [{ round: 1, name: "search_email", args: { q: "secret" }, ok: true, error: null, ms: 3 }],
  consulted_email_thread_ids: [],
  consulted_client_ids: [],
  consulted_dd_text: false,
  usage: null,
  model: null,
  created_at: at(Math.ceil(n / 2) * 10),
  finished_at: at(Math.ceil(n / 2) * 10),
  redacted_at: null,
  expires_at: at(90 * 86400),
  ...over
});
const convRow = (over: Row = {}): Row => ({
  id: CONV,
  principal_id: "ep_1",
  surface: "web",
  title: "What happened today?",
  create_client_turn_id: "ctid-1",
  ref_seq: 3,
  turn_count: 2,
  created_at: at(0),
  last_message_at: at(20),
  updated_at: at(20),
  expires_at: at(90 * 86400),
  ...over
});

// ---------------------------------------------------------------------------
// beginTurn / finishTurn
// ---------------------------------------------------------------------------

const BEGIN_INPUT = {
  conversationId: null,
  clientTurnId: "ctid-000001",
  surface: "web" as const,
  text: "What did I miss?",
  context: null,
  title: "What did I miss?",
  retentionDays: 90,
  staleSeconds: 600,
  rateLimit: 30,
  rateWindowSeconds: 600,
  maxRunning: 2
};

describe("beginTurn (T69)", () => {
  const started = {
    outcome: "started", conversation_id: CONV, created: true, turn_id: TURN(1), user_message_id: MSG(1),
    user_created_at: "2026-11-07T12:00:00.123456+00:00", assistant_message_id: MSG(2), ref_seq: 1, context_ref: "r1"
  };

  it("sends all twelve parameters (the context as { kind, id } only) with the signal, and maps started", async () => {
    useDb({ rpc: { exec_chat_begin_turn: () => started } });
    const signal = new AbortController().signal;
    const r = await beginTurn(P, { ...BEGIN_INPUT, context: { kind: "attention", id: "ea_1", label: "never sent" } as never }, { signal });
    expect(r).toEqual({
      outcome: "started", conversationId: CONV, created: true, turnId: TURN(1), userMessageId: MSG(1),
      userCreatedAt: "2026-11-07T12:00:00.123456+00:00", assistantMessageId: MSG(2), refSeq: 1, contextRef: "r1"
    });
    const [call] = db.on("exec_chat_begin_turn");
    expect(call.payload).toEqual({
      p_principal: "ep_1", p_conversation_id: null, p_client_turn_id: "ctid-000001", p_surface: "web", p_user_text: "What did I miss?",
      p_context: { kind: "attention", id: "ea_1" }, p_title: "What did I miss?", p_retention_days: 90, p_stale_seconds: 600,
      p_rate_limit: 30, p_rate_window_seconds: 600, p_max_running: 2
    });
    expect(call.signal).toBe(signal);
  });

  it("maps every other outcome: replay, busy, busy_principal, rate_limited, not_found; context_ref null", async () => {
    const answers: [unknown, unknown][] = [
      [{ ...started, context_ref: null, ref_seq: 0, created: false }, { outcome: "started", conversationId: CONV, created: false, turnId: TURN(1), userMessageId: MSG(1), userCreatedAt: started.user_created_at, assistantMessageId: MSG(2), refSeq: 0, contextRef: null }],
      [{ outcome: "replay", conversation_id: CONV, turn_id: TURN(1), assistant_message_id: MSG(2) }, { outcome: "replay", conversationId: CONV, turnId: TURN(1), assistantMessageId: MSG(2) }],
      [{ outcome: "busy", conversation_id: CONV }, { outcome: "busy", conversationId: CONV }],
      [{ outcome: "busy_principal" }, { outcome: "busy_principal" }],
      [{ outcome: "rate_limited", retry_after_seconds: 299 }, { outcome: "rate_limited", retryAfterSeconds: 299 }],
      [{ outcome: "rate_limited", retry_after_seconds: 0 }, { outcome: "rate_limited", retryAfterSeconds: 1 }],
      [{ outcome: "not_found" }, { outcome: "not_found" }]
    ];
    for (const [raw, mapped] of answers) {
      useDb({ rpc: { exec_chat_begin_turn: () => raw } });
      expect(await beginTurn(P, BEGIN_INPUT), JSON.stringify(raw)).toEqual(mapped);
    }
  });

  it("a malformed answer, a database error and a missing function (P5b not installed) all throw ChatStoreError; no value in the message", async () => {
    for (const raw of [null, "started", { outcome: "started", conversation_id: CONV }, { outcome: "busy" }, { outcome: "rate_limited" }, { outcome: "maybe" }]) {
      useDb({ rpc: { exec_chat_begin_turn: () => raw } });
      await expect(beginTurn(P, BEGIN_INPUT), JSON.stringify(raw)).rejects.toBeInstanceOf(ChatStoreError);
    }
    useDb({ rpc: { exec_chat_begin_turn: () => ({ error: { code: "P0001", message: 'invalid input syntax for type json: "What did I miss?"' } }) } });
    const err = await beginTurn(P, BEGIN_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatStoreError);
    expect((err as ChatStoreError).code).toBe("P0001");
    expect((err as ChatStoreError).table).toBe("exec_messages");
    expect(String((err as Error).message)).not.toContain("What did I miss?");
    useDb({ rpc: { exec_chat_begin_turn: () => ({ error: { code: "22P02", message: 'invalid input syntax for type uuid: "hunter2" in relation "exec_messages"' } }) } });
    const word = await beginTurn(P, BEGIN_INPUT).catch((e: unknown) => e);
    expect((word as Error).message).not.toContain("hunter2");
    expect((word as Error).message).toContain('"exec_messages"');
    useDb({});
    const missing = await beginTurn(P, BEGIN_INPUT).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ChatStoreError);
    expect((missing as ChatStoreError).code).toBe("PGRST202");
  });

  it("an aborted signal throws the abort, not a store error; a bad context or principal is refused before any call", async () => {
    useDb({ rpc: { exec_chat_begin_turn: () => started } });
    const c = new AbortController();
    c.abort(new Error("begin timed out"));
    await expect(beginTurn(P, BEGIN_INPUT, { signal: c.signal })).rejects.toThrow("begin timed out");
    await expect(beginTurn(P, { ...BEGIN_INPUT, context: { kind: "task", id: "t_1" } as never })).rejects.toThrow(TypeError);
    await expect(beginTurn({} as ExecPrincipal, BEGIN_INPUT)).rejects.toThrow(TypeError);
    expect(db.on("exec_chat_begin_turn")).toHaveLength(1);
  });
});

const usage: TurnUsage = {
  modelCalls: 2, toolCalls: 3, toolCallsNotPersisted: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5,
  costUsd: 0.12, transformations: 0, unknownMarkers: 0, partialRoundUncounted: false, promptVersion: "exec-chat-v2", toolsVersion: "tools-v1"
};
const FINISH: FinishTurnInput = {
  messageId: MSG(2), status: "complete", statusReason: null, refusalCategory: null, text: "Done [r1].", recommendations: "- Call",
  sources: [{ ref: "r1", target: { type: "task", id: "t_1" }, source: { class: "internal", label: "Task" } as never }],
  cards: [{ kind: "task_proposal", id: PROP(1) }],
  toolCalls: [{ round: 1, name: "search_tasks", args: { query: "x" }, ok: true, error: null, ms: 12 }],
  consultedEmailThreadIds: ["th_1"], consultedClientIds: ["cl_1"], consultedDdText: true, usage, model: "claude-opus-5-5", refSeq: 4
};

describe("finishTurn (T69)", () => {
  it("sends all sixteen parameters with its own signal and answers the CAS (true / false)", async () => {
    let answer = true;
    useDb({ rpc: { exec_chat_finish_turn: () => answer } });
    const signal = new AbortController().signal;
    expect(await finishTurn(P, FINISH, { signal })).toBe(true);
    const [call] = db.on("exec_chat_finish_turn");
    expect(call.payload).toEqual({
      p_principal: "ep_1", p_message_id: MSG(2), p_status: "complete", p_status_reason: null, p_refusal_category: null,
      p_text: "Done [r1].", p_recommendations: "- Call", p_sources: FINISH.sources, p_cards: FINISH.cards, p_tool_calls: FINISH.toolCalls,
      p_consulted: ["th_1"], p_consulted_clients: ["cl_1"], p_consulted_dd_text: true, p_usage: usage, p_model: "claude-opus-5-5", p_ref_seq: 4
    });
    expect(call.signal).toBe(signal);
    answer = false;
    expect(await finishTurn(P, FINISH, { signal })).toBe(false);
  });

  it("loop-1: a lone surrogate anywhere in the text, sources, cards or tool-call args (keys too) goes out as U+FFFD", async () => {
    useDb({ rpc: { exec_chat_finish_turn: () => true } });
    const high = String.fromCharCode(0xd83d);
    const repl = String.fromCharCode(0xfffd);
    const face = String.fromCodePoint(0x1f600);
    const input: FinishTurnInput = {
      ...FINISH,
      text: `Done ${face} ${high}`,
      recommendations: `- Call ${high}`,
      toolCalls: [{ round: 1, name: "propose_task", args: { description: `${"x".repeat(10)}${high}`, [`k${high}`]: 1 }, ok: true, error: null, ms: 12 }]
    };
    expect(await finishTurn(P, input, { signal: new AbortController().signal })).toBe(true);
    const [call] = db.on("exec_chat_finish_turn");
    const payload = call.payload as Record<string, unknown>;
    expect(payload.p_text).toBe(`Done ${face} ${repl}`);
    expect(payload.p_recommendations).toBe(`- Call ${repl}`);
    expect(payload.p_tool_calls).toEqual([{ round: 1, name: "propose_task", args: { description: `${"x".repeat(10)}${repl}`, [`k${repl}`]: 1 }, ok: true, error: null, ms: 12 }]);
    expect(payload.p_sources).toEqual(FINISH.sources);
    expect(payload.p_cards).toEqual(FINISH.cards);
  });

  it("a CHECK refusal throws ChatStoreError 23514; a non-boolean answer is malformed; no signal or a bad id is refused", async () => {
    useDb({ rpc: { exec_chat_finish_turn: () => ({ error: { code: "23514", message: 'new row for relation "exec_messages" violates check constraint "exec_messages_text_check"' } }) } });
    const err = await finishTurn(P, FINISH, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatStoreError);
    expect((err as ChatStoreError).code).toBe("23514");
    expect((err as Error).message).toContain('"exec_messages_text_check"');
    useDb({ rpc: { exec_chat_finish_turn: () => "yes" } });
    await expect(finishTurn(P, FINISH, { signal: new AbortController().signal })).rejects.toBeInstanceOf(ChatStoreError);
    await expect(finishTurn(P, FINISH, undefined as never)).rejects.toThrow(TypeError);
    await expect(finishTurn(P, { ...FINISH, messageId: "ecm_1" }, { signal: new AbortController().signal })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("loadConversation / listConversations / loadTurnByMessageId (T69)", () => {
  const SOURCE = { ref: "r2", target: { type: "email_thread", id: "th_1" }, source: { class: "private", label: "Email" } };
  const rows = () => [
    msgRow(1, { context: { kind: "attention", id: "ea_1", ref: "r1" } }),
    msgRow(2, { sources: [SOURCE, { ref: 5 }, "junk"], cards: [{ kind: "task_proposal", id: PROP(1) }, { kind: "draft", id: DRAFT(1), existing: true, privateRefKinds: ["dd_text", "nope"] }, { kind: "other", id: "x" }], consulted_email_thread_ids: ["th_1"], consulted_client_ids: ["cl_1"], consulted_dd_text: true }),
    msgRow(3),
    msgRow(4, { status: "running", text: "", finished_at: null }),
    msgRow(5, { conversation_id: `ecv_${hex(2)}` }),
    msgRow(7, { principal_id: "ep_2" })
  ];

  it("maps the conversation and its turns oldest first; the newest maxTurns, hasEarlier; his rows only", async () => {
    useDb({ tables: { exec_conversations: [convRow()], exec_messages: rows() } });
    const out = await loadConversation(P, CONV, { maxTurns: 5 });
    expect(out?.conversation).toEqual({ id: CONV, surface: "web", title: "What happened today?", refSeq: 3, turnCount: 2, createdAt: at(0), lastMessageAt: at(20) });
    expect(out?.hasEarlier).toBe(false);
    expect(out?.turns.map((t) => [t.turnId, t.user.id, t.assistant?.id])).toEqual([
      [TURN(1), MSG(1), MSG(2)],
      [TURN(2), MSG(3), MSG(4)]
    ]);
    const [t1, t2] = out?.turns ?? [];
    expect(t1.user).toEqual({
      id: MSG(1), role: "user", status: "complete", statusReason: null, text: "A question", recommendations: "",
      context: { kind: "attention", id: "ea_1", ref: "r1" }, sources: [], cards: [], consultedEmailThreadIds: [], consultedClientIds: [],
      consultedDdText: false, createdAt: at(10), finishedAt: at(10), redactedAt: null
    });
    expect(t1.assistant).toMatchObject({
      sources: [SOURCE],
      cards: [{ kind: "task_proposal", id: PROP(1) }, { kind: "draft", id: DRAFT(1), existing: true, privateRefKinds: ["dd_text"] }],
      consultedEmailThreadIds: ["th_1"], consultedClientIds: ["cl_1"], consultedDdText: true
    });
    expect(t2.assistant).toMatchObject({ status: "running", finishedAt: null });
    // Never the tool calls or usage (arguments are content), and the reads are filtered by principal.
    const reads = db.on("exec_messages");
    expect(reads[0].columns).not.toMatch(/tool_calls|usage/);
    expect(reads[0].filters).toContainEqual(["eq", "principal_id", "ep_1"]);
    expect(reads[0].orders).toEqual([{ column: "created_at", ascending: false }, { column: "id", ascending: false }]);
    expect(reads[0].limit).toBe(12);

    const one = await loadConversation(P, CONV, { maxTurns: 1 });
    expect(one?.hasEarlier).toBe(true);
    expect(one?.turns.map((t) => t.turnId)).toEqual([TURN(2)]);
  });

  it("null for a malformed id (no read), another principal's conversation or a surface mismatch; maxTurns bounds", async () => {
    useDb({ tables: { exec_conversations: [convRow()], exec_messages: rows() } });
    expect(await loadConversation(P, "ecv_1", { maxTurns: 5 })).toBeNull();
    expect(db.requests).toHaveLength(0);
    expect(await loadConversation(mint("ep_2"), CONV, { maxTurns: 5 })).toBeNull();
    expect(await loadConversation(P, CONV, { maxTurns: 5, surface: "slack" })).toBeNull();
    expect((await loadConversation(P, CONV, { maxTurns: 5, surface: "web" }))?.conversation.id).toBe(CONV);
    for (const n of [0, 401, 1.5]) await expect(loadConversation(P, CONV, { maxTurns: n })).rejects.toThrow(TypeError);
  });

  it("a read error throws ChatStoreError; a malformed row too", async () => {
    useDb({ tables: { exec_conversations: [convRow()], exec_messages: rows() }, fail: (r) => (r.target === "exec_messages" ? { message: "timeout", code: "57014" } : null) });
    await expect(loadConversation(P, CONV, { maxTurns: 5 })).rejects.toMatchObject({ name: "ChatStoreError", table: "exec_messages", code: "57014" });
    useDb({ tables: { exec_conversations: [convRow({ surface: "sms" })], exec_messages: [] } });
    await expect(loadConversation(P, CONV, { maxTurns: 5 })).rejects.toBeInstanceOf(ChatStoreError);
  });

  it("listConversations: his, of the surface, most recent first, limit 1..100", async () => {
    useDb({
      tables: {
        exec_conversations: [
          convRow(),
          convRow({ id: `ecv_${hex(2)}`, last_message_at: at(50) }),
          convRow({ id: `ecv_${hex(3)}`, surface: "slack" }),
          convRow({ id: `ecv_${hex(4)}`, principal_id: "ep_2" })
        ]
      }
    });
    const list = await listConversations(P, { surface: "web", limit: 10 });
    expect(list.map((c) => c.id)).toEqual([`ecv_${hex(2)}`, CONV]);
    expect(db.requests[0].limit).toBe(10);
    await expect(listConversations(P, { surface: "web", limit: 0 })).rejects.toThrow(TypeError);
    await expect(listConversations(P, { surface: "web", limit: 101 })).rejects.toThrow(TypeError);
  });

  it("loadTurnByMessageId: both rows of the answer's turn; null for a question's id, another principal's or a malformed id", async () => {
    useDb({ tables: { exec_messages: rows() } });
    const t = await loadTurnByMessageId(P, MSG(2));
    expect([t?.turnId, t?.user.id, t?.assistant?.id]).toEqual([TURN(1), MSG(1), MSG(2)]);
    expect(await loadTurnByMessageId(P, MSG(1))).toBeNull();
    expect(await loadTurnByMessageId(mint("ep_2"), MSG(2))).toBeNull();
    expect(await loadTurnByMessageId(P, "ecm_2")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const PROPOSAL: NewProposal = {
  conversationId: CONV, messageId: MSG(2), title: "Call the client", description: "About the renewal.", assigneeUserId: "u_austin",
  assigneeName: "Austin", departmentId: "dep_seo", dueOn: "2026-11-10", dueAt: "2026-11-10T22:00:00.000Z", clientName: "Acme",
  priority: "high", expiresAt: "2026-11-14T12:00:00.000Z"
};
const proposalRow = (n: number, over: Row = {}): Row => ({
  id: PROP(n), principal_id: "ep_1", conversation_id: CONV, message_id: MSG(2), status: "pending", title: "Call the client",
  description: "About the renewal.", assignee_user_id: "u_austin", assignee_name: "Austin", department_id: "dep_seo", due_on: "2026-11-10",
  due_at: "2026-11-10T22:00:00+00:00", client_name: "Acme", priority: "high", task_id: null, decided_at: null, redacted_at: null,
  created_at: at(n), updated_at: at(n), expires_at: "2026-11-14T12:00:00+00:00", ...over
});
const PROPOSAL_COLUMNS = Object.keys(proposalRow(0));

describe("proposals (T69)", () => {
  it("insertProposal: one row with the identical key set whatever is null; status pending; answers id and expiry", async () => {
    useDb({ tables: { exec_task_proposals: [] }, columns: { exec_task_proposals: PROPOSAL_COLUMNS } });
    const bare: NewProposal = { ...PROPOSAL, assigneeUserId: null, assigneeName: null, departmentId: null, dueOn: null, dueAt: null, clientName: null, description: "" };
    const a = await insertProposal(P, PROPOSAL);
    const b = await insertProposal(P, bare);
    expect(a.expiresAt).toBe(PROPOSAL.expiresAt);
    expect(a.id).not.toBe(b.id);
    const [ia, ib] = db.on("exec_task_proposals").filter((r) => r.kind === "insert");
    expect(Object.keys(ia.payload as Row)).toEqual(Object.keys(ib.payload as Row));
    expect(Object.keys(proposalInsertRow("ep_1", PROPOSAL))).toEqual(Object.keys(proposalInsertRow("ep_1", bare)));
    expect(ia.payload).toEqual({
      principal_id: "ep_1", conversation_id: CONV, message_id: MSG(2), status: "pending", title: "Call the client", description: "About the renewal.",
      assignee_user_id: "u_austin", assignee_name: "Austin", department_id: "dep_seo", due_on: "2026-11-10", due_at: "2026-11-10T22:00:00.000Z",
      client_name: "Acme", priority: "high", expires_at: PROPOSAL.expiresAt
    });
    await expect(insertProposal(P, { ...PROPOSAL, priority: "urgent" as never })).rejects.toThrow(TypeError);
    useDb({ fail: (r) => (r.kind === "insert" ? { code: "23514", message: 'violates check constraint "exec_task_proposals_due_check"' } : null), tables: { exec_task_proposals: [] } });
    await expect(insertProposal(P, PROPOSAL)).rejects.toMatchObject({ code: "23514", table: "exec_task_proposals" });
  });

  it("listProposalsForMessages: his, camelCase, oldest first, chunked; [] without a read for no ids", async () => {
    const many = Array.from({ length: 150 }, (_, i) => MSG(100 + i));
    useDb({ tables: { exec_task_proposals: [proposalRow(2), proposalRow(1, { message_id: MSG(149 + 100) }), proposalRow(3, { principal_id: "ep_2" }), proposalRow(4, { message_id: MSG(9) })] } });
    expect(await listProposalsForMessages(P, [])).toEqual([]);
    expect(db.requests).toHaveLength(0);
    const out = await listProposalsForMessages(P, [MSG(2), ...many]);
    expect(out.map((p) => p.id)).toEqual([PROP(1), PROP(2)]);
    expect(db.requests).toHaveLength(2);
    expect(out[1]).toEqual({
      id: PROP(2), principalId: "ep_1", conversationId: CONV, messageId: MSG(2), status: "pending", title: "Call the client",
      description: "About the renewal.", assigneeUserId: "u_austin", assigneeName: "Austin", departmentId: "dep_seo", dueOn: "2026-11-10",
      dueAt: "2026-11-10T22:00:00+00:00", clientName: "Acme", priority: "high", taskId: null, decidedAt: null, redactedAt: null,
      createdAt: at(2), updatedAt: at(2), expiresAt: "2026-11-14T12:00:00+00:00"
    });
  });

  it("getProposal: his row or null (another principal's, a malformed id)", async () => {
    useDb({ tables: { exec_task_proposals: [proposalRow(1), proposalRow(2, { principal_id: "ep_2" })] } });
    expect((await getProposal(P, PROP(1)))?.id).toBe(PROP(1));
    expect(await getProposal(P, PROP(2))).toBeNull();
    expect(await getProposal(P, "etp_1")).toBeNull();
  });

  it("casProposal: .eq status = from, the patch's columns and updated_at only; true for one row, false otherwise", async () => {
    useDb({ tables: { exec_task_proposals: [proposalRow(1)] } });
    expect(await casProposal(P, PROP(1), "pending", { status: "confirming", taskId: "task_1" })).toBe(true);
    const [u] = db.requests.filter((r) => r.kind === "update");
    expect(Object.keys(u.payload as Row).sort()).toEqual(["status", "task_id", "updated_at"]);
    expect(u.filters).toEqual([["eq", "id", PROP(1)], ["eq", "principal_id", "ep_1"], ["eq", "status", "pending"]]);
    expect(u.columns).toBe("id");
    expect(await casProposal(P, PROP(1), "pending", { status: "dismissed", decidedAt: at(1) })).toBe(false);
    expect(await casProposal(P, PROP(1), "confirming", { status: "confirmed", decidedAt: at(2) })).toBe(true);
    expect(db.tables.exec_task_proposals[0]).toMatchObject({ status: "confirmed", task_id: "task_1", decided_at: at(2) });
    expect(await casProposal(mint("ep_2"), PROP(1), "confirmed", { status: "dismissed" })).toBe(false);
    expect(await casProposal(P, "etp_1", "pending", { status: "dismissed" })).toBe(false);
    await expect(casProposal(P, PROP(1), "pending", {})).rejects.toThrow(TypeError);
    await expect(casProposal(P, PROP(1), "pending", { status: "approved" as never })).rejects.toThrow(TypeError);
  });

  it("proposalContentHash: sha256 of the seven fields in order; stable over key order and the due time's printing; any field changes it", () => {
    const fields = { title: "T", description: "D", assigneeUserId: "u_1", departmentId: "dep_1", clientName: "Acme", dueAt: "2026-11-10T22:00:00.000Z", priority: "high" as const };
    const expected = createHash("sha256").update(JSON.stringify(["T", "D", "u_1", "dep_1", "Acme", "2026-11-10T22:00:00.000Z", "high"])).digest("hex");
    expect(proposalContentHash(fields)).toBe(expected);
    const reordered = { priority: "high" as const, dueAt: "2026-11-10T22:00:00+00:00", clientName: "Acme", departmentId: "dep_1", assigneeUserId: "u_1", description: "D", title: "T" };
    expect(proposalContentHash(reordered)).toBe(expected);
    expect(proposalContentHash({ ...fields, dueAt: null })).toBe(createHash("sha256").update(JSON.stringify(["T", "D", "u_1", "dep_1", "Acme", null, "high"])).digest("hex"));
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
      const changed = { ...fields, [k]: k === "priority" ? "low" : k === "dueAt" ? "2026-11-11T22:00:00.000Z" : `${fields[k]}x` };
      expect(proposalContentHash(changed as typeof fields), k).not.toBe(expected);
    }
    // A redaction's cleared row hashes differently from the card he saw.
    expect(proposalContentHash({ ...fields, title: "[Removed]", description: "" })).not.toBe(expected);
    expect(proposalContentHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Redaction and the draft-id read
// ---------------------------------------------------------------------------

const NOT_INSTALLED = [
  { code: "42883", message: "function public.exec_chat_redact_threads(text, text[], text) does not exist" },
  { code: "PGRST202", message: "Could not find the function public.exec_chat_redact_threads in the schema cache" },
  { code: "42P01", message: 'relation "public.exec_messages" does not exist' },
  { code: "PGRST205", message: "Could not find the table 'public.exec_messages' in the schema cache" }
];

describe("redaction (T69)", () => {
  it("redactChatForThreads: deduped ids in chunks of 200 with REDACTED_TEXT; the counts add up; [] → 0 without a call", async () => {
    const calls: Row[] = [];
    useDb({ rpc: { exec_chat_redact_threads: (args) => (calls.push(args), (args.p_thread_ids as string[]).length === 50 ? 1 : 2) } });
    const ids = Array.from({ length: 450 }, (_, i) => `th_${i}`);
    expect(await redactChatForThreads(P, [...ids, "th_0", "th_1"])).toBe(5);
    expect(calls.map((c) => (c.p_thread_ids as string[]).length)).toEqual([CHAT_REDACT_CHUNK, CHAT_REDACT_CHUNK, 50]);
    expect(calls.every((c) => c.p_principal === "ep_1" && c.p_text === REDACTED_TEXT)).toBe(true);
    useDb({ rpc: { exec_chat_redact_threads: () => 9 } });
    expect(await redactChatForThreads(P, [])).toBe(0);
    expect(db.requests).toHaveLength(0);
    await expect(redactChatForThreads(P, ["th_1", ""])).rejects.toThrow(TypeError);
  });

  it("not installed (42883, PGRST202, 42P01, PGRST205) → 0; any other error throws (the caller retries); a malformed answer throws", async () => {
    for (const error of NOT_INSTALLED) {
      useDb({ rpc: { exec_chat_redact_threads: () => ({ error }) } });
      expect(await redactChatForThreads(P, ["th_1"]), error.code).toBe(0);
    }
    useDb({});
    expect(await redactChatForThreads(P, ["th_1"])).toBe(0);
    useDb({ rpc: { exec_chat_redact_threads: () => ({ error: { code: "55P03", message: "lock timeout" } }) } });
    await expect(redactChatForThreads(P, ["th_1"])).rejects.toMatchObject({ name: "ChatStoreError", code: "55P03" });
    useDb({ rpc: { exec_chat_redact_threads: () => ({ error: { code: "P0001", message: "exec_chat_redact_threads: at most 200 thread ids per call" } }) } });
    await expect(redactChatForThreads(P, ["th_1"])).rejects.toBeInstanceOf(ChatStoreError);
    useDb({ rpc: { exec_chat_redact_threads: () => "2" } });
    await expect(redactChatForThreads(P, ["th_1"])).rejects.toBeInstanceOf(ChatStoreError);
  });

  it("redactChatMessage: one message with one of the two texts; the boolean answer; not installed → false; other text refused", async () => {
    const calls: Row[] = [];
    useDb({ rpc: { exec_chat_redact_message: (args) => (calls.push(args), true) } });
    expect(await redactChatMessage(P, MSG(2), UNCHECKED_TEXT)).toBe(true);
    expect(await redactChatMessage(P, MSG(2), REDACTED_TEXT)).toBe(true);
    expect(calls).toEqual([
      { p_principal: "ep_1", p_message_id: MSG(2), p_text: UNCHECKED_TEXT },
      { p_principal: "ep_1", p_message_id: MSG(2), p_text: REDACTED_TEXT }
    ]);
    await expect(redactChatMessage(P, MSG(2), "[Removed]")).rejects.toThrow(TypeError);
    expect(await redactChatMessage(P, "ecm_2", REDACTED_TEXT)).toBe(false);
    for (const error of NOT_INSTALLED) {
      useDb({ rpc: { exec_chat_redact_message: () => ({ error }) } });
      expect(await redactChatMessage(P, MSG(2), REDACTED_TEXT)).toBe(false);
    }
    useDb({ rpc: { exec_chat_redact_message: () => ({ error: { code: "57014", message: "timeout" } }) } });
    await expect(redactChatMessage(P, MSG(2), REDACTED_TEXT)).rejects.toBeInstanceOf(ChatStoreError);
  });

  it("listRedactedSince: this conversation's answers redacted at or after the time, with whether each is the verified text", async () => {
    useDb({
      tables: {
        exec_messages: [
          msgRow(2, { redacted_at: at(100), text: REDACTED_TEXT }),
          msgRow(4, { redacted_at: at(200), text: UNCHECKED_TEXT }),
          msgRow(6, { redacted_at: at(5), text: REDACTED_TEXT }),
          msgRow(8, { redacted_at: null }),
          msgRow(10, { redacted_at: at(300), conversation_id: `ecv_${hex(2)}` })
        ]
      }
    });
    expect(await listRedactedSince(P, CONV, at(50))).toEqual([
      { id: MSG(2), verified: true },
      { id: MSG(4), verified: false }
    ]);
    const [r] = db.requests;
    expect(r.columns).toBe("id,text");
    expect(r.filters).toEqual([["eq", "conversation_id", CONV], ["eq", "principal_id", "ep_1"], ["eq", "role", "assistant"], ["gte", "redacted_at", at(50)]]);
    expect(await listRedactedSince(P, "ecv_1", at(50))).toEqual([]);
    await expect(listRedactedSince(P, CONV, "yesterday")).rejects.toThrow(TypeError);
    for (const error of NOT_INSTALLED) {
      useDb({ fail: () => error, tables: { exec_messages: [] } });
      expect(await listRedactedSince(P, CONV, at(50))).toEqual([]);
    }
    useDb({ fail: () => ({ code: "57014", message: "timeout" }), tables: { exec_messages: [] } });
    await expect(listRedactedSince(P, CONV, at(50))).rejects.toBeInstanceOf(ChatStoreError);
  });

  it("listChatDraftIdsForThreads: chunks of 200, deduped and sorted, only ed_ ids; not installed → []; other errors throw", async () => {
    const calls: Row[] = [];
    useDb({
      rpc: {
        exec_chat_draft_ids_for_threads: (args) => {
          calls.push(args);
          return (args.p_thread_ids as string[]).length === 200 ? [DRAFT(2), DRAFT(1), "ed_bad", 7] : [DRAFT(1), DRAFT(3)];
        }
      }
    });
    const ids = Array.from({ length: 250 }, (_, i) => `th_${i}`);
    expect(await listChatDraftIdsForThreads(P, ids)).toEqual([DRAFT(1), DRAFT(2), DRAFT(3)]);
    expect(calls.map((c) => [c.p_principal, (c.p_thread_ids as string[]).length])).toEqual([["ep_1", 200], ["ep_1", 50]]);
    expect(await listChatDraftIdsForThreads(P, [])).toEqual([]);
    for (const error of NOT_INSTALLED) {
      useDb({ rpc: { exec_chat_draft_ids_for_threads: () => ({ error }) } });
      expect(await listChatDraftIdsForThreads(P, ["th_1"])).toEqual([]);
    }
    useDb({ rpc: { exec_chat_draft_ids_for_threads: () => ({ error: { code: "08006", message: "connection failure" } }) } });
    await expect(listChatDraftIdsForThreads(P, ["th_1"])).rejects.toBeInstanceOf(ChatStoreError);
  });
});

// ---------------------------------------------------------------------------
// Purge (T71's store half)
// ---------------------------------------------------------------------------

describe("purgeExpiredChatRows (T71)", () => {
  it("deletes expired conversations, then expired messages (RPC 6, loop-3), then fails answers running for 10 minutes; counts each", async () => {
    useDb({
      rpc: { exec_chat_purge_expired_messages: () => 2 },
      tables: {
        exec_conversations: [convRow({ expires_at: at(-1) }), convRow({ id: `ecv_${hex(2)}`, expires_at: at(10) })],
        exec_messages: [
          msgRow(1, { expires_at: at(-5) }),
          msgRow(2, { expires_at: at(-5) }),
          msgRow(3, { expires_at: at(100) }),
          msgRow(4, { status: "running", finished_at: null, created_at: at(-601), expires_at: at(100) }),
          msgRow(6, { status: "running", finished_at: null, created_at: at(-599), expires_at: at(100), conversation_id: `ecv_${hex(3)}` })
        ]
      }
    });
    const signal = new AbortController().signal;
    expect(await purgeExpiredChatRows(NOW, { signal })).toEqual({ conversations: 1, messages: 2, staleFailed: 1 });
    expect(db.requests.map((r) => [r.kind, r.target])).toEqual([
      ["delete", "exec_conversations"],
      ["rpc", "exec_chat_purge_expired_messages"],
      ["update", "exec_messages"]
    ]);
    expect(db.requests[0].filters).toEqual([["lt", "expires_at", NOW.toISOString()]]);
    // loop-3: the carry-forward happens in the same call as the delete, with the text that hides an overflow.
    expect(db.requests[1].payload).toEqual({ p_now: NOW.toISOString(), p_text: UNCHECKED_TEXT });
    expect(db.requests[2].filters).toEqual([["eq", "status", "running"], ["lt", "created_at", at(-600)]]);
    expect(db.requests[2].payload).toEqual({ status: "failed", status_reason: "stale", finished_at: NOW.toISOString(), updated_at: NOW.toISOString() });
    expect(db.requests.every((r) => r.signal === signal)).toBe(true);
    expect(db.tables.exec_messages.find((m) => m.id === MSG(4))).toMatchObject({ status: "failed", status_reason: "stale" });
    expect(db.tables.exec_messages.find((m) => m.id === MSG(6))).toMatchObject({ status: "running" });
  });

  it("missing tables (P5b not installed) count 0; any other error throws; a bad clock is refused", async () => {
    useDb({});
    expect(await purgeExpiredChatRows(NOW)).toEqual({ conversations: 0, messages: 0, staleFailed: 0 });
    useDb({ tables: { exec_conversations: [], exec_messages: [] }, fail: (r) => (r.target === "exec_chat_purge_expired_messages" ? { code: "57014", message: "timeout" } : null) });
    await expect(purgeExpiredChatRows(NOW)).rejects.toMatchObject({ name: "ChatStoreError", table: "exec_messages" });
    useDb({ tables: { exec_conversations: [], exec_messages: [] }, rpc: { exec_chat_purge_expired_messages: () => "two" } });
    await expect(purgeExpiredChatRows(NOW)).rejects.toMatchObject({ name: "ChatStoreError" });
    await expect(purgeExpiredChatRows(new Date(Number.NaN))).rejects.toThrow(TypeError);
    const c = new AbortController();
    c.abort(new Error("lease lost"));
    await expect(purgeExpiredChatRows(NOW, { signal: c.signal })).rejects.toThrow("lease lost");
  });
});
