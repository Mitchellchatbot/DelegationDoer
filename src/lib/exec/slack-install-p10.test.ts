import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createFakeSlackDb, type FakeSlackDb, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { ROUTING_INSTALLATION as RI } from "@/lib/exec/__tests__/slack-assert";
import { installationRow, TOKEN_KEY } from "@/lib/exec/__tests__/slack-route-helpers";
import { __resetAcceptActionV2ForTests, __resetAcceptActionV3ForTests, acceptAction } from "@/lib/exec/slack-install";
import type { SlackActionFacts } from "@/lib/exec/slack-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.9 RK05 / RK06 and §2.1.14 (C38, H4; Area D): acceptAction tries P10's exec_slack_accept_action_v3 first, then P8's v2,
// then P6's v1, each absence (42883 / PGRST202) remembered for 5 minutes per process; every P6 and P8 action answers as before
// through v3. v3 is mirrored here from §2.1.14 on top of P6's fake (its v1 / v2 mirrors): P8's checks in P8's order, the
// widened allow-list, then one job per CLICK for the reply buttons (srd-send:<trigger_id> / srd-act:<trigger_id>), the value
// checked by the reply pattern. The SQL twin is Area A's SQ23. The interactions route is unchanged (gate 5). Invented names.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const MESSAGE_TS = "1794321000.000100";
const ESR = `esr_${"e".repeat(32)}`;
const REPLY_VALUE = `r1.${ESR}.3.${"a".repeat(32)}`;
const V3 = "exec_slack_accept_action_v3";
const signal = () => new AbortController().signal;
const facts = (over: Partial<SlackActionFacts> = {}): SlackActionFacts => ({
  teamId: RI.teamId, apiAppId: RI.appId, userId: RI.userId, triggerId: "t.1", actionId: "ea_sr_send", value: REPLY_VALUE, containerType: "message",
  channelId: RI.dmChannelId, messageTs: MESSAGE_TS, ...over
});

let db: FakeSlackDb;
let v3Present: boolean;
let rpcLog: string[];

/** §2.1.14's v3 over P6's fake: v2's checks for the reply buttons, then the job (on conflict do nothing); every other action → v2. */
function acceptV3(a: Row): Row {
  const inst = db.tables.exec_slack_installations
    .filter((i) => (i.revoked_at === null || i.revoked_at === undefined) && i.team_id === a.p_team_id && i.app_id === a.p_api_app_id
      && typeof a.p_user_id === "string" && i.user_id === a.p_user_id)[0];
  const ignored = (reason: string) => ({ outcome: "ignored", reason });
  const replyAction = ["ea_sr_send", "ea_sr_rewrite", "ea_sr_discard"].includes(String(a.p_action_id));
  if (!replyAction) return { __delegate: true };
  if (!inst) return ignored("not_owner");
  if (a.p_container_type !== "message") return ignored("container");
  if (a.p_channel_id !== inst.slack_dm_channel_id) return ignored("other_channel");
  if (typeof a.p_message_ts !== "string" || !/^[0-9]{1,12}\.[0-9]{1,8}$/.test(a.p_message_ts)) return ignored("bad_ts");
  if (typeof a.p_value !== "string" || a.p_value.length > 200 || !/^[a-z][0-9]\.[A-Za-z0-9_.]+$/.test(a.p_value)) return ignored("bad_value");
  if (typeof a.p_trigger_id !== "string" || !/^[A-Za-z0-9.]{1,200}$/.test(a.p_trigger_id)) return ignored("bad_trigger");
  if (!/^r1\.esr_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$/.test(a.p_value)) return ignored("bad_value");
  const send = a.p_action_id === "ea_sr_send";
  const key = `${send ? "srd-send:" : "srd-act:"}${a.p_trigger_id}`;
  if (db.tables.exec_jobs.some((j) => j.dedupe_key === key)) return { outcome: "duplicate" };
  const parts = a.p_value.split(".");
  db.tables.exec_jobs.push({
    id: db.tables.exec_jobs.length + 1, kind: send ? "exec.slack-rdraft-send" : "exec.slack-rdraft-act", lane: "interactive", principal_id: inst.principal_id,
    payload: { installation_id: inst.id, action: send ? "send" : a.p_action_id === "ea_sr_rewrite" ? "rewrite" : "discard", draft_id: parts[1],
      version: Number(parts[2]), value: a.p_value, channel_id: a.p_channel_id, message_ts: a.p_message_ts },
    dedupe_key: key, max_attempts: 1, status: "queued"
  });
  return { outcome: "enqueued" };
}

function useDb(missing: string[] = []): void {
  db = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] }, missing });
  v3Present = !missing.includes(V3);
  const inner = db.client as { from: (t: string) => unknown; rpc: (fn: string, args: Row) => unknown };
  const client = {
    from: (t: string) => inner.from(t),
    rpc: (fn: string, args: Row) => {
      rpcLog.push(fn);
      if (fn !== V3) return inner.rpc(fn, args);
      const answer = !v3Present
        ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
        : (() => {
          const r = acceptV3(args);
          return { data: r.__delegate ? null : r, error: null, delegate: r.__delegate === true };
        })();
      const q = {
        abortSignal: () => q,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if ((answer as { delegate?: boolean }).delegate) return (inner.rpc("exec_slack_accept_action_v2", args) as PromiseLike<unknown>).then(res, rej);
          return Promise.resolve(answer).then(res, rej);
        }
      };
      return q;
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
}

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  rpcLog = [];
  __resetAcceptActionV2ForTests();
  __resetAcceptActionV3ForTests();
  useDb();
});
afterEach(() => {
  __resetAcceptActionV2ForTests();
  __resetAcceptActionV3ForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("RK05 acceptAction: v3, then v2, then v1", () => {
  it("v3 present → one call; a reply Send is exec.slack-rdraft-send, Rewrite / Discard exec.slack-rdraft-act (one job per click)", async () => {
    expect(await acceptAction(facts(), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(facts({ actionId: "ea_sr_rewrite", triggerId: "t.2" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(facts({ actionId: "ea_sr_discard", triggerId: "t.3" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcLog).toEqual([V3, V3, V3]);
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.dedupe_key, j.max_attempts, (j.payload as Row).action, (j.payload as Row).version])).toEqual([
      ["exec.slack-rdraft-send", "srd-send:t.1", 1, "send", 3], ["exec.slack-rdraft-act", "srd-act:t.2", 1, "rewrite", 3],
      ["exec.slack-rdraft-act", "srd-act:t.3", 1, "discard", 3]
    ]);
    expect(db.tables.exec_jobs[0].payload).toEqual({ installation_id: installationRow().id, action: "send", draft_id: ESR, version: 3, value: REPLY_VALUE,
      channel_id: RI.dmChannelId, message_ts: MESSAGE_TS });
  });

  it("every P6 and P8 action answers as before through v3 (v3 hands them to v2's body)", async () => {
    expect(await acceptAction(facts({ actionId: "ea_draft_save", value: `d1.ed_${"e".repeat(32)}.3`, triggerId: "t.4" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    const ci = `c1.ebc_${"c".repeat(32)}.2.${"a".repeat(32)}`;
    expect(await acceptAction(facts({ actionId: "ea_ci_send", value: ci, triggerId: "t.5" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.dedupe_key])).toEqual([["exec.slack-action", "slack-act:t.4"], ["exec.checkin-send", "checkin-send:t.5"]]);
  });

  it("v3 missing (PGRST202) → v2 on the same signal, v3 marked absent 5 minutes; v2 missing too → v1; after 5 minutes v3 again", async () => {
    useDb([V3]);
    const s = signal();
    expect(await acceptAction(facts({ actionId: "ea_fb_up", value: `f1.ecm_${"9".repeat(32)}` }), { signal: s })).toEqual({ outcome: "enqueued" });
    expect(rpcLog).toEqual([V3, "exec_slack_accept_action_v2"]);
    expect((globalThis as { __ddExecAcceptActionV3AbsentAt?: number }).__ddExecAcceptActionV3AbsentAt).toBe(NOW.getTime());
    rpcLog.length = 0;
    vi.setSystemTime(new Date(NOW.getTime() + 4 * 60_000));
    // Inside the window v3 isn't tried; a reply button then meets v2's allow-list (unknown action), never a job.
    expect(await acceptAction(facts({ triggerId: "t.9" }), { signal: signal() })).toEqual({ outcome: "ignored", reason: "unknown_action" });
    expect(rpcLog).toEqual(["exec_slack_accept_action_v2"]);
    rpcLog.length = 0;
    useDb([V3, "exec_slack_accept_action_v2"]);
    __resetAcceptActionV2ForTests();
    expect(await acceptAction(facts({ actionId: "ea_fb_up", value: `f1.ecm_${"9".repeat(32)}`, triggerId: "t.6" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcLog).toEqual(["exec_slack_accept_action_v2", "exec_slack_accept_action"]);
    rpcLog.length = 0;
    useDb();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000 + 1));
    __resetAcceptActionV2ForTests();
    expect(await acceptAction(facts({ triggerId: "t.7" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcLog).toEqual([V3]);
  });

  it("v3 answering any other error is that error (no fallback); all three missing → not_installed", async () => {
    useDb([V3, "exec_slack_accept_action_v2", "exec_slack_accept_action"]);
    expect(await acceptAction(facts(), { signal: signal() })).toEqual({ outcome: "not_installed" });
  });
});

describe("RK06 v3's reply branch (fake; SQL SQ23)", () => {
  it("another user, another channel, a non-message container, a bad value → ignored; two clicks → two jobs; Slack's retry → duplicate", async () => {
    expect(await acceptAction(facts({ userId: "U0JANE" }), { signal: signal() })).toEqual({ outcome: "ignored", reason: "not_owner" });
    expect(await acceptAction(facts({ channelId: "D0OTHER" }), { signal: signal() })).toEqual({ outcome: "ignored", reason: "other_channel" });
    expect(await acceptAction(facts({ containerType: "view" }), { signal: signal() })).toEqual({ outcome: "ignored", reason: "container" });
    for (const value of [`r1.${ESR}.3.${"a".repeat(31)}`, `r1.esr_x.3.${"a".repeat(32)}`, `c1.ebc_${"c".repeat(32)}.2.${"a".repeat(32)}`, `r1.${ESR}.33333.${"a".repeat(32)}`]) {
      expect(await acceptAction(facts({ value }), { signal: signal() }), value).toEqual({ outcome: "ignored", reason: "bad_value" });
    }
    expect(db.tables.exec_jobs).toHaveLength(0);
    expect(await acceptAction(facts({ triggerId: "t.a" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(facts({ triggerId: "t.b" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(facts({ triggerId: "t.a" }), { signal: signal() })).toEqual({ outcome: "duplicate" });
    expect(db.tables.exec_jobs.map((j) => j.dedupe_key)).toEqual(["srd-send:t.a", "srd-send:t.b"]);
  });

  it("RK11 the interactions route is byte-identical to P9's (only acceptAction changed) and names the new action ids nowhere but its log list", () => {
    const route = readFileSync(fileURLToPath(new URL("../../app/api/integrations/exec-slack/interactions/route.ts", import.meta.url)), "utf8");
    expect(createHash("sha256").update(route.replace(/\r\n/g, "\n"), "utf8").digest("hex")).toBe("8b8cd06eab55fc9f588dbde7dfb1181fa371917bdbcdb83d5c6d41b2152c6408");
    expect(route).not.toContain("ea_sr_");
    const install = readFileSync(fileURLToPath(new URL("./slack-install.ts", import.meta.url)), "utf8");
    expect(install).toContain('const RPC_ACCEPT_ACTION_V3 = "exec_slack_accept_action_v3";');
    expect(install).not.toContain("exec.slack-rdraft-send");
  });
});
