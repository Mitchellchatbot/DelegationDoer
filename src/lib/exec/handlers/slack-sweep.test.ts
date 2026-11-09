import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({
  prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), newConversationTitle: vi.fn(), storedTurnPayload: vi.fn(), proposalViewFor: vi.fn()
}));
vi.mock("@/lib/exec/proposals", () => ({ confirmProposal: vi.fn(), dismissProposal: vi.fn(), getProposalView: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ loadConversation: vi.fn(), loadTurnByMessageId: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { storedTurnPayload } from "@/lib/exec/agent/turn";
import { loadConversation, loadTurnByMessageId, type StoredTurn } from "@/lib/exec/chat-store";
import { REDACTED_TEXT } from "@/lib/exec/chat/copy";
import { getDraftView } from "@/lib/exec/drafts";
import {
  slackDmPurgeJobHandler,
  slackDmPurgeScheduledWork,
  slackSweepJobHandler,
  slackSweepScheduledWork,
  slackTsOf,
  slackWorkDue
} from "@/lib/exec/handlers/slack-sweep";
import { loadSettings } from "@/lib/exec/principal";
import { getProposalView } from "@/lib/exec/proposals";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import type { SlackMethod } from "@/lib/exec/slack-types";
import { renderNote } from "@/lib/exec/slack-ui";

import { done as chatDone, proposal, sources as chatSources } from "../__tests__/chat-ui-fixtures";
import { restrictedView } from "../__tests__/drafts-ui-fixtures";
import type { FakeSlackHandler } from "../__tests__/fake-slack-api";
import { assertSlackParts, findSentinel, ROUTING_INSTALLATION as RI } from "../__tests__/slack-assert";
import {
  CONV,
  DRAFT,
  INST,
  KEY,
  MSG,
  PRINCIPAL,
  PROPOSAL,
  SETTINGS,
  TURN,
  buttonsOf,
  callsOf,
  jobCtx,
  partsOfCall,
  replyEventRow,
  slackError,
  slackRateLimited,
  textOf,
  useSlack,
  useSlackDb,
  type Harness
} from "../__tests__/slack-jobs-harness";

// P6 contract §5.8 (C8, C19, C42, C43): SW01-SW09 (the stale and redaction sweep) and DP01-DP05 (the DM purge).

const NOW_MS = Date.parse("2026-11-06T15:00:30.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
let h: Harness;
let spies: ReturnType<typeof vi.spyOn>[];

const sweep = () => slackSweepJobHandler.run(jobCtx("exec.slack-sweep", {}));
const purge = () => slackDmPurgeJobHandler.run(jobCtx("exec.slack-dm-purge", {}));
const event = (id: string) => h.db.tables.exec_slack_events.find((e) => e.event_id === id);
const post = (ts: string) => h.db.tables.exec_slack_posts.find((p) => p.ts === ts);
const ledgerRow = (over: Record<string, unknown>) => ({
  installation_id: INST, principal_id: "ep_1", channel_id: RI.dmChannelId, ts: "1793977000.000001", thread_ts: "1793976900.000001", kind: "answer",
  message_id: null, ref_id: null, posted_at: iso(NOW_MS - 30 * MIN), followed_at: null, ...over
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  for (const m of [storedTurnPayload, loadConversation, loadTurnByMessageId, getDraftView, getProposalView]) vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {})];
});
afterEach(() => {
  expect(findSentinel(spies.map((s) => s.mock.calls))).toBeNull();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("exec.slack-sweep, pass 1: stale replies (SW01-SW06)", () => {
  const PH = "1793976500.000300";

  it("SW01: open rows last changed over 10 minutes ago → CAS swept, then the stale note: on the placeholder, or posted in the thread", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [
          replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, message_ts: "1793976400.000100", updated_at: iso(NOW_MS - 11 * MIN), received_at: iso(NOW_MS - 12 * MIN) }),
          replyEventRow({ event_id: "Ev0B", reply_state: "queued", message_ts: "1793976401.000100", thread_ts: "1793976000.000100", updated_at: iso(NOW_MS - 11 * MIN), received_at: iso(NOW_MS - 11 * MIN) }),
          replyEventRow({ event_id: "Ev0C", reply_state: "started", message_ts: "1793976402.000100", updated_at: iso(NOW_MS - 20 * MIN), received_at: iso(NOW_MS - 20 * MIN) })
        ]
      }
    });
    const slack = useSlack();
    expect(await sweep()).toEqual({ swept: 3, followed: 0 });
    expect(["Ev0A", "Ev0B", "Ev0C"].map((id) => event(id)?.reply_state)).toEqual(["swept", "swept", "swept"]);
    expect(callsOf(slack.calls, "chat.update").map((c) => [c.body.ts, textOf(partsOfCall(c))])).toEqual([[PH, textOf(renderNote("stale"))]]);
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => [c.body.thread_ts, textOf(partsOfCall(c))]).sort()).toEqual(
      [["1793976000.000100", textOf(renderNote("stale"))], ["1793976402.000100", textOf(renderNote("stale"))]].sort()
    );
    expect(h.db.tables.exec_slack_posts.map((p) => p.kind)).toEqual(["note", "note"]);
    for (const c of slack.calls) assertSlackParts(partsOfCall(c));
  });

  it("SW02: the CAS loses (the job finished meanwhile) → nothing posted", async () => {
    h = useSlackDb({
      tables: { exec_slack_events: [replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 11 * MIN) })] },
      before: (call, db) => {
        if (call.kind === "rpc" && (call.payload as Record<string, unknown>)?.p_to === "swept") {
          const ev = db.tables.exec_slack_events.find((e) => e.event_id === "Ev0A");
          if (ev) ev.reply_state = "answered";
        }
      }
    });
    const slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(slack.calls).toHaveLength(0);
  });

  it("SW03 / SW06 (build-5): a row updated less than 10 minutes ago is untouched, even received long ago; a queued row received (= updated) 11 minutes ago is swept", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [
          replyEventRow({ event_id: "Ev0RECENT", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 2 * MIN), received_at: iso(NOW_MS - 12 * MIN) }),
          replyEventRow({ event_id: "Ev0FIVE", reply_state: "started", updated_at: iso(NOW_MS - 5 * MIN), received_at: iso(NOW_MS - 5 * MIN) }),
          replyEventRow({ event_id: "Ev0OLD", reply_state: "queued", message_ts: "1793976401.000100", updated_at: iso(NOW_MS - 11 * MIN), received_at: iso(NOW_MS - 11 * MIN) })
        ]
      }
    });
    const slack = useSlack();
    expect(await sweep()).toEqual({ swept: 1, followed: 0 });
    expect(event("Ev0RECENT")?.reply_state).toBe("placeholder");
    expect(event("Ev0FIVE")?.reply_state).toBe("started");
    expect(event("Ev0OLD")?.reply_state).toBe("swept");
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(0);
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1);
  });

  it("SW04: no active installation, or the P6 schema missing → skipped", async () => {
    h = useSlackDb({ tables: { exec_slack_installations: [] } });
    let slack = useSlack();
    expect(await sweep()).toEqual({ skipped: "no_installation" });
    expect(await purge()).toEqual({ skipped: "no_installation" });
    slack.restore();
    h = useSlackDb({ missing: ["exec_slack_installations"] });
    slack = useSlack();
    expect(await sweep()).toEqual({ skipped: "not_installed" });
    expect(await purge()).toEqual({ skipped: "not_installed" });
    expect(slack.calls).toHaveLength(0);
    expect(await slackSweepJobHandler.run(jobCtx("exec.slack-sweep", {}, { principal: null }))).toEqual({ skipped: "no_principal" });
  });

  it("SW05: an auth error stops the run (rethrown, recorded)", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [
          replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 12 * MIN) }),
          replyEventRow({ event_id: "Ev0B", reply_state: "placeholder", placeholder_ts: "1793976501.000300", updated_at: iso(NOW_MS - 11 * MIN) })
        ]
      }
    });
    useSlack({ "chat.update": slackError("token_revoked") });
    await expect(sweep()).rejects.toMatchObject({ name: "SlackApiError", errorClass: "auth" });
    expect(event("Ev0B")?.reply_state).toBe("placeholder");
    expect(h.db.tables.exec_slack_installations[0].last_error_code).toBe("token_revoked");
  });

  it("a non-auth failure on one row is logged by event id and the run goes on", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [
          replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 12 * MIN) }),
          replyEventRow({ event_id: "Ev0B", reply_state: "queued", message_ts: "1793976401.000100", updated_at: iso(NOW_MS - 11 * MIN) })
        ]
      }
    });
    const slack = useSlack({ "chat.update": slackError("internal_error") });
    expect(await sweep()).toEqual({ swept: 2, followed: 0 });
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(1);
    expect(spies[0].mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([expect.stringContaining("Ev0A")]);
  });

  it("SW10 (fixer correctness-6): a stale note that fails after the swept CAS gets its own retry job (references only, three attempts); the retry writes it", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [
          replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 12 * MIN) }),
          replyEventRow({ event_id: "Ev0B", reply_state: "queued", message_ts: "1793976401.000100", thread_ts: "1793976000.000100", updated_at: iso(NOW_MS - 11 * MIN) })
        ]
      }
    });
    let slack = useSlack({ "chat.update": slackRateLimited(), "chat.postMessage": slackError("internal_error") });
    expect(await sweep()).toEqual({ swept: 2, followed: 0 });
    expect(["Ev0A", "Ev0B"].map((id) => event(id)?.reply_state)).toEqual(["swept", "swept"]);
    const retries = h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-sweep");
    expect(retries.map((j) => [j.dedupe_key, j.lane, j.max_attempts, j.principal_id, Date.parse(String(j.run_after)) - NOW_MS])).toEqual([
      ["slack-stale:Ev0A", "bulk", 3, "ep_1", 30_000],
      ["slack-stale:Ev0B", "bulk", 3, "ep_1", 30_000]
    ]);
    expect(retries.map((j) => j.payload)).toEqual([
      { stale_note: { event_id: "Ev0A", installation_id: INST, channel_id: RI.dmChannelId, placeholder_ts: PH, root_ts: "1793977201.000100" } },
      { stale_note: { event_id: "Ev0B", installation_id: INST, channel_id: RI.dmChannelId, placeholder_ts: null, root_ts: "1793976000.000100" } }
    ]);
    slack.restore();

    // The retry jobs: the same note, into the same DM.
    slack = useSlack();
    const retry = (payload: unknown) => slackSweepJobHandler.run(jobCtx("exec.slack-sweep", payload as Record<string, unknown>));
    expect(await retry(retries[0].payload)).toEqual({ swept: 0, followed: 0, noted: 1 });
    expect(await retry(retries[1].payload)).toEqual({ swept: 0, followed: 0, noted: 1 });
    expect(callsOf(slack.calls, "chat.update").map((c) => [c.body.ts, textOf(partsOfCall(c))])).toEqual([[PH, textOf(renderNote("stale"))]]);
    expect(callsOf(slack.calls, "chat.postMessage").map((c) => [c.body.thread_ts, textOf(partsOfCall(c))])).toEqual([["1793976000.000100", textOf(renderNote("stale"))]]);
    expect(callsOf(slack.calls, "conversations.history")).toEqual([]);
    slack.restore();

    // A Slack failure throws (the runner retries); a gone placeholder ends it; another installation's DM is never posted to.
    useSlack({ "chat.update": slackRateLimited() });
    await expect(retry(retries[0].payload)).rejects.toMatchObject({ name: "SlackApiError" });
    useSlack({ "chat.update": slackError("message_not_found") });
    expect(await retry(retries[0].payload)).toEqual({ skipped: "message_gone" });
    const other = { stale_note: { ...(retries[0].payload as { stale_note: Record<string, unknown> }).stale_note, channel_id: "D0OTHER" } };
    slack = useSlack();
    expect(await retry(other)).toEqual({ skipped: "installation" });
    expect(slack.calls).toHaveLength(0);
  });

  it("SW10: an auth-class failure after the CAS stops the run and enqueues no note retry (the token is dead)", async () => {
    h = useSlackDb({ tables: { exec_slack_events: [replyEventRow({ event_id: "Ev0A", reply_state: "placeholder", placeholder_ts: PH, updated_at: iso(NOW_MS - 12 * MIN) })] } });
    useSlack({ "chat.update": slackError("token_revoked") });
    await expect(sweep()).rejects.toMatchObject({ errorClass: "auth" });
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-sweep")).toEqual([]);
  });
});

describe("exec.slack-sweep, pass 2: redaction follow-ups (SW07-SW09)", () => {
  const ANS_TS = "1793977000.000010";
  const PROP_TS = "1793977000.000011";
  const DRAFT_TS = "1793977000.000012";
  const CHANGED = "2026-11-06T14:59:00.123456+00:00";
  const ANSWER = MSG(2);
  const message = (over: Record<string, unknown> = {}) => ({ id: ANSWER, principal_id: "ep_1", conversation_id: CONV(1), role: "assistant", status: "complete", redacted_at: "2026-11-06T14:58:00.000Z", updated_at: CHANGED, ...over });
  const stored = (): StoredTurn => ({ turnId: TURN(1), user: { id: MSG(1) }, assistant: { id: ANSWER, redactedAt: "2026-11-06T14:58:00.000Z" } }) as unknown as StoredTurn;

  function seedAnswer(extra: { events?: Record<string, unknown>[] } = {}) {
    h = useSlackDb({
      tables: {
        exec_slack_events: extra.events ?? [],
        exec_messages: [message()],
        exec_slack_posts: [
          ledgerRow({ ts: ANS_TS, kind: "answer", message_id: ANSWER }),
          ledgerRow({ ts: PROP_TS, kind: "proposal", message_id: ANSWER, ref_id: PROPOSAL(1) }),
          ledgerRow({ ts: DRAFT_TS, kind: "draft", message_id: ANSWER, ref_id: DRAFT(1) })
        ]
      }
    });
    vi.mocked(loadTurnByMessageId).mockResolvedValue(stored());
    vi.mocked(loadConversation).mockResolvedValue({ conversation: { id: CONV(1), surface: "slack", title: "t", refSeq: 0, turnCount: 1, createdAt: "x", lastMessageAt: "x" }, turns: [], hasEarlier: false });
    vi.mocked(storedTurnPayload).mockResolvedValue(chatDone({ messageId: ANSWER, conversationId: CONV(1), answer: REDACTED_TEXT, sources: [chatSources()[0]] }));
    vi.mocked(getProposalView).mockResolvedValue(proposal({ id: PROPOSAL(1), status: "withdrawn", redacted: true }));
    vi.mocked(getDraftView).mockResolvedValue(restrictedView({ id: DRAFT(1) }));
  }

  it("SW07: a redacted answer → chat.update with the stored, redacted payload (no sources, no buttons), its cards re-rendered (removed, hidden), then followed at the READ timestamp; a second sweep does nothing", async () => {
    seedAnswer();
    let slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    const updates = callsOf(slack.calls, "chat.update");
    expect(updates.map((c) => c.body.ts)).toEqual([ANS_TS, PROP_TS, DRAFT_TS]);
    const answer = partsOfCall(updates[0]);
    expect(textOf(answer)).toContain(REDACTED_TEXT);
    expect(textOf(answer)).not.toContain(SLACK_COPY.sourcesLabel);
    expect(buttonsOf(answer)).toEqual([]);
    expect(textOf(partsOfCall(updates[1]))).toContain(SLACK_COPY.proposalStatus.removed);
    expect(buttonsOf(partsOfCall(updates[1]))).toEqual([]);
    expect(textOf(partsOfCall(updates[2]))).toContain(SLACK_COPY.draftStatus.hidden);
    for (const u of updates) assertSlackParts(partsOfCall(u));
    expect(vi.mocked(loadConversation).mock.calls[0].slice(1)).toEqual([CONV(1), { maxTurns: 1, surface: "slack" }]);
    expect(vi.mocked(storedTurnPayload).mock.calls[0][0]).toBe(PRINCIPAL);
    // M38: followed_at is the timestamp RPC 7 read, verbatim (microseconds included), never now().
    expect(post(ANS_TS)?.followed_at).toBe(CHANGED);
    slack.restore();

    slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(slack.calls).toHaveLength(0);
  });

  it("SW07b: a stored turn that can't be found → the removed note on the answer", async () => {
    seedAnswer();
    vi.mocked(loadTurnByMessageId).mockResolvedValue(null);
    const slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    expect(textOf(partsOfCall(callsOf(slack.calls, "chat.update")[0]))).toBe(textOf(renderNote("removed")));
  });

  it("SW07c: a card update that fails (rate limited) leaves the answer unfollowed, so the next sweep retries it", async () => {
    seedAnswer();
    let n = 0;
    const slack = useSlack({ "chat.update": (body) => (++n === 2 ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429 }) : { ok: true, channel: RI.dmChannelId, ts: body.ts }) });
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(callsOf(slack.calls, "chat.update")).toHaveLength(3);
    expect(post(ANS_TS)?.followed_at).toBeNull();
  });

  it("SW08: a draft follow-up (P4's restricted purge, no redaction) → only that card; rate limited → not marked; message_not_found → marked", async () => {
    const DTS = "1793977000.000020";
    const seed = () => {
      h = useSlackDb({
        tables: {
          exec_drafts: [{ id: DRAFT(2), principal_id: "ep_1", restricted_purged: true, updated_at: CHANGED }],
          exec_slack_posts: [ledgerRow({ ts: DTS, kind: "draft", message_id: MSG(3), ref_id: DRAFT(2) })]
        }
      });
      vi.mocked(getDraftView).mockResolvedValue(restrictedView({ id: DRAFT(2) }));
    };
    seed();
    let slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    expect(callsOf(slack.calls, "chat.update").map((c) => c.body.ts)).toEqual([DTS]);
    expect(textOf(partsOfCall(callsOf(slack.calls, "chat.update")[0]))).toContain(SLACK_COPY.draftStatus.hidden);
    expect(post(DTS)?.followed_at).toBe(CHANGED);
    slack.restore();

    seed();
    slack = useSlack({ "chat.update": slackRateLimited() });
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(post(DTS)?.followed_at).toBeNull();
    slack.restore();

    seed();
    slack = useSlack({ "chat.update": slackError("message_not_found") });
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    expect(post(DTS)?.followed_at).toBe(CHANGED);
  });

  it("SW09: an answer redacted while its reply is still placeholder isn't followed until the job ends answered", async () => {
    seedAnswer({ events: [replyEventRow({ event_id: "Ev0LIVE", reply_state: "placeholder", placeholder_ts: ANS_TS, assistant_message_id: ANSWER, updated_at: iso(NOW_MS - 1 * MIN) })] });
    let slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(slack.calls).toHaveLength(0);
    slack.restore();

    (event("Ev0LIVE") as Record<string, unknown>).reply_state = "answered";
    slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    expect(callsOf(slack.calls, "chat.update")[0].body.ts).toBe(ANS_TS);
  });

  it("SW11 (fixer security-3): a proposal card posted after its answer was followed (RPC 7 (c)) → re-rendered removed and followed on its own at the READ timestamp", async () => {
    const LATE_TS = "1793977000.000013";
    h = useSlackDb({
      tables: {
        // The answer post was followed already; the card the reply job posted afterwards has its own (null) marker.
        exec_messages: [message()],
        exec_slack_posts: [ledgerRow({ ts: ANS_TS, kind: "answer", message_id: ANSWER, followed_at: CHANGED }), ledgerRow({ ts: LATE_TS, kind: "proposal", message_id: ANSWER, ref_id: PROPOSAL(1) })],
        exec_task_proposals: [{ id: PROPOSAL(1), principal_id: "ep_1", status: "withdrawn", redacted_at: "2026-11-06T14:58:00.000Z", updated_at: CHANGED }]
      }
    });
    vi.mocked(getProposalView).mockResolvedValue(proposal({ id: PROPOSAL(1), status: "withdrawn", redacted: true }));
    let slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 1 });
    const updates = callsOf(slack.calls, "chat.update");
    expect(updates.map((c) => c.body.ts)).toEqual([LATE_TS]);
    expect(textOf(partsOfCall(updates[0]))).toContain(SLACK_COPY.proposalStatus.removed);
    expect(textOf(partsOfCall(updates[0]))).not.toContain("Call");
    expect(buttonsOf(partsOfCall(updates[0]))).toEqual([]);
    expect(vi.mocked(getProposalView).mock.calls[0][1]).toBe(PROPOSAL(1));
    expect(post(LATE_TS)?.followed_at).toBe(CHANGED);
    slack.restore();
    slack = useSlack();
    expect(await sweep()).toEqual({ swept: 0, followed: 0 });
    expect(slack.calls).toHaveLength(0);
  });
});

describe("exec.slack-dm-purge (DP01-DP05)", () => {
  const CUTOFF_MS = NOW_MS - SETTINGS.retentionDaysChat * DAY;
  const old = (n: number) => `${Math.floor(CUTOFF_MS / 1000) - 1000 + n}.000100`;
  const history = (pages: Record<string, unknown>[][], cursorForever = false): FakeSlackHandler => {
    let i = 0;
    return () => {
      const messages = pages[Math.min(i, pages.length - 1)] ?? [];
      i += 1;
      const more = cursorForever || i < pages.length;
      return { ok: true, messages, has_more: more, response_metadata: { next_cursor: more ? `c${i}` : "" } };
    };
  };
  const deleted = (calls: ReturnType<typeof useSlack>["calls"]) => callsOf(calls, "chat.delete").map((c) => String(c.body.ts));

  it("DP01: deletes only messages with our bot_id older than the cutoff (his and another bot's stay)", async () => {
    h = useSlackDb();
    const slack = useSlack({
      "conversations.history": history([[{ ts: old(1), user: RI.userId }, { ts: old(2), bot_id: "B0OTHER" }, { ts: old(3), bot_id: RI.botId }]])
    });
    expect(await purge()).toEqual({ deleted: 1, ledger: 0, scanned: 3, stoppedEarly: false });
    expect(deleted(slack.calls)).toEqual([old(3)]);
    const hist = callsOf(slack.calls, "conversations.history")[0].body;
    expect(hist).toMatchObject({ channel: RI.dmChannelId, latest: slackTsOf(CUTOFF_MS), limit: "200" });
    expect(spies[2].mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["[exec-slack] dm purge deleted=1 ledger=0 scanned=3"]);
  });

  it("DP02: an old root's thread replies with our bot_id are deleted, his replies kept, then the root if it is ours", async () => {
    h = useSlackDb();
    const slack = useSlack({
      "conversations.history": history([[{ ts: old(10), user: RI.userId, reply_count: 3 }, { ts: old(20), bot_id: RI.botId, reply_count: 1 }]]),
      "conversations.replies": (body) =>
        body.ts === old(10)
          ? { ok: true, messages: [{ ts: old(10), user: RI.userId }, { ts: old(11), bot_id: RI.botId }, { ts: old(12), user: RI.userId }, { ts: old(13), bot_id: RI.botId }] }
          : { ok: true, messages: [{ ts: old(20), bot_id: RI.botId }, { ts: old(21), user: RI.userId }] }
    });
    const out = await purge();
    expect(out).toMatchObject({ deleted: 3, ledger: 0 });
    expect(deleted(slack.calls)).toEqual([old(11), old(13), old(20)]);
    expect(callsOf(slack.calls, "conversations.replies").map((c) => [c.body.ts, c.body.latest])).toEqual([[old(10), slackTsOf(CUTOFF_MS)], [old(20), slackTsOf(CUTOFF_MS)]]);
  });

  it("DP03: stops at 80 deletes, and at 5 listing calls", async () => {
    h = useSlackDb();
    let slack = useSlack({ "conversations.history": history([Array.from({ length: 200 }, (_, i) => ({ ts: old(i + 100), bot_id: RI.botId }))], true) });
    expect(await purge()).toMatchObject({ deleted: 80 });
    expect(callsOf(slack.calls, "chat.delete")).toHaveLength(80);
    expect(callsOf(slack.calls, "conversations.history")).toHaveLength(1);
    slack.restore();

    h = useSlackDb();
    slack = useSlack({ "conversations.history": history([[{ ts: old(1), user: RI.userId }]], true) });
    expect(await purge()).toMatchObject({ deleted: 0, scanned: 5 });
    expect(callsOf(slack.calls, "conversations.history")).toHaveLength(5);
  });

  it("DP04: a rate limit ends the run early without throwing (tomorrow continues)", async () => {
    h = useSlackDb();
    let n = 0;
    const slack = useSlack({
      "conversations.history": history([[{ ts: old(1), bot_id: RI.botId }, { ts: old(2), bot_id: RI.botId }, { ts: old(3), bot_id: RI.botId }]]),
      "chat.delete": (body) => (++n === 2 ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": "30" } }) : { ok: true, channel: RI.dmChannelId, ts: body.ts })
    });
    expect(await purge()).toEqual({ deleted: 1, ledger: 0, scanned: 2, stoppedEarly: true });
    expect(callsOf(slack.calls, "chat.delete")).toHaveLength(2);
  });

  it("DP05 (C43): the ledger first: old rows (a reply under a root no history page reaches included) are deleted by ts and their rows removed (gone too); newer rows stay; the scan gets only what is left", async () => {
    const oldPosted = iso(CUTOFF_MS - DAY);
    const rows = [
      ledgerRow({ ts: old(1), kind: "answer", posted_at: oldPosted, thread_ts: old(0) }),
      ledgerRow({ ts: old(2), kind: "note", posted_at: oldPosted, thread_ts: "1700000000.000001" }),
      ledgerRow({ ts: old(3), kind: "draft", ref_id: DRAFT(1), posted_at: oldPosted }),
      ledgerRow({ ts: "1793977000.000001", kind: "answer", posted_at: iso(NOW_MS - DAY) })
    ];
    const many = Array.from({ length: 76 }, (_, i) => ledgerRow({ ts: old(100 + i), kind: "note", posted_at: oldPosted }));
    h = useSlackDb({ tables: { exec_slack_posts: [...rows, ...many] } });
    const slack = useSlack({
      "chat.delete": (body) => (body.ts === old(2) ? { ok: false, error: "message_not_found" } : { ok: true, channel: RI.dmChannelId, ts: body.ts }),
      "conversations.history": history([[{ ts: old(500), bot_id: RI.botId }, { ts: old(501), bot_id: RI.botId }, { ts: old(502), bot_id: RI.botId }]])
    });
    const out = await purge();
    expect(out).toMatchObject({ deleted: 80, ledger: 79 });
    expect(h.db.tables.exec_slack_posts.map((p) => p.ts)).toEqual(["1793977000.000001"]);
    expect(deleted(slack.calls).slice(0, 3)).toEqual([old(1), old(2), old(3)]);
    // 79 ledger deletes leave one for the backstop scan.
    expect(deleted(slack.calls).slice(79)).toEqual([old(500)]);
  });

  it("the handlers and schedules: bulk, 60 s / 120 s; every 5 minutes (1 attempt) and daily at 04:10 (2 attempts), both gated on an active installation", async () => {
    expect(slackSweepJobHandler).toMatchObject({ kind: "exec.slack-sweep", lane: "bulk", timeoutMs: 60_000 });
    expect(slackDmPurgeJobHandler).toMatchObject({ kind: "exec.slack-dm-purge", lane: "bulk", timeoutMs: 120_000 });
    expect(slackSweepScheduledWork).toMatchObject({ kind: "exec.slack-sweep", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 1 });
    expect(slackDmPurgeScheduledWork).toMatchObject({ kind: "exec.slack-dm-purge", lane: "bulk", cadence: { kind: "daily" }, maxAttempts: 2 });
    expect(slackDmPurgeScheduledWork.cadence.kind === "daily" && slackDmPurgeScheduledWork.cadence.at(SETTINGS)).toBe("04:10");
    h = useSlackDb();
    expect(await slackWorkDue(PRINCIPAL)).toBe(true);
    expect(await slackSweepScheduledWork.when?.(PRINCIPAL, SETTINGS, new Date())).toBe(true);
    h = useSlackDb({ tables: { exec_slack_installations: [] } });
    expect(await slackWorkDue(PRINCIPAL)).toBe(false);
    h = useSlackDb({ missing: ["exec_slack_installations"] });
    expect(await slackWorkDue(PRINCIPAL)).toBe(false);
    h = useSlackDb({ fail: () => ({ message: "boom", code: "08006" }) });
    await expect(slackWorkDue(PRINCIPAL)).rejects.toMatchObject({ name: "SlackStoreError" });
  });

  it("slackTsOf: an instant as a Slack ts", () => {
    expect(slackTsOf(1793977230999)).toBe("1793977230.000000");
    const m: SlackMethod = "chat.delete";
    expect(m).toBe("chat.delete");
  });
});

describe("exec.slack-dm-purge: a dead token on a history read (C17 v2)", () => {
  it("listDmItems failing token_revoked is recorded, checked once and rethrown", async () => {
    h = useSlackDb();
    useSlack({ "conversations.history": slackError("token_revoked") });
    await expect(purge()).rejects.toMatchObject({ name: "SlackApiError", code: "token_revoked" });
    expect(h.db.tables.exec_slack_installations[0].last_error_code).toBe("token_revoked");
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall")).toHaveLength(1);
  });
});
