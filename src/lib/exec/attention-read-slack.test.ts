import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/email-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-view")>()),
  loadEmailGate: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn()
}));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  listThreadScreenRows: vi.fn()
}));
// Area A's store keeps its real body (restoreMocks puts it back before each test); wrapped so AS09 counts the reads.
vi.mock("@/lib/exec/slack-read-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/exec/slack-read-store")>();
  return { ...real, slackScreenRows: vi.fn(real.slackScreenRows) };
});

import { createFakeAttentionDb, type FakeAttentionDb, type Row } from "@/lib/exec/__tests__/fake-attention-db";
import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { getScreenedAttentionItem, listScreenedAttention, screenAttentionItems } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { sealSecret } from "@/lib/exec/crypto";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { loadEmailGate } from "@/lib/exec/email-view";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { slackScreenRows } from "@/lib/exec/slack-read-store";
import { loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ruleFromRow } from "@/lib/restricted-senders";

// P7a contract §5.14 AS01-AS10, AS12 (with AS01b, AS06b) (Area E; §3.14, C20, N1, N11, C10, C45): the S3 Slack
// screen in P5a's accessor, end to end over the real attention store (fake-attention-db) and Area A's real
// slackScreenRows (fake-slack-read-db, its P7a tables and the reading half). AS11 (App Home passes surface "slack")
// is in handlers/slack-home-surface.test.ts, which mocks this module.

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const NOW = new Date("2026-11-08T15:00:00.000Z");
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const INST = `esi_${hex32(1)}`;
const NINE = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
const id = (n: number) => `ea_${n.toString(16).padStart(32, "0")}`;
const fp = (channel: string, ts: string) => `slack:msg:${channel}:${ts}`;
const TS = (n: number) => `17941000${String(n).padStart(2, "0")}.000100`;

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: "T0SCALED", slack_user_id: "U0MITCH" },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();
const settings: ExecSettings = { principalId: "ep_1", ...DEFAULT_SETTINGS, mutedChannelIds: [], emailEnabled: true, emailSchemaReady: true };

// ---------------------------------------------------------------------------
// Rows (snake_case, as A's fake holds them)
// ---------------------------------------------------------------------------

function inst(over: Row = {}): Row {
  const bot = sealSecret("xoxb-screen-test-bot", "exec_slack_installations.bot_token:ep_1");
  const user = sealSecret(S.userToken, "exec_slack_installations.user_token:ep_1");
  return {
    id: INST, principal_id: "ep_1", team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot,
    key_id: bot.split(".")[1], bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: user, user_scopes: [...NINE],
    slack_dm_channel_id: "D0MITCH", installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null,
    revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null, user_key_id: user.split(".")[1],
    user_installed_at: "2026-11-01T00:00:00.000Z", user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
    user_last_error_at: null, reading_state: "ready", discovered_at: "2026-11-01T01:00:00.000Z", reading_purged_at: null, ...over
  };
}
function channel(channelId: string, over: Row = {}): Row {
  return {
    principal_id: "ep_1", installation_id: INST, channel_id: channelId, conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null,
    finance_name: false, watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: S.channelName, im_user_id: null,
    is_member: true, is_private: false, is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null,
    swept_at: null, last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: "2026-11-01T01:00:00.000Z",
    seen_at: "2026-11-01T01:00:00.000Z", left_at: null, created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", ...over
  };
}
const denyRow = (channelId: string): Row =>
  channel(channelId, { conv_type: "im", class: "deny", deny_reason: "bot_im", name: null, watch_state: "unwatched", is_member: false, is_private: true });
function message(channelId: string, ts: string, over: Row = {}): Row {
  return {
    principal_id: "ep_1", channel_id: channelId, ts, thread_ts: null, role: "candidate", author_user_id: "U0JANE", author_external: false,
    is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "assessed", content_hash: null, edited_ts: null, responded_ts: null, responded_at: null,
    acknowledged_at: null, assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}
let itemN = 0;
function item(channelId: string, ts: string, over: Row = {}): Row {
  itemN += 1;
  return {
    id: `esl_${hex32(itemN)}`, principal_id: "ep_1", channel_id: channelId, ts, kind: "request", thread_ts: null, author_user_id: "U0JANE",
    author_label: S.authorName, author_external: false, assessed: true, addressed_to_you: true, needs_response: true, bypass_mute: false,
    urgency: "normal", summary: S.summary, excerpt: S.excerpt, due_text: null, due_at: null, commitment_direction: null, source_class: "public",
    permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z",
    created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}
const marker = (channelId: string, ts: string): Row => ({
  principal_id: "ep_1", channel_id: channelId, ts, reason: "event", deleted_at: NOW.toISOString(), expires_at: "2026-11-09T17:00:00.000Z"
});

interface World {
  channels?: Row[];
  messages?: Row[];
  items?: Row[];
  markers?: Row[];
  switchOn?: boolean;
  half?: Row | null;
  fail?: string | null;
}

let attn: FakeAttentionDb;
let slack: FakeSlackReadDb;

/** One client over both fakes: the attention table from P2b's, everything else from A's P7a fake. */
function useWorld(w: World = {}): void {
  slack = createFakeSlackReadDb({
    now: () => NOW,
    slack: { tables: { exec_slack_installations: w.half === null ? [] : [inst(w.half ?? {})] } },
    tables: {
      exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: w.switchOn !== false, slack_daily_cap_usd: 2, watch_mode: "member_only", updated_at: NOW.toISOString() }],
      exec_slack_channels: w.channels ?? [],
      exec_slack_messages: w.messages ?? [],
      exec_slack_items: w.items ?? [],
      exec_slack_deleted: w.markers ?? []
    },
    fail: (c) => (w.fail && c.target === w.fail ? { code: "57014", message: `timeout ${S.text}` } : null)
  });
  const a = attn.client as { from: (t: string) => unknown };
  const s = slack.client as { from: (t: string) => unknown; rpc: (...args: unknown[]) => unknown };
  const client = { from: (t: string) => (t === "exec_attention_items" ? a.from(t) : s.from(t)), rpc: (...args: unknown[]) => s.rpc(...args) };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
}

/** A stored attention row: a Slack message item unless given another source / fingerprint. */
function seedAttention(n: number, fingerprint: string, over: Row = {}): Row {
  const source = fingerprint.startsWith("slack:") ? "slack" : fingerprint.startsWith("email:") ? "email" : "dd";
  return attn.seed({
    id: id(n),
    principal_id: "ep_1",
    fingerprint,
    source,
    kind: source === "slack" ? "slack_request" : source === "email" ? "important_email" : "overdue_tasks",
    category: "my_action",
    priority_score: 90 - n,
    priority_band: "normal",
    title: `Title ${n}`,
    state_hash: "abcdef0123456789",
    first_seen_at: new Date(Date.parse("2026-11-01T00:00:00Z") + n * 60_000).toISOString(),
    last_seen_at: "2026-11-08T14:50:00Z",
    ...over
  });
}

const RULE = ruleFromRow({ id: "r1", pattern: "restricted.example", match_kind: "domain", label: "R" }, new Set());
const H = restrictedPolicyHash("hidden", [RULE]);
const CLEAN = screenHashesFor({ all: [{ from: "jane@acme.com", to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const threadRow: ThreadScreenRow = { threadId: "t_ok", accountId: "acc_his", state: "triaged", screenHashes: CLEAN, screenTruncated: false, screenedPolicyHash: H };

const shown = (page: { items: AttentionFeedItem[] }) => page.items.map((i) => Number.parseInt(i.id.slice(3), 16));
const list = (surface?: "web" | "slack") => listScreenedAttention(principal, {}, { now: NOW, ...(surface ? { surface } : {}) });

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  itemN = 0;
  attn = createFakeAttentionDb({ now: () => "2026-11-01T09:00:00.000Z" });
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "on", settings, pinned: ["acc_his"] });
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [RULE], hash: H });
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map([["t_ok", threadRow]].filter(([k]) => ids.includes(k as string)) as [string, ThreadScreenRow][]));
  out = captureConsole();
});
afterEach(() => {
  // §0.3 rule 4: no Slack text, name, token or summary in any log line (the channel name never leaves the store).
  assertNoSlackText(out.calls(), { label: "console" });
  vi.unstubAllEnvs();
});

/** The page carries nothing Slack-side but ids and counts: the feed's rows are the attention rows, never an item's text. */
function assertPageClean(page: ScreenedAttentionPage | { items: AttentionFeedItem[] }): void {
  assertNoSlackText(page, { label: "page" });
}

describe("the S3 Slack screen (§3.14, C20)", () => {
  it("AS01 a muted conversation (muted by him): its non-bypass item withheld (hiddenSlack 1), its bypass item kept; unmuted, both show (same rows)", async () => {
    const t1 = TS(1);
    const t2 = TS(2);
    const rows = (watch: "muted" | "watched") => ({
      channels: [channel("C0MUTE", { watch_state: watch, mute_source: watch === "muted" ? "owner" : null })],
      messages: [message("C0MUTE", t1), message("C0MUTE", t2)],
      items: [item("C0MUTE", t1), item("C0MUTE", t2, { bypass_mute: true })]
    });
    seedAttention(1, fp("C0MUTE", t1));
    seedAttention(2, fp("C0MUTE", t2));
    seedAttention(3, "dd:x:3");
    useWorld(rows("muted"));
    const muted = await list();
    expect(shown(muted)).toEqual([2, 3]);
    expect(muted).toMatchObject({ hiddenSlack: 1, slackScreen: "ok", hiddenEmail: 0, emailScreen: "none" });
    assertPageClean(muted);
    useWorld(rows("watched"));
    const back = await list();
    expect(shown(back)).toEqual([1, 2, 3]);
    expect(back).toMatchObject({ hiddenSlack: 0, slackScreen: "ok" });
  });

  it("AS01b a bypass item is never honoured under a finance default mute (a rename re-muted it); muted by him or by Slack, it shows", async () => {
    const t = TS(1);
    seedAttention(1, fp("C0FIN", t));
    const world = (muteSource: "default_finance" | "owner" | "slack") => ({
      channels: [channel("C0FIN", { class: muteSource === "default_finance" ? "finance" : "standard", finance_name: muteSource === "default_finance", watch_state: "muted", mute_source: muteSource })],
      messages: [message("C0FIN", t)],
      items: [item("C0FIN", t, { bypass_mute: true, source_class: muteSource === "default_finance" ? "finance" : "public" })]
    });
    useWorld(world("default_finance"));
    expect(await list()).toMatchObject({ items: [], hiddenSlack: 1, slackScreen: "ok" });
    useWorld(world("owner"));
    expect(shown(await list())).toEqual([1]);
    useWorld(world("slack"));
    expect(shown(await list())).toEqual([1]);
    // A muted row with no stored source stays muted (fail closed: only an owner or Slack mute is bypassed).
    useWorld({ ...world("owner"), channels: [channel("C0FIN", { watch_state: "muted", mute_source: null })] });
    expect(await list()).toMatchObject({ items: [], hiddenSlack: 1 });
  });

  it("AS01c (fixer security-1) a finance channel's mute is never bypassed on the web either, whatever its stored source (an owner or Slack mute on class finance, a finance-named Slack Connect channel)", async () => {
    const t = TS(1);
    seedAttention(1, fp("C0FIN", t));
    for (const over of [{ class: "finance", finance_name: true, mute_source: "owner" }, { class: "finance", finance_name: true, mute_source: "slack" },
      { class: "external", finance_name: true, is_ext_shared: true, ext_ever: true, mute_source: "owner" }]) {
      useWorld({ channels: [channel("C0FIN", { ...over, watch_state: "muted" })], messages: [message("C0FIN", t)],
        items: [item("C0FIN", t, { bypass_mute: true, source_class: "finance" })] });
      expect(await list(), JSON.stringify(over)).toMatchObject({ items: [], hiddenSlack: 1, slackScreen: "ok" });
    }
  });

  it("AS02 a conversation he doesn't watch: every item withheld, a bypass item included", async () => {
    const t1 = TS(1);
    const t2 = TS(2);
    seedAttention(1, fp("C0UNW", t1));
    seedAttention(2, fp("C0UNW", t2));
    useWorld({
      channels: [channel("C0UNW", { watch_state: "unwatched" })],
      messages: [message("C0UNW", t1), message("C0UNW", t2)],
      items: [item("C0UNW", t1), item("C0UNW", t2, { bypass_mute: true })]
    });
    expect(await list()).toMatchObject({ items: [], hiddenSlack: 2, slackScreen: "ok" });
  });

  it("AS03 a never-read (deny), unclassified or hub conversation, or no conversation row at all: withheld", async () => {
    const t = TS(1);
    seedAttention(1, fp("D0DENY", t));
    seedAttention(2, fp("C0UNCL", t));
    seedAttention(3, fp("C0HUB", t));
    seedAttention(4, fp("C0GONE", t));
    seedAttention(5, fp("C0OK", t));
    useWorld({
      channels: [
        denyRow("D0DENY"),
        channel("C0UNCL", { class: "unclassified", name: null, watch_state: "unwatched", classified_at: null }),
        channel("C0HUB", { class: "hub", hub_kind: "outbound" }),
        channel("C0OK")
      ],
      messages: ["D0DENY", "C0UNCL", "C0HUB", "C0GONE", "C0OK"].map((c) => message(c, t)),
      items: ["D0DENY", "C0UNCL", "C0HUB", "C0GONE", "C0OK"].map((c) => item(c, t, { bypass_mute: true }))
    });
    const page = await list();
    expect(shown(page)).toEqual([5]);
    expect(page).toMatchObject({ hiddenSlack: 4, slackScreen: "ok" });
  });

  it("AS04 no message row, or a deleted marker: withheld (and an item no longer backing the fingerprint)", async () => {
    const [t1, t2, t3, t4] = [TS(1), TS(2), TS(3), TS(4)];
    for (const [n, t] of [[1, t1], [2, t2], [3, t3], [4, t4]] as const) seedAttention(n, fp("C0GEN", t));
    useWorld({
      channels: [channel("C0GEN")],
      messages: [message("C0GEN", t2), message("C0GEN", t3), message("C0GEN", t4)],
      items: [item("C0GEN", t1), item("C0GEN", t2), item("C0GEN", t4)],
      markers: [marker("C0GEN", t2)]
    });
    const page = await list();
    // t1: no message row; t2: a marker; t3: no item; t4: shown.
    expect(shown(page)).toEqual([4]);
    expect(page).toMatchObject({ hiddenSlack: 3, slackScreen: "ok" });
  });

  it("AS05 reading switched off, stopped (revoked) or never consented: every Slack message item withheld; DD items unchanged", async () => {
    const t = TS(1);
    seedAttention(1, fp("C0GEN", t));
    seedAttention(2, "dd:x:2");
    const base = { channels: [channel("C0GEN")], messages: [message("C0GEN", t)], items: [item("C0GEN", t, { bypass_mute: true })] };
    useWorld(base);
    expect(shown(await list())).toEqual([1, 2]);
    for (const w of [
      { ...base, switchOn: false },
      { ...base, half: { user_token_enc: null, user_key_id: null, reading_state: "revoked", discovered_at: null, user_revoked_at: NOW.toISOString(), user_revoke_reason: "stopped" } },
      { ...base, half: { user_token_enc: null, user_key_id: null, user_scopes: [], user_installed_at: null, reading_state: "none", discovered_at: null } },
      { ...base, half: null }
    ] as World[]) {
      useWorld(w);
      const page = await list();
      expect(shown(page), JSON.stringify(w.half ?? w.switchOn)).toEqual([2]);
      expect(page).toMatchObject({ hiddenSlack: 1, slackScreen: "ok" });
    }
  });

  it("AS06 surface 'slack' withholds finance items (class finance, source_class finance); 'web' (the default) keeps them", async () => {
    const [t1, t2] = [TS(1), TS(2)];
    seedAttention(1, fp("C0FINW", t1));
    seedAttention(2, fp("C0GEN", t2));
    useWorld({
      channels: [channel("C0FINW", { class: "finance", finance_name: true, watch_state: "watched", mute_source: null, watch_set_by_owner_at: NOW.toISOString() }), channel("C0GEN")],
      messages: [message("C0FINW", t1), message("C0GEN", t2)],
      items: [item("C0FINW", t1, { source_class: "finance" }), item("C0GEN", t2)]
    });
    expect(shown(await list())).toEqual([1, 2]);
    expect(shown(await list("web"))).toEqual([1, 2]);
    const onSlack = await list("slack");
    expect(shown(onSlack)).toEqual([2]);
    expect(onSlack).toMatchObject({ hiddenSlack: 1, slackScreen: "ok" });
    // The by-id read and the arbitrary-items screen take the surface too.
    expect(await getScreenedAttentionItem(principal, id(1), { now: NOW, surface: "slack" })).toEqual({ ok: false, reason: "withheld" });
    expect(await getScreenedAttentionItem(principal, id(1), { now: NOW })).toMatchObject({ ok: true });
    const items = (await list()).items;
    expect(shown(await screenAttentionItems(principal, items, { surface: "slack" }))).toEqual([2]);
    expect(shown(await screenAttentionItems(principal, items))).toEqual([1, 2]);
  });

  it("AS06b a watched Slack Connect channel named like finance: finance items, and not-yet-reconciled private ones, withheld on 'slack', kept on 'web'", async () => {
    const [t1, t2] = [TS(1), TS(2)];
    seedAttention(1, fp("C0EXTF", t1));
    seedAttention(2, fp("C0EXTF", t2));
    useWorld({
      channels: [channel("C0EXTF", { class: "external", finance_name: true, is_ext_shared: true, ext_ever: true, watch_state: "watched", watch_set_by_owner_at: NOW.toISOString() })],
      messages: [message("C0EXTF", t1), message("C0EXTF", t2)],
      items: [item("C0EXTF", t1, { source_class: "finance", excerpt: null }), item("C0EXTF", t2, { source_class: "private", excerpt: null })]
    });
    expect(shown(await list("web"))).toEqual([1, 2]);
    expect(await list("slack")).toMatchObject({ items: [], hiddenSlack: 2, slackScreen: "ok" });
  });

  it("an unknown surface screens as the stricter 'slack'", async () => {
    const t = TS(1);
    seedAttention(1, fp("C0FINW", t));
    useWorld({ channels: [channel("C0FINW", { class: "finance", finance_name: true })], messages: [message("C0FINW", t)], items: [item("C0FINW", t, { source_class: "finance" })] });
    const page = await listScreenedAttention(principal, {}, { now: NOW, surface: "SLACK" as unknown as "slack" });
    expect(page).toMatchObject({ items: [], hiddenSlack: 1 });
  });

  it("AS07 a store read failure: every Slack item withheld, slackScreen unavailable, one log line with ids and counts; email screening unaffected", async () => {
    const t = TS(1);
    seedAttention(1, fp("C0GEN", t));
    seedAttention(2, "slack:digest:C0GEN:2026-11-08");
    seedAttention(3, "email:thread:t_ok:m1");
    seedAttention(4, "dd:x:4");
    useWorld({ channels: [channel("C0GEN")], messages: [message("C0GEN", t)], items: [item("C0GEN", t)], fail: "exec_slack_items" });
    const page = await list();
    expect(shown(page)).toEqual([3, 4]);
    expect(page).toMatchObject({ hiddenSlack: 2, slackScreen: "unavailable", hiddenEmail: 0, emailScreen: "ok" });
    const lines = out.calls().map((c) => String(c[0])).filter((l) => l.startsWith("[exec-attention-read]"));
    expect(lines).toEqual(["[exec-attention-read] Slack screen rows unreadable for ep_1; 2 Slack item(s) withheld (SlackReadStoreError)"]);
    // The same with the store throwing something else, and an abort is rethrown, never mistaken for a failure.
    vi.mocked(slackScreenRows).mockRejectedValueOnce(new TypeError(`bad ${S.text}`));
    expect(await list()).toMatchObject({ hiddenSlack: 2, slackScreen: "unavailable" });
    const ac = new AbortController();
    vi.mocked(slackScreenRows).mockImplementationOnce(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(listScreenedAttention(principal, {}, { now: NOW, signal: ac.signal })).rejects.toThrow();
  });

  it("AS08 getScreenedAttentionItem: shown → ok; withheld → withheld; an unreadable batch → screen_unavailable; a P7b fingerprint passes", async () => {
    const [t1, t2] = [TS(1), TS(2)];
    seedAttention(1, fp("C0GEN", t1));
    seedAttention(2, fp("C0MUTE", t2));
    seedAttention(3, "slack:digest:C0GEN:2026-11-08");
    seedAttention(4, "slack:msg:not-a-channel:1");
    useWorld({
      channels: [channel("C0GEN"), channel("C0MUTE", { watch_state: "muted", mute_source: "owner" })],
      messages: [message("C0GEN", t1), message("C0MUTE", t2)],
      items: [item("C0GEN", t1), item("C0MUTE", t2)]
    });
    expect(await getScreenedAttentionItem(principal, id(1), { now: NOW })).toMatchObject({ ok: true, item: { id: id(1) } });
    expect(await getScreenedAttentionItem(principal, id(2), { now: NOW })).toEqual({ ok: false, reason: "withheld" });
    expect(await getScreenedAttentionItem(principal, id(3), { now: NOW })).toMatchObject({ ok: true });
    // A slack:msg: fingerprint that doesn't parse is withheld with no read.
    vi.mocked(slackScreenRows).mockClear();
    expect(await getScreenedAttentionItem(principal, id(4), { now: NOW })).toEqual({ ok: false, reason: "withheld" });
    expect(slackScreenRows).not.toHaveBeenCalled();
    useWorld({ channels: [channel("C0GEN")], messages: [message("C0GEN", t1)], items: [item("C0GEN", t1)], fail: "exec_slack_channels" });
    expect(await getScreenedAttentionItem(principal, id(1), { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
  });

  it("AS09 one slackScreenRows read per screened batch (keys deduped); the refill loop still fills the page to its limit", async () => {
    // 6 withheld Slack items (unwatched) rank first, then 4 shown ones and DD items.
    const chans = [channel("C0UNW", { watch_state: "unwatched" }), channel("C0GEN")];
    const messages: Row[] = [];
    const items: Row[] = [];
    for (let k = 1; k <= 6; k++) {
      seedAttention(k, fp("C0UNW", TS(k)), { priority_score: 100 - k });
      messages.push(message("C0UNW", TS(k)));
      items.push(item("C0UNW", TS(k)));
    }
    for (let k = 7; k <= 10; k++) {
      seedAttention(k, fp("C0GEN", TS(k)), { priority_score: 100 - k });
      messages.push(message("C0GEN", TS(k)));
      items.push(item("C0GEN", TS(k)));
    }
    for (let k = 11; k <= 12; k++) seedAttention(k, `dd:x:${k}`, { priority_score: 100 - k });
    useWorld({ channels: chans, messages, items });
    vi.mocked(slackScreenRows).mockClear();
    const page = await listScreenedAttention(principal, { limit: 4 }, { now: NOW });
    expect(shown(page)).toEqual([7, 8, 9, 10]);
    expect(page).toMatchObject({ hiddenSlack: 6, slackScreen: "ok" });
    expect(page.nextCursor).not.toBeNull();
    // Batch 1 (4 rows: all withheld), batch 2 (4 rows: 2 withheld, 2 shown), batch 3 (2 rows: shown): three reads.
    const calls = vi.mocked(slackScreenRows).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toEqual([1, 2, 3, 4].map((k) => ({ channelId: "C0UNW", ts: TS(k) })));
    expect(calls[2][1]).toEqual([9, 10].map((k) => ({ channelId: "C0GEN", ts: TS(k) })));
    // A batch with no Slack item reads nothing Slack-side.
    vi.mocked(slackScreenRows).mockClear();
    const next = await listScreenedAttention(principal, { limit: 4, cursor: page.nextCursor }, { now: NOW });
    expect(shown(next)).toEqual([11, 12]);
    expect(next).toMatchObject({ hiddenSlack: 0, slackScreen: "none" });
    expect(slackScreenRows).not.toHaveBeenCalled();
    // The same fingerprint twice in one batch is read once.
    expect(await screenAttentionItems(principal, [page.items[0], page.items[0]])).toMatchObject({ items: [page.items[0], page.items[0]] });
    expect(vi.mocked(slackScreenRows).mock.calls[0][1]).toEqual([{ channelId: "C0GEN", ts: TS(7) }]);
  });

  it("AS10 non-Slack items are untouched: no Slack read, hiddenSlack 0, slackScreen none; screenAttentionItems keeps P5a's answer shape", async () => {
    seedAttention(1, "dd:x:1");
    seedAttention(2, "email:thread:t_ok:m1");
    useWorld();
    vi.mocked(slackScreenRows).mockClear();
    const page = await list();
    expect(shown(page)).toEqual([1, 2]);
    expect(page).toEqual({ items: page.items, nextCursor: null, hiddenEmail: 0, emailScreen: "ok", hiddenSlack: 0, slackScreen: "none" });
    expect(slackScreenRows).not.toHaveBeenCalled();
    const s = await screenAttentionItems(principal, page.items);
    expect(Object.keys(s).sort()).toEqual(["emailScreen", "hiddenEmail", "items"]);
  });

  it("AS12 every page the accessor returns carries hiddenSlack and slackScreen (an empty one too)", async () => {
    useWorld();
    expect(await list()).toEqual({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none", hiddenSlack: 0, slackScreen: "none" });
    const t = TS(1);
    seedAttention(1, fp("C0GEN", t));
    useWorld({ channels: [channel("C0GEN")], messages: [message("C0GEN", t)], items: [item("C0GEN", t)] });
    const page = await list();
    expect(page.hiddenSlack).toBe(0);
    expect(page.slackScreen).toBe("ok");
    assertPageClean(page);
  });
});
