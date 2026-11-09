import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ kickInteractive: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/runtime", () => ({ ensureExecRuntime: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...actual, acceptEvent: vi.fn(actual.acceptEvent), acceptAction: vi.fn(actual.acceptAction) };
});
// IA04: the P4 / P5b entry points a click eventually reaches (in the job, never here), as spies.
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn(), saveDraft: vi.fn(), requestRegeneration: vi.fn() }));
vi.mock("@/lib/exec/proposals", () => ({ confirmProposal: vi.fn(), dismissProposal: vi.fn(), getProposalView: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({ prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), storedTurnPayload: vi.fn() }));

import * as interactionsRoute from "@/app/api/integrations/exec-slack/interactions/route";
import { SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbSeed, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { INSTALLATION_ID, installationRow, signedSlackRequest, slackEnv } from "@/lib/exec/__tests__/slack-route-helpers";
import { prepareChatTurn, runPreparedTurn, storedTurnPayload } from "@/lib/exec/agent/turn";
import { getDraftView, requestRegeneration, saveDraft } from "@/lib/exec/drafts";
import { kickInteractive } from "@/lib/exec/jobs";
import { confirmProposal, dismissProposal, getProposalView } from "@/lib/exec/proposals";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import { __resetAcceptActionV2ForTests, acceptAction, acceptEvent } from "@/lib/exec/slack-install";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// POST /api/integrations/exec-slack/interactions (P6 contract §3.10.2, K8, C12,
// C13, C36; Area C): IA01-IA06. The route runs for real against Area A's store over
// fake-slack-db.ts (RPC 2 mirrored: the owner, DM and action checks, the
// slack-act:<trigger_id> dedupe). Requests are signed here with node:crypto.

const ED = `ed_${"b".repeat(32)}`;
const MESSAGE_TS = "1793977201.000100";

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
const consoleCalls = () => spies.flatMap((s) => s.mock.calls);
const slackLines = () => consoleCalls().map((c) => String(c[0])).filter((l) => l.startsWith("[exec-slack]"));

/** A block_actions payload as Slack sends it for a click in the bot DM, with every never-read field carrying a sentinel. */
function blockActions(over: Row = {}, action: Row = {}): Row {
  return {
    type: "block_actions",
    api_app_id: "A0EXEC",
    team: { id: "T0SCALED", domain: "scaledai" },
    enterprise: null,
    user: { id: "U0MITCH", username: SENTINELS.displayName, name: SENTINELS.displayName, team_id: "T0SCALED" },
    trigger_id: SENTINELS.triggerId,
    response_url: SENTINELS.responseUrl,
    container: { type: "message", message_ts: MESSAGE_TS, channel_id: "D0MITCH", is_ephemeral: false },
    channel: { id: "D0MITCH", name: "directmessage" },
    message: { type: "message", text: SENTINELS.text, ts: MESSAGE_TS, blocks: [] },
    state: { values: {} },
    actions: [{ action_id: "ea_draft_save", block_id: "draft", value: `d1.${ED}.3`, type: "button", action_ts: "1793977300.000001", ...action }],
    ...over
  };
}
const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`;
const click = (payload: unknown, opts: Parameters<typeof signedSlackRequest>[2] = {}) =>
  interactionsRoute.POST(signedSlackRequest("interactions", typeof payload === "string" || Buffer.isBuffer(payload) ? payload : form(payload), opts));

const noP4P5bCalls = () => {
  for (const fn of [getDraftView, saveDraft, requestRegeneration, confirmProposal, dismissProposal, getProposalView, prepareChatTurn, runPreparedTurn, storedTurnPayload]) {
    expect(vi.mocked(fn)).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  useEnv();
  useDb(owner());
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.mocked(ensureExecRuntime).mockReset();
  vi.mocked(kickInteractive).mockReset();
  vi.mocked(acceptAction).mockClear();
  vi.mocked(acceptEvent).mockClear();
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
    expect(interactionsRoute.dynamic).toBe("force-dynamic");
    expect(interactionsRoute.runtime).toBe("nodejs");
    expect(Object.keys(interactionsRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});

describe("the owner check (C13)", () => {
  it("IA01 user.id ≠ the installation's user → RPC ignored (not_owner), 200, nothing enqueued, no kick", async () => {
    const res = await click(blockActions({ user: { id: "U0JANE", name: SENTINELS.displayName } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(acceptAction).toHaveBeenCalledTimes(1);
    expect(await vi.mocked(acceptAction).mock.results[0].value).toEqual({ outcome: "ignored", reason: "not_owner" });
    expect(db.tables.exec_jobs).toEqual([]);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(slackLines()).toEqual(["[exec-slack] interactions ignored reason=not_owner action=ea_draft_save"]);
  });

  it("IA01 another channel, an unknown action or a bad value → ignored, 200, nothing enqueued", async () => {
    const cases: [Row, Row, string][] = [
      [{ container: { type: "message", message_ts: MESSAGE_TS, channel_id: "D0OTHER" } }, {}, "other_channel"],
      [{}, { action_id: "ea_draft_send" }, "unknown_action"],
      [{}, { value: "x".repeat(201) }, "bad_value"]
    ];
    for (const [over, action, reason] of cases) {
      const res = await click(blockActions(over, action));
      expect(res.status).toBe(200);
      expect(slackLines().at(-1)).toContain(`ignored reason=${reason}`);
    }
    expect(db.tables.exec_jobs).toEqual([]);
    expect(kickInteractive).not.toHaveBeenCalled();
  });

  it("IA02 wrong app or wrong team → 200, no RPC", async () => {
    for (const over of [{ api_app_id: "A0OTHER" }, { team: { id: "T0OTHER" } }]) {
      const res = await click(blockActions(over));
      expect(res.status).toBe(200);
    }
    expect(acceptAction).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
    expect(slackLines()).toEqual([
      "[exec-slack] interactions dropped reason=wrong_app action=ea_draft_save",
      "[exec-slack] interactions dropped reason=wrong_team action=ea_draft_save"
    ]);
  });

  it("IA03 Open in DD (ea_open_dd, a URL button) → 200, no RPC", async () => {
    const res = await click(blockActions({}, { action_id: "ea_open_dd", value: undefined, url: "https://operations.scaledai.org/executive/email/drafts/x" }));
    expect(res.status).toBe(200);
    expect(acceptAction).not.toHaveBeenCalled();
    expect(ensureExecRuntime).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("the feature flag off or the Slack config missing → 200, no RPC", async () => {
    useEnv({ EXEC_ENABLED: "false" });
    expect((await click(blockActions())).status).toBe(200);
    useEnv({ EXEC_SLACK_TEAM_ID: undefined });
    expect((await click(blockActions())).status).toBe(200);
    expect(acceptAction).not.toHaveBeenCalled();
    expect(slackLines().map((l) => l.split(" ")[3])).toEqual(["reason=disabled", "reason=not_configured"]);
  });
});

describe("the ack", () => {
  it("IA04 returns before any P4 / P5b / Slack call and kicks the interactive lane after enqueued", async () => {
    let enqueuedAt = -1;
    vi.mocked(acceptAction).mockImplementationOnce(async (facts, opts) => {
      const actual = await vi.importActual<typeof import("@/lib/exec/slack-install")>("@/lib/exec/slack-install");
      const r = await actual.acceptAction(facts, opts);
      enqueuedAt = vi.mocked(kickInteractive).mock.calls.length;
      return r;
    });
    const res = await click(blockActions());
    expect(res.status).toBe(200);
    expect(enqueuedAt).toBe(0);
    expect(kickInteractive).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureExecRuntime).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(acceptAction).mock.invocationCallOrder[0]);
    expect(fetchSpy).not.toHaveBeenCalled();
    noP4P5bCalls();
    // P8 (C43): P6's acceptAction calls P8's exec_slack_accept_action_v2 (P6's body + the check-in buttons) first.
    expect(db.calls.map((c) => [c.kind, c.target])).toEqual([["rpc", "exec_slack_accept_action_v2"]]);
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.lane, j.max_attempts, j.payload])).toEqual([
      ["exec.slack-action", "interactive", 1, { installation_id: INSTALLATION_ID, action_id: "ea_draft_save", value: `d1.${ED}.3`, channel_id: "D0MITCH", message_ts: MESSAGE_TS }]
    ]);
    expect(slackLines()).toEqual(["[exec-slack] interactions enqueued reason=enqueued action=ea_draft_save"]);
  });

  it("the same trigger twice → duplicate, 200, one job, one kick", async () => {
    expect((await click(blockActions())).status).toBe(200);
    expect((await click(blockActions())).status).toBe(200);
    expect(db.tables.exec_jobs).toHaveLength(1);
    expect(kickInteractive).toHaveBeenCalledTimes(1);
    expect(slackLines()[1]).toBe("[exec-slack] interactions duplicate reason=duplicate action=ea_draft_save");
  });

  it("the RPC missing → 200, nothing done", async () => {
    // P8 (C43): v2 first, then P6's RPC; "the RPC missing" = both missing (and the 5-minute absence memo forgotten after).
    useDb({ ...owner(), missing: ["exec_slack_accept_action", "exec_slack_accept_action_v2"] });
    onTestFinished(() => __resetAcceptActionV2ForTests());
    expect((await click(blockActions())).status).toBe(200);
    expect(kickInteractive).not.toHaveBeenCalled();
    expect(slackLines()[0]).toContain("dropped reason=schema_missing");
  });

  it("IA05 the RPC throws → 500 (C36)", async () => {
    useDb({ ...owner(), fail: (call) => (call.kind === "rpc" ? { code: "XX000", message: "internal" } : null) });
    const res = await click(blockActions());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(kickInteractive).not.toHaveBeenCalled();
  });

  it("IA05 the RPC slower than 2 s → 500 at 2 s, the controller aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    useDb({ ...owner(), before: (call) => (call.kind === "rpc" ? new Promise((r) => setTimeout(r, 60_000)) : undefined) });
    const pending = click(blockActions());
    await vi.advanceTimersByTimeAsync(2_001);
    const res = await pending;
    expect(res.status).toBe(500);
    expect(vi.mocked(acceptAction).mock.calls[0][1].signal.aborted).toBe(true);
    expect(db.tables.exec_jobs).toEqual([]);
  });

  it("IA06 response_url, message, view and state are never read (a Proxy records every property read)", async () => {
    const reads = new Set<PropertyKey>();
    const record = (v: unknown): unknown => {
      if (typeof v !== "object" || v === null) return v;
      return new Proxy(v as object, {
        get(t, k, r) {
          reads.add(k);
          return record(Reflect.get(t, k, r));
        },
        has(t, k) {
          reads.add(k);
          return Reflect.has(t, k);
        },
        getOwnPropertyDescriptor(t, k) {
          reads.add(k);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        ownKeys(t) {
          reads.add("*ownKeys*");
          return Reflect.ownKeys(t);
        }
      });
    };
    const realParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((s: string) => record(realParse(s)));
    const res = await click(blockActions({ view: { id: "V0", state: { values: {} } } }));
    vi.mocked(JSON.parse).mockRestore();
    expect(res.status).toBe(200);
    expect(db.tables.exec_jobs).toHaveLength(1);
    for (const k of ["response_url", "message", "view", "state", "*ownKeys*"]) expect(reads.has(k), String(k)).toBe(false);
    expect(reads.has("trigger_id")).toBe(true);
  });
});

describe("the gates before the payload", () => {
  it("a 2 MiB body → 413, nothing parsed", async () => {
    const res = await click(`payload=${"x".repeat(2 * 1024 * 1024)}`);
    expect(res.status).toBe(413);
    expect(acceptAction).not.toHaveBeenCalled();
  });

  it("a bad signature → 401 { error: unauthorized }, no RPC", async () => {
    const res = await click(blockActions(), { secret: "another-secret" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(acceptAction).not.toHaveBeenCalled();
  });

  it("an unparseable payload → 400; another payload type → 200 with no action", async () => {
    expect((await click("payload=%7Bnope")).status).toBe(400);
    expect((await click("nothing=here")).status).toBe(400);
    expect((await click(Buffer.from([0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x3d, 0xff, 0xfe]))).status).toBe(400);
    expect((await click({ type: "view_submission", view: { id: "V1" } })).status).toBe(200);
    expect(acceptAction).not.toHaveBeenCalled();
  });

  it("no sentinel (trigger id, response_url, text, display name) reaches a log line, an RPC row or a response", async () => {
    const res = await click(blockActions());
    const body = await res.text();
    expect(findSentinel([consoleCalls(), body, [...res.headers]])).toBeNull();
    // The trigger id goes to RPC 2 for its dedupe key (slack-act:<trigger_id>, C13) and nowhere else: not the job payload.
    expect(db.tables.exec_jobs.map((j) => j.dedupe_key)).toEqual([`slack-act:${SENTINELS.triggerId}`]);
    expect(findSentinel(db.tables.exec_jobs.map((j) => j.payload))).toBeNull();
    expect(JSON.stringify(consoleCalls())).not.toContain(SENTINELS.triggerId);
  });
});
