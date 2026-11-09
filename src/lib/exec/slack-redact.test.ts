import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn(), enqueueJobs: vi.fn() }));
// P5b's per-message redaction (RPC 4) at its boundary: the post-finish recheck's fail-closed write.
vi.mock("@/lib/exec/chat-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/chat-store")>()), redactChatMessage: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ listPurgeLog: vi.fn(), listAuthorOptouts: vi.fn(), getSlackReadingState: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", () => ({ enqueueDigestRebuilds: vi.fn() }));

import { createFakeSlackIntelDb, type FakeSlackIntelDb } from "@/lib/exec/__tests__/fake-slack-intel-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { NOW, PID, PRINCIPAL, channelDbRow } from "@/lib/exec/__tests__/slack-read-jobs";
import { buildReplay, replayedAnswerText } from "@/lib/exec/agent/prompt";
import { redactChatMessage, type StoredMessage, type StoredTurn } from "@/lib/exec/chat-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { kickSlackIntelSweep, recheckSlackAnswer, redactChatForSlack } from "@/lib/exec/slack-redact";
import { SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import { __resetSlackIntelStoreForTests } from "@/lib/exec/slack-intel-store";
import { slackDigestKey, slackMessageKey } from "@/lib/exec/slack-intel-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area D: slack-redact.ts (contract §3.9, N13, N15, C27; §5.9 RD04-RD11). RPCs 10-12 run as Area A's fake mirrors them
// (fake-slack-intel-db: §2.1.10-§2.1.11 line for line) under Area A's real store; P5b's per-message RPC 4 and the job
// enqueue are mocked at their modules.

const C = "C0ACMESEO";
const TS = "1794140000.000100";
const CONV = `ecv_${"1".repeat(32)}`;
const msgId = (n: number) => `ecm_${String(n).padStart(32, "0")}`;
let db: FakeSlackIntelDb;
let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];

function message(n: number, over: Row = {}): Row {
  return {
    id: msgId(n), principal_id: PID, conversation_id: CONV, turn_id: `ect_${String(n).padStart(32, "0")}`, role: "assistant", status: "complete",
    text: `Answer ${n} ${S.summary}`, recommendations: "", sources: [], cards: [], tool_calls: [], consulted_email_thread_ids: [], consulted_client_ids: [],
    consulted_dd_text: false, consulted_slack_refs: [], consulted_slack_channels: [], consulted_private_slack: false,
    created_at: new Date(NOW.getTime() - 3_600_000 + n * 60_000).toISOString(), finished_at: null, redacted_at: null, ...over
  };
}
const digestRow = (over: Row = {}): Row => ({
  id: `esd_${"a".repeat(32)}`, principal_id: PID, channel_id: C, local_date: "2026-11-08", tz: "America/New_York", from_ts: "1794114000.000000",
  to_ts: "1794150000.000000", status: "built", summary: S.summary, highlights: [], decisions: [], open_questions: [], source_ts: [TS], human_count: 2,
  bot_count: 0, dd_post_count: 0, external_count: 0, thread_count: 0, privacy: "public", partial: false, full_day: false, injection_suspected: false,
  rebuilds: 0, model: "claude-haiku-5-5", cost_usd: 0.001, requested_at: "2026-11-08T14:00:00.000Z", built_at: "2026-11-08T14:01:00.000Z",
  expires_at: "2027-02-01T00:00:00.000Z", ...over
});
const installation = (over: Row = {}): Row => ({ id: `esi_${"1".repeat(32)}`, principal_id: PID, team_id: "T0SCALED", revoked_at: null, user_revoked_at: null, user_token_enc: "sealed", ...over });

function useDb(tables: Partial<Record<string, Row[]>> = {}, fail?: (call: { target: string; kind: string }) => { code: string; message: string } | null): FakeSlackIntelDb {
  db = createFakeSlackIntelDb({
    tables: { exec_slack_channels: [channelDbRow({ channel_id: C, name: S.channelName })], exec_slack_installations: [installation()], ...tables } as never,
    now: () => NOW,
    ...(fail ? { fail: (call) => fail(call) } : {})
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const rowOf = (id: string) => db.tables.exec_messages.find((m) => m.id === id) as Row;
const rpcs = (name: string) => db.calls.filter((c) => c.kind === "rpc" && c.target === name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  results.length = 0;
  __resetSlackIntelStoreForTests();
  vi.mocked(redactChatMessage).mockResolvedValue(true);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  useDb();
});

afterEach(() => {
  // Ids and codes only: no ref key, ts, text or channel name in a log line, an RPC error or a job payload.
  assertNoSlackLeak({ console: out, jobs: vi.mocked(enqueueJob), results });
  vi.useRealTimers();
});

describe("redactChatForSlack (§3.9, C27)", () => {
  it("redacts every answer that consulted a key or channel, and the later answers of its conversation, with C27's text", async () => {
    useDb({ exec_messages: [
      message(1),
      message(2, { consulted_slack_refs: [slackMessageKey(C, TS)], consulted_slack_channels: [C] }),
      message(3),
      message(4, { conversation_id: `ecv_${"2".repeat(32)}` })
    ] });
    const n = await redactChatForSlack(PRINCIPAL, { messageKeys: [slackMessageKey(C, TS)], digestKeys: [], channelIds: [], all: false });
    results.push(n);
    expect(n).toBe(2);
    expect([1, 2, 3, 4].map((i) => rowOf(msgId(i)).text === SLACK_REDACTED_TEXT)).toEqual([false, true, true, false]);
    expect(rpcs("exec_chat_redact_slack")[0].payload).toMatchObject({ p_text: SLACK_REDACTED_TEXT, p_all: false });
  });

  it("nothing to redact → 0 with no call; all → one principal-wide call", async () => {
    expect(await redactChatForSlack(PRINCIPAL, { messageKeys: [], digestKeys: [], channelIds: [], all: false })).toBe(0);
    expect(db.calls).toEqual([]);
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C] }), message(2)] });
    expect(await redactChatForSlack(PRINCIPAL, { messageKeys: [], digestKeys: [], channelIds: [], all: true })).toBe(2);
    expect(rpcs("exec_chat_redact_slack")).toHaveLength(1);
  });

  it("RD05 chunks at 500 keys and channels per call", async () => {
    const keys = Array.from({ length: 1_100 }, (_v, n) => slackMessageKey(C, `17941${String(n).padStart(5, "0")}.000100`));
    await redactChatForSlack(PRINCIPAL, { messageKeys: keys, digestKeys: [slackDigestKey(C, "2026-11-08", 0)], channelIds: ["C0OTHER"], all: false });
    const calls = rpcs("exec_chat_redact_slack").map((c) => c.payload as Row);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect((c.p_message_keys as unknown[]).length + (c.p_digest_keys as unknown[]).length + (c.p_channel_ids as unknown[]).length).toBeLessThanOrEqual(500);
    expect(calls.flatMap((c) => c.p_message_keys as string[])).toHaveLength(1_100);
  });

  it("a store error throws (the sweep retries); the message carries the code only", async () => {
    useDb({}, (call) => (call.target === "exec_chat_redact_slack" ? { code: "XX000", message: `boom ${S.slackText}` } : null));
    const err = await redactChatForSlack(PRINCIPAL, { messageKeys: [slackMessageKey(C, TS)], digestKeys: [], channelIds: [], all: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(S.slackText);
    results.push((err as Error).message);
  });

  it("RD09 a Slack redaction goes through P5b's exec_chat_redact_message: redacted_at moves (P6's DM follow-up keys on it)", async () => {
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C], recommendations: "Do X", sources: [{ ref: "r1" }] })] });
    await redactChatForSlack(PRINCIPAL, { messageKeys: [], digestKeys: [], channelIds: [C], all: false });
    const row = rowOf(msgId(1));
    expect(row).toMatchObject({ text: SLACK_REDACTED_TEXT, recommendations: "", sources: [] });
    expect(row.redacted_at).toBe(NOW.toISOString());
    expect(db.redactions).toEqual([{ rpc: "exec_chat_redact_slack", messageId: msgId(1), text: SLACK_REDACTED_TEXT }]);
  });
});

describe("recheckSlackAnswer (§3.9, RPC 11, fail closed)", () => {
  it("RD04 clean when nothing it consulted is gone; redacted when a consulted message has a deleted marker", async () => {
    useDb({ exec_messages: [message(1, { consulted_slack_refs: [slackMessageKey(C, TS)], consulted_slack_channels: [C] })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("clean");
    useDb({
      exec_messages: [message(1, { consulted_slack_refs: [slackMessageKey(C, TS)], consulted_slack_channels: [C] })],
      exec_slack_deleted: [{ principal_id: PID, channel_id: C, ts: TS, reason: "deleted_event", deleted_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() }]
    });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("redacted");
    expect(rowOf(msgId(1)).text).toBe(SLACK_REDACTED_TEXT);
    expect(rpcs("exec_chat_slack_recheck")[0].payload).toMatchObject({ p_message_id: msgId(1), p_text: SLACK_REDACTED_TEXT });
  });

  it("RD04 a store failure twice → this message only, with SLACK_UNCHECKED_TEXT through redactChatMessage; no principal-wide call; a sweep kick", async () => {
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C] })] }, (call) => (call.target === "exec_chat_slack_recheck" ? { code: "57014", message: "timeout" } : null));
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("unchecked");
    expect(rpcs("exec_chat_slack_recheck")).toHaveLength(2);
    expect(rpcs("exec_chat_redact_slack")).toHaveLength(0);
    expect(vi.mocked(redactChatMessage).mock.calls).toEqual([[PRINCIPAL, msgId(1), SLACK_UNCHECKED_TEXT, expect.objectContaining({ signal: expect.any(AbortSignal) })]]);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.slack-intel-sweep", lane: "bulk", payload: { reason: "finish_recheck" } });
  });

  it("RD04 a failure once, then an answer → that answer (retried once)", async () => {
    let n = 0;
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C] })] }, (call) => (call.target === "exec_chat_slack_recheck" && ++n === 1 ? { code: "57014", message: "timeout" } : null));
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("clean");
    expect(redactChatMessage).not.toHaveBeenCalled();
  });

  it("RD04 the unchecked write failing too still answers unchecked (the turn shows the unchecked text)", async () => {
    useDb({}, (call) => (call.target === "exec_chat_slack_recheck" ? { code: "57014", message: "timeout" } : null));
    vi.mocked(redactChatMessage).mockRejectedValue(new Error("down"));
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("unchecked");
  });

  it("RD08 (intel-5) a today rebuild in flight (building, same rebuilds) is not a removal; a blank (rebuilds moved) is", async () => {
    const key = slackDigestKey(C, "2026-11-08", 0);
    const msg = message(1, { consulted_slack_refs: [key], consulted_slack_channels: [C] });
    useDb({ exec_messages: [structuredClone(msg)], exec_slack_digests: [digestRow({ status: "building", summary: null, rebuilds: 0 })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("clean");
    useDb({ exec_messages: [structuredClone(msg)], exec_slack_digests: [digestRow({ status: "built", rebuilds: 0 })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("clean");
    useDb({ exec_messages: [structuredClone(msg)], exec_slack_digests: [digestRow({ status: "stale", summary: null, rebuilds: 1 })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("redacted");
  });

  it("RD11 an author purge (a message outbox row, no deleted marker) of a consulted message → the recheck redacts it", async () => {
    useDb({
      exec_messages: [message(1, { consulted_slack_refs: [slackMessageKey(C, TS)], consulted_slack_channels: [C] })],
      exec_slack_purge_log: [{ id: 7, principal_id: PID, scope: "message", channel_id: C, ts: TS, reason: "author_optout", created_at: NOW.toISOString() }]
    });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("redacted");
  });

  it("a lost channel or a revoked reading half → redacted; a message without Slack consults → clean (no write)", async () => {
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C] })], exec_slack_channels: [channelDbRow({ channel_id: C, left_at: NOW.toISOString(), watch_state: "unwatched" })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("redacted");
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [C] })], exec_slack_installations: [installation({ user_revoked_at: NOW.toISOString() })] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("redacted");
    useDb({ exec_messages: [message(1)] });
    expect(await recheckSlackAnswer(PRINCIPAL, msgId(1))).toBe("clean");
    expect(db.redactions).toEqual([]);
  });
});

describe("kickSlackIntelSweep (§3.9)", () => {
  it("enqueues the sweep, bulk, deduped per reason and minute; references only", async () => {
    await kickSlackIntelSweep(PID, "finish_recheck");
    const minute = Math.floor(NOW.getTime() / 60_000);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toEqual({
      kind: "exec.slack-intel-sweep", lane: "bulk", principalId: PID, payload: { reason: "finish_recheck" }, dedupeKey: `slkintel:${PID}:finish_recheck:m${minute}`, maxAttempts: 3
    });
  });

  it("RD07 never throws: an enqueue failure is logged by id", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error(`db down ${S.slackText}`));
    await expect(kickSlackIntelSweep(PID, "schedule")).resolves.toBeUndefined();
    expect(JSON.stringify(out.calls())).toContain(PID);
  });
});

describe("replay (RD10)", () => {
  it("RD10 a Slack-redacted answer replays as its redaction text in the next turn", () => {
    const at = NOW.toISOString();
    const user: StoredMessage = { id: msgId(1), role: "user", status: "complete", statusReason: null, text: "What happened in launch?", recommendations: "", context: null,
      sources: [], cards: [], consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, createdAt: at, finishedAt: at, redactedAt: null };
    const assistant: StoredMessage = { ...user, id: msgId(2), role: "assistant", text: SLACK_REDACTED_TEXT, redactedAt: at, recommendations: "" };
    const turn: StoredTurn = { turnId: `ect_${"1".repeat(32)}`, user, assistant };
    expect(replayedAnswerText(assistant)).toBe(SLACK_REDACTED_TEXT);
    const replay = buildReplay([turn], "America/New_York");
    expect(JSON.stringify(replay[1])).toContain(SLACK_REDACTED_TEXT);
    expect(replayedAnswerText({ ...assistant, text: SLACK_UNCHECKED_TEXT })).toBe(SLACK_UNCHECKED_TEXT);
  });
});
