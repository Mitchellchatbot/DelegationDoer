import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/sources/dd", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, listTaskThreadLinks: vi.fn(), listPendingApprovalItems: vi.fn() };
});
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", () => ({ loadScreeningPolicy: vi.fn(), screenRestricted: vi.fn(), screenStoredRow: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { intakeThreadIdsForTasks } from "@/lib/exec/intake-screen";
import { listTaskThreadLinks } from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";

// P5b §3.0.1 (AM6): intakeThreadIdsForTasks, thread ids only, for get_task's consulted set (C19, C25).

const principal = { id: "ep_1", userId: "u_m" } as unknown as ExecPrincipal;

beforeEach(() => {
  vi.mocked(listTaskThreadLinks).mockResolvedValue([
    { taskId: "t_1", threadIds: ["th_a", "th_b", "th_a"], clientEmail: "SECRET@client.io" },
    { taskId: "t_2", threadIds: [], clientEmail: "other@client.io" }
  ]);
});

describe("intakeThreadIdsForTasks", () => {
  it("maps each linked task to its thread ids, never the recorded sender; tasks with no thread are absent", async () => {
    const signal = new AbortController().signal;
    const out = await intakeThreadIdsForTasks(principal, ["t_1", "t_2", "t_1", ""], { signal });
    expect(vi.mocked(listTaskThreadLinks)).toHaveBeenCalledWith(principal, ["t_1", "t_2"], { signal });
    expect([...out]).toEqual([["t_1", ["th_a", "th_b"]]]);
    expect(JSON.stringify([...out])).not.toContain("SECRET");
  });

  it("no ids → no read; a read failure throws (the caller withholds)", async () => {
    expect((await intakeThreadIdsForTasks(principal, [])).size).toBe(0);
    expect(vi.mocked(listTaskThreadLinks)).not.toHaveBeenCalled();
    vi.mocked(listTaskThreadLinks).mockRejectedValue(new Error("down"));
    await expect(intakeThreadIdsForTasks(principal, ["t_1"])).rejects.toThrow("down");
  });
});
