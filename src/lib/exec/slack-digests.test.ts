import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJobs: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), recordUserTokenError: vi.fn(), enqueueUserCheck: vi.fn(), clearUserTokenError: vi.fn()
}));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn() }));
// P7a's facade at its module boundary (§4 stage 1); SLACK_CAP_FEATURES is P7a's real constant.
vi.mock("@/lib/exec/slack-reading", async () => ({
  SLACK_CAP_FEATURES: (await import("@/lib/exec/slack-read-types")).SLACK_CAP_FEATURES,
  listIntelChannels: vi.fn(), getDdBotIdentity: vi.fn(), listAuthorOptouts: vi.fn(), listOpenSlackItems: vi.fn(), readOpenSlackItems: vi.fn(),
  latestAuthorOptoutAt: vi.fn()
}));
// Area A's real store over its frozen fake; only the state gate (C1, which reads P7a's facade) is set by each test.
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), featureSpentTodayUsd: vi.fn() }));

import { installFakeSlack, slackReadError, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { createFakeSlackIntelDb, type FakeSlackIntelDb, type FakeSlackIntelDbCall } from "@/lib/exec/__tests__/fake-slack-intel-db";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { NOW, PID, PRINCIPAL, channelDbRow, historyPage, itemRow, readingInstallation, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { classifyError, enqueueJobs } from "@/lib/exec/jobs";
import { callModel } from "@/lib/exec/llm/client";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import type { ExecRequestParams } from "@/lib/exec/llm/request";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import {
  buildDigest,
  dayBounds,
  enqueueDigestRebuilds,
  listBriefSlackDigests,
  listDigestViews,
  requestTodayDigests,
  setSinceLastBriefResolver,
  sinceLastBrief,
  slackCatchUpCounts,
  slackDigestRef
} from "@/lib/exec/slack-digests";
import { isDdPost } from "@/lib/exec/slack-ingest";
import { __resetSlackIntelStoreForTests, slackIntelState } from "@/lib/exec/slack-intel-store";
import { tsOfDate, type ChannelRow, type SlackDigestPayload, type SlackIntelState } from "@/lib/exec/slack-intel-types";
import { openReader } from "@/lib/exec/slack-read";
import { SLACK_CAP_FEATURES, effectiveSlackCapUsd } from "@/lib/exec/slack-read-types";
import { getDdBotIdentity, latestAuthorOptoutAt, listAuthorOptouts, listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { SlackRateBudgetError, takeSlackBudget, noteSlackRateLimited } from "@/lib/exec/slack-rate";
import { enqueueUserCheck, recordUserTokenError } from "@/lib/exec/slack-install";
import { readHistory } from "@/lib/exec/sources/slack";
import { DIGEST_SCHEMA_V1, DIGEST_SYSTEM_PROMPT_V1 } from "@/lib/exec/triage/slack-digest";
import { BudgetExceededError, NonRetryableError, type EnqueueJobInput } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area C: slack-digests.ts (contract §3.6, §3.11.2, N3, N7, N10, N11, N13, N19, C6, C12–C15, C20, C22–C24; §5.4 DG01,
// DG07–DG18, DG20–DG24, DG26–DG28, DG30, DG31, DG33–DG35). buildDigest runs for real: P7a's paced glue and sources/slack.ts
// over fake-slack-api's fetch stub (the limiter, the user-token health writes and the reader mocked at their modules),
// Area A's store over fake-slack-intel-db (RPC 6 / RPC 7 mirrored), the pure renderer and parser; P7a's facade, the model
// (callModel) and the spend read are mocked at their module boundaries.

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./__tests__/fixtures/slack-intel/${name}`, import.meta.url), "utf8")) as T;
const CH = read<{ rows: Record<string, ChannelRow> }>("channels.json").rows;
type DayMessage = { ts: string; expect: string; ddArm?: string; raw: Record<string, unknown> };
const DAY = read<{ channelId: string; localDate: string; fromTs: string; toTs: string; history: DayMessage[]; replies: Record<string, DayMessage[]>;
  counts: Record<string, number> }>("history-day.json");
const OPTOUTS = read<{ authorUserIds: string[] }>("optouts.json").authorUserIds;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const DAY_MS = 86_400_000;

const dbChannel = (c: ChannelRow): Row => channelDbRow({
  channel_id: c.channelId, conv_type: c.convType, class: c.class, watch_state: c.watchState, mute_source: c.muteSource, name: c.name, is_private: c.isPrivate,
  finance_name: c.financeName, is_ext_shared: c.isExtShared, ext_ever: c.extEver, is_archived: c.isArchived, left_at: c.leftAt, last_activity_ts: c.lastActivityTs,
  deny_reason: c.denyReason, hub_kind: c.hubKind, im_user_id: c.imUserId
});

let db: FakeSlackIntelDb;
let channels: ChannelRow[];
let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];
const errors: unknown[] = [];

function useDb(extra: Partial<Record<string, Row[]>> = {}, before?: (call: FakeSlackIntelDbCall, d: FakeSlackIntelDb) => void): FakeSlackIntelDb {
  db = createFakeSlackIntelDb({ tables: { exec_slack_channels: Object.values(CH).map(dbChannel), ...extra } as never, ...(before ? { before } : {}) });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const digests = () => db.tables.exec_slack_digests;
const rpcCalls = (name: string) => db.calls.filter((c) => c.kind === "rpc" && c.target === name);

let slackFake: ReturnType<typeof installFakeSlack> | null = null;
/** One fake Slack per test at a time: a second install first restores the first (its unexpected calls fail the test). */
function daySlack(over: Partial<Record<string, FakeSlackHandler>> = {}) {
  slackFake?.restore();
  slackFake = installFakeSlack({
    "conversations.history": () => historyPage(DAY.history.map((h) => h.raw)),
    "conversations.replies": (body) => historyPage((DAY.replies[String(body.ts)] ?? []).map((r) => r.raw)),
    ...over
  });
  return slackFake;
}

const OUT = {
  summary: `The team agreed to ship the landing page on Friday and picked the blue variant. ${S.summary}`,
  highlights: [{ msg: "S0", text: "Someone asked whether the page can ship Friday." }],
  decisions: [{ msg: "S3", text: "The blue variant was chosen." }],
  open_questions: [],
  injection_suspected: false
};
function modelSays(answer: unknown = OUT, over: Record<string, unknown> = {}) {
  vi.mocked(callModel).mockResolvedValue({ message: { content: [{ type: "text", text: JSON.stringify(answer) }], stop_details: null } as never,
    refused: false, truncated: false, costUsd: 0.0021, latencyMs: 5, requestId: "req_1", ...over });
}
const modelRequest = (i = 0): ExecRequestParams => vi.mocked(callModel).mock.calls[i][0].request;
const modelInput = (i = 0): string => {
  const content = modelRequest(i).messages[0].content;
  return Array.isArray(content) ? content.map((b) => ("text" in b ? String(b.text) : "")).join("") : String(content);
};

const PLAN: SlackDigestPayload = { channel_id: DAY.channelId, local_date: DAY.localDate, mode: "plan" };
async function run(payload: SlackDigestPayload = PLAN, s = settings()) {
  const r = await buildDigest(PRINCIPAL, s, payload, { signal: new AbortController().signal, now: new Date() });
  results.push(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  results.length = 0;
  errors.length = 0;
  slackFake = null;
  __resetSlackIntelStoreForTests();
  channels = Object.values(CH).filter((c) => c.class !== "deny");
  useDb();
  vi.mocked(listIntelChannels).mockReset().mockImplementation(async (_p, opts) =>
    (opts?.channelIds !== undefined ? channels.filter((c) => opts.channelIds!.includes(c.channelId)) : channels).map((c) => ({ ...c })));
  vi.mocked(slackIntelState).mockReset().mockResolvedValue("ok");
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(openReader).mockReset().mockResolvedValue(readingInstallation());
  vi.mocked(getDdBotIdentity).mockReset().mockResolvedValue({ teamId: "T0SCALED", userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: NOW.toISOString() });
  vi.mocked(listAuthorOptouts).mockReset().mockResolvedValue([...OPTOUTS]);
  vi.mocked(latestAuthorOptoutAt).mockReset().mockResolvedValue(null);
  vi.mocked(readOpenSlackItems).mockReset().mockResolvedValue({ items: [], mutedHidden: 0 });
  vi.mocked(takeSlackBudget).mockReset().mockResolvedValue(undefined);
  vi.mocked(noteSlackRateLimited).mockReset().mockResolvedValue(undefined);
  vi.mocked(featureSpentTodayUsd).mockReset().mockResolvedValue(0.1);
  vi.mocked(enqueueJobs).mockReset().mockImplementation(async (inputs: readonly EnqueueJobInput[]) =>
    ({ enqueued: inputs.length, inserted: inputs.map((j, i) => ({ id: i + 1, dedupeKey: j.dedupeKey ?? null })) }));
  vi.mocked(callModel).mockReset();
  modelSays();
});

afterEach(() => {
  setSinceLastBriefResolver(null);
  // §0.3 rules 4–5: logs, job payloads, results and errors carry ids, dates, counts and codes; never Slack text, a summary,
  // a channel name or his token. (The digest row in the fake holds the AI summary: that is the store, not a leak.)
  assertNoSlackLeak({ console: out, jobs: vi.mocked(enqueueJobs), results, errors }, { label: "slack-digests" });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("dayBounds (DG17)", () => {
  it("a New York day is local midnight to local midnight, as ts strings; endsAt is the next midnight", () => {
    const b = dayBounds("2026-11-07", "America/New_York");
    expect(b).toEqual({ fromTs: DAY.fromTs, toTs: DAY.toTs, endsAt: new Date("2026-11-08T05:00:00.000Z") });
  });

  it("DST: the fall-back day is 25 hours, the spring-forward day 23; zones far from UTC and without DST", () => {
    const fall = dayBounds("2026-11-01", "America/New_York");
    expect([fall.fromTs, fall.toTs]).toEqual([tsOfDate(new Date("2026-11-01T04:00:00.000Z")), tsOfDate(new Date("2026-11-02T05:00:00.000Z"))]);
    const spring = dayBounds("2026-03-08", "America/New_York");
    expect([spring.fromTs, spring.toTs]).toEqual([tsOfDate(new Date("2026-03-08T05:00:00.000Z")), tsOfDate(new Date("2026-03-09T04:00:00.000Z"))]);
    const karachi = dayBounds("2026-11-07", "Asia/Karachi");
    expect([karachi.fromTs, karachi.toTs]).toEqual([tsOfDate(new Date("2026-11-06T19:00:00.000Z")), tsOfDate(new Date("2026-11-07T19:00:00.000Z"))]);
    const kiritimati = dayBounds("2026-11-07", "Pacific/Kiritimati");
    expect(kiritimati.fromTs).toBe(tsOfDate(new Date("2026-11-06T10:00:00.000Z")));
    const honolulu = dayBounds("2026-11-07", "Pacific/Honolulu");
    expect(honolulu.fromTs).toBe(tsOfDate(new Date("2026-11-07T10:00:00.000Z")));
  });

  it("a malformed or impossible date throws a TypeError", () => {
    for (const d of ["2026-11-31", "2026-13-01", "11/07/2026", "", "2026-11-7"]) expect(() => dayBounds(d, "America/New_York"), d).toThrow(TypeError);
  });
});

describe("buildDigest: one channel-day (DG01, DG08, DG09, DG17, DG18, DG26)", () => {
  it("yesterday's plan build: claimed for the full day, read through paced('sweep'), one Haiku call, stored built", async () => {
    const slack = daySlack();
    const r = await run();
    expect(r).toMatchObject({ outcome: "built", costUsd: 0.0021, humanCount: 5, partial: false, fullDay: true });

    // The claim: the day's bounds (the day is over: to the next midnight), retention 90 days past the day's end.
    const [claim] = rpcCalls("exec_slack_digest_claim");
    expect(claim.payload).toMatchObject({ p_principal: PID, p_channel_id: DAY.channelId, p_local_date: DAY.localDate, p_tz: "America/New_York",
      p_from_ts: DAY.fromTs, p_to_ts: DAY.toTs, p_mode: "plan", p_expires_at: new Date(Date.parse("2026-11-08T05:00:00.000Z") + 90 * DAY_MS).toISOString() });

    // Slack: one history page over the day, the replies of its one thread; each through the limiter with class sweep.
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.history", "conversations.replies"]);
    expect(slack.calls[0].body).toMatchObject({ channel: DAY.channelId, oldest: DAY.fromTs, latest: DAY.toTs, inclusive: "true", limit: "200" });
    expect(slack.calls[1].body).toMatchObject({ channel: DAY.channelId, ts: "1794060000.000100", oldest: DAY.fromTs, latest: DAY.toTs });
    expect(vi.mocked(takeSlackBudget).mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["T0SCALED", "conversations.history", "sweep"], ["T0SCALED", "conversations.replies", "sweep"]
    ]);

    // The row: counts as the fixture states them, the six messages the model saw (people only, oldest first), the AI text.
    const [row] = digests();
    expect(row).toMatchObject({ status: "built", full_day: true, privacy: "public", partial: false, injection_suspected: false,
      human_count: DAY.counts.human, bot_count: DAY.counts.bot, dd_post_count: DAY.counts.ddPost, external_count: DAY.counts.external,
      thread_count: DAY.counts.threads, model: EXEC_MODELS.digest, cost_usd: 0.0021, rebuilds: 0 });
    expect(row.source_ts).toEqual(["1794060000.000100", "1794060500.000120", "1794060900.000130", "1794061000.000110", "1794067000.000600", "1794070000.000900"]);
    expect(row.summary).toContain(S.summary);
    expect(row.highlights).toEqual([{ msg: "1794060000.000100", text: "Someone asked whether the page can ship Friday." }]);
    expect(row.decisions).toEqual([{ msg: "1794061000.000110", text: "The blue variant was chosen." }]);
    expect(row).not.toHaveProperty("excerpt");
  });

  it("DG18 the request: feature digest, Haiku 5.5, effort low, no temperature, the frozen schema and system prompt", async () => {
    daySlack();
    await run();
    expect(callModel).toHaveBeenCalledTimes(1);
    const call = vi.mocked(callModel).mock.calls[0][0];
    expect(call.feature).toBe("digest");
    expect(call.principal).toBe(PRINCIPAL);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    const req = modelRequest();
    expect(req.model).toBe(EXEC_MODELS.digest);
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.max_tokens).toBe(4_000);
    expect(req.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: DIGEST_SCHEMA_V1 } });
    expect(req.output_config?.format?.schema).not.toBe(DIGEST_SCHEMA_V1);
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("tools");
    expect(req.system).toEqual([{ type: "text", text: DIGEST_SYSTEM_PROMPT_V1 }]);
    expect(sha((req.system as { text: string }[])[0].text)).toBe("80fc3d6276fc190bc4c4ede3ca9ae1e34803a462cf294b79ad56ee83431e690d");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });

  it("DG01 pseudonyms by first appearance (him = YOU), mentions mapped to them; no Slack id, name or channel name reaches the model", async () => {
    daySlack();
    await run();
    const text = modelInput();
    const heads = [...text.matchAll(/^\[S(\d+) nonce=([0-9a-f]{16}) (\d\d:\d\d) ([A-Z0-9]+)(, reply)?\]$/gm)];
    // U0JANE first (A1), then U0SAM (A2), him (YOU), the partner (A3); the two thread replies marked.
    expect(heads.map((h) => [h[4], Boolean(h[5])])).toEqual([["A1", false], ["A2", true], ["YOU", true], ["A2", false], ["A3", false], ["YOU", false]]);
    expect(new Set(heads.map((h) => h[2])).size).toBe(1);
    expect(text).toContain(`<untrusted_slack nonce="${heads[0][2]}">`);
    expect(text).toContain("@YOU can we ship the landing page Friday?");
    for (const id of ["U0JANE", "U0SAM", "U0MITCH", "U0PARTNER", "T0SCALED", DAY.channelId]) expect(text, id).not.toContain(id);
    expect(text).not.toContain(CH.publicWatched.name as string);
    expect(text).toMatch(/^The conversation: a Slack channel \(a public channel\)\.$/m);
  });

  it("DG08 DD posts (every arm), bots, joins and hidden replies never reach the model; they are counted, and never indexed (DG26)", async () => {
    daySlack();
    await run();
    const text = modelInput();
    for (const sentinel of [S.ddText, S.botText, S.taskTitle, S.optedOutText]) expect(text).not.toContain(sentinel);
    expect(text).not.toContain("has joined the channel");
    const shownTs = digests()[0].source_ts as string[];
    for (const h of DAY.history.filter((m) => m.expect !== "human" && m.expect !== "external")) expect(shownTs).not.toContain(h.ts);
    expect(digests()[0]).toMatchObject({ bot_count: 3, dd_post_count: 3 });
    // A pointer at one past the six rendered messages is refused, so a line can't name a DD post.
    vi.mocked(callModel).mockClear();
    modelSays({ ...OUT, decisions: [{ msg: "S6", text: "Points at nothing the model saw." }] });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    db.tables.exec_slack_digests.length = 0;
    expect(await run()).toMatchObject({ outcome: "failed", code: "unknown_message" });
    expect(digests()[0]).toMatchObject({ status: "failed", summary: null });
  });

  it("DG09 an external author's message reaches the input (summarized only), is counted external, and no verbatim run over 160 survives", async () => {
    daySlack();
    const external = "we can review on Monday";
    const long = "we can review on Monday morning once the partner team has signed off on the copy, the pricing table and the legal footer, and then we push the page live before lunch for everyone to see";
    const history = DAY.history.map((h) => (h.expect === "external" ? { ...h.raw, text: long } : h.raw));
    daySlack({ "conversations.history": () => historyPage(history) });
    modelSays({ ...OUT, highlights: [{ msg: "S4", text: long }] });
    await run();
    expect(modelInput()).toContain(external);
    const [row] = digests();
    expect(row.external_count).toBe(1);
    const line = (row.highlights as { text: string }[])[0].text;
    expect(line.startsWith(long.slice(0, 140))).toBe(true);
    expect(line).not.toContain(long.slice(0, 161));
    expect(line.endsWith(` [${String.fromCodePoint(0x2026)}]`)).toBe(true);
  });

  it("DG17 a 'today so far' build reads to now and is never full-day; the day's later messages aren't read past now", async () => {
    vi.setSystemTime(new Date("2026-11-07T16:00:00.000Z"));
    daySlack();
    const r = await run({ channel_id: DAY.channelId, local_date: DAY.localDate, mode: "today" });
    expect(r).toMatchObject({ outcome: "built", fullDay: false });
    const [claim] = rpcCalls("exec_slack_digest_claim");
    expect(claim.payload).toMatchObject({ p_mode: "today", p_from_ts: DAY.fromTs, p_to_ts: tsOfDate(new Date("2026-11-07T16:00:00.000Z")) });
    const [row] = digests();
    expect(row.full_day).toBe(false);
    // His 16:46 message and the 16:20 / 16:30 posts lie after now: not part of "so far".
    expect(row.source_ts).toEqual(["1794060000.000100", "1794060500.000120", "1794060900.000130", "1794061000.000110", "1794067000.000600"]);
    // A rebuild of today is not full-day either (fullDay = now ≥ endsAt, whatever the mode).
    db.tables.exec_slack_digests[0].status = "stale";
    expect(await run({ channel_id: DAY.channelId, local_date: DAY.localDate, mode: "rebuild" })).toMatchObject({ outcome: "built", fullDay: false });
  });

  it("a future date, a malformed payload or a date past retention is not_allowed with no claim", async () => {
    const slack = daySlack();
    expect(await run({ channel_id: DAY.channelId, local_date: "2026-11-09", mode: "plan" })).toMatchObject({ outcome: "not_allowed", code: "future" });
    expect(await run({ channel_id: "bad", local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "not_allowed", code: "bad_payload" });
    expect(await run({ channel_id: DAY.channelId, local_date: DAY.localDate, mode: "later" as never })).toMatchObject({ outcome: "not_allowed" });
    expect(await run({ channel_id: DAY.channelId, local_date: "2026-07-01", mode: "rebuild" })).toMatchObject({ outcome: "not_allowed", code: "expired" });
    expect(rpcCalls("exec_slack_digest_claim")).toEqual([]);
    expect(slack.calls).toEqual([]);
  });
});

describe("DG07 / DG29: the policy before any claim or read", () => {
  const DENIED = ["publicUnwatched", "leftPrivate", "publicMuted", "publicSlackMuted", "financeMuted", "externalFinanceName", "hubOutbound", "hubClientEmail",
    "unclassified", "im", "denyLead", "ddBotDm", "selfDm"];
  it.each(DENIED)("%s → not_allowed: no claim, no Slack call, no model call", async (key) => {
    const slack = daySlack();
    const r = await run({ channel_id: CH[key].channelId, local_date: DAY.localDate, mode: "plan" });
    expect(r.outcome).toBe("not_allowed");
    expect(rpcCalls("exec_slack_digest_claim")).toEqual([]);
    expect(slack.calls).toEqual([]);
    expect(openReader).not.toHaveBeenCalled();
    expect(callModel).not.toHaveBeenCalled();
    expect(digests()).toEqual([]);
  });

  it("every state but ok → not_allowed before the channel is even read", async () => {
    const slack = daySlack();
    for (const state of ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as SlackIntelState[]) {
      vi.mocked(slackIntelState).mockResolvedValueOnce(state);
      expect(await run()).toMatchObject({ outcome: "not_allowed", code: state });
    }
    expect(listIntelChannels).not.toHaveBeenCalled();
    expect(slack.calls).toEqual([]);
  });

  it("an archived channel: no 'today' build, but its past day is digested; a watched finance channel is digested (page only)", async () => {
    daySlack();
    expect(await run({ channel_id: CH.archived.channelId, local_date: "2026-11-08", mode: "today" })).toMatchObject({ outcome: "not_allowed", code: "archived" });
    expect(await run({ channel_id: CH.archived.channelId, local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "built" });
    expect(await run({ channel_id: CH.financeWatched.channelId, local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "built" });
    expect(digests().find((d) => d.channel_id === CH.financeWatched.channelId)).toMatchObject({ privacy: "finance" });
    expect(await run({ channel_id: CH.mpim.channelId, local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "built" });
    expect(digests().find((d) => d.channel_id === CH.mpim.channelId)).toMatchObject({ privacy: "group_dm" });
    expect(await run({ channel_id: CH.externalShared.channelId, local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "built" });
    expect(digests().find((d) => d.channel_id === CH.externalShared.channelId)).toMatchObject({ privacy: "external" });
  });

  it("the switch, the state and the channel are re-checked right before the model call: 'Don't watch' mid-build → nothing is sent", async () => {
    let read = 0;
    daySlack({
      "conversations.history": () => {
        read += 1;
        // He unwatched the conversation while its history was being read.
        channels = channels.map((c) => (c.channelId === DAY.channelId ? { ...c, watchState: "unwatched" } : c));
        return historyPage(DAY.history.map((h) => h.raw));
      }
    });
    expect(await run()).toMatchObject({ outcome: "not_allowed", code: "policy_changed" });
    expect(read).toBe(1);
    expect(callModel).not.toHaveBeenCalled();
    expect(digests()[0]).toMatchObject({ status: "failed", summary: null, source_ts: [] });

    channels = Object.values(CH).filter((c) => c.class !== "deny");
    vi.mocked(slackIntelState).mockResolvedValueOnce("ok").mockResolvedValueOnce("reading_off");
    digests().length = 0;
    expect(await run()).toMatchObject({ outcome: "not_allowed", code: "policy_changed" });
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe("outcomes without a model call (DG10, DG11, DG33)", () => {
  it("DG10 nothing from a person that day → empty, counts kept, no model call", async () => {
    const history = DAY.history.filter((h) => h.expect !== "human" && h.expect !== "external").map((h) => h.raw);
    daySlack({ "conversations.history": () => historyPage(history) });
    expect(await run()).toMatchObject({ outcome: "empty", humanCount: 0, fullDay: true });
    expect(callModel).not.toHaveBeenCalled();
    expect(featureSpentTodayUsd).not.toHaveBeenCalled();
    expect(digests()[0]).toMatchObject({ status: "empty", summary: null, source_ts: [], human_count: 0, bot_count: 3, dd_post_count: 3, full_day: true });
  });

  it("DG11 the shared Slack sub-cap: SLACK_CAP_FEATURES (triage and digest) against effectiveSlackCapUsd, below the raw cap too", async () => {
    daySlack();
    // 20 % of a $5 daily cap = $1, under the raw $2 Slack cap: $1.50 spent is over the effective one.
    const s = settings({ dailyCostCapUsd: 5, slackDailyCapUsd: 2 });
    expect(effectiveSlackCapUsd(s)).toBe(1);
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(1.5);
    expect(await run(PLAN, s)).toMatchObject({ outcome: "skipped_cap", costUsd: null });
    expect(callModel).not.toHaveBeenCalled();
    const [pid, tz, features, at] = vi.mocked(featureSpentTodayUsd).mock.calls[0];
    expect([pid, tz, at]).toEqual([PID, "America/New_York", NOW]);
    expect(features).toBe(SLACK_CAP_FEATURES);
    expect([...features]).toEqual(["slack_triage", "digest"]);
    expect(digests()[0]).toMatchObject({ status: "skipped_cap", summary: null, source_ts: [], human_count: 5 });

    // Just under the effective cap → built; exactly at it → skipped.
    digests().length = 0;
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(0.99);
    expect(await run(PLAN, s)).toMatchObject({ outcome: "built" });
    digests().length = 0;
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(1);
    expect(await run(PLAN, s)).toMatchObject({ outcome: "skipped_cap" });
  });

  it("DG11 a spend read failure (or a non-number) → failed, fail closed, no model call", async () => {
    daySlack();
    vi.mocked(featureSpentTodayUsd).mockRejectedValueOnce(new Error("usage read failed"));
    expect(await run()).toMatchObject({ outcome: "failed", code: "spend_unavailable" });
    digests().length = 0;
    vi.mocked(featureSpentTodayUsd).mockResolvedValueOnce(Number.NaN);
    expect(await run()).toMatchObject({ outcome: "failed", code: "spend_unavailable" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("DG33 opted-out authors are dropped before anything is kept: never rendered, never counted", async () => {
    daySlack();
    await run();
    expect(modelInput()).not.toContain(S.optedOutText);
    expect(digests()[0].source_ts).not.toContain("1794068000.000700");
    const c = digests()[0];
    expect(Number(c.human_count) + Number(c.external_count) + Number(c.bot_count) + Number(c.dd_post_count)).toBe(DAY.history.length - 1 + 2);
  });

  it("DG33 (fixer correctness-5) an opted-out author's threads are dropped whole, root and replies, uncounted and unread", async () => {
    const OPT = OPTOUTS[0];
    const at = (h: number, frac = "000100") => `${Number(DAY.fromTs.split(".")[0]) + h * 3600}.${frac}`;
    const optRoot = at(10);
    const janeRoot = at(11);
    const history = [
      { type: "message", user: OPT, team: "T0SCALED", text: `${S.optedOutText} root`, ts: optRoot, thread_ts: optRoot, reply_count: 1, latest_reply: at(10, "000900") },
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "TAINTED-ROOT-MARKER question", ts: janeRoot, thread_ts: janeRoot, reply_count: 1, latest_reply: at(11, "000900") },
      { type: "message", user: "U0SAM", team: "T0SCALED", text: "The blue variant ships Friday.", ts: at(12) }
    ];
    const replies: Record<string, Record<string, unknown>[]> = {
      [optRoot]: [history[0], { type: "message", user: "U0SAM", team: "T0SCALED", text: "TAINTED-REPLY-MARKER as they said", ts: at(10, "000900"), thread_ts: optRoot, parent_user_id: OPT }],
      [janeRoot]: [history[1], { type: "message", user: OPT, team: "T0SCALED", text: `${S.optedOutText} reply`, ts: at(11, "000900"), thread_ts: janeRoot, parent_user_id: "U0JANE" }]
    };
    const slack = daySlack({ "conversations.history": () => historyPage(history), "conversations.replies": (body) => historyPage(replies[String(body.ts)] ?? []) });
    modelSays({ summary: "A release date was set.", highlights: [{ msg: "S0", text: "Someone set the release day." }], decisions: [], open_questions: [], injection_suspected: false });
    expect(await run()).toMatchObject({ outcome: "built", humanCount: 1 });
    const input = modelInput();
    for (const never of [S.optedOutText, "TAINTED-ROOT-MARKER", "TAINTED-REPLY-MARKER"]) expect(input).not.toContain(never);
    expect(input).toContain("The blue variant ships Friday.");
    // The opted-out author's own thread is never read; the colleague's is (that is how the reply is found).
    expect(slack.calls.filter((c) => c.method === "conversations.replies").map((c) => c.body.ts)).toEqual([janeRoot]);
    expect(digests()[0]).toMatchObject({ status: "built", source_ts: [at(12)], human_count: 1, external_count: 0, bot_count: 0, dd_post_count: 0 });
  });

  it("DG33 an opt-out list that can't be read → failed before any Slack read or model call", async () => {
    const slack = daySlack();
    vi.mocked(listAuthorOptouts).mockRejectedValueOnce(new Error("store down"));
    expect(await run()).toMatchObject({ outcome: "failed", code: "optouts_unavailable" });
    expect(slack.calls).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(digests()[0]).toMatchObject({ status: "failed" });
  });

  it("no reader (reading half gone or paused at P7a) → failed, no Slack call", async () => {
    const slack = daySlack();
    vi.mocked(openReader).mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ outcome: "failed", code: "no_reader" });
    expect(slack.calls).toEqual([]);
  });
});

describe("the model's answer (DG12)", () => {
  it("refusal → failed; truncation → failed; invalid output → failed with its reason; each keeps the cost, no text", async () => {
    daySlack();
    modelSays(OUT, { refused: true });
    expect(await run()).toMatchObject({ outcome: "failed", code: "refused", costUsd: 0.0021 });
    expect(digests()[0]).toMatchObject({ status: "failed", summary: null, cost_usd: 0.0021 });
    for (const [over, answer, code] of [[{ truncated: true }, OUT, "truncated"], [{}, { summary: 1 }, "invalid_output"], [{}, { ...OUT, summary: " " }, "empty_summary"]] as const) {
      modelSays(answer, over);
      expect(await run()).toMatchObject({ outcome: "failed", code });
      expect(digests()[0]).toMatchObject({ status: "failed", summary: null });
    }
  });

  it("BudgetExceededError (the daily cap) → skipped_cap; another model error → failed", async () => {
    daySlack();
    vi.mocked(callModel).mockRejectedValueOnce(new BudgetExceededError(15, 15));
    expect(await run()).toMatchObject({ outcome: "skipped_cap" });
    expect(digests()[0]).toMatchObject({ status: "skipped_cap" });
    vi.mocked(callModel).mockRejectedValueOnce(Object.assign(new Error("overloaded"), { name: "APIError" }));
    expect(await run()).toMatchObject({ outcome: "failed", code: "APIError" });
  });

  it("injection_suspected is stored and logged as a flag only", async () => {
    daySlack();
    modelSays({ ...OUT, injection_suspected: true });
    expect(await run()).toMatchObject({ outcome: "built" });
    expect(digests()[0].injection_suspected).toBe(true);
    expect(out.calls().flat().join(" ")).toContain("injection_suspected=1");
  });
});

describe("RPC 7's outcomes (DG13, DG14, DG35)", () => {
  const optOutDuringFinish = (call: FakeSlackIntelDbCall, d: FakeSlackIntelDb) => {
    if (call.kind === "rpc" && call.target === "exec_slack_digest_finish") {
      d.tables.exec_slack_author_optouts.push({ principal_id: PID, author_user_id: "U0SAM", created_at: new Date().toISOString() });
    }
  };

  it("DG13 deleted_source (an author opted out while the model wrote) → stale, no text, and a rebuild job within 7 days", async () => {
    useDb({}, optOutDuringFinish);
    daySlack();
    expect(await run()).toMatchObject({ outcome: "deleted_source" });
    expect(digests()[0]).toMatchObject({ status: "stale", summary: null, source_ts: [], rebuilds: 1 });
    const jobs = vi.mocked(enqueueJobs).mock.calls.flatMap((c) => c[0]);
    expect(jobs).toEqual([expect.objectContaining({ kind: "exec.slack-digest", lane: "bulk", principalId: PID, maxAttempts: 2,
      payload: { channel_id: DAY.channelId, local_date: DAY.localDate, mode: "rebuild" }, dedupeKey: `slkdig:${PID}:${DAY.channelId}:${DAY.localDate}:r1` })]);
  });

  it("DG13 a deleted marker on a source ts → deleted_source; a day older than 7 days gets no rebuild", async () => {
    useDb({ exec_slack_deleted: [{ principal_id: PID, channel_id: DAY.channelId, ts: "1794061000.000110", reason: "event", deleted_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() }] });
    daySlack();
    expect(await run()).toMatchObject({ outcome: "deleted_source" });
    expect(vi.mocked(enqueueJobs).mock.calls.flatMap((c) => c[0])).toHaveLength(1);

    vi.mocked(enqueueJobs).mockClear();
    useDb({}, optOutDuringFinish);
    const old = "2026-10-30";
    const b = dayBounds(old, "America/New_York");
    const ts = `${Number(b.fromTs.split(".")[0]) + 3600}.000100`;
    daySlack({ "conversations.history": () => historyPage([{ type: "message", user: "U0JANE", team: "T0SCALED", text: "an old note", ts }]),
      "conversations.replies": () => historyPage([]) });
    modelSays({ ...OUT, decisions: [] });
    expect(await run({ channel_id: DAY.channelId, local_date: old, mode: "rebuild" })).toMatchObject({ outcome: "deleted_source" });
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it("DG14 lost: the digest was blanked mid-build (RPC 8 made it stale) → nothing written, result lost", async () => {
    useDb({}, (call, d) => {
      if (call.kind === "rpc" && call.target === "exec_slack_digest_finish") Object.assign(d.tables.exec_slack_digests[0], { status: "stale", rebuilds: 1 });
    });
    daySlack();
    expect(await run()).toMatchObject({ outcome: "lost" });
    expect(digests()[0]).toMatchObject({ status: "stale", summary: null, rebuilds: 1 });
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it("DG35 channel_gone: he left the conversation (or it was reclassified) while the model wrote → not_allowed, the row is gone, no rebuild", async () => {
    for (const change of [{ left_at: NOW.toISOString(), watch_state: "unwatched" }, { class: "hub", hub_kind: "outbound" }, { class: "deny", deny_reason: "fb_lead" }]) {
      useDb({}, (call, d) => {
        if (call.kind === "rpc" && call.target === "exec_slack_digest_finish") {
          Object.assign(d.tables.exec_slack_channels.find((c) => c.channel_id === DAY.channelId)!, change);
        }
      });
      daySlack();
      expect(await run()).toMatchObject({ outcome: "not_allowed", code: "channel_gone" });
      expect(digests()).toEqual([]);
    }
    expect(enqueueJobs).not.toHaveBeenCalled();
  });
});

describe("live reads (DG15, DG16, DG28)", () => {
  it("DG15 the limiter refuses (SlackRateBudgetError) → failed with no Slack call; nothing else read", async () => {
    const slack = daySlack();
    vi.mocked(takeSlackBudget).mockRejectedValueOnce(new SlackRateBudgetError(30_000));
    expect(await run()).toMatchObject({ outcome: "failed", code: "rate_limited" });
    expect(slack.calls).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(digests()[0]).toMatchObject({ status: "failed", summary: null });
    // A time-boxed pass may wait into the limiter's next window (P7a's boxedWaitMs), never past its box.
    const opts = vi.mocked(takeSlackBudget).mock.calls[0][3] as { maxWaitMs?: number };
    expect(opts.maxWaitMs).toBeGreaterThan(0);
    expect(opts.maxWaitMs).toBeLessThanOrEqual(61_000);
  });

  it("DG15 Slack answers ratelimited → failed, the method is blocked for P7a's classes, no further calls", async () => {
    const slack = daySlack({ "conversations.history": () => slackReadError("ratelimited") });
    expect(await run()).toMatchObject({ outcome: "failed", code: "rate_limited" });
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.history"]);
    expect(noteSlackRateLimited).toHaveBeenCalledWith("T0SCALED", "conversations.history", expect.any(Number));
    expect(callModel).not.toHaveBeenCalled();
  });

  it("DG15 a ratelimited thread read ends the reads too (the day is not summarized half-read)", async () => {
    const slack = daySlack({ "conversations.replies": () => slackReadError("ratelimited") });
    expect(await run()).toMatchObject({ outcome: "failed", code: "rate_limited" });
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.history", "conversations.replies"]);
  });

  it("DG16 history paging stops at 5 pages (partial); replies only for parents posted that day, at most 10", async () => {
    const parents = Array.from({ length: 12 }, (_v, i) => ({ type: "message", user: "U0JANE", team: "T0SCALED", text: `topic ${i}`,
      ts: `${1794060000 + i * 100}.000100`, thread_ts: `${1794060000 + i * 100}.000100`, reply_count: 1 }));
    const before = { type: "message", user: "U0SAM", team: "T0SCALED", text: "yesterday's thread", ts: "1794020000.000100",
      thread_ts: "1794020000.000100", reply_count: 4 };
    let page = 0;
    const slack = daySlack({
      "conversations.history": () => {
        page += 1;
        return historyPage(page === 1 ? [...parents, before] : [], { hasMore: true, nextCursor: `c${page}` });
      },
      "conversations.replies": (body) => historyPage([{ type: "message", user: "U0SAM", team: "T0SCALED", text: "a reply", ts: `${Number(String(body.ts).split(".")[0]) + 5}.000200`,
        thread_ts: String(body.ts) }])
    });
    modelSays({ ...OUT, decisions: [] });
    const r = await run();
    expect(r).toMatchObject({ outcome: "built", partial: true });
    const history = slack.calls.filter((c) => c.method === "conversations.history");
    expect(history).toHaveLength(5);
    expect(history.map((c) => c.body.cursor ?? null)).toEqual([null, "c1", "c2", "c3", "c4"]);
    const replies = slack.calls.filter((c) => c.method === "conversations.replies");
    expect(replies).toHaveLength(10);
    // The newest ten parents of the day; never the thread whose root is the day before.
    expect(replies.map((c) => c.body.ts)).toEqual(parents.slice(2).reverse().map((p) => p.ts));
    expect(digests()[0]).toMatchObject({ partial: true, thread_count: 10 });
  });

  it("DG16 a replies page with more → partial; a thread gone meanwhile (thread_not_found) is skipped, not a failure", async () => {
    daySlack({ "conversations.replies": () => slackReadError("thread_not_found") });
    expect(await run()).toMatchObject({ outcome: "built" });
    expect(digests()[0]).toMatchObject({ thread_count: 0, human_count: 3 });
    digests().length = 0;
    daySlack({ "conversations.replies": (body) => historyPage((DAY.replies[String(body.ts)] ?? []).map((r) => r.raw), { hasMore: true, nextCursor: "x" }) });
    expect(await run()).toMatchObject({ outcome: "built", partial: true });
  });

  it("DG28 a revoked reading token mid-build (an auth answer through paced) → failed, and the error keeps errorClass auth (no retry)", async () => {
    daySlack({ "conversations.replies": () => slackReadError("token_revoked") });
    let thrown: unknown = null;
    try {
      await run();
    } catch (err) {
      thrown = err;
      errors.push(err);
    }
    expect(thrown).not.toBeNull();
    expect(classifyError(thrown)).toBe("auth");
    expect(digests()[0]).toMatchObject({ status: "failed", summary: null });
    expect(recordUserTokenError).toHaveBeenCalledWith(readingInstallation().row.id, "token_revoked");
    expect(enqueueUserCheck).toHaveBeenCalled();
    expect(callModel).not.toHaveBeenCalled();
  });

  it("DG28 the reading token our key can't open (openReader's auth NonRetryableError) → failed and rethrown as auth", async () => {
    daySlack();
    vi.mocked(openReader).mockRejectedValueOnce(new NonRetryableError("slack reading token unavailable", "auth"));
    const err = await run().catch((e: unknown) => e);
    errors.push(err);
    expect(classifyError(err)).toBe("auth");
    expect(digests()[0]).toMatchObject({ status: "failed" });
  });

  it("the job's abort is rethrown after a best-effort failed finish", async () => {
    const ctl = new AbortController();
    daySlack({ "conversations.history": () => {
      ctl.abort(new Error("lease lost"));
      return historyPage([]);
    } });
    const err = await buildDigest(PRINCIPAL, settings(), PLAN, { signal: ctl.signal, now: new Date() }).catch((e: unknown) => e);
    errors.push(err);
    expect(err).toBeInstanceOf(Error);
    expect(digests()[0]).toMatchObject({ status: "failed" });
  });
});

describe("DD posts (DG34; P7a's isDdPost)", () => {
  it("DG34 the DD bot user, the DD app id and DD's template (posted as a teammate) are all dropped and counted ddPost", async () => {
    daySlack();
    await run();
    expect(digests()[0].dd_post_count).toBe(3);
    const ddBot = { userId: "U0DDBOT", appId: "A0DDAPP" };
    const parsed = (await readHistoryOf(DAY.history.filter((h) => h.expect === "ddPost").map((h) => h.raw)));
    expect(parsed.map((m) => isDdPost(m, ddBot))).toEqual([true, true, true]);
  });

  it("DG34 getDdBotIdentity null (or failing): the template arm still drops; the bot-authored one is still not a person", async () => {
    for (const setup of [() => vi.mocked(getDdBotIdentity).mockResolvedValueOnce(null), () => vi.mocked(getDdBotIdentity).mockRejectedValueOnce(new Error("x"))]) {
      digests().length = 0;
      vi.mocked(callModel).mockClear();
      setup();
      daySlack();
      expect(await run()).toMatchObject({ outcome: "built" });
      const text = modelInput();
      // The template arm (DD's task card posted as a teammate) is dropped whatever the identity.
      expect(text).not.toContain("Task update");
      expect(text).not.toContain(S.taskTitle);
      // The app-arm post carries a bot id: counted a bot, never rendered.
      expect(text).not.toContain("New SEO task");
      expect(digests()[0]).toMatchObject({ dd_post_count: 1, bot_count: 4 });
      // Known gap of "null tolerated" (§3.11.2 step 5): a plain as-user post by the DD bot user, with no template, is then a
      // person's message. DD's own posts carry its template or its bot / app ids, so this is a message DD itself never sends.
      expect(text).toContain("Reminder");
    }
  });
});

async function readHistoryOf(raws: Record<string, unknown>[]) {
  const slack = installFakeSlack({ "conversations.history": () => historyPage(raws) });
  const r = await readHistory(readingInstallation().target, { channel: DAY.channelId, limit: 200 });
  slack.restore();
  return r.messages;
}

describe("concurrency and reclaims (DG27, DG30, DG31)", () => {
  it("DG27 two builds of one day: one claims, the other is busy (no Slack read, no model call)", async () => {
    let second: unknown = null;
    daySlack({
      "conversations.history": async () => {
        if (second === null) second = await run();
        return historyPage(DAY.history.map((h) => h.raw));
      }
    });
    const first = await run();
    expect(first).toMatchObject({ outcome: "built" });
    expect(second).toEqual({ outcome: "busy", costUsd: null });
    expect(rpcCalls("exec_slack_digest_claim")).toHaveLength(2);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("DG30 a 'today' build at 11:00 is finished by the 00:30 plan for that date (full day); a plan on a full-day row is fresh", async () => {
    vi.setSystemTime(new Date("2026-11-07T16:00:00.000Z"));
    daySlack();
    expect(await run({ channel_id: DAY.channelId, local_date: DAY.localDate, mode: "today" })).toMatchObject({ outcome: "built", fullDay: false });
    expect(digests()[0]).toMatchObject({ full_day: false });
    expect((digests()[0].source_ts as string[]).length).toBe(5);

    vi.setSystemTime(new Date("2026-11-08T05:30:00.000Z"));
    expect(await run()).toMatchObject({ outcome: "built", fullDay: true });
    expect(digests()).toHaveLength(1);
    expect(digests()[0]).toMatchObject({ status: "built", full_day: true, rebuilds: 0 });
    expect((digests()[0].source_ts as string[]).length).toBe(6);

    expect(await run()).toEqual({ outcome: "fresh", costUsd: null });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("DG31 a yesterday row skipped by the cap late in the day is rebuilt by the 00:30 plan", async () => {
    daySlack();
    vi.mocked(featureSpentTodayUsd).mockResolvedValueOnce(5);
    expect(await run()).toMatchObject({ outcome: "skipped_cap" });
    expect(digests()[0]).toMatchObject({ status: "skipped_cap" });
    expect(await run()).toMatchObject({ outcome: "built", fullDay: true });
    expect(digests()[0]).toMatchObject({ status: "built", full_day: true });
  });
});

describe("enqueues (DG13, DG20)", () => {
  it("DG20 requestTodayDigests: at most `max` channels needing a build; one built within the hour isn't enqueued (nor counted); one building counts", async () => {
    const today = "2026-11-08";
    const recent = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    useDb({ exec_slack_digests: [
      { id: `esd_${"a".repeat(32)}`, principal_id: PID, channel_id: "C0ACMESEO", local_date: today, tz: "America/New_York", from_ts: "1794114000.000000",
        to_ts: "1794140000.000000", status: "built", summary: "x", source_ts: ["1794120000.000100"], built_at: recent, requested_at: recent, expires_at: "2027-02-01T00:00:00.000Z" },
      { id: `esd_${"b".repeat(32)}`, principal_id: PID, channel_id: "C0PRIVOPS", local_date: today, tz: "America/New_York", from_ts: "1794114000.000000",
        to_ts: "1794140000.000000", status: "building", requested_at: new Date(NOW.getTime() - 60_000).toISOString(), expires_at: "2027-02-01T00:00:00.000Z" },
      { id: `esd_${"c".repeat(32)}`, principal_id: PID, channel_id: "C0DESIGN", local_date: today, tz: "America/New_York", from_ts: "1794114000.000000",
        to_ts: "1794140000.000000", status: "built", summary: "x", source_ts: ["1794120000.000100"], built_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        requested_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), expires_at: "2027-02-01T00:00:00.000Z" }
    ] });
    const got = await requestTodayDigests(PRINCIPAL, ["C0ACMESEO", "C0PRIVOPS", "C0DESIGN", "G0MPIMTEAM", "C0PARTNER", "C0EXEVER", "bad"], NOW, 3);
    expect(got).toEqual(["C0PRIVOPS", "C0DESIGN", "G0MPIMTEAM"]);
    const jobs = vi.mocked(enqueueJobs).mock.calls.flatMap((c) => c[0]);
    const hour = Math.floor(NOW.getTime() / 3_600_000);
    expect(jobs.map((j) => [j.payload, j.dedupeKey])).toEqual([
      [{ channel_id: "C0DESIGN", local_date: today, mode: "today" }, `slkdig:${PID}:C0DESIGN:${today}:t${hour}`],
      [{ channel_id: "G0MPIMTEAM", local_date: today, mode: "today" }, `slkdig:${PID}:G0MPIMTEAM:${today}:t${hour}`]
    ]);
    expect(jobs.every((j) => j.kind === "exec.slack-digest" && j.lane === "bulk" && j.maxAttempts === 2)).toBe(true);
    expect(await requestTodayDigests(PRINCIPAL, ["C0ACMESEO"], NOW, 1)).toEqual([]);
    expect(await requestTodayDigests(PRINCIPAL, ["C0ACMESEO", "G0MPIMTEAM"], NOW, 0)).toEqual([]);
  });

  it("enqueueDigestRebuilds: within 7 days of today only, newest first, ≤ max, one per (channel, date), r<rebuilds> or q<planDate> keys, staggered", async () => {
    const rows = [
      { channelId: "C0ACMESEO", localDate: "2026-11-05", rebuilds: 2 }, { channelId: "C0ACMESEO", localDate: "2026-11-01", rebuilds: 1 },
      { channelId: "C0PRIVOPS", localDate: "2026-11-07", rebuilds: 1 }, { channelId: "C0PRIVOPS", localDate: "2026-11-07", rebuilds: 3 },
      { channelId: "C0OLD", localDate: "2026-10-31", rebuilds: 1 }, { channelId: "C0FUTURE", localDate: "2026-11-09", rebuilds: 0 },
      { channelId: "x", localDate: "2026-11-07", rebuilds: 1 }
    ];
    expect(await enqueueDigestRebuilds(PRINCIPAL, rows, NOW, { max: 10 })).toBe(3);
    const jobs = vi.mocked(enqueueJobs).mock.calls[0][0];
    expect(jobs.map((j) => j.dedupeKey)).toEqual([`slkdig:${PID}:C0PRIVOPS:2026-11-07:r1`, `slkdig:${PID}:C0ACMESEO:2026-11-05:r2`, `slkdig:${PID}:C0ACMESEO:2026-11-01:r1`]);
    expect(jobs.map((j) => (j.runAfter as Date).getTime() - NOW.getTime())).toEqual([0, 20_000, 40_000]);
    expect(jobs.every((j) => (j.payload as Record<string, unknown>).mode === "rebuild")).toBe(true);
    vi.mocked(enqueueJobs).mockClear();
    expect(await enqueueDigestRebuilds(PRINCIPAL, rows, NOW, { max: 1, planDate: "2026-11-07" })).toBe(1);
    expect(vi.mocked(enqueueJobs).mock.calls[0][0].map((j) => j.dedupeKey)).toEqual([`slkdig:${PID}:C0PRIVOPS:2026-11-07:q2026-11-07`]);
    expect(await enqueueDigestRebuilds(PRINCIPAL, rows, NOW, { max: 0 })).toBe(0);
    await expect(enqueueDigestRebuilds(PRINCIPAL, rows, NOW, { max: 1, planDate: "nope" })).rejects.toThrow(TypeError);
  });
});

describe("reading digests (DG21, DG24, DG29)", () => {
  const row = (channelId: string, localDate: string, over: Row = {}): Row => ({
    id: `esd_${createHash("md5").update(channelId + localDate).digest("hex")}`, principal_id: PID, channel_id: channelId, local_date: localDate, tz: "America/New_York",
    from_ts: DAY.fromTs, to_ts: DAY.toTs, status: "built", summary: `A summary of ${channelId}.`, highlights: [{ msg: "1794060000.000100", text: "A highlight." }],
    decisions: [{ msg: "1794060000.000100", text: "A decision." }], open_questions: [{ msg: "1794060000.000100", text: "A question?" }],
    source_ts: ["1794060000.000100"], human_count: 3, full_day: true, privacy: "public", built_at: NOW.toISOString(), requested_at: NOW.toISOString(),
    expires_at: "2027-02-01T00:00:00.000Z", ...over
  });
  const link = (channelId: string, clientId: string | null, tag: boolean): Row => ({ principal_id: PID, channel_id: channelId,
    tag_client_id: tag ? clientId : null, tag_client_name: tag ? S.clientName : null, tag_project_ids: [], tagged_at: tag ? NOW.toISOString() : null,
    rule_client_id: tag ? null : clientId, rule_client_name: tag ? null : clientId === null ? null : "Rule Client", rule_candidates: clientId === null ? 0 : 1,
    checked_at: NOW.toISOString() });

  it("DG21 listBriefSlackDigests: built digests of the date, policy brief (no finance, no muted), ranked high-linked first, then people; ≤ 6", async () => {
    const date = DAY.localDate;
    useDb({
      exec_slack_digests: [
        row("C0ACMESEO", date, { human_count: 2 }), row("C0PRIVOPS", date, { human_count: 9, privacy: "private" }), row("G0MPIMTEAM", date, { human_count: 4, privacy: "group_dm" }),
        row("C0PAYROLL", date, { human_count: 50, privacy: "finance" }), row("C0DESIGN", date, { human_count: 40 }), row("C0PARTNER", date, { human_count: 1, privacy: "external" }),
        row("C0EXEVER", date, { human_count: 5, privacy: "external" }), row("C0OLDLAUNCH", date, { human_count: 6 }), row("C0RANDOM", date, { human_count: 30 }),
        row("C0LEFTPRIV", date, { human_count: 30 }), row("C0ACMESEO", "2026-11-06", { human_count: 99 }),
        row("C0LAUNCH", date, { status: "failed", summary: null, highlights: [], decisions: [], open_questions: [], source_ts: [] })
      ],
      exec_slack_channel_links: [link("C0PARTNER", "cl_partner", true), link("C0ACMESEO", "cl_acme", false)]
    });
    const got = await listBriefSlackDigests(PRINCIPAL, { localDate: date });
    expect(got.map((d) => d.channelId)).toEqual(["C0PARTNER", "C0PRIVOPS", "C0OLDLAUNCH", "C0EXEVER", "G0MPIMTEAM", "C0ACMESEO"]);
    expect(got[0]).toMatchObject({ clientId: "cl_partner", privacy: "external", channelLabel: "#partner-collab", localDate: date, summary: "A summary of C0PARTNER.",
      decisions: ["A decision."], openQuestions: ["A question?"] });
    expect(got[0].ref).toEqual({ system: "slack", id: `C0PARTNER:d:${date}`, url: `https://operations.scaledai.org/executive/slack?date=${date}#ch-C0PARTNER`,
      label: `Digest: #partner-collab, ${date}`, class: "private" });
    // A low (name-rule) link doesn't rank and gives no client.
    expect(got.find((d) => d.channelId === "C0ACMESEO")).toMatchObject({ clientId: null });
    expect(got.find((d) => d.channelId === "G0MPIMTEAM")).toMatchObject({ channelLabel: "Group DM", privacy: "group_dm" });

    vi.mocked(slackIntelState).mockResolvedValueOnce("reading_off");
    expect(await listBriefSlackDigests(PRINCIPAL, { localDate: date })).toEqual([]);
    expect(await listBriefSlackDigests(PRINCIPAL, { localDate: "bad" })).toEqual([]);
  });

  it("slackDigestRef: the DD page of the day, allow-listed; private unless explicitly public", () => {
    expect(slackDigestRef({ channelId: "C0ACMESEO", localDate: "2026-11-07" }, "#acme-dental-seo", false)).toEqual({ system: "slack", id: "C0ACMESEO:d:2026-11-07",
      url: "https://operations.scaledai.org/executive/slack?date=2026-11-07#ch-C0ACMESEO", label: "Digest: #acme-dental-seo, 2026-11-07", class: "public" });
    expect(slackDigestRef({ channelId: "C0ACMESEO", localDate: "2026-11-07" }, "", true).class).toBe("private");
  });

  it("DG24 listDigestViews: every status mapped, text only on built cards; not_built only for channels active that day; never an im", async () => {
    const date = DAY.localDate;
    const statuses = ["built", "empty", "stale", "failed", "skipped_cap", "building"] as const;
    const watched = ["C0ACMESEO", "C0PRIVOPS", "G0MPIMTEAM", "C0PAYROLL", "C0PARTNER", "C0EXEVER"];
    useDb({
      exec_slack_digests: statuses.map((s, i) => row(watched[i], date, s === "built" ? {} : { status: s, summary: null, highlights: [], decisions: [], open_questions: [],
        source_ts: s === "empty" ? ["1794060000.000100"] : [], full_day: s === "empty" })),
      exec_slack_channel_links: [link("C0ACMESEO", "cl_acme", true)]
    });
    channels = channels.map((c) => (c.channelId === "C0OLDLAUNCH" ? { ...c, lastActivityTs: "1794000000.000100" } : c));
    const cards = await listDigestViews(PRINCIPAL, "ok", { dates: [date], use: "page", limit: 30 }, { now: NOW });
    // The tagged (high) channel first, then (all with 3 people) by channel id.
    expect(cards.map((c) => [c.channelId, c.status])).toEqual([
      ["C0ACMESEO", "built"], ["C0EXEVER", "building"], ["C0PARTNER", "skipped_cap"], ["C0PAYROLL", "failed"], ["C0PRIVOPS", "empty"], ["G0MPIMTEAM", "stale"]
    ]);
    const built = cards.find((c) => c.channelId === "C0ACMESEO")!;
    expect(built).toMatchObject({ digestId: expect.stringMatching(/^esd_/), channelLabel: "#acme-dental-seo", privacy: "public", date, summary: "A summary of C0ACMESEO.",
      highlights: [{ text: "A highlight.", permalink: null }], decisions: [{ text: "A decision.", permalink: null }], openQuestions: [{ text: "A question?", permalink: null }],
      counts: { human: 3, bot: 0, ddPost: 0, external: 0, threads: 0 }, partial: false, canBuild: false, clientName: S.clientName });
    for (const c of cards.filter((x) => x.status !== "built")) expect([c.summary, c.highlights, c.decisions, c.openQuestions]).toEqual([null, [], [], []]);
    expect(cards.find((c) => c.channelId === "C0PAYROLL")).toMatchObject({ privacy: "finance" });
    // Active that day with no row → not_built; C0OLDLAUNCH's last activity is before the day: no card; the im and the muted / unwatched / left never.
    const notBuilt = cards.filter((c) => c.status === "not_built").map((c) => c.channelId);
    expect(notBuilt).toEqual([]);
    for (const id of ["D0JANE", "C0DESIGN", "C0RANDOM", "C0LEFTPRIV", "C0OLDLAUNCH", "C0FINANCE", "C0OUTBOUND"]) expect(cards.map((c) => c.channelId)).not.toContain(id);

    // Today: nothing built yet → not_built for the watched channels active today, buildable (not archived).
    const today = await listDigestViews(PRINCIPAL, "ok", { dates: ["2026-11-08"], use: "page", limit: 30 }, { now: NOW });
    expect(today.every((c) => c.status === "not_built" && c.digestId === null && c.counts === null)).toBe(true);
    expect(today.map((c) => c.channelId).sort()).toEqual(["C0ACMESEO", "C0EXEVER", "C0PARTNER", "C0PAYROLL", "C0PRIVOPS", "G0MPIMTEAM"]);
    expect(today.every((c) => c.canBuild)).toBe(true);
    // chat_slack never shows finance; a limit cuts; a state that isn't ok shows nothing.
    const slackSurface = await listDigestViews(PRINCIPAL, "ok", { dates: [date], use: "chat_slack", limit: 2 }, { now: NOW });
    expect(slackSurface).toHaveLength(2);
    expect((await listDigestViews(PRINCIPAL, "ok", { dates: [date], use: "chat_slack", limit: 30 }, { now: NOW })).map((c) => c.channelId)).not.toContain("C0PAYROLL");
    expect(await listDigestViews(PRINCIPAL, "discovering", { dates: [date], use: "page", limit: 30 })).toEqual([]);
  });

  it("DG24 the order: newest date first, then cards with a row, high-linked, more people, channel id", async () => {
    useDb({ exec_slack_digests: [row("C0PRIVOPS", "2026-11-06", { human_count: 9 }), row("C0ACMESEO", "2026-11-07", { human_count: 1 }),
      row("C0PRIVOPS", "2026-11-07", { human_count: 9 }), row("G0MPIMTEAM", "2026-11-07", { human_count: 9 })],
      exec_slack_channel_links: [link("C0ACMESEO", "cl_acme", true)] });
    const cards = await listDigestViews(PRINCIPAL, "ok", { dates: ["2026-11-06", "2026-11-07"], channelIds: ["C0ACMESEO", "C0PRIVOPS", "G0MPIMTEAM"], use: "page", limit: 30 },
      { now: NOW });
    expect(cards.map((c) => `${c.date} ${c.channelId} ${c.status}`)).toEqual([
      "2026-11-07 C0ACMESEO built", "2026-11-07 C0PRIVOPS built", "2026-11-07 G0MPIMTEAM built",
      "2026-11-06 C0PRIVOPS built", "2026-11-06 C0ACMESEO not_built", "2026-11-06 G0MPIMTEAM not_built"
    ]);
  });

  it("DG29 an unwatched public channel with activity and a left private channel get no card (page) and no build", async () => {
    useDb({ exec_slack_digests: [row("C0RANDOM", DAY.localDate), row("C0LEFTPRIV", DAY.localDate)] });
    const cards = await listDigestViews(PRINCIPAL, "ok", { dates: [DAY.localDate, "2026-11-08"], use: "page", limit: 50 }, { now: NOW });
    expect(cards.map((c) => c.channelId)).not.toContain("C0RANDOM");
    expect(cards.map((c) => c.channelId)).not.toContain("C0LEFTPRIV");
    const slack = daySlack();
    for (const id of ["C0RANDOM", "C0LEFTPRIV"]) {
      expect(await run({ channel_id: id, local_date: DAY.localDate, mode: "plan" })).toMatchObject({ outcome: "not_allowed" });
    }
    expect(rpcCalls("exec_slack_digest_claim")).toEqual([]);
    expect(slack.calls).toEqual([]);
  });
});

describe("catch-up counts and since_last_brief (DG22, DG23)", () => {
  it("DG23 slackCatchUpCounts reads P7a's screened open items (readOpenSlackItems: web, 14 days, 200) and re-screens with slackItemPolicy('page')", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [
      itemRow({ channelId: "C0ACMESEO", needsResponse: true }),
      itemRow({ channelId: "C0ACMESEO", kind: "decision", needsResponse: false }),
      itemRow({ channelId: "C0ACMESEO", assessed: false, needsResponse: true, summary: null }),
      itemRow({ channelId: "C0ACMESEO", needsResponse: true, respondedAt: NOW.toISOString(), kind: "commitment" }),
      // Owner-muted: only a bypass item shows.
      itemRow({ channelId: "C0DESIGN", needsResponse: true, bypassMute: true }),
      itemRow({ channelId: "C0DESIGN", needsResponse: true, bypassMute: false }),
      // Unwatched, a finance default mute, a left channel, a hub: nothing.
      itemRow({ channelId: "C0RANDOM", needsResponse: true, bypassMute: true }),
      itemRow({ channelId: "C0FINANCE", needsResponse: true, bypassMute: true }),
      itemRow({ channelId: "C0LEFTPRIV", needsResponse: true, bypassMute: true }),
      itemRow({ channelId: "C0OUTBOUND", needsResponse: true }),
      itemRow({ channelId: "C0GONE", needsResponse: true })
    ], mutedHidden: 0 });
    expect(await slackCatchUpCounts(PRINCIPAL, "ok", { now: NOW })).toEqual({ unanswered: 3, decisionsPending: 1, notAssessed: 1 });
    expect(vi.mocked(readOpenSlackItems).mock.calls[0][1]).toEqual({ sinceIso: new Date(NOW.getTime() - 14 * DAY_MS).toISOString(), limit: 200, surface: "web" });
    expect(await slackCatchUpCounts(PRINCIPAL, "reading_off")).toBeNull();
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [], mutedHidden: 0 });
    expect(await slackCatchUpCounts(PRINCIPAL, "ok")).toEqual({ unanswered: 0, decisionsPending: 0, notAssessed: 0 });
  });

  it("DG23 the channel read failing propagates (the caller's section fails soft); counts are capped at 200", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: Array.from({ length: 250 }, () => itemRow({ channelId: "C0ACMESEO" })), mutedHidden: 0 });
    expect(await slackCatchUpCounts(PRINCIPAL, "ok")).toMatchObject({ unanswered: 200 });
    vi.mocked(listIntelChannels).mockRejectedValueOnce(new Error("down"));
    await expect(slackCatchUpCounts(PRINCIPAL, "ok")).rejects.toThrow();
    // Fixer ui-9: P7a's item read failing propagates too (the tile says "Couldn't load", never 0).
    vi.mocked(readOpenSlackItems).mockRejectedValueOnce(new Error("down"));
    await expect(slackCatchUpCounts(PRINCIPAL, "ok")).rejects.toThrow("down");
  });

  it("DG22 sinceLastBrief: today's brief time once it passed, else yesterday's; across both DST changes", async () => {
    const s = settings({ briefLocalTime: "08:00" });
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    expect(await sinceLastBrief(PRINCIPAL, s, new Date("2026-11-08T12:59:00.000Z"))).toEqual(new Date("2026-11-07T13:00:00.000Z"));
    // 2026-11-01 (fall back at 02:00): 08:00 EST = 13:00Z; the day before, 08:00 EDT = 12:00Z.
    expect(await sinceLastBrief(PRINCIPAL, s, new Date("2026-11-01T14:00:00.000Z"))).toEqual(new Date("2026-11-01T13:00:00.000Z"));
    expect(await sinceLastBrief(PRINCIPAL, s, new Date("2026-11-01T12:30:00.000Z"))).toEqual(new Date("2026-10-31T12:00:00.000Z"));
    // 2026-03-08 (spring forward): 08:00 EDT = 12:00Z; the day before, 08:00 EST = 13:00Z.
    expect(await sinceLastBrief(PRINCIPAL, s, new Date("2026-03-08T12:30:00.000Z"))).toEqual(new Date("2026-03-08T12:00:00.000Z"));
    expect(await sinceLastBrief(PRINCIPAL, s, new Date("2026-03-08T11:30:00.000Z"))).toEqual(new Date("2026-03-07T13:00:00.000Z"));
  });

  it("DG22 a registered resolver wins; one that answers null, a future time or throws is ignored; null unregisters", async () => {
    const s = settings({ briefLocalTime: "08:00" });
    const delivered = new Date("2026-11-08T13:07:00.000Z");
    setSinceLastBriefResolver(async () => delivered);
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toBe(delivered);
    setSinceLastBriefResolver(async () => null);
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    setSinceLastBriefResolver(async () => new Date(NOW.getTime() + 60_000));
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    setSinceLastBriefResolver(async () => {
      throw new Error("brief store down");
    });
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    setSinceLastBriefResolver(null);
    expect(await sinceLastBrief(PRINCIPAL, s, NOW)).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    expect(() => setSinceLastBriefResolver("x" as never)).toThrow(TypeError);
  });
});
