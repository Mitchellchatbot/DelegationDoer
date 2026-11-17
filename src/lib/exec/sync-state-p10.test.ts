import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createFakePostgrest } from "@/lib/exec/__tests__/fake-postgrest";
import { parseLeadRunSummary, parseOptoutSeen, parseReplyCursor, parseReplyTokenHealth, parseTokenHealthState, tryAcquireLease } from "@/lib/exec/sync-state";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 (contract §3.12, §2.3, C21; Area A owns the parsers from stage 1; AM-P10-9): the slack/lead-run summary, the reply sweep's
// slack-reply keys and the lead lease. Counts, codes, times, DD task ids and positions only: anything else is dropped (never a
// channel id, a name or text).

const SUMMARY = {
  at: "2026-11-10T15:00:00.000Z", complete: true, partial: false, needsFinal: 2, channels: 6, counted: 5, pages: 9, listedNotMember: 2, classifyEnqueued: 1,
  errors: { not_in_channel: 1 }, failingRuns: 0, failCode: null, notMember: [{ taskId: "t_acme_onb", i: 1 }, { taskId: "t_zenith_onb", i: 2 }]
};

describe("parseLeadRunSummary (slack / lead-run)", () => {
  it("parses a stored summary; the v1.1 fields default (failCode null, notMember [], the counts 0)", () => {
    expect(parseLeadRunSummary(SUMMARY)).toEqual(SUMMARY);
    const { listedNotMember: _a, classifyEnqueued: _b, failingRuns: _c, failCode: _d, notMember: _e, errors: _f, ...required } = SUMMARY;
    expect(parseLeadRunSummary(required)).toEqual({ ...required, listedNotMember: 0, classifyEnqueued: 0, failingRuns: 0, failCode: null, notMember: [], errors: {} });
  });

  it("a missing or malformed required field → null; a bad failCode → null", () => {
    for (const k of ["at", "complete", "partial", "needsFinal", "channels", "counted", "pages"] as const) {
      const { [k]: _gone, ...rest } = SUMMARY;
      expect(parseLeadRunSummary(rest), k).toBeNull();
    }
    expect(parseLeadRunSummary({ ...SUMMARY, at: "yesterday" })).toBeNull();
    expect(parseLeadRunSummary({ ...SUMMARY, pages: -1 })).toBeNull();
    expect(parseLeadRunSummary({ ...SUMMARY, failCode: "Not A Code" })).toBeNull();
    expect(parseLeadRunSummary({ ...SUMMARY, failCode: "store_error" })?.failCode).toBe("store_error");
    expect(parseLeadRunSummary(null)).toBeNull();
    expect(parseLeadRunSummary("{}")).toBeNull();
  });

  it("C21 / product-10: errors keep only snake_case codes with whole counts; notMember keeps <= 50 well-formed { taskId, i } (i 0..11), never a name or id", () => {
    const p = parseLeadRunSummary({ ...SUMMARY,
      errors: { not_in_channel: 2, "C0LEADVOB1": 1, zenith_house_vob_leads: 1.5, ratelimited: -1, timeout: 3 },
      notMember: [{ taskId: "t_ok", i: 0 }, { taskId: "zenith house", i: 1 }, { taskId: "t_ok", i: 12 }, { taskId: "t_ok", i: 2, name: "zenith-house-vob-leads" },
        { taskId: "C0LEADNOT1" }, "t_x", null, ...Array.from({ length: 60 }, (_, i) => ({ taskId: `t_${i}`, i: i % 12 }))] });
    expect(p?.errors).toEqual({ not_in_channel: 2, timeout: 3 });
    expect(p?.notMember).toHaveLength(50);
    expect(p?.notMember.slice(0, 2)).toEqual([{ taskId: "t_ok", i: 0 }, { taskId: "t_ok", i: 2 }]);
    expect(JSON.stringify(p)).not.toMatch(/zenith-house|C0LEADVOB1|name/);
  });
});

describe("the slack-reply keys and the lead lease", () => {
  it("parseReplyCursor { afterId } (a non-negative purge-log id); parseOptoutSeen { at } (an ISO time)", () => {
    expect(parseReplyCursor({ afterId: 42 })).toEqual({ afterId: 42 });
    expect(parseReplyCursor({ afterId: -1 })).toBeNull();
    expect(parseReplyCursor({})).toBeNull();
    expect(parseOptoutSeen({ at: "2026-11-10T15:00:00.000Z" })).toEqual({ at: "2026-11-10T15:00:00.000Z" });
    expect(parseOptoutSeen({ at: "soon" })).toBeNull();
  });

  it("parseReplyTokenHealth is P8's TokenHealthState rule on P10's own key (C60)", () => {
    for (const v of [{ state: "ok", checkedAt: "2026-11-10T06:10:00.000Z" }, { state: "mismatch", checkedAt: "2026-11-10T06:10:00.000Z" }, { state: "weird" }, null]) {
      expect(parseReplyTokenHealth(v)).toEqual(parseTokenHealthState(v));
    }
    expect(parseReplyTokenHealth({ state: "ok", checkedAt: "2026-11-10T06:10:00.000Z" })).toEqual({ state: "ok", checkedAt: "2026-11-10T06:10:00.000Z" });
  });

  it("the lead job's lease (slack-leads-lease) is stored under source slack", async () => {
    const db = createFakePostgrest({ tables: { exec_sync_state: [] } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    expect(await tryAcquireLease({ id: "ep_1" } as unknown as ExecPrincipal, "slack-leads-lease", "w1", 330_000, new Date("2026-11-10T15:00:00.000Z"))).toBe(true);
    expect(db.tables.exec_sync_state.map((r) => [r.principal_id, r.source, r.key])).toEqual([["ep_1", "slack", "slack-leads-lease"]]);
  });
});
