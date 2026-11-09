import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// P7a's facade at its boundary: the outbox, the opt-outs and the raw view state.
vi.mock("@/lib/exec/slack-reading", () => ({ listPurgeLog: vi.fn(), listAuthorOptouts: vi.fn(), getSlackReadingState: vi.fn() }));
// Area C's rebuild enqueue at its boundary (its own suite pins the keys and the 7-day window).
vi.mock("@/lib/exec/slack-digests", () => ({ enqueueDigestRebuilds: vi.fn() }));
vi.mock("@/lib/exec/chat-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/chat-store")>()), redactChatMessage: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
// exec_sync_state in memory (the cursor and the fingerprint).
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));

import { createFakeSlackIntelDb, type FakeSlackIntelDb } from "@/lib/exec/__tests__/fake-slack-intel-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { NOW, PID, PRINCIPAL, channelDbRow, jobCtx, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { runSlackIntelSweep, slackIntelSweepJobHandler, slackIntelSweepScheduledWork, type SlackIntelSweepResult } from "@/lib/exec/handlers/slack-intel-sweep";
import { loadSettings } from "@/lib/exec/principal";
import { enqueueDigestRebuilds } from "@/lib/exec/slack-digests";
import { SLACK_REDACTED_TEXT } from "@/lib/exec/slack-intel-copy";
import { __resetSlackIntelStoreForTests } from "@/lib/exec/slack-intel-store";
import { slackDigestKey, slackMessageKey } from "@/lib/exec/slack-intel-types";
import { getSlackReadingState, listAuthorOptouts, listPurgeLog } from "@/lib/exec/slack-reading";
import { optoutFingerprint } from "@/lib/exec/slack-redact";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import type { SlackReadingViewState } from "@/lib/exec/slack-read-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area D: exec.slack-intel-sweep and followSlackPurges (contract §3.11.4, C32, C33, N13, N20; §5.9 SW01-SW12). The
// store is Area A's real one over its frozen fake (RPC 8, 10, 12 and 14 as §2.1 has them); P7a's outbox, opt-outs and view
// state come from the facade's mock; exec_sync_state lives in a map.

const PUB = "C0ACMESEO";
const PRIV = "C0PRIVOPS";
const LEAD = "C0FBLEADS";
const TS1 = "1794140000.000100";   // 2026-11-08 (New York)
const CONV = `ecv_${"1".repeat(32)}`;
const msgId = (n: number) => `ecm_${String(n).padStart(32, "0")}`;
type LogRow = Awaited<ReturnType<typeof listPurgeLog>>[number];

let db: FakeSlackIntelDb;
let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];
const state = new Map<string, unknown>();
let outbox: LogRow[] = [];

function message(n: number, over: Row = {}): Row {
  return {
    id: msgId(n), principal_id: PID, conversation_id: `ecv_${String(n).padStart(32, "0")}`, turn_id: `ect_${String(n).padStart(32, "0")}`, role: "assistant",
    status: "complete", text: `Answer ${S.summary}`, recommendations: "", sources: [], cards: [], tool_calls: [], consulted_email_thread_ids: [],
    consulted_client_ids: [], consulted_dd_text: false, consulted_slack_refs: [], consulted_slack_channels: [], consulted_private_slack: false,
    created_at: new Date(NOW.getTime() - 3_600_000 + n * 60_000).toISOString(), finished_at: null, redacted_at: null, ...over
  };
}
let dSeq = 0;
const digest = (over: Row = {}): Row => ({
  id: `esd_${String(++dSeq).padStart(32, "0")}`, principal_id: PID, channel_id: PUB, local_date: "2026-11-08", tz: "America/New_York",
  from_ts: "1794114000.000000", to_ts: "1794150000.000000", status: "built", summary: S.summary, highlights: [], decisions: [], open_questions: [],
  source_ts: [TS1], human_count: 2, bot_count: 0, dd_post_count: 0, external_count: 0, thread_count: 0, privacy: "public", partial: false, full_day: true,
  injection_suspected: false, rebuilds: 0, model: "claude-haiku-5-5", cost_usd: 0.001, requested_at: "2026-11-08T05:30:00.000Z",
  built_at: "2026-11-08T05:31:00.000Z", expires_at: "2027-02-01T00:00:00.000Z", ...over
});
const link = (channelId: string, over: Row = {}): Row => ({
  principal_id: PID, channel_id: channelId, tag_client_id: "c_acme", tag_client_name: S.clientName, tag_project_ids: [], tagged_at: NOW.toISOString(),
  rule_client_id: null, rule_client_name: null, rule_candidates: 0, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...over
});
// An hour old by default: past the cursor's settle time (fixer correctness-1), so the cursor passes it.
const logRow = (id: number, over: Partial<LogRow>): LogRow => ({ id, scope: "message", channelId: PUB, ts: TS1, reason: "deleted_event",
  createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(), ...over });

function useDb(tables: Partial<Record<string, Row[]>> = {}, fail?: (call: { target: string; kind: string }) => { code: string; message: string } | null): FakeSlackIntelDb {
  dSeq = 0;
  db = createFakeSlackIntelDb({
    tables: {
      exec_slack_channels: [
        channelDbRow({ channel_id: PUB, name: S.channelName }),
        channelDbRow({ channel_id: PRIV, conv_type: "group", is_private: true, name: "private-ops" }),
        channelDbRow({ channel_id: LEAD, class: "standard", name: "acme-lead-old" })
      ],
      exec_slack_installations: [{ id: `esi_${"1".repeat(32)}`, principal_id: PID, team_id: "T0SCALED", revoked_at: null, user_revoked_at: null, user_token_enc: "sealed" }],
      ...tables
    } as never,
    now: () => NOW,
    ...(fail ? { fail: (call) => fail(call) } : {})
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const rowOf = (id: string) => db.tables.exec_messages.find((m) => m.id === id) as Row;
const redacted = (n: number) => rowOf(msgId(n)).text === SLACK_REDACTED_TEXT;
const rpcs = (name: string) => db.calls.filter((c) => c.kind === "rpc" && c.target === name);

function readingView(view: SlackReadingViewState) {
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: view, discoveredAt: "2026-11-01T00:00:00.000Z", lastSweepAt: null, lastEventAt: null });
}
type Counted = Exclude<SlackIntelSweepResult, { skipped: string }>;
/** One sweep; typed as the counted result (the skip tests compare the value whole). */
async function sweep(): Promise<Counted> {
  const r = await runSlackIntelSweep(jobCtx("exec.slack-intel-sweep", { reason: "schedule" }), NOW);
  results.push(r);
  return r as Counted;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  results.length = 0;
  state.clear();
  outbox = [];
  __resetSlackIntelStoreForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  readingView("on");
  vi.mocked(listAuthorOptouts).mockResolvedValue([]);
  vi.mocked(listPurgeLog).mockImplementation(async (_p, afterId, limit) => outbox.filter((r) => r.id > afterId).sort((a, b) => a.id - b.id).slice(0, limit));
  vi.mocked(enqueueDigestRebuilds).mockImplementation(async (_p, rows) => rows.length);
  vi.mocked(getSyncState).mockImplementation(async (_p, source, key, parse) => {
    const v = state.get(`${source}/${key}`);
    if (v === undefined) return null;
    const value = parse(v);
    return value === null ? null : { value, rev: 1 };
  });
  vi.mocked(putSyncState).mockImplementation(async (_p, source, key, value) => {
    state.set(`${source}/${key}`, structuredClone(value));
  });
  useDb();
});

afterEach(() => {
  // SW06: counts and a boolean only, in the result and the logs.
  assertNoSlackLeak({ console: out, results });
  vi.useRealTimers();
});

describe("the outbox (C32)", () => {
  it("SW01 / RD06 a message row: blanks the digests holding the ts, redacts by its message key and the OLD digest key, queues the rebuild, then the cursor moves", async () => {
    useDb({
      exec_slack_digests: [digest({ rebuilds: 4 })],
      exec_messages: [
        message(1, { consulted_slack_refs: [slackMessageKey(PUB, TS1)], consulted_slack_channels: [PUB] }),
        message(2, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 4)], consulted_slack_channels: [PUB] }),
        message(3, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 9)], consulted_slack_channels: [PUB] })
      ]
    });
    outbox = [logRow(11, {})];
    const r = await sweep();
    expect(r).toMatchObject({ logRows: 1, digestsBlanked: 1, channelsForgotten: 0, redacted: 2, rebuildsQueued: 1, optoutsActed: false });
    expect(db.tables.exec_slack_digests[0]).toMatchObject({ status: "stale", rebuilds: 5, summary: null });
    expect([redacted(1), redacted(2), redacted(3)]).toEqual([true, true, false]);
    expect(vi.mocked(enqueueDigestRebuilds).mock.calls[0][1]).toEqual([{ channelId: PUB, localDate: "2026-11-08", rebuilds: 5 }]);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 11 });
    // Only after the batch's redaction: the put is the last outbox write.
    const order = [...vi.mocked(putSyncState).mock.invocationCallOrder];
    expect(Math.min(...order)).toBeGreaterThan(vi.mocked(enqueueDigestRebuilds).mock.invocationCallOrder[0]);
  });

  it("SW07 the blank looks at the ts's local date ± 1 day (in his zone)", async () => {
    outbox = [logRow(1, { ts: "1794114000.000100" })];   // 2026-11-08 00:00:00 New York
    await sweep();
    const blank = rpcs("exec_slack_digest_blank")[0].payload as Row;
    expect(blank).toMatchObject({ p_channel_id: PUB, p_ts: ["1794114000.000100"] });
    expect([...(blank.p_dates as string[])].sort()).toEqual(["2026-11-07", "2026-11-08", "2026-11-09"]);
  });

  it("RD06 a conversation row: RPC 14 (no scan) and redact by channel; a rekey row: nothing forgotten or redacted", async () => {
    useDb({
      exec_slack_digests: [digest({ channel_id: PRIV })],
      exec_messages: [message(1, { consulted_slack_channels: [PRIV] }), message(2, { consulted_slack_channels: [PUB] })]
    });
    outbox = [logRow(1, { scope: "conversation", channelId: PRIV, ts: null, reason: "left" }), logRow(2, { scope: "conversation", channelId: PUB, ts: null, reason: "rekey" })];
    const r = await sweep();
    const forget = rpcs("exec_slack_intel_forget_channels").map((c) => c.payload as Row);
    expect(forget[0]).toMatchObject({ p_channel_ids: [PRIV], p_scan: false });
    expect([redacted(1), redacted(2)]).toEqual([true, false]);
    expect(r).toMatchObject({ logRows: 2, channelsForgotten: 1 });
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 2 });
  });

  it("RD06 a reading row redacts every Slack-consulting answer", async () => {
    useDb({ exec_messages: [message(1, { consulted_slack_channels: [PUB] }), message(2, { consulted_slack_channels: [PRIV] }), message(3)] });
    outbox = [logRow(3, { scope: "reading", channelId: null, ts: null, reason: "reading_purged" })];
    const r = await sweep();
    expect([redacted(1), redacted(2), redacted(3)]).toEqual([true, true, false]);
    expect(r.logRows).toBe(1);
  });

  it("SW01 / SW02 batches of 500 from afterId 0 (the whole 7-day outbox) until fewer remain; the cursor moves per batch", async () => {
    outbox = Array.from({ length: 1_203 }, (_v, n) => logRow(n + 1, { ts: `17941${String(n).padStart(5, "0")}.000100` }));
    const r = await sweep();
    expect(vi.mocked(listPurgeLog).mock.calls.map((c) => [c[1], c[2]])).toEqual([[0, 500], [500, 500], [1000, 500]]);
    expect(vi.mocked(putSyncState).mock.calls.filter((c) => c[2] === "purge-log").map((c) => c[3])).toEqual([{ afterId: 500 }, { afterId: 1000 }, { afterId: 1203 }]);
    expect(r.logRows).toBe(1_203);
    // A later pass starts after the cursor.
    vi.mocked(listPurgeLog).mockClear();
    await sweep();
    expect(vi.mocked(listPurgeLog).mock.calls[0][1]).toBe(1_203);
  });

  it("SW08 a redaction failure throws (the job retries) and the cursor does NOT move; the retry reprocesses the batch idempotently", async () => {
    let failing = true;
    useDb({ exec_slack_digests: [digest()], exec_messages: [message(1, { consulted_slack_refs: [slackMessageKey(PUB, TS1)], consulted_slack_channels: [PUB] })] },
      (call) => (failing && call.target === "exec_chat_redact_slack" ? { code: "57014", message: "statement timeout" } : null));
    outbox = [logRow(5, {})];
    await expect(sweep()).rejects.toThrow();
    expect(state.has("slack-intel/purge-log")).toBe(false);
    failing = false;
    const r = await sweep();
    expect(r).toMatchObject({ logRows: 1, redacted: 1 });
    expect(redacted(1)).toBe(true);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 5 });
  });

  it("SW08 (fixer correctness-2) the retry still redacts an answer that consulted only the blanked DIGEST, and queues its rebuild", async () => {
    let failing = true;
    useDb({ exec_slack_digests: [digest({ rebuilds: 0 })], exec_messages: [message(1, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 0)], consulted_slack_channels: [PUB] })] },
      (call) => (failing && call.target === "exec_chat_redact_slack" ? { code: "57014", message: "statement timeout" } : null));
    outbox = [logRow(5, {})];
    await expect(sweep()).rejects.toThrow();
    // The first attempt blanked the digest (RPC 8 committed) before its redaction failed.
    expect(db.tables.exec_slack_digests[0]).toMatchObject({ status: "stale", rebuilds: 1, source_ts: [] });
    expect(enqueueDigestRebuilds).not.toHaveBeenCalled();
    failing = false;
    const r = await sweep();
    expect(redacted(1)).toBe(true);
    expect(r).toMatchObject({ logRows: 1, redacted: 1, rebuildsQueued: 1 });
    expect(vi.mocked(enqueueDigestRebuilds).mock.calls[0][1]).toEqual([{ channelId: PUB, localDate: "2026-11-08", rebuilds: 1 }]);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 5 });
  });

  it("SW08 (fixer correctness-2) a second sweep over the same rows (another process) still finds the digest keys", async () => {
    useDb({ exec_slack_digests: [digest({ rebuilds: 2 })], exec_messages: [message(1, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 2)], consulted_slack_channels: [PUB] })] });
    outbox = [logRow(5, {})];
    // Another process blanked first (RPC 8) and died before its redaction.
    await (db.client as SupabaseClient).rpc("exec_slack_digest_blank", { p_principal: PID, p_channel_id: PUB, p_ts: [TS1], p_dates: ["2026-11-08"], p_all: false });
    expect(db.tables.exec_slack_digests[0]).toMatchObject({ status: "stale", rebuilds: 3 });
    const r = await sweep();
    expect(r.digestsBlanked).toBe(0);
    expect(redacted(1)).toBe(true);
  });

  it("SW13 (fixer correctness-3 / security-4) a same-generation rebuild dropped the deleted ts before the sweep: answers that consulted that generation are still redacted", async () => {
    // Generation 0 was built at 10:00 with TS1; a "today" rebuild (same generation, the claim never bumps it) then read the
    // history after TS1 was deleted, so the row no longer holds it. RPC 8 blanks nothing.
    const TS2 = "1794141000.000100";
    useDb({
      exec_slack_digests: [digest({ rebuilds: 0, source_ts: [TS2], to_ts: "1794150000.000000", full_day: false }),
        digest({ local_date: "2026-11-07", rebuilds: 0, from_ts: "1794027600.000000", to_ts: "1794114000.000000", source_ts: ["1794100000.000100"] })],
      exec_messages: [
        message(1, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 0)], consulted_slack_channels: [PUB] }),
        message(2, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-07", 0)], consulted_slack_channels: [PUB] })
      ]
    });
    outbox = [logRow(6, {})];
    const r = await sweep();
    expect(r.digestsBlanked).toBe(0);
    expect(db.tables.exec_slack_digests.map((d) => d.status)).toEqual(["built", "built"]);
    expect([redacted(1), redacted(2)]).toEqual([true, false]);   // the deleted message's day only
    expect(r.rebuildsQueued).toBe(0);
  });

  it("SW13 a digest whose window ends before the deleted message (built earlier that day, never re-read) isn't redacted", async () => {
    useDb({
      exec_slack_digests: [digest({ rebuilds: 0, source_ts: ["1794120000.000100"], to_ts: "1794130000.000000", full_day: false })],
      exec_messages: [message(1, { consulted_slack_refs: [slackDigestKey(PUB, "2026-11-08", 0)], consulted_slack_channels: [PUB] })]
    });
    outbox = [logRow(6, {})];   // TS1 (1794140000) is after the row's to_ts
    await sweep();
    expect(redacted(1)).toBe(false);
  });

  it("SW14 (fixer correctness-1) a lower outbox id that commits after a higher one is still followed; nothing is followed twice", async () => {
    const TSA = "1794140100.000100";
    useDb({
      exec_slack_digests: [digest()],
      exec_messages: [message(1, { consulted_slack_refs: [slackMessageKey(PUB, TS1)], consulted_slack_channels: [PUB] }),
        message(2, { consulted_slack_refs: [slackMessageKey(PUB, TSA)], consulted_slack_channels: [PUB] })]
    });
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    // id 12 committed; id 11 (allocated first) is still in flight.
    outbox = [logRow(12, { ts: TS1, createdAt: fresh })];
    await sweep();
    expect(redacted(1)).toBe(true);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 0, done: [12] });
    // id 11 commits: the next pass follows it and skips 12 (no second blank of TS1).
    outbox.push(logRow(11, { ts: TSA, createdAt: new Date(NOW.getTime() - 90_000).toISOString() }));
    const blanksBefore = rpcs("exec_slack_digest_blank").length;
    const r = await sweep();
    expect(r.logRows).toBe(1);
    expect(redacted(2)).toBe(true);
    expect(rpcs("exec_slack_digest_blank").slice(blanksBefore).map((c) => (c.payload as Row).p_ts)).toEqual([[TSA]]);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 0, done: [11, 12] });
    // Once both are older than the settle time, the cursor passes them.
    const at = new Date(NOW.getTime() + 20 * 60_000);
    vi.setSystemTime(at);
    const later = (await runSlackIntelSweep(jobCtx("exec.slack-intel-sweep", { reason: "schedule" }), at)) as Counted;
    results.push(later);
    expect(later.logRows).toBe(0);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 12 });
  });

  it("SW09 (intel-2) a left private conversation: its digests deleted, its owner tags KEPT, its answers redacted", async () => {
    useDb({
      exec_slack_channels: [channelDbRow({ channel_id: PRIV, conv_type: "group", is_private: true, name: "private-ops", watch_state: "unwatched", left_at: NOW.toISOString() })],
      exec_slack_digests: [digest({ channel_id: PRIV }), digest({ channel_id: PRIV, local_date: "2026-11-07" })],
      exec_slack_channel_links: [link(PRIV)],
      exec_messages: [message(1, { consulted_slack_refs: [slackDigestKey(PRIV, "2026-11-08", 0)], consulted_slack_channels: [PRIV] })]
    });
    outbox = [logRow(1, { scope: "conversation", channelId: PRIV, ts: null, reason: "left" })];
    await sweep();
    expect(db.tables.exec_slack_digests.filter((d) => d.channel_id === PRIV)).toEqual([]);
    expect(db.tables.exec_slack_channel_links.map((l) => l.channel_id)).toEqual([PRIV]);
    expect(redacted(1)).toBe(true);
  });

  it("SW10 (intel-2) a rename into a lead name (reason deny, reclassified): digests AND the link row deleted, chat redacted", async () => {
    useDb({
      exec_slack_channels: [channelDbRow({ channel_id: LEAD, class: "deny", deny_reason: "fb_lead", name: null, watch_state: "unwatched" })],
      exec_slack_digests: [digest({ channel_id: LEAD })],
      exec_slack_channel_links: [link(LEAD)],
      exec_messages: [message(1, { consulted_slack_channels: [LEAD] })]
    });
    outbox = [logRow(1, { scope: "conversation", channelId: LEAD, ts: null, reason: "deny" })];
    await sweep();
    expect(db.tables.exec_slack_digests).toEqual([]);
    expect(db.tables.exec_slack_channel_links).toEqual([]);
    expect(redacted(1)).toBe(true);
  });

  it("SW12 reinstall and lost_access: digests deleted, tags kept", async () => {
    for (const reason of ["reinstall", "lost_access"]) {
      useDb({ exec_slack_digests: [digest({ channel_id: PRIV })], exec_slack_channel_links: [link(PRIV)] });
      state.clear();
      outbox = [logRow(1, { scope: "conversation", channelId: PRIV, ts: null, reason })];
      await sweep();
      expect(db.tables.exec_slack_digests, reason).toEqual([]);
      expect(db.tables.exec_slack_channel_links.map((l) => l.channel_id), reason).toEqual([PRIV]);
    }
  });

  it("a message row on a channel forgotten in the same batch isn't blanked separately and gets no rebuild", async () => {
    useDb({ exec_slack_digests: [digest({ channel_id: PRIV })] });
    outbox = [logRow(1, { channelId: PRIV }), logRow(2, { scope: "conversation", channelId: PRIV, ts: null, reason: "gone" })];
    const r = await sweep();
    expect(rpcs("exec_slack_digest_blank")).toHaveLength(0);
    expect(r.rebuildsQueued).toBe(0);
  });
});

describe("the scan arm, the opt-outs, the backstop", () => {
  it("SW03 / SW10 the scan: conversations now hub/deny/unclassified or left still holding digests → deleted; lost consulted channels → redacted", async () => {
    useDb({
      exec_slack_channels: [channelDbRow({ channel_id: PUB, class: "hub", hub_kind: "outbound", name: "outbound-replies" }), channelDbRow({ channel_id: PRIV, conv_type: "group", is_private: true })],
      exec_slack_digests: [digest({ channel_id: PUB })],
      exec_messages: [message(1, { consulted_slack_channels: [PUB] }), message(2, { consulted_slack_channels: ["C0VANISHED"] }), message(3, { consulted_slack_channels: [PRIV] })]
    });
    const r = await sweep();
    expect(rpcs("exec_slack_intel_forget_channels").map((c) => (c.payload as Row).p_scan)).toEqual([true]);
    expect(rpcs("exec_chat_slack_orphan_channels")).toHaveLength(1);
    expect(db.tables.exec_slack_digests).toEqual([]);
    expect([redacted(1), redacted(2), redacted(3)]).toEqual([true, true, false]);
    expect(r.channelsForgotten).toBe(1);
  });

  it("SW11 (C33) a new opt-out: blank every digest, rebuild the blanked days (≤ 7 back: Area C's window), redact all, store the fingerprint", async () => {
    useDb({
      exec_slack_digests: [digest(), digest({ channel_id: PRIV, local_date: "2026-11-01" })],
      exec_messages: [message(1, { consulted_slack_channels: [PUB] }), message(2)]
    });
    vi.mocked(listAuthorOptouts).mockResolvedValue(["U0OPTOUT"]);
    const r = await sweep();
    expect(r).toMatchObject({ optoutsActed: true, digestsBlanked: 2 });
    expect(db.tables.exec_slack_digests.every((d) => d.status === "stale")).toBe(true);
    expect(vi.mocked(enqueueDigestRebuilds).mock.calls[0][1]).toHaveLength(2);
    expect(vi.mocked(enqueueDigestRebuilds).mock.calls[0][3]).toMatchObject({ max: 200 });
    expect(redacted(1)).toBe(true);
    const fp = optoutFingerprint(["U0OPTOUT"]);
    expect(state.get("slack-intel/optouts")).toEqual(fp);
    expect(fp.fp).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify([...state.values()])).not.toContain("U0OPTOUT");
    // The same set next run: nothing.
    vi.mocked(enqueueDigestRebuilds).mockClear();
    const again = await sweep();
    expect(again.optoutsActed).toBe(false);
    expect(enqueueDigestRebuilds).not.toHaveBeenCalled();
  });

  it("SW11 (fixer correctness-2) an opt-out pass that failed after its blank still queues the rebuilds on the retry", async () => {
    useDb({ exec_slack_digests: [digest(), digest({ channel_id: PRIV, local_date: "2026-11-07" })], exec_messages: [message(1, { consulted_slack_channels: [PUB] })] });
    vi.mocked(listAuthorOptouts).mockResolvedValue(["U0OPTOUT"]);
    vi.mocked(enqueueDigestRebuilds).mockRejectedValueOnce(new Error("queue down"));
    await expect(sweep()).rejects.toThrow("queue down");
    expect(db.tables.exec_slack_digests.every((d) => d.status === "stale")).toBe(true);
    expect(state.has("slack-intel/optouts")).toBe(false);
    const r = await sweep();
    expect(r.optoutsActed).toBe(true);
    // The retry's own call (the first one threw): it finds the stale rows although nothing was left to blank.
    expect(vi.mocked(enqueueDigestRebuilds).mock.calls).toHaveLength(2);
    expect(r.rebuildsQueued).toBe(2);
    const queued = vi.mocked(enqueueDigestRebuilds).mock.calls[1]?.[1] ?? [];
    expect([...queued].map((q) => `${q.channelId}:${q.localDate}:${q.rebuilds}`).sort()).toEqual([`${PRIV}:2026-11-07:1`, `${PUB}:2026-11-08:1`].sort());
    expect(redacted(1)).toBe(true);
  });

  it("SW11 a shrunk set only stores the new fingerprint; an empty first set acts on nothing", async () => {
    state.set("slack-intel/optouts", optoutFingerprint(["U0A", "U0B"]));
    useDb({ exec_slack_digests: [digest()] });
    vi.mocked(listAuthorOptouts).mockResolvedValue(["U0A"]);
    const r = await sweep();
    expect(r.optoutsActed).toBe(false);
    expect(db.tables.exec_slack_digests[0].status).toBe("built");
    expect(state.get("slack-intel/optouts")).toEqual(optoutFingerprint(["U0A"]));
    state.clear();
    vi.mocked(listAuthorOptouts).mockResolvedValue([]);
    const first = await sweep();
    expect(first.optoutsActed).toBe(false);
    expect(db.tables.exec_slack_digests[0].status).toBe("built");
  });

  it("SW11 a swapped member (same size, new fingerprint) counts as added", async () => {
    state.set("slack-intel/optouts", optoutFingerprint(["U0A"]));
    vi.mocked(listAuthorOptouts).mockResolvedValue(["U0B"]);
    expect((await sweep()).optoutsActed).toBe(true);
  });

  it("SW04 the backstop: P7a's view revoked or bot_not_connected → redact all; error → nothing", async () => {
    for (const [view, expected] of [["revoked", true], ["bot_not_connected", true], ["error", false]] as const) {
      useDb({ exec_messages: [message(1, { consulted_slack_channels: [PUB] })] });
      readingView(view);
      await sweep();
      expect(redacted(1), view).toBe(expected);
    }
  });
});

describe("the state gate (SW05) and the job", () => {
  it("SW05 (intel-3) the follow-ups run with reading off, discovering, revoked and not connected", async () => {
    for (const [view, s] of [["paused", settings({ slackReadingEnabled: false })], ["discovering", settings()], ["not_consented", settings()], ["bot_not_connected", settings()]] as const) {
      useDb({ exec_slack_digests: [digest()] });
      state.clear();
      readingView(view);
      vi.mocked(loadSettings).mockResolvedValue(s);
      outbox = [logRow(1, {})];
      const r = await sweep();
      expect(r, view).toMatchObject({ logRows: 1, digestsBlanked: 1 });
    }
  });

  it("SW05 only not_installed skips everything: either schema missing, or P7a's view not_installed", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false }));
    expect(await sweep()).toEqual({ skipped: "not_installed" });
    vi.mocked(loadSettings).mockResolvedValue(settings());
    useDb();
    db.missing.add("exec_slack_digests");
    __resetSlackIntelStoreForTests();
    expect(await sweep()).toEqual({ skipped: "not_installed" });
    useDb();
    __resetSlackIntelStoreForTests();
    readingView("not_installed");
    expect(await sweep()).toEqual({ skipped: "not_installed" });
    expect(listPurgeLog).not.toHaveBeenCalled();
  });

  it("SW05 the schedule's enabled reads only slackReadingSchemaReady; the job is bulk, 90 s; no principal → skipped", async () => {
    expect(slackIntelSweepScheduledWork.enabled?.(settings({ slackReadingEnabled: false }))).toBe(true);
    expect(slackIntelSweepScheduledWork.enabled?.(settings({ slackReadingSchemaReady: false }))).toBe(false);
    expect(slackIntelSweepJobHandler).toMatchObject({ kind: "exec.slack-intel-sweep", lane: "bulk", timeoutMs: 90_000 });
    expect(await runSlackIntelSweep(jobCtx("exec.slack-intel-sweep", {}, { principal: null }), NOW)).toEqual({ skipped: "no_principal" });
  });

  it("SW06 the result: counts and a boolean only", async () => {
    outbox = [logRow(1, {})];
    const r = await sweep();
    expect(Object.keys(r).sort()).toEqual(["channelsForgotten", "digestsBlanked", "logRows", "optoutsActed", "rebuildsQueued", "redacted"]);
    expect(Object.values(r).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
  });

  it("a cursor already at the end reads one empty page and still runs the scan and opt-out arms", async () => {
    state.set("slack-intel/purge-log", { afterId: 99 });
    const r = await sweep();
    expect(vi.mocked(listPurgeLog).mock.calls).toEqual([[PRINCIPAL, 99, 500]]);
    expect(r.logRows).toBe(0);
    expect(rpcs("exec_slack_intel_forget_channels")).toHaveLength(1);
  });

  it("a malformed stored cursor reads from 0 (it never jumps ahead)", async () => {
    state.set("slack-intel/purge-log", { afterId: -4 });
    outbox = [logRow(1, {})];
    await sweep();
    expect(vi.mocked(listPurgeLog).mock.calls[0][1]).toBe(0);
  });

  it("the outbox loop stops at the time box (no new batch starts after it)", async () => {
    outbox = Array.from({ length: 1_000 }, (_v, n) => logRow(n + 1, { ts: `17941${String(n).padStart(5, "0")}.000100` }));
    let reads = 0;
    vi.mocked(listPurgeLog).mockImplementation(async (_p, afterId, limit) => {
      // The first batch takes the whole 60 s box.
      if (++reads === 1) vi.setSystemTime(new Date(NOW.getTime() + 61_000));
      return outbox.filter((r) => r.id > afterId).slice(0, limit);
    });
    const r = await sweep();
    expect(r.logRows).toBe(500);
    expect(state.get("slack-intel/purge-log")).toEqual({ afterId: 500 });
  });
});
