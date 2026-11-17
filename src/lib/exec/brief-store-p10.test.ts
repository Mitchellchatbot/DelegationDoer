import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { createFakeBriefDb, type FakeBriefDb, type FakeBriefDbSeed } from "@/lib/exec/__tests__/fake-brief-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import * as store from "@/lib/exec/brief-store";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 (contract §3.8 item 4, §3.11, C23, v1.1 correctness-3; Area A): brief-store.ts's two P10 functions, RPC 21
// exec_brief_strip_leads (stripBriefLeads / stripBriefLeadsSystem) and function 22 exec_brief_principals_with_leads
// (listPrincipalsWithBriefLeads), against P8's fake (fake-brief-db.ts, extended additively with both). The SQL suite runs the
// same cases on PGlite and real Postgres (SQ18, SQ28).

const NOW = new Date("2026-11-10T15:00:00.000Z");
const P = { id: "ep_1" } as unknown as ExecPrincipal;
const LEADS = { v: 1, localDate: "2026-11-09", rows: [{ label: "Zenith House", clientId: "cl_zen", vob: 10, nonvob: 8, calendly: 3, zapErrors: 0, complete: true,
  kinds: ["vob", "nonvob", "calendly"] }], more: 0, totals: { vob: 10, nonvob: 8, calendly: 3, zapErrors: 0 }, totalKinds: ["vob", "nonvob", "calendly"], unlinked: 0,
  incomplete: false, asOf: "2026-11-10T13:00:00.000Z", notCounted: 0, failing: false, dated: false, firstRun: false };
let n = 0;
const brief = (principal: string, leads: boolean, over: Row = {}): Row => {
  n += 1;
  return {
    id: `eb_${String(n).padStart(32, "0")}`, principal_id: principal, local_date: `2026-10-${String(n).padStart(2, "0")}`, tz: "America/New_York",
    scheduled_at: "2026-11-09T13:00:00.000Z", status: "built", mode: "ai", built_at: "2026-11-09T13:01:00.000Z",
    content: { v: 1, headline: "Two things need you today.", sections: [], top3: [], ...(leads ? { leads: LEADS } : {}) },
    content_expires_at: "2026-12-10T05:00:00.000Z", expires_at: "2027-05-09T05:00:00.000Z", ...over
  };
};

let db: FakeBriefDb;
function use(seed: FakeBriefDbSeed = {}): FakeBriefDb {
  db = createFakeBriefDb({ now: () => new Date(), ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetBriefStoreForTests();
  n = 0;
});

describe("stripBriefLeads / stripBriefLeadsSystem (RPC 21; twin of SQ18)", () => {
  it("removes only `leads` from his briefs' content (every other key kept, updated_at stamped); other principals untouched; the count of rows changed", async () => {
    use({ tables: { exec_briefs: [brief("ep_1", true), brief("ep_1", false), brief("ep_2", true), brief("ep_1", true, { content: null, status: "failed", mode: null,
      built_at: null })] } });
    const before = structuredClone(db.tables.exec_briefs[0].content) as Row;
    expect(await store.stripBriefLeads(P)).toBe(1);
    const { leads: _dropped, ...rest } = before;
    expect(db.tables.exec_briefs[0].content).toEqual(rest);
    expect(db.tables.exec_briefs[0].updated_at).toBe(NOW.toISOString());
    expect(Object.prototype.hasOwnProperty.call(db.tables.exec_briefs[2].content, "leads")).toBe(true);
    expect(await store.stripBriefLeads(P)).toBe(0);
    expect(await store.stripBriefLeadsSystem("ep_2")).toBe(1);
    expect(db.calls.filter((c) => c.target === "exec_brief_strip_leads").map((c) => c.payload)).toEqual([{ p_principal: "ep_1" }, { p_principal: "ep_1" },
      { p_principal: "ep_2" }]);
  });

  it("null while the function is missing (P10's migration not applied); another error throws a code-only error; a bad id is a TypeError", async () => {
    use({ missing: ["exec_brief_strip_leads"] });
    expect(await store.stripBriefLeads(P)).toBeNull();
    expect(await store.stripBriefLeadsSystem("ep_1")).toBeNull();
    db.missing.clear();
    db.failNext("exec_brief_strip_leads", "57014");
    await expect(store.stripBriefLeadsSystem("ep_1")).rejects.toThrow(/^exec brief store: stripBriefLeads(System)? failed \(57014\)$/);
    await expect(store.stripBriefLeadsSystem("")).rejects.toThrow(TypeError);
  });
});

describe("listPrincipalsWithBriefLeads (function 22; v1.1 correctness-3; twin of SQ28)", () => {
  it("exactly the principals with a stored brief holding `leads`, distinct, ordered, <= the limit; [] while missing", async () => {
    use({ tables: { exec_briefs: [brief("ep_2", true), brief("ep_1", true), brief("ep_1", true), brief("ep_3", false)] } });
    expect(await store.listPrincipalsWithBriefLeads(100)).toEqual(["ep_1", "ep_2"]);
    expect(await store.listPrincipalsWithBriefLeads(1)).toEqual(["ep_1"]);
    expect(db.calls.filter((c) => c.target === "exec_brief_principals_with_leads").map((c) => c.payload)).toEqual([{ p_limit: 100 }, { p_limit: 1 }]);
    await store.stripBriefLeads(P);
    expect(await store.listPrincipalsWithBriefLeads(100)).toEqual(["ep_2"]);
    db.missing.add("exec_brief_principals_with_leads");
    expect(await store.listPrincipalsWithBriefLeads(100)).toEqual([]);
  });

  it("an answer that isn't a list of principal ids is malformed (code-only error)", async () => {
    use({ fail: (c) => (c.target === "exec_brief_principals_with_leads" ? null : null) });
    const rpc = vi.spyOn(db.client as { rpc: (fn: string, a: unknown) => unknown }, "rpc").mockReturnValue(
      { abortSignal: () => Promise.resolve({ data: { not: "a list" }, error: null }), then: (f: (v: unknown) => unknown) => f({ data: { not: "a list" }, error: null }) });
    await expect(store.listPrincipalsWithBriefLeads(10)).rejects.toThrow(/^exec brief store: listPrincipalsWithBriefLeads: malformed answer failed$/);
    rpc.mockRestore();
  });
});
