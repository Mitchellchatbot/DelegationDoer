import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { CHAT_SHARE_OF_DAILY_CAP, chatSpentTodayUsd, effectiveChatCapUsd } from "@/lib/exec/agent/budget";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import type { ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P5b contract §3.4 (B8, C17, C30): test 46's cap arithmetic and the chat spend read.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings = (chat: number, daily: number): ExecSettings => ({ ...DEFAULT_SETTINGS, principalId: principal.id, chatDailyCapUsd: chat, dailyCostCapUsd: daily });

interface Call { table: string; ops: [string, ...unknown[]][] }

function fakeDb(pages: ({ id: number; cost_usd: number | string | null }[] | { error: { message: string } })[]) {
  const calls: Call[] = [];
  let page = 0;
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gte", "gt", "order", "limit", "abortSignal"]) {
      builder[op] = (...args: unknown[]) => {
        call.ops.push([op, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => void) => {
      const p = pages[Math.min(page, pages.length - 1)];
      page += 1;
      resolve("error" in p ? { data: null, error: p.error } : { data: p, error: null });
    };
    return builder;
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return calls;
}

const rows = (n: number, start = 1, cost: number | string = 0.01) => Array.from({ length: n }, (_, i) => ({ id: start + i, cost_usd: cost }));

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
});

describe("effectiveChatCapUsd (test 46, C30)", () => {
  it("is min(chat cap, 0.6 × daily cap), floored to the cent", () => {
    expect(CHAT_SHARE_OF_DAILY_CAP).toBe(0.6);
    expect(effectiveChatCapUsd(settings(9, 15))).toBe(9);
    expect(effectiveChatCapUsd(settings(9, 5))).toBe(3);
    expect(effectiveChatCapUsd(settings(0, 15))).toBe(0);
    expect(effectiveChatCapUsd(settings(9, 0))).toBe(0);
    expect(effectiveChatCapUsd(settings(9, 7.77))).toBe(4.66);
    expect(effectiveChatCapUsd(settings(2.345, 100))).toBe(2.34);
    expect(effectiveChatCapUsd(settings(Number.NaN, 15))).toBe(0);
    expect(effectiveChatCapUsd(settings(-1, 15))).toBe(0);
  });
});

describe("chatSpentTodayUsd (§3.4)", () => {
  it("sums feature chat since his local midnight, keyset-paged on id, with the signal", async () => {
    const calls = fakeDb([rows(1000, 1, "0.002"), rows(3, 1001, 0.5)]);
    const signal = new AbortController().signal;
    const spent = await chatSpentTodayUsd(principal, new Date("2026-11-07T15:00:00.000Z"), { signal });
    expect(spent).toBeCloseTo(2 + 1.5, 6);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.table).toBe("exec_ai_usage");
      expect(c.ops).toContainEqual(["select", "id,cost_usd"]);
      expect(c.ops).toContainEqual(["eq", "principal_id", "ep_owner"]);
      expect(c.ops).toContainEqual(["eq", "feature", "chat"]);
      expect(c.ops).toContainEqual(["gte", "created_at", "2026-11-07T05:00:00.000Z"]);
      expect(c.ops).toContainEqual(["abortSignal", signal]);
    }
    expect(calls[0].ops).toContainEqual(["gt", "id", 0]);
    expect(calls[1].ops).toContainEqual(["gt", "id", 1000]);
  });

  it("throws on a read error, with no content in the message (fail closed)", async () => {
    fakeDb([{ error: { message: "permission denied for table exec_ai_usage" } }]);
    const err = await chatSpentTodayUsd(principal, new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("exec_ai_usage read failed (chat spend)");
  });

  it("throws for an aborted signal before reading, and past 50 full pages", async () => {
    const calls = fakeDb([rows(1000)]);
    const c = new AbortController();
    c.abort();
    await expect(chatSpentTodayUsd(principal, new Date(), { signal: c.signal })).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
    await expect(chatSpentTodayUsd(principal, new Date())).rejects.toThrow(/not guessing/);
    expect(calls).toHaveLength(50);
  });
});
