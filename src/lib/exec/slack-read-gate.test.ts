import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { assertNoSlackText } from "@/lib/exec/__tests__/slack-read-assert";

// P7a contract §5.3 V2xx and §5.13 RQ13 (Area A; AM-P7a-16): the V2 gate decision table (fixtures/slack-gate.json)
// through fake-slack-read-db.ts's mirror of exec_slack_accept_event_v2. The SQL suite's RQ12 runs the same rows
// through the migration on PGlite, PG15 and PG17 (<sp>/p7a-sql/tests/lib/slack-gate.mjs, the same state keys and the
// same normalization), so the fake and the SQL both equal the fixture (the RT-F pattern) and can't drift apart.

type Json = Record<string, unknown>;
const FIXTURES = new URL("./__tests__/fixtures/", import.meta.url);
const GATE = JSON.parse(readFileSync(new URL("slack-gate.json", FIXTURES), "utf8")) as {
  base: Json & { installationId: string; installation: Json; settings: Json; ddBot: Json; optouts: string[]; fb: Json[] };
  rows: { name: string; ingest: string; state?: Json; send?: "once" | "twice" | "again"; retry?: number; expect: Json }[];
};
const INGEST = JSON.parse(readFileSync(new URL("slack-ingest.json", FIXTURES), "utf8")) as {
  channels: Record<string, Json>;
  rows: { name: string; envelope: Json; expectFacts?: Json | null; expectDerive?: null; expectChannel?: string }[];
};
const PID = "ep_1";

const str = (v: unknown) => (typeof v === "string" ? v : null);
const present = (o: Json, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

/** The facts the route passes to v1's 20 parameters (P6 slack-suite.mjs factsOf, its twin). */
function factsOf(env: Json, retryNum: number): Json {
  const e = (env.event && typeof env.event === "object" ? env.event : {}) as Json;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const tokens = (e.tokens ?? {}) as Json;
  return {
    p_event_id: env.event_id, p_team_id: env.team_id, p_api_app_id: env.api_app_id, p_event_type: str(e.type), p_event_time: env.event_time,
    p_retry_num: retryNum, p_channel: str(e.channel), p_channel_type: str(e.channel_type), p_user: str(e.user), p_ts: str(e.ts),
    p_thread_ts: str(e.thread_ts), p_has_bot_id: present(e, "bot_id") || present(e, "bot_profile"), p_has_app_id: present(e, "app_id"),
    p_subtype: present(e, "subtype") ? String(e.subtype) : null, p_hidden: e.hidden === true, p_text_is_string: typeof e.text === "string",
    p_has_message: present(e, "message") || present(e, "previous_message"), p_tab: str(e.tab), p_revoked_bot_ids: ids(tokens.bot),
    p_revoked_user_ids: ids(tokens.oauth)
  };
}

/** IngestFacts → p_ingest: nulls omitted, booleans and numbers kept, dd_paths only when non-empty (slack-gate.mjs toIngest). */
function toIngest(f: Json): Json {
  const map: Record<string, string> = {
    kind: "kind", conv: "conv", ts: "ts", threadTs: "thread_ts", editedTs: "edited_ts", deletedTs: "deleted_ts", author: "author",
    authorTeam: "author_team", parentUser: "parent_user", mentions: "mentions", isBot: "is_bot", appId: "app_id", ddTemplate: "dd_template",
    broadcast: "broadcast", question: "question", len: "len", hints: "hints", files: "files", extShared: "ext_shared", authUser: "auth_user",
    authIsBot: "auth_is_bot", lc: "lc", name: "name", newChannel: "new_channel", isExtShared: "is_ext_shared", ddPaths: "dd_paths"
  };
  const out: Json = {};
  for (const [camel, snake] of Object.entries(map)) {
    const v = f[camel];
    if (v === null || v === undefined) continue;
    if (snake === "dd_paths" && (!Array.isArray(v) || v.length === 0)) continue;
    out[snake] = v;
  }
  return out;
}

function gateArgs(row: (typeof GATE.rows)[number], eventId?: string): Json {
  const ing = INGEST.rows.find((r) => r.name === row.ingest);
  if (!ing) throw new Error(`no slack-ingest row ${row.ingest}`);
  const env = { ...ing.envelope, event_id: eventId ?? ing.envelope.event_id };
  const facts = factsOf(env, row.retry ?? 0);
  if (ing.expectFacts && ing.expectFacts.kind === "lifecycle") facts.p_channel = ing.expectChannel;
  const auths = Array.isArray(ing.envelope.authorizations) ? (ing.envelope.authorizations as Json[]) : [];
  const full = ing.expectFacts
    ? { authUser: str(auths[0]?.user_id), authIsBot: auths[0]?.is_bot === true, extShared: ing.envelope.is_ext_shared_channel === true, ...ing.expectFacts }
    : null;
  return { ...facts, p_ingest: ing.expectDerive === null || !full ? null : toIngest(full) };
}

/** The base + the row's state as the fake's seed (slack-gate.mjs gateRows, its twin). */
function seedFor(row: (typeof GATE.rows)[number]): FakeSlackReadDb {
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
    missing: st.fb === "missing" ? ["fb_onboarding"] : [],
    tables: {
      exec_slack_installations: [inst], exec_settings: [settings], exec_slack_channels: channels, exec_slack_messages: messages, exec_slack_items: items,
      exec_slack_threads: threads, exec_slack_deleted: markers, exec_attention_items: attention, exec_slack_author_optouts: optouts, exec_slack_dd_bot: ddBot,
      fb_onboarding: fb
    }
  });
}

/** The normalized snapshot (slack-gate.mjs effectsSql, its twin): the same columns, pid → <p>, time buckets → *. */
function effects(db: FakeSlackReadDb, answer: unknown): Json {
  const t = db.tables;
  const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));
  const inst = [...t.exec_slack_installations].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const snapshot = {
    answer,
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

function diffEffects(before: Json, after: Json): Json {
  const out: Json = { answer: after.answer };
  const added: Json = {};
  const removed: Json = {};
  for (const k of Object.keys(after)) {
    if (k === "answer") continue;
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

async function v2(db: FakeSlackReadDb, args: Json): Promise<unknown> {
  const { data, error } = (await (db.client as { rpc(fn: string, a: Json): PromiseLike<{ data: unknown; error: unknown }> }).rpc("exec_slack_accept_event_v2", args));
  if (error) throw new Error(`v2 failed: ${JSON.stringify(error)}`);
  return data;
}

describe("RQ13: the V2 gate fixture through fake-slack-read-db.ts equals the SQL's expectations", () => {
  it("the fixture is well-formed: every row names an ingest envelope and carries a diff", () => {
    expect(GATE.rows.length).toBeGreaterThanOrEqual(90);
    for (const row of GATE.rows) {
      expect(INGEST.rows.some((r) => r.name === row.ingest), row.name).toBe(true);
      expect(Object.keys(row.expect).sort(), row.name).toEqual(expect.arrayContaining(["added", "answer", "removed"]));
    }
    expect(new Set(GATE.rows.map((r) => r.name)).size).toBe(GATE.rows.length);
  });

  for (const row of GATE.rows) {
    it(row.name, async () => {
      const db = seedFor(row);
      const before = effects(db, null);
      const args = gateArgs(row);
      let answer = await v2(db, args);
      if (row.send === "twice") answer = await v2(db, { ...args, p_retry_num: 1 });
      if (row.send === "again") answer = await v2(db, gateArgs(row, `${String(args.p_event_id)}X`));
      const got = diffEffects(before, effects(db, answer));
      expect(got).toEqual(row.expect);
      // §0.3 rule 4: no Slack text in what the gate wrote (the envelopes carry the sentinels).
      assertNoSlackText({ added: got.added, answer: got.answer, calls: db.calls.map((c) => c.payload) }, { label: row.name });
    });
  }
});
