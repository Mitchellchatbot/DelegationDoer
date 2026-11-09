import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { ITEM_TEXT_KEYS, SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { sealSecret } from "@/lib/exec/crypto";
import { buildSlackCandidates } from "@/lib/exec/producers/slack";
import * as store from "@/lib/exec/slack-read-store";
import {
  SlackReadStoreError,
  acceptEventV2,
  applyClasses,
  countChannels,
  countOpenItems,
  countPendingTriage,
  deleteChannelRow,
  finishDiscovery,
  getChannel,
  getDdBotRow,
  isSlackReadingSchemaMissing,
  lastSweepAt,
  latestAuthorOptoutAt,
  listAuthorOptouts,
  listCandidates,
  listGateDropChannels,
  listItemsForAttention,
  listItemsForMessage,
  listPickerChannels,
  listProbeTargets,
  listPurgeLog,
  listStoredTs,
  listSweepTargets,
  listThreads,
  listUnclassified,
  markDeleted,
  noteFromHim,
  noteMessages,
  purgeAuthor,
  purgeConversation,
  purgeExpiredSlack,
  purgeReading,
  rateBlock,
  rateBlocks,
  rateTake,
  rekeyChannel,
  saveDdBotRow,
  saveProbe,
  saveSweepProgress,
  saveThreadWatermark,
  setAcknowledged,
  setPermalinks,
  setWatch,
  slackScreenRows,
  unstampAnswered,
  unwatchUnjoined,
  userRevoke,
  writeTriageResult
} from "@/lib/exec/slack-read-store";
import type { ClassRow, ItemOutcome, ItemWriteRow, NoteRow } from "@/lib/exec/slack-read-types";
import type { SlackEventFacts } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.8, §5.16 ST01-ST08 and ST17, §5.8 PG02-PG06 (Area A): slack-read-store.ts against
// fake-slack-read-db.ts. The fake's RPC bodies mirror the migration (RQ13 and the SQL suite keep them equal); here
// the store's own half is pinned: the query shapes and filters, the identical key sets of every RPC row, the
// answer mapping, the missing-schema values, and that no Slack text reaches an error, a log line or an RPC argument
// (exec_slack_write_items' text keys excepted).

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const NOW = new Date("2026-11-08T15:00:00.000Z");
const NOW_TS = "1794150000.000000";
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const INST = `esi_${hex32(1)}`;
const INST_2 = `esi_${hex32(2)}`;
const principal = (id = "ep_1") => Object.freeze({ id, userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "UTC",
  mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;
const P1 = principal("ep_1");
const P2 = principal("ep_2");
const NINE = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261109100000_exec_slack_reading.sql", import.meta.url), "utf8");

let db: FakeSlackReadDb;
function useDb(seed: FakeSlackReadDbSeed = {}): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => NOW, ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

/** His installation with a live reading half (snake_case, sealed for the principal). */
function inst(over: Row = {}): Row {
  const pid = (over.principal_id as string | undefined) ?? "ep_1";
  const bot = sealSecret("xoxb-store-test-bot", `exec_slack_installations.bot_token:${pid}`);
  const user = sealSecret(S.userToken, `exec_slack_installations.user_token:${pid}`);
  return {
    id: INST, principal_id: pid, team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot,
    key_id: bot.split(".")[1], bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: user, user_scopes: [...NINE],
    slack_dm_channel_id: "D0MITCH", installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null,
    revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null, user_key_id: user.split(".")[1],
    user_installed_at: "2026-11-01T00:00:00.000Z", user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
    user_last_error_at: null, reading_state: "ready", discovered_at: "2026-11-01T01:00:00.000Z", reading_purged_at: null, ...over
  };
}
function channel(over: Row = {}): Row {
  return {
    principal_id: "ep_1", installation_id: INST, channel_id: "C0GEN", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null,
    finance_name: false, watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: S.channelName, im_user_id: null,
    is_member: true, is_private: false, is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null,
    swept_at: null, last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: "2026-11-01T01:00:00.000Z",
    seen_at: "2026-11-01T01:00:00.000Z", left_at: null, created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", ...over
  };
}
const deny = (id: string, reason: string, over: Row = {}): Row =>
  channel({ channel_id: id, class: "deny", deny_reason: reason, name: null, watch_state: "unwatched", is_member: false, is_private: true, ...over });
function message(over: Row = {}): Row {
  return {
    principal_id: "ep_1", channel_id: "C0GEN", ts: "1794100000.000100", thread_ts: null, role: "candidate", author_user_id: "U0JANE",
    author_external: false, is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "pending", content_hash: null, edited_ts: null,
    responded_ts: null, responded_at: null, acknowledged_at: null, assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z",
    created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}
function item(over: Row = {}): Row {
  return {
    id: `esl_${hex32(Number(over.n ?? 1))}`, principal_id: "ep_1", channel_id: "C0GEN", ts: "1794100000.000100", kind: "request", thread_ts: null,
    author_user_id: "U0JANE", author_label: S.authorName, author_external: false, assessed: true, addressed_to_you: true, needs_response: true,
    bypass_mute: false, urgency: "normal", summary: S.summary, excerpt: S.excerpt, due_text: null, due_at: null, commitment_direction: null,
    source_class: "public", permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z",
    created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z", ...over, n: undefined
  };
}
const attention = (fingerprint: string, over: Row = {}): Row => ({
  id: `ea_${fingerprint.replace(/[^0-9]/g, "").slice(-12)}`, principal_id: "ep_1", source: "slack", fingerprint, kind: "slack_request", status: "open", ...over
});
const clean = (r: Row) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
const rpcCalls = (fn: string) => db.calls.filter((c) => c.kind === "rpc" && c.target === fn);

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  useDb();
});
afterEach(() => {
  out.assertClean();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("ST01: errors and the missing-schema rule", () => {
  it("isSlackReadingSchemaMissing knows the six codes, on the error or on a SlackReadStoreError; the message carries no value", () => {
    for (const code of ["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]) {
      expect(isSlackReadingSchemaMissing({ code })).toBe(true);
      expect(isSlackReadingSchemaMissing(new SlackReadStoreError("getChannel", code))).toBe(true);
    }
    for (const v of [{ code: "57014" }, new SlackReadStoreError("x", null), null, "42P01", new Error("42P01")]) expect(isSlackReadingSchemaMissing(v)).toBe(false);
    const e = new SlackReadStoreError("noteMessages", "23514");
    expect(e.message).toBe("exec slack reading store: noteMessages failed (23514)");
    expect(new SlackReadStoreError("not_installed", null).message).toBe("exec slack reading store: not_installed failed");
  });

  it("a database error throws SlackReadStoreError(op, code) whose message names no value; an aborted signal throws its reason", async () => {
    useDb({ tables: { exec_slack_channels: [channel()] }, fail: () => ({ code: "57014", message: `timeout near ${S.text}` }) });
    const err = await thrown(getChannel(P1, "C0GEN"));
    expect(err).toBeInstanceOf(SlackReadStoreError);
    expect(err).toMatchObject({ op: "getChannel", pgCode: "57014" });
    assertNoSlackText(err, { label: "error" });
    useDb({ tables: { exec_slack_channels: [channel()] } });
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    await expect(purgeExpiredSlack(NOW, { signal: ac.signal })).rejects.toThrow("stopped");
  });

  it("acceptEventV2: the 21 named arguments; v2_missing on PGRST202 / 42883; not_installed on a missing table; the answer mapped", async () => {
    const facts: SlackEventFacts = {
      eventId: "Ev0ST01", teamId: "T0SCALED", apiAppId: "A0EXEC", eventType: "message", eventTime: 1794150000, retryNum: 0, channel: "C0GEN",
      channelType: "channel", user: "U0JANE", ts: "1794150000.000100", threadTs: null, hasBotId: false, hasAppId: false, subtype: null, hidden: false,
      textIsString: true, hasMessage: false, tab: null, revokedBotIds: [], revokedUserIds: []
    };
    const signal = new AbortController().signal;
    useDb({ missing: ["exec_slack_accept_event_v2"] });
    expect(await acceptEventV2(facts, { kind: "msg" }, { signal })).toEqual({ outcome: "v2_missing" });
    useDb({ fail: (c) => (c.target === "exec_slack_accept_event_v2" ? { code: "42883", message: "function does not exist" } : null) });
    expect(await acceptEventV2(facts, { kind: "msg" }, { signal })).toEqual({ outcome: "v2_missing" });
    useDb({ fail: (c) => (c.target === "exec_slack_accept_event_v2" ? { code: "42P01", message: "relation does not exist" } : null) });
    expect(await acceptEventV2(facts, { kind: "msg" }, { signal })).toEqual({ outcome: "not_installed" });
    useDb({ fail: () => ({ code: "P0001", message: "exec_slack_ingest_check: unknown key" }) });
    expect(await thrown(acceptEventV2(facts, { kind: "msg" }, { signal }))).toMatchObject({ op: "acceptEventV2", pgCode: "P0001" });
    // No reading half: v2 drops, records nothing; the call carried exactly the v2 parameter names.
    useDb();
    expect(await acceptEventV2(facts, { kind: "msg", conv: "channel", ts: facts.ts, author: "U0JANE", auth_user: "U0MITCH" }, { signal }))
      .toEqual({ outcome: "accepted", decision: "drop", reason: "not_reading", recorded: false, path: "v2" });
    expect(db.calls[0].signal).toBe(signal);
    // A P6 event: v1's answer, path v1.
    useDb({ tables: { exec_slack_installations: [inst({ user_token_enc: null, user_key_id: null, user_scopes: [], reading_state: "none", discovered_at: null, user_installed_at: null })] } });
    expect(await acceptEventV2({ ...facts, eventType: "app_home_opened", channel: "D0MITCH", user: "U0MITCH", tab: "home" }, null, { signal }))
      .toEqual({ outcome: "accepted", decision: "home", reason: null, enqueued: true, interactive: true, path: "v1" });
    expect(await acceptEventV2({ ...facts, eventType: "app_home_opened", channel: "D0MITCH", user: "U0MITCH", tab: "home" }, null, { signal }))
      .toEqual({ outcome: "duplicate", path: "v1" });
  });
});

describe("ST02: channel reads", () => {
  it("getChannel: the row mapped, another principal's row and a malformed id → null; missing → null", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_slack_channels: [channel(), channel({ principal_id: "ep_2", channel_id: "C0OTHER" })] } });
    expect(await getChannel(P1, "C0GEN")).toMatchObject({ channelId: "C0GEN", installationId: INST, convType: "channel", class: "standard", watchState: "watched",
      name: S.channelName, isMember: true, isPrivate: false, updatedAt: "2026-11-01T01:00:00.000Z" });
    expect(await getChannel(P1, "C0OTHER")).toBeNull();
    expect(await getChannel(P1, "not a channel")).toBeNull();
    useDb({ missing: ["exec_slack_channels"] });
    expect(await getChannel(P1, "C0GEN")).toBeNull();
  });

  it("listPickerChannels: channel and group rows that aren't deny, by name; countChannels counts DMs, group DMs, hubs and never-read reasons", async () => {
    useDb({
      tables: {
        exec_slack_channels: [
          channel({ channel_id: "C0B", name: "bravo" }), channel({ channel_id: "C0A", name: "alpha", watch_state: "muted", mute_source: "owner" }),
          channel({ channel_id: "G0P", conv_type: "group", is_private: true, name: "private-x", watch_state: "unwatched" }),
          channel({ channel_id: "C0HUB", class: "hub", hub_kind: "outbound", name: "outbound" }),
          deny("C0LEADS", "lead_name"), deny("C0FB", "fb_list"), deny("D0BOT", "assistant_dm", { conv_type: "im" }),
          channel({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE" }),
          channel({ channel_id: "D0BOB", conv_type: "im", is_private: true, name: null, im_user_id: "U0BOB", watch_state: "unwatched" }),
          channel({ channel_id: "G0MP", conv_type: "mpim", is_private: true, name: null }),
          channel({ channel_id: "C0UN", class: "unclassified", name: null, watch_state: "unwatched" })
        ]
      }
    });
    expect((await listPickerChannels(P1, 1000)).map((c) => c.channelId)).toEqual(["C0A", "C0B", "C0HUB", "G0P", "C0UN"]);
    // Fixer ui-8: the watched and muted rows first, then the unwatched ones fill the rest.
    const calls = db.calls.slice(-2);
    expect(calls.map((c) => c.filters)).toEqual([
      [{ op: "eq", column: "principal_id", value: "ep_1" }, { op: "in", column: "conv_type", values: ["channel", "group"] }, { op: "neq", column: "class", value: "deny" },
        { op: "in", column: "watch_state", values: ["watched", "muted"] }],
      [{ op: "eq", column: "principal_id", value: "ep_1" }, { op: "in", column: "conv_type", values: ["channel", "group"] }, { op: "neq", column: "class", value: "deny" },
        { op: "in", column: "watch_state", values: ["unwatched"] }]
    ]);
    expect(await countChannels(P1)).toEqual({
      byWatch: { watched: 1, muted: 1, unwatched: 2 }, denyByReason: { lead_name: 1, fb_list: 1, assistant_dm: 1 }, hubs: 1,
      dms: { watched: 1, total: 2 }, groupDms: { watched: 1, total: 1 }
    });
    // The deny rows' channel ids are counted, never returned.
    expect(JSON.stringify(await countChannels(P1))).not.toContain("C0LEADS");
    useDb({ missing: ["exec_slack_channels"] });
    expect(await listPickerChannels(P1, 10)).toEqual([]);
    expect(await countChannels(P1)).toEqual({ byWatch: { watched: 0, muted: 0, unwatched: 0 }, denyByReason: {}, hubs: 0, dms: { watched: 0, total: 0 }, groupDms: { watched: 0, total: 0 } });
  });

  it("listSweepTargets (fixer correctness-2 / correctness-3): sweepable rows, not archived, not left, watched or muted by him or Slack (never a finance default mute); one order across every type: never swept first, then the oldest sweep, a DM winning a tie", async () => {
    useDb({
      tables: {
        exec_slack_channels: [
          channel({ channel_id: "C0OLD", swept_at: "2026-11-08T10:00:00.000Z" }), channel({ channel_id: "C0NEW", swept_at: null }),
          channel({ channel_id: "C0ARCH", is_archived: true }), channel({ channel_id: "C0LEFT", left_at: "2026-11-02T00:00:00.000Z" }),
          channel({ channel_id: "C0MUTE", watch_state: "muted", mute_source: "owner" }), channel({ channel_id: "C0HUB", class: "hub", hub_kind: "client_email" }),
          channel({ channel_id: "C0SMUTE", watch_state: "muted", mute_source: "slack", swept_at: "2026-11-08T11:00:00.000Z" }),
          channel({ channel_id: "C0FMUTE", class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" }),
          channel({ channel_id: "C0UNW", watch_state: "unwatched" }),
          channel({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, swept_at: "2026-11-08T14:00:00.000Z" }),
          channel({ channel_id: "D0ZED", conv_type: "im", is_private: true, name: null, swept_at: null }),
          channel({ channel_id: "D0TIE", conv_type: "im", is_private: true, name: null, swept_at: "2026-11-08T10:00:00.000Z" }),
          channel({ channel_id: "C0FIN", class: "finance", finance_name: true, swept_at: "2026-11-08T09:00:00.000Z" }), deny("C0D", "lead_name")
        ]
      }
    });
    expect((await listSweepTargets(P1, 20)).map((c) => c.channelId)).toEqual(["D0ZED", "C0HUB", "C0MUTE", "C0NEW", "C0FIN", "D0TIE", "C0OLD", "C0SMUTE", "D0JANE"]);
    expect((await listSweepTargets(P1, 3)).map((c) => c.channelId)).toEqual(["D0ZED", "C0HUB", "C0MUTE"]);
  });

  it("listSweepTargets (fixer correctness-2): 40 never-swept DMs and a channel: the channel is reached once the DMs have their first sweep, not never", async () => {
    const dms = Array.from({ length: 40 }, (_, i) => channel({ channel_id: `D0DM${String(i).padStart(2, "0")}`, conv_type: "im", is_private: true, name: null, swept_at: null }));
    useDb({ tables: { exec_slack_channels: [...dms, channel({ channel_id: "C0GEN", swept_at: null })] } });
    // Run 1 sweeps the 30 the limiter allows (a DM wins the tie of never swept); they get swept_at.
    const run1 = (await listSweepTargets(P1, 200)).map((c) => c.channelId);
    expect(run1.slice(0, 40).every((id) => id.startsWith("D0"))).toBe(true);
    for (const id of run1.slice(0, 30)) db.tables.exec_slack_channels.find((r) => r.channel_id === id)!.swept_at = "2026-11-08T14:00:00.000Z";
    // Run 2: the 10 never-swept DMs, then the never-swept channel, before any DM swept in run 1.
    const run2 = (await listSweepTargets(P1, 200)).map((c) => c.channelId);
    expect(run2.indexOf("C0GEN")).toBe(10);
  });

  it("listProbeTargets: unjoined standard/external public channels, never probed first then the oldest probe before staleBefore; listUnclassified", async () => {
    useDb({
      tables: {
        exec_slack_channels: [
          channel({ channel_id: "C0P1", is_member: false, probed_at: "2026-10-01T00:00:00.000Z" }),
          channel({ channel_id: "C0P2", is_member: false, probed_at: null, watch_state: "unwatched" }),
          channel({ channel_id: "C0P3", is_member: false, probed_at: "2026-11-08T00:00:00.000Z" }),
          channel({ channel_id: "C0P4", is_member: true }), channel({ channel_id: "C0P5", is_member: false, class: "finance", finance_name: true }),
          channel({ channel_id: "C0P6", is_member: false, class: "external", is_ext_shared: true, ext_ever: true, probed_at: "2026-09-01T00:00:00.000Z" }),
          channel({ channel_id: "C0U2", class: "unclassified", name: null, watch_state: "unwatched", created_at: "2026-11-02T00:00:00.000Z" }),
          channel({ channel_id: "C0U1", class: "unclassified", name: null, watch_state: "unwatched", created_at: "2026-11-01T00:00:00.000Z" })
        ]
      }
    });
    expect((await listProbeTargets(P1, "2026-11-01T00:00:00.000Z", 10)).map((c) => c.channelId)).toEqual(["C0P2", "C0P6", "C0P1"]);
    expect((await listUnclassified(P1, 10)).map((c) => c.channelId)).toEqual(["C0U1", "C0U2"]);
    await expect(listProbeTargets(P1, "yesterday", 10)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("ST03: classes and discovery (RPCs 12 and 13)", () => {
  const classRow = (over: Partial<ClassRow> = {}): ClassRow => ({
    channel_id: "C0GEN", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null, finance_name: false, default_watch: "watched",
    default_mute: null, name: "general", im_user_id: null, is_member: true, is_private: false, is_ext_shared: false, is_archived: false, ...over
  });

  it("applyClasses: identical key sets, chunks of 200, the counts summed; a deny row comes out bare", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } } });
    const rows = [classRow(), classRow({ channel_id: "C0LEADS", class: "deny", deny_reason: "lead_name", name: null, default_watch: "unwatched" })];
    for (let i = 0; i < 250; i += 1) rows.push(classRow({ channel_id: `C0X${String(i).padStart(4, "0")}`, name: `x-${i}` }));
    const r = await applyClasses(P1, INST, rows, "2026-11-08T14:00:00.000Z");
    expect(r).toEqual({ upserted: 251, denied: 1, purged: 0 });
    const calls = rpcCalls("exec_slack_apply_classes");
    expect(calls.map((c) => ((c.payload as Row).p_rows as unknown[]).length)).toEqual([200, 52]);
    for (const c of calls) {
      expect(Object.keys(c.payload as Row).sort()).toEqual(["p_installation_id", "p_principal", "p_rows", "p_run_started_at"]);
      for (const row of (c.payload as Row).p_rows as Row[]) expect(Object.keys(row).sort()).toEqual(Object.keys(classRow()).sort());
    }
    const bare = db.tables.exec_slack_channels.find((c) => c.channel_id === "C0LEADS");
    expect(bare).toMatchObject({ class: "deny", deny_reason: "lead_name", name: null, watch_state: "unwatched", hist_watermark_ts: null });
  });

  it("applyClasses refuses a row without the payload type's exact keys before any call; missing → zeros; finishDiscovery maps", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({ discovered_at: null, reading_state: "discovering" })] } } });
    await expect(applyClasses(P1, INST, [{ ...classRow(), extra: 1 } as unknown as ClassRow], NOW.toISOString())).rejects.toBeInstanceOf(TypeError);
    const { name: _n, ...short } = classRow();
    void _n;
    await expect(applyClasses(P1, INST, [short as unknown as ClassRow], NOW.toISOString())).rejects.toBeInstanceOf(TypeError);
    expect(db.calls).toEqual([]);
    expect(await finishDiscovery(P1, INST, NOW.toISOString())).toEqual({ ready: true, removed: 0 });
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ reading_state: "ready", discovered_at: NOW.toISOString() });
    expect(await finishDiscovery(P1, "esi_bogus", NOW.toISOString())).toEqual({ ready: false, removed: 0 });
    useDb({ missing: ["exec_slack_apply_classes", "exec_slack_finish_discovery"] });
    expect(await applyClasses(P1, INST, [classRow()], NOW.toISOString())).toEqual({ upserted: 0, denied: 0, purged: 0 });
    expect(await finishDiscovery(P1, INST, NOW.toISOString())).toEqual({ ready: false, removed: 0 });
  });
});

describe("ST04: the picker and the channel writers", () => {
  it("setWatch: updated / conflict / confirmation_required / refused / not_found; a missing schema throws not_installed", async () => {
    useDb({
      slack: { tables: { exec_slack_installations: [inst()] } },
      tables: { exec_slack_channels: [channel(), channel({ channel_id: "C0FIN", class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" }), deny("C0D", "lead_name"), channel({ channel_id: "C0HUB", class: "hub", hub_kind: "outbound" })] }
    });
    const v = "2026-11-01T01:00:00.000Z";
    const r = await setWatch(P1, "C0GEN", "muted", v, false);
    expect(r).toMatchObject({ outcome: "updated" });
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ watch_state: "muted", mute_source: "owner", watch_set_by_owner_at: expect.any(String) });
    expect(await setWatch(P1, "C0GEN", "watched", v, false)).toMatchObject({ outcome: "conflict", updatedAt: (r as { updatedAt: string }).updatedAt });
    expect(await setWatch(P1, "C0FIN", "watched", v, false)).toEqual({ outcome: "confirmation_required" });
    expect(await setWatch(P1, "C0FIN", "watched", v, true)).toMatchObject({ outcome: "updated" });
    expect(await setWatch(P1, "C0D", "watched", v, false)).toEqual({ outcome: "refused", class: "deny" });
    expect(await setWatch(P1, "C0HUB", "watched", v, false)).toEqual({ outcome: "refused", class: "hub" });
    expect(await setWatch(P1, "C0NONE", "watched", v, false)).toEqual({ outcome: "not_found" });
    expect(await setWatch(P1, "C0GEN", "watched", "not a time", false)).toMatchObject({ outcome: "conflict" });
    await expect(setWatch(P1, "C0GEN", "bogus" as never, v, false)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_set_watch"] });
    expect(await thrown(setWatch(P1, "C0GEN", "muted", v, false))).toMatchObject({ op: "not_installed", pgCode: "PGRST202" });
  });

  it("saveSweepProgress: watermark, swept and deep stamps, never on deny / unclassified rows, never moving the picker's version", async () => {
    useDb({ tables: { exec_slack_channels: [channel(), deny("C0D", "lead_name"), channel({ channel_id: "C0U", class: "unclassified", name: null, watch_state: "unwatched" })] } });
    await saveSweepProgress(P1, "C0GEN", { histWatermarkTs: "1794149000.000100", deep: true, sweptAt: NOW.toISOString(), lastActivityTs: "1794149000.000100" });
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ hist_watermark_ts: "1794149000.000100", swept_at: NOW.toISOString(), deep_swept_at: NOW.toISOString(),
      last_activity_ts: "1794149000.000100", updated_at: "2026-11-01T01:00:00.000Z" });
    await saveSweepProgress(P1, "C0GEN", { histWatermarkTs: null, deep: false, sweptAt: "2026-11-08T16:00:00.000Z", lastActivityTs: null });
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ hist_watermark_ts: "1794149000.000100", deep_swept_at: NOW.toISOString(), swept_at: "2026-11-08T16:00:00.000Z" });
    for (const id of ["C0D", "C0U"]) await saveSweepProgress(P1, id, { histWatermarkTs: "1794149000.000100", deep: true, sweptAt: NOW.toISOString(), lastActivityTs: null });
    expect(db.tables.exec_slack_channels[1]).toMatchObject({ hist_watermark_ts: null, swept_at: null });
    expect(db.tables.exec_slack_channels[2]).toMatchObject({ hist_watermark_ts: null });
    await expect(saveSweepProgress(P1, "C0GEN", { histWatermarkTs: "abc", deep: false, sweptAt: NOW.toISOString(), lastActivityTs: null })).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_channels"] });
    expect(await thrown(saveSweepProgress(P1, "C0GEN", { histWatermarkTs: null, deep: false, sweptAt: NOW.toISOString(), lastActivityTs: null }))).toMatchObject({ op: "not_installed" });
  });

  it("saveProbe: activity always; watch only when not owner-set, class standard/external, not finance_name, never a muted row", async () => {
    useDb({
      tables: {
        exec_slack_channels: [
          channel({ channel_id: "C0A", is_member: false, watch_state: "unwatched" }),
          channel({ channel_id: "C0B", is_member: false, watch_state: "unwatched", watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" }),
          channel({ channel_id: "C0C", is_member: false, watch_state: "unwatched", class: "external", is_ext_shared: true, ext_ever: true, finance_name: true }),
          channel({ channel_id: "C0M", is_member: false, watch_state: "muted", mute_source: "slack" })
        ]
      }
    });
    for (const id of ["C0A", "C0B", "C0C", "C0M"]) await saveProbe(P1, id, { activity30d: 12, lastActivityTs: "1794149000.000100", probedAt: NOW.toISOString(), watch: "watched" });
    const by = (id: string) => db.tables.exec_slack_channels.find((c) => c.channel_id === id);
    expect(by("C0A")).toMatchObject({ watch_state: "watched", activity_30d: 12, probed_at: NOW.toISOString() });
    expect(by("C0B")).toMatchObject({ watch_state: "unwatched", activity_30d: 12 });
    expect(by("C0C")).toMatchObject({ watch_state: "unwatched", activity_30d: 12 });
    expect(by("C0M")).toMatchObject({ watch_state: "muted", mute_source: "slack" });
  });

  it("unwatchUnjoined; deleteChannelRow cascades; rekeyChannel moves the rows (missing → { rekeyed: false })", async () => {
    useDb({
      slack: { tables: { exec_slack_installations: [inst()] } },
      tables: {
        exec_slack_channels: [
          channel({ channel_id: "C0A", is_member: false }), channel({ channel_id: "C0B", is_member: false, watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" }),
          channel({ channel_id: "C0C" })
        ],
        exec_slack_messages: [message({ channel_id: "C0C" })],
        exec_slack_items: [item({ channel_id: "C0C" })]
      }
    });
    expect(await unwatchUnjoined(P1)).toBe(1);
    expect(db.tables.exec_slack_channels.map((c) => c.watch_state)).toEqual(["unwatched", "watched", "watched"]);
    expect(await rekeyChannel(P1, "C0C", "C0D")).toEqual({ rekeyed: true });
    expect(db.tables.exec_slack_messages[0].channel_id).toBe("C0D");
    expect(db.tables.exec_slack_items[0].channel_id).toBe("C0D");
    await deleteChannelRow(P1, "C0D");
    expect(db.tables.exec_slack_messages).toEqual([]);
    expect(db.tables.exec_slack_items).toEqual([]);
    useDb({ missing: ["exec_slack_rekey_channel"] });
    expect(await rekeyChannel(P1, "C0C", "C0D")).toEqual({ rekeyed: false });
  });
});

describe("ST05: threads", () => {
  it("listThreads by root; saveThreadWatermark upserts, never moves a watermark back, expires 14 days after the newest reply", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel()],
        exec_slack_threads: [{ principal_id: "ep_1", channel_id: "C0GEN", thread_ts: "1794100000.000100", he_posted_ts: "1794100001.000000",
          reply_watermark_ts: "1794100500.000000", latest_reply_seen_ts: "1794100500.000000", expires_at: "2026-12-30T00:00:00.000Z", updated_at: NOW.toISOString() }]
      }
    });
    expect(await listThreads(P1, "C0GEN", ["1794100000.000100", "1794999999.000000", "junk"])).toEqual([
      { threadTs: "1794100000.000100", hePostedTs: "1794100001.000000", replyWatermarkTs: "1794100500.000000", latestReplySeenTs: "1794100500.000000" }
    ]);
    await saveThreadWatermark(P1, "C0GEN", "1794100000.000100", { replyWatermarkTs: "1794100400.000000", latestReplySeenTs: "1794100600.000000" });
    expect(db.tables.exec_slack_threads[0]).toMatchObject({ reply_watermark_ts: "1794100500.000000", latest_reply_seen_ts: "1794100600.000000",
      he_posted_ts: "1794100001.000000", expires_at: "2026-12-30T00:00:00.000Z" });
    await saveThreadWatermark(P1, "C0GEN", "1794140000.000000", { replyWatermarkTs: "1794140100.000000", latestReplySeenTs: "1794140100.000000" });
    expect(db.tables.exec_slack_threads[1]).toMatchObject({ thread_ts: "1794140000.000000", he_posted_ts: null,
      expires_at: new Date(1794140100 * 1000 + 14 * 86_400_000).toISOString() });
    // RPC 7b: no channel row → nothing written (the RPC answers false; no FK error reaches the sweep).
    await saveThreadWatermark(P1, "C0NONE", "1794140000.000000", { replyWatermarkTs: "1794140100.000000", latestReplySeenTs: "1794140100.000000" });
    expect(db.tables.exec_slack_threads.map((t) => t.channel_id)).toEqual(["C0GEN", "C0GEN"]);
    expect(db.calls.filter((c) => c.kind === "rpc").map((c) => c.target)).toEqual(Array(3).fill("exec_slack_save_thread_watermark"));
    useDb({ missing: ["exec_slack_save_thread_watermark"] });
    expect(await thrown(saveThreadWatermark(P1, "C0GEN", "1794140000.000000", { replyWatermarkTs: "1794140100.000000", latestReplySeenTs: "1794140100.000000" })))
      .toMatchObject({ op: "not_installed" });
  });

  it("ST05b (fixer security-2): saveThreadWatermark never writes into a deny conversation (N1, rule 7), nor an unclassified one; a hub keeps its watermark", async () => {
    useDb({ tables: { exec_slack_channels: [deny("C0LEADS", "lead_name"), channel({ channel_id: "C0UN", class: "unclassified", name: null, watch_state: "unwatched" }),
      channel({ channel_id: "C0HUB", class: "hub", hub_kind: "outbound" })] } });
    for (const id of ["C0LEADS", "C0UN", "C0HUB"]) {
      await saveThreadWatermark(P1, id, "1794140000.000000", { replyWatermarkTs: "1794140100.000000", latestReplySeenTs: "1794140100.000000" });
    }
    expect(db.tables.exec_slack_threads.map((t) => t.channel_id)).toEqual(["C0HUB"]);
    expect(db.locks.filter((l) => l.rpc === "exec_slack_save_thread_watermark").map((l) => [l.key, l.mode]))
      .toEqual([["ep_1:C0LEADS", "share"], ["ep_1:C0UN", "share"], ["ep_1:C0HUB", "share"]]);
  });
});

describe("ST06: messages (RPCs 6, 7, 8) and their reads", () => {
  const note = (over: Partial<NoteRow> = {}): NoteRow => ({ ts: "1794149000.000100", thread_ts: null, role: "candidate", author: "U0JANE", author_external: false, reasons: 2, dd_paths: [], ...over });

  it("noteMessages: identical key sets, chunks of 500, the answer mapped (opted_out → optedOut); a bad row is refused before the call", async () => {
    useDb({ tables: { exec_slack_channels: [channel()], exec_slack_author_optouts: [{ principal_id: "ep_1", author_user_id: "U0OPTOUT", created_at: NOW.toISOString() }] } });
    const rows = [note(), note({ ts: "1794149000.000200", author: "U0OPTOUT" }), note({ ts: "1794149000.000300", role: "anchor", author: null, reasons: 0, dd_paths: ["/tasks/t_1"] })];
    expect(await noteMessages(P1, "C0GEN", rows, "bulk", "b5980500")).toEqual({ candidates: 1, anchors: 1, blocked: 0, optedOut: 1, jobs: 1 });
    const call = rpcCalls("exec_slack_note_messages")[0];
    expect(Object.keys(call.payload as Row).sort()).toEqual(["p_bucket", "p_channel", "p_lane", "p_principal", "p_rows"]);
    for (const r of (call.payload as Row).p_rows as Row[]) expect(Object.keys(r).sort()).toEqual(Object.keys(note()).sort());
    await expect(noteMessages(P1, "C0GEN", [{ ...note(), text: S.text } as unknown as NoteRow], "bulk", "b1")).rejects.toBeInstanceOf(TypeError);
    await expect(noteMessages(P1, "C0GEN", [note()], "bulk", "x1")).rejects.toBeInstanceOf(TypeError);
    const many = Array.from({ length: 501 }, (_, i) => note({ ts: `1794149001.${String(i).padStart(6, "0")}` }));
    await noteMessages(P1, "C0GEN", many, "bulk", "b5980501");
    expect(rpcCalls("exec_slack_note_messages").slice(1).map((c) => ((c.payload as Row).p_rows as unknown[]).length)).toEqual([500, 1]);
    useDb({ missing: ["exec_slack_note_messages"] });
    expect(await noteMessages(P1, "C0GEN", [note()], "bulk", "b1")).toEqual({ candidates: 0, anchors: 0, blocked: 0, optedOut: 0, jobs: 0 });
  });

  it("noteFromHim and markDeleted map their answers; markDeleted dedupes and chunks; the reasons are checked", async () => {
    useDb({ tables: { exec_slack_channels: [channel({ conv_type: "im", channel_id: "D0JANE", is_private: true, name: null })], exec_slack_messages: [message({ channel_id: "D0JANE", reasons: 1 })] } });
    expect(await noteFromHim(P1, "D0JANE", [{ ts: "1794149000.000100", thread_ts: null, mentions: [] }])).toEqual({ stamped: 1, skipped: 0 });
    expect(await markDeleted(P1, "D0JANE", ["1794100000.000100", "1794100000.000100"], "event")).toEqual({ items: 0, messages: 1, attention: 0 });
    expect((rpcCalls("exec_slack_mark_deleted")[0].payload as Row).p_ts).toEqual(["1794100000.000100"]);
    await expect(markDeleted(P1, "D0JANE", ["junk"], "event")).rejects.toBeInstanceOf(TypeError);
    await expect(markDeleted(P1, "D0JANE", [], "other" as never)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_note_from_him"] });
    expect(await noteFromHim(P1, "D0JANE", [{ ts: "1794149000.000100", thread_ts: null, mentions: [] }])).toEqual({ stamped: 0, skipped: 0 });
  });

  it("listCandidates: window by root (c / a channel message / a thread root), retriage by ts, oldest first, pending candidates only", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel(), channel({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null })],
        exec_slack_messages: [
          message({ ts: "1794100000.000300" }), message({ ts: "1794100000.000100" }),
          message({ ts: "1794100000.000200", thread_ts: "1794100000.000100" }), message({ ts: "1794100000.000400", thread_ts: "1794100000.000100", triage_state: "assessed", role: "item" }),
          message({ ts: "1794100000.000500", role: "anchor", is_dd_post: true, triage_state: "none", reasons: 0, author_user_id: null }),
          message({ channel_id: "D0JANE", ts: "1794100001.000100" }), message({ channel_id: "D0JANE", ts: "1794100001.000200", thread_ts: "1794100001.000100" })
        ]
      }
    });
    expect((await listCandidates(P1, "C0GEN", "1794100000.000100", "window")).map((c) => c.ts)).toEqual(["1794100000.000100", "1794100000.000200"]);
    expect((await listCandidates(P1, "C0GEN", "1794100000.000300", "window")).map((c) => c.ts)).toEqual(["1794100000.000300"]);
    expect((await listCandidates(P1, "D0JANE", "c", "window")).map((c) => c.ts)).toEqual(["1794100001.000100"]);
    expect(await listCandidates(P1, "C0GEN", "1794100000.000100", "retriage", "1794100000.000400")).toEqual([
      { ts: "1794100000.000400", threadTs: "1794100000.000100", authorUserId: "U0JANE", authorExternal: false, reasons: 2, triageState: "assessed", contentHash: null, editedTs: null, respondedTs: null }
    ]);
    expect(await listCandidates(P1, "C0GEN", "1794100000.000500", "retriage", "1794100000.000500")).toEqual([]);
  });

  it("listStoredTs compares ts values as numbers; setAcknowledged stamps messages and items once", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel()],
        exec_slack_messages: [message({ ts: "999999999.900000" }), message({ ts: "1794100000.000100" }), message({ ts: "1794100000.000200", thread_ts: "1794100000.000100" })],
        exec_slack_items: [item({ ts: "1794100000.000100" })]
      }
    });
    expect(await listStoredTs(P1, "C0GEN", { oldest: "1000000000.000000", latest: "1794150000.000000", threadTs: null })).toEqual(["1794100000.000100"]);
    expect(await listStoredTs(P1, "C0GEN", { oldest: "1", latest: "1794150000.000000", threadTs: null }).catch((e) => e)).toBeInstanceOf(TypeError);
    expect(await listStoredTs(P1, "C0GEN", { oldest: "1794100000.000000", latest: "1794150000.000000", threadTs: "1794100000.000100" })).toEqual(["1794100000.000200"]);
    expect(await setAcknowledged(P1, "C0GEN", ["1794100000.000100"], NOW.toISOString())).toBe(1);
    expect(await setAcknowledged(P1, "C0GEN", ["1794100000.000100"], NOW.toISOString())).toBe(0);
    expect(db.tables.exec_slack_items[0].acknowledged_at).toBe(NOW.toISOString());
  });
});

describe("ST07: items (RPC 11, the only excerpt writer) and their reads", () => {
  const row = (over: Partial<ItemWriteRow> = {}): ItemWriteRow => ({
    ts: "1794100000.000100", kind: "request", author: "U0JANE", author_label: S.authorName, author_external: false, author_internal_verified: true,
    assessed: true, addressed: true, needs_response: true, bypass_mute: false, urgency: "high", summary: S.summary, excerpt: S.excerpt, due_text: null,
    due_at: null, direction: null, source_class: "public", ...over
  });
  const outcome = (over: Partial<ItemOutcome> = {}): ItemOutcome => ({ ts: "1794100000.000100", state: "assessed", content_hash: "a".repeat(64), ...over });

  it("writeTriageResult: identical key sets; every item has an outcome; the answer mapped; only write_items' text keys carry text", async () => {
    useDb({ tables: { exec_slack_channels: [channel()], exec_slack_messages: [message(), message({ ts: "1794100000.000200" })], exec_slack_deleted: [] } });
    const r = await writeTriageResult(P1, "C0GEN", [row(), row({ ts: "1794100000.000200", kind: "decision", source_class: "private" })],
      [outcome(), outcome({ ts: "1794100000.000200" }), outcome({ ts: "1794100000.000999", state: "skipped", content_hash: null })]);
    expect(r).toEqual({ written: 2, refusedDeleted: 0, refusedMissing: 1, refusedClass: 0, refusedOptout: 0, classMismatch: 1 });
    const call = rpcCalls("exec_slack_write_items")[0];
    for (const x of (call.payload as Row).p_rows as Row[]) expect(Object.keys(x).sort()).toEqual(Object.keys(row()).sort());
    for (const x of (call.payload as Row).p_outcomes as Row[]) expect(Object.keys(x).sort()).toEqual(["content_hash", "state", "ts"]);
    assertNoSlackText(call.payload, { label: "write_items args", ignoreKeys: ITEM_TEXT_KEYS });
    expect(db.tables.exec_slack_items.map((i) => i.source_class)).toEqual(["public", "public"]);
    await expect(writeTriageResult(P1, "C0GEN", [row()], [])).rejects.toBeInstanceOf(TypeError);
    await expect(writeTriageResult(P1, "C0GEN", [], [outcome(), outcome()])).rejects.toBeInstanceOf(TypeError);
    await expect(writeTriageResult(P1, "C0GEN", [{ ...row(), text: S.text } as unknown as ItemWriteRow], [outcome()])).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_write_items"] });
    expect(await writeTriageResult(P1, "C0GEN", [row()], [outcome()])).toEqual({ written: 0, refusedDeleted: 0, refusedMissing: 0, refusedClass: 1, refusedOptout: 0, classMismatch: 0 });
  });

  it("writeTriageResult in a deny / hub / unclassified / missing channel: refusedClass for every outcome", async () => {
    useDb({ tables: { exec_slack_channels: [deny("C0D", "lead_name")] } });
    expect(await writeTriageResult(P1, "C0D", [], [outcome()])).toMatchObject({ written: 0, refusedClass: 1 });
    expect(await writeTriageResult(P1, "C0NONE", [], [outcome()])).toMatchObject({ written: 0, refusedClass: 1 });
  });

  it("listItemsForMessage maps every column; setPermalinks writes only allow-listed links", async () => {
    useDb({ tables: { exec_slack_channels: [channel()], exec_slack_messages: [message()], exec_slack_items: [item()] } });
    const [it0] = await listItemsForMessage(P1, "C0GEN", "1794100000.000100");
    expect(it0).toMatchObject({ id: `esl_${hex32(1)}`, channelId: "C0GEN", kind: "request", authorLabel: S.authorName, excerpt: S.excerpt, summary: S.summary,
      sourceClass: "public", assessed: true, expiresAt: "2027-02-01T00:00:00.000Z" });
    await setPermalinks(P1, [{ id: it0.id, permalink: "https://evil.example/archives/C0GEN/p1794100000000100" }]);
    expect(db.tables.exec_slack_items[0].permalink).toBeNull();
    await setPermalinks(P1, [{ id: it0.id, permalink: "https://scaledai.slack.com/archives/C0GEN/p1794100000000100" }]);
    expect(db.tables.exec_slack_items[0].permalink).toBe("https://scaledai.slack.com/archives/C0GEN/p1794100000000100");
  });

  it("listItemsForAttention: open non-fyi items of the last 14 days and commitments due in [now − 30 d, now], with their channel rows", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel(), channel({ channel_id: "C0OTHER" })],
        exec_slack_messages: [message(), message({ ts: "1794100000.000200" }), message({ ts: "1794100000.000300" }), message({ channel_id: "C0OTHER" })],
        exec_slack_items: [
          item({ n: 1 }), item({ n: 2, ts: "1794100000.000200", kind: "fyi" }), item({ n: 3, ts: "1794100000.000300", responded_ts: "1794100001.000000", responded_at: NOW.toISOString() }),
          item({ n: 4, channel_id: "C0OTHER", kind: "commitment", commitment_direction: "mitchell_owes", created_at: "2026-10-01T00:00:00.000Z", due_at: "2026-11-01T00:00:00.000Z" }),
          item({ n: 5, created_at: "2026-10-01T00:00:00.000Z", ts: "1794100000.000300", kind: "decision" })
        ]
      }
    });
    const r = await listItemsForAttention(P1, NOW);
    expect(r.items.map((i) => i.id).sort()).toEqual([`esl_${hex32(1)}`, `esl_${hex32(4)}`]);
    expect(r.channels.map((c) => c.channelId).sort()).toEqual(["C0GEN", "C0OTHER"]);
  });

  it("listItemsForAttention (fixer correctness-6): an owed_to_mitchell commitment he answered and that is now due is still returned and produces slack_commitment (§3.13: open until 30 days overdue)", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel()],
        exec_slack_messages: [message(), message({ ts: "1794100000.000300" })],
        exec_slack_items: [
          item({ n: 1, kind: "commitment", commitment_direction: "owed_to_mitchell", created_at: "2026-10-01T00:00:00.000Z", due_at: "2026-11-07T00:00:00.000Z",
            responded_ts: "1794100001.000000", responded_at: "2026-11-02T00:00:00.000Z" }),
          item({ n: 3, ts: "1794100000.000300", kind: "commitment", commitment_direction: "mitchell_owes", created_at: "2026-10-01T00:00:00.000Z",
            due_at: "2026-11-07T00:00:00.000Z", responded_ts: "1794100001.000000", responded_at: "2026-11-02T00:00:00.000Z" })
        ]
      }
    });
    const r = await listItemsForAttention(P1, NOW);
    expect(r.items.map((i) => i.id).sort()).toEqual([`esl_${hex32(1)}`, `esl_${hex32(3)}`]);
    const candidates = buildSlackCandidates({ items: r.items, channels: new Map(r.channels.map((c) => [c.channelId, c])), now: NOW, tz: "America/New_York" });
    // The answered owed_to_mitchell one surfaces as a delegated commitment; the answered mitchell_owes one does not.
    expect(candidates.map((c) => [c.fingerprint, c.kind])).toEqual([["slack:msg:C0GEN:1794100000.000100", "slack_commitment"]]);
  });

  it("listItemsForAttention (fixer correctness-5): answered: true (a registered check-in hook) also returns the stamped items of the window; without it only the unanswered ones", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel()],
        exec_slack_messages: [message(), message({ ts: "1794100000.000200" })],
        exec_slack_items: [item({ n: 1, responded_ts: "1794100001.000000", responded_at: NOW.toISOString() }), item({ n: 2, ts: "1794100000.000200" })]
      }
    });
    expect((await listItemsForAttention(P1, NOW)).items.map((i) => i.id)).toEqual([`esl_${hex32(2)}`]);
    expect((await listItemsForAttention(P1, NOW, { answered: true })).items.map((i) => i.id).sort()).toEqual([`esl_${hex32(1)}`, `esl_${hex32(2)}`]);
  });

  it("unstampAnswered un-stamps messages and items by the responded ts; counts open items and pending candidates; lastSweepAt", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel({ swept_at: "2026-11-08T10:00:00.000Z" }), channel({ channel_id: "C0B", swept_at: "2026-11-08T12:00:00.000Z" })],
        exec_slack_messages: [message({ responded_ts: "1794100001.000000", responded_at: NOW.toISOString() }), message({ ts: "1794100000.000200" })],
        exec_slack_items: [item({ responded_ts: "1794100001.000000", responded_at: NOW.toISOString() }), item({ n: 2, ts: "1794100000.000200", kind: "fyi" })]
      }
    });
    expect(await countOpenItems(P1)).toBe(0);
    expect(await unstampAnswered(P1, [{ channelId: "C0GEN", respondedTs: "1794100001.000000" }, { channelId: "bad", respondedTs: "x" }])).toBe(1);
    expect(db.tables.exec_slack_messages[0]).toMatchObject({ responded_ts: null, responded_at: null });
    expect(await countOpenItems(P1)).toBe(1);
    expect(await countPendingTriage(P1)).toBe(2);
    expect(await lastSweepAt(P1)).toBe("2026-11-08T12:00:00.000Z");
    useDb({ missing: ["exec_slack_items", "exec_slack_messages", "exec_slack_channels"] });
    expect([await countOpenItems(P1), await countPendingTriage(P1), await lastSweepAt(P1)]).toEqual([0, 0, null]);
  });

  it("slackScreenRows: readingLive needs a live half and the switch; the item of highest precedence; messages and markers by fingerprint", async () => {
    const fp = (c: string, t: string) => `slack:msg:${c}:${t}`;
    const seed = (switchOn: boolean, half: Row = {}) =>
      useDb({
        slack: { tables: { exec_slack_installations: [inst(half)] } },
        tables: {
          exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: switchOn, slack_daily_cap_usd: 2, watch_mode: "member_only", updated_at: NOW.toISOString() }],
          exec_slack_channels: [channel(), channel({ channel_id: "C0FIN", class: "external", is_ext_shared: true, ext_ever: true, finance_name: true, watch_state: "muted", mute_source: "default_finance" })],
          exec_slack_messages: [message(), message({ ts: "1794100000.000200" })],
          exec_slack_items: [item({ n: 1, kind: "commitment", commitment_direction: "mitchell_owes" }), item({ n: 2, kind: "decision", bypass_mute: true }),
            item({ n: 3, ts: "1794100000.000200", kind: "request", assessed: false, summary: null, excerpt: null })],
          exec_slack_deleted: [{ principal_id: "ep_1", channel_id: "C0GEN", ts: "1794100000.000900", reason: "event", deleted_at: NOW.toISOString(), expires_at: "2026-11-09T17:00:00.000Z" }]
        }
      });
    seed(true);
    const r = await slackScreenRows(P1, [{ channelId: "C0GEN", ts: "1794100000.000100" }, { channelId: "C0GEN", ts: "1794100000.000200" },
      { channelId: "C0GEN", ts: "1794100000.000900" }, { channelId: "C0FIN", ts: "1794100000.000300" }, { channelId: "junk", ts: "x" }]);
    expect(r.readingLive).toBe(true);
    expect([...r.channels.keys()].sort()).toEqual(["C0FIN", "C0GEN"]);
    expect(r.channels.get("C0FIN")).toEqual({ class: "external", watchState: "muted", muteSource: "default_finance", financeName: true });
    expect(r.items.get(fp("C0GEN", "1794100000.000100"))).toEqual({ bypassMute: true, sourceClass: "public" });
    expect(r.items.get(fp("C0GEN", "1794100000.000200"))).toEqual({ bypassMute: false, sourceClass: "public" });
    expect([...r.messages].sort()).toEqual([fp("C0GEN", "1794100000.000100"), fp("C0GEN", "1794100000.000200")]);
    expect([...r.markers]).toEqual([fp("C0GEN", "1794100000.000900")]);
    seed(false);
    expect((await slackScreenRows(P1, [{ channelId: "C0GEN", ts: "1794100000.000100" }])).readingLive).toBe(false);
    seed(true, { user_token_enc: null, user_key_id: null, reading_state: "revoked", discovered_at: null, user_revoked_at: NOW.toISOString(), user_revoke_reason: "stopped" });
    expect((await slackScreenRows(P1, [{ channelId: "C0GEN", ts: "1794100000.000100" }])).readingLive).toBe(false);
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, fail: (c) => (c.target === "exec_slack_items" ? { code: "57014", message: "timeout" } : null) });
    expect(await thrown(slackScreenRows(P1, [{ channelId: "C0GEN", ts: "1794100000.000100" }]))).toMatchObject({ op: "slackScreenRows", pgCode: "57014" });
  });
});

describe("ST08: the limiter, the DD bot row, opt-outs, the outbox, the gate's drop list", () => {
  it("rateTake / rateBlock / rateBlocks: the answer mapped; refusals carry wait_ms and a reason; a missing schema throws (no unmetered call)", async () => {
    useDb();
    for (let i = 0; i < 30; i += 1) expect(await rateTake("T0SCALED", "conversations.history", "sweep", 1, NOW)).toEqual({ allowed: true, waitMs: 0 });
    expect(await rateTake("T0SCALED", "conversations.history", "sweep", 1, NOW)).toEqual({ allowed: false, waitMs: 60_000, reason: "budget" });
    expect(await rateTake("T0SCALED", "conversations.history", "triage", 10, NOW)).toEqual({ allowed: true, waitMs: 0 });
    await rateBlock("T0SCALED", "users.info", new Date(NOW.getTime() + 30_000));
    expect(await rateTake("T0SCALED", "users.info", "triage", 1, NOW)).toEqual({ allowed: false, waitMs: 30_000, reason: "blocked" });
    expect(await rateBlocks("T0SCALED")).toEqual([]);   // the fake's rateBlocks reads with the real clock: NOW is in the past
    await expect(rateTake("T0SCALED", "chat.postMessage" as never, "triage", 1, NOW)).rejects.toBeInstanceOf(TypeError);
    await expect(rateTake("T0SCALED", "users.info", "triage", 11, NOW)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_rate_take"] });
    expect(await thrown(rateTake("T0SCALED", "users.info", "triage", 1, NOW))).toMatchObject({ op: "not_installed", pgCode: "PGRST202" });
  });

  it("rateBlocks lists the methods blocked past now", async () => {
    useDb({ tables: { exec_slack_rate: [
      { team_id: "T0SCALED", method: "users.info", window_start: NOW.toISOString(), n_total: 0, n_triage: 0, n_sweep: 0, n_probe: 0, n_discovery: 0,
        blocked_until: new Date(Date.now() + 60_000).toISOString(), updated_at: NOW.toISOString() },
      { team_id: "T0SCALED", method: "users.list", window_start: NOW.toISOString(), n_total: 0, n_triage: 0, n_sweep: 0, n_probe: 0, n_discovery: 0,
        blocked_until: new Date(Date.now() - 60_000).toISOString(), updated_at: NOW.toISOString() }
    ] } });
    expect((await rateBlocks("T0SCALED")).map((b) => b.method)).toEqual(["users.info"]);
    expect(await rateBlocks("not a team")).toEqual([]);
  });

  it("getDdBotRow / saveDdBotRow (upsert by team; the CHECK holds ok ⇔ ids and no code)", async () => {
    useDb();
    expect(await getDdBotRow("T0SCALED")).toBeNull();
    await saveDdBotRow({ teamId: "T0SCALED", ok: true, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", errorCode: null, checkedAt: NOW.toISOString() });
    await saveDdBotRow({ teamId: "T0SCALED", ok: true, userId: "U0DDBOT", botId: "B0DDBOT", appId: null, errorCode: null, checkedAt: NOW.toISOString() });
    expect(await getDdBotRow("T0SCALED")).toEqual({ ok: true, userId: "U0DDBOT", botId: "B0DDBOT", appId: null, errorCode: null, checkedAt: NOW.toISOString() });
    expect(await thrown(saveDdBotRow({ teamId: "T0SCALED", ok: true, userId: null, botId: null, appId: null, errorCode: null, checkedAt: NOW.toISOString() })))
      .toMatchObject({ op: "saveDdBotRow", pgCode: "23514" });
    const call = db.calls.find((c) => c.kind === "upsert");
    expect(call?.options).toMatchObject({ onConflict: "team_id" });
  });

  it("purgeAuthor (missing → not_installed), listAuthorOptouts, listPurgeLog after an id, listGateDropChannels", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel(), deny("C0D", "lead_name"), channel({ channel_id: "C0U", class: "unclassified", name: null, watch_state: "unwatched" }),
          deny("C0P2", "lead_name", { principal_id: "ep_2" })],
        exec_slack_messages: [message({ author_user_id: "U0JANE" })], exec_slack_items: [item()]
      }
    });
    expect(await purgeAuthor(P1, "U0JANE")).toEqual({ conversations: 0, messages: 1, items: 1, attention: 0 });
    expect(await listAuthorOptouts(P1)).toEqual(["U0JANE"]);
    const log = await listPurgeLog(P1, 0, 10);
    expect(log).toEqual([{ id: 1, scope: "message", channelId: "C0GEN", ts: "1794100000.000100", reason: "author_optout", createdAt: NOW.toISOString() }]);
    expect(await listPurgeLog(P1, 1, 10)).toEqual([]);
    expect(await listGateDropChannels(["ep_1", "ep_2"])).toEqual([
      { principalId: "ep_1", channelId: "C0D", class: "deny" }, { principalId: "ep_1", channelId: "C0U", class: "unclassified" },
      { principalId: "ep_2", channelId: "C0P2", class: "deny" }
    ]);
    await expect(purgeAuthor(P1, "bad")).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_purge_author", "exec_slack_author_optouts", "exec_slack_purge_log", "exec_slack_channels"] });
    expect(await thrown(purgeAuthor(P1, "U0JANE"))).toMatchObject({ op: "not_installed" });
    expect([await listAuthorOptouts(P1), await listPurgeLog(P1, 0, 5), await listGateDropChannels(["ep_1"])]).toEqual([[], [], []]);
  });

  it("P7b fixer (security-3) latestAuthorOptoutAt: the newest opt-out's time, his own only; none or missing → null; a failure throws", async () => {
    useDb({ tables: { exec_slack_author_optouts: [
      { principal_id: "ep_1", author_user_id: "U0JANE", created_at: "2026-11-01T10:00:00.000Z" },
      { principal_id: "ep_1", author_user_id: "U0SAM", created_at: "2026-11-07T10:00:00.000Z" },
      { principal_id: "ep_2", author_user_id: "U0SAM", created_at: "2026-11-08T10:00:00.000Z" }
    ] } });
    expect(await latestAuthorOptoutAt(P1)).toBe("2026-11-07T10:00:00.000Z");
    expect(await latestAuthorOptoutAt(principal("ep_3"))).toBeNull();
    const select = db.calls.find((c) => c.kind === "select" && c.target === "exec_slack_author_optouts");
    expect(select?.columns).toBe("created_at");
    useDb({ missing: ["exec_slack_author_optouts"] });
    expect(await latestAuthorOptoutAt(P1)).toBeNull();
    useDb({ fail: (call) => (call.target === "exec_slack_author_optouts" ? { code: "57014", message: "timeout" } : null) });
    expect(await thrown(latestAuthorOptoutAt(P1))).toMatchObject({ op: "latestAuthorOptoutAt", pgCode: "57014" });
  });
});

describe("PG02-PG06: the purge functions map their answers and the missing schema", () => {
  it("PG02: purgeExpiredSlack — the seven counts, p_now = now, the signal; missing → every count 0", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel(), channel({ channel_id: "C0LEFT", left_at: "2026-09-01T00:00:00.000Z", watch_state: "unwatched" })],
        exec_slack_messages: [message({ expires_at: "2026-11-01T00:00:00.000Z" }), message({ ts: "1794100000.000200" })],
        exec_slack_items: [item({ expires_at: "2026-11-01T00:00:00.000Z" })],
        exec_attention_items: [attention("slack:msg:C0GEN:1794100000.000100"), attention("slack:msg:C0GEN:1794100000.000200"), attention("slack:digest:x")]
      }
    });
    const signal = new AbortController().signal;
    expect(await purgeExpiredSlack(NOW, { signal })).toEqual({ items: 1, messages: 1, threads: 0, markers: 0, log: 0, channels: 1, attention: 1 });
    expect(rpcCalls("exec_slack_purge_expired")[0]).toMatchObject({ payload: { p_now: NOW.toISOString() }, signal });
    expect(db.tables.exec_attention_items.map((a) => a.fingerprint)).toEqual(["slack:msg:C0GEN:1794100000.000200", "slack:digest:x"]);
    useDb({ missing: ["exec_slack_purge_expired"] });
    expect(await purgeExpiredSlack(NOW)).toEqual({ items: 0, messages: 0, threads: 0, markers: 0, log: 0, channels: 0, attention: 0 });
  });

  it("PG03: purgeReading — the counts (purged as 1/0); a live half raises (P0001); missing → null", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_slack_channels: [channel()] } });
    expect(await thrown(purgeReading(INST))).toMatchObject({ op: "purgeReading", pgCode: "P0001" });
    db.tables.exec_slack_installations[0].revoked_at = NOW.toISOString();
    db.tables.exec_slack_installations[0].revoke_reason = "app_uninstalled";
    expect(await purgeReading(INST)).toEqual({ purged: 1, channels: 1, attention: 0, events: 0 });
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ user_token_enc: null, reading_state: "revoked", user_revoke_reason: "installation_revoked" });
    expect(await purgeReading(INST_2)).toEqual({ purged: 0 });
    useDb({ missing: ["exec_slack_purge_reading"] });
    expect(await purgeReading(INST)).toBeNull();
  });

  it("PG04: userRevoke — revoked and the purge counts in one call; a second call purges nothing; missing → { revoked: false, purge: null }", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_slack_channels: [channel()], exec_slack_messages: [message()] } });
    expect(await userRevoke(INST, "stopped")).toEqual({ revoked: true, purge: { purged: 1, channels: 1, attention: 0, events: 0 } });
    expect(await userRevoke(INST, "stopped")).toEqual({ revoked: false, purge: null });
    await expect(userRevoke(INST, "bogus" as never)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_user_revoke"] });
    expect(await userRevoke(INST, "stopped")).toEqual({ revoked: false, purge: null });
  });

  it("PG05: purgeConversation — the counts; an unknown reason is refused here; missing → {}", async () => {
    useDb({ tables: { exec_slack_channels: [channel()], exec_slack_messages: [message()], exec_slack_items: [item()], exec_attention_items: [attention("slack:msg:C0GEN:1794100000.000100")] } });
    expect(await purgeConversation(P1, "C0GEN", "left")).toEqual({ items: 1, messages: 1, threads: 0, attention: 1 });
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ watch_state: "unwatched", is_member: false, left_at: NOW.toISOString() });
    await expect(purgeConversation(P1, "C0GEN", "author_optout" as never)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_purge_conversation"] });
    expect(await purgeConversation(P1, "C0GEN", "deny")).toEqual({});
  });

  it("PG06: markDeleted — the marker (26 h), the rows, the exact attention fingerprint, one purge-log row; missing → zeros", async () => {
    useDb({
      tables: {
        exec_slack_channels: [channel()], exec_slack_messages: [message()], exec_slack_items: [item()],
        exec_attention_items: [attention("slack:msg:C0GEN:1794100000.000100"), attention("slack:msg:C0GEN:1794100000.0001009")]
      }
    });
    expect(await markDeleted(P1, "C0GEN", ["1794100000.000100"], "event")).toEqual({ items: 1, messages: 1, attention: 1 });
    expect(db.tables.exec_slack_deleted[0]).toMatchObject({ ts: "1794100000.000100", reason: "event", expires_at: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() });
    expect(db.tables.exec_attention_items.map((a) => a.fingerprint)).toEqual(["slack:msg:C0GEN:1794100000.0001009"]);
    expect(db.tables.exec_slack_purge_log.map((l) => clean({ scope: l.scope, channel_id: l.channel_id, ts: l.ts, reason: l.reason }))).toEqual([
      { scope: "message", channel_id: "C0GEN", ts: "1794100000.000100", reason: "deleted_event" }
    ]);
    useDb({ missing: ["exec_slack_mark_deleted"] });
    expect(await markDeleted(P1, "C0GEN", ["1794100000.000100"], "event")).toEqual({ items: 0, messages: 0, attention: 0 });
  });
});

describe("ST-FX: the P7a fixer's store rules (the fake mirrors the migration; RQ37-RQ43 are the SQL twins)", () => {
  const facts = (over: Partial<SlackEventFacts> = {}): SlackEventFacts => ({
    eventId: "Ev0FX01", teamId: "T0SCALED", apiAppId: "A0EXEC", eventType: "message", eventTime: 1794150000, retryNum: 0, channel: "C0GEN",
    channelType: "channel", user: "U0JANE", ts: "1794150000.000100", threadTs: null, hasBotId: false, hasAppId: false, subtype: null, hidden: false,
    textIsString: true, hasMessage: false, tab: null, revokedBotIds: [], revokedUserIds: [], ...over
  });
  const signal = new AbortController().signal;
  const reading = (tables: Partial<Record<string, Row[]>>) =>
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: true, retention_days_slack: 90 }], ...tables } as never });
  const mention = (channelId: string, eventId: string) =>
    acceptEventV2(facts({ eventId, channel: channelId }), { kind: "msg", conv: "channel", ts: "1794150000.000100", author: "U0JANE", auth_user: "U0MITCH",
      is_bot: false, len: 2, mentions: ["U0MITCH"] }, { signal });

  it("FX-S1 (security-1): Mute on a finance channel is the closed finance mute, so a mention there is never a candidate; a legacy owner mute on one doesn't bypass either", async () => {
    reading({ exec_slack_channels: [channel({ channel_id: "C0FIN", class: "finance", finance_name: true, watch_state: "unwatched", name: "payroll" }),
      channel({ channel_id: "C0PAY", class: "external", is_ext_shared: true, ext_ever: true, finance_name: true, watch_state: "unwatched", name: "acme-payroll" }),
      channel({ channel_id: "C0OLD", class: "finance", finance_name: true, watch_state: "muted", mute_source: "owner", name: "legal" }),
      channel({ channel_id: "C0GEN", watch_state: "unwatched" })] });
    for (const id of ["C0FIN", "C0PAY", "C0GEN"]) expect((await setWatch(P1, id, "muted", "2026-11-01T01:00:00.000Z", false)).outcome, id).toBe("updated");
    const src = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id)!.mute_source;
    expect([src("C0FIN"), src("C0PAY"), src("C0GEN")]).toEqual(["default_finance", "default_finance", "owner"]);
    for (const [id, ev] of [["C0FIN", "Ev0FX01A"], ["C0PAY", "Ev0FX01B"], ["C0OLD", "Ev0FX01C"]] as const) {
      expect(await mention(id, ev), id).toMatchObject({ decision: "drop", reason: "muted", recorded: false });
    }
    // An owner mute on an ordinary channel still lets his mention through (N11).
    expect(await mention("C0GEN", "Ev0FX01D")).toMatchObject({ decision: "ingest", reason: "candidate" });
    expect(db.tables.exec_slack_messages.map((m) => m.channel_id)).toEqual(["C0GEN"]);
  });

  it("FX-S2 (security-2): in a deny conversation the delete, the his-message and the note writers store nothing (no marker, no purge-log row, no thread row, no candidate); a deny -> deny re-classification clears what a raced write left, with no log row", async () => {
    reading({ exec_slack_channels: [deny("C0LEADS", "lead_name")] });
    expect(await markDeleted(P1, "C0LEADS", ["1794150000.000100"], "absent")).toEqual({ items: 0, messages: 0, attention: 0 });
    expect(await noteFromHim(P1, "C0LEADS", [{ ts: "1794150000.000200", thread_ts: null, mentions: [] }])).toEqual({ stamped: 0, skipped: 1 });
    expect(await noteMessages(P1, "C0LEADS", [{ ts: "1794150000.000300", thread_ts: null, role: "candidate", author: "U0JANE", author_external: false, reasons: 2, dd_paths: [] }], "bulk", "b1"))
      .toMatchObject({ candidates: 0, jobs: 0 });
    expect([db.tables.exec_slack_deleted, db.tables.exec_slack_purge_log, db.tables.exec_slack_threads, db.tables.exec_slack_messages]).toEqual([[], [], [], []]);
    expect(db.locks.filter((l) => ["exec_slack_mark_deleted", "exec_slack_note_messages", "exec_slack_note_from_him"].includes(l.rpc)).map((l) => [l.rpc, l.mode]))
      .toEqual([["exec_slack_mark_deleted", "share"], ["exec_slack_note_from_him", "share"], ["exec_slack_note_messages", "share"]]);
    // A write that raced the deny left rows behind: the next classification (deny again) removes them, logging nothing.
    db.tables.exec_slack_messages.push(message({ channel_id: "C0LEADS", ts: "1794150000.000400" }));
    db.tables.exec_slack_threads.push({ principal_id: "ep_1", channel_id: "C0LEADS", thread_ts: "1794150000.000400", he_posted_ts: null, reply_watermark_ts: "1794150000.000500",
      latest_reply_seen_ts: "1794150000.000500", expires_at: "2026-12-01T00:00:00.000Z", updated_at: NOW.toISOString() });
    await applyClasses(P1, INST, [{ channel_id: "C0LEADS", conv_type: "channel", class: "deny", deny_reason: "lead_name", hub_kind: null, finance_name: false,
      default_watch: "unwatched", default_mute: null, name: null, im_user_id: null, is_member: true, is_private: false, is_ext_shared: false, is_archived: false }], NOW.toISOString());
    expect([db.tables.exec_slack_messages, db.tables.exec_slack_threads, db.tables.exec_slack_purge_log]).toEqual([[], [], []]);
  });

  it("FX-S3 (security-3): the writer stores no item in an unwatched or a finance-muted conversation: each outcome skipped, the stored items kept", async () => {
    for (const ch of [channel({ watch_state: "unwatched" }), channel({ class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" })]) {
      useDb({ tables: { exec_slack_channels: [ch], exec_slack_messages: [message(), message({ ts: "1794100000.000200", role: "item", triage_state: "assessed" })],
        exec_slack_items: [item({ n: 2, ts: "1794100000.000200", source_class: ch.class === "finance" ? "finance" : "public" })] } });
      const row: ItemWriteRow = { ts: "1794100000.000100", kind: "request", author: "U0JANE", author_label: S.authorName, author_external: false,
        author_internal_verified: true, assessed: true, addressed: true, needs_response: true, bypass_mute: true, urgency: "high", summary: S.summary,
        excerpt: S.excerpt, due_text: null, due_at: null, direction: null, source_class: ch.class === "finance" ? "finance" : "public" };
      const r = await writeTriageResult(P1, "C0GEN", [row], [{ ts: "1794100000.000100", state: "assessed", content_hash: null },
        { ts: "1794100000.000200", state: "skipped", content_hash: null }]);
      expect(r, String(ch.watch_state)).toMatchObject({ written: 0, refusedClass: 2 });
      expect(db.tables.exec_slack_items.map((i) => i.ts)).toEqual(["1794100000.000200"]);
      expect(db.tables.exec_slack_messages.map((m) => [m.ts, m.role, m.triage_state])).toEqual([["1794100000.000100", "candidate", "skipped"], ["1794100000.000200", "item", "skipped"]]);
    }
  });

  it("FX-S5 (security-5): a deny row's lifecycle events store nothing (no event row, no purge-log row, no job); channel_deleted removes the bare marker; channel_id_changed still moves it", async () => {
    reading({ exec_slack_channels: [deny("C0LEADS", "lead_name")] });
    const lc = (eventId: string, eventType: string, ingest: Record<string, unknown>) =>
      acceptEventV2(facts({ eventId, eventType, channel: "C0LEADS", user: null, ts: null }), { kind: "lifecycle", auth_user: "U0MITCH", ...ingest }, { signal });
    for (const [ev, type, ing] of [["Ev0FX05A", "channel_left", { lc: "left" }], ["Ev0FX05B", "channel_archive", { lc: "archive" }],
      ["Ev0FX05C", "channel_rename", { lc: "rename", name: "general" }], ["Ev0FX05D", "channel_shared", { lc: "shared" }],
      ["Ev0FX05E", "channel_unarchive", { lc: "unarchive" }]] as const) {
      expect(await lc(ev, type, ing), type).toMatchObject({ decision: "drop", reason: "deny", recorded: false });
    }
    expect(db.tables.exec_slack_events).toEqual([]);
    expect(db.tables.exec_slack_purge_log).toEqual([]);
    expect(db.tables.exec_jobs).toEqual([]);
    expect(db.tables.exec_slack_channels).toEqual([expect.objectContaining({ channel_id: "C0LEADS", class: "deny", is_archived: false, left_at: null })]);
    expect(await lc("Ev0FX05F", "channel_id_changed", { lc: "id_changed", new_channel: "C0LEADS2" })).toMatchObject({ decision: "lifecycle", reason: "rekey" });
    expect(db.tables.exec_jobs.map((j) => j.kind)).toEqual(["exec.slack-rekey"]);
    expect(await lc("Ev0FX05G", "channel_deleted", { lc: "deleted" })).toMatchObject({ decision: "drop", reason: "deny", recorded: false });
    expect(db.tables.exec_slack_channels).toEqual([]);
    expect(db.tables.exec_slack_purge_log).toEqual([]);
    // finish_discovery: a deny marker the listing no longer returns goes without a purge-log row (rule 7).
    db.tables.exec_slack_channels.push(deny("C0GONE", "lead_name", { seen_at: "2026-11-01T00:00:00.000Z" }));
    expect(await finishDiscovery(P1, INST, NOW.toISOString())).toEqual({ ready: true, removed: 1 });
    expect(db.tables.exec_slack_channels).toEqual([]);
    expect(db.tables.exec_slack_purge_log).toEqual([]);
  });

  it("FX-S7 (security-7): a re-key onto an id already denied keeps the deny marker; the old row's data and row go", async () => {
    useDb({ tables: { exec_slack_channels: [channel({ channel_id: "C0OLD" }), deny("C0NEWID", "fb_list")], exec_slack_messages: [message({ channel_id: "C0OLD" })],
      exec_slack_items: [item({ channel_id: "C0OLD" })] } });
    expect(await rekeyChannel(P1, "C0OLD", "C0NEWID")).toEqual({ rekeyed: false });
    expect(db.tables.exec_slack_channels).toEqual([expect.objectContaining({ channel_id: "C0NEWID", class: "deny", deny_reason: "fb_list" })]);
    expect([db.tables.exec_slack_messages, db.tables.exec_slack_items]).toEqual([[], []]);
    expect(db.tables.exec_slack_purge_log.map((l) => [l.scope, l.channel_id, l.reason])).toEqual([["conversation", "C0OLD", "deny"]]);
  });

  it("FX-S8 (security-8): a hand-typed FB list name (spaces, upper case, punctuation, no URL) still denies the channel renamed to it", async () => {
    reading({ exec_slack_channels: [channel()], fb_onboarding: [{ task_id: "t1", state: { "access.notify.slack_channels": { v: JSON.stringify([{ name: "Zeta Intake Team!" }]) } } }] });
    const r = await acceptEventV2(facts({ eventId: "Ev0FX08A", eventType: "channel_rename", user: null, ts: null }),
      { kind: "lifecycle", auth_user: "U0MITCH", lc: "rename", name: "zeta-intake-team" }, { signal });
    expect(r).toMatchObject({ decision: "lifecycle", reason: "denied" });
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ class: "deny", deny_reason: "fb_list", name: null });
  });

  it("FX-U11 (ui-11): Slack revoking his token after a failed Stop clears the 'remove the access in Slack' code on the revoked half", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({ user_token_enc: null, user_key_id: null, user_scopes: [], reading_state: "revoked", discovered_at: null,
      user_revoked_at: "2026-11-08T10:00:00.000Z", user_revoke_reason: "stopped", user_last_error_code: "revoke_failed", user_last_error_at: "2026-11-08T10:00:00.000Z",
      reading_purged_at: "2026-11-08T10:00:00.000Z" })] } } });
    await acceptEventV2(facts({ eventId: "Ev0FX11A", eventType: "tokens_revoked", channel: null, user: null, ts: null, revokedUserIds: ["U0OTHER"] }), null, { signal });
    expect(db.tables.exec_slack_installations[0].user_last_error_code).toBe("revoke_failed");
    await acceptEventV2(facts({ eventId: "Ev0FX11B", eventType: "tokens_revoked", channel: null, user: null, ts: null, revokedUserIds: ["U0MITCH"] }), null, { signal });
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ user_last_error_code: null, user_last_error_at: null, reading_state: "revoked" });
  });
});

describe("ST17 (C48): every RPC's argument keys are the migration's parameter names", () => {
  /** `create or replace function public.<name>(<params>)` → name → parameter names, from the migration text. */
  function signatures(sql: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const re = /create or replace function public\.([a-z0-9_]+)\(([^)]*)\)/g;
    for (const m of sql.matchAll(re)) {
      const params = m[2]
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join(" ")
        .split(",")
        .map((p) => p.trim().split(/\s+/)[0])
        .filter((p) => p.length > 0);
      out.set(m[1], params);
    }
    return out;
  }

  it("the parser reads the twenty-five functions, v2 with its 21 names (p_ingest last)", () => {
    const sigs = signatures(MIGRATION);
    expect(sigs.size).toBe(25);
    expect(sigs.get("exec_slack_save_thread_watermark")).toEqual(["p_principal", "p_channel", "p_thread_ts", "p_watermark", "p_latest"]);
    expect(sigs.get("exec_slack_accept_event_v2")).toEqual([
      "p_event_id", "p_team_id", "p_api_app_id", "p_event_type", "p_event_time", "p_retry_num", "p_channel", "p_channel_type", "p_user", "p_ts",
      "p_thread_ts", "p_has_bot_id", "p_has_app_id", "p_subtype", "p_hidden", "p_text_is_string", "p_has_message", "p_tab", "p_revoked_bot_ids",
      "p_revoked_user_ids", "p_ingest"
    ]);
  });

  it("every store function's rpc() call names exactly its function's parameters", async () => {
    const sigs = signatures(MIGRATION);
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_slack_channels: [channel()] } });
    const facts: SlackEventFacts = {
      eventId: "Ev0ST17", teamId: "T0SCALED", apiAppId: "A0EXEC", eventType: "message", eventTime: 1794150000, retryNum: 0, channel: "C0GEN",
      channelType: "channel", user: "U0JANE", ts: NOW_TS, threadTs: null, hasBotId: false, hasAppId: false, subtype: null, hidden: false, textIsString: true,
      hasMessage: false, tab: null, revokedBotIds: [], revokedUserIds: []
    };
    const run: (() => Promise<unknown>)[] = [
      () => acceptEventV2(facts, { kind: "msg", conv: "channel", ts: NOW_TS, auth_user: "U0MITCH" }, { signal: new AbortController().signal }),
      () => applyClasses(P1, INST, [], NOW.toISOString()).then(() => applyClasses(P1, INST, [{ channel_id: "C0GEN", conv_type: "channel", class: "standard",
        deny_reason: null, hub_kind: null, finance_name: false, default_watch: "watched", default_mute: null, name: "general", im_user_id: null, is_member: true,
        is_private: false, is_ext_shared: false, is_archived: false }], NOW.toISOString())),
      () => finishDiscovery(P1, INST, NOW.toISOString()),
      () => setWatch(P1, "C0GEN", "muted", "2026-11-01T01:00:00.000Z", false),
      () => purgeConversation(P1, "C0GEN", "gone"),
      () => rekeyChannel(P1, "C0GEN", "C0GEN2"),
      () => noteMessages(P1, "C0GEN2", [{ ts: NOW_TS, thread_ts: null, role: "candidate", author: "U0JANE", author_external: false, reasons: 2, dd_paths: [] }], "bulk", "b1"),
      () => noteFromHim(P1, "C0GEN2", [{ ts: NOW_TS, thread_ts: null, mentions: [] }]),
      () => saveThreadWatermark(P1, "C0GEN2", NOW_TS, { replyWatermarkTs: NOW_TS, latestReplySeenTs: NOW_TS }),
      () => markDeleted(P1, "C0GEN2", [NOW_TS], "absent"),
      () => writeTriageResult(P1, "C0GEN2", [], [{ ts: NOW_TS, state: "skipped", content_hash: null }]),
      () => userRevoke(INST, "stopped"),
      () => purgeReading(INST),
      () => purgeExpiredSlack(NOW),
      () => rateTake("T0SCALED", "users.info", "triage", 1, NOW),
      () => rateBlock("T0SCALED", "users.info", NOW),
      () => purgeAuthor(P1, "U0JANE")
    ];
    for (const f of run) await f();
    const called = db.calls.filter((c) => c.kind === "rpc");
    const names = new Set(called.map((c) => c.target));
    expect([...names].sort()).toEqual([
      "exec_slack_accept_event_v2", "exec_slack_apply_classes", "exec_slack_finish_discovery", "exec_slack_mark_deleted", "exec_slack_note_from_him",
      "exec_slack_note_messages", "exec_slack_purge_author", "exec_slack_purge_conversation", "exec_slack_purge_expired", "exec_slack_purge_reading",
      "exec_slack_rate_block", "exec_slack_rate_take", "exec_slack_rekey_channel", "exec_slack_save_thread_watermark", "exec_slack_set_watch",
      "exec_slack_user_revoke", "exec_slack_write_items"
    ]);
    for (const c of called) {
      const want = sigs.get(c.target);
      expect(want, c.target).toBeDefined();
      expect(Object.keys(c.payload as Row).sort(), c.target).toEqual([...(want ?? [])].sort());
    }
    // Every RPC the store names is one of the migration's functions (no other spelling anywhere in the module).
    const src = readFileSync(new URL("./slack-read-store.ts", import.meta.url), "utf8");
    for (const m of src.matchAll(/"(exec_slack_[a-z0-9_]+)"/g)) {
      if (/^exec_slack_(channels|threads|messages|items|deleted|rate|dd_bot|purge_log|author_optouts)$/.test(m[1])) continue;
      expect(sigs.has(m[1]), m[1]).toBe(true);
    }
    // P7b stage 0 (§3.17.6 P7a-2): + listIntelChannels and getSlackItemsByIds (they read tables only; no RPC); the P7b fixer
    // (security-3): + latestAuthorOptoutAt (a table read; no RPC).
    expect(Object.keys(store).filter((k) => typeof (store as Record<string, unknown>)[k] === "function").length).toBe(50);   // §3.8.1: 45 functions, the predicate, the error class, P7b's three reads
  });
});
