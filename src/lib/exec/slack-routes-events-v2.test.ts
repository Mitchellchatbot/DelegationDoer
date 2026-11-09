import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ kickInteractive: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/runtime", () => ({ ensureExecRuntime: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// The real stores over the fakes, with call spies on the two acks.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...actual, acceptEvent: vi.fn(actual.acceptEvent) };
});
vi.mock("@/lib/exec/slack-read-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, acceptEventV2: vi.fn(actual.acceptEventV2) };
});
vi.mock("@/lib/exec/slack-ingest", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-ingest")>();
  return { ...actual, ingestFactsForRpc: vi.fn(actual.ingestFactsForRpc), deriveIngestFacts: vi.fn(actual.deriveIngestFacts) };
});

import * as eventsRoute from "@/app/api/integrations/exec-slack/events/route";
import { createFakeSlackDb, type FakeSlackDb, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import { SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { installationRow, routingRows, signedSlackRequest, slackEnv, testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { kickInteractive } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import * as gate from "@/lib/exec/slack-gate-cache";
import { deriveIngestFacts, ingestFactsForRpc } from "@/lib/exec/slack-ingest";
import { parseEventEnvelope } from "@/lib/exec/slack-events";
import { acceptEvent, slackSystemSummary } from "@/lib/exec/slack-install";
import { acceptEventV2 } from "@/lib/exec/slack-read-store";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// POST /api/integrations/exec-slack/events, P7a (contract §3.9.2, §5.3, N5, C1-C6, C43, C48; Area C):
// V201-V244 (with V223b) and FB01-FB05. The real route runs against the real stores: slack-read-store.ts over
// fake-slack-read-db.ts, whose exec_slack_accept_event_v2 mirrors §2.7 and hands P6's events to P6's v1 in the composed
// fake (RQ13 keeps that mirror equal to the SQL on PGlite, PG15 and PG17). The V2 decision table
// (fixtures/slack-gate.json, AM-P7a-16) drives the replay: every row's envelope goes through the route (signature,
// envelope, the derived facts, the pre-DB filter, the gate, v2) and must leave exactly the rows the SQL leaves.
// FB01-FB05 run the same route against P6's own fake (no v2 at all). No live Slack, model or network call.

type Json = Record<string, unknown>;
const FIXTURES = new URL("./__tests__/fixtures/", import.meta.url);
const GATE = JSON.parse(readFileSync(new URL("slack-gate.json", FIXTURES), "utf8")) as {
  base: Json & { installationId: string; installation: Json; settings: Json; ddBot: Json; optouts: string[]; fb: Json[] };
  rows: GateRow[];
};
type GateRow = { name: string; ingest: string; state?: Json; send?: "once" | "twice" | "again"; retry?: number; expect: Json };
const INGEST = JSON.parse(readFileSync(new URL("slack-ingest.json", FIXTURES), "utf8")) as {
  channels: Record<string, Json>;
  rows: { name: string; envelope: Json; expectFacts?: Json | null; expectDerive?: null; expectChannel?: string; expectPrefilter?: string }[];
};
const PID = "ep_1";
const MIN = 60_000;
const P = testPrincipal(PID);

let out: ReturnType<typeof captureConsole>;
let fetchSpy: ReturnType<typeof vi.fn>;
let current: { client: unknown; calls: { kind: string; target: string; payload: unknown; signal: AbortSignal | null }[] } | null = null;

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
function useDb<T extends FakeSlackReadDb | FakeSlackDb>(db: T): T {
  current = db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const ingestRow = (name: string) => {
  const r = INGEST.rows.find((x) => x.name === name || x.name.startsWith(name));
  if (!r) throw new Error(`no slack-ingest row ${name}`);
  return structuredClone(r);
};
const envelopeOf = (name: string, over: (env: Json) => void = () => {}): Json => {
  const env = ingestRow(name).envelope;
  over(env);
  return env;
};
const post = (envelope: unknown, retry = 0) =>
  eventsRoute.POST(signedSlackRequest("events", JSON.stringify(envelope), retry > 0 ? { headers: { "x-slack-retry-num": String(retry) } } : {}));
const lines = () => out.calls().map((c) => String(c[0])).filter((l) => l.startsWith("[exec-slack] events"));
const rpcCalls = () => (current?.calls ?? []).filter((c) => c.kind === "rpc").map((c) => c.target);

// ---------------------------------------------------------------------------
// The gate fixture's seed and snapshot (the twins of slack-read-gate.test.ts / slack-gate.mjs, Area A's)

function seedFor(row: { state?: Json }, extra: Partial<FakeSlackReadDbSeed> = {}): FakeSlackReadDb {
  const b = GATE.base;
  const st = (row.state ?? {}) as Json;
  const inst: Row = { ...b.installation, id: b.installationId, principal_id: PID, revoked_at: null, revoke_reason: null, last_dm_at: null,
    last_error_code: null, last_error_at: null, purged_at: null, user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
    user_last_error_at: null, reading_purged_at: null };
  const io = (st.installation ?? {}) as Json;
  if (io.reading === "none") Object.assign(inst, { user_token_enc: null, user_key_id: null, user_scopes: [], user_installed_at: null, reading_state: "none", discovered_at: null });
  if (io.reading === "discovering") Object.assign(inst, { reading_state: "discovering", discovered_at: null });
  for (const [k, v] of Object.entries(io)) if (k !== "reading") inst[k] = v;
  const settings = { principal_id: PID, ...b.settings, ...((st.settings ?? {}) as Json) };
  const cat: Record<string, Json> = { ...INGEST.channels };
  delete cat["(none)"];
  for (const [id, over] of Object.entries((st.channels ?? {}) as Record<string, Json | null>)) {
    if (over === null) delete cat[id];
    else cat[id] = { ...(cat[id] ?? {}), ...over };
  }
  const now = "2026-11-08T14:00:00.000Z";
  const channels = Object.entries(cat).map(([id, c]) => {
    const deny = c.class === "deny";
    return {
      principal_id: PID, installation_id: b.installationId, channel_id: id, conv_type: c.convType, class: c.class, deny_reason: c.denyReason ?? null,
      hub_kind: c.hubKind ?? null, finance_name: c.financeName === true, watch_state: c.watchState ?? "unwatched", mute_source: c.muteSource ?? null,
      watch_set_by_owner_at: c.ownerSet ? "2026-11-02T00:00:00.000Z" : null, name: deny || c.class === "unclassified" ? null : (c.name ?? null),
      im_user_id: c.imUserId ?? null, is_member: c.isMember === true, is_private: c.isPrivate !== false || c.convType !== "channel",
      is_ext_shared: c.isExtShared === true, ext_ever: c.extEver === true || c.isExtShared === true, is_archived: c.isArchived === true,
      hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null,
      classified_at: now, seen_at: now, left_at: c.leftAt ?? null, created_at: now, updated_at: now
    };
  });
  const list = (k: string) => (Array.isArray(st[k]) ? (st[k] as Json[]) : []);
  const messages = list("messages").map((m) => ({
    principal_id: PID, channel_id: m.channel, ts: m.ts, thread_ts: m.thread_ts ?? null, role: m.role ?? "candidate",
    author_user_id: m.role === "anchor" ? null : (m.author ?? "U0JANE"), author_external: m.author_external === true, is_dd_post: m.role === "anchor",
    dd_paths: m.dd_paths ?? [], reasons: m.role === "anchor" ? 0 : (m.reasons ?? 2), triage_state: m.role === "anchor" ? "none" : (m.triage_state ?? "pending"),
    content_hash: null, edited_ts: null, responded_ts: null, responded_at: null, acknowledged_at: null, assessed_at: null,
    expires_at: "2027-02-01T00:00:00.000Z", created_at: now, updated_at: now
  }));
  const items = list("items").map((i, n) => ({
    id: `esl_${String(n + 1).padStart(32, "0")}`, principal_id: PID, channel_id: i.channel, ts: i.ts, kind: i.kind ?? "request", thread_ts: i.thread_ts ?? null,
    author_user_id: i.author ?? "U0JANE", author_label: "A label", author_external: false, assessed: true, addressed_to_you: false, needs_response: false,
    bypass_mute: false, urgency: "normal", summary: "A summary", excerpt: i.excerpt === false ? null : "An excerpt", due_text: null, due_at: null,
    commitment_direction: i.kind === "commitment" ? "mitchell_owes" : null, source_class: i.source_class ?? "public", permalink: null,
    responded_ts: null, responded_at: null, acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: now, updated_at: now
  }));
  const threads = list("threads").map((t) => ({ principal_id: PID, channel_id: t.channel, thread_ts: t.thread_ts, he_posted_ts: t.he_posted_ts ?? null,
    reply_watermark_ts: null, latest_reply_seen_ts: null, expires_at: "2027-02-01T00:00:00.000Z", updated_at: now }));
  const markers = list("markers").map((m) => ({ principal_id: PID, channel_id: m.channel, ts: m.ts, reason: "event", deleted_at: now, expires_at: "2026-11-09T16:00:00.000Z" }));
  const attention = ((st.attention ?? []) as string[]).map((fp, n) => ({ id: `ea_${n}`, principal_id: PID, fingerprint: fp, source: "slack", kind: "slack_request",
    status: "open" }));
  const optouts = ((st.optouts ?? b.optouts) as string[]).map((a) => ({ principal_id: PID, author_user_id: a, created_at: now }));
  const ddBot = st.ddBot === false ? [] : [{ ...b.ddBot, checked_at: now }];
  const fb = st.fb === "missing" || st.fb === "empty" ? [] : b.fb.map((e, n) => ({
    task_id: `t_${n}`, state: { "access.notify.slack_channels": { v: JSON.stringify([e]) }, "access.ein.number": { v: "12-3456789" } }
  }));
  return createFakeSlackReadDb({
    now: () => new Date(),
    missing: st.fb === "missing" ? ["fb_onboarding", ...(extra.missing ?? [])] : [...(extra.missing ?? [])],
    ...(extra.before ? { before: extra.before } : {}),
    tables: {
      exec_slack_installations: [inst], exec_settings: [settings], exec_slack_channels: channels, exec_slack_messages: messages, exec_slack_items: items,
      exec_slack_threads: threads, exec_slack_deleted: markers, exec_attention_items: attention, exec_slack_author_optouts: optouts, exec_slack_dd_bot: ddBot,
      fb_onboarding: fb
    }
  });
}

/** The normalized snapshot (slack-read-gate.test.ts's effects): the same columns, pid → <p>, time buckets → *. */
function effects(db: FakeSlackReadDb): Json {
  const t = db.tables;
  const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));
  const inst = [...t.exec_slack_installations].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const snapshot = {
    installation: inst ? { revoked: inst.revoked_at !== null && inst.revoked_at !== undefined, revoke_reason: inst.revoke_reason ?? null,
      reading_state: inst.reading_state ?? null, has_token: typeof inst.user_token_enc === "string" } : null,
    events: t.exec_slack_events.map((e) => pick(e, ["event_id", "decision", "drop_reason", "ingest_outcome", "slack_user_id", "channel_id", "message_ts"])),
    channels: t.exec_slack_channels.map((c) => ({
      ...pick(c, ["channel_id", "conv_type", "class", "deny_reason", "hub_kind", "watch_state", "mute_source", "finance_name", "name", "im_user_id", "is_member",
        "is_private", "is_ext_shared", "ext_ever", "is_archived"]),
      left: c.left_at !== null && c.left_at !== undefined, owner_set: c.watch_set_by_owner_at !== null && c.watch_set_by_owner_at !== undefined,
      last_event_ts: c.last_event_ts ?? null, hist_watermark_ts: c.hist_watermark_ts ?? null
    })),
    messages: t.exec_slack_messages.map((m) => pick(m, ["channel_id", "ts", "thread_ts", "role", "author_user_id", "author_external", "is_dd_post", "dd_paths",
      "reasons", "triage_state", "edited_ts", "responded_ts"])),
    items: t.exec_slack_items.map((i) => ({ ...pick(i, ["channel_id", "ts", "kind"]), has_excerpt: i.excerpt !== null && i.excerpt !== undefined,
      source_class: i.source_class ?? null, responded_ts: i.responded_ts ?? null })),
    threads: t.exec_slack_threads.map((x) => pick(x, ["channel_id", "thread_ts", "he_posted_ts"])),
    markers: t.exec_slack_deleted.map((x) => pick(x, ["channel_id", "ts", "reason"])),
    purgeLog: t.exec_slack_purge_log.map((x) => pick(x, ["scope", "channel_id", "ts", "reason"])),
    attention: t.exec_attention_items.map((a) => a.fingerprint),
    jobs: t.exec_jobs.map((j) => ({ kind: j.kind, lane: j.lane, has_principal: j.principal_id !== null && j.principal_id !== undefined, payload: j.payload,
      dedupe_key: j.dedupe_key ?? null, max_attempts: j.max_attempts }))
  };
  const s = JSON.stringify(snapshot).split(PID).join("<p>");
  return JSON.parse(s.replace(/:m[0-9]{6,}/g, ":m*").replace(/:h[0-9]{5,}/g, ":h*").replace(/(slack-home:[^:"]+:[^:"]+:)[0-9]+/g, "$1*")) as Json;
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v as Json).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Json)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** What changed: rows added and removed per table, the installation only when it changed. */
function diffEffects(before: Json, after: Json): Json {
  const out: Json = {};
  const added: Json = {};
  const removed: Json = {};
  for (const k of Object.keys(after)) {
    if (k === "installation") {
      if (canon(before[k]) !== canon(after[k])) out.installation = after[k];
      continue;
    }
    const b = new Map(((before[k] as unknown[]) ?? []).map((x) => [canon(x), x]));
    const a = new Map(((after[k] as unknown[]) ?? []).map((x) => [canon(x), x]));
    const plus = [...a.keys()].filter((x) => !b.has(x)).sort().map((x) => a.get(x));
    const minus = [...b.keys()].filter((x) => !a.has(x)).sort().map((x) => b.get(x));
    if (plus.length) added[k] = plus;
    if (minus.length) removed[k] = minus;
  }
  out.added = added;
  out.removed = removed;
  return out;
}

/** The store's answer for v2's JSON (acceptEventV2 keeps exactly these keys). */
function storeAnswer(raw: Json): Json {
  if (raw.outcome === "duplicate") return { outcome: "duplicate", path: raw.path };
  const a: Json = { outcome: raw.outcome, decision: raw.decision, reason: raw.reason ?? null, path: raw.path };
  for (const k of ["recorded", "enqueued", "interactive"]) if (typeof raw[k] === "boolean") a[k] = raw[k];
  return a;
}

const lastV2Answer = async (): Promise<unknown> => {
  const results = vi.mocked(acceptEventV2).mock.results;
  return results.length === 0 ? undefined : await results[results.length - 1].value;
};

beforeEach(() => {
  useEnv();
  gate.__resetGateCacheForTests();
  out = captureConsole();
  vi.mocked(ensureExecRuntime).mockReset();
  vi.mocked(kickInteractive).mockReset();
  vi.mocked(notifyOps).mockReset().mockResolvedValue(false);
  vi.mocked(acceptEvent).mockClear();
  vi.mocked(acceptEventV2).mockClear();
  vi.mocked(ingestFactsForRpc).mockClear();
  vi.mocked(deriveIngestFacts).mockClear();
  fetchSpy = vi.fn(async () => {
    throw new TypeError("no network in this test");
  });
  vi.stubGlobal("fetch", fetchSpy);
  useDb(seedFor({}));
});

afterEach(() => {
  // V234 / §0.3 rule 4: nothing from an envelope's text, blocks, attachments, files or previous_message reaches a log line.
  out.assertClean();
  // V229: the ack path never calls Slack, Anthropic or anything else over the network.
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("V201-V244: the V2 decision table through the real route (fixtures/slack-gate.json)", () => {
  it("the table is the shared one (≥ 90 rows, unique names, each naming an envelope)", () => {
    expect(GATE.rows.length).toBeGreaterThanOrEqual(90);
    expect(new Set(GATE.rows.map((r) => r.name)).size).toBe(GATE.rows.length);
    for (const r of GATE.rows) expect(INGEST.rows.some((x) => x.name === r.ingest), r.name).toBe(true);
  });

  for (const row of GATE.rows) {
    it(row.name, async () => {
      const db = useDb(seedFor(row));
      const before = effects(db);
      const env = ingestRow(row.ingest).envelope;
      const first = await post(env, row.retry ?? 0);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("");
      let res = first;
      if (row.send === "twice") res = await post(env, 1);
      if (row.send === "again") res = await post({ ...env, event_id: `${String(env.event_id)}X` }, 0);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      // The same rows as the SQL leaves (RQ12) and the fake leaves when called directly (RQ13).
      const got = diffEffects(before, effects(db));
      const want = { ...row.expect };
      delete want.answer;
      expect(got).toEqual(want);
      // The route got v2's answer through the store.
      expect(await lastV2Answer()).toEqual(storeAnswer(row.expect.answer as Json));

      // V229: one RPC per request that reaches the database (v2: P6's events go to v1 inside it), nothing else.
      const sends = row.send === "twice" || row.send === "again" ? 2 : 1;
      expect(db.calls.map((c) => [c.kind, c.target])).toEqual(Array.from({ length: sends }, () => ["rpc", "exec_slack_accept_event_v2"]));
      expect(acceptEvent).not.toHaveBeenCalled();
      // Step 8: the interactive lane is kicked exactly when v2 enqueued interactive work (the fixture's answer is the last send's).
      if (sends === 1) expect(vi.mocked(kickInteractive).mock.calls.length).toBe((row.expect.answer as Json).interactive === true ? 1 : 0);

      // V234: v2's arguments are references and flags (§2.4); no Slack text, token or name in them, the log or the answer.
      assertNoSlackText({ calls: db.calls.map((c) => c.payload), added: got.added }, { label: row.name });
      const line = lines().at(-1) ?? "";
      expect(line).toMatch(/ path=v[12]$/);
    });
  }
});

describe("V228 a malformed p_ingest raises in v2; no real envelope can produce one", () => {
  it.each<[string, Json]>([
    ["an unknown key", { kind: "msg", conv: "channel", ts: "1794150001.000101", author: "U0JANE", is_bot: false, auth_user: "U0MITCH", auth_is_bot: false, text: "x" }],
    ["a 300-character name", { kind: "lifecycle", lc: "rename", name: "a".repeat(300), auth_user: "U0MITCH", auth_is_bot: false }],
    ["len 5", { kind: "msg", conv: "channel", ts: "1794150001.000101", len: 5, is_bot: false, auth_user: "U0MITCH", auth_is_bot: false }],
    ["a mention that isn't a user id", { kind: "msg", conv: "channel", ts: "1794150001.000101", mentions: ["here"], is_bot: false, auth_user: "U0MITCH", auth_is_bot: false }]
  ])("%s → the RPC raises → 500 (Slack retries), nothing written", async (_label, ingest) => {
    const db = useDb(seedFor({}));
    const before = effects(db);
    vi.mocked(ingestFactsForRpc).mockReturnValueOnce(ingest);
    const env = ingest.kind === "lifecycle" ? envelopeOf("IG19 / V226 channel_rename: a plain rename") : envelopeOf("IG02 an explicit mention of him");
    const res = await post(env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(res.headers.get("x-slack-no-retry")).toBeNull();
    expect(diffEffects(before, effects(db))).toEqual({ added: {}, removed: {} });
    // The failing RPC is named on the line (v2 here).
    expect(lines().at(-1)).toMatch(/events failed reason=store(_[a-z0-9]+)? .* path=v2$/);
  });

  /** §2.4 / exec_slack_ingest_check, restated: the keys, types and patterns v2 accepts. */
  const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
  const USER = /^[UW][A-Z0-9]{2,30}$/;
  const CHECK: Record<string, (v: unknown) => boolean> = {
    kind: (v) => ["msg", "edit", "delete", "lifecycle"].includes(v as string),
    conv: (v) => ["channel", "group", "im", "mpim"].includes(v as string),
    lc: (v) => ["created", "rename", "archive", "unarchive", "deleted", "left", "shared", "unshared", "id_changed"].includes(v as string),
    ts: (v) => typeof v === "string" && TS.test(v), thread_ts: (v) => typeof v === "string" && TS.test(v),
    edited_ts: (v) => typeof v === "string" && TS.test(v), deleted_ts: (v) => typeof v === "string" && TS.test(v),
    author: (v) => typeof v === "string" && USER.test(v), parent_user: (v) => typeof v === "string" && USER.test(v),
    auth_user: (v) => typeof v === "string" && USER.test(v),
    author_team: (v) => typeof v === "string" && /^[TE][A-Z0-9]{2,30}$/.test(v),
    app_id: (v) => typeof v === "string" && /^A[A-Z0-9]{2,30}$/.test(v),
    new_channel: (v) => typeof v === "string" && /^[CGD][A-Z0-9]{2,30}$/.test(v),
    name: (v) => typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(v),
    is_bot: (v) => typeof v === "boolean", dd_template: (v) => typeof v === "boolean", broadcast: (v) => typeof v === "boolean",
    question: (v) => typeof v === "boolean", files: (v) => typeof v === "boolean", ext_shared: (v) => typeof v === "boolean",
    auth_is_bot: (v) => typeof v === "boolean", is_ext_shared: (v) => typeof v === "boolean",
    len: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3,
    hints: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 7,
    mentions: (v) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && USER.test(x)),
    dd_paths: (v) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && x.length <= 400 && x.startsWith("/"))
  };

  it("property: ingestFactsForRpc of every fixture envelope (slack-ingest.json and P6's routing table) passes the check", () => {
    const envelopes = [...INGEST.rows.map((r) => r.envelope), ...routingRows().map((r) => r.envelope)];
    let checked = 0;
    for (const env of envelopes) {
      const d = deriveIngestFacts(env);
      if (d === null) continue;
      const ingest = ingestFactsForRpc(d.facts);
      expect(typeof ingest.kind).toBe("string");
      for (const [k, v] of Object.entries(ingest)) {
        expect(Object.prototype.hasOwnProperty.call(CHECK, k), `key ${k}`).toBe(true);
        if (v !== null) expect(CHECK[k](v), `${k} of ${String(env.event_id)}`).toBe(true);
      }
      assertNoSlackText(ingest, { label: String(env.event_id) });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(80);
  });
});

describe("V230 the pre-DB filter (C3): every drop is a 200 with no database call", () => {
  const drops = INGEST.rows.filter((r) => typeof r.expectPrefilter === "string" && r.expectPrefilter !== "pass");
  it("the fixture holds the drops", () => {
    expect(new Set(drops.map((r) => r.expectPrefilter))).toEqual(new Set(["hidden", "bot_no_mention", "edit_noop", "noise_subtype"]));
  });
  for (const r of drops) {
    it(`${r.name}`, async () => {
      const db = useDb(seedFor({}));
      const res = await post(r.envelope);
      expect(res.status).toBe(200);
      expect(db.calls).toEqual([]);
      expect(acceptEventV2).not.toHaveBeenCalled();
      expect(ensureExecRuntime).not.toHaveBeenCalled();
      expect(lines()).toEqual([`[exec-slack] events dropped reason=${r.expectPrefilter} event=${String(r.envelope.event_id)} type=message retry=0 path=-`]);
    });
  }

  it("a delete and a tombstone in Slack's recorded shape (hidden: true) are never dropped as hidden or bot_no_mention", async () => {
    for (const name of ["IG08 message_deleted", "IG21 / V243 a thread parent's tombstone", "IG09b a message_deleted whose previous message is a bot's"]) {
      vi.mocked(acceptEventV2).mockClear();
      useDb(seedFor({}));
      expect((await post(envelopeOf(name))).status).toBe(200);
      expect(acceptEventV2).toHaveBeenCalledTimes(1);
    }
  });
});

describe("V229 the ack path's calls (integrator)", () => {
  it("V229 one RPC (v2) for a reading event that reaches the database, none for a pre-DB drop; no Slack, model or network call", async () => {
    const db = useDb(seedFor({}));
    expect((await post(envelopeOf("IG02 an explicit mention of him"))).status).toBe(200);
    expect(db.calls.map((c) => [c.kind, c.target])).toEqual([["rpc", "exec_slack_accept_event_v2"]]);
    const drop = INGEST.rows.find((r) => r.expectPrefilter === "noise_subtype");
    if (!drop) throw new Error("no noise_subtype row");
    const db2 = useDb(seedFor({}));
    expect((await post(drop.envelope)).status).toBe(200);
    expect(db2.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("V231 a warm gate snapshot drops before any database call (C3, C43)", () => {
  /** Loads the snapshot from the seeded database, then clears the call log. */
  async function warm(db: FakeSlackReadDb): Promise<gate.GateSnapshot> {
    gate.noteEventSeen();
    expect(await gate.refreshGateCache()).toBe("refreshed");
    db.calls.length = 0;
    const s = gate.gateSnapshot();
    expect(s).not.toBeNull();
    return s!;
  }
  const msgIn = (channel: string, type = "channel") => envelopeOf("IG02 an explicit mention of him", (e) => Object.assign(e.event as Json, { channel, channel_type: type }));
  const editIn = (channel: string, type = "channel") => envelopeOf("IG07 message_changed", (e) => Object.assign(e.event as Json, { channel, channel_type: type }));
  const deleteIn = (channel: string, type = "channel") => envelopeOf("IG08 message_deleted", (e) => Object.assign(e.event as Json, { channel, channel_type: type }));
  const archiveOf = (channel: string) => envelopeOf("IG19 channel_archive", (e) => Object.assign(e.event as Json, { channel }));

  it("a deny conversation: a message, an edit, a delete and a lifecycle event → 200 drop deny, no RPC", async () => {
    const db = useDb(seedFor({}));
    expect((await warm(db)).dropClasses.get("G0BPVOB")).toBe("deny");
    for (const env of [msgIn("G0BPVOB", "group"), editIn("G0BPVOB", "group"), deleteIn("G0BPVOB", "group"), archiveOf("G0BPVOB")]) {
      const res = await post(env);
      expect(res.status).toBe(200);
      expect(lines().at(-1)).toContain("dropped reason=deny");
      expect(lines().at(-1)).toMatch(/ path=-$/);
    }
    expect(db.calls).toEqual([]);
    expect(acceptEventV2).not.toHaveBeenCalled();
  });

  it("an unclassified conversation (fixer correctness-9): a new message, a delete, an edit and a lifecycle event all reach v2 (the snapshot may predate its classification); v2 drops the message as unclassified", async () => {
    const db = useDb(seedFor({}));
    expect((await warm(db)).dropClasses.get("C0RESET")).toBe("unclassified");
    expect((await post(msgIn("C0RESET"))).status).toBe(200);
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
    expect(lines().at(-1)).toContain("dropped reason=unclassified");   // v2's own drop, after the RPC
    for (const env of [deleteIn("C0RESET"), editIn("C0RESET"), archiveOf("C0RESET")]) expect((await post(env)).status).toBe(200);
    expect(rpcCalls()).toEqual(Array(4).fill("exec_slack_accept_event_v2"));
  });

  it.each<[string, Partial<FakeSlackReadDbSeed> & { state: Json }]>([
    ["the switch off", { state: { settings: { slack_reading_enabled: false } } }],
    ["a discovery in progress (discovered_at null)", { state: { installation: { reading: "discovering" } } }]
  ])("reading not on (%s): a new message → not_reading before any RPC; a delete, an edit and a lifecycle event reach v2", async (_label, seed) => {
    const db = useDb(seedFor(seed));
    const s = await warm(db);
    expect([s.readingHalfLive, s.readingOn]).toEqual([true, false]);
    await post(msgIn("C0GENERAL"));
    expect(lines().at(-1)).toContain("dropped reason=not_reading");
    expect(rpcCalls()).toEqual([]);
    for (const env of [deleteIn("C0GENERAL"), editIn("C0GENERAL"), archiveOf("C0GENERAL")]) expect((await post(env)).status).toBe(200);
    expect(rpcCalls()).toHaveLength(3);
  });

  it("no live reading half: every reading kind → not_reading, no RPC; the assistant DM and a bot-authorized event still reach it", async () => {
    const db = useDb(seedFor({ state: { installation: { reading: "none" } } }));
    const s = await warm(db);
    expect([s.readingHalfLive, s.readingOn, s.assistantDmChannelIds.has("D0MITCH")]).toEqual([false, false, true]);
    for (const env of [msgIn("C0GENERAL"), editIn("C0GENERAL"), deleteIn("C0GENERAL"), archiveOf("C0GENERAL"), msgIn("D0JANE", "im")]) {
      expect((await post(env)).status).toBe(200);
      expect(lines().at(-1)).toContain("dropped reason=not_reading");
    }
    expect(rpcCalls()).toEqual([]);
    // The assistant DM is never the gate's: v2 hands it to v1, which answers reply.
    await post(envelopeOf("V201 his DM to the assistant"));
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
    expect(lines().at(-1)).toContain("accepted reason=reply");
    expect(lines().at(-1)).toMatch(/ path=v1$/);
    // An event Slack authorized for the bot (only P6's DM chat could use one) goes to the RPC, which drops it.
    await post(envelopeOf("V210 an event only the bot sees"));
    expect(rpcCalls()).toHaveLength(2);
    expect(lines().at(-1)).toContain("dropped reason=not_reading");
    expect(lines().at(-1)).toMatch(/ path=v2$/);
  });

  it("V201 (integrator) his DM to the assistant with a warm snapshot, reading on or off: never the gate's; v2 hands it to v1 (reply)", async () => {
    for (const state of [{}, { settings: { slack_reading_enabled: false } }, { installation: { reading: "none" } }]) {
      gate.__resetGateCacheForTests();
      const db = useDb(seedFor({ state }));
      await warm(db);
      expect((await post(envelopeOf("V201 his DM to the assistant"))).status).toBe(200);
      expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
      expect(lines().at(-1)).toContain("accepted reason=reply");
    }
  });

  it("reading on: a watched channel's message and an unknown channel's message reach v2 (no class to drop on)", async () => {
    const db = useDb(seedFor({}));
    await warm(db);
    await post(msgIn("C0GENERAL"));
    await post(envelopeOf("V212 a message in an unknown channel"));
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2", "exec_slack_accept_event_v2"]);
  });

  it("every reading event notes itself (the refresh keeps running while events flow); P6's own events don't", async () => {
    useDb(seedFor({}));
    expect(await gate.refreshGateCache()).toBe("skipped");
    await post(envelopeOf("V202 app_home_opened"));
    expect(await gate.refreshGateCache()).toBe("skipped");
    await post(envelopeOf("IG02 an explicit mention of him"));
    expect(await gate.refreshGateCache()).toBe("refreshed");
  });
});

describe("V232 a cold or stale snapshot sends the event to v2, which drops it without writing", () => {
  it("cold (never loaded): a deny conversation's message reaches v2 → drop deny, nothing written", async () => {
    const db = useDb(seedFor({}));
    const before = effects(db);
    await post(envelopeOf("V213 a message in a deny (lead) channel"));
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
    expect(await lastV2Answer()).toMatchObject({ outcome: "accepted", decision: "drop", reason: "deny", recorded: false });
    expect(diffEffects(before, effects(db))).toEqual({ added: {}, removed: {} });
  });

  it("stale (loaded more than 5 minutes ago): the same", async () => {
    const db = useDb(seedFor({}));
    const past = Date.now() - 6 * MIN;
    gate.noteEventSeen(past);
    expect(await gate.refreshGateCache(new Date(past))).toBe("refreshed");
    expect(gate.gateSnapshot()).toBeNull();
    db.calls.length = 0;
    const before = effects(db);
    await post(envelopeOf("V213 a message in a deny (lead) channel"));
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
    expect(diffEffects(before, effects(db))).toEqual({ added: {}, removed: {} });
  });
});

describe("V233 P6's routing table through v2", () => {
  // §1.4 #5: these shapes are bot or hidden noise, dropped by the pre-DB filter.
  const PREFILTERED: Readonly<Record<string, string>> = { "05": "bot_no_mention", "06": "bot_no_mention", "10": "hidden", "11": "hidden" };
  // A message outside every active assistant DM is a reading event under P7a: with no reading half, v2 answers
  // not_reading and records nothing (C6). P6 recorded these as v1 drops (other_channel, not_installed).
  const READING_PATH: Readonly<Record<string, string>> = { "03": "not_reading", "04": "not_reading", "19": "not_reading", "20": "not_reading" };

  for (const r of routingRows()) {
    const n = r.name.slice(0, 2);
    it(`V233 ${r.name}`, async () => {
      const inst = r.installation === "owner" ? [installationRow()] : r.installation === "revoked"
        ? [installationRow({ bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "app_uninstalled", purged_at: "2026-11-02T00:05:00.000Z" })]
        : [];
      const db = useDb(createFakeSlackReadDb({ now: () => new Date(), tables: { exec_slack_installations: inst } }));
      const res = await post(r.envelope, 2);
      expect(res.status).toBe(200);
      const routeLevel = PREFILTERED[n] ?? (r.expect.routeLevel as string | undefined);
      if (routeLevel) {
        expect(db.calls).toEqual([]);
        expect(lines()[0]).toContain(`dropped reason=${routeLevel}`);
        return;
      }
      expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
      const answer = (await lastV2Answer()) as Json;
      if (READING_PATH[n]) {
        expect(answer).toMatchObject({ outcome: "accepted", decision: "drop", reason: READING_PATH[n], path: "v2", recorded: false });
        expect(db.tables.exec_slack_events).toEqual([]);
        expect(db.tables.exec_jobs).toEqual([]);
        return;
      }
      // Every other row: v1's exact decision, reason and jobs, through v2 (path v1).
      expect(answer).toMatchObject({ outcome: "accepted", decision: r.expect.decision, reason: r.expect.reason ?? null, path: "v1" });
      const [ev] = db.tables.exec_slack_events;
      expect(ev).toMatchObject({ event_id: r.envelope.event_id, decision: r.expect.decision, drop_reason: r.expect.reason ?? null });
      const enqueuedInteractive = r.expect.decision === "reply" || r.expect.decision === "home";
      expect(vi.mocked(kickInteractive).mock.calls.length).toBe(enqueuedInteractive ? 1 : 0);
    });
  }
});

describe("V234 Slack text never leaves the route", () => {
  it("sentinels in text, blocks, attachments, files[].name and previous_message: absent from every log line, RPC argument and response", async () => {
    const S = SLACK_TEXT_SENTINELS;
    const db = useDb(seedFor({}));
    const msg = envelopeOf("V221 a DM to him (len 2)", (e) => Object.assign(e.event as Json, {
      text: `<@U0MITCH> ${S.text} ${S.ddText}`,
      blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: S.text }, { type: "text", text: S.excerpt }] }] }],
      attachments: [{ text: S.summary, fallback: S.dueText, title: S.topic }],
      files: [{ id: "F0FILE", name: S.fileName, title: S.fileName }],
      user_profile: { real_name: S.authorName, display_name: S.authorName }
    }));
    const edit = envelopeOf("IG07 message_changed");
    const del = envelopeOf("IG08 message_deleted");
    const responses: Response[] = [];
    for (const env of [msg, edit, del]) responses.push(await post(env));
    const bodies = await Promise.all(responses.map((r) => r.text()));
    assertNoSlackText({ calls: db.calls.map((c) => c.payload), bodies, headers: responses.map((r) => [...r.headers]), events: db.tables.exec_slack_events,
      messages: db.tables.exec_slack_messages, jobs: db.tables.exec_jobs }, { label: "V234" });
    expect(JSON.stringify(db.calls.map((c) => c.payload))).not.toContain("SENTINEL");
  });
});

describe("V235 / V236 shapes and the 2 s budget", () => {
  it("V235 channel_type absent → conv omitted → v2 drops scope (no throw, 200)", async () => {
    useDb(seedFor({}));
    const res = await post(envelopeOf("V235 channel_type absent"));
    expect(res.status).toBe(200);
    expect(await lastV2Answer()).toMatchObject({ decision: "drop", reason: "scope" });
  });

  it("V236 v2 slower than 2 s → 500 by ~2 s, the controller aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const db = useDb(seedFor({}, { before: (call) => (call.kind === "rpc" ? new Promise((r) => setTimeout(r, 60_000)) : undefined) }));
    let settled: Response | null = null;
    const pending = post(envelopeOf("IG02 an explicit mention of him")).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(1_990);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(settled!.status).toBe(500);
    const signal = vi.mocked(acceptEventV2).mock.calls[0][2].signal;
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    expect(lines().at(-1)).toMatch(/events failed reason=timeout .* path=v2$/);
    expect(db.tables.exec_slack_events).toEqual([]);
  });

  it("V236 v2 answering v2_missing, then v1 answering: 200 within the same controller (one signal for both calls)", async () => {
    const db = useDb(seedFor({}, { missing: ["exec_slack_accept_event_v2"] }));
    const res = await post(envelopeOf("V201 his DM to the assistant"));
    expect(res.status).toBe(200);
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2", "exec_slack_accept_event"]);
    const [v2call, v1call] = db.calls.filter((c) => c.kind === "rpc");
    expect(v2call.signal).toBeInstanceOf(AbortSignal);
    expect(v1call.signal).toBe(v2call.signal);
    expect(lines().at(-1)).toMatch(/accepted reason=reply .* path=v1 v2=missing$/);
  });

  it("the fact derivation throwing (it never should) sends the event down P6's path: v2 with no reading facts, v1 drops it", async () => {
    const db = useDb(seedFor({}));
    vi.mocked(deriveIngestFacts).mockImplementationOnce(() => {
      throw new Error(SLACK_TEXT_SENTINELS.text);
    });
    const res = await post(envelopeOf("IG02 an explicit mention of him"));
    expect(res.status).toBe(200);
    expect(vi.mocked(acceptEventV2).mock.calls[0][1]).toBeNull();
    expect(await lastV2Answer()).toMatchObject({ outcome: "accepted", decision: "drop", reason: "other_channel", path: "v1" });
    expect(rpcCalls()).toEqual(["exec_slack_accept_event_v2"]);
    expect(db.tables.exec_slack_messages).toEqual([]);
  });

  it("an RPC error → 500 store_<code> (retried by Slack), no kick", async () => {
    useDb(createFakeSlackReadDb({ fail: (c) => (c.kind === "rpc" ? { code: "53300", message: "too many connections" } : null) }));
    const res = await post(envelopeOf("IG02 an explicit mention of him"));
    expect(res.status).toBe(500);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(lines().at(-1)).toContain("events failed reason=store_53300");
  });
});

// ---------------------------------------------------------------------------
// FB01-FB05: a P6-only database (P6's fake: no v2, no P7a schema)

describe("FB01-FB05 the fallback to P6's v1 (C4, C48)", () => {
  const p6Db = () => useDb(createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] } }));
  const hisDm = () => envelopeOf("V201 his DM to the assistant");

  it("FB01 his DM still gets reply and exactly one job; the route marked v2 absent", async () => {
    const db = p6Db();
    const res = await post(hisDm());
    expect(res.status).toBe(200);
    expect(db.calls.map((c) => [c.kind, c.target])).toEqual([["rpc", "exec_slack_accept_event_v2"], ["rpc", "exec_slack_accept_event"]]);
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.lane])).toEqual([["exec.slack-reply", "interactive"]]);
    expect(db.tables.exec_slack_events.map((e) => e.decision)).toEqual(["reply"]);
    expect(kickInteractive).toHaveBeenCalledTimes(1);
    expect(gate.v2CachedAbsent()).toBe(true);
    expect(lines()).toEqual([`[exec-slack] events accepted reason=reply event=${String(hisDm().event_id)} type=message retry=0 path=v1 v2=missing`]);
  });

  it("FB02 within the next 5 minutes the route calls v1 directly (one RPC call)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = p6Db();
    await post(hisDm());
    db.calls.length = 0;
    vi.setSystemTime(Date.now() + 5 * MIN - 1_000);
    await post({ ...hisDm(), event_id: "Ev0P7AFB0201" });
    expect(db.calls.map((c) => [c.kind, c.target])).toEqual([["rpc", "exec_slack_accept_event"]]);
    expect(lines().at(-1)).toMatch(/ path=v1$/);
  });

  it("FB03 after 5 minutes it tries v2 again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = p6Db();
    await post(hisDm());
    db.calls.length = 0;
    vi.setSystemTime(Date.now() + 5 * MIN);
    await post({ ...hisDm(), event_id: "Ev0P7AFB0301" });
    expect(db.calls.map((c) => c.target)).toEqual(["exec_slack_accept_event_v2", "exec_slack_accept_event"]);
  });

  it("FB04 with v2 absent, a reading event gets v1's other_channel drop row (no crash, no 500)", async () => {
    const db = p6Db();
    gate.markV2Absent();
    const res = await post(envelopeOf("IG02 an explicit mention of him"));
    expect(res.status).toBe(200);
    expect(db.calls.map((c) => c.target)).toEqual(["exec_slack_accept_event"]);
    expect(db.tables.exec_slack_events.map((e) => [e.decision, e.drop_reason])).toEqual([["drop", "other_channel"]]);
    // The same through the fallback itself (v2 asked first).
    gate.__resetGateCacheForTests();
    const res2 = await post({ ...envelopeOf("IG08 message_deleted"), event_id: "Ev0P7AFB0401" });
    expect(res2.status).toBe(200);
    expect(db.tables.exec_slack_events.map((e) => [e.decision, e.drop_reason])).toEqual([["drop", "other_channel"], ["drop", "other_channel"]]);
  });

  it("FB05 v2 missing while the P7a schema is ready → one ops alert at the next refresh, the flag set, the System card's v2Missing true", async () => {
    useDb(seedFor({}, { missing: ["exec_slack_accept_event_v2"] }));
    expect((await post(hisDm())).status).toBe(200);
    expect(gate.v2CachedAbsent()).toBe(true);
    expect(notifyOps).not.toHaveBeenCalled();   // never on the ack path
    expect(gate.v2MissingWithSchemaAt()).toBeNull();
    await gate.refreshGateCache();
    expect(notifyOps).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(notifyOps).mock.calls[0][0];
    expect(alert.key).toBe("exec-slack-v2-missing");
    expect(alert.title).toBe("Executive Assistant: Slack reading events are falling back to P6");
    expect(`${alert.title} ${alert.detail}`).not.toMatch(/esi_|ep_|U0|D0|C0|T0/);
    expect(gate.v2MissingWithSchemaAt()).not.toBeNull();
    await gate.refreshGateCache();
    expect(notifyOps).toHaveBeenCalledTimes(1);
    const summary = await slackSystemSummary(P);
    expect(summary?.reading?.v2Missing).toBe(true);
    expect(out.calls().flat().map(String).some((l) => l.includes("v2 answered function-not-found") && l.includes("v2_missing"))).toBe(true);
  });

  it("FB05 a real P6-only database (no v2, no P7a columns) → no alarm", async () => {
    // P6's fake answers a limit-0 select of an unknown column with no rows instead of 42703 (it only checks projected
    // rows), so the P7a schema check reads it as ready; the read fake with the reading columns missing models the real
    // P6-only database here (PostgREST answers 42703 for the column whatever the limit).
    useDb(createFakeSlackReadDb({
      now: () => new Date(),
      tables: { exec_slack_installations: [installationRow()] },
      missing: ["exec_slack_accept_event_v2", "exec_slack_installations.reading_state"]
    }));
    await post(hisDm());
    expect(gate.v2CachedAbsent()).toBe(true);
    await gate.refreshGateCache();
    expect(notifyOps).not.toHaveBeenCalled();
    expect(gate.v2MissingWithSchemaAt()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integrator (stage 2): V220 as §5.3 states it (the IG20 candidate-reason table through v2, the twin rule), and V222's
// receipt-minute bucket (G21). Both run the real store's acceptEventV2 over fake-slack-read-db.ts; the SQL twins are
// "RQ12 V220 (integrator)" and "RQ12 V222 (integrator)" in the SQL suite.

type ReasonRow = { name: string; input: { conv: "im" | "mpim" | "channel" | "group"; len: 0 | 1 | 2 | 3; question: boolean; mentionsHim: boolean;
  isReply: boolean; parentIsHim: boolean; hePostedInThread: boolean }; expect: number };
const REASON_TABLE = (INGEST as unknown as { candidateReasons: ReasonRow[] }).candidateReasons;
const CONV_CHANNEL: Record<ReasonRow["input"]["conv"], string> = { im: "D0JANE", mpim: "G0MPIM", channel: "C0GENERAL", group: "G0PRIV" };
const PARENT_TS = "1794149000.000100";

/** One v2 call for an IG20 input: the IG02 envelope's facts, re-pointed at the row's conversation and ts. */
async function v2For(row: ReasonRow, n: number, broadcast: boolean): Promise<{ db: FakeSlackReadDb; ts: string; answer: Json }> {
  const ch = CONV_CHANNEL[row.input.conv];
  const ts = `17941500${String(10 + n).padStart(2, "0")}.00020${broadcast ? 1 : 0}`;
  const threads = row.input.hePostedInThread ? [{ channel: ch, thread_ts: PARENT_TS, he_posted_ts: "1794149001.000100" }] : [];
  const db = useDb(seedFor({ state: { threads } }));
  const env = envelopeOf("IG02 an explicit mention of him", (e) => {
    e.event_id = `Ev0P7AV220${String(n).padStart(2, "0")}${broadcast ? "B" : "A"}`;
    const ev = e.event as Json;
    ev.channel = ch;
    ev.channel_type = row.input.conv === "group" ? "group" : row.input.conv;
    ev.ts = ts;
    if (row.input.isReply) ev.thread_ts = PARENT_TS;
  });
  const parsed = parseEventEnvelope(env, null);
  if (parsed.kind !== "event_callback") throw new Error("not an event");
  const ingest: Json = {
    kind: "msg", conv: row.input.conv, ts, author: "U0JANE", is_bot: false, auth_user: "U0MITCH", auth_is_bot: false, len: row.input.len,
    question: row.input.question, mentions: row.input.mentionsHim ? ["U0MITCH"] : [], broadcast, author_team: "T0SCALED",
    ...(row.input.isReply ? { thread_ts: PARENT_TS, parent_user: row.input.parentIsHim ? "U0MITCH" : "U0BOB" } : {})
  };
  const r = await acceptEventV2(parsed.facts, ingest, { signal: new AbortController().signal });
  return { db, ts, answer: r as unknown as Json };
}

describe("V220 (integrator) the IG20 candidate-reason table through v2 (the twin rule)", () => {
  it("the table is the fixture's 16 rows", () => {
    expect(REASON_TABLE).toHaveLength(16);
  });
  REASON_TABLE.forEach((row, n) => {
    it(`V220 ${row.name}: v2's reasons equal candidateReasons; a broadcast never counts as a mention`, async () => {
      for (const broadcast of [false, true]) {
        const { db, ts, answer } = await v2For(row, n, broadcast);
        const msg = db.tables.exec_slack_messages.find((m) => m.ts === ts);
        if (row.expect === 0) {
          expect(answer, `${row.name} broadcast=${broadcast}`).toMatchObject({ outcome: "accepted", decision: "drop", reason: "not_addressed" });
          expect(msg).toBeUndefined();
        } else {
          expect(answer, `${row.name} broadcast=${broadcast}`).toMatchObject({ outcome: "accepted", decision: "ingest", reason: "candidate" });
          expect(msg?.reasons, `${row.name} broadcast=${broadcast}`).toBe(row.expect);
        }
      }
    });
  });
});

describe("V222 (integrator) the triage bucket is the receipt minute (G21)", () => {
  it("V222 a mention whose message ts is hours older than its receipt: the triage key carries the receipt minute, not the message's", async () => {
    const row = REASON_TABLE.find((r) => r.input.conv === "channel" && r.input.mentionsHim && !r.input.isReply);
    if (!row) throw new Error("no channel mention row");
    const before = Math.floor(Date.now() / MIN);
    const { db, ts } = await v2For(row, 40, false);
    const after = Math.floor(Date.now() / MIN);
    const job = db.tables.exec_jobs.find((j) => j.kind === "exec.slack-triage");
    const minute = Number(/:m([0-9]+)$/.exec(String(job?.dedupe_key))?.[1]);
    expect(minute).toBeGreaterThanOrEqual(before);
    expect(minute).toBeLessThanOrEqual(after);
    expect(minute).not.toBe(Math.floor(Number(ts.split(".")[0]) / 60));
  });
});
