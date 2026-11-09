import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  casSyncState,
  getSyncState,
  putSyncState,
  releaseLease,
  tryAcquireLease,
  type LeaseKey
} from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { createFakePostgrest, type FakePostgrest } from "./__tests__/fake-postgrest";

// P5a contract §3.12.8, test 62 (K16, coherence-18): the "ddtext" source beside
// mail, email and P4's clone-ea, and the ddtext-lease under source ddtext. P3's
// lease tests (sync-state.test.ts) and P4's PX06 tests (sync-state-ea.test.ts)
// are unchanged.

const principal = { id: "ep_1", userId: "u_1" } as unknown as ExecPrincipal;
const T0 = new Date("2026-11-20T12:00:00.000Z");
const parseAny = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);

let db: FakePostgrest;
beforeEach(() => {
  db = createFakePostgrest({ tables: { exec_sync_state: [] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const stored = (source: string, key: string) => db.tables.exec_sync_state.find((r) => r.source === source && r.key === key);

describe("the ddtext source", () => {
  it("is accepted beside mail, email and clone-ea for get / put / cas", async () => {
    await putSyncState(principal, "ddtext", "cursor", { startedAt: "2026-11-20T12:00:00.000Z" });
    expect(stored("ddtext", "cursor")?.cursor).toEqual({ startedAt: "2026-11-20T12:00:00.000Z", rev: 1 });
    expect(await getSyncState(principal, "ddtext", "cursor", parseAny)).toEqual({ value: { startedAt: "2026-11-20T12:00:00.000Z", rev: 1 }, rev: 1 });
    expect(await casSyncState(principal, "ddtext", "cursor", 1, { startedAt: "2026-11-20T12:10:00.000Z" })).toBe(true);
    expect(await casSyncState(principal, "ddtext", "cursor", 1, { startedAt: "2026-11-20T12:20:00.000Z" })).toBe(false);
    for (const source of ["mail", "email", "clone-ea"] as const) {
      await putSyncState(principal, source, "k", { a: 1 });
      expect(stored(source, "k")?.cursor).toEqual({ a: 1, rev: 1 });
    }
    await expect(getSyncState(principal, "bogus" as "ddtext", "k", parseAny)).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("ddtext-lease", () => {
  it("acquires under source ddtext, refuses another holder until expiry, then takes over; release frees it for its holder only", async () => {
    expect(await tryAcquireLease(principal, "ddtext-lease", "w1:1", 300_000, T0)).toBe(true);
    expect(stored("ddtext", "ddtext-lease")?.cursor).toEqual({ holder: "w1:1", leaseUntil: "2026-11-20T12:05:00.000Z", rev: 1 });
    expect(stored("email", "ddtext-lease")).toBeUndefined();
    expect(await tryAcquireLease(principal, "ddtext-lease", "w2:2", 300_000, new Date("2026-11-20T12:04:59.000Z"))).toBe(false);
    expect(await tryAcquireLease(principal, "ddtext-lease", "w2:2", 300_000, new Date("2026-11-20T12:05:00.000Z"))).toBe(true);
    await releaseLease(principal, "ddtext-lease", "w1:1");
    expect(stored("ddtext", "ddtext-lease")?.cursor).toMatchObject({ holder: "w2:2" });
    await releaseLease(principal, "ddtext-lease", "w2:2");
    expect(stored("ddtext", "ddtext-lease")?.cursor).toMatchObject({ holder: null, leaseUntil: null });
  });

  it("is independent of the attention lease, which stays under source email", async () => {
    expect(await tryAcquireLease(principal, "attention-lease", "w1", 180_000, T0)).toBe(true);
    expect(await tryAcquireLease(principal, "ddtext-lease", "w2", 180_000, T0)).toBe(true);
    expect(stored("email", "attention-lease")?.cursor).toMatchObject({ holder: "w1" });
    expect(stored("ddtext", "ddtext-lease")?.cursor).toMatchObject({ holder: "w2" });
    expect(db.tables.exec_sync_state.map((r) => `${r.source}/${r.key}`).sort()).toEqual(["ddtext/ddtext-lease", "email/attention-lease"]);
  });

  it("refuses an unknown lease key for good; release logs it and never throws", async () => {
    await expect(tryAcquireLease(principal, "other-lease" as LeaseKey, "w1", 1000, T0)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(releaseLease(principal, "other-lease" as LeaseKey, "w1")).resolves.toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("could not release ?/other-lease");
    expect(db.queries).toEqual([]);
  });
});
