import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadPrincipalForUser: vi.fn(), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ kickInteractive: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/runtime", () => ({ ensureExecRuntime: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...actual, acceptEvent: vi.fn(actual.acceptEvent), acceptAction: vi.fn(actual.acceptAction) };
});
// P6's database (v1): the P7a store answers v2_missing, so the route takes P6's path, exactly as slack-routes-events.test.ts.
// The reading cases at the end put the real acceptEventV2 back (over fake-slack-read-db, whose v2 mirrors the SQL).
const v2 = vi.hoisted(() => ({ actual: null as unknown as typeof import("@/lib/exec/slack-read-store")["acceptEventV2"] }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-read-store")>();
  v2.actual = actual.acceptEventV2;
  return { ...actual, acceptEventV2: vi.fn(async () => ({ outcome: "v2_missing" as const })) };
});
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn(), saveDraft: vi.fn(), requestRegeneration: vi.fn() }));
vi.mock("@/lib/exec/proposals", () => ({ confirmProposal: vi.fn(), dismissProposal: vi.fn(), getProposalView: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({ prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), storedTurnPayload: vi.fn() }));

import { readFileSync } from "node:fs";

import * as eventsRoute from "@/app/api/integrations/exec-slack/events/route";
import * as interactionsRoute from "@/app/api/integrations/exec-slack/interactions/route";
import { execAskAiRoutingStateFor } from "@/lib/exec/access";
import { kickInteractive } from "@/lib/exec/jobs";
import { loadPrincipalForUser, loadSettings } from "@/lib/exec/principal";
import { __resetGateCacheForTests } from "@/lib/exec/slack-gate-cache";
import { acceptAction, acceptEvent } from "@/lib/exec/slack-install";
import { acceptEventV2 } from "@/lib/exec/slack-read-store";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";

import { createFakeSlackDb, type FakeSlackDb, type Row } from "./fake-slack-db";
import { createFakeSlackReadDb, type FakeSlackReadDb } from "./fake-slack-read-db";
import { settings as settingsFixture } from "./p5a-ui-fixtures";
import { findSentinel, SENTINELS } from "./slack-assert";
import { installationRow, routingRow, signedSlackRequest, slackEnv } from "./slack-route-helpers";
import { linkWithOwnFactorToken, OWNER_AUTH_ID, stepUpToken, strongToken } from "./step-up-fixtures";

// P9 §2.3 (Area B): routing. Slack: his message in the assistant DM → one reply job; a colleague's DM to the bot → dropped
// (silence); a channel message → never a reply; a retried event_id → one reply; an interaction from another user →
// not_owner; with Slack reading (P7a's v2): a watched channel's message → the reading ingest only (no reply, no chat job),
// a deny-class (FB lead) channel's message → dropped with nothing stored. Ask AI: routed only when every one of
// (EXEC_ENABLED, the owner, a strong sign-in = a password sign-in at any aal, chat_enabled, ask_ai_uses_exec) holds;
// any link session keeps DD's legacy Ask AI, even one that verified a code of its own.

// ---------------------------------------------------------------------------
// The Ask AI routing matrix
// ---------------------------------------------------------------------------

const OWNER = { id: "u_owner", email: "mitchell@scaledai.org" };
const LEADER = { id: "u_lead", email: "lead@scaledai.org" };
const PRINCIPAL = Object.freeze({ id: "ep_owner", userId: "u_owner", email: OWNER.email, name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const ON: ExecSettings = settingsFixture({ chatSchemaReady: true, chatEnabled: true, askAiUsesExec: true });

// strong: his password sign-in (strongToken, aal1). strong_with_code: the same plus a verified code (aal2, amr
// [totp, password]). Both are strong: the step-up reads how the session signed in, not its aal.
type SessionKind = "strong" | "strong_with_code" | "link" | "link_with_own_factor";
const SESSIONS: readonly SessionKind[] = ["strong", "strong_with_code", "link", "link_with_own_factor"];
const STRONG_SESSIONS: ReadonlySet<SessionKind> = new Set<SessionKind>(["strong", "strong_with_code"]);

function useSession(kind: SessionKind): void {
  const token =
    kind === "strong" ? strongToken()
    : kind === "strong_with_code" ? stepUpToken({ aal: "aal2", methods: ["totp", "password"] })
    : kind === "link" ? stepUpToken({ aal: "aal1", methods: ["otp"] })
    : linkWithOwnFactorToken();
  const getSession = vi.fn(async () => ({ data: { session: { access_token: token, user: { id: OWNER_AUTH_ID } } }, error: null }));
  vi.mocked(getSupabaseServer).mockReturnValue({ auth: { getSession } } as unknown as ReturnType<typeof getSupabaseServer>);
}

describe("§2.3 the Ask AI routing matrix", () => {
  beforeEach(() => {
    vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cases: { flag: boolean; owner: boolean; session: SessionKind; chat: boolean; askAi: boolean }[] = [];
  for (const flag of [true, false]) for (const owner of [true, false]) for (const session of SESSIONS) for (const chat of [true, false]) for (const askAi of [true, false]) {
    cases.push({ flag, owner, session, chat, askAi });
  }

  it(`routed only when every condition holds (${cases.length} combinations); every link session keeps legacy Ask AI`, async () => {
    for (const c of cases) {
      vi.stubEnv("EXEC_ENABLED", c.flag ? "true" : "false");
      useSession(c.session);
      vi.mocked(loadSettings).mockResolvedValue({ ...ON, chatEnabled: c.chat, askAiUsesExec: c.askAi });
      const state = await execAskAiRoutingStateFor(c.owner ? OWNER : LEADER);
      const expected = c.flag && c.owner && STRONG_SESSIONS.has(c.session) && c.chat && c.askAi;
      expect(state.routed, JSON.stringify(c)).toBe(expected);
      if (!state.routed) expect(state.emailOn, JSON.stringify(c)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Slack events and interactions (P6's path, the real routes over fake-slack-db)
// ---------------------------------------------------------------------------

let db: FakeSlackDb;
function useSlack(): void {
  for (const [k, v] of Object.entries(slackEnv())) vi.stubEnv(k, v);
  db = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(acceptEventV2).mockImplementation(async () => ({ outcome: "v2_missing" as const }));
  __resetGateCacheForTests();
  vi.mocked(kickInteractive).mockReset();
  vi.mocked(acceptEvent).mockClear();
  vi.mocked(acceptAction).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("no network in this test");
  }));
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
}
const postEvent = (envelope: Row, retry?: number) =>
  eventsRoute.POST(signedSlackRequest("events", JSON.stringify(envelope), retry === undefined ? {} : { headers: { "x-slack-retry-num": String(retry) } }));

describe("§2.3 Slack routing", () => {
  beforeEach(() => useSlack());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("his message in the assistant DM → one reply decision and one interactive kick; Slack's retry of the same event_id → still one", async () => {
    const env = routingRow(1).envelope;
    expect((await postEvent(env)).status).toBe(200);
    expect(db.tables.exec_slack_events).toHaveLength(1);
    expect(db.tables.exec_slack_events[0]).toMatchObject({ decision: "reply" });
    expect(kickInteractive).toHaveBeenCalledTimes(1);
    expect((await postEvent(env, 1)).status).toBe(200);
    expect(db.tables.exec_slack_events).toHaveLength(1);
    expect(kickInteractive).toHaveBeenCalledTimes(1);
  });

  it("a colleague's DM to the bot and a channel message → dropped (silence: no reply, no kick), and the event row holds no text", async () => {
    for (const n of [3, 4]) {
      const env = routingRow(n).envelope;
      (env.event as Row).text = SENTINELS.text;
      expect((await postEvent(env)).status).toBe(200);
    }
    expect(db.tables.exec_slack_events.map((e) => [e.decision, e.drop_reason])).toEqual([["drop", "other_channel"], ["drop", "other_channel"]]);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(findSentinel(db.tables.exec_slack_events)).toBeNull();
  });

  it("an interaction from another Slack user → ignored not_owner: nothing enqueued, no kick", async () => {
    const payload = {
      type: "block_actions", api_app_id: "A0EXEC", team: { id: "T0SCALED", domain: "scaledai" }, enterprise: null,
      user: { id: "U0JANE", username: "jane", name: "jane", team_id: "T0SCALED" }, trigger_id: "1.2.abc", response_url: "https://hooks.slack.com/actions/x",
      container: { type: "message", message_ts: "1793977201.000100", channel_id: "D0MITCH", is_ephemeral: false }, channel: { id: "D0MITCH", name: "directmessage" },
      message: { type: "message", text: "x", ts: "1793977201.000100", blocks: [] }, state: { values: {} },
      actions: [{ action_id: "ea_draft_save", block_id: "draft", value: `d1.ed_${"b".repeat(32)}.3`, type: "button", action_ts: "1793977300.000001" }]
    };
    const res = await interactionsRoute.POST(signedSlackRequest("interactions", `payload=${encodeURIComponent(JSON.stringify(payload))}`));
    expect(res.status).toBe(200);
    expect(await vi.mocked(acceptAction).mock.results[0].value).toEqual({ outcome: "ignored", reason: "not_owner" });
    expect(db.tables.exec_jobs ?? []).toEqual([]);
    expect(kickInteractive).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Slack reading (P7a's v2 path: the real route and store over fake-slack-read-db, seeded like slack-routes-events-v2.test.ts)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const FIXTURES = new URL("./fixtures/", import.meta.url);
const GATE_BASE = (JSON.parse(readFileSync(new URL("slack-gate.json", FIXTURES), "utf8")) as {
  base: { installationId: string; installation: Json; settings: Json; ddBot: Json; optouts: string[]; fb: Json[] };
}).base;
const INGEST = JSON.parse(readFileSync(new URL("slack-ingest.json", FIXTURES), "utf8")) as { channels: Record<string, Json>; rows: { name: string; envelope: Row }[] };
const READ_PID = "ep_1";
/** The text sentinel every slack-ingest.json envelope carries. */
const INGEST_TEXT = "SENTINEL-SLACK-TEXT";

/** The gate fixture's base state (slack-routes-events-v2.test.ts seedFor({})): reading on, the catalog's channels. */
function readingDb(): FakeSlackReadDb {
  const b = GATE_BASE;
  const now = "2026-11-08T14:00:00.000Z";
  const inst: Row = {
    ...b.installation, id: b.installationId, principal_id: READ_PID, revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null,
    purged_at: null, user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_purged_at: null
  };
  const channels = Object.entries(INGEST.channels).filter(([id]) => id !== "(none)").map(([id, c]) => ({
    principal_id: READ_PID, installation_id: b.installationId, channel_id: id, conv_type: c.convType, class: c.class, deny_reason: c.denyReason ?? null,
    hub_kind: c.hubKind ?? null, finance_name: c.financeName === true, watch_state: c.watchState ?? "unwatched", mute_source: c.muteSource ?? null,
    watch_set_by_owner_at: c.ownerSet ? "2026-11-02T00:00:00.000Z" : null, name: c.class === "deny" || c.class === "unclassified" ? null : (c.name ?? null),
    im_user_id: c.imUserId ?? null, is_member: c.isMember === true, is_private: c.isPrivate !== false || c.convType !== "channel",
    is_ext_shared: c.isExtShared === true, ext_ever: c.extEver === true || c.isExtShared === true, is_archived: c.isArchived === true,
    hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null,
    classified_at: now, seen_at: now, left_at: c.leftAt ?? null, created_at: now, updated_at: now
  }));
  return createFakeSlackReadDb({
    now: () => new Date(),
    tables: {
      exec_slack_installations: [inst], exec_settings: [{ principal_id: READ_PID, ...b.settings }], exec_slack_channels: channels,
      exec_slack_author_optouts: b.optouts.map((a) => ({ principal_id: READ_PID, author_user_id: a, created_at: now })), exec_slack_dd_bot: [{ ...b.ddBot, checked_at: now }],
      fb_onboarding: b.fb.map((e, n) => ({ task_id: `t_${n}`, state: { "access.notify.slack_channels": { v: JSON.stringify([e]) } } }))
    }
  });
}
const ingestEnvelope = (prefix: string): Row => {
  const r = INGEST.rows.find((x) => x.name.startsWith(prefix));
  if (!r) throw new Error(`no slack-ingest row ${prefix}`);
  return structuredClone(r.envelope);
};

describe("§2.3 Slack reading routes (P7a's v2)", () => {
  let rdb: FakeSlackReadDb;
  beforeEach(() => {
    for (const [k, v] of Object.entries(slackEnv())) vi.stubEnv(k, v);
    __resetGateCacheForTests();
    rdb = readingDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(rdb.client as SupabaseClient);
    vi.mocked(acceptEventV2).mockReset().mockImplementation(v2.actual);
    vi.mocked(acceptEvent).mockClear();
    vi.mocked(kickInteractive).mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("no network in this test");
    }));
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a mention of him in a watched channel → the reading ingest only: a text-free candidate row and a triage job; no reply decision, no chat job", async () => {
    expect((await postEvent(ingestEnvelope("IG02 "))).status).toBe(200);
    expect(await vi.mocked(acceptEventV2).mock.results[0].value).toMatchObject({ outcome: "accepted", decision: "ingest", path: "v2" });
    expect(rdb.tables.exec_slack_events.map((e) => e.decision)).toEqual(["ingest"]);
    expect(rdb.tables.exec_slack_messages.map((m) => [m.channel_id, m.role])).toEqual([["C0GENERAL", "candidate"]]);
    expect(rdb.tables.exec_jobs.map((j) => j.kind)).toEqual(["exec.slack-triage"]);
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(rdb.tables)).not.toContain(INGEST_TEXT);
  });

  it("a message in a deny-class (FB lead) channel → dropped with nothing stored: no row in any table, no text, no kick", async () => {
    const counts = () => Object.fromEntries(Object.entries(rdb.tables).map(([t, rows]) => [t, rows.length]));
    const before = counts();
    expect((await postEvent(ingestEnvelope("V213 "))).status).toBe(200);
    expect(await vi.mocked(acceptEventV2).mock.results[0].value).toMatchObject({ outcome: "accepted", decision: "drop", reason: "deny", recorded: false });
    expect(counts()).toEqual(before);
    expect(JSON.stringify(rdb.tables)).not.toContain(INGEST_TEXT);
    expect(kickInteractive).not.toHaveBeenCalled();
  });
});
