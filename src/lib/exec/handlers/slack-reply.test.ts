import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// P5b's turn at its module boundary (contract §4): the job's own logic is what is under test.
vi.mock("@/lib/exec/agent/turn", () => ({
  prepareChatTurn: vi.fn(),
  runPreparedTurn: vi.fn(),
  newConversationTitle: vi.fn((q: string) => String(q).replace(/\s+/g, " ").trim().slice(0, 80)),
  storedTurnPayload: vi.fn(),
  proposalViewFor: vi.fn()
}));
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn() }));
// postCards re-reads each proposal card (fixer security-3); unset, it answers undefined and the turn's own view is posted.
vi.mock("@/lib/exec/proposals", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/proposals")>()), getProposalView: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { prepareChatTurn, runPreparedTurn, type PreparedTurn } from "@/lib/exec/agent/turn";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { CHAT_PAUSED_TEXT, FAILED_TEXT, REFUSED_TEXT } from "@/lib/exec/chat/copy";
import type { ChatDonePayload } from "@/lib/exec/chat/view-types";
import { sealSecret } from "@/lib/exec/crypto";
import { getDraftView } from "@/lib/exec/drafts";
import { slackReplyJobHandler } from "@/lib/exec/handlers/slack-reply";
import { notifyOps } from "@/lib/exec/ops";
import { getProposalView } from "@/lib/exec/proposals";
import { loadSettings } from "@/lib/exec/principal";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { renderNote, renderPlaceholder } from "@/lib/exec/slack-ui";
import { AuditUnavailableError, type ExecSettings } from "@/lib/exec/types";

import { done as chatDone, proposal } from "../__tests__/chat-ui-fixtures";
import { draftView } from "../__tests__/drafts-ui-fixtures";
import type { FakeSlackDbSeed } from "../__tests__/fake-slack-db";
import { assertSlackParts, findSentinel, ROUTING_INSTALLATION as RI, SENTINELS } from "../__tests__/slack-assert";
import {
  CONV,
  DRAFT,
  EVENT_ID,
  INST,
  KEY,
  MSG,
  PRINCIPAL,
  PROPOSAL,
  SETTINGS,
  TURN,
  buttonsOf,
  callsOf,
  inOrder,
  installationRow,
  jobCtx,
  partsOfCall,
  replyEventRow,
  slackError,
  textOf,
  useSlack,
  useSlackDb,
  type Harness,
  type SlackHandlers
} from "../__tests__/slack-jobs-harness";

// P6 contract §5.7 (K9, K18): RP01-RP27 (incl. RP02b) and the job half of SR01, against the REAL slack-dm.ts,
// slack-install.ts (fake-slack-db.ts), sources/slack.ts (fake-slack-api.ts) and slack-ui.ts.

const NOW_MS = Date.parse("2026-11-06T15:00:30.000Z"); // epoch 1793977230
const NOW_SEC = Math.floor(NOW_MS / 1000);
const TS = "1793977201.000100"; // 29 s before NOW
const ROOT = "1793977100.000200";
const ASSISTANT = MSG(2);

let h: Harness;
let spies: ReturnType<typeof vi.spyOn>[];

const note = (key: keyof typeof SLACK_COPY.notes) => textOf(renderNote(key));
const payload = (over: Record<string, unknown> = {}) => ({ event_id: EVENT_ID, installation_id: INST, channel: RI.dmChannelId, ts: TS, thread_ts: null, event_time: NOW_SEC - 2, ...over });
const eventRow = () => h.db.tables.exec_slack_events.find((e) => e.event_id === EVENT_ID);
const message = (over: Record<string, unknown> = {}) => ({ ts: TS, user: RI.userId, text: SENTINELS.text, type: "message", ...over });

function started(conversationId: string): Extract<PreparedTurn, { kind: "started" }> {
  return {
    kind: "started",
    begin: {
      outcome: "started", conversationId, created: false, turnId: TURN(1), userMessageId: MSG(1), userCreatedAt: new Date(NOW_MS).toISOString(),
      assistantMessageId: ASSISTANT, refSeq: 0, contextRef: null
    },
    context: null
  };
}
const turnDone = (over: Partial<ChatDonePayload> = {}): ChatDonePayload =>
  chatDone({ messageId: ASSISTANT, conversationId: CONV(1), turnId: TURN(1), answer: "Two tasks are overdue [r1].", ...over });
const AUDIT = { status: "complete", statusReason: null, modelCalls: 2, toolCalls: 1, costUsd: 0.05 };

/** The prepared turn and its run, as the fake P5b turn answers by default; each call is logged. */
function fakeTurn(opts: { prepared?: PreparedTurn | ((conversationId: string) => PreparedTurn); done?: ChatDonePayload; run?: (signal: AbortSignal) => Promise<ChatDonePayload> } = {}) {
  vi.mocked(prepareChatTurn).mockImplementation(async (_p, _s, req) => {
    h.order.push("prepare");
    const p = opts.prepared;
    return typeof p === "function" ? p(String(req.conversationId)) : (p ?? started(String(req.conversationId)));
  });
  vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, o) => {
    h.order.push(o.signal.aborted ? "run:aborted" : "run");
    if (o.signal.aborted) return { done: turnDone({ status: "aborted", statusReason: "client_abort", answer: "" }), audit: { ...AUDIT, status: "aborted", modelCalls: 0 } };
    const done = opts.run ? await opts.run(o.signal) : (opts.done ?? turnDone());
    return { done, audit: { ...AUDIT, status: done.status } };
  });
}

async function run(over: Record<string, unknown> = {}, ctxOver: Parameters<typeof jobCtx>[2] = {}) {
  return slackReplyJobHandler.run(jobCtx("exec.slack-reply", payload(over), ctxOver));
}

function setup(opts: { event?: Record<string, unknown>; slack?: SlackHandlers; msg?: Record<string, unknown> | null; settings?: Partial<ExecSettings> } = {}) {
  h = useSlackDb({ tables: { exec_slack_installations: [installationRow()], exec_slack_events: [replyEventRow({ message_ts: TS, ...opts.event })] } });
  const slack = useSlack(opts.slack ?? {}, opts.msg === undefined ? message() : opts.msg);
  vi.mocked(loadSettings).mockImplementation(async () => {
    h.order.push("loadSettings");
    return { ...SETTINGS, ...opts.settings };
  });
  return slack;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  vi.mocked(auditStart).mockReset();
  vi.mocked(auditStart).mockImplementation(async () => {
    h.order.push("auditStart");
    return 77;
  });
  vi.mocked(auditFinish).mockReset();
  vi.mocked(auditFinish).mockImplementation(async () => {
    h.order.push("auditFinish");
  });
  vi.mocked(getDraftView).mockReset();
  vi.mocked(notifyOps).mockReset();
  vi.mocked(prepareChatTurn).mockReset();
  vi.mocked(runPreparedTurn).mockReset();
  spies = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {})
  ];
  fakeTurn();
});

afterEach(() => {
  // RP18 everywhere: nothing a log line, an ops alert or an audit row carries holds his text, the token or his email.
  expect(findSentinel([spies.map((s) => s.mock.calls), vi.mocked(notifyOps).mock.calls, vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls])).toBeNull();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("exec.slack-reply: the fixer's cards and ledger (RP28, RP29)", () => {
  it("RP28 (fixer security-3): a proposal card is posted from the proposal as it is now: redacted since the turn → removed, no title, no buttons; a failed re-read → the turn's view", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    const fromTurn = proposal({ id: PROPOSAL(1), title: "Call Dana about the vendor invoices" });
    fakeTurn({ done: turnDone({ cards: [{ kind: "task_proposal", proposal: fromTurn }] }) });
    vi.mocked(getProposalView).mockReset();
    vi.mocked(getProposalView).mockResolvedValue(proposal({ id: PROPOSAL(1), status: "withdrawn", redacted: true, title: "[Removed]", description: "" }));
    let slack = setup();
    expect(await run()).toEqual({ status: "complete", cards: 1, cardsFailed: 0 });
    expect(vi.mocked(getProposalView).mock.calls[0].slice(0, 2)).toEqual([PRINCIPAL, PROPOSAL(1)]);
    let card = partsOfCall(callsOf(slack.calls, "chat.postMessage")[1]);
    expect(textOf(card)).toContain(SLACK_COPY.proposalStatus.removed);
    expect(textOf(card)).not.toContain("Call Dana");
    expect(buttonsOf(card)).toEqual([]);
    slack.restore();

    vi.mocked(getProposalView).mockRejectedValue(new Error("read failed"));
    fakeTurn({ done: turnDone({ cards: [{ kind: "task_proposal", proposal: fromTurn }] }) });
    slack = setup();
    expect(await run()).toEqual({ status: "complete", cards: 1, cardsFailed: 0 });
    card = partsOfCall(callsOf(slack.calls, "chat.postMessage")[1]);
    expect(textOf(card)).toContain("Call Dana");
    expect(buttonsOf(card)).toEqual(["ea_task_create", "ea_task_dismiss"]);
  });

  it("RP29 (fixer security-4): the placeholder's own ledger write failing still leaves the answer post in the ledger (RPC 6 writes it with the transition)", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    fakeTurn();
    h = useSlackDb({
      tables: {
        exec_slack_installations: [installationRow()],
        exec_slack_events: [replyEventRow({ message_ts: TS })],
        exec_messages: [{ id: ASSISTANT, principal_id: PRINCIPAL.id, conversation_id: CONV(1), role: "assistant", status: "running", slack_ts: null }]
      },
      fail: (c) => (c.kind === "insert" && c.target === "exec_slack_posts" ? { code: "08006", message: "connection lost" } : null)
    });
    const slack = useSlack({}, message());
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    expect(await run()).toMatchObject({ status: "complete" });
    const placeholderTs = String(callsOf(slack.calls, "chat.update")[0].body.ts);
    expect(h.db.tables.exec_slack_posts.map((r) => [r.ts, r.kind, r.message_id, r.thread_ts])).toEqual([[placeholderTs, "answer", ASSISTANT, TS]]);
    expect(spies[0].mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([expect.stringContaining("ledger row not written")]);
  });
});

describe("exec.slack-reply: the happy path (RP01, RP16, RP17, RP27)", () => {
  it("RP01: claims, logs access, re-reads, checks settings, audits, gets the thread, prepares, stores the placeholder ts BEFORE the turn, answers, closes, then cards", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    fakeTurn({ done: turnDone({ cards: [{ kind: "task_proposal", proposal: proposal({ id: PROPOSAL(1) }) }] }) });
    const slack = setup();
    const out = await run();
    expect(out).toEqual({ status: "complete", cards: 1, cardsFailed: 0 });
    expect(
      inOrder(h.order, [
        "rpc:reply_step:started",
        "db:insert:exec_access_log",
        "slack:conversations.history",
        "loadSettings",
        "auditStart",
        "db:rpc:exec_slack_conversation_for_thread",
        "prepare",
        "slack:chat.postMessage",
        "rpc:reply_step:placeholder",
        "run",
        "slack:chat.update",
        "rpc:reply_step:answered",
        "slack:chat.postMessage",
        "auditFinish"
      ])
    ).toBe(true);
    // M17: the placeholder ts is on the event row before the model call.
    expect(h.order.indexOf("rpc:reply_step:placeholder")).toBeLessThan(h.order.indexOf("run"));
    // prepareChatTurn(surface "slack", clientTurnId "slk_<ts>") with the thread's conversation.
    const req = vi.mocked(prepareChatTurn).mock.calls[0][2];
    const conv = h.db.tables.exec_conversations[0];
    expect(req).toEqual({ conversationId: conv.id, clientTurnId: "slk_1793977201_000100", surface: "slack", text: SENTINELS.text, context: null });
    expect(vi.mocked(prepareChatTurn).mock.calls[0][4]).toEqual({ timeoutMs: 10_000 });
    expect(conv).toMatchObject({ surface: "slack", slack_channel_id: RI.dmChannelId, slack_thread_ts: TS, create_client_turn_id: "slkc_D0MITCH_1793977201_000100" });
    // The access log row (C40): surface slack, his Slack id and the event id, no session.
    expect(h.db.tables.exec_access_log).toEqual([
      expect.objectContaining({ principal_id: "ep_1", route: "slack:message.im", surface: "slack", slack_user_id: RI.userId, slack_event_id: EVENT_ID, auth_user_id: null, session_id: null })
    ]);
    // The audit row: actor slack, chat.turn, ids and counts only.
    expect(vi.mocked(auditStart).mock.calls[0][1]).toEqual({ actor: "slack", action: "chat.turn", target: `exec_slack_events:${EVENT_ID}`, input: { surface: "slack", textChars: SENTINELS.text.length } });
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: true, result: { status: "complete", statusReason: null, modelCalls: 2, toolCalls: 1, costUsd: 0.05, cards: 1 } }]]);
    // The event row ends answered with the placeholder ts and the refs (K9).
    const placeholderTs = String(callsOf(slack.calls, "chat.update")[0].body.ts);
    expect(eventRow()).toMatchObject({ reply_state: "answered", placeholder_ts: placeholderTs, conversation_id: conv.id, assistant_message_id: ASSISTANT });
    // Every post is in his DM, in the thread of his message, and passes the Block Kit rules.
    const posts = callsOf(slack.calls, "chat.postMessage");
    expect(posts.map((c) => [c.body.channel, c.body.thread_ts, c.body.unfurl_links, c.body.unfurl_media])).toEqual([
      [RI.dmChannelId, TS, false, false],
      [RI.dmChannelId, TS, false, false]
    ]);
    expect(textOf(partsOfCall(posts[0]))).toBe(textOf(renderPlaceholder()));
    for (const c of [...posts, ...callsOf(slack.calls, "chat.update")]) assertSlackParts(partsOfCall(c));
    expect(textOf(partsOfCall(callsOf(slack.calls, "chat.update")[0]))).toContain("Two tasks are overdue");
    // The ledger (C43): the answer post with its message id, the card with its ref.
    const cardTs = h.db.tables.exec_slack_posts[1]?.ts;
    expect(cardTs).not.toBe(placeholderTs);
    expect(h.db.tables.exec_slack_posts.map((r) => [r.ts, r.kind, r.message_id, r.ref_id, r.thread_ts])).toEqual([
      [placeholderTs, "answer", ASSISTANT, null, TS],
      [cardTs, "proposal", ASSISTANT, PROPOSAL(1), TS]
    ]);
  });

  it("RP16: a top-level message is its own thread root; a thread reply uses thread_ts as the root and posts there", async () => {
    let slack = setup();
    await run();
    expect(h.db.tables.exec_conversations[0].slack_thread_ts).toBe(TS);
    expect(callsOf(slack.calls, "chat.postMessage")[0].body.thread_ts).toBe(TS);
    expect(callsOf(slack.calls, "conversations.history")).toHaveLength(1);

    vi.mocked(prepareChatTurn).mockClear();
    slack.restore();
    slack = setup({ event: { thread_ts: ROOT } });
    await run({ thread_ts: ROOT });
    expect(h.db.tables.exec_conversations[0].slack_thread_ts).toBe(ROOT);
    expect(vi.mocked(prepareChatTurn).mock.calls[0][2].clientTurnId).toBe("slk_1793977201_000100");
    expect(callsOf(slack.calls, "conversations.replies")[0].body).toMatchObject({ channel: RI.dmChannelId, ts: ROOT, oldest: TS, latest: TS });
    expect(callsOf(slack.calls, "chat.postMessage")[0].body.thread_ts).toBe(ROOT);
  });

  it("RP17: a generating draft card and a proposal card → two thread posts in the ledger, and three refreshes at +20/+60/+180 s keyed by this job", async () => {
    const draftId = DRAFT(1);
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: draftId, status: "generating", capabilities: { canRegenerate: false } }));
    fakeTurn({
      done: turnDone({
        cards: [
          { kind: "draft", draftId, href: `/executive/email/drafts/${draftId}`, existing: false, privateRefKinds: [] },
          { kind: "task_proposal", proposal: proposal({ id: PROPOSAL(1) }) }
        ]
      })
    });
    const slack = setup();
    const ctx = jobCtx("exec.slack-reply", payload(), { id: 4242 });
    expect(await slackReplyJobHandler.run(ctx)).toEqual({ status: "complete", cards: 2, cardsFailed: 0 });
    const posts = callsOf(slack.calls, "chat.postMessage");
    expect(posts).toHaveLength(3);
    const draftTs = h.db.tables.exec_slack_posts.find((r) => r.kind === "draft")?.ts as string;
    expect(h.db.tables.exec_slack_posts.filter((r) => r.kind !== "answer").map((r) => [r.kind, r.message_id, r.ref_id])).toEqual([
      ["draft", ASSISTANT, draftId],
      ["proposal", ASSISTANT, PROPOSAL(1)]
    ]);
    const cardJobs = h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-card");
    expect(cardJobs.map((j) => [j.dedupe_key, Date.parse(String(j.run_after)) - NOW_MS, j.max_attempts, j.lane])).toEqual([
      [`slack-card:${draftTs}:4242:0`, 20_000, 1, "interactive"],
      [`slack-card:${draftTs}:4242:1`, 60_000, 1, "interactive"],
      [`slack-card:${draftTs}:4242:2`, 180_000, 1, "interactive"]
    ]);
    expect(cardJobs[0].payload).toEqual({ installation_id: INST, kind: "draft", id: draftId, channel_id: RI.dmChannelId, message_ts: draftTs, sched: "4242", i: 0 });
    for (const c of posts) assertSlackParts(partsOfCall(c));
  });

  it("RP27: the answer CAS runs before the cards; a card that fails to post leaves the reply answered with no failed note", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    fakeTurn({ done: turnDone({ cards: [{ kind: "task_proposal", proposal: proposal({ id: PROPOSAL(1) }) }] }) });
    let posts = 0;
    const slack = setup({ slack: { "chat.postMessage": () => (++posts === 1 ? { ok: true, channel: RI.dmChannelId, ts: "1793977300.000001" } : { ok: false, error: "internal_error" }) } });
    expect(await run()).toEqual({ status: "complete", cards: 0, cardsFailed: 1 });
    expect(h.order.indexOf("rpc:reply_step:answered")).toBeLessThan(h.order.lastIndexOf("slack:chat.postMessage"));
    expect(eventRow()?.reply_state).toBe("answered");
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).not.toContain(note("failed"));
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(1);
  });
});

describe("exec.slack-reply: the stale guard (RP02, RP02b)", () => {
  it("RP02: event_time 16 minutes old → the late note in the thread and no turn; 14 minutes → answered", async () => {
    let slack = setup();
    expect(await run({ event_time: NOW_SEC - 16 * 60 })).toEqual({ late: true });
    expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => [c.body.thread_ts, textOf(partsOfCall(c))])).toEqual([[TS, note("late")]]);
    expect(eventRow()?.reply_state).toBe("skipped");
    expect(h.db.tables.exec_slack_posts.map((r) => r.kind)).toEqual(["note"]);
    slack.restore();

    slack = setup();
    expect(await run({ event_time: NOW_SEC - 14 * 60 })).toMatchObject({ status: "complete" });
    expect(eventRow()?.reply_state).toBe("answered");
  });

  it("RP02b: a fresh event_time but a message ts 16 minutes old is late too; both fresh is answered", async () => {
    const oldTs = `${NOW_SEC - 16 * 60}.000100`;
    let slack = setup({ event: { message_ts: oldTs }, msg: message({ ts: oldTs }) });
    expect(await run({ ts: oldTs, event_time: NOW_SEC - 1 })).toEqual({ late: true });
    expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("late")]);
    slack.restore();

    slack = setup();
    expect(await run({ event_time: NOW_SEC - 1 })).toMatchObject({ status: "complete" });
  });
});

describe("exec.slack-reply: refusals before the turn (RP03-RP05, RP10-RP14, RP19-RP21)", () => {
  it("RP03: rate_limited (130 s) → 'Try again in 3 min.' and no placeholder", async () => {
    fakeTurn({ prepared: { kind: "rate_limited", retryAfterSeconds: 130 } });
    const slack = setup();
    expect(await run()).toEqual({ skipped: "rate_limited" });
    const posts = callsOf(slack.calls, "chat.postMessage");
    expect(posts.map((c) => textOf(partsOfCall(c)))).toEqual([SLACK_COPY.notes.rateLimited.replace("{minutes}", "3")]);
    expect(textOf(partsOfCall(posts[0]))).toContain("Try again in 3 min.");
    expect(vi.mocked(runPreparedTurn)).not.toHaveBeenCalled();
    expect(eventRow()?.reply_state).toBe("skipped");
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, result: { outcome: "rate_limited" } }]]);
  });

  it("SR01: the shared limit is the begin's own count across web and Slack: the 31st question in 10 minutes is refused on Slack", async () => {
    // A fake begin that counts user rows of both surfaces in the window, as P5b's RPC does (SQL SR02 runs it for real).
    const window: { surface: string; at: number }[] = Array.from({ length: 29 }, (_, i) => ({ surface: "web", at: NOW_MS - i * 1000 }));
    const begin = (conversationId: string): PreparedTurn => {
      const recent = window.filter((r) => NOW_MS - r.at < 600_000).length;
      if (recent >= 30) return { kind: "rate_limited", retryAfterSeconds: 61 };
      window.push({ surface: "slack", at: NOW_MS });
      return started(conversationId);
    };
    fakeTurn({ prepared: begin });
    let slack = setup();
    expect(await run()).toMatchObject({ status: "complete" }); // the 30th
    slack.restore();
    slack = setup();
    expect(await run()).toEqual({ skipped: "rate_limited" }); // the 31st
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([SLACK_COPY.notes.rateLimited.replace("{minutes}", "2")]);
    expect(window.map((r) => r.surface).filter((s) => s === "slack")).toHaveLength(1);
  });

  it("RP04: chat off, or the P5b schema not ready → the chatOff note, no turn", async () => {
    for (const settings of [{ chatEnabled: false }, { chatSchemaReady: false }]) {
      const slack = setup({ settings });
      expect(await run()).toEqual({ skipped: "chat_off" });
      expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("chatOff")]);
      expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
      expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
      expect(eventRow()?.reply_state).toBe("skipped");
      slack.restore();
    }
  });

  it("RP05: busy → busyThread; busy_principal → busyPrincipal", async () => {
    for (const [prepared, key] of [[{ kind: "busy" }, "busyThread"], [{ kind: "busy_principal" }, "busyPrincipal"]] as const) {
      fakeTurn({ prepared: prepared as PreparedTurn });
      const slack = setup();
      expect(await run()).toEqual({ skipped: prepared.kind });
      expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note(key)]);
      expect(vi.mocked(runPreparedTurn)).not.toHaveBeenCalled();
      expect(eventRow()?.reply_state).toBe("skipped");
      slack.restore();
    }
  });

  it("not_found / context_unavailable from the begin → the failed note, state failed, audit closed not ok", async () => {
    for (const prepared of [{ kind: "not_found" }, { kind: "context_unavailable", reason: "gone" }] as const) {
      vi.mocked(auditFinish).mockClear();
      fakeTurn({ prepared: prepared as PreparedTurn });
      const slack = setup();
      expect(await run()).toEqual({ skipped: prepared.kind });
      expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("failed")]);
      expect(eventRow()?.reply_state).toBe("failed");
      expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, result: { outcome: prepared.kind } }]]);
      slack.restore();
    }
  });

  it("RP10: a replay → nothing posted, state skipped, the audit closed ok", async () => {
    fakeTurn({ prepared: { kind: "replay" } as unknown as PreparedTurn });
    const slack = setup();
    expect(await run()).toEqual({ skipped: "replay" });
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(0);
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(0);
    expect(eventRow()?.reply_state).toBe("skipped");
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: true, result: { outcome: "replay" } }]]);
  });

  it("RP11: the claim CAS loses (the sweep took the row) → returns at once, nothing read or posted", async () => {
    const slack = setup({ event: { reply_state: "swept" } });
    expect(await run()).toEqual({ skipped: "state" });
    expect(slack.calls).toHaveLength(0);
    expect(h.db.tables.exec_access_log).toHaveLength(0);
  });

  it("RP12: the message was deleted (the re-read finds nothing) → skipped, nothing posted", async () => {
    const slack = setup({ msg: null });
    expect(await run()).toEqual({ skipped: "message_gone" });
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(0);
    expect(eventRow()?.reply_state).toBe("skipped");
  });

  it("RP13: the re-read shows another user, a bot_id, an app_id, a subtype or a hidden message → skipped", async () => {
    for (const over of [{ user: "U0OTHER" }, { bot_id: "B0BOT" }, { app_id: "A0EXEC" }, { subtype: "message_changed" }, { hidden: true }, { text: undefined }]) {
      const slack = setup({ msg: message(over) });
      expect(await run()).toEqual({ skipped: "not_his_message" });
      expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(0);
      expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
      slack.restore();
    }
  });

  it("RP14: 4,001 characters → tooLong; 4,000 passes", async () => {
    let slack = setup({ msg: message({ text: "x".repeat(4001) }) });
    expect(await run()).toEqual({ skipped: "too_long" });
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("tooLong")]);
    slack.restore();
    slack = setup({ msg: message({ text: "x".repeat(4000) }) });
    expect(await run()).toMatchObject({ status: "complete" });
  });

  it("an empty question after Slack's markup is removed → skipped, nothing posted", async () => {
    const slack = setup({ msg: message({ text: "   " }) });
    expect(await run()).toEqual({ skipped: "empty" });
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(0);
  });

  it("RP19: a revoked installation or a different DM channel → skipped before any Slack call", async () => {
    let slack = setup();
    h.db.tables.exec_slack_installations[0] = installationRow({ bot_token_enc: null, key_id: null, revoked_at: "2026-11-05T00:00:00.000Z", revoke_reason: "app_uninstalled" });
    expect(await run()).toEqual({ skipped: "installation" });
    expect(slack.calls).toHaveLength(0);
    expect(eventRow()?.reply_state).toBe("skipped");
    slack.restore();

    slack = setup();
    expect(await run({ channel: "D0OTHER" })).toEqual({ skipped: "installation" });
    expect(slack.calls).toHaveLength(0);
  });

  it("RP20: the token can't be opened (SecretUnavailableError) → token_unavailable recorded, NonRetryableError of class auth", async () => {
    const slack = setup();
    const foreign = sealSecret(SENTINELS.token, "exec_slack_installations.bot_token:ep_other");
    h.db.tables.exec_slack_installations[0] = installationRow({ bot_token_enc: foreign, key_id: foreign.split(".")[1] });
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: "NonRetryableError", errorClass: "auth", message: "slack token unavailable" });
    expect(h.db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: "token_unavailable" });
    expect(eventRow()?.reply_state).toBe("failed");
    expect(slack.calls).toHaveLength(0);
  });

  it("RP21: the audit is unavailable → the failed note, no turn, state failed", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    const slack = setup();
    expect(await run()).toEqual({ skipped: "audit_unavailable" });
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("failed")]);
    expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
    expect(eventRow()?.reply_state).toBe("failed");
  });

  it("a payload without the reference shape → NonRetryableError; no principal → skipped", async () => {
    setup();
    await expect(slackReplyJobHandler.run(jobCtx("exec.slack-reply", { ...payload(), ts: "not-a-ts" }))).rejects.toMatchObject({ name: "NonRetryableError" });
    expect(await slackReplyJobHandler.run(jobCtx("exec.slack-reply", payload(), { principal: null }))).toEqual({ skipped: "no_principal" });
  });
});

describe("exec.slack-reply: failures after the placeholder (RP06-RP09, RP15, RP23-RP26)", () => {
  it("RP06: the turn throws → the placeholder becomes the failed note on its own signal; state failed; audit closed", async () => {
    fakeTurn({ run: async () => { throw new Error("boom"); } });
    const slack = setup();
    await expect(run()).rejects.toThrow("boom");
    const updates = callsOf(slack.calls, "chat.update");
    expect(updates.map((c) => textOf(partsOfCall(c)))).toEqual([note("failed")]);
    expect(updates[0].body.ts).toBe(eventRow()?.placeholder_ts);
    expect(eventRow()?.reply_state).toBe("failed");
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, error: "internal" }]]);
    // The turn ran, so no second (aborted) run.
    expect(vi.mocked(runPreparedTurn)).toHaveBeenCalledTimes(1);
  });

  it("RP07: the job times out mid-turn (its signal aborts) → the timedOut note through a NON-aborted signal; also when the turn then throws", async () => {
    const controller = new AbortController();
    fakeTurn({
      run: async () => {
        controller.abort(new DOMException("job timeout", "TimeoutError"));
        return turnDone({ status: "aborted", statusReason: "client_abort", answer: "a partial answer" });
      }
    });
    let slack = setup();
    expect(await run({}, { signal: controller.signal })).toMatchObject({ status: "aborted" });
    // The update landed although the job's signal had fired: it ran on the own controller.
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).toEqual([note("timedOut")]);
    expect(eventRow()?.reply_state).toBe("answered");
    slack.restore();

    // M19: the finally's update must not use the job's (aborted) signal either.
    const controller2 = new AbortController();
    fakeTurn({
      run: async () => {
        controller2.abort(new DOMException("job timeout", "TimeoutError"));
        throw new DOMException("job timeout", "TimeoutError");
      }
    });
    slack = setup();
    await expect(run({}, { signal: controller2.signal })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).toEqual([note("timedOut")]);
    expect(eventRow()?.reply_state).toBe("failed");
  });

  it("RP08: refused, capped and failed turns show P5b's fixed texts through renderAnswer (no failed note on top)", async () => {
    for (const d of [
      turnDone({ status: "refused", statusReason: "refusal", answer: REFUSED_TEXT, sources: [] }),
      turnDone({ status: "capped", statusReason: "chat_budget", answer: CHAT_PAUSED_TEXT, sources: [] }),
      turnDone({ status: "failed", statusReason: "model_error", answer: FAILED_TEXT, sources: [] })
    ]) {
      vi.mocked(auditFinish).mockClear();
      fakeTurn({ done: d });
      const slack = setup();
      expect(await run()).toMatchObject({ status: d.status });
      const updates = callsOf(slack.calls, "chat.update");
      expect(updates).toHaveLength(1);
      const shown = textOf(partsOfCall(updates[0]));
      expect(shown).toContain(d.answer.slice(0, 20));
      expect(partsOfCall(updates[0]).blocks).toHaveLength(1);
      expect(eventRow()?.reply_state).toBe("answered");
      expect(vi.mocked(auditFinish).mock.calls[0][1]).toMatchObject({ ok: d.status !== "failed" });
      slack.restore();
    }
  });

  it("RP09 / C9: the placeholder post fails with token_revoked → the prepared turn finished aborted (no model call), error recorded, state failed, the auth error rethrown", async () => {
    const slack = setup({ slack: { "chat.postMessage": slackError("token_revoked") } });
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: "SlackApiError", code: "token_revoked", errorClass: "auth" });
    expect(h.order.filter((e) => e.startsWith("run"))).toEqual(["run:aborted"]);
    expect(h.db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: "token_revoked" });
    expect(eventRow()?.reply_state).toBe("failed");
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(0);
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, error: "internal" }]]);
  });

  it("RP15: the answer update fails invalid_blocks → the unrenderable note", async () => {
    let updates = 0;
    const slack = setup({ slack: { "chat.update": (body) => (++updates === 1 ? { ok: false, error: "invalid_blocks" } : { ok: true, channel: RI.dmChannelId, ts: body.ts }) } });
    expect(await run()).toMatchObject({ status: "complete" });
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).toEqual([expect.stringContaining("Two tasks"), note("unrenderable")]);
    expect(eventRow()?.reply_state).toBe("answered");
  });

  it("RP23: the placeholder CAS loses (the sweep took the row) → the placeholder is deleted, the turn finished aborted, nothing else; a failed delete → the stale note", async () => {
    const sweepFirst: FakeSlackDbSeed = { before: (call, db) => {
      if (call.kind === "rpc" && call.target === "exec_slack_reply_step" && (call.payload as Record<string, unknown>).p_to === "placeholder") {
        const ev = db.tables.exec_slack_events.find((e) => e.event_id === EVENT_ID);
        if (ev) ev.reply_state = "swept";
      }
    } };
    h = useSlackDb({ tables: { exec_slack_events: [replyEventRow({ message_ts: TS })] }, ...sweepFirst });
    let slack = useSlack({}, message());
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    expect(await run()).toEqual({ skipped: "swept" });
    const placeholderTs = String(callsOf(slack.calls, "chat.postMessage")[0].body.ts ?? "");
    expect(callsOf(slack.calls, "chat.delete")).toHaveLength(1);
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1);
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(0);
    expect(h.order.filter((e) => e.startsWith("run"))).toEqual(["run:aborted"]);
    expect(h.db.tables.exec_slack_posts.map((r) => r.ts)).not.toContain(placeholderTs);
    expect(eventRow()?.reply_state).toBe("swept");
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, result: { outcome: "swept" } }]]);
    slack.restore();

    h = useSlackDb({ tables: { exec_slack_events: [replyEventRow({ message_ts: TS })] }, ...sweepFirst });
    slack = useSlack({ "chat.delete": slackError("internal_error") }, message());
    expect(await run()).toEqual({ skipped: "swept" });
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).toEqual([note("stale")]);
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1);
  });

  it("RP24: the answer CAS loses → the stale note is the last write (sweep before or after our answer), no cards", async () => {
    for (const sweepAt of ["before_answer", "after_answer"] as const) {
      const shown = new Map<string, string>();
      vi.mocked(getDraftView).mockResolvedValue(null);
      fakeTurn({
        run: async () => {
          if (sweepAt === "before_answer") {
            // The sweep CAS'd the row and wrote its stale note while the turn ran.
            const ev = h.db.tables.exec_slack_events.find((e) => e.event_id === EVENT_ID) as Record<string, unknown>;
            ev.reply_state = "swept";
            shown.set(String(ev.placeholder_ts), note("stale"));
          }
          return turnDone({ cards: [{ kind: "task_proposal", proposal: proposal({ id: PROPOSAL(1) }) }] });
        }
      });
      h = useSlackDb({
        tables: { exec_slack_events: [replyEventRow({ message_ts: TS })] },
        before: (call, db) => {
          if (sweepAt === "after_answer" && call.kind === "rpc" && (call.payload as Record<string, unknown>).p_to === "answered") {
            const ev = db.tables.exec_slack_events.find((e) => e.event_id === EVENT_ID) as Record<string, unknown>;
            ev.reply_state = "swept";
            shown.set(String(ev.placeholder_ts), note("stale"));
          }
        }
      });
      const slack = useSlack({ "chat.update": (body) => {
        shown.set(String(body.ts), textOf({ blocks: body.blocks }));
        return { ok: true, channel: RI.dmChannelId, ts: body.ts };
      } }, message());
      vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
      expect(await run()).toEqual({ skipped: "swept_late" });
      const placeholderTs = String(eventRow()?.placeholder_ts);
      expect(shown.get(placeholderTs)).toBe(note("stale"));
      expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1); // the placeholder only: no cards
      slack.restore();
    }
  });

  it("RP25: RPC 6 throws after the placeholder posted → the placeholder shows failed, the turn finished aborted, the failed CAS attempted, the audit not ok", async () => {
    h = useSlackDb({
      tables: { exec_slack_events: [replyEventRow({ message_ts: TS })] },
      fail: (call) => (call.kind === "rpc" && (call.payload as Record<string, unknown>)?.p_to === "placeholder" ? { message: "timeout", code: "57014" } : null)
    });
    const slack = useSlack({}, message());
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    await expect(run()).rejects.toMatchObject({ name: "SlackStoreError" });
    expect(callsOf(slack.calls, "chat.update").map((c) => textOf(partsOfCall(c)))).toEqual([note("failed")]);
    expect(h.order.filter((e) => e.startsWith("run"))).toEqual(["run:aborted"]);
    expect(h.order.filter((e) => e.startsWith("rpc:reply_step"))).toEqual(["rpc:reply_step:started", "rpc:reply_step:placeholder", "rpc:reply_step:failed"]);
    expect(eventRow()?.reply_state).toBe("failed");
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[77, { ok: false, error: "internal" }]]);
  });

  it("RP26: the re-read fails with HTTP 503 (and, separately, the settings read throws) → one failed note in the thread, state failed, no placeholder, no turn", async () => {
    let slack = setup({ slack: { "conversations.history": () => new Response("upstream", { status: 503 }) } });
    await expect(run()).rejects.toMatchObject({ name: "SlackApiError" });
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => [c.body.thread_ts, textOf(partsOfCall(c))])).toEqual([[TS, note("failed")]]);
    expect(eventRow()?.reply_state).toBe("failed");
    expect(vi.mocked(prepareChatTurn)).not.toHaveBeenCalled();
    expect(h.db.tables.exec_slack_posts.map((r) => r.kind)).toEqual(["note"]);
    slack.restore();

    slack = setup();
    vi.mocked(loadSettings).mockRejectedValue(new Error("settings read failed"));
    await expect(run()).rejects.toThrow("settings read failed");
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => textOf(partsOfCall(c)))).toEqual([note("failed")]);
    expect(eventRow()?.reply_state).toBe("failed");
    expect(vi.mocked(runPreparedTurn)).not.toHaveBeenCalled();
  });
});

describe("exec.slack-reply: shape and leaks (RP18, RP22)", () => {
  it("RP18: the job's payload, its result and every payload it enqueues hold no text, token or email", async () => {
    const draftId = DRAFT(3);
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: draftId, status: "generating", bodyText: SENTINELS.text }));
    fakeTurn({ done: turnDone({ answer: `${SENTINELS.text} [r1]`, cards: [{ kind: "draft", draftId, href: `/executive/email/drafts/${draftId}`, existing: false, privateRefKinds: [] }] }) });
    setup();
    const ctx = jobCtx("exec.slack-reply", payload());
    const out = await slackReplyJobHandler.run(ctx);
    expect(findSentinel([ctx.job.payload, out, h.db.tables.exec_jobs.map((j) => j.payload), h.db.tables.exec_slack_posts, h.db.tables.exec_slack_events, h.db.tables.exec_access_log])).toBeNull();
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-card")).toHaveLength(3);
  });

  it("RP22: interactive lane, 300 s, its kind", () => {
    expect(slackReplyJobHandler).toMatchObject({ kind: "exec.slack-reply", lane: "interactive", timeoutMs: 300_000 });
  });

  it("every message it writes passes the Block Kit rules and says nothing but the fixed fallback in text", async () => {
    const slack = setup();
    await run();
    for (const c of [...callsOf(slack.calls, "chat.postMessage"), ...callsOf(slack.calls, "chat.update")]) {
      assertSlackParts(partsOfCall(c));
      expect(c.body.text).toBe(SLACK_COPY.fallbackText);
      expect(buttonsOf(partsOfCall(c))).not.toContain("send");
    }
    expect(PRINCIPAL.id).toBe("ep_1");
  });
});

describe("exec.slack-reply: a dead token on the re-read (C17 v2)", () => {
  it("the re-read failing invalid_auth records the error, enqueues the revocation check once, and leaves the reply failed", async () => {
    const slack = setup({ slack: { "conversations.history": slackError("invalid_auth"), "chat.postMessage": slackError("invalid_auth") } });
    await expect(run()).rejects.toMatchObject({ name: "SlackApiError", code: "invalid_auth", errorClass: "auth" });
    expect(h.db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: "invalid_auth" });
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall").map((j) => j.dedupe_key)).toEqual([`slack-revoke-check:auth:${INST}:2026110615`]);
    expect(eventRow()?.reply_state).toBe("failed");
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1);
  });
});
