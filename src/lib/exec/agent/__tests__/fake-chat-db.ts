// Test support for Area C's turn tests (P5b contract §5 tests 63-68, 107, 111,
// 116, 120): an in-memory stand-in for Area A's chat-store.ts, written from the
// frozen contract (§3.3, §2.1's RPC semantics), so turn.ts is tested against
// the interface. Every call records the signal it was given (tests 64, 110).
//
// Use as
//   const db = vi.hoisted(() => ({ current: null as FakeChatDb | null }));
//   vi.mock("@/lib/exec/chat-store", async () => (await import("./__tests__/fake-chat-db")).chatStoreModule(() => db.current!));
// This file imports types only (plus node:crypto and vitest).

import { createHash } from "node:crypto";
import { vi } from "vitest";

import type { ChatCard, ChatContextInput, ChatContextKind, CitedSource, RefTarget } from "@/lib/exec/agent/types";
import type {
  BeginTurnResult,
  ChatConversationRow,
  FinishTurnInput,
  NewProposal,
  ProposalRow,
  StoredMessage,
  StoredTurn
} from "@/lib/exec/chat-store";

// The fixed redaction texts (copy.ts), repeated here so this file imports no module a test may mock.
export const FAKE_REDACTED_TEXT = "[Removed: this answer drew on mail from a sender that is now restricted.]";

export interface FakeMessage extends StoredMessage {
  conversationId: string;
  turnId: string;
  clientTurnId: string;
  finish: FinishTurnInput | null;
}

export interface FakeConversation {
  id: string;
  surface: "web" | "slack";
  title: string;
  refSeq: number;
  createdAt: string;
  lastMessageAt: string;
}

let counter = 0;
const hex = (prefix: string) => `${prefix}_${(++counter).toString(16).padStart(32, "0")}`;

function threadOf(t: RefTarget): string | null {
  if (t.type === "email_thread") return t.id;
  if (t.type === "attention" || t.type === "commitment") return t.threadId;
  return null;
}

export class FakeChatDb {
  conversations = new Map<string, FakeConversation>();
  messages: FakeMessage[] = [];
  proposals: ProposalRow[] = [];
  /** The signal each store call got, by function name (for "never the request's signal" tests). */
  signals: { fn: string; signal: AbortSignal | undefined; abortedAtCall: boolean }[] = [];
  /** fn name → error to throw on its next calls (a count of how many times). */
  failures = new Map<string, { error: unknown; times: number }>();
  /** Advances on every write so ordering is visible; tests may set it. */
  clock = Date.parse("2026-11-07T15:00:00.000Z");
  beginOutcome: BeginTurnResult | null = null;
  finishResult: boolean | null = null;

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  record(fn: string, signal: AbortSignal | undefined): void {
    this.signals.push({ fn, signal, abortedAtCall: signal?.aborted === true });
    const f = this.failures.get(fn);
    if (f && f.times > 0) {
      f.times -= 1;
      throw f.error;
    }
  }

  fail(fn: string, error: unknown = new Error(`${fn} failed`), times = 1): void {
    this.failures.set(fn, { error, times });
  }

  /** Adds a finished turn (for history). */
  seedTurn(conversationId: string, user: Partial<StoredMessage> & { text: string }, assistant: Partial<StoredMessage> & { status: StoredMessage["status"] }): StoredTurn {
    const conv = this.conversations.get(conversationId) ?? this.addConversation({ id: conversationId });
    const turnId = hex("ect");
    const u: FakeMessage = this.blank(conversationId, turnId, "user", { status: "complete", finishedAt: this.tick(), createdAt: this.tick(), ...user });
    const a: FakeMessage = this.blank(conversationId, turnId, "assistant", { createdAt: this.tick(), finishedAt: assistant.status === "running" ? null : this.tick(), ...assistant });
    this.messages.push(u, a);
    conv.lastMessageAt = a.createdAt;
    return { turnId, user: u, assistant: a };
  }

  addConversation(over: Partial<FakeConversation> = {}): FakeConversation {
    const c: FakeConversation = { id: hex("ecv"), surface: "web", title: "A title", refSeq: 0, createdAt: this.tick(), lastMessageAt: this.tick(), ...over };
    this.conversations.set(c.id, c);
    return c;
  }

  private blank(conversationId: string, turnId: string, role: "user" | "assistant", over: Partial<StoredMessage>): FakeMessage {
    return {
      id: hex("ecm"), role, status: "complete", statusReason: null, text: "", recommendations: "", context: null, sources: [], cards: [],
      consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, createdAt: this.tick(), finishedAt: null, redactedAt: null,
      conversationId, turnId, clientTurnId: `ctid-${turnId}`, finish: null, ...over
    };
  }

  turnsOf(conversationId: string): StoredTurn[] {
    const rows = this.messages.filter((m) => m.conversationId === conversationId);
    const turns: StoredTurn[] = [];
    for (const u of rows.filter((m) => m.role === "user")) {
      const a = rows.find((m) => m.role === "assistant" && m.turnId === u.turnId) ?? null;
      turns.push({ turnId: u.turnId, user: { ...u }, assistant: a ? { ...a } : null });
    }
    return turns;
  }

  message(id: string): FakeMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  // ----- the chat-store surface -----

  async beginTurn(input: {
    conversationId: string | null; clientTurnId: string; surface: "web" | "slack"; text: string; context: ChatContextInput | null; title: string;
  }, signal?: AbortSignal): Promise<BeginTurnResult> {
    this.record("beginTurn", signal);
    if (this.beginOutcome) return this.beginOutcome;
    let conv: FakeConversation | undefined;
    if (input.conversationId === null) {
      conv = [...this.conversations.values()].find((c) => this.messages.some((m) => m.conversationId === c.id && m.clientTurnId === input.clientTurnId));
      conv ??= this.addConversation({ surface: input.surface, title: input.title });
    } else {
      conv = this.conversations.get(input.conversationId);
      if (!conv || conv.surface !== input.surface) return { outcome: "not_found" };
    }
    const same = this.messages.find((m) => m.conversationId === conv!.id && m.clientTurnId === input.clientTurnId && m.role === "assistant");
    if (same) return same.status === "running" ? { outcome: "busy", conversationId: conv.id } : { outcome: "replay", conversationId: conv.id, turnId: same.turnId, assistantMessageId: same.id };
    if (this.messages.some((m) => m.conversationId === conv!.id && m.status === "running")) return { outcome: "busy", conversationId: conv.id };
    const turnId = hex("ect");
    let contextRef: string | null = null;
    if (input.context) {
      conv.refSeq += 1;
      contextRef = `r${conv.refSeq}`;
    }
    const u = this.blank(conv.id, turnId, "user", {
      status: "complete", text: input.text, createdAt: this.tick(), finishedAt: null,
      context: input.context ? { kind: input.context.kind as ChatContextKind, id: input.context.id, ref: contextRef as string } : null
    });
    u.clientTurnId = input.clientTurnId;
    const a = this.blank(conv.id, turnId, "assistant", { status: "running", createdAt: this.tick() });
    a.clientTurnId = input.clientTurnId;
    this.messages.push(u, a);
    return {
      outcome: "started", conversationId: conv.id, created: input.conversationId === null, turnId, userMessageId: u.id,
      userCreatedAt: u.createdAt, assistantMessageId: a.id, refSeq: conv.refSeq, contextRef
    };
  }

  async finishTurn(input: FinishTurnInput, signal: AbortSignal): Promise<boolean> {
    this.record("finishTurn", signal);
    if (this.finishResult !== null) return this.finishResult;
    const m = this.message(input.messageId);
    if (!m || m.status !== "running") return false;
    Object.assign(m, {
      status: input.status, statusReason: input.statusReason, text: input.text, recommendations: input.recommendations, sources: input.sources,
      cards: input.cards, consultedEmailThreadIds: input.consultedEmailThreadIds, consultedClientIds: input.consultedClientIds,
      consultedDdText: input.consultedDdText, finishedAt: this.tick(), finish: input
    });
    const conv = this.conversations.get(m.conversationId);
    if (conv) conv.refSeq = Math.max(conv.refSeq, input.refSeq);
    return true;
  }

  async loadConversation(conversationId: string, maxTurns: number, signal?: AbortSignal) {
    this.record("loadConversation", signal);
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    const turns = this.turnsOf(conversationId);
    const kept = turns.slice(Math.max(0, turns.length - maxTurns));
    const row: ChatConversationRow = { id: conv.id, surface: conv.surface, title: conv.title, refSeq: conv.refSeq, turnCount: turns.length, createdAt: conv.createdAt, lastMessageAt: conv.lastMessageAt };
    return { conversation: row, turns: kept, hasEarlier: kept.length < turns.length };
  }

  async loadTurnByMessageId(id: string, signal?: AbortSignal): Promise<StoredTurn | null> {
    this.record("loadTurnByMessageId", signal);
    const a = this.message(id);
    if (!a || a.role !== "assistant") return null;
    return this.turnsOf(a.conversationId).find((t) => t.turnId === a.turnId) ?? null;
  }

  /** The B7/C19 predicate: consulted overlap or a cited thread, then every later answer of the conversation. */
  private reached(threadIds: readonly string[]): FakeMessage[] {
    const ids = new Set(threadIds);
    const hit = this.messages.filter(
      (m) => m.role === "assistant" && m.status !== "running" &&
        (m.consultedEmailThreadIds.some((t) => ids.has(t)) || m.sources.some((s: CitedSource) => { const t = threadOf(s.target); return t !== null && ids.has(t); }))
    );
    const out = new Set(hit);
    for (const h of hit) {
      for (const m of this.messages) {
        if (m.role === "assistant" && m.status !== "running" && m.conversationId === h.conversationId && m.createdAt >= h.createdAt) out.add(m);
      }
    }
    return [...out];
  }

  private redact(m: FakeMessage, text: string): void {
    m.text = text;
    m.recommendations = "";
    m.sources = [];
    m.redactedAt = this.tick();
    for (const p of this.proposals) {
      if (p.messageId !== m.id) continue;
      if (p.status === "pending") p.status = "withdrawn";
      p.title = "[Removed]";
      p.description = "";
      p.redactedAt = m.redactedAt;
    }
  }

  async redactChatForThreads(threadIds: readonly string[], signal?: AbortSignal): Promise<number> {
    this.record("redactChatForThreads", signal);
    const hit = this.reached(threadIds);
    for (const m of hit) this.redact(m, FAKE_REDACTED_TEXT);
    return hit.length;
  }

  async redactChatMessage(id: string, text: string, signal?: AbortSignal): Promise<boolean> {
    this.record("redactChatMessage", signal);
    const m = this.message(id);
    if (!m || m.role !== "assistant" || m.status === "running") return false;
    // An earlier REDACTED_TEXT is never replaced by the unchecked one.
    this.redact(m, m.text === FAKE_REDACTED_TEXT ? FAKE_REDACTED_TEXT : text);
    return true;
  }

  async listRedactedSince(conversationId: string, sinceIso: string, signal?: AbortSignal): Promise<{ id: string; verified: boolean }[]> {
    this.record("listRedactedSince", signal);
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.role === "assistant" && m.redactedAt !== null && m.redactedAt >= sinceIso)
      .map((m) => ({ id: m.id, verified: m.text === FAKE_REDACTED_TEXT }));
  }

  async listChatDraftIdsForThreads(threadIds: readonly string[], signal?: AbortSignal): Promise<string[]> {
    this.record("listChatDraftIdsForThreads", signal);
    const out = new Set<string>();
    for (const m of this.reached(threadIds)) for (const c of m.cards as ChatCard[]) if (c.kind === "draft") out.add(c.id);
    return [...out].sort();
  }

  async listProposalsForMessages(ids: readonly string[], signal?: AbortSignal): Promise<ProposalRow[]> {
    this.record("listProposalsForMessages", signal);
    return this.proposals.filter((p) => ids.includes(p.messageId)).map((p) => ({ ...p }));
  }

  addProposal(p: NewProposal & { id?: string; status?: ProposalRow["status"] }): ProposalRow {
    const now = this.tick();
    const row: ProposalRow = {
      id: p.id ?? hex("etp"), principalId: "ep_owner", conversationId: p.conversationId, messageId: p.messageId, status: p.status ?? "pending",
      title: p.title, description: p.description, assigneeUserId: p.assigneeUserId, assigneeName: p.assigneeName, departmentId: p.departmentId,
      dueOn: p.dueOn, dueAt: p.dueAt, clientName: p.clientName, priority: p.priority, taskId: null, decidedAt: null, redactedAt: null,
      createdAt: now, updatedAt: now, expiresAt: p.expiresAt
    };
    this.proposals.push(row);
    return row;
  }
}

/** §3.3's proposalContentHash, as the contract defines it. */
export function fakeProposalContentHash(row: Pick<ProposalRow, "title" | "description" | "assigneeUserId" | "departmentId" | "clientName" | "dueAt" | "priority">): string {
  return createHash("sha256")
    .update(JSON.stringify([row.title, row.description, row.assigneeUserId, row.departmentId, row.clientName, row.dueAt, row.priority]))
    .digest("hex");
}

/** A vi.mock factory body for @/lib/exec/chat-store over the db the getter returns. */
export function chatStoreModule(db: () => FakeChatDb) {
  class ChatStoreError extends Error {
    readonly table: string;
    constructor(table: string, message: string) {
      super(message);
      this.table = table;
    }
  }
  type Opts = { signal?: AbortSignal } | undefined;
  return {
    ChatStoreError,
    beginTurn: vi.fn((_p: unknown, input: Parameters<FakeChatDb["beginTurn"]>[0], opts?: Opts) => db().beginTurn(input, opts?.signal)),
    finishTurn: vi.fn((_p: unknown, input: FinishTurnInput, opts: { signal: AbortSignal }) => db().finishTurn(input, opts.signal)),
    loadConversation: vi.fn((_p: unknown, id: string, opts: { maxTurns: number; signal?: AbortSignal }) => db().loadConversation(id, opts.maxTurns, opts.signal)),
    loadTurnByMessageId: vi.fn((_p: unknown, id: string, opts?: Opts) => db().loadTurnByMessageId(id, opts?.signal)),
    listConversations: vi.fn(async () => []),
    insertProposal: vi.fn(),
    getProposal: vi.fn(),
    casProposal: vi.fn(),
    listProposalsForMessages: vi.fn((_p: unknown, ids: readonly string[], opts?: Opts) => db().listProposalsForMessages(ids, opts?.signal)),
    proposalContentHash: vi.fn(fakeProposalContentHash),
    redactChatForThreads: vi.fn((_p: unknown, ids: readonly string[], opts?: Opts) => db().redactChatForThreads(ids, opts?.signal)),
    redactChatMessage: vi.fn((_p: unknown, id: string, text: string, opts?: Opts) => db().redactChatMessage(id, text, opts?.signal)),
    listRedactedSince: vi.fn((_p: unknown, conv: string, since: string, opts?: Opts) => db().listRedactedSince(conv, since, opts?.signal)),
    listChatDraftIdsForThreads: vi.fn((_p: unknown, ids: readonly string[], opts?: Opts) => db().listChatDraftIdsForThreads(ids, opts?.signal)),
    purgeExpiredChatRows: vi.fn(async () => ({ conversations: 0, messages: 0, staleFailed: 0 }))
  };
}
