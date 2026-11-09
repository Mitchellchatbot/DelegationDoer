import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { SLACK_TEXT_SENTINELS as S, assertNoSlackText } from "@/lib/exec/__tests__/slack-read-assert";
import { PRINCIPAL } from "@/lib/exec/__tests__/slack-read-jobs";
import { DdReadError, getClientEmailChannelId, listDdBotDmChannelIds, listFbLeadChannels } from "@/lib/exec/sources/dd";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.6.4 (Area D): the three Slack-related DD reads behind the never-watch classifier's context (explicit columns,
// fail closed with DdReadError naming only the table and the database's code).

type Answer = { data: unknown; error: { code?: string; message: string } | null };
interface Recorded { kind: "rpc" | "from"; target: string; steps: [string, unknown[]][] }
let calls: Recorded[];
let answer: Answer;

function builder(rec: Recorded): unknown {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "limit", "abortSignal", "is", "in"]) {
    b[m] = (...args: unknown[]) => {
      rec.steps.push([m, args]);
      return b;
    };
  }
  b.then = (resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer).then(resolve, reject);
  return b;
}
beforeEach(() => {
  calls = [];
  answer = { data: [], error: null };
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    rpc: (target: string) => {
      const rec: Recorded = { kind: "rpc", target, steps: [] };
      calls.push(rec);
      return builder(rec);
    },
    from: (target: string) => {
      const rec: Recorded = { kind: "from", target, steps: [] };
      calls.push(rec);
      return builder(rec);
    }
  } as unknown as SupabaseClient);
});

describe("listFbLeadChannels", () => {
  it("calls exec_slack_fb_lead_channels() (the one key, in SQL) and keeps only well-formed names and ids", async () => {
    answer = { data: [{ name: "acme-vob-leads", channel_id: "C0LEADS" }, { name: "Bad Name!", channel_id: null }, { name: null, channel_id: "G0PRIVLEADS" },
      { name: S.channelName.toUpperCase(), channel_id: "x" }], error: null };
    const ac = new AbortController();
    expect(await listFbLeadChannels(PRINCIPAL, { signal: ac.signal })).toEqual([{ name: "acme-vob-leads", channelId: "C0LEADS" }, { name: null, channelId: "G0PRIVLEADS" }]);
    expect(calls).toEqual([{ kind: "rpc", target: "exec_slack_fb_lead_channels", steps: [["abortSignal", [ac.signal]]] }]);
  });

  it("any error throws DdReadError (discovery aborts); the message names the function and the code, never a value", async () => {
    answer = { data: null, error: { code: "42P01", message: `relation "fb_onboarding" does not exist near ${S.channelName}` } };
    const err = await listFbLeadChannels(PRINCIPAL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DdReadError);
    expect((err as Error).message).toBe("DD read failed (exec_slack_fb_lead_channels): 42P01");
    assertNoSlackText(err, { label: "error" });
    answer = { data: null, error: null };
    await expect(listFbLeadChannels(PRINCIPAL)).rejects.toBeInstanceOf(DdReadError);
  });
});

describe("getClientEmailChannelId", () => {
  it("workspace_settings.client_email_channel_id of the 'workspace' row; malformed or missing → null; an error throws", async () => {
    answer = { data: [{ client_email_channel_id: " C0BQ6H8U693 " }], error: null };
    expect(await getClientEmailChannelId(PRINCIPAL)).toBe("C0BQ6H8U693");
    expect(calls[0]).toMatchObject({ kind: "from", target: "workspace_settings" });
    expect(calls[0].steps.slice(0, 3)).toEqual([["select", ["client_email_channel_id", undefined]], ["eq", ["id", "workspace"]], ["limit", [1]]]);
    answer = { data: [{ client_email_channel_id: "not-a-channel" }], error: null };
    expect(await getClientEmailChannelId(PRINCIPAL)).toBeNull();
    answer = { data: [], error: null };
    expect(await getClientEmailChannelId(PRINCIPAL)).toBeNull();
    answer = { data: null, error: { code: "42703", message: "column does not exist" } };
    await expect(getClientEmailChannelId(PRINCIPAL)).rejects.toThrow("DD read failed (workspace_settings): 42703");
  });
});

describe("listDdBotDmChannelIds", () => {
  it("daily_briefings.slack_channel, non-null, newest first, distinct, at most 5", async () => {
    answer = { data: ["D0A", "D0A", "D0B", "bad", "D0C", "D0D", "D0E", "D0F"].map((slack_channel) => ({ slack_channel, created_at: "2026-11-08" })), error: null };
    expect(await listDdBotDmChannelIds(PRINCIPAL)).toEqual(["D0A", "D0B", "D0C", "D0D", "D0E"]);
    expect(calls[0]).toMatchObject({ kind: "from", target: "daily_briefings" });
    expect(calls[0].steps).toEqual(expect.arrayContaining([["select", ["slack_channel,created_at", undefined]], ["not", ["slack_channel", "is", null]],
      ["order", ["created_at", { ascending: false }]]]));
    answer = { data: null, error: { code: "57014", message: "timeout" } };
    await expect(listDdBotDmChannelIds(PRINCIPAL)).rejects.toBeInstanceOf(DdReadError);
  });
});
