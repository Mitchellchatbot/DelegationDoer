import { beforeEach, describe, expect, it, vi } from "vitest";

// P8 contract §5.2 (LG08-LG10): the legacy-side gate. The stores are mocked at the module boundary (Area A's brief store,
// Area D's installationFactsForSystem); principal.ts's loader is tested itself in principal.test.ts (OW12).

vi.mock("@/lib/exec/access", () => ({ isExecEnabled: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadOwnerBriefRowForLegacy: vi.fn() }));
vi.mock("@/lib/exec/brief-store", () => ({
  briefSchemaReady: vi.fn(),
  getBriefDayFactsForSystem: vi.fn(),
  getLegacyBriefMeta: vi.fn(),
  isBriefSchemaMissing: vi.fn(),
  legacyDeliveredBetween: vi.fn()
}));
vi.mock("@/lib/exec/slack-install", () => ({ installationFactsForSystem: vi.fn() }));

import fixture from "@/lib/exec/__tests__/fixtures/brief-ownership.json";
import { isExecEnabled } from "@/lib/exec/access";
import { legacyBriefGate, legacyCheckinVerdict, type LegacyBriefDecision } from "@/lib/exec/brief-legacy-gate";
import { briefSchemaReady, getBriefDayFactsForSystem, getLegacyBriefMeta, isBriefSchemaMissing, legacyDeliveredBetween } from "@/lib/exec/brief-store";
import type { BriefOwner, BriefOwnershipFacts } from "@/lib/exec/brief-types";
import { loadOwnerBriefRowForLegacy, type LegacyOwnerBriefRow } from "@/lib/exec/principal";
import { installationFactsForSystem } from "@/lib/exec/slack-install";

const OWNER = "mitchell@scaledai.org";
const NOW = new Date("2026-11-06T13:05:00Z");   // 08:05 EST
const PID = "ep_1";

class FakeStoreError extends Error {
  constructor(readonly pgCode: string | null) {
    super(`store failed${pgCode ? ` (${pgCode})` : ""}`);
  }
}
const MISSING = new Set(["42P01", "PGRST205"]);

const ownerRow = (o: Partial<LegacyOwnerBriefRow> = {}): LegacyOwnerBriefRow => ({
  principalId: PID, enabled: true, briefEnabled: true, supersede: true, checkinsEnabled: true, briefLocalTime: "08:00",
  briefTimezone: "America/New_York", ...o
});
type DayFacts = { exists: boolean; owner: BriefOwner | null; delivered: boolean; fallbackSent: boolean };
const noDay: DayFacts = { exists: false, owner: null, delivered: false, fallbackSent: false };

/** Every read answers from the seven M1 facts (execEnabled = EXEC_ENABLED ∧ the principal enabled, C2). */
function armFacts(f: BriefOwnershipFacts): void {
  vi.mocked(isExecEnabled).mockReturnValue(true);
  vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValue({ state: "ok", row: ownerRow({ enabled: f.execEnabled, briefEnabled: f.briefEnabled, supersede: f.supersede }) });
  vi.mocked(briefSchemaReady).mockResolvedValue(f.tablesReady);
  vi.mocked(installationFactsForSystem).mockResolvedValue({ schema: true, active: f.installationActive, readingActive: false });
  vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(f.execDeliveredToday ? { exists: true, owner: "exec", delivered: true, fallbackSent: false } : noDay);
  vi.mocked(legacyDeliveredBetween).mockResolvedValue(f.legacyDeliveredToday);
}

beforeEach(() => {
  vi.mocked(isBriefSchemaMissing).mockImplementation((err) => err instanceof FakeStoreError && err.pgCode !== null && MISSING.has(err.pgCode));
  armFacts({ execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: true, execDeliveredToday: false, legacyDeliveredToday: false });
  vi.mocked(getLegacyBriefMeta).mockResolvedValue(null);
});

describe("legacyBriefGate (M1, legacy side)", () => {
  it("EXEC_ENABLED off → run (exec_disabled), with no read at all", async () => {
    vi.mocked(isExecEnabled).mockReturnValue(false);
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "exec_disabled", ranWhileSuperseded: false });
    expect(loadOwnerBriefRowForLegacy).not.toHaveBeenCalled();
    expect(briefSchemaReady).not.toHaveBeenCalled();
  });

  it("LG08 exec not installed → run (not_installed); the owner without a principal → run (no_principal)", async () => {
    vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValueOnce({ state: "not_installed" });
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "not_installed", ranWhileSuperseded: false });
    vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValueOnce({ state: "no_principal" });
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "no_principal", ranWhileSuperseded: false });
    expect(briefSchemaReady).not.toHaveBeenCalled();
    // The P8 tables missing (the probe says so, or a store throws schema-missing) → not_installed too.
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "not_installed", ranWhileSuperseded: false });
    expect(getBriefDayFactsForSystem).not.toHaveBeenCalled();
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValueOnce("not_installed");
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "not_installed", ranWhileSuperseded: false });
    vi.mocked(getBriefDayFactsForSystem).mockRejectedValueOnce(new FakeStoreError("42P01"));
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "not_installed", ranWhileSuperseded: false });
  });

  // One row per M1 outcome, taken from the lead's table (OW01) by index (the fixture's bit order).
  const REPRESENTATIVE = [0b0000000, 0b1000000, 0b1100100, 0b1100010, 0b1110001, 0b1110000, 0b1111000, 0b1111100];
  it("LG08 the M1 table through the gate (8 representative rows) matches OW01", () => {
    const reasons = new Set(REPRESENTATIVE.map((i) => fixture.rows[i].reason));
    expect(reasons).toEqual(new Set(["exec_disabled", "not_installed", "exec_delivered", "brief_off", "legacy_delivered", "not_superseding", "no_installation", "owns"]));
  });
  it.each(REPRESENTATIVE)("LG08 row %i", async (i) => {
    const row = fixture.rows[i];
    armFacts(row.facts as BriefOwnershipFacts);
    const d: LegacyBriefDecision = await legacyBriefGate(OWNER, NOW);
    expect(d.run).toBe(row.owner !== "exec");
    if (row.owner === "exec") expect(d).toEqual({ run: false, reason: row.reason === "exec_delivered" ? "exec_delivered" : "exec_owns" });
    else {
      const reason = row.reason === "exec_disabled" || row.reason === "not_installed" ? row.reason : "legacy_owns";
      expect(d).toEqual({ run: true, reason, ranWhileSuperseded: reason === "legacy_owns" && row.facts.briefEnabled && row.facts.supersede });
    }
  });

  it("LG08 every row of the table: the gate runs legacy exactly when the predicate's owner isn't exec", async () => {
    for (const [i, row] of fixture.rows.entries()) {
      armFacts(row.facts as BriefOwnershipFacts);
      const d = await legacyBriefGate(OWNER, NOW);
      expect(d.run, `row ${i}`).toBe(row.owner !== "exec");
    }
  });

  it("ranWhileSuperseded is the stored briefEnabled ∧ supersede on a legacy_owns day", async () => {
    armFacts({ execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: false, execDeliveredToday: false, legacyDeliveredToday: false });
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "legacy_owns", ranWhileSuperseded: true });
    armFacts({ execEnabled: true, tablesReady: true, briefEnabled: true, supersede: false, installationActive: true, execDeliveredToday: false, legacyDeliveredToday: false });
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "legacy_owns", ranWhileSuperseded: false });
  });

  it("the day is the owner's brief-zone date, with its local-midnight bounds", async () => {
    vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValue({ state: "ok", row: ownerRow({ briefTimezone: "Asia/Manila" }) });
    await legacyBriefGate(OWNER, new Date("2026-11-06T17:00:00Z"));   // 01:00 on 2026-11-07 in Manila
    expect(getBriefDayFactsForSystem).toHaveBeenCalledWith(PID, "2026-11-07");
    expect(legacyDeliveredBetween).toHaveBeenCalledWith("2026-11-06T16:00:00.000Z", "2026-11-07T16:00:00.000Z");
    expect(installationFactsForSystem).toHaveBeenCalledWith(PID);
  });

  it("an installation table that's missing (facts.schema false) reads as no installation", async () => {
    vi.mocked(installationFactsForSystem).mockResolvedValue({ schema: false, active: false, readingActive: false });
    await expect(legacyBriefGate(OWNER, NOW)).resolves.toEqual({ run: true, reason: "legacy_owns", ranWhileSuperseded: true });
  });

  it.each([
    ["loadOwnerBriefRowForLegacy", () => vi.mocked(loadOwnerBriefRowForLegacy).mockRejectedValue(new Error("users read failed (57014)"))],
    ["briefSchemaReady", () => vi.mocked(briefSchemaReady).mockRejectedValue(new FakeStoreError("08006"))],
    ["installationFactsForSystem", () => vi.mocked(installationFactsForSystem).mockRejectedValue(new FakeStoreError("57014"))],
    ["getBriefDayFactsForSystem", () => vi.mocked(getBriefDayFactsForSystem).mockRejectedValue(new FakeStoreError(null))],
    ["legacyDeliveredBetween", () => vi.mocked(legacyDeliveredBetween).mockRejectedValue(new FakeStoreError("57P01"))]
  ])("LG09 a non-missing read error from %s throws", async (_name, arm) => {
    arm();
    await expect(legacyBriefGate(OWNER, NOW)).rejects.toThrow();
  });

  it("never returns a principal: only run, reason and ranWhileSuperseded", async () => {
    for (const row of fixture.rows) {
      armFacts(row.facts as BriefOwnershipFacts);
      const d = await legacyBriefGate(OWNER, NOW);
      expect(Object.keys(d).every((k) => ["run", "reason", "ranWhileSuperseded"].includes(k))).toBe(true);
    }
  });
});

describe("legacyCheckinVerdict (M1, C37)", () => {
  const BID = "brief_2026-11-06";
  const day = (o: Partial<DayFacts>): DayFacts => ({ exists: true, owner: "exec", delivered: false, fallbackSent: false, ...o });

  it("LG10 exec owned and delivered that date → expired; a fallback stamp alone → expired", async () => {
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ delivered: true }));
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("expired");
    expect(getBriefDayFactsForSystem).toHaveBeenCalledWith(PID, "2026-11-06");
    expect(getLegacyBriefMeta).toHaveBeenCalledWith(BID);
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ fallbackSent: true }));
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("expired");
  });

  it("LG10 owner exec_page_only, or exec without a delivery stamp, or no row → valid", async () => {
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ owner: "exec_page_only", delivered: true }));
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({}));
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(noDay);
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
  });

  it("LG10 the legacy row's meta.ranWhileSuperseded keeps its buttons valid", async () => {
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ delivered: true }));
    vi.mocked(getLegacyBriefMeta).mockResolvedValue({ ranWhileSuperseded: true });
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(getLegacyBriefMeta).mockResolvedValue({ ranWhileSuperseded: false });
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("expired");
  });

  it.each(["brief_2026-11-6", "msg_2026-11-06", "brief_2026-11-06x", "", "brief_2026-11-06\nbrief_2026-11-07"])("LG10 a bad brief id %j → valid, no read", async (id) => {
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ delivered: true }));
    await expect(legacyCheckinVerdict(OWNER, id, NOW)).resolves.toBe("valid");
    expect(loadOwnerBriefRowForLegacy).not.toHaveBeenCalled();
  });

  it("LG10 EXEC_ENABLED off, exec not installed, no principal → valid", async () => {
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValue(day({ delivered: true }));
    vi.mocked(isExecEnabled).mockReturnValueOnce(false);
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValueOnce({ state: "not_installed" });
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(loadOwnerBriefRowForLegacy).mockResolvedValueOnce({ state: "no_principal" });
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
    vi.mocked(getBriefDayFactsForSystem).mockResolvedValueOnce("not_installed");
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).resolves.toBe("valid");
  });

  it.each([
    ["loadOwnerBriefRowForLegacy", () => vi.mocked(loadOwnerBriefRowForLegacy).mockRejectedValue(new Error("users read failed (57014)"))],
    ["getLegacyBriefMeta", () => vi.mocked(getLegacyBriefMeta).mockRejectedValue(new FakeStoreError("57014"))],
    ["getBriefDayFactsForSystem", () => vi.mocked(getBriefDayFactsForSystem).mockRejectedValue(new FakeStoreError(null))]
  ])("LG10 a read error from %s throws", async (_name, arm) => {
    arm();
    await expect(legacyCheckinVerdict(OWNER, BID, NOW)).rejects.toThrow();
  });
});
