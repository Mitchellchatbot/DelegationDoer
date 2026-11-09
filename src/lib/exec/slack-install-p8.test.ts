import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createFakeSlackDb, type FakeSlackDb } from "@/lib/exec/__tests__/fake-slack-db";
import { ROUTING_INSTALLATION as RI } from "@/lib/exec/__tests__/slack-assert";
import { installationRow, TOKEN_KEY } from "@/lib/exec/__tests__/slack-route-helpers";
import { __resetAcceptActionV2ForTests, acceptAction, installationFactsForSystem, SlackStoreError } from "@/lib/exec/slack-install";
import type { SlackActionFacts } from "@/lib/exec/slack-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 §5.11 CI32 (C43, coherence-6) and §3.21.3 installationFactsForSystem (AM-P8-17; Area D): P6's acceptAction calls P8's
// exec_slack_accept_action_v2 first and falls back to P6's own RPC on 42883 / PGRST202, remembering the absence for 5 minutes
// per process; the interactions route is not edited.

let db: FakeSlackDb;
const NOW = new Date("2026-11-09T13:20:00.000Z");
const signal = () => new AbortController().signal;
const MESSAGE_TS = "1793977301.000101";
const ED = `ed_${"e".repeat(32)}`;
const facts = (over: Partial<SlackActionFacts> = {}): SlackActionFacts => ({
  teamId: RI.teamId, apiAppId: RI.appId, userId: RI.userId, triggerId: "t.1", actionId: "ea_draft_save", value: `d1.${ED}.3`, containerType: "message",
  channelId: RI.dmChannelId, messageTs: MESSAGE_TS, ...over
});
const rpcTargets = () => db.calls.filter((c) => c.kind === "rpc").map((c) => c.target);
function useDb(missing: string[] = []): void {
  db = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] }, missing });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  __resetAcceptActionV2ForTests();
  useDb();
});
afterEach(() => {
  __resetAcceptActionV2ForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("CI32 acceptAction: v2, then v1", () => {
  it("v2 present → one call to exec_slack_accept_action_v2; a P6 action is P6's job, a check-in click is exec.checkin-send (one per click)", async () => {
    expect(await acceptAction(facts(), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcTargets()).toEqual(["exec_slack_accept_action_v2"]);
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.dedupe_key])).toEqual([["exec.slack-action", "slack-act:t.1"]]);
    const value = `c1.ebc_${"c".repeat(32)}.2.${"a".repeat(32)}`;
    expect(await acceptAction(facts({ actionId: "ea_ci_send", value, triggerId: "t.2" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(facts({ actionId: "ea_ci_rewrite", value, triggerId: "t.3" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(db.tables.exec_jobs.slice(1).map((j) => [j.kind, j.dedupe_key, j.max_attempts, j.payload])).toEqual([
      ["exec.checkin-send", "checkin-send:t.2", 1, { installation_id: installationRow().id, checkin_id: `ebc_${"c".repeat(32)}`, rev: 2, value, channel_id: RI.dmChannelId, message_ts: MESSAGE_TS }],
      ["exec.checkin-rewrite", "checkin-rewrite:t.3", 1, { installation_id: installationRow().id, checkin_id: `ebc_${"c".repeat(32)}`, rev: 2, value, channel_id: RI.dmChannelId, message_ts: MESSAGE_TS }]
    ]);
    expect(await acceptAction(facts({ actionId: "ea_ci_send", value: `c1.ebc_x.2.${"a".repeat(32)}`, triggerId: "t.4" }), { signal: signal() }))
      .toEqual({ outcome: "ignored", reason: "bad_value" });
  });

  it("v2 missing (PGRST202) → v1 on the same signal, v2 marked absent; within 5 minutes → v1 directly; after 5 minutes → v2 again", async () => {
    useDb(["exec_slack_accept_action_v2"]);
    const s = signal();
    expect(await acceptAction(facts(), { signal: s })).toEqual({ outcome: "enqueued" });
    expect(db.calls.filter((c) => c.kind === "rpc").map((c) => [c.target, c.signal === s])).toEqual([["exec_slack_accept_action_v2", true], ["exec_slack_accept_action", true]]);
    expect((globalThis as { __ddExecAcceptActionV2AbsentAt?: number }).__ddExecAcceptActionV2AbsentAt).toBe(NOW.getTime());
    db.calls.length = 0;
    vi.setSystemTime(new Date(NOW.getTime() + 4 * 60_000));
    expect(await acceptAction(facts({ triggerId: "t.2" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcTargets()).toEqual(["exec_slack_accept_action"]);
    db.calls.length = 0;
    db.missing.delete("exec_slack_accept_action_v2");
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000 + 1));
    expect(await acceptAction(facts({ triggerId: "t.3" }), { signal: signal() })).toEqual({ outcome: "enqueued" });
    expect(rpcTargets()).toEqual(["exec_slack_accept_action_v2"]);
  });

  it("a P6 action through v1 gets P6's answer unchanged; both missing → not_installed; another error → SlackStoreError", async () => {
    useDb(["exec_slack_accept_action_v2"]);
    expect(await acceptAction(facts({ userId: "U0JANE" }), { signal: signal() })).toEqual({ outcome: "ignored", reason: "not_owner" });
    expect(await acceptAction(facts({ actionId: "ea_ci_send", value: `c1.ebc_${"c".repeat(32)}.2.${"a".repeat(32)}` }), { signal: signal() }))
      .toEqual({ outcome: "ignored", reason: "unknown_action" });
    useDb(["exec_slack_accept_action_v2", "exec_slack_accept_action"]);
    __resetAcceptActionV2ForTests();
    expect(await acceptAction(facts(), { signal: signal() })).toEqual({ outcome: "not_installed" });
    __resetAcceptActionV2ForTests();
    db = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] }, fail: () => ({ code: "53300", message: "too many" }) });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await expect(acceptAction(facts(), { signal: signal() })).rejects.toBeInstanceOf(SlackStoreError);
    expect(rpcTargets()).toEqual(["exec_slack_accept_action_v2"]);
  });

  it("the interactions route is byte-identical to P7b's (only acceptAction changed)", () => {
    const route = readFileSync(fileURLToPath(new URL("../../app/api/integrations/exec-slack/interactions/route.ts", import.meta.url)), "utf8");
    expect(createHash("sha256").update(route.replace(/\r\n/g, "\n"), "utf8").digest("hex")).toBe("8b8cd06eab55fc9f588dbde7dfb1181fa371917bdbcdb83d5c6d41b2152c6408");
  });
});

/** A one-table stand-in for installationFactsForSystem's two reads (P6's fake can't hold P7a's reading columns). */
function factsClient(answers: ({ data: unknown[] } | { error: { code: string; message: string } })[]): { client: unknown; selects: string[] } {
  const selects: string[] = [];
  const builder = (cols: string) => {
    selects.push(cols);
    const answer = answers.shift() ?? { data: [] };
    const result = "error" in answer ? { data: null, error: answer.error } : { data: answer.data, error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "is", "order", "limit", "abortSignal"]) q[m] = () => q;
    q.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result).then(f, r);
    return q;
  };
  return { client: { from: () => ({ select: builder }) }, selects };
}

describe("installationFactsForSystem (§3.21.3, AM-P8-17)", () => {
  const use = (answers: Parameters<typeof factsClient>[0]) => {
    const fake = factsClient(answers);
    vi.mocked(getSupabaseAdmin).mockReturnValue(fake.client as SupabaseClient);
    return fake;
  };
  const row = (over: Record<string, unknown> = {}) => ({ id: "esi_1", revoked_at: null, user_token_enc: "v1.sealed", user_revoked_at: null, reading_state: "ready", ...over });

  it("an active row with a live reading half → all true; discovering counts as live", async () => {
    use([{ data: [row()] }]);
    expect(await installationFactsForSystem("ep_1")).toEqual({ schema: true, active: true, readingActive: true });
    use([{ data: [row({ reading_state: "discovering" })] }]);
    expect((await installationFactsForSystem("ep_1")).readingActive).toBe(true);
  });

  it("the reading half not live (no token, revoked, state none / revoked) → readingActive false; no active row → active false", async () => {
    for (const over of [{ user_token_enc: null }, { user_revoked_at: NOW.toISOString() }, { reading_state: "none" }, { reading_state: "revoked" }]) {
      use([{ data: [row(over)] }]);
      expect(await installationFactsForSystem("ep_1"), JSON.stringify(over)).toEqual({ schema: true, active: true, readingActive: false });
    }
    use([{ data: [] }]);
    expect(await installationFactsForSystem("ep_1")).toEqual({ schema: true, active: false, readingActive: false });
  });

  it("P7a's columns missing → the P6 columns answer, readingActive false; the P6 table missing → all false; another error throws", async () => {
    const fake = use([{ error: { code: "42703", message: "column" } }, { data: [{ id: "esi_1", revoked_at: null }] }]);
    expect(await installationFactsForSystem("ep_1")).toEqual({ schema: true, active: true, readingActive: false });
    expect(fake.selects).toEqual(["id,revoked_at,user_token_enc,user_revoked_at,reading_state", "id,revoked_at"]);
    use([{ error: { code: "PGRST205", message: "table" } }]);
    expect(await installationFactsForSystem("ep_1")).toEqual({ schema: false, active: false, readingActive: false });
    use([{ error: { code: "53300", message: "too many" } }]);
    await expect(installationFactsForSystem("ep_1")).rejects.toBeInstanceOf(SlackStoreError);
    await expect(installationFactsForSystem("")).rejects.toBeInstanceOf(TypeError);
  });
});
