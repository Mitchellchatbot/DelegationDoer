import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ kickInteractive: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/runtime", () => ({ ensureExecRuntime: vi.fn() }));
// Area A's real store over the fake DB, with call spies on the two acks.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...actual, acceptEvent: vi.fn(actual.acceptEvent), acceptAction: vi.fn(actual.acceptAction) };
});
// P7a (§3.9.2, C4): the route now asks v2 first. This file is P6's database, where v2 doesn't exist: the P7a store
// answers v2_missing (no database call), the route falls back to v1 on the same controller and marks v2 absent, so
// every assertion below is about P6's v1 exactly as before. slack-routes-events-v2.test.ts runs the real v2 (and
// FB01-FB05 the real fallback against this same P6 fake).
vi.mock("@/lib/exec/slack-read-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, acceptEventV2: vi.fn(async () => ({ outcome: "v2_missing" as const })) };
});

import * as eventsRoute from "@/app/api/integrations/exec-slack/events/route";
import { ROUTING_INSTALLATION as RI, SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbSeed, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import {
  INSTALLATION_ID,
  impliedFacts,
  installationRow,
  revokedInstallationRow,
  routingRow,
  routingRows,
  signedSlackRequest,
  slackEnv
} from "@/lib/exec/__tests__/slack-route-helpers";
import { kickInteractive } from "@/lib/exec/jobs";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import { __resetGateCacheForTests } from "@/lib/exec/slack-gate-cache";
import { acceptAction, acceptEvent } from "@/lib/exec/slack-install";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// POST /api/integrations/exec-slack/events (P6 contract §3.10.1, K7; Area C):
// EV01-EV15 and RT-V's route half. The route runs for real against Area A's real
// store over fake-slack-db.ts (whose RPC 1 mirrors the SQL routing rule, RT-F),
// with the runtime and the job kick as spies. Every request is signed with
// node:crypto here, so the signature check is the real one too.
//
// P7a (§3.9.2, §1.4 #5; expectations only, counts unchanged): each log line ends
// with path=<v1|v2|-> (here "-" before the RPC step, "v1 v2=missing" on a test's
// first v1 call, "v1" after it); RT-V rows 5, 6 (bot posts that mention nobody)
// and 10, 11 (the hidden message_replied shape) are dropped by the route's
// pre-DB filter now, before any RPC; every other row reaches v1 as before.

const P6_SCHEMA = [
  "exec_slack_installations", "exec_slack_events", "exec_oauth_states", "exec_chat_feedback", "exec_slack_posts",
  "exec_slack_accept_event", "exec_slack_accept_action", "exec_slack_revoke_installation", "exec_slack_purge_installation",
  "exec_slack_conversation_for_thread", "exec_slack_reply_step", "exec_slack_redaction_followups"
];

let db: FakeSlackDb;
let spies: ReturnType<typeof vi.spyOn>[];
let fetchSpy: ReturnType<typeof vi.fn>;

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
function useDb(seed?: FakeSlackDbSeed): FakeSlackDb {
  db = createFakeSlackDb(seed);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const owner = (): FakeSlackDbSeed => ({ tables: { exec_slack_installations: [installationRow()] } });

/** Every console call so far, flattened. */
const consoleCalls = () => spies.flatMap((s) => s.mock.calls);
/** The [exec-slack] lines logged so far. */
const slackLines = () => consoleCalls().map((c) => String(c[0])).filter((l) => l.startsWith("[exec-slack]"));

const post = (envelope: unknown, opts: Parameters<typeof signedSlackRequest>[2] = {}) =>
  eventsRoute.POST(signedSlackRequest("events", typeof envelope === "string" || Buffer.isBuffer(envelope) ? envelope : JSON.stringify(envelope), opts));

/** Row 1 (his top-level DM) carrying sentinel text in its text and blocks. */
function dmEnvelope(over: Row = {}): Row {
  const env = routingRow(1).envelope;
  (env.event as Row).text = SENTINELS.text;
  (env.event as Row).blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: SENTINELS.text }] }] }];
  return { ...env, ...over };
}

beforeEach(() => {
  useEnv();
  useDb(owner());
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.mocked(ensureExecRuntime).mockReset();
  vi.mocked(kickInteractive).mockReset();
  vi.mocked(acceptEvent).mockClear();
  vi.mocked(acceptAction).mockClear();
  // P7a: the per-process gate state starts empty in every test (no snapshot, v2 not yet known absent).
  __resetGateCacheForTests();
  fetchSpy = vi.fn(async () => {
    throw new TypeError("no network in this test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("route module", () => {
  it("is dynamic, on the Node runtime, and exports POST only", () => {
    expect(eventsRoute.dynamic).toBe("force-dynamic");
    expect(eventsRoute.runtime).toBe("nodejs");
    expect(Object.keys(eventsRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});

describe("url_verification (K7)", () => {
  it("EV01 signed, EXEC_ENABLED unset, no Slack config but the signing secret, no migration → 200 text/plain, body = challenge", async () => {
    useEnv({
      EXEC_ENABLED: undefined, EXEC_SLACK_CLIENT_ID: undefined, EXEC_SLACK_CLIENT_SECRET: undefined, EXEC_SLACK_TEAM_ID: undefined,
      EXEC_SLACK_APP_ID: undefined, EXEC_TOKEN_KEY: undefined
    });
    useDb({ missing: P6_SCHEMA });
    const res = await post({ token: "legacy-verification-token", challenge: SENTINELS.challenge, type: "url_verification" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(SENTINELS.challenge);
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(ensureExecRuntime).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
    expect(slackLines()).toEqual(["[exec-slack] events challenge reason=url_verification event=- type=- retry=0 path=-"]);
    expect(findSentinel(consoleCalls())).toBeNull();
  });

  it("EV01 also with EXEC_ENABLED=false", async () => {
    useEnv({ EXEC_ENABLED: "false" });
    const res = await post({ challenge: "abc123", type: "url_verification" });
    expect([res.status, await res.text()]).toEqual([200, "abc123"]);
  });

  it("EV02 unsigned → 401, the body has no challenge", async () => {
    const res = await post({ challenge: SENTINELS.challenge, type: "url_verification" }, { sign: false });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
    expect(body).not.toContain(SENTINELS.challenge);
    expect(slackLines()).toEqual(["[exec-slack] events rejected reason=missing_headers event=- type=- retry=0 path=-"]);
  });

  it("EV02 signed with another secret → 401, no challenge", async () => {
    const res = await post({ challenge: SENTINELS.challenge, type: "url_verification" }, { secret: "not-the-signing-secret" });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SENTINELS.challenge);
  });

  it("an unsigned url_verification with no signing secret configured → 401 no_secret", async () => {
    useEnv({ EXEC_SLACK_SIGNING_SECRET: undefined });
    const res = await post({ challenge: "abc", type: "url_verification" });
    expect(res.status).toBe(401);
    expect(slackLines()[0]).toContain("reason=no_secret");
  });
});

describe("the signature", () => {
  it("EV03 a bad signature → 401 and acceptEvent not called", async () => {
    const res = await post(dmEnvelope(), { secret: "another-secret" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("EV03 a body changed after signing → 401", async () => {
    const good = signedSlackRequest("events", JSON.stringify(dmEnvelope()));
    const tampered = new Request(good.url, {
      method: "POST",
      headers: good.headers,
      body: JSON.stringify({ ...dmEnvelope(), team_id: "T0EVIL" })
    });
    const res = await eventsRoute.POST(tampered);
    expect(res.status).toBe(401);
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it("EV03 a timestamp 301 s old → 401 stale, acceptEvent not called", async () => {
    const res = await post(dmEnvelope(), { tsSec: Math.floor(Date.now() / 1000) - 301 });
    expect(res.status).toBe(401);
    expect(slackLines()[0]).toContain("reason=stale");
    expect(acceptEvent).not.toHaveBeenCalled();
  });
});

describe("route-level drops (200, no RPC)", () => {
  it.each<[string, number]>([
    ["EV04 wrong api_app_id", 17],
    ["EV05 wrong team_id", 18]
  ])("%s → 200, no RPC, exactly one [exec-slack] line with no sentinel", async (_label, n) => {
    const env = routingRow(n).envelope;
    (env.event as Row).text = SENTINELS.text;
    const res = await post(env, { headers: { "x-slack-retry-num": "1" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(ensureExecRuntime).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
    const lines = slackLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[exec-slack] events dropped reason=${n === 17 ? "wrong_app" : "wrong_team"} event=${String(env.event_id)} type=message retry=1 path=-`);
    expect(findSentinel(consoleCalls())).toBeNull();
  });

  it("EV06 EXEC_ENABLED=false (and unset) → 200 drop disabled, no RPC", async () => {
    for (const flag of ["false", undefined]) {
      useEnv({ EXEC_ENABLED: flag });
      vi.mocked(acceptEvent).mockClear();
      const res = await post(dmEnvelope());
      expect(res.status).toBe(200);
      expect(acceptEvent).not.toHaveBeenCalled();
    }
    expect(db.calls).toEqual([]);
    expect(slackLines().every((l) => l.includes("reason=disabled"))).toBe(true);
  });

  it("the Slack config missing → 200 drop not_configured, no RPC", async () => {
    useEnv({ EXEC_SLACK_APP_ID: undefined });
    const res = await post(dmEnvelope());
    expect(res.status).toBe(200);
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(slackLines()[0]).toContain("reason=not_configured");
  });

  it("another envelope type (app_rate_limited) → 200 drop other_type, no RPC", async () => {
    const res = await post(routingRow(30).envelope);
    expect(res.status).toBe(200);
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(slackLines()).toEqual(["[exec-slack] events dropped reason=other_type event=- type=app_rate_limited retry=0 path=-"]);
  });
});

describe("the ack RPC", () => {
  it("EV07 the RPC missing (PGRST202) → 200 drop schema_missing", async () => {
    useDb({ ...owner(), missing: ["exec_slack_accept_event"] });
    const res = await post(dmEnvelope());
    expect(res.status).toBe(200);
    expect(acceptEvent).toHaveBeenCalledTimes(1);
    expect(slackLines()).toEqual([`[exec-slack] events dropped reason=schema_missing event=${String(dmEnvelope().event_id)} type=message retry=0 path=v1 v2=missing`]);
  });

  it("EV08 an RPC error → 500 { error: unavailable }", async () => {
    useDb({ ...owner(), fail: (call) => (call.kind === "rpc" ? { code: "53300", message: "too many connections" } : null) });
    const res = await post(dmEnvelope());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(res.headers.get("x-slack-no-retry")).toBeNull();
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(slackLines()[0]).toContain("events failed reason=store_53300");
  });

  it("EV08 ensureExecRuntime throwing → 500, no RPC", async () => {
    vi.mocked(ensureExecRuntime).mockImplementation(() => {
      throw new Error("registry broke");
    });
    const res = await post(dmEnvelope());
    expect(res.status).toBe(500);
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it("EV09 an RPC slower than 2 s → 500 by ~2 s, the controller aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-07T15:00:00.000Z"));
    useDb({ ...owner(), before: (call) => (call.kind === "rpc" ? new Promise((r) => setTimeout(r, 60_000)) : undefined) });
    let settled: Response | null = null;
    const pending = post(dmEnvelope()).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(1_990);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe(500);
    const signal = vi.mocked(acceptEvent).mock.calls[0][1].signal;
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    expect(slackLines()[0]).toContain("events failed reason=timeout");
    expect(db.tables.exec_slack_events).toEqual([]);
  });

  it("EV09 an ack that ignores its signal still answers 500 at 2 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.mocked(acceptEvent).mockImplementationOnce(() => new Promise(() => {}));
    const pending = post(dmEnvelope());
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(500);
  });

  it("EV10 accepted + interactive → ensureExecRuntime, then the RPC, then kickInteractive", async () => {
    const res = await post(dmEnvelope());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const order = [
      vi.mocked(ensureExecRuntime).mock.invocationCallOrder[0],
      vi.mocked(acceptEvent).mock.invocationCallOrder[0],
      vi.mocked(kickInteractive).mock.invocationCallOrder[0]
    ];
    expect(order.every((n) => typeof n === "number")).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.lane, j.max_attempts])).toEqual([["exec.slack-reply", "interactive", 1]]);
    expect(slackLines()).toEqual([`[exec-slack] events accepted reason=reply event=${String(dmEnvelope().event_id)} type=message retry=0 path=v1 v2=missing`]);
  });

  it("EV10 an accepted drop (a colleague's DM) → 200, no kick", async () => {
    const res = await post(routingRow(3).envelope);
    expect(res.status).toBe(200);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(slackLines()[0]).toContain("events dropped reason=other_channel");
  });

  it("EV10 a kick that throws never fails the ack", async () => {
    vi.mocked(kickInteractive).mockImplementation(() => {
      throw new Error("lane busy");
    });
    expect((await post(dmEnvelope())).status).toBe(200);
  });

  it("EV11 a duplicate (Slack's retry of the same event_id) → 200, no kick, one events row, one job", async () => {
    expect((await post(dmEnvelope())).status).toBe(200);
    vi.mocked(kickInteractive).mockClear();
    const retry = await post(dmEnvelope(), { headers: { "x-slack-retry-num": "1" } });
    expect(retry.status).toBe(200);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(db.tables.exec_slack_events).toHaveLength(1);
    expect(db.tables.exec_jobs).toHaveLength(1);
    expect(slackLines()[1]).toBe(`[exec-slack] events duplicate reason=duplicate event=${String(dmEnvelope().event_id)} type=message retry=1 path=v1`);
  });
});

describe("permanent failures carry x-slack-no-retry (C37)", () => {
  it("EV12 a 2 MiB body → 413 with x-slack-no-retry: 1, nothing parsed", async () => {
    const big = JSON.stringify({ ...dmEnvelope(), padding: "x".repeat(2 * 1024 * 1024) });
    const res = await post(big);
    expect(res.status).toBe(413);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    expect(acceptEvent).not.toHaveBeenCalled();
    expect(slackLines()[0]).toContain("rejected reason=too_large");
  });

  it.each<[string, string | Buffer]>([
    ["EV13 signed non-JSON", "this is not json"],
    ["a signed body that isn't UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["a signed JSON array", "[1,2,3]"],
    ["a signed event_callback with a bad event_id", JSON.stringify({ ...dmEnvelope(), event_id: "nope" })]
  ])("%s → 400 with x-slack-no-retry: 1", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    expect(acceptEvent).not.toHaveBeenCalled();
  });
});

describe("the ack path's budget and leaks", () => {
  it("EV14 zero fetch calls (Slack, Anthropic or anything) and exactly one database call: the RPC", async () => {
    const res = await post(dmEnvelope());
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.calls.map((c) => [c.kind, c.target])).toEqual([["rpc", "exec_slack_accept_event"]]);
    expect(db.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("EV15 a message event with sentinel text: no log line, RPC argument, stored row or response holds it", async () => {
    const res = await post(dmEnvelope());
    const body = await res.text();
    expect(findSentinel([consoleCalls(), db.calls, db.tables, body, [...res.headers]])).toBeNull();
    expect(JSON.stringify(db.calls)).not.toContain("SENTINEL");
    expect(Object.keys(db.calls[0].payload as Row).sort()).toEqual([
      "p_api_app_id", "p_channel", "p_channel_type", "p_event_id", "p_event_time", "p_event_type", "p_has_app_id", "p_has_bot_id",
      "p_has_message", "p_hidden", "p_retry_num", "p_revoked_bot_ids", "p_revoked_user_ids", "p_subtype", "p_tab", "p_team_id",
      "p_text_is_string", "p_thread_ts", "p_ts", "p_user"
    ]);
  });
});

// ---------------------------------------------------------------------------
// RT-V (route half): every fixture row through the route, the fake DB evaluating the rule

describe("RT-V: the routing fixture through the events route", () => {
  const rows = routingRows();
  it("the fixture is the shared one", () => {
    expect(rows).toHaveLength(35);
  });

  // P7a §1.4 #5 (C3): these shapes are bot or hidden noise, dropped by the pre-DB filter before any RPC (V233).
  const P7A_PREFILTERED: Readonly<Record<string, string>> = { "05": "bot_no_mention", "06": "bot_no_mention", "10": "hidden", "11": "hidden" };

  for (const r of rows) {
    it(`RT-V route ${r.name}`, async () => {
      const seeded = r.installation === "owner" ? [installationRow()] : r.installation === "revoked" ? [revokedInstallationRow()] : [];
      useDb({ tables: { exec_slack_installations: seeded } });
      const res = await post(r.envelope, { headers: { "x-slack-retry-num": "2" } });
      expect(res.status).toBe(200);
      const routeLevel = P7A_PREFILTERED[r.name.slice(0, 2)] ?? (r.expect.routeLevel as string | undefined);
      if (routeLevel) {
        expect(acceptEvent).not.toHaveBeenCalled();
        expect(db.calls).toEqual([]);
        expect(slackLines()[0]).toContain(`dropped reason=${routeLevel}`);
        return;
      }
      expect(acceptEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(acceptEvent).mock.calls[0][0]).toEqual(impliedFacts(r.envelope, 2));
      const [ev] = db.tables.exec_slack_events;
      expect(ev).toMatchObject({ event_id: r.envelope.event_id, decision: r.expect.decision, drop_reason: r.expect.reason ?? null });
      const enqueuedInteractive = r.expect.decision === "reply" || r.expect.decision === "home";
      expect(vi.mocked(kickInteractive).mock.calls.length).toBe(enqueuedInteractive ? 1 : 0);
      if (r.expect.decision === "revoke") expect(db.tables.exec_slack_installations[0]).toMatchObject({ id: INSTALLATION_ID, revoke_reason: "app_uninstalled" });
    });
  }

  it("RT-V: the stale rows are stale only against ROUTING_INSTALLATION's installed_at", () => {
    for (const n of [25, 35]) expect(Number(routingRow(n).envelope.event_time)).toBeLessThan(RI.installedAtEpochSec);
  });
});
