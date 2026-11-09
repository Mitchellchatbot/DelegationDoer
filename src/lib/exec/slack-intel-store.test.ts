import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
// slackIntelState reads P7a's view through the facade (C1); the rest of the facade is P7a's and isn't read here.
vi.mock("@/lib/exec/slack-reading", () => ({ getSlackReadingState: vi.fn(), latestAuthorOptoutAt: vi.fn() }));

import { channelLinkVerdict, createFakeSlackIntelDb, type FakeSlackIntelDb, type FakeSlackIntelDbSeed } from "@/lib/exec/__tests__/fake-slack-intel-db";
import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { sealSecret } from "@/lib/exec/crypto";
import type { SlackMessageLink } from "@/lib/exec/slack-intel-types";
import {
  SlackIntelStoreError,
  __resetSlackIntelStoreForTests,
  blankAllDigests,
  blankDigests,
  claimDigest,
  finishDigest,
  finishTurnV2Available,
  finishTurnV2Rpc,
  forgetSlackIntelChannels,
  getDigests,
  getDigestsByIds,
  getMessageLinks,
  isSlackIntelSchemaMissing,
  listChannelLinks,
  listChannelsLinkedToClient,
  listChannelsTaggedToProject,
  listItemKeysLinkedToClient,
  listOrphanSlackChannels,
  listProjectItemIds,
  listPublicSlackFactsForClient,
  listUnlinkedMessages,
  purgeExpiredSlackIntel,
  recheckSlackRpc,
  redactSlackRpc,
  searchSlackStored,
  setChannelRules,
  setChannelTags,
  slackIntelSchemaReady,
  slackIntelState,
  upsertMessageLinks
} from "@/lib/exec/slack-intel-store";
import { getSlackItemsByIds, listAuthorOptouts, listIntelChannels } from "@/lib/exec/slack-read-store";
import type { SlackReadingViewState } from "@/lib/exec/slack-read-types";
import { getSlackReadingState, latestAuthorOptoutAt } from "@/lib/exec/slack-reading";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b contract §5.12 ST01-ST15 (Area A): slack-intel-store.ts against fake-slack-intel-db.ts, and P7b's two additive reads in
// P7a's slack-read-store.ts (§3.17.6 P7a-2) against P7a's own fake-slack-read-db.ts. The fake's RPC bodies mirror the
// migration (the SQL suite, SQ01-SQ27, holds the real ones; the "fake twin" cases here keep the two equal on shared cases).
// Here the store's own half is pinned: the request shapes, identical key sets, chunking, the answer mapping, the
// missing-schema values, the caches, and that no Slack text, name or query reaches an error, a log line or a request it
// doesn't need to.

const NOW = new Date("2026-11-08T15:00:00.000Z");
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const ESD = (n: number) => `esd_${hex32(n)}`;
const ESL = (n: number) => `esl_${hex32(n)}`;
const ECM = (n: number) => `ecm_${hex32(n)}`;
const T = (s: number, f = 100) => `17941${String(s).padStart(5, "0")}.${String(f).padStart(6, "0")}`;
const principal = (id = "ep_1") => Object.freeze({ id, userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;
const P1 = principal("ep_1");
const P2 = principal("ep_2");

let db: FakeSlackIntelDb;
function useDb(seed: FakeSlackIntelDbSeed = {}): FakeSlackIntelDb {
  db = createFakeSlackIntelDb({ now: () => NOW, ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

function chan(over: Row = {}): Row {
  return {
    principal_id: "ep_1", installation_id: "esi_1", channel_id: "C0GEN", conv_type: "channel", class: "standard", watch_state: "watched", name: S.channelName,
    is_member: true, is_private: false, is_ext_shared: false, ext_ever: false, finance_name: false, left_at: null, ...over
  };
}
function msg(over: Row = {}): Row {
  return { principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), thread_ts: null, role: "candidate", is_dd_post: false, author_user_id: "U0JANE",
    author_external: false, dd_paths: [], created_at: "2026-11-08T10:00:00.000Z", ...over };
}
function itm(over: Row = {}): Row {
  return { id: ESL(1), principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), thread_ts: null, kind: "decision", assessed: true, summary: S.summary, excerpt: S.excerpt,
    source_class: "public", bypass_mute: false, author_user_id: "U0JANE", author_external: false, ...over };
}
function dg(over: Row = {}): Row {
  const status = (over.status as string | undefined) ?? "built";
  return {
    id: ESD(1), principal_id: "ep_1", channel_id: "C0GEN", local_date: "2026-11-07", tz: "America/New_York", from_ts: T(0), to_ts: T(90000), status,
    summary: status === "built" ? S.summary : null, source_ts: status === "built" ? [T(1)] : [], built_at: status === "built" ? "2026-11-08T05:30:00.000Z" : null,
    privacy: "public", rebuilds: 0, expires_at: "2026-12-01T05:00:00.000Z", requested_at: "2026-11-08T05:29:00.000Z", ...over
  };
}
function answer(over: Row = {}): Row {
  return { id: ECM(1), principal_id: "ep_1", conversation_id: "ecv_1", role: "assistant", status: "complete", text: S.slackText, recommendations: "r",
    sources: [], tool_calls: [{ round: 1, name: "search_slack", args: { query: S.query }, ok: true }], consulted_slack_refs: [], consulted_slack_channels: [],
    consulted_private_slack: false, redacted_at: null, created_at: "2026-11-08T12:00:00.000Z", ...over };
}
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
  __resetSlackIntelStoreForTests();
  vi.mocked(getSlackReadingState).mockReset();
  vi.mocked(latestAuthorOptoutAt).mockReset().mockResolvedValue(null);
  out = captureConsole();
  useDb();
});
afterEach(() => {
  out.assertClean();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("ST01: the schema probe, its cache, and the missing-schema rule", () => {
  it("isSlackIntelSchemaMissing knows the table, function and column codes, on the error or on a SlackIntelStoreError", () => {
    for (const code of ["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]) {
      expect(isSlackIntelSchemaMissing({ code })).toBe(true);
      expect(isSlackIntelSchemaMissing(new SlackIntelStoreError("claimDigest", code))).toBe(true);
    }
    for (const v of [{ code: "57014" }, new SlackIntelStoreError("x", null), null, "42P01", new Error("42P01"), undefined]) expect(isSlackIntelSchemaMissing(v)).toBe(false);
  });

  it("slackIntelSchemaReady: select id limit 0 on exec_slack_digests; true cached 60 s, false 10 s; another failure throws and isn't cached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(await slackIntelSchemaReady()).toBe(true);
    expect(db.calls.map((c) => [c.kind, c.target, c.columns, c.limit])).toEqual([["select", "exec_slack_digests", "id", 0]]);
    vi.setSystemTime(NOW.getTime() + 59_000);
    expect(await slackIntelSchemaReady()).toBe(true);
    expect(db.calls).toHaveLength(1);
    vi.setSystemTime(NOW.getTime() + 61_000);
    db.missing.add("exec_slack_digests");
    expect(await slackIntelSchemaReady()).toBe(false);
    expect(db.calls).toHaveLength(2);
    vi.setSystemTime(NOW.getTime() + 70_000);
    db.missing.delete("exec_slack_digests");
    expect(await slackIntelSchemaReady()).toBe(false);
    expect(db.calls).toHaveLength(2);
    vi.setSystemTime(NOW.getTime() + 72_000);
    expect(await slackIntelSchemaReady()).toBe(true);
    expect(db.calls).toHaveLength(3);
    __resetSlackIntelStoreForTests();
    useDb({ fail: () => ({ code: "57014", message: `canceling ${S.slackText}` }) });
    const err = await thrown(slackIntelSchemaReady());
    expect(err).toMatchObject({ name: "SlackIntelStoreError", op: "slackIntelSchemaReady", pgCode: "57014", message: "exec slack intel store: slackIntelSchemaReady failed (57014)" });
    useDb();
    expect(await slackIntelSchemaReady()).toBe(true);
  });

  it("an aborted signal wins over the database's answer", async () => {
    const ac = new AbortController();
    ac.abort(new Error("lease lost"));
    await expect(slackIntelSchemaReady({ signal: ac.signal })).rejects.toThrow("lease lost");
  });
});

// ---------------------------------------------------------------------------

describe("ST02: slackIntelState, C1 exactly (first match wins), never throws", () => {
  const VIEW: SlackReadingViewState[] = ["not_installed", "bot_not_connected", "not_consented", "discovering", "paused", "on", "revoked", "error"];
  /** C1, restated independently of the code. */
  function expected(view: SlackReadingViewState, schemaReady: boolean, p7b: boolean, enabled: boolean): string {
    if (!schemaReady || !p7b || view === "not_installed") return "not_installed";
    if (view === "bot_not_connected") return "not_connected";
    if (view === "not_consented" || view === "revoked" || view === "error") return "reading_revoked";
    if (!enabled || view === "paused") return "reading_off";
    if (view === "discovering") return "discovering";
    if (view === "on") return "ok";
    return "not_installed";
  }
  const settings = (schemaReady: boolean, enabled: boolean) => ({ slackReadingSchemaReady: schemaReady, slackReadingEnabled: enabled }) as ExecSettings;

  it("every SlackReadingViewState × slackReadingSchemaReady × the P7b schema × slackReadingEnabled", async () => {
    const seen = new Set<string>();
    for (const view of VIEW) {
      for (const schemaReady of [true, false]) {
        for (const p7b of [true, false]) {
          for (const enabled of [true, false]) {
            __resetSlackIntelStoreForTests();
            useDb({ missing: p7b ? [] : ["exec_slack_digests"] });
            vi.mocked(getSlackReadingState).mockResolvedValue({ state: view, discoveredAt: null, lastSweepAt: null, lastEventAt: null });
            const got = await slackIntelState(P1, settings(schemaReady, enabled));
            const want = expected(view, schemaReady, p7b, enabled);
            expect(got, `${view} schema=${schemaReady} p7b=${p7b} enabled=${enabled}`).toBe(want);
            seen.add(got);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(["discovering", "not_connected", "not_installed", "ok", "reading_off", "reading_revoked"]);
  });

  it("a read failure (P7a's view, the probe), an unknown view state or no settings → not_installed", async () => {
    vi.mocked(getSlackReadingState).mockRejectedValue(new Error("boom"));
    expect(await slackIntelState(P1, settings(true, true))).toBe("not_installed");
    vi.mocked(getSlackReadingState).mockResolvedValue({ state: "later" as SlackReadingViewState, discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect(await slackIntelState(P1, settings(true, true))).toBe("not_installed");
    __resetSlackIntelStoreForTests();
    useDb({ fail: () => ({ code: "57014", message: "timeout" }) });
    vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect(await slackIntelState(P1, settings(true, true))).toBe("not_installed");
    expect(await slackIntelState(P1, null as unknown as ExecSettings)).toBe("not_installed");
    expect(await slackIntelState(null as unknown as ExecPrincipal, settings(true, true))).toBe("not_installed");
  });

  it("the schema switch off never reads P7a's view", async () => {
    await slackIntelState(P1, settings(false, true));
    expect(getSlackReadingState).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ST03 / ST04: the tag and rule writers", () => {
  beforeEach(() => {
    useDb({ tables: { exec_slack_channels: [chan(), chan({ channel_id: "C0DENY", class: "deny", name: null, watch_state: "unwatched" })] } });
  });

  it("ST03: setChannelTags maps RPC 1's answers; its arguments are exactly RPC 1's parameters; projects deduped", async () => {
    expect(await setChannelTags(P1, { channelId: "C0GEN", client: { id: "c_1", name: S.clientName }, projectIds: ["p_1", "p_1", "p_2"] })).toBe("ok");
    expect(rpcCalls("exec_slack_set_channel_links")[0].payload).toEqual({ p_principal: "ep_1", p_channel_id: "C0GEN", p_client_id: "c_1", p_client_name: S.clientName,
      p_project_ids: ["p_1", "p_2"] });
    expect(db.tables.exec_slack_channel_links[0]).toMatchObject({ tag_client_id: "c_1", match_confidence: "high", client_match_via: "tag" });
    expect(await setChannelTags(P1, { channelId: "C0DENY", client: null, projectIds: [] })).toBe("not_taggable");
    expect(await setChannelTags(P1, { channelId: "C0NOPE", client: null, projectIds: [] })).toBe("not_found");
    expect(await setChannelTags(P2, { channelId: "C0GEN", client: null, projectIds: [] })).toBe("not_found");
    const n = db.calls.length;
    expect(await setChannelTags(P1, { channelId: "junk", client: null, projectIds: [] })).toBe("not_found");
    await expect(setChannelTags(P1, { channelId: "C0GEN", client: null, projectIds: Array.from({ length: 11 }, (_, i) => `p_${i}`) })).rejects.toThrow(TypeError);
    await expect(setChannelTags(P1, { channelId: "C0GEN", client: { id: "", name: "x" }, projectIds: [] })).rejects.toThrow(TypeError);
    expect(db.calls.length).toBe(n);
  });

  it("ST03: a missing RPC → not_installed; a failure → the op and code only; a malformed answer → an error", async () => {
    db.missing.add("exec_slack_set_channel_links");
    expect(await thrown(setChannelTags(P1, { channelId: "C0GEN", client: null, projectIds: [] }))).toMatchObject({ op: "not_installed", pgCode: "PGRST202" });
    db.missing.clear();
    useDb({ fail: () => ({ code: "23514", message: `violates ${S.clientName}` }) });
    const e = (await thrown(setChannelTags(P1, { channelId: "C0GEN", client: { id: "c_1", name: S.clientName }, projectIds: [] }))) as Error;
    expect(e.message).toBe("exec slack intel store: setChannelTags failed (23514)");
    assertNoSlackLeak({ errors: [e.message, e] });
  });

  it("ST04: setChannelRules: identical keys, 2 000 per call, the last row of a channel wins, the written counts summed; missing → 0", async () => {
    const channels = Array.from({ length: 4500 }, (_, i) => chan({ channel_id: `C0X${i}` }));
    useDb({ tables: { exec_slack_channels: channels } });
    const rows = channels.map((c, i) => ({ channelId: String(c.channel_id), clientId: i % 2 ? "c_1" : null, clientName: i % 2 ? "Acme" : null, candidates: i % 2 ? 1 : 0 }));
    rows.push({ channelId: "C0X0", clientId: null, clientName: null, candidates: 2 });
    expect(await setChannelRules(P1, rows)).toBe(4500);
    const calls = rpcCalls("exec_slack_set_channel_rules");
    expect(calls.map((c) => ((c.payload as Row).p_rows as Row[]).length)).toEqual([2000, 2000, 500]);
    for (const c of calls) {
      expect(Object.keys(c.payload as Row).sort()).toEqual(["p_principal", "p_rows"]);
      for (const r of (c.payload as Row).p_rows as Row[]) expect(Object.keys(r).sort()).toEqual(["candidates", "channel_id", "client_id", "client_name"]);
    }
    expect(db.tables.exec_slack_channel_links.find((l) => l.channel_id === "C0X0")).toMatchObject({ rule_candidates: 2, match_confidence: "low", client_id: null });
    expect(await setChannelRules(P1, [])).toBe(0);
    expect(rpcCalls("exec_slack_set_channel_rules")).toHaveLength(3);
    await expect(setChannelRules(P1, [{ channelId: "bad", clientId: null, clientName: null, candidates: 0 }])).rejects.toThrow(TypeError);
    await expect(setChannelRules(P1, [{ channelId: "C0X1", clientId: "c_1", clientName: null, candidates: 1 }])).rejects.toThrow(TypeError);
    await expect(setChannelRules(P1, [{ channelId: "C0X1", clientId: null, clientName: null, candidates: 1.5 }])).rejects.toThrow(TypeError);
    db.missing.add("exec_slack_set_channel_rules");
    expect(await setChannelRules(P1, [{ channelId: "C0X1", clientId: null, clientName: null, candidates: 0 }])).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("ST05 / ST06: message links", () => {
  const link = (over: Partial<SlackMessageLink> = {}): SlackMessageLink => ({
    channelId: "C0GEN", ts: T(1), clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0, taskIds: [], projectIds: [],
    emailThreadIds: [], checkedAt: NOW.toISOString(), ...over
  });

  it("ST05: upsertMessageLinks: every row carries the identical key set, on the PK, 500 per request; arrays deduped and capped", async () => {
    const msgs = Array.from({ length: 1200 }, (_, i) => msg({ ts: T(i) }));
    useDb({ tables: { exec_slack_messages: msgs } });
    const links = msgs.map((m, i) => link({
      ts: String(m.ts),
      ...(i % 3 === 0 ? { clientId: "c_1", clientName: "Acme", clientMatchVia: "dd_link" as const, matchConfidence: "high" as const, clientCandidates: 1 } : {}),
      ...(i % 5 === 0 ? { taskIds: ["t_1", "t_1", ...Array.from({ length: 30 }, (_, k) => `t_${k}`)], emailThreadIds: ["a", "b", "c", "d", "e", "f"] } : {})
    }));
    expect(await upsertMessageLinks(P1, links)).toBe(1200);
    const ups = db.calls.filter((c) => c.kind === "upsert");
    expect(ups.map((c) => (c.payload as Row[]).length)).toEqual([500, 500, 200]);
    const keys = new Set(ups.flatMap((c) => (c.payload as Row[]).map((r) => Object.keys(r).sort().join(","))));
    expect([...keys]).toEqual(["channel_id,checked_at,client_candidates,client_id,client_match_via,client_name,email_thread_ids,match_confidence,principal_id,project_ids,task_ids,ts"]);
    expect(ups.every((c) => c.target === "exec_slack_message_links" && c.options?.onConflict === "principal_id,channel_id,ts")).toBe(true);
    const capped = db.tables.exec_slack_message_links.find((r) => r.ts === T(0)) as Row;
    expect((capped.task_ids as string[]).length).toBe(20);
    expect(capped.email_thread_ids).toEqual(["a", "b", "c", "d", "e"]);
    // An upsert of the same key replaces the row.
    expect(await upsertMessageLinks(P1, [link({ ts: T(0) })])).toBe(1);
    expect(db.tables.exec_slack_message_links.find((r) => r.ts === T(0))).toMatchObject({ client_id: null, task_ids: [] });
    await expect(upsertMessageLinks(P1, [link({ ts: "bad" })])).rejects.toThrow(TypeError);
    await expect(upsertMessageLinks(P1, [link({ clientMatchVia: "guess" as never })])).rejects.toThrow(TypeError);
    expect(await upsertMessageLinks(P1, [])).toBe(0);
    db.missing.add("exec_slack_message_links");
    expect(await upsertMessageLinks(P1, [link()])).toBe(0);
  });

  it("ST05: a vanished message row (23503) fails the batch with the op and code only", async () => {
    useDb({ tables: { exec_slack_messages: [] } });
    expect(await thrown(upsertMessageLinks(P1, [link()]))).toMatchObject({ op: "upsertMessageLinks", pgCode: "23503" });
  });

  it("ST06: getMessageLinks returns each key's own link and its thread root's; every valid key has an entry; missing → nulls", async () => {
    const own = { principal_id: "ep_1", channel_id: "C0GEN", ts: T(2), client_id: "c_1", client_name: "Acme", client_match_via: "domain", match_confidence: "medium",
      client_candidates: 1, task_ids: [], project_ids: [], email_thread_ids: [], checked_at: NOW.toISOString() };
    const root = { ...own, ts: T(1), client_match_via: "dd_post", match_confidence: "high", task_ids: ["t_1"] };
    useDb({ tables: { exec_slack_message_links: [own, root, { ...root, principal_id: "ep_2", ts: T(3) }] } });
    const r = await getMessageLinks(P1, [{ channelId: "C0GEN", ts: T(2), threadTs: T(1) }, { channelId: "C0GEN", ts: T(5), threadTs: T(1) },
      { channelId: "C0GEN", ts: T(3), threadTs: null }, { channelId: "C0GEN", ts: T(1), threadTs: T(1) }, { channelId: "bad", ts: T(1), threadTs: null }]);
    expect([...r.keys()].sort()).toEqual([`C0GEN:${T(1)}`, `C0GEN:${T(2)}`, `C0GEN:${T(3)}`, `C0GEN:${T(5)}`]);
    expect(r.get(`C0GEN:${T(2)}`)?.own).toMatchObject({ clientId: "c_1", clientMatchVia: "domain", matchConfidence: "medium" });
    expect(r.get(`C0GEN:${T(2)}`)?.root).toMatchObject({ ts: T(1), clientMatchVia: "dd_post", matchConfidence: "high", taskIds: ["t_1"] });
    expect(r.get(`C0GEN:${T(5)}`)).toMatchObject({ own: null, root: { ts: T(1) } });
    expect(r.get(`C0GEN:${T(3)}`)).toEqual({ own: null, root: null });
    expect(r.get(`C0GEN:${T(1)}`)?.root).toBeNull();
    db.missing.add("exec_slack_message_links");
    expect(await getMessageLinks(P1, [{ channelId: "C0GEN", ts: T(2), threadTs: null }])).toEqual(new Map([[`C0GEN:${T(2)}`, { own: null, root: null }]]));
  });
});

// ---------------------------------------------------------------------------

describe("ST07: stored search and the other RPC reads", () => {
  beforeEach(() => {
    useDb({
      tables: {
        exec_slack_channels: [chan(), chan({ channel_id: "C0MUT", watch_state: "muted", mute_source: "owner" })],
        exec_slack_messages: [msg(), msg({ ts: T(2) }), msg({ channel_id: "C0MUT", ts: T(3) })],
        exec_slack_items: [itm({ summary: "alpha launch" }), itm({ id: ESL(2), ts: T(2), kind: "request", summary: "beta", excerpt: "zebra report" }),
          itm({ id: ESL(3), channel_id: "C0MUT", ts: T(3), summary: "alpha mention", bypass_mute: true })],
        exec_slack_digests: [dg({ summary: "alpha gamma plan" })]
      }
    });
  });
  const q = (over = {}) => ({ query: "alpha", channelIds: ["C0GEN"], bypassChannelIds: ["C0MUT"], kinds: null, sinceIso: "2026-11-01T00:00:00Z",
    includeDigests: true, limit: 10, ...over });

  it("both channel sets empty (or no kinds) → [] without a call; the rows mapped; the query clipped to 200; bypass ids minus full ids", async () => {
    expect(await searchSlackStored(P1, q({ channelIds: [], bypassChannelIds: [] }))).toEqual([]);
    expect(await searchSlackStored(P1, q({ channelIds: ["bad"], bypassChannelIds: [] }))).toEqual([]);
    expect(await searchSlackStored(P1, q({ kinds: [] }))).toEqual([]);
    expect(db.calls).toEqual([]);
    const r = await searchSlackStored(P1, q());
    expect(r.map((h) => [h.src, h.id, h.channelId]).sort()).toEqual([["digest", ESD(1), "C0GEN"], ["item", ESL(1), "C0GEN"], ["item", ESL(3), "C0MUT"]]);
    expect(r.every((h) => typeof h.rank === "number" && /Z$/.test(h.at))).toBe(true);
    expect((await searchSlackStored(P1, q({ query: "zebra" }))).map((h) => h.id)).toEqual([ESL(2)]);
    await searchSlackStored(P1, q({ query: "x".repeat(500), bypassChannelIds: ["C0GEN", "C0MUT", "C0MUT"], kinds: ["decision", "bogus" as never] }));
    const last = rpcCalls("exec_slack_search").at(-1)?.payload as Row;
    expect(last).toEqual({ p_principal: "ep_1", p_query: "x".repeat(200), p_channel_ids: ["C0GEN"], p_bypass_channel_ids: ["C0MUT"], p_kinds: ["decision"],
      p_since: "2026-11-01T00:00:00.000Z", p_include_digests: true, p_limit: 10 });
    db.missing.add("exec_slack_search");
    expect(await searchSlackStored(P1, q())).toEqual([]);
  });

  it("listUnlinkedMessages / listProjectItemIds / listPublicSlackFactsForClient / listOrphanSlackChannels map their RPCs; missing → []", async () => {
    const un = await listUnlinkedMessages(P1, 5000);
    expect(rpcCalls("exec_slack_unlinked_messages")[0].payload).toEqual({ p_principal: "ep_1", p_limit: 2000 });
    expect(un.map((m) => [m.channelId, m.ts, m.role, m.isDdPost, m.summaries])).toEqual([
      ["C0GEN", T(1), "candidate", false, ["alpha launch"]], ["C0GEN", T(2), "candidate", false, ["beta"]], ["C0MUT", T(3), "candidate", false, ["alpha mention"]]
    ]);
    expect(JSON.stringify(un)).not.toContain(S.excerpt);
    await listUnlinkedMessages(P1, 0);
    expect(rpcCalls("exec_slack_unlinked_messages")[1].payload).toEqual({ p_principal: "ep_1", p_limit: 1 });
    db.tables.exec_slack_message_links.push({ principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), client_id: null, client_name: null, client_match_via: null,
      match_confidence: null, client_candidates: 0, task_ids: [], project_ids: ["p_1"], email_thread_ids: [], checked_at: NOW.toISOString() });
    expect(await listProjectItemIds(P1, { projectId: "p_1", taskIds: [], sinceIso: "2026-11-01T00:00:00Z", limit: 999 })).toEqual([
      { itemId: ESL(1), via: "link", at: new Date(1794100001000).toISOString() }
    ]);
    expect(rpcCalls("exec_slack_project_items")[0].payload).toMatchObject({ p_limit: 150, p_task_ids: [] });
    expect(await listProjectItemIds(P1, { projectId: "", taskIds: [], sinceIso: "2026-11-01T00:00:00Z", limit: 5 })).toEqual([]);
    db.tables.exec_slack_channel_links.push({ principal_id: "ep_1", channel_id: "C0GEN", tag_client_id: "c_1", tag_client_name: "Acme", tag_project_ids: [],
      tagged_at: NOW.toISOString(), rule_client_id: null, rule_client_name: null, rule_candidates: 0, ...channelLinkVerdict({ tag_client_id: "c_1", tag_client_name: "Acme",
        rule_client_id: null, rule_client_name: null, rule_candidates: 0 }) });
    const facts = await listPublicSlackFactsForClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 50 });
    expect(facts.map((f) => [f.src, f.id, f.kind, f.body, f.ts, f.localDate])).toEqual([["item", ESL(1), "decision", "alpha launch", T(1), null]]);
    expect(rpcCalls("exec_slack_public_facts")[0].payload).toEqual({ p_principal: "ep_1", p_client_id: "c_1", p_since: "2026-11-01T00:00:00.000Z", p_limit: 20 });
    db.tables.exec_messages.push(answer({ consulted_slack_channels: ["C0GONE", "C0GEN"] }));
    expect(await listOrphanSlackChannels(P1, 999)).toEqual(["C0GONE"]);
    expect(rpcCalls("exec_chat_slack_orphan_channels")[0].payload).toEqual({ p_principal: "ep_1", p_limit: 200 });
    for (const t of ["exec_slack_unlinked_messages", "exec_slack_project_items", "exec_slack_public_facts", "exec_chat_slack_orphan_channels"]) db.missing.add(t);
    expect(await listUnlinkedMessages(P1, 10)).toEqual([]);
    expect(await listProjectItemIds(P1, { projectId: "p_1", taskIds: [], sinceIso: "2026-11-01T00:00:00Z", limit: 5 })).toEqual([]);
    expect(await listPublicSlackFactsForClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 5 })).toEqual([]);
    expect(await listOrphanSlackChannels(P1, 10)).toEqual([]);
  });

  it("listItemKeysLinkedToClient: high and medium links of the client at or after since, newest ts first (compareTs), limited", async () => {
    const l = (ts: string, conf: string, over: Row = {}) => ({ principal_id: "ep_1", channel_id: "C0GEN", ts, client_id: "c_1", client_name: "Acme",
      client_match_via: conf === "high" ? "dd_link" : "domain", match_confidence: conf, client_candidates: 1, task_ids: [], project_ids: [], email_thread_ids: [],
      checked_at: NOW.toISOString(), ...over });
    useDb({ tables: { exec_slack_message_links: [l(T(1), "high"), l(T(9), "medium"), l("999999999.000100", "high"), l(T(5), "low", { client_candidates: 2 }),
      l(T(7), "high", { client_id: "c_2", client_name: "Beta" }), l(T(3), "high", { channel_id: "C0OTHER" })] } });
    const r = await listItemKeysLinkedToClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 10 });
    expect(r).toEqual([{ channelId: "C0GEN", ts: T(9), confidence: "medium" }, { channelId: "C0OTHER", ts: T(3), confidence: "high" },
      { channelId: "C0GEN", ts: T(1), confidence: "high" }]);
    expect(await listItemKeysLinkedToClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 1 })).toHaveLength(1);
    expect(await listItemKeysLinkedToClient(P1, "", { sinceIso: "2026-11-01T00:00:00Z", limit: 1 })).toEqual([]);
  });

  it("listChannelLinks / listChannelsLinkedToClient / listChannelsTaggedToProject read the generated verdict; missing → empty", async () => {
    await setChannelTags(P1, { channelId: "C0GEN", client: { id: "c_1", name: "Acme" }, projectIds: ["p_1"] });
    await setChannelRules(P1, [{ channelId: "C0MUT", clientId: "c_1", clientName: "Acme", candidates: 1 }]);
    const all = await listChannelLinks(P1);
    expect([...all.keys()]).toEqual(["C0GEN", "C0MUT"]);
    expect(all.get("C0GEN")).toMatchObject({ tagClientId: "c_1", tagProjectIds: ["p_1"], clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 });
    expect(all.get("C0MUT")).toMatchObject({ tagClientId: null, clientId: "c_1", clientMatchVia: "name", matchConfidence: "low" });
    expect([...(await listChannelLinks(P1, { channelIds: ["C0MUT", "bad"] })).keys()]).toEqual(["C0MUT"]);
    expect((await listChannelsLinkedToClient(P1, "c_1", ["high"])).map((l) => l.channelId)).toEqual(["C0GEN"]);
    expect((await listChannelsLinkedToClient(P1, "c_1", ["high", "low"])).map((l) => l.channelId)).toEqual(["C0GEN", "C0MUT"]);
    expect(await listChannelsLinkedToClient(P1, "c_1", [])).toEqual([]);
    expect((await listChannelsTaggedToProject(P1, "p_1")).map((l) => l.channelId)).toEqual(["C0GEN"]);
    expect(await listChannelsTaggedToProject(P1, "p_9")).toEqual([]);
    db.missing.add("exec_slack_channel_links");
    expect((await listChannelLinks(P1)).size).toBe(0);
    expect(await listChannelsLinkedToClient(P1, "c_1", ["high"])).toEqual([]);
    expect(await listChannelsTaggedToProject(P1, "p_1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ST08: the digest lifecycle maps every outcome", () => {
  const claim = (over = {}) => claimDigest(P1, { channelId: "C0GEN", localDate: "2026-11-07", tz: "America/New_York", fromTs: T(0), toTs: T(90000),
    expiresAt: "2026-12-01T05:00:00Z", mode: "plan", ...over });
  const finish = (id: string, over = {}) => finishDigest(P1, { id, status: "built", summary: S.summary, highlights: [{ msg: T(1), text: S.summary }], decisions: [],
    openQuestions: [], sourceTs: [T(1), T(1), "bad"], counts: { human: 2, bot: 1, ddPost: 0, external: 0, threads: 0 }, privacy: "public", partial: false,
    fullDay: true, injectionSuspected: false, model: "claude-haiku-5-5", costUsd: 0.0012, ...over });
  beforeEach(() => {
    useDb({ tables: { exec_slack_channels: [chan(), chan({ channel_id: "C0B" })] } });
  });

  it("claim → claimed / busy / fresh / not_found; finish → ok (full_day honoured) / lost; the payloads are exactly the RPCs' parameters", async () => {
    const c = await claim();
    expect(c).toMatchObject({ outcome: "claimed", rebuilds: 0 });
    expect(Object.keys(rpcCalls("exec_slack_digest_claim")[0].payload as Row).sort()).toEqual(
      ["p_channel_id", "p_expires_at", "p_from_ts", "p_local_date", "p_mode", "p_principal", "p_to_ts", "p_tz"]);
    expect(await claim()).toEqual({ outcome: "busy" });
    if (c.outcome !== "claimed") throw new Error("unreachable");
    expect(await finish(c.id)).toBe("ok");
    const payload = rpcCalls("exec_slack_digest_finish")[0].payload as Row;
    expect(Object.keys(payload).sort()).toEqual(["p_cost", "p_counts", "p_decisions", "p_full_day", "p_highlights", "p_id", "p_injection", "p_model", "p_partial",
      "p_principal", "p_privacy", "p_questions", "p_source_ts", "p_status", "p_summary"]);
    expect(payload).toMatchObject({ p_source_ts: [T(1)], p_counts: { human: 2, bot: 1, ddPost: 0, external: 0, threads: 0 }, p_full_day: true, p_cost: 0.0012 });
    expect(db.tables.exec_slack_digests[0]).toMatchObject({ status: "built", full_day: true, human_count: 2 });
    expect(await claim()).toEqual({ outcome: "fresh" });
    expect(await finish(c.id)).toBe("lost");
    expect(await finish("esd_nope")).toBe("lost");
    expect(await claim({ channelId: "C0NOPE" })).toEqual({ outcome: "not_found" });
    expect(await claim({ channelId: "bad" })).toEqual({ outcome: "not_found" });
    const t = await claim({ localDate: "2026-11-08", mode: "today" });
    if (t.outcome !== "claimed") throw new Error("unreachable");
    expect(await finish(t.id, { status: "failed", fullDay: true })).toBe("ok");
    expect(db.tables.exec_slack_digests.find((d) => d.id === t.id)).toMatchObject({ status: "failed", full_day: false, summary: null });
  });

  it("finish → channel_gone (the row deleted) and deleted_source (stale, rebuilds + 1); input guards", async () => {
    const a = await claim();
    if (a.outcome !== "claimed") throw new Error("unreachable");
    db.tables.exec_slack_channels[0].left_at = NOW.toISOString();
    expect(await finish(a.id)).toBe("channel_gone");
    expect(db.tables.exec_slack_digests.find((d) => d.id === a.id)).toBeUndefined();
    const b = await claim({ channelId: "C0B" });
    if (b.outcome !== "claimed") throw new Error("unreachable");
    db.tables.exec_slack_deleted.push({ principal_id: "ep_1", channel_id: "C0B", ts: T(1), reason: "event" });
    expect(await finish(b.id)).toBe("deleted_source");
    expect(db.tables.exec_slack_digests.find((d) => d.id === b.id)).toMatchObject({ status: "stale", rebuilds: 1, summary: null, source_ts: [] });
    await expect(finish(ESD(9), { status: "stale" as never })).rejects.toThrow(TypeError);
    await expect(finish(ESD(9), { privacy: "dm" })).rejects.toThrow(TypeError);
    await expect(finish(ESD(9), { highlights: Array.from({ length: 7 }, () => ({ msg: T(1), text: "x" })) })).rejects.toThrow(TypeError);
    await expect(claim({ localDate: "11/07/2026" })).rejects.toThrow(TypeError);
    await expect(claim({ mode: "later" as never })).rejects.toThrow(TypeError);
  });

  it("blankDigests (old rebuilds, chunked 500 ts × 30 dates, each digest once), blankAllDigests, forgetSlackIntelChannels (500 per call, the scan once)", async () => {
    useDb({ tables: { exec_slack_channels: [chan(), chan({ channel_id: "C0B" })],
      exec_slack_digests: [dg({ rebuilds: 4, source_ts: [T(1), T(2)] }), dg({ id: ESD(2), local_date: "2026-11-06", source_ts: [T(600)] }),
        dg({ id: ESD(3), channel_id: "C0B" }), dg({ id: ESD(4), local_date: "2026-11-05", status: "building" })] } });
    const many = [T(1), ...Array.from({ length: 700 }, (_, i) => T(100 + i))];
    const r = await blankDigests(P1, "C0GEN", many, ["2026-11-07", "2026-11-06", "2026-11-05"]);
    expect(rpcCalls("exec_slack_digest_blank").map((c) => [((c.payload as Row).p_ts as string[]).length, ((c.payload as Row).p_dates as string[]).length]))
      .toEqual([[500, 3], [201, 3]]);
    expect(r.sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([
      { id: ESD(1), channelId: "C0GEN", localDate: "2026-11-07", oldRebuilds: 4 }, { id: ESD(2), channelId: "C0GEN", localDate: "2026-11-06", oldRebuilds: 0 },
      { id: ESD(4), channelId: "C0GEN", localDate: "2026-11-05", oldRebuilds: 0 }]);
    expect(await blankDigests(P1, "C0GEN", [], ["2026-11-07"])).toEqual([]);
    expect(rpcCalls("exec_slack_digest_blank")).toHaveLength(2);
    await expect(blankDigests(P1, "bad", [T(1)], ["2026-11-07"])).rejects.toThrow(TypeError);
    expect(await blankAllDigests(P1)).toEqual([{ id: ESD(3), channelId: "C0B", localDate: "2026-11-07", oldRebuilds: 0 }]);
    expect(rpcCalls("exec_slack_digest_blank").at(-1)?.payload).toEqual({ p_principal: "ep_1", p_channel_id: null, p_ts: null, p_dates: null, p_all: true });
    const ids = Array.from({ length: 1100 }, (_, i) => `C0F${i}`);
    const f = await forgetSlackIntelChannels(P1, [...ids, "C0B", "bad"], { scan: true });
    const calls = rpcCalls("exec_slack_intel_forget_channels").map((c) => c.payload as Row);
    expect(calls.map((c) => [(c.p_channel_ids as string[]).length, c.p_scan])).toEqual([[500, true], [500, false], [101, false]]);
    expect(f.find((x) => x.channelId === "C0B")).toEqual({ channelId: "C0B", digests: 1, links: 0 });
    expect(await forgetSlackIntelChannels(P1, [], { scan: false })).toEqual([]);
    expect(rpcCalls("exec_slack_intel_forget_channels")).toHaveLength(3);
    await forgetSlackIntelChannels(P1, [], { scan: true });
    expect(rpcCalls("exec_slack_intel_forget_channels").at(-1)?.payload).toEqual({ p_principal: "ep_1", p_channel_ids: [], p_scan: true });
  });

  it("a missing schema: claim and finish throw not_installed; blank, forget and the reads answer empty", async () => {
    for (const fn of ["exec_slack_digest_claim", "exec_slack_digest_finish", "exec_slack_digest_blank", "exec_slack_intel_forget_channels"]) db.missing.add(fn);
    db.missing.add("exec_slack_digests");
    expect(await thrown(claim())).toMatchObject({ op: "not_installed" });
    expect(await thrown(finish(ESD(1)))).toMatchObject({ op: "not_installed" });
    expect(await blankDigests(P1, "C0GEN", [T(1)], ["2026-11-07"])).toEqual([]);
    expect(await blankAllDigests(P1)).toEqual([]);
    expect(await forgetSlackIntelChannels(P1, ["C0GEN"], { scan: true })).toEqual([]);
    expect(await getDigests(P1, { dates: ["2026-11-07"] })).toEqual([]);
    expect(await getDigestsByIds(P1, [ESD(1)])).toEqual([]);
  });

  it("getDigests / getDigestsByIds map every column (only a built row holds text); filters by date, channel and status", async () => {
    useDb({ tables: { exec_slack_channels: [chan(), chan({ channel_id: "C0B" })],
      exec_slack_digests: [dg({ highlights: [{ msg: T(1), text: "h" }, { bad: true }], cost_usd: "0.0012", human_count: 3, partial: true }),
        dg({ id: ESD(2), channel_id: "C0B", status: "stale", rebuilds: 2 }), dg({ id: ESD(3), local_date: "2026-11-06", status: "empty" })] } });
    const r = await getDigests(P1, { dates: ["2026-11-07", "2026-11-06", "bad"] });
    expect(r.map((d) => [d.id, d.localDate, d.status])).toEqual([[ESD(2), "2026-11-07", "stale"], [ESD(1), "2026-11-07", "built"], [ESD(3), "2026-11-06", "empty"]]);
    expect(r[1]).toMatchObject({ summary: S.summary, highlights: [{ msg: T(1), text: "h" }], costUsd: 0.0012, counts: { human: 3 }, partial: true, privacy: "public",
      builtAt: "2026-11-08T05:30:00.000Z", fullDay: false });
    expect(r[0]).toMatchObject({ summary: null, rebuilds: 2, builtAt: null });
    expect((await getDigests(P1, { dates: ["2026-11-07"], channelIds: ["C0B"] })).map((d) => d.id)).toEqual([ESD(2)]);
    expect((await getDigests(P1, { dates: ["2026-11-07", "2026-11-06"], statuses: ["built", "empty"] })).map((d) => d.id)).toEqual([ESD(1), ESD(3)]);
    expect(await getDigests(P1, { dates: [] })).toEqual([]);
    expect(await getDigests(P1, { dates: ["2026-11-07"], statuses: [] })).toEqual([]);
    expect((await getDigestsByIds(P1, [ESD(3), ESD(1), "bad"])).map((d) => d.id).sort()).toEqual([ESD(1), ESD(3)]);
    expect(await getDigestsByIds(P2, [ESD(1)])).toEqual([]);
  });

  it("fixer security-3: a built digest requested at or before the newest opt-out reads as stale with no text until the sweep blanks it; raw keeps it", async () => {
    useDb({ tables: { exec_slack_channels: [chan()],
      exec_slack_digests: [dg({ requested_at: "2026-11-08T05:29:00.000Z" }), dg({ id: ESD(2), local_date: "2026-11-06", requested_at: "2026-11-08T09:00:00.000Z" }),
        dg({ id: ESD(3), local_date: "2026-11-05", status: "empty", requested_at: "2026-11-08T05:00:00.000Z" })] } });
    vi.mocked(latestAuthorOptoutAt).mockResolvedValue("2026-11-08T06:00:00.000Z");
    const r = await getDigests(P1, { dates: ["2026-11-07", "2026-11-06", "2026-11-05"] });
    expect(r.map((d) => [d.id, d.status])).toEqual([[ESD(1), "stale"], [ESD(2), "built"], [ESD(3), "empty"]]);
    expect(r[0]).toMatchObject({ summary: null, highlights: [], decisions: [], openQuestions: [], sourceTs: [], rebuilds: 0 });
    expect(r[1].summary).toBe(S.summary);
    expect((await getDigestsByIds(P1, [ESD(1), ESD(2)])).map((d) => [d.id, d.status]).sort()).toEqual([[ESD(1), "stale"], [ESD(2), "built"]]);
    expect((await getDigests(P1, { dates: ["2026-11-07"] }, { raw: true }))[0]).toMatchObject({ status: "built", summary: S.summary });
    // Exactly at the opt-out's time counts as before it.
    vi.mocked(latestAuthorOptoutAt).mockResolvedValue("2026-11-08T09:00:00.000Z");
    expect((await getDigests(P1, { dates: ["2026-11-06"] }))[0].status).toBe("stale");
    // No opt-out: as stored. A failed opt-out read fails the digest read (fail closed).
    vi.mocked(latestAuthorOptoutAt).mockResolvedValue(null);
    expect((await getDigests(P1, { dates: ["2026-11-07"] }))[0].status).toBe("built");
    vi.mocked(latestAuthorOptoutAt).mockRejectedValue(new Error("down"));
    await expect(getDigests(P1, { dates: ["2026-11-07"] })).rejects.toThrow("down");
    await expect(getDigestsByIds(P1, [ESD(1)])).rejects.toThrow("down");
  });

  it("purgeExpiredSlackIntel: expired digests deleted in chunks of 1 000 by id; building rows over 30 minutes failed; missing → zeros", async () => {
    const expired = Array.from({ length: 1500 }, (_, i) => dg({ id: ESD(10 + i), local_date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}`,
      channel_id: `C0E${i}`, expires_at: "2026-11-01T00:00:00.000Z" }));
    useDb({ tables: { exec_slack_channels: expired.map((d) => chan({ channel_id: d.channel_id })).concat([chan()]),
      exec_slack_digests: [...expired, dg({ status: "building", requested_at: "2026-11-08T14:00:00.000Z" }),
        dg({ id: ESD(2), local_date: "2026-11-06", status: "building", requested_at: "2026-11-08T14:45:00.000Z" })] } });
    expect(await purgeExpiredSlackIntel(NOW)).toEqual({ digests: 1500, failedBuilds: 1 });
    const selects = db.calls.filter((c) => c.kind === "select" && c.target === "exec_slack_digests");
    expect(selects.map((c) => c.limit)).toEqual([1000, 1000]);
    expect(db.tables.exec_slack_digests.map((d) => [d.id, d.status])).toEqual([[ESD(1), "failed"], [ESD(2), "building"]]);
    await expect(purgeExpiredSlackIntel(new Date(Number.NaN))).rejects.toThrow(TypeError);
    useDb({ missing: ["exec_slack_digests"] });
    expect(await purgeExpiredSlackIntel(NOW)).toEqual({ digests: 0, failedBuilds: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("ST09 / ST12: the chat RPCs", () => {
  it("ST09: finishTurnV2Available probes once with a no-op call; true for the process; a missing RPC re-probed after 10 minutes; another failure throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(await finishTurnV2Available()).toBe(true);
    expect(await finishTurnV2Available()).toBe(true);
    vi.setSystemTime(NOW.getTime() + 3_600_000);
    expect(await finishTurnV2Available()).toBe(true);
    expect(rpcCalls("exec_chat_finish_turn_v2")).toHaveLength(1);
    expect(Object.keys(rpcCalls("exec_chat_finish_turn_v2")[0].payload as Row)).toHaveLength(19);
    expect(db.tables.exec_messages).toEqual([]);
    __resetSlackIntelStoreForTests();
    useDb({ missing: ["exec_chat_finish_turn_v2"] });
    expect(await finishTurnV2Available()).toBe(false);
    vi.setSystemTime(NOW.getTime() + 3_600_000 + 9 * 60_000);
    expect(await finishTurnV2Available()).toBe(false);
    expect(db.calls).toHaveLength(1);
    vi.setSystemTime(NOW.getTime() + 3_600_000 + 11 * 60_000);
    db.missing.clear();
    expect(await finishTurnV2Available()).toBe(true);
    expect(db.calls).toHaveLength(2);
    __resetSlackIntelStoreForTests();
    useDb({ fail: () => ({ code: "57014", message: "timeout" }) });
    expect(await thrown(finishTurnV2Available())).toMatchObject({ op: "finishTurnV2Available", pgCode: "57014" });
    useDb();
    expect(await finishTurnV2Available()).toBe(true);
  });

  it("finishTurnV2Rpc (RPC 9's caller, D6): one call with RPC 2's args plus the three Slack values; the consults land on the answer; errors carry op + code; abort wins", async () => {
    useDb({ tables: { exec_messages: [answer({ status: "running", text: "" })] } });
    const signal = new AbortController().signal;
    const args = { p_message_id: ECM(1), p_status: "complete", p_status_reason: null, p_refusal_category: null, p_text: "Done.", p_recommendations: "",
      p_sources: [], p_cards: [], p_tool_calls: [], p_consulted: [], p_consulted_clients: [], p_consulted_dd_text: false, p_usage: null, p_model: "m", p_ref_seq: 1,
      p_principal: "ep_spoofed" };
    const refs = [`m:C0GEN:${T(1)}`, "d:C0GEN:2026-11-07:0"];
    expect(await finishTurnV2Rpc(P1, args, { refs, channels: ["C0GEN"], privateSlack: true }, { signal })).toBe(true);
    const calls = rpcCalls("exec_chat_finish_turn_v2");
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].payload as Row)).toHaveLength(19);
    // The principal is always the caller's, never one smuggled in through args.
    expect(calls[0].payload).toMatchObject({ p_principal: "ep_1", p_slack_refs: refs, p_slack_channels: ["C0GEN"], p_private_slack: true, p_text: "Done." });
    expect(db.tables.exec_messages[0]).toMatchObject({ status: "complete", consulted_slack_refs: refs, consulted_slack_channels: ["C0GEN"], consulted_private_slack: true });
    // Not running any more → false, nothing written.
    expect(await finishTurnV2Rpc(P1, args, { refs, channels: ["C0GEN"], privateSlack: false }, { signal })).toBe(false);
    expect(db.tables.exec_messages[0]).toMatchObject({ consulted_private_slack: true });
    useDb({ fail: () => ({ code: "23514", message: `violates exec_messages_slack_pair_check ${S.slackText}` }) });
    const err = await thrown(finishTurnV2Rpc(P1, args, { refs, channels: ["C0GEN"], privateSlack: true }, { signal }));
    expect(err).toBeInstanceOf(SlackIntelStoreError);
    expect(err).toMatchObject({ op: "finishTurnV2", pgCode: "23514" });
    expect(String((err as Error).message)).not.toContain(S.slackText);
    useDb();
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    await expect(finishTurnV2Rpc(P1, args, { refs, channels: ["C0GEN"], privateSlack: true }, { signal: ac.signal })).rejects.toThrow("stopped");
    expect(db.calls).toHaveLength(0);
    await expect(finishTurnV2Rpc(P1, args, { refs, channels: ["C0GEN"], privateSlack: true }, {} as { signal: AbortSignal })).rejects.toThrow(TypeError);
  });

  it("redactSlackRpc: keys filtered to the two formats, 500 keys + channels per call, all = one call; text bounds; missing → 0", async () => {
    useDb({ tables: { exec_messages: [answer({ consulted_slack_refs: [`m:C0GEN:${T(1)}`], consulted_slack_channels: ["C0GEN"] })] } });
    const mk = Array.from({ length: 600 }, (_, i) => `m:C0GEN:${T(i)}`);
    const n = await redactSlackRpc(P1, { messageKeys: [...mk, "x:bad", `m:C0GEN:${T(1)}`], digestKeys: ["d:C0GEN:2026-11-07:0", "d:bad"], channelIds: ["C0Z", "bad"],
      all: false, text: "[Removed]" });
    expect(n).toBe(1);
    const calls = rpcCalls("exec_chat_redact_slack").map((c) => c.payload as Row);
    expect(calls.map((c) => [(c.p_message_keys as string[]).length, (c.p_digest_keys as string[]).length, (c.p_channel_ids as string[]).length, c.p_all]))
      .toEqual([[500, 0, 0, false], [100, 1, 1, false]]);
    expect(db.redactions).toEqual([{ rpc: "exec_chat_redact_slack", messageId: ECM(1), text: "[Removed]" }]);
    expect(db.tables.exec_messages[0]).toMatchObject({ text: "[Removed]", recommendations: "", sources: [], tool_calls: [{ round: 1, name: "search_slack", ok: true, error: null }] });
    expect(await redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: [], all: true, text: "[Removed]" })).toBe(0);
    expect(rpcCalls("exec_chat_redact_slack").at(-1)?.payload).toEqual({ p_principal: "ep_1", p_message_keys: [], p_digest_keys: [], p_channel_ids: [], p_all: true,
      p_text: "[Removed]" });
    expect(await redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: [], all: false, text: "[Removed]" })).toBe(0);
    await expect(redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: [], all: true, text: "" })).rejects.toThrow(TypeError);
    await expect(redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: [], all: true, text: "x".repeat(401) })).rejects.toThrow(TypeError);
    db.missing.add("exec_chat_redact_slack");
    expect(await redactSlackRpc(P1, { messageKeys: [`m:C0GEN:${T(1)}`], digestKeys: [], channelIds: [], all: false, text: "[Removed]" })).toBe(0);
  });

  it("redactSlackRpc (fixer security-2): a call that hits RPC 10's 2 000-answer cap is repeated until every hit is redacted (all and keyed)", async () => {
    const many = (n: number, over: Row) => Array.from({ length: n }, (_, i) => answer({ id: ECM(i + 1), conversation_id: `ecv_${i + 1}`,
      created_at: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 1000).toISOString(), ...over }));
    useDb({ tables: { exec_messages: many(4_005, { consulted_slack_channels: ["C0GEN"] }) } });
    expect(await redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: [], all: true, text: "[Removed]" })).toBe(4_005);
    expect(rpcCalls("exec_chat_redact_slack").map((c) => (c.payload as Row).p_all)).toEqual([true, true, true]);
    expect(db.tables.exec_messages.every((m) => m.text === "[Removed]")).toBe(true);
    useDb({ tables: { exec_messages: many(2_001, { consulted_slack_refs: [`m:C0GEN:${T(1)}`], consulted_slack_channels: ["C0GEN"] }) } });
    expect(await redactSlackRpc(P1, { messageKeys: [`m:C0GEN:${T(1)}`], digestKeys: [], channelIds: [], all: false, text: "[Removed]" })).toBe(2_001);
    expect(rpcCalls("exec_chat_redact_slack")).toHaveLength(2);
    // Exactly at the cap: one more call finds nothing left.
    useDb({ tables: { exec_messages: many(2_000, { consulted_slack_channels: ["C0GEN"] }) } });
    expect(await redactSlackRpc(P1, { messageKeys: [], digestKeys: [], channelIds: ["C0GEN"], all: false, text: "[Removed]" })).toBe(2_000);
    expect(rpcCalls("exec_chat_redact_slack")).toHaveLength(2);
  });

  it("recheckSlackRpc maps RPC 11's boolean (redactions recorded as the recheck's); a malformed id → false without a call; missing → false", async () => {
    useDb({ tables: {
      exec_slack_installations: [{ principal_id: "ep_1", revoked_at: null, user_revoked_at: null, user_token_enc: "sealed" }],
      exec_slack_channels: [chan()],
      exec_messages: [answer({ consulted_slack_channels: ["C0GONE"] }), answer({ id: ECM(2), consulted_slack_channels: ["C0GEN"], created_at: "2026-11-08T11:00:00.000Z",
        conversation_id: "ecv_2" })]
    } });
    const signal = new AbortController().signal;
    expect(await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal })).toBe(true);
    expect(db.redactions).toEqual([{ rpc: "exec_chat_slack_recheck", messageId: ECM(1), text: "[Removed]" }]);
    expect(await recheckSlackRpc(P1, ECM(2), "[Removed]", { signal })).toBe(false);
    expect(rpcCalls("exec_chat_slack_recheck")[0].payload).toEqual({ p_principal: "ep_1", p_message_id: ECM(1), p_text: "[Removed]" });
    const n = db.calls.length;
    expect(await recheckSlackRpc(P1, "bad", "[Removed]", { signal })).toBe(false);
    expect(db.calls.length).toBe(n);
    db.missing.add("exec_chat_slack_recheck");
    expect(await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal })).toBe(false);
  });

  it("fixer correctness-7 / security-4 (the fake mirrors RPC 11): what lands while the answer is written counts as gone", async () => {
    const AT = "2026-11-08T12:00:00.000Z";
    const AFTER = "2026-11-08T12:00:30.000Z";
    const BEFORE = "2026-11-08T11:00:00.000Z";
    const inst = { principal_id: "ep_1", revoked_at: null, user_revoked_at: null, user_token_enc: "sealed" };
    const signal = new AbortController().signal;
    const ans = (n: number, over: Row) => answer({ id: ECM(n), conversation_id: `ecv_${n}`, created_at: AT, ...over });
    const conv = (channel: string, reason: string, at: string) => ({ id: 0, principal_id: "ep_1", scope: "conversation", channel_id: channel, ts: null, reason, created_at: at });
    // A conversation purge during the turn (an author purge's IM); one before it, and a re-key, aren't.
    useDb({ tables: {
      exec_slack_installations: [inst], exec_slack_channels: [chan({ channel_id: "D0JANE", conv_type: "im", name: null }), chan(), chan({ channel_id: "C0B" })],
      exec_messages: [ans(1, { consulted_slack_channels: ["D0JANE"] }), ans(2, { consulted_slack_channels: ["C0GEN"] }), ans(3, { consulted_slack_channels: ["C0B"] })],
      exec_slack_purge_log: [conv("D0JANE", "author_optout", AFTER), conv("C0GEN", "left", BEFORE), conv("C0B", "rekey", AFTER)]
    } as never });
    expect([await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal }), await recheckSlackRpc(P1, ECM(2), "[Removed]", { signal }),
      await recheckSlackRpc(P1, ECM(3), "[Removed]", { signal })]).toEqual([true, false, false]);
    // A same-generation rebuild claimed during the turn over a deleted message in its window.
    useDb({ tables: {
      exec_slack_installations: [inst], exec_slack_channels: [chan()],
      exec_slack_digests: [dg({ requested_at: AFTER }), dg({ id: ESD(2), local_date: "2026-11-06", requested_at: BEFORE })],
      exec_messages: [ans(1, { consulted_slack_refs: ["d:C0GEN:2026-11-07:0"], consulted_slack_channels: ["C0GEN"] }),
        ans(2, { consulted_slack_refs: ["d:C0GEN:2026-11-06:0"], consulted_slack_channels: ["C0GEN"] })],
      exec_slack_purge_log: [{ id: 0, principal_id: "ep_1", scope: "message", channel_id: "C0GEN", ts: T(500), reason: "deleted_event", created_at: BEFORE }]
    } as never });
    expect(await recheckSlackRpc(P1, ECM(2), "[Removed]", { signal })).toBe(false);
    expect(await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal })).toBe(true);
    // An opt-out during the turn: every Slack answer; one before it: nothing.
    useDb({ tables: {
      exec_slack_installations: [inst], exec_slack_channels: [chan()],
      exec_messages: [ans(1, { consulted_slack_refs: [`m:C0GEN:${T(9)}`], consulted_slack_channels: ["C0GEN"] })],
      exec_slack_author_optouts: [{ principal_id: "ep_1", author_user_id: "U0OLD", created_at: BEFORE }]
    } as never });
    expect(await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal })).toBe(false);
    db.tables.exec_slack_author_optouts.push({ principal_id: "ep_1", author_user_id: "U0NEW", created_at: AFTER });
    expect(await recheckSlackRpc(P1, ECM(1), "[Removed]", { signal })).toBe(true);
  });

  it("fixer security-3 / security-5 (the fake mirrors RPCs 5 and 13): digests older than the newest opt-out, and flagged ones for drafts, are left out", async () => {
    const link = { principal_id: "ep_1", channel_id: "C0GEN", tag_client_id: "c_1", tag_client_name: "Acme", tag_project_ids: [], tagged_at: NOW.toISOString(),
      rule_client_id: null, rule_client_name: null, rule_candidates: 0, ...channelLinkVerdict({ tag_client_id: "c_1", tag_client_name: "Acme", rule_client_id: null,
        rule_client_name: null, rule_candidates: 0 }) };
    useDb({ tables: {
      exec_slack_channels: [chan()], exec_slack_channel_links: [link],
      exec_slack_digests: [
        dg({ summary: "alpha one", decisions: [{ msg: T(1), text: "alpha one decided" }], requested_at: "2026-11-08T05:29:00.000Z" }),
        dg({ id: ESD(2), local_date: "2026-11-06", summary: "alpha two", decisions: [{ msg: T(1), text: "alpha two decided" }], requested_at: "2026-11-08T09:00:00.000Z" }),
        dg({ id: ESD(3), local_date: "2026-11-05", summary: "alpha three", decisions: [{ msg: T(1), text: "alpha three decided" }], requested_at: "2026-11-08T09:00:00.000Z",
          injection_suspected: true })
      ],
      exec_slack_author_optouts: [{ principal_id: "ep_1", author_user_id: "U0OPTOUT", created_at: "2026-11-08T06:00:00.000Z" }]
    } as never });
    const found = await searchSlackStored(P1, { query: "alpha", channelIds: ["C0GEN"], bypassChannelIds: [], kinds: null, sinceIso: "2026-11-01T00:00:00Z",
      includeDigests: true, limit: 50 });
    expect(found.filter((x) => x.src === "digest").map((x) => x.id).sort()).toEqual([ESD(2), ESD(3)]);
    const facts = await listPublicSlackFactsForClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 20 });
    expect(facts.filter((x) => x.src === "digest").map((x) => x.id)).toEqual([ESD(2)]);
  });

  it("ST12: listOrphanSlackChannels clamps the limit to 1..200 and accepts scalar or object rows, dropping malformed ids", async () => {
    useDb({ tables: { exec_messages: [answer({ consulted_slack_channels: ["C0A", "C0B", "C0C"] })] } });
    expect(await listOrphanSlackChannels(P1, 2)).toEqual(["C0A", "C0B"]);
    expect(await listOrphanSlackChannels(P1, 0)).toEqual(["C0A"]);
    expect(rpcCalls("exec_chat_slack_orphan_channels").map((c) => (c.payload as Row).p_limit)).toEqual([2, 1]);
    const client = db.client as { rpc(fn: string, a: Row): unknown };
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc: () => Promise.resolve({ data: [{ exec_chat_slack_orphan_channels: "C0Q" }, "C0R", "bad", null], error: null }) } as never);
    expect(await listOrphanSlackChannels(P1, 10)).toEqual(["C0Q", "C0R"]);
    void client;
  });
});

// ---------------------------------------------------------------------------

describe("ST10 / ST11: no excerpt is ever selected; errors carry the op and code only", () => {
  it("ST10: every read of the store selects explicit columns, none of them excerpt (a query-string spy over every request)", async () => {
    useDb({ tables: { exec_slack_channels: [chan()], exec_slack_messages: [msg()], exec_slack_items: [itm()], exec_slack_digests: [dg()] } });
    await listChannelLinks(P1);
    await listChannelLinks(P1, { channelIds: ["C0GEN"] });
    await listChannelsLinkedToClient(P1, "c_1", ["high", "low"]);
    await listChannelsTaggedToProject(P1, "p_1");
    await getMessageLinks(P1, [{ channelId: "C0GEN", ts: T(1), threadTs: T(0) }]);
    await listItemKeysLinkedToClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 5 });
    await getDigests(P1, { dates: ["2026-11-07"] });
    await getDigestsByIds(P1, [ESD(1)]);
    await slackIntelSchemaReady();
    await purgeExpiredSlackIntel(NOW);
    const reads = db.calls.filter((c) => c.kind !== "rpc");
    expect(reads.length).toBeGreaterThanOrEqual(10);
    for (const c of reads) {
      expect(c.columns, `${c.kind} ${c.target}`).not.toBe("*");
      expect(String(c.columns ?? ""), `${c.kind} ${c.target}`).not.toMatch(/excerpt/);
    }
    expect(reads.every((c) => ["exec_slack_channel_links", "exec_slack_message_links", "exec_slack_digests"].includes(c.target))).toBe(true);
    const src = readFileSync(new URL("./slack-intel-store.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/excerpt/);
    expect(src.match(/"exec_slack_(channels|messages|items|deleted|purge_log|author_optouts|installations)"/g)).toBeNull();
  });

  it("ST11: a failed request's error is SlackIntelStoreError(op, code): no value it was handed or read, no log line; an abort wins", async () => {
    const LEAK = `${S.slackText} ${S.clientName} ${S.query}`;
    useDb({ tables: { exec_slack_channels: [chan()] }, fail: () => ({ code: "XX000", message: LEAK, details: LEAK } as never) });
    const errs = [
      await thrown(listChannelLinks(P1)),
      await thrown(searchSlackStored(P1, { query: S.query, channelIds: ["C0GEN"], bypassChannelIds: [], kinds: null, sinceIso: "2026-11-01T00:00:00Z", includeDigests: true, limit: 5 })),
      await thrown(listPublicSlackFactsForClient(P1, "c_1", { sinceIso: "2026-11-01T00:00:00Z", limit: 5 })),
      await thrown(setChannelTags(P1, { channelId: "C0GEN", client: { id: "c_1", name: S.clientName }, projectIds: [] })),
      await thrown(redactSlackRpc(P1, { messageKeys: [`m:C0GEN:${T(1)}`], digestKeys: [], channelIds: [], all: false, text: "[Removed]" })),
      await thrown(getDigests(P1, { dates: ["2026-11-07"] }))
    ] as SlackIntelStoreError[];
    for (const e of errs) {
      expect(e).toBeInstanceOf(SlackIntelStoreError);
      expect(e.message).toMatch(/^exec slack intel store: [A-Za-z]+ failed \(XX000\)$/);
      expect(e.pgCode).toBe("XX000");
    }
    assertNoSlackLeak({ errors: errs.map((e) => [e.message, e.op, e.stack ?? ""]), console: out });
    const ac = new AbortController();
    ac.abort(new Error("lease lost"));
    useDb({ tables: { exec_slack_channels: [chan()] } });
    await expect(listChannelLinks(P1, { signal: ac.signal })).rejects.toThrow("lease lost");
    await expect(searchSlackStored(P1, { query: "q", channelIds: ["C0GEN"], bypassChannelIds: [], kinds: null, sinceIso: "2026-11-01T00:00:00Z", includeDigests: true,
      limit: 5 }, { signal: ac.signal })).rejects.toThrow("lease lost");
    await expect(slackIntelState(P1, { slackReadingSchemaReady: true, slackReadingEnabled: true } as ExecSettings, { signal: ac.signal })).resolves.toBe("not_installed");
    await expect(listChannelLinks(null as unknown as ExecPrincipal)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe("the fake twin of the SQL suite's shared cases (SQ05, SQ08's NULL hole, SQ12)", () => {
  it("channelLinkVerdict = §2.1.2's generated columns", () => {
    expect(channelLinkVerdict({ tag_client_id: "c_1", tag_client_name: "Acme", rule_client_id: "c_2", rule_client_name: "Beta", rule_candidates: 1 }))
      .toEqual({ client_id: "c_1", client_name: "Acme", client_match_via: "tag", match_confidence: "high", client_candidates: 1 });
    expect(channelLinkVerdict({ tag_client_id: null, tag_client_name: null, rule_client_id: "c_2", rule_client_name: "Beta", rule_candidates: 1 }))
      .toEqual({ client_id: "c_2", client_name: "Beta", client_match_via: "name", match_confidence: "low", client_candidates: 1 });
    expect(channelLinkVerdict({ tag_client_id: null, tag_client_name: null, rule_client_id: null, rule_client_name: null, rule_candidates: 3 }))
      .toEqual({ client_id: null, client_name: null, client_match_via: "name", match_confidence: "low", client_candidates: 3 });
    expect(channelLinkVerdict({ tag_client_id: null, tag_client_name: null, rule_client_id: null, rule_client_name: null, rule_candidates: 0 }))
      .toEqual({ client_id: null, client_name: null, client_match_via: null, match_confidence: null, client_candidates: 0 });
  });

  it("the fake refuses a generated column write (428C9) and a verdict with a via but no confidence (the CHECK's NULL hole, closed)", async () => {
    useDb({ tables: { exec_slack_channels: [chan()], exec_slack_messages: [msg()] } });
    const client = db.client as { from(t: string): { insert(r: Row): PromiseLike<{ error: { code?: string; message: string } | null }> } };
    expect((await client.from("exec_slack_channel_links").insert({ principal_id: "ep_1", channel_id: "C0GEN", client_id: "c_1" })).error?.code).toBe("428C9");
    const bad = await client.from("exec_slack_message_links").insert({ principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), client_id: "c_1", client_name: "Acme",
      client_match_via: "dd_post", client_candidates: 1 });
    expect(bad.error).toMatchObject({ code: "23514" });
    expect(bad.error?.message).toContain("exec_slack_message_links_verdict_check");
  });

  it("RPC 6's claim matrix in the fake equals SQ12's", async () => {
    const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
    const cases: [Row | null, "plan" | "today" | "rebuild", string][] = [
      [null, "plan", "claimed"], [{ status: "built", full_day: true }, "plan", "fresh"], [{ status: "built", full_day: false }, "plan", "claimed"],
      [{ status: "empty", full_day: false, source_ts: [T(1)] }, "plan", "claimed"], [{ status: "skipped_cap" }, "plan", "claimed"],
      [{ status: "built", built_at: ago(7_200_000) }, "today", "claimed"], [{ status: "built", built_at: ago(600_000) }, "today", "fresh"],
      [{ status: "stale" }, "rebuild", "claimed"], [{ status: "failed" }, "rebuild", "claimed"], [{ status: "built", full_day: true }, "rebuild", "fresh"],
      [{ status: "building", requested_at: ago(60_000) }, "plan", "busy"], [{ status: "building", requested_at: ago(660_000) }, "today", "claimed"]
    ];
    for (const [i, [row, mode, outcome]] of cases.entries()) {
      useDb({ tables: { exec_slack_channels: [chan()], exec_slack_digests: row ? [dg({ rebuilds: 3, ...row })] : [] } });
      const r = await claimDigest(P1, { channelId: "C0GEN", localDate: "2026-11-07", tz: "UTC", fromTs: T(0), toTs: T(1), expiresAt: "2026-12-01T00:00:00Z", mode });
      expect(r.outcome, `case ${i}`).toBe(outcome);
      if (r.outcome === "claimed") {
        expect(r.rebuilds).toBe(row ? 3 : 0);
        expect(db.tables.exec_slack_digests[0]).toMatchObject({ status: "building", full_day: false, summary: null, source_ts: [] });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ST13-ST15: P7b's additive reads in P7a's slack-read-store.ts, against P7a's own fake
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const INST = `esi_${hex32(1)}`;
const NINE = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
let rdb: FakeSlackReadDb;
function useReadDb(seed: FakeSlackReadDbSeed = {}): FakeSlackReadDb {
  rdb = createFakeSlackReadDb({ now: () => NOW, ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(rdb.client as SupabaseClient);
  return rdb;
}
function inst(over: Row = {}): Row {
  const bot = sealSecret("xoxb-intel-store-test-bot", "exec_slack_installations.bot_token:ep_1");
  const user = sealSecret(S.userToken, "exec_slack_installations.user_token:ep_1");
  return {
    id: INST, principal_id: "ep_1", team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot, key_id: bot.split(".")[1],
    bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: user, user_scopes: [...NINE], slack_dm_channel_id: "D0MITCH",
    installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null,
    last_error_at: null, purged_at: null, user_key_id: user.split(".")[1], user_installed_at: "2026-11-01T00:00:00.000Z", user_revoked_at: null,
    user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "ready", discovered_at: "2026-11-01T01:00:00.000Z",
    reading_purged_at: null, ...over
  };
}
function p7aChannel(over: Row = {}): Row {
  return {
    principal_id: "ep_1", installation_id: INST, channel_id: "C0GEN", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null, finance_name: false,
    watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: S.channelName, im_user_id: null, is_member: true, is_private: false,
    is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null,
    last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: "2026-11-01T01:00:00.000Z", seen_at: "2026-11-01T01:00:00.000Z", left_at: null,
    created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", ...over
  };
}
const p7aDeny = (id: string, over: Row = {}): Row =>
  p7aChannel({ channel_id: id, class: "deny", deny_reason: "lead_name", name: null, watch_state: "unwatched", is_member: false, is_private: true, ...over });
function p7aMessage(over: Row = {}): Row {
  return {
    principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), thread_ts: null, role: "candidate", author_user_id: "U0JANE", author_external: false, is_dd_post: false,
    dd_paths: [], reasons: 2, triage_state: "assessed", content_hash: null, edited_ts: null, responded_ts: null, responded_at: null, acknowledged_at: null,
    assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}
function p7aItem(n: number, over: Row = {}): Row {
  return {
    id: ESL(n), principal_id: "ep_1", channel_id: "C0GEN", ts: T(1), kind: "request", thread_ts: null, author_user_id: "U0JANE", author_label: S.authorName,
    author_external: false, assessed: true, addressed_to_you: true, needs_response: true, bypass_mute: false, urgency: "normal", summary: S.summary, excerpt: S.excerpt,
    due_text: null, due_at: null, commitment_direction: null, source_class: "public", permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null,
    expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}
const settingsRow = (on = true) => ({ principal_id: "ep_1", slack_reading_enabled: on, slack_daily_cap_usd: 2, watch_mode: "member_only", updated_at: NOW.toISOString() });

describe("ST13: listIntelChannels (P7a-2, in P7a's store)", () => {
  beforeEach(() => {
    vi.stubEnv("EXEC_TOKEN_KEY", KEY);
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("every row of the principal but class deny, by channel id; the channelIds filter (malformed ids ignored); P7a's columns; missing → []", async () => {
    useReadDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: { exec_slack_channels: [
      p7aChannel({ channel_id: "C0ZED" }), p7aChannel(), p7aDeny("C0DENY"), p7aChannel({ channel_id: "C0HUB", class: "hub", hub_kind: "outbound" }),
      p7aChannel({ channel_id: "C0UNC", class: "unclassified", name: null, watch_state: "unwatched" }), p7aChannel({ channel_id: "C0OTH", principal_id: "ep_2" })
    ] } });
    const all = await listIntelChannels(P1);
    expect(all.map((c) => [c.channelId, c.class])).toEqual([["C0GEN", "standard"], ["C0HUB", "hub"], ["C0UNC", "unclassified"], ["C0ZED", "standard"]]);
    expect(all[0]).toMatchObject({ convType: "channel", watchState: "watched", isPrivate: false, financeName: false, leftAt: null, name: S.channelName });
    const sel = rdb.calls.filter((c) => c.target === "exec_slack_channels");
    expect(sel[0].columns).not.toMatch(/\*/);
    expect(sel[0].filters).toEqual(expect.arrayContaining([{ op: "eq", column: "principal_id", value: "ep_1" }, { op: "neq", column: "class", value: "deny" }]));
    expect((await listIntelChannels(P1, { channelIds: ["C0DENY", "C0ZED", "bad", "C0ZED"] })).map((c) => c.channelId)).toEqual(["C0ZED"]);
    expect(await listIntelChannels(P1, { channelIds: [] })).toEqual([]);
    useReadDb({ missing: ["exec_slack_channels"] });
    expect(await listIntelChannels(P1)).toEqual([]);
    useReadDb({ fail: () => ({ code: "57014", message: "timeout" }) });
    expect(await thrown(listIntelChannels(P1))).toMatchObject({ name: "SlackReadStoreError", op: "listIntelChannels", pgCode: "57014" });
  });

  it("at most 2 000 rows (two pages of 1 000)", async () => {
    useReadDb({ slack: { tables: { exec_slack_installations: [inst()] } }, tables: {
      exec_slack_channels: Array.from({ length: 2100 }, (_, i) => p7aChannel({ channel_id: `C0N${String(i).padStart(4, "0")}` })) } });
    const r = await listIntelChannels(P1);
    expect(r).toHaveLength(2000);
    expect(r.at(-1)?.channelId).toBe("C0N1999");
    expect(rdb.calls.filter((c) => c.target === "exec_slack_channels").map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });
});

describe("ST14: getSlackItemsByIds applies P7a's C20 screen (slackScreenRows + slackScreenAllows); the only P7a read that selects excerpt for P7b", () => {
  beforeEach(() => {
    vi.stubEnv("EXEC_TOKEN_KEY", KEY);
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  function seed(opts: { on?: boolean; half?: Row } = {}) {
    useReadDb({
      slack: { tables: { exec_slack_installations: [inst(opts.half ?? {})] } },
      tables: {
        exec_settings: [settingsRow(opts.on ?? true)],
        exec_slack_channels: [
          p7aChannel(),
          p7aChannel({ channel_id: "C0MUT", watch_state: "muted", mute_source: "owner" }),
          p7aChannel({ channel_id: "C0SMU", watch_state: "muted", mute_source: "slack" }),
          p7aChannel({ channel_id: "C0UNW", watch_state: "unwatched", is_member: false }),
          p7aChannel({ channel_id: "C0FIN", class: "finance", finance_name: true }),
          p7aChannel({ channel_id: "C0FMU", class: "finance", finance_name: true, watch_state: "muted", mute_source: "owner" }),
          p7aChannel({ channel_id: "C0EXF", class: "external", is_ext_shared: true, ext_ever: true, finance_name: true }),
          p7aChannel({ channel_id: "C0HUB", class: "hub", hub_kind: "outbound" }),
          p7aChannel({ channel_id: "C0UNC", class: "unclassified", name: null, watch_state: "unwatched" })
        ],
        exec_slack_messages: [p7aMessage(), p7aMessage({ ts: T(2) }), p7aMessage({ ts: T(3) }), ...["C0MUT", "C0SMU", "C0UNW", "C0FIN", "C0FMU", "C0EXF", "C0HUB", "C0UNC"]
          .flatMap((c) => [p7aMessage({ channel_id: c }), p7aMessage({ channel_id: c, ts: T(2) })])],
        exec_slack_items: [
          p7aItem(1), // shown
          p7aItem(2, { ts: T(2), kind: "decision", source_class: "finance" }), // a finance item in a watched channel: web only
          p7aItem(3, { ts: T(3) }), // its message carries a deleted marker
          p7aItem(4, { ts: T(9) }), // no message row (an FK the fake doesn't hold: a purge raced)
          p7aItem(5, { channel_id: "C0MUT" }), p7aItem(6, { channel_id: "C0MUT", ts: T(2), bypass_mute: true }),
          p7aItem(7, { channel_id: "C0SMU", bypass_mute: true }), p7aItem(8, { channel_id: "C0UNW", bypass_mute: true }),
          p7aItem(9, { channel_id: "C0FIN", source_class: "finance" }), p7aItem(10, { channel_id: "C0FMU", bypass_mute: true, source_class: "finance" }),
          p7aItem(11, { channel_id: "C0EXF", source_class: "finance" }), p7aItem(12, { channel_id: "C0HUB" }), p7aItem(13, { channel_id: "C0UNC" })
        ],
        exec_slack_deleted: [{ principal_id: "ep_1", channel_id: "C0GEN", ts: T(3), reason: "event", deleted_at: NOW.toISOString(), expires_at: "2026-11-09T17:00:00.000Z" }]
      }
    });
  }
  const ALL = Array.from({ length: 13 }, (_, i) => ESL(i + 1));

  it("web: watched rows, owner / Slack-muted bypass items, finance shown; withheld: marker, no message row, plain muted, unwatched, finance mutes, hub, unclassified", async () => {
    seed();
    const web = await getSlackItemsByIds(P1, [...ALL].reverse(), { surface: "web" });
    expect(web.map((i) => i.id)).toEqual([ESL(11), ESL(9), ESL(7), ESL(6), ESL(2), ESL(1)]);
    expect(web.find((i) => i.id === ESL(1))).toMatchObject({ excerpt: S.excerpt, summary: S.summary, sourceClass: "public" });
    const sel = rdb.calls.filter((c) => c.target === "exec_slack_items" && c.kind === "select");
    expect(sel[0].columns).toMatch(/\bexcerpt\b/);
    expect(sel[0].filters).toEqual(expect.arrayContaining([{ op: "eq", column: "principal_id", value: "ep_1" }]));
  });

  it("slack: finance items and finance channels (class or name) withheld too; any other surface screens as slack", async () => {
    seed();
    expect((await getSlackItemsByIds(P1, ALL, { surface: "slack" })).map((i) => i.id)).toEqual([ESL(1), ESL(6), ESL(7)]);
    expect((await getSlackItemsByIds(P1, ALL, { surface: "chat" as never })).map((i) => i.id)).toEqual([ESL(1), ESL(6), ESL(7)]);
  });

  it("reading not live (switch off, revoked half) → []; another principal's ids → []; malformed ids ignored, ≤ 500; missing → []; a failure throws", async () => {
    seed({ on: false });
    expect(await getSlackItemsByIds(P1, ALL, { surface: "web" })).toEqual([]);
    seed({ half: { user_token_enc: null, user_key_id: null, reading_state: "revoked", discovered_at: null, user_revoked_at: NOW.toISOString(), user_revoke_reason: "stopped" } });
    expect(await getSlackItemsByIds(P1, ALL, { surface: "web" })).toEqual([]);
    seed();
    expect(await getSlackItemsByIds(P2, ALL, { surface: "web" })).toEqual([]);
    expect(await getSlackItemsByIds(P1, ["bad", "esl_x"], { surface: "web" })).toEqual([]);
    expect(rdb.calls.filter((c) => c.target === "exec_slack_items")).toHaveLength(1);
    await getSlackItemsByIds(P1, Array.from({ length: 700 }, (_, i) => ESL(1000 + i)), { surface: "web" });
    const ids = rdb.calls.filter((c) => c.target === "exec_slack_items").slice(1).flatMap((c) => (c.filters.find((f) => f.op === "in") as { values: unknown[] }).values);
    expect(ids).toHaveLength(500);
    useReadDb({ missing: ["exec_slack_items"] });
    expect(await getSlackItemsByIds(P1, ALL, { surface: "web" })).toEqual([]);
    useReadDb({ fail: (c) => (c.target === "exec_slack_items" ? { code: "57014", message: "timeout" } : null) });
    expect(await thrown(getSlackItemsByIds(P1, ALL, { surface: "web" }))).toMatchObject({ op: "getSlackItemsByIds", pgCode: "57014" });
  });

  it("the screen is P7a's own rule: for every item, shown ⇔ slackScreenAllows over slackScreenRows (one rule, never re-implemented)", async () => {
    const { slackScreenAllows } = await import("@/lib/exec/attention-read");
    const { slackScreenRows } = await import("@/lib/exec/slack-read-store");
    seed();
    const items = rdb.tables.exec_slack_items.map((r) => ({ id: String(r.id), channelId: String(r.channel_id), ts: String(r.ts), bypassMute: r.bypass_mute === true,
      sourceClass: String(r.source_class) }));
    const rows = await slackScreenRows(P1, items.map((i) => ({ channelId: i.channelId, ts: i.ts })));
    for (const surface of ["web", "slack"] as const) {
      const want = items.filter((i) => slackScreenAllows(rows, i, i, surface)).map((i) => i.id);
      expect((await getSlackItemsByIds(P1, ALL, { surface })).map((i) => i.id), surface).toEqual(want);
    }
  });
});

describe("ST15: listAuthorOptouts (P7a's own, bound as is: ids only)", () => {
  it("the opted-out author ids of the principal, sorted; malformed ids dropped; missing → []; a failure throws", async () => {
    useReadDb({ tables: { exec_slack_author_optouts: [
      { principal_id: "ep_1", author_user_id: "U0OPTOUT", created_at: NOW.toISOString() }, { principal_id: "ep_1", author_user_id: "U0ALPHA", created_at: NOW.toISOString() },
      { principal_id: "ep_2", author_user_id: "U0OTHER", created_at: NOW.toISOString() }, { principal_id: "ep_1", author_user_id: "not-a-user", created_at: NOW.toISOString() }
    ] } });
    expect(await listAuthorOptouts(P1)).toEqual(["U0ALPHA", "U0OPTOUT"]);
    const sel = rdb.calls.filter((c) => c.target === "exec_slack_author_optouts");
    expect(sel[0].columns).toBe("author_user_id");
    useReadDb({ missing: ["exec_slack_author_optouts"] });
    expect(await listAuthorOptouts(P1)).toEqual([]);
    useReadDb({ fail: () => ({ code: "57014", message: "timeout" }) });
    expect(await thrown(listAuthorOptouts(P1))).toMatchObject({ op: "listAuthorOptouts", pgCode: "57014" });
  });
});

describe("the sync-state source \"slack-intel\" (§3.2, AM-P7b-15): its three keys round-trip; the value holds refs only", () => {
  it("purge-log { afterId }, optouts { fp, count }, correlate { lastFullAt } are written and read back under source slack-intel", async () => {
    const { createFakePostgrest } = await import("@/lib/exec/__tests__/fake-postgrest");
    const { getSyncState, putSyncState } = await import("@/lib/exec/sync-state");
    const pg = createFakePostgrest({ tables: { exec_sync_state: [] } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(pg.client as SupabaseClient);
    const parseAny = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);
    await putSyncState(P1, "slack-intel", "purge-log", { afterId: 42 });
    await putSyncState(P1, "slack-intel", "optouts", { fp: "0123456789ab", count: 2 });
    await putSyncState(P1, "slack-intel", "correlate", { lastFullAt: NOW.toISOString() });
    expect((await getSyncState(P1, "slack-intel", "purge-log", parseAny))?.value).toMatchObject({ afterId: 42 });
    expect((await getSyncState(P1, "slack-intel", "optouts", parseAny))?.value).toMatchObject({ fp: "0123456789ab", count: 2 });
    expect((await getSyncState(P1, "slack-intel", "correlate", parseAny))?.value).toMatchObject({ lastFullAt: NOW.toISOString() });
    expect(pg.tables.exec_sync_state.map((r) => [r.source, r.key]).sort()).toEqual([["slack-intel", "correlate"], ["slack-intel", "optouts"], ["slack-intel", "purge-log"]]);
    assertNoSlackLeak({ extra: { rows: pg.tables.exec_sync_state } });
  });
});
