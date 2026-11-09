import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSyncState, putSyncState, releaseLease, tryAcquireLease, type LeaseKey } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { createFakePostgrest, type FakePostgrest } from "./__tests__/fake-postgrest";

// P7a contract §3.20.1 (Area A; AM-P7a-7): the "slack" source and the three Slack reading leases, stored under it.
// The earlier "unknown source" assertions (sync-state.test.ts, sync-state-ea.test.ts, sync-state-ddtext.test.ts) now use
// another name, since "slack" is a real source.

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

describe("the slack source", () => {
  it("is accepted for get / put", async () => {
    await putSyncState(principal, "slack", "cursor", { at: "2026-11-20T12:00:00.000Z" });
    expect(await getSyncState(principal, "slack", "cursor", parseAny)).toEqual({ value: { at: "2026-11-20T12:00:00.000Z", rev: 1 }, rev: 1 });
    await expect(getSyncState(principal, "bogus" as "slack", "k", parseAny)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("the three reading leases live under source slack, one holder each, independent of each other", async () => {
    for (const key of ["slack-discover-lease", "slack-sweep-lease", "slack-attention-lease"] as LeaseKey[]) {
      expect(await tryAcquireLease(principal, key, "w1:1", 300_000, T0)).toBe(true);
      expect(stored("slack", key)?.cursor).toEqual({ holder: "w1:1", leaseUntil: "2026-11-20T12:05:00.000Z", rev: 1 });
      expect(await tryAcquireLease(principal, key, "w2:2", 300_000, new Date("2026-11-20T12:04:59.000Z"))).toBe(false);
      await releaseLease(principal, key, "w1:1");
      expect(stored("slack", key)?.cursor).toMatchObject({ holder: null, leaseUntil: null });
    }
    expect(db.tables.exec_sync_state.map((r) => `${r.source}/${r.key}`).sort()).toEqual([
      "slack/slack-attention-lease", "slack/slack-discover-lease", "slack/slack-sweep-lease"
    ]);
  });
});
