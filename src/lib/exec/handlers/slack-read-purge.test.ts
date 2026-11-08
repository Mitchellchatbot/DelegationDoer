import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import ingest from "@/lib/exec/__tests__/fixtures/slack-ingest.json";
import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack, slackReadError } from "@/lib/exec/__tests__/fake-slack-api";
import { ITEM_TEXT_KEYS, SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { INST, NOW, PID, PRINCIPAL, TOKEN_KEY, channelDbRow, hex32, installationDbRow, itemDbRow, jobCtx, messageDbRow, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { auditEvent } from "@/lib/exec/audit";
import { sealSecret } from "@/lib/exec/crypto";
import { slackReadPurgeJobHandler, slackReadRecheckJobHandler, slackReadRecheckScheduledWork } from "@/lib/exec/handlers/slack-read-purge";
import { purgeUnpurgedRevocations, slackUninstallJobHandler } from "@/lib/exec/handlers/slack-uninstall";
import { slackUserCheckJobHandler } from "@/lib/exec/handlers/slack-user-check";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { parseEventEnvelope } from "@/lib/exec/slack-events";
import { deriveIngestFacts, ingestFactsForRpc, prefilterIngest } from "@/lib/exec/slack-ingest";
import { acceptEventV2, applyClasses, purgeAuthor, purgeExpiredSlack, userRevoke } from "@/lib/exec/slack-read-store";
import { getSlackReadingState, listOpenSlackItems } from "@/lib/exec/slack-reading";
import { buildTriageWindow } from "@/lib/exec/triage/slack";
import type { SlackReadMessage } from "@/lib/exec/sources/slack";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.9-10, §5.16 RG01-RG05, §5.8 PG07-PG18 (with PG10b), §5.7 DM07 / DM08, §5.10 XC03 / XC04 (Area D): the
// reading purges and the recheck, and the end-to-end purge flows over fake-slack-read-db (the store, v2 and the RPCs for real;
// an event goes through the route's own steps: parseEventEnvelope → deriveIngestFacts → prefilterIngest → acceptEventV2).

type Envelope = Record<string, unknown> & { event: Record<string, unknown> };
const ENVELOPES = new Map((ingest as unknown as { rows: { name: string; envelope: Envelope }[] }).rows.map((r) => [r.name, r.envelope]));
const env = (name: string, over: (e: Envelope) => void = () => {}): Envelope => {
  const e = structuredClone(ENVELOPES.get(name));
  if (!e) throw new Error(`no fixture envelope ${name}`);
  over(e);
  return e;
};
const INST2 = `esi_${hex32(2)}`;
const TS = "1794140000.000100";
let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;

function useDb(tables: Partial<Record<string, Row[]>> = {}, installations: Row[] = [installationDbRow(sealSecret)]): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: tables as never, slack: { tables: { exec_slack_installations: installations } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
/** One reading conversation of his with a candidate, an item and its attention row, plus P6's own rows. */
function seedReading(channelId = "C0GENERAL", over: Row = {}): Partial<Record<string, Row[]>> {
  return {
    exec_slack_channels: [channelDbRow({ channel_id: channelId, ...over })],
    exec_slack_messages: [messageDbRow({ channel_id: channelId, ts: TS, role: "item", triage_state: "assessed" })],
    exec_slack_items: [itemDbRow({ channel_id: channelId, ts: TS })],
    exec_attention_items: [{ id: `ea_${channelId}`, principal_id: PID, source: "slack", fingerprint: `slack:msg:${channelId}:${TS}`, kind: "slack_request", status: "open" }]
  };
}
async function deliver(e: Envelope): Promise<unknown> {
  const parsed = parseEventEnvelope(e, null);
  if (parsed.kind !== "event_callback") throw new Error("not an event_callback");
  const d = deriveIngestFacts(e);
  if (d) {
    const pre = prefilterIngest(e, d.facts);
    if (pre !== "pass") return { dropped: pre };
  }
  const facts = d !== null && d.facts.kind === "lifecycle" ? { ...parsed.facts, channel: d.channel } : parsed.facts;
  return acceptEventV2(facts, d ? ingestFactsForRpc(d.facts) : null, { signal: new AbortController().signal });
}
const P7A = ["exec_slack_channels", "exec_slack_threads", "exec_slack_messages", "exec_slack_items", "exec_slack_deleted"] as const;
const p7aRows = (channelId?: string) => P7A.flatMap((t) => db.tables[t].filter((r) => channelId === undefined || r.channel_id === channelId));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(notifyOps).mockResolvedValue(true);
});
afterEach(() => {
  out.assertClean();
  assertNoSlackText([vi.mocked(auditEvent).mock.calls, vi.mocked(notifyOps).mock.calls, db.tables.exec_slack_purge_log, db.tables.exec_slack_events],
    { label: "audit, ops, outbox, events" });
  assertNoSlackText(db.calls.filter((c) => c.kind === "rpc").map((c) => c.payload), { label: "rpc", ignoreKeys: ITEM_TEXT_KEYS });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("RG01-RG05: exec.slack-read-purge and exec.slack-read-recheck", () => {
  const revoked = (over: Row = {}) => installationDbRow(sealSecret, { reading_state: "revoked", user_token_enc: null, user_key_id: null, user_scopes: [],
    user_revoked_at: "2026-11-07T00:00:00.000Z", user_revoke_reason: "app_uninstalled", ...over });

  it("RG01 the purge deletes the installation's reading rows, audits (ids and counts), returns counts", async () => {
    useDb(seedReading(), [revoked()]);
    const r = await slackReadPurgeJobHandler.run(jobCtx("exec.slack-read-purge", { installation_id: INST, reason: "app_uninstalled" }, { principal: null }));
    expect(p7aRows()).toEqual([]);
    expect(db.tables.exec_attention_items).toEqual([]);
    expect(Object.values(r as Record<string, number>).every((v) => typeof v === "number")).toBe(true);
    expect(vi.mocked(auditEvent).mock.calls[0]).toEqual([null, expect.objectContaining({ actor: "system", action: "slack.read_purged",
      target: `exec_slack_installations:${INST}`, input: expect.objectContaining({ reason: "app_uninstalled" }) })]);
    expect(db.tables.exec_slack_installations[0].reading_purged_at).not.toBeNull();
  });

  it("RG02 the P7a schema missing → NonRetryableError(not_installed); RG03 a bad payload → dead", async () => {
    useDb();
    db.missing.add("exec_slack_purge_reading");
    await expect(slackReadPurgeJobHandler.run(jobCtx("exec.slack-read-purge", { installation_id: INST, reason: "recheck" }, { principal: null })))
      .rejects.toMatchObject({ name: "NonRetryableError", message: "not_installed" });
    await expect(slackReadPurgeJobHandler.run(jobCtx("exec.slack-read-purge", { installation_id: INST, reason: "because" }, { principal: null })))
      .rejects.toMatchObject({ name: "NonRetryableError" });
  });

  it("RG04 / PG10 / PG10b the recheck lists globally: a disabled principal's revoked, unpurged installation gets a principal-null purge; a purged one doesn't; two ticks the same UTC day → one job", async () => {
    useDb({}, [
      revoked({ id: INST, principal_id: "ep_9" }),
      revoked({ id: INST2, principal_id: "ep_1", reading_purged_at: "2026-11-07T01:00:00.000Z" })
    ]);
    const r1 = await slackReadRecheckJobHandler.run(jobCtx("exec.slack-read-recheck", {}));
    const r2 = await slackReadRecheckJobHandler.run(jobCtx("exec.slack-read-recheck", {}, { principal: { ...PRINCIPAL, id: "ep_2" } as never }));
    expect(r1).toMatchObject({ enqueued: 1 });
    expect(r2).toMatchObject({ enqueued: 0 });
    const jobs = db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-read-purge");
    expect(jobs).toEqual([expect.objectContaining({ principal_id: null, lane: "bulk", payload: { installation_id: INST, reason: "recheck" },
      dedupe_key: `slack-read-purge:${INST}:recheck:2026-11-08`, max_attempts: 6 })]);
  });

  it("RG05 the recheck runs daily at 04:20 local, gated on the schema", () => {
    expect(slackReadRecheckScheduledWork).toMatchObject({ kind: "exec.slack-read-recheck", lane: "bulk", maxAttempts: 2 });
    expect(slackReadRecheckScheduledWork.cadence.kind === "daily" && slackReadRecheckScheduledWork.cadence.at(settings())).toBe("04:20");
    expect(slackReadRecheckScheduledWork.enabled?.(settings({ slackReadingSchemaReady: false }))).toBe(false);
  });
});

describe("PG07-PG09: stop, revoke, uninstall", () => {
  it("PG07 Stop reading (userRevoke 'stopped'): every reading row, the Slack attention rows and the reading events gone, the token null, the view revoked; P6's rows kept", async () => {
    useDb({
      ...seedReading(),
      exec_slack_events: [
        { event_id: "Ev0READ1", installation_id: INST, principal_id: PID, team_id: "T0SCALED", api_app_id: "A0EXEC", event_type: "message", decision: "ingest",
          ingest_outcome: "candidate", event_time: NOW.toISOString(), retry_num: 0, received_at: NOW.toISOString(), updated_at: NOW.toISOString() },
        { event_id: "Ev0P6HOME", installation_id: INST, principal_id: PID, team_id: "T0SCALED", api_app_id: "A0EXEC", event_type: "app_home_opened", decision: "home",
          event_time: NOW.toISOString(), retry_num: 0, received_at: NOW.toISOString(), updated_at: NOW.toISOString() }
      ],
      exec_attention_items: [...(seedReading().exec_attention_items ?? []), { id: "ea_email", principal_id: PID, source: "email", fingerprint: "email:thread:x", kind: "important_email", status: "open" }]
    });
    const r = await userRevoke(INST, "stopped");
    expect(r.revoked).toBe(true);
    expect(p7aRows()).toEqual([]);
    expect(db.tables.exec_attention_items.map((a) => a.source)).toEqual(["email"]);
    expect(db.tables.exec_slack_events.map((e) => e.event_id)).toEqual(["Ev0P6HOME"]);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ user_token_enc: null, reading_state: "revoked", revoked_at: null });
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("revoked");
    expect(db.tables.exec_slack_purge_log.filter((l) => l.scope === "reading")).toHaveLength(1);
  });

  it("PG08 tokens_revoked → the user check → invalid_auth → the same purge; ok → nothing", async () => {
    useDb(seedReading());
    let s = installFakeSlack({ "auth.test": () => ({ ok: true, team_id: "T0SCALED", user_id: "U0MITCH" }) });
    expect(await slackUserCheckJobHandler.run(jobCtx("exec.slack-user-check", { installation_id: INST, event_time: NOW.getTime() / 1000 }, { principal: null })))
      .toEqual({ stillValid: true });
    expect(p7aRows()).not.toEqual([]);
    s.restore();
    s = installFakeSlack({ "auth.test": () => slackReadError("token_revoked") });
    expect(await slackUserCheckJobHandler.run(jobCtx("exec.slack-user-check", { installation_id: INST, event_time: NOW.getTime() / 1000 }, { principal: null })))
      .toMatchObject({ revoked: true });
    expect(p7aRows()).toEqual([]);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ reading_state: "revoked", user_revoke_reason: "tokens_revoked" });
  });

  it("AM-P7a-15 P6's daily backstop (purgeUnpurgedRevocations) also purges the reading half first", async () => {
    const inst = installationDbRow(sealSecret, { revoked_at: "2026-11-08T12:00:00.000Z", revoke_reason: "app_uninstalled" });
    useDb(seedReading(), [inst]);
    expect(await purgeUnpurgedRevocations(NOW)).toBe(1);
    expect(p7aRows()).toEqual([]);
    const calls = db.calls.filter((c) => c.kind === "rpc").map((c) => c.target);
    expect(calls.indexOf("exec_slack_purge_reading")).toBeLessThan(calls.indexOf("exec_slack_purge_installation"));
  });

  it("PG09 app_uninstalled: P6's uninstall purge purges the reading half first; the read-purge job after it purges nothing", async () => {
    const inst = installationDbRow(sealSecret, { revoked_at: "2026-11-08T14:00:00.000Z", revoke_reason: "app_uninstalled" });
    useDb(seedReading(), [inst]);
    await slackUninstallJobHandler.run(jobCtx("exec.slack-uninstall", { installation_id: INST, mode: "purge" }, { principal: null }));
    expect(p7aRows()).toEqual([]);
    expect(db.tables.exec_attention_items).toEqual([]);
    const calls = db.calls.filter((c) => c.kind === "rpc").map((c) => c.target);
    expect(calls.indexOf("exec_slack_purge_reading")).toBeLessThan(calls.indexOf("exec_slack_purge_installation"));
    const again = await slackReadPurgeJobHandler.run(jobCtx("exec.slack-read-purge", { installation_id: INST, reason: "app_uninstalled" }, { principal: null }));
    // Idempotent: the RPC runs again (purged), and deletes nothing.
    expect(Object.entries(again as Record<string, number>).filter(([k, n]) => k !== "purged" && n > 0)).toEqual([]);
  });
});

describe("PG11-PG18 and DM07 / DM08 / XC03 / XC04: events and the other purges", () => {
  it("PG11 channel_left / group_left → that conversation purged at once; the others untouched", async () => {
    useDb({ ...seedReading("C0GENERAL"), exec_slack_channels: [channelDbRow(), channelDbRow({ channel_id: "G0PRIV", conv_type: "group", is_private: true, name: "ops" })],
      exec_slack_messages: [messageDbRow({ ts: TS, role: "item", triage_state: "assessed" }), messageDbRow({ channel_id: "G0PRIV", ts: TS })] });
    await deliver(env("IG19 / PG11 channel_left"));
    expect(db.tables.exec_slack_messages.map((m) => m.channel_id)).toEqual(["G0PRIV"]);
    expect(db.tables.exec_slack_channels.find((c) => c.channel_id === "C0GENERAL")).toMatchObject({ is_member: false, watch_state: "unwatched" });
    await deliver(env("IG19 / PG11 group_left"));
    expect(db.tables.exec_slack_messages).toEqual([]);
  });

  it("PG13 / DM07 message_deleted in Slack's recorded shape (hidden: true), end to end: item, message, excerpt, attention gone; marker; outbox; an attention kick", async () => {
    const e = env("IG08 message_deleted in the recorded shape (hidden: true)");
    const deleted = String(e.event.deleted_ts);
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: deleted, role: "item", triage_state: "assessed" })],
      exec_slack_items: [itemDbRow({ ts: deleted })],
      exec_attention_items: [{ id: "ea_1", principal_id: PID, source: "slack", fingerprint: `slack:msg:C0GENERAL:${deleted}`, kind: "slack_request", status: "open" },
        { id: "ea_2", principal_id: PID, source: "slack", fingerprint: `slack:msg:C0GENERAL:${deleted}0`, kind: "slack_request", status: "open" }] });
    expect(await deliver(e)).toMatchObject({ outcome: "accepted" });
    expect(db.tables.exec_slack_items).toEqual([]);
    expect(db.tables.exec_slack_messages).toEqual([]);
    expect(db.tables.exec_slack_deleted.map((d) => d.ts)).toEqual([deleted]);
    expect(db.tables.exec_attention_items.map((a) => a.id)).toEqual(["ea_2"]);
    expect(db.tables.exec_slack_purge_log.map((l) => [l.scope, l.ts])).toEqual([["message", deleted]]);
    expect(db.tables.exec_jobs.some((j) => j.kind === "exec.slack-attention")).toBe(true);
  });

  it("DM08 a marker blocks the event path: the same message re-delivered as new is not stored", async () => {
    const e = env("V221 a DM to him (len 2): a dm candidate");
    const ts = String(e.event.ts);
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE" })],
      exec_slack_deleted: [{ principal_id: PID, channel_id: "D0JANE", ts, reason: "event", deleted_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() }] });
    await deliver(e);
    expect(db.tables.exec_slack_messages).toEqual([]);
  });

  it("PG14 TTL: an expired item and message deleted; a fresh one kept", async () => {
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: "1790000000.000100", role: "item", expires_at: "2026-11-01T00:00:00.000Z" }),
      messageDbRow({ ts: TS, expires_at: "2027-02-01T00:00:00.000Z" })], exec_slack_items: [itemDbRow({ ts: "1790000000.000100", expires_at: "2026-11-01T00:00:00.000Z" })],
      exec_attention_items: [{ id: "ea_old", principal_id: PID, source: "slack", fingerprint: "slack:msg:C0GENERAL:1790000000.000100", kind: "slack_request", status: "open" },
        { id: "ea_new", principal_id: PID, source: "slack", fingerprint: `slack:msg:C0GENERAL:${TS}`, kind: "slack_request", status: "open" }] });
    const r = await purgeExpiredSlack(NOW);
    expect(r).toMatchObject({ items: 1, messages: 1, attention: 1 });
    expect(db.tables.exec_slack_messages.map((m) => m.ts)).toEqual([TS]);
    expect(db.tables.exec_slack_items).toEqual([]);
    // Its attention row goes in the same run (the orphan sweep); the fresh message's stays.
    expect(db.tables.exec_attention_items.map((a) => a.id)).toEqual(["ea_new"]);
  });

  it("PG15 every purge appends exactly one outbox row per message / conversation / reading purge, with no text", async () => {
    useDb(seedReading());
    await deliver(env("IG08 message_deleted in the recorded shape (hidden: true)", (e) => {
      e.event.deleted_ts = TS;
    }));
    expect(db.tables.exec_slack_purge_log.map((l) => l.scope)).toEqual(["message"]);
    await deliver(env("IG19 / PG11 channel_left"));
    expect(db.tables.exec_slack_purge_log.map((l) => l.scope)).toEqual(["message", "conversation"]);
    await userRevoke(INST, "stopped");
    expect(db.tables.exec_slack_purge_log.map((l) => l.scope)).toEqual(["message", "conversation", "reading"]);
  });

  it("PG16 reconnect race: installation 1 revoked, 2 created and discovered before 1's purge → 1's purge leaves 2's rows intact", async () => {
    const one = installationDbRow(sealSecret, { id: INST, revoked_at: "2026-11-08T13:00:00.000Z", revoke_reason: "disconnected", reading_state: "revoked",
      user_token_enc: null, user_key_id: null, user_scopes: [], user_revoked_at: "2026-11-08T13:00:00.000Z", user_revoke_reason: "disconnected" });
    const two = installationDbRow(sealSecret, { id: INST2, installed_at: "2026-11-08T14:00:00.000Z" });
    useDb(seedReading(), [one, two]);
    await applyClasses(PRINCIPAL, INST2, [{ channel_id: "C0GENERAL", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null, finance_name: false,
      default_watch: "watched", default_mute: null, name: "general", im_user_id: null, is_member: true, is_private: false, is_ext_shared: false, is_archived: false }], NOW.toISOString());
    db.tables.exec_slack_messages.push(messageDbRow({ ts: "1794149000.000100" }));
    await slackReadPurgeJobHandler.run(jobCtx("exec.slack-read-purge", { installation_id: INST, reason: "recheck" }, { principal: null }));
    expect(db.tables.exec_slack_channels.map((c) => [c.channel_id, c.installation_id])).toEqual([["C0GENERAL", INST2]]);
    expect(db.tables.exec_slack_messages.map((m) => m.ts)).toEqual(["1794149000.000100"]);
  });

  it("PG17 per-author deletion: her IM purged, her rows and threads gone, others kept, outbox rows, the opt-out; then a v2 event from her drops and her context renders as the placeholder", async () => {
    useDb({
      exec_slack_channels: [channelDbRow(), channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE" })],
      exec_slack_messages: [
        messageDbRow({ ts: "1794140000.000100", author_user_id: "U0JANE" }),
        messageDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", author_user_id: "U0BOB", reasons: 4 }),
        messageDbRow({ ts: "1794142000.000100", author_user_id: "U0BOB" }),
        messageDbRow({ channel_id: "D0JANE", ts: "1794143000.000100", author_user_id: "U0JANE", reasons: 1 })
      ]
    });
    const r = await purgeAuthor(PRINCIPAL, "U0JANE");
    expect(r).toMatchObject({ conversations: 1 });
    expect(db.tables.exec_slack_messages.map((m) => m.ts)).toEqual(["1794142000.000100"]);
    expect(db.tables.exec_slack_author_optouts.map((o) => o.author_user_id)).toEqual(["U0JANE"]);
    expect(db.tables.exec_slack_purge_log.filter((l) => l.reason === "author_optout").length).toBeGreaterThanOrEqual(2);
    await deliver(env("V221 a DM to him (len 2): a dm candidate", (e) => {
      e.event.channel = "C0GENERAL";
      e.event.channel_type = "channel";
      e.event.text = `<@U0MITCH> ${String(e.event.text)}`;
    }));
    expect(db.tables.exec_slack_messages.map((m) => m.ts)).toEqual(["1794142000.000100"]);
    const ctx: SlackReadMessage = { ts: "1794149000.000100", threadTs: null, user: "U0JANE", userTeam: "T0SCALED", botId: null, botProfile: false, appId: null, subtype: null,
      hidden: false, text: S.text, blocks: null, attachments: null, replyCount: 0, latestReply: null, parentUserId: null, editedTs: null, reactedUserIds: [], fileCount: 0 };
    const { window } = buildTriageWindow({ channel: { channelId: "C0GENERAL", installationId: INST, convType: "channel", class: "standard", denyReason: null, hubKind: null,
      financeName: false, watchState: "watched", muteSource: null, watchSetByOwnerAt: null, name: "general", imUserId: null, isMember: true, isPrivate: false, isExtShared: false,
      extEver: false, isArchived: false, histWatermarkTs: null, deepSweptAt: null, sweptAt: null, lastEventTs: null, lastActivityTs: null, activity30d: null, probedAt: null,
      classifiedAt: null, leftAt: null, updatedAt: NOW.toISOString() }, fetched: [ctx, { ...ctx, ts: "1794149100.000100", user: "U0BOB", text: "can you sign it" }],
    candidates: [{ ts: "1794149100.000100", threadTs: null, authorUserId: "U0BOB", authorExternal: false, reasons: 2, triageState: "pending", contentHash: null, editedTs: null, respondedTs: null }],
    hisId: "U0MITCH", teamId: "T0SCALED", ddBot: { userId: null, appId: null }, optedOut: new Set(["U0JANE"]), labels: new Map(), nonce: "0123456789abcdef" });
    expect(window.messages[0]).toMatchObject({ placeholder: "optout", text: "" });
    // The opt-out survives Stop reading.
    await userRevoke(INST, "stopped");
    expect(db.tables.exec_slack_author_optouts.map((o) => o.author_user_id)).toEqual(["U0JANE"]);
  });

  it("PG18 (C43) a delete while paused is honoured at once (with its outbox row); switched back on, the item never reappears", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false }));
    useDb(seedReading());
    await deliver(env("IG08 message_deleted in the recorded shape (hidden: true)", (e) => {
      e.event.deleted_ts = TS;
    }));
    expect(db.tables.exec_slack_items).toEqual([]);
    expect(db.tables.exec_slack_purge_log.map((l) => [l.scope, l.ts])).toEqual([["message", TS]]);
    vi.mocked(loadSettings).mockResolvedValue(settings());
    expect(await listOpenSlackItems(PRINCIPAL, { sinceIso: "2026-11-01T00:00:00.000Z", limit: 50, surface: "web" })).toEqual([]);
  });

  it("XC03 channel_shared → external, ext_ever, public items → private; XC04 channel_unshared → is_ext_shared false, ext_ever kept, items private", async () => {
    useDb({ ...seedReading(), exec_slack_items: [itemDbRow({ ts: TS, source_class: "public" })] });
    await deliver(env("IG19 / XC03 channel_shared"));
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ class: "external", ext_ever: true, is_ext_shared: true });
    expect(db.tables.exec_slack_items[0]).toMatchObject({ source_class: "private" });
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "C0SHARED", class: "external", is_ext_shared: true, ext_ever: true, name: "partner-collab" })],
      exec_slack_messages: [messageDbRow({ channel_id: "C0SHARED", ts: TS, role: "item" })], exec_slack_items: [itemDbRow({ channel_id: "C0SHARED", ts: TS, source_class: "private" })] });
    await deliver(env("IG19 / XC04 channel_unshared (no longer shared)"));
    expect(db.tables.exec_slack_channels[0]).toMatchObject({ is_ext_shared: false, ext_ever: true });
    expect(db.tables.exec_slack_items[0]).toMatchObject({ source_class: "private" });
  });
});
