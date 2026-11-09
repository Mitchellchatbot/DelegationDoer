import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/attention", () => ({ lastAttentionRefresh: vi.fn(), syncAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn() }));
vi.mock("@/lib/exec/ddtext-store", () => ({ ddtextLastRunAt: vi.fn() }));
vi.mock("@/lib/exec/email-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/email-view")>()), loadEmailGate: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  getPendingApprovals: vi.fn(),
  listActivitySince: vi.fn(),
  listDepartments: vi.fn(),
  listEodNotesForDate: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listTasksByIds: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listTasksCreatedBetween: vi.fn(),
  listTimeEntriesBetween: vi.fn(),
  listUsers: vi.fn()
}));
// The P8 reads the System card and the card make, at their module boundaries.
vi.mock("@/lib/exec/brief-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-view")>()), getBriefSystemView: vi.fn(), getBriefCardView: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), spentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/settings", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/settings")>()), spendTodayByFeature: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));

import { SystemSection } from "@/components/exec/overview/SystemSection";
import { lastAttentionRefresh } from "@/lib/exec/attention";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import { getBriefCardView, getBriefSystemView } from "@/lib/exec/brief-view";
import { loadEmailGate } from "@/lib/exec/email-view";
import { refusalsSince, spentTodayUsd } from "@/lib/exec/llm/usage";
import { BRIEF_BUILD_JOB, getOverview, type OverviewBriefSystem, type OverviewSystem } from "@/lib/exec/overview";
import { spendTodayByFeature } from "@/lib/exec/settings";
import * as dd from "@/lib/exec/sources/dd";
import { getSyncState, parseTokenHealthState } from "@/lib/exec/sync-state";
import type { ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { NOW, briefSettings, cardView, principal } from "../__tests__/brief-ui-fixtures";

// P8 contract §5.16 (Area E) and B's OP04-OP08 request: the Overview's P8 parts. The System card's brief, check-in token
// and AI rows (OP05, OP06), exec.brief tracked while the brief is on (OP07), the earlier rows still there (OP08), the
// brief card section (UI20's data half), and llm/usage.ts refusalsSince (C40).

const SYSTEM_ROW: OverviewBriefSystem = {
  localDate: "2026-11-09", owner: "exec", ownerReason: "owns", status: "delivered", statusReason: null, channel: "exec_bot", mode: "ai", modeReason: null,
  builtAt: null, deliveredAt: "2026-11-09T13:02:00.000Z", fallbackSentAt: null, fallbackErrorCode: null, legacyDeliveredToday: false,
  checkins: { proposed: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 0 }
};

interface Query { table: string; columns: string | null; options: unknown; filters: unknown[][] }
let queries: Query[];

/** A PostgREST stand-in: every query answers no rows (and count 7), recorded. */
function recordingClient(answer: { data?: unknown; error?: unknown; count?: number } = {}): SupabaseClient {
  return {
    from(table: string) {
      const q: Query = { table, columns: null, options: null, filters: [] };
      queries.push(q);
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        if (name === "select") {
          q.columns = args[0] as string;
          q.options = args[1] ?? null;
        } else q.filters.push([name, ...args]);
        return builder;
      };
      for (const m of ["select", "eq", "gte", "gt", "lt", "lte", "or", "order", "range", "limit", "abortSignal", "in", "is", "not"]) builder[m] = chain(m);
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: answer.data ?? [], error: answer.error ?? null, count: answer.count ?? 7 });
      return builder;
    }
  } as unknown as SupabaseClient;
}

const gate = (settings: Partial<ExecSettings>) => vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: briefSettings(settings) });
const system = async (opts?: { brief?: boolean }): Promise<OverviewSystem> => {
  const o = await getOverview(principal, NOW, opts);
  if (!o.sections.system.ok) throw new Error("system failed");
  return o.sections.system.data;
};

beforeEach(() => {
  queries = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(getSupabaseAdmin).mockReturnValue(recordingClient());
  for (const fn of [dd.listActivitySince, dd.listDepartments, dd.listEodNotesForDate, dd.listOpenTasks, dd.listProjects, dd.listProjectStages, dd.listStatusChangeEntries,
    dd.listTasksByIds, dd.listTasksCompletedBetween, dd.listTasksCreatedBetween, dd.listTimeEntriesBetween, dd.listUsers, dd.getPendingApprovals]) {
    vi.mocked(fn as (...a: unknown[]) => Promise<unknown>).mockResolvedValue([]);
  }
  vi.mocked(listScreenedAttention).mockResolvedValue({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" } as never);
  vi.mocked(lastAttentionRefresh).mockResolvedValue(null);
  gate({ chatSchemaReady: false });
  vi.mocked(getBriefSystemView).mockReset().mockResolvedValue(SYSTEM_ROW);
  vi.mocked(getBriefCardView).mockReset().mockResolvedValue(cardView());
  vi.mocked(spentTodayUsd).mockReset().mockResolvedValue(3.5);
  vi.mocked(spendTodayByFeature).mockReset().mockResolvedValue({ totalUsd: 3.5, capUsd: 15, byFeature: [{ feature: "brief", usd: 3 }, { feature: "chat", usd: 0.5 }] });
  vi.mocked(getSyncState).mockReset().mockResolvedValue({ value: { state: "ok", checkedAt: "2026-11-09T11:00:00.000Z" }, rev: 1 } as never);
});

describe("OP05: the AI rows (C40)", () => {
  it("spend today (the cap's own day and zone), the cap from the settings, by feature as a record, refusals in 24 hours", async () => {
    const s = await system();
    expect(s.ai).toEqual({ spentTodayUsd: 3.5, capUsd: 15, byFeature: { brief: 3, chat: 0.5 }, refusals24h: 7 });
    expect(spentTodayUsd).toHaveBeenCalledWith(principal.id, principal.timezone, NOW);
    expect(vi.mocked(spendTodayByFeature).mock.calls[0][2]).toMatchObject({ capUsd: 15 });
    const refusals = queries.find((q) => q.table === "exec_ai_usage");
    expect(refusals?.filters).toEqual(
      expect.arrayContaining([["eq", "principal_id", principal.id], ["eq", "stop_reason", "refusal"], ["gte", "created_at", "2026-11-08T14:00:00.000Z"]])
    );
    expect(refusals?.options).toEqual({ count: "exact", head: true });
  });

  it("a failed spend or refusal read → ai null (the card says couldn't load), the rest of the card stands", async () => {
    vi.mocked(spentTodayUsd).mockRejectedValue(new Error("exec_ai_usage read failed"));
    const s = await system();
    expect(s.ai).toBeNull();
    expect(s.brief).toEqual(SYSTEM_ROW);
  });
});

describe("OP06: the check-in token row (C19)", () => {
  it("from brief/token-health; none stored → unchecked; a failed read → null; check-ins off → no row", async () => {
    expect((await system()).userToken).toEqual({ state: "ok", checkedAt: "2026-11-09T11:00:00.000Z" });
    expect(getSyncState).toHaveBeenCalledWith(principal, "brief", "token-health", parseTokenHealthState, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.mocked(getSyncState).mockResolvedValue(null);
    expect((await system()).userToken).toEqual({ state: "unchecked", checkedAt: null });
    vi.mocked(getSyncState).mockRejectedValue(new Error("sync state"));
    expect((await system()).userToken).toBeNull();
    gate({ chatSchemaReady: false, checkinsEnabled: false });
    expect("userToken" in (await system())).toBe(false);
  });
});

describe("OP07: exec.brief joins the tracked kinds only while the brief is on", () => {
  it("on: listed even with no run; off: not listed, and no P8 row is read at all", async () => {
    expect(BRIEF_BUILD_JOB).toBe("exec.brief");
    expect((await system()).kinds.map((k) => k.kind)).toContain("exec.brief");
    gate({ chatSchemaReady: false, briefEnabled: false });
    vi.mocked(getBriefSystemView).mockClear();
    vi.mocked(spentTodayUsd).mockClear();
    const off = await system();
    expect(off.kinds.map((k) => k.kind)).not.toContain("exec.brief");
    expect(["brief", "userToken", "ai"].some((k) => k in off)).toBe(false);
    expect(getBriefSystemView).not.toHaveBeenCalled();
    expect(spentTodayUsd).not.toHaveBeenCalled();
  });

  it("the settings unreadable → no P8 rows (the card can't tell whether the brief is on)", async () => {
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings down"));
    const o = await getOverview(principal, NOW);
    const sys = o.sections.system;
    if (sys.ok) expect(["brief", "userToken", "ai"].some((k) => k in sys.data)).toBe(false);
  });

  it("the brief row: not installed (null) → no row; a failed read → null", async () => {
    vi.mocked(getBriefSystemView).mockResolvedValue(null);
    expect("brief" in (await system())).toBe(false);
    vi.mocked(getBriefSystemView).mockRejectedValue(new Error("exec_briefs read failed"));
    expect((await system()).brief).toBeNull();
  });
});

describe("OP08: the earlier rows still render beside the P8 ones", () => {
  it("P4's drafts rows (here: couldn't load), P6's Slack row and P7a's reading row, then the brief rows", () => {
    const data: OverviewSystem = {
      kinds: [], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null,
      drafts: null,
      slack: { state: "connected", lastDmAt: null, reading: { state: "on", lastSweepAt: null, pendingTriage: 2, blockedMethods: 0, userErrorCode: null, revokedAt: null, v2Missing: false } } as never,
      brief: SYSTEM_ROW, userToken: { state: "ok", checkedAt: null }, ai: { spentTodayUsd: 1, capUsd: 15, byFeature: {}, refusals24h: 0 }
    };
    const out = renderToStaticMarkup(createElement(SystemSection, { system: { ok: true, data }, now: NOW.toISOString(), tz: "America/New_York" }));
    const order = ["assistant drafts status", "data-slack-system", "data-slack-reading-system", "data-brief-system"].map((m) => out.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("UI20 (data half): the brief card section", () => {
  it("asked for: the card, or null (no current brief), or { ok: false } when its read failed, the rest of the Overview loading", async () => {
    expect((await getOverview(principal, NOW, { brief: true })).sections.brief).toEqual({ ok: true, data: cardView() });
    expect(getBriefCardView).toHaveBeenCalledWith(principal, NOW);
    vi.mocked(getBriefCardView).mockResolvedValue(null);
    expect((await getOverview(principal, NOW, { brief: true })).sections.brief).toEqual({ ok: true, data: null });
    vi.mocked(getBriefCardView).mockRejectedValue(new Error("exec_briefs read failed"));
    const failed = await getOverview(principal, NOW, { brief: true });
    expect(failed.sections.brief).toEqual({ ok: false, error: "unavailable" });
    expect(failed.sections.attention.ok).toBe(true);
    expect(failed.sections.system.ok).toBe(true);
  });

  it("not asked for (the brief's own gather, the agent's tools): no read, no key", async () => {
    vi.mocked(getBriefCardView).mockClear();
    const o = await getOverview(principal, NOW);
    expect("brief" in o.sections).toBe(false);
    expect(getBriefCardView).not.toHaveBeenCalled();
  });
});

describe("refusalsSince (llm/usage.ts, C40)", () => {
  it("one exact head count of his refusal rows since the time; a read error throws with the code only; bad input is a TypeError", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(recordingClient({ count: 3 }));
    expect(await refusalsSince(principal.id, "2026-11-08T14:00:00.000Z")).toBe(3);
    expect(queries[0]).toMatchObject({ table: "exec_ai_usage", columns: "id", options: { count: "exact", head: true } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(recordingClient({ error: { code: "57014", message: "canceling statement due to statement timeout" } }));
    await expect(refusalsSince(principal.id, "2026-11-08T14:00:00.000Z")).rejects.toThrow("exec_ai_usage read failed (57014)");
    await expect(refusalsSince("", "2026-11-08T14:00:00.000Z")).rejects.toThrow(TypeError);
    await expect(refusalsSince(principal.id, "yesterday")).rejects.toThrow(TypeError);
  });
});
