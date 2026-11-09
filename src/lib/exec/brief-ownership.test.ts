import { beforeEach, describe, expect, it, vi } from "vitest";

// P8 contract §5.1 (OW01-OW11): the M1 predicate over the lead's 128-row table, the cutoff, the watchdog's time, the TTLs
// and the exec-side loaders. The stores are mocked at the module boundary (Area A's and D's stores are other areas' files);
// each mock answers like the store's contract (§3.4, §3.21.3) over a small in-test table.

vi.mock("@/lib/exec/access", () => ({ isExecEnabled: vi.fn() }));
vi.mock("@/lib/exec/brief-store", () => ({
  briefSchemaReady: vi.fn(),
  getBriefByDate: vi.fn(),
  legacyDeliveredBetween: vi.fn(),
  legacyBriefInFlight: vi.fn(),
  countPendingCheckins: vi.fn(),
  isBriefSchemaMissing: vi.fn()
}));
vi.mock("@/lib/exec/slack-install", () => ({ getActiveInstallation: vi.fn(), isSlackSchemaMissing: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn() };
});

import fixture from "@/lib/exec/__tests__/fixtures/brief-ownership.json";
import { isExecEnabled } from "@/lib/exec/access";
import {
  briefExpiries,
  briefOwnership,
  catchUpCutoff,
  legacyMayRun,
  mayDmAt,
  scheduledInstant,
  watchdogRunAfter
} from "@/lib/exec/brief-ownership";
import { checkinApprovalSource, loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import {
  briefSchemaReady, countPendingCheckins, getBriefByDate, isBriefSchemaMissing, legacyBriefInFlight, legacyDeliveredBetween
} from "@/lib/exec/brief-store";
import type { BriefOwnershipFacts, BriefRow } from "@/lib/exec/brief-types";
import { loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { getActiveInstallation, isSlackSchemaMissing } from "@/lib/exec/slack-install";
import type { InstallationRow } from "@/lib/exec/slack-types";
import { localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

const FACT_NAMES = fixture.facts as (keyof BriefOwnershipFacts)[];

function principal(tz = NY): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const settings = (o: Partial<ExecSettings> = {}): ExecSettings => ({ ...settingsFromRow(null, "ep_1"), ...o });

// ---------------------------------------------------------------------------------------------------------------------
// OW01-OW03: the predicate
// ---------------------------------------------------------------------------------------------------------------------

describe("briefOwnership (M1)", () => {
  it("OW01 every one of the 128 rows of the lead's table maps to its verdict and reason", () => {
    expect(fixture.rows).toHaveLength(128);
    expect(FACT_NAMES).toEqual(["execEnabled", "tablesReady", "briefEnabled", "supersede", "installationActive", "execDeliveredToday", "legacyDeliveredToday"]);
    const tally: Record<string, number> = {};
    fixture.rows.forEach((row, i) => {
      // The fixture's row order is its own documented bit order (row 0 all false, row 127 all true).
      FACT_NAMES.forEach((name, k) => expect((row.facts as Record<string, boolean>)[name], `row ${i} ${name}`).toBe(((i >> (6 - k)) & 1) === 1));
      const v = briefOwnership(row.facts as BriefOwnershipFacts);
      expect(v, `row ${i}`).toEqual({ owner: row.owner, reason: row.reason });
      tally[`${v.owner}/${v.reason}`] = (tally[`${v.owner}/${v.reason}`] ?? 0) + 1;
    });
    expect(tally).toEqual(fixture.tally);
  });

  it("OW02 exec_delivered wins over brief off, supersede off and no installation", () => {
    const rows = fixture.rows.filter((r) => r.facts.execEnabled && r.facts.tablesReady && r.facts.execDeliveredToday);
    expect(rows).toHaveLength(16);
    for (const r of rows) expect(briefOwnership(r.facts as BriefOwnershipFacts)).toEqual({ owner: "exec", reason: "exec_delivered" });
    expect(briefOwnership({ execEnabled: true, tablesReady: true, briefEnabled: false, supersede: false, installationActive: false, execDeliveredToday: true, legacyDeliveredToday: true }))
      .toEqual({ owner: "exec", reason: "exec_delivered" });
  });

  it("OW03 legacy may run for every verdict but exec", () => {
    expect(legacyMayRun({ owner: "exec", reason: "owns" })).toBe(false);
    expect(legacyMayRun({ owner: "exec", reason: "exec_delivered" })).toBe(false);
    expect(legacyMayRun({ owner: "legacy", reason: "exec_disabled" })).toBe(true);
    expect(legacyMayRun({ owner: "exec_page_only", reason: "legacy_delivered" })).toBe(true);
    for (const r of fixture.rows) expect(legacyMayRun(briefOwnership(r.facts as BriefOwnershipFacts))).toBe(r.owner !== "exec");
  });

  it("reads a fact as true only when it is exactly true (a malformed fact moves toward legacy, never toward a DM)", () => {
    const all = { execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: true, execDeliveredToday: false, legacyDeliveredToday: false };
    expect(briefOwnership(all)).toEqual({ owner: "exec", reason: "owns" });
    expect(briefOwnership({ ...all, execEnabled: "true" } as unknown as BriefOwnershipFacts)).toEqual({ owner: "legacy", reason: "exec_disabled" });
    expect(briefOwnership({ ...all, installationActive: 1 } as unknown as BriefOwnershipFacts)).toEqual({ owner: "exec_page_only", reason: "no_installation" });
    expect(briefOwnership({ ...all, execDeliveredToday: "yes" } as unknown as BriefOwnershipFacts)).toEqual({ owner: "exec", reason: "owns" });
    expect(briefOwnership(null as unknown as BriefOwnershipFacts)).toEqual({ owner: "legacy", reason: "exec_disabled" });
    expect(Object.isFrozen(briefOwnership(all))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// OW04-OW08: times
// ---------------------------------------------------------------------------------------------------------------------

describe("catchUpCutoff (C4)", () => {
  const cutoff = (d: string, hhmm: string) => iso(catchUpCutoff(d, localTimeToUtc(d, hhmm, NY), NY));

  it("OW04 08:00 → 12:00; 06:00 → 12:00; 09:30 → 13:30; 14:00 → 18:00 (2026-11-06, EST)", () => {
    expect(cutoff("2026-11-06", "08:00")).toBe("2026-11-06T17:00:00.000Z");
    expect(cutoff("2026-11-06", "06:00")).toBe("2026-11-06T17:00:00.000Z");
    expect(cutoff("2026-11-06", "09:30")).toBe("2026-11-06T18:30:00.000Z");
    expect(cutoff("2026-11-06", "14:00")).toBe("2026-11-06T23:00:00.000Z");
  });

  it("OW04 the spring-forward and fall-back days keep wall-clock 12:00", () => {
    // 2027-03-14: 02:00 EST → 03:00 EDT, so 12:00 is 16:00Z; 2026-11-01: 02:00 EDT → 01:00 EST, so 12:00 is 17:00Z.
    expect(cutoff("2027-03-14", "08:00")).toBe("2027-03-14T16:00:00.000Z");
    expect(cutoff("2026-11-01", "08:00")).toBe("2026-11-01T17:00:00.000Z");
    // An early brief whose +4 h crosses the change still lands on 12:00 local (the floor wins).
    expect(cutoff("2027-03-14", "01:30")).toBe("2027-03-14T16:00:00.000Z");
    // A brief in the repeated hour (its first occurrence, 05:30Z): +4 h = 09:30Z, under the floor.
    expect(cutoff("2026-11-01", "01:30")).toBe("2026-11-01T17:00:00.000Z");
  });

  it("throws on a scheduledAt that isn't a date", () => {
    expect(() => catchUpCutoff("2026-11-06", new Date(Number.NaN), NY)).toThrow(RangeError);
  });
});

describe("mayDmAt (C4)", () => {
  const due = localTimeToUtc("2026-11-06", "08:00", NY);

  it("OW05 before the cutoff → true; at the cutoff → false", () => {
    expect(mayDmAt(at("2026-11-06T13:00:00Z"), "2026-11-06", due, NY)).toBe(true);
    expect(mayDmAt(at("2026-11-06T16:59:59.999Z"), "2026-11-06", due, NY)).toBe(true);
    expect(mayDmAt(at("2026-11-06T17:00:00Z"), "2026-11-06", due, NY)).toBe(false);
    expect(mayDmAt(at("2026-11-06T22:00:00Z"), "2026-11-06", due, NY)).toBe(false);
  });

  it("OW05 a 23:30 brief: 23:45 the same day → true; 01:00 the next local day → false (the local date ended)", () => {
    const late = localTimeToUtc("2026-11-06", "23:30", NY);
    // Its +4 h cutoff (03:30 the next day) is later than the end of the local date, which wins.
    expect(iso(catchUpCutoff("2026-11-06", late, NY))).toBe("2026-11-07T08:30:00.000Z");
    expect(mayDmAt(at("2026-11-07T04:45:00Z"), "2026-11-06", late, NY)).toBe(true);
    expect(mayDmAt(at("2026-11-07T05:00:00Z"), "2026-11-06", late, NY)).toBe(false);
    expect(mayDmAt(at("2026-11-07T06:00:00Z"), "2026-11-06", late, NY)).toBe(false);
  });

  it("fails closed on anything malformed", () => {
    expect(mayDmAt(new Date(Number.NaN), "2026-11-06", due, NY)).toBe(false);
    expect(mayDmAt(at("2026-11-06T13:00:00Z"), "2026-13-06", due, NY)).toBe(false);
    expect(mayDmAt(at("2026-11-06T13:00:00Z"), "2026-11-06", new Date(Number.NaN), NY)).toBe(false);
  });
});

describe("watchdogRunAfter (C3)", () => {
  it("OW06 max(scheduledAt, now) + 45 min: due 08:00 at 08:00:30 → 08:45:30; a 10:12 catch-up → 10:57", () => {
    const due = at("2026-11-06T13:00:00Z");
    expect(iso(watchdogRunAfter(due, at("2026-11-06T13:00:30Z")))).toBe("2026-11-06T13:45:30.000Z");
    expect(iso(watchdogRunAfter(due, at("2026-11-06T15:12:00Z")))).toBe("2026-11-06T15:57:00.000Z");
    // A tick before the due time (never the scheduler's case) still waits 45 minutes past the due time.
    expect(iso(watchdogRunAfter(due, at("2026-11-06T12:00:00Z")))).toBe("2026-11-06T13:45:00.000Z");
    expect(() => watchdogRunAfter(new Date(Number.NaN), new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("briefExpiries (C28)", () => {
  it("OW07 content = end of the local date + 30 days, row = + 180 days, each a local midnight across DST", () => {
    // 2026-10-15 (EDT) ends 2026-10-16T04:00Z. +30 days → the end of 2026-11-14, 2026-11-15 00:00 EST = 05:00Z (DST ended);
    // +180 days → the end of 2027-04-13, 2027-04-14 00:00 EDT = 04:00Z.
    expect(briefExpiries("2026-10-15", NY)).toEqual({ contentExpiresAt: at("2026-11-15T05:00:00Z"), expiresAt: at("2027-04-14T04:00:00Z") });
    // Asia/Kolkata has no DST: exactly 30 and 180 days of 24 h after the end of the day.
    const k = briefExpiries("2026-11-06", "Asia/Kolkata");
    expect(iso(k.contentExpiresAt)).toBe("2026-12-06T18:30:00.000Z");
    expect(iso(k.expiresAt)).toBe("2027-05-05T18:30:00.000Z");
    expect(k.expiresAt.getTime()).toBeGreaterThanOrEqual(k.contentExpiresAt.getTime());
  });
});

describe("scheduledInstant", () => {
  it("OW08 equals localTimeToUtc, DST cases included", () => {
    for (const [d, t] of [["2026-11-06", "08:00"], ["2027-03-14", "02:30"], ["2026-11-01", "01:30"], ["2026-07-06", "08:00"]] as const) {
      expect(iso(scheduledInstant(d, t, NY))).toBe(iso(localTimeToUtc(d, t, NY)));
    }
    expect(iso(scheduledInstant("2027-03-14", "02:30", NY))).toBe("2027-03-14T07:00:00.000Z");
    expect(iso(scheduledInstant("2026-11-01", "01:30", NY))).toBe("2026-11-01T05:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// OW09-OW11: the exec-side loader (fake stores)
// ---------------------------------------------------------------------------------------------------------------------

class FakeStoreError extends Error {
  constructor(readonly pgCode: string | null) {
    super(`store failed${pgCode ? ` (${pgCode})` : ""}`);
  }
}
const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);
const missing = (err: unknown) => err instanceof FakeStoreError && err.pgCode !== null && MISSING.has(err.pgCode);

const briefRow = (o: Partial<BriefRow> = {}): BriefRow => ({
  id: "eb_" + "1".repeat(32), principalId: "ep_1", localDate: "2026-11-06", tz: NY, scheduledAt: "2026-11-06T13:00:00.000Z", rev: 1,
  status: "built", statusReason: null, owner: "exec", ownerReason: "owns", mode: "ai", modeReason: null, content: null,
  buildStartedAt: null, builtAt: null, regenLockUntil: null, regenSeq: 0, noveltyMarkedAt: null, deliveryStartedAt: null, postAttempts: 0,
  deliveredAt: null, slackChannelId: null, slackTs: null, checkinsTs: null, lateNoteTs: null, fallbackSentAt: null, fallbackSlackTs: null,
  fallbackChannelId: null, fallbackDeleteAfter: null, fallbackDeletedAt: null, fallbackErrorCode: null, scrubbedAt: null, dmFollowedAt: null,
  errorCode: null, contentExpiresAt: "2026-12-07T05:00:00.000Z", contentPurgedAt: null, expiresAt: "2027-05-06T04:00:00.000Z",
  createdAt: "2026-11-06T13:00:00.000Z", updatedAt: "2026-11-06T13:00:00.000Z", ...o
});
const INSTALLATION = { id: "esi_" + "2".repeat(32), revokedAt: null } as unknown as InstallationRow;

/** daily_briefings rows by delivered_at; legacyDeliveredBetween answers like §3.4 ("any row with delivered_at in [from, to)"). */
let legacyRows: { delivered_at: string | null }[] = [];
/** exec_brief_checkins rows; countPendingCheckins answers like M14 (proposed, that local date, expires_at > now). */
let checkinRows: { status: string; local_date: string; expires_at: string; created_at: string }[] = [];

beforeEach(() => {
  legacyRows = [];
  checkinRows = [];
  vi.mocked(isExecEnabled).mockReturnValue(true);
  vi.mocked(isBriefSchemaMissing).mockImplementation(missing);
  vi.mocked(isSlackSchemaMissing).mockImplementation(missing);
  vi.mocked(briefSchemaReady).mockResolvedValue(true);
  vi.mocked(getBriefByDate).mockResolvedValue(null);
  vi.mocked(getActiveInstallation).mockResolvedValue(INSTALLATION);
  vi.mocked(legacyDeliveredBetween).mockImplementation(async (fromIso, toIso) =>
    legacyRows.some((r) => r.delivered_at !== null && Date.parse(r.delivered_at) >= Date.parse(fromIso) && Date.parse(r.delivered_at) < Date.parse(toIso)));
  vi.mocked(legacyBriefInFlight).mockResolvedValue(false);
  vi.mocked(countPendingCheckins).mockImplementation(async (_p, localDate, now) => {
    const live = checkinRows.filter((r) => r.status === "proposed" && r.local_date === localDate && Date.parse(r.expires_at) > now.getTime());
    const oldest = live.map((r) => r.created_at).sort()[0] ?? null;
    return { count: live.length, oldestAt: oldest };
  });
  vi.mocked(loadSettings).mockResolvedValue(settings({ briefEnabled: true, supersedeLegacyBrief: true }));
});

describe("loadBriefOwnership (§3.3.2)", () => {
  const NOW = at("2026-11-06T13:05:00Z");
  const p = principal();

  it("reads every fact fresh and answers exec/owns with the day's row and the installation", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow());
    const read = await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW);
    expect(read.verdict).toEqual({ owner: "exec", reason: "owns" });
    expect(read.facts).toEqual({ execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: true, execDeliveredToday: false, legacyDeliveredToday: false });
    expect(read.localDate).toBe("2026-11-06");
    expect(read.brief?.id).toBe("eb_" + "1".repeat(32));
    expect(read.installation).toBe(INSTALLATION);
    expect(getBriefByDate).toHaveBeenCalledWith(p, "2026-11-06", expect.anything());
  });

  it("execDeliveredToday from the row's delivered_at or fallback_sent_at; the predicate's other rows from the settings", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ deliveredAt: "2026-11-06T13:01:00Z", status: "delivered" }));
    expect((await loadBriefOwnership(p, settings(), "2026-11-06", NOW)).verdict).toEqual({ owner: "exec", reason: "exec_delivered" });
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ fallbackSentAt: "2026-11-06T13:46:00Z" }));
    expect((await loadBriefOwnership(p, settings(), "2026-11-06", NOW)).facts.execDeliveredToday).toBe(true);
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow());
    expect((await loadBriefOwnership(p, settings(), "2026-11-06", NOW)).verdict).toEqual({ owner: "legacy", reason: "brief_off" });
    expect((await loadBriefOwnership(p, settings({ briefEnabled: true }), "2026-11-06", NOW)).verdict).toEqual({ owner: "exec_page_only", reason: "not_superseding" });
    vi.mocked(getActiveInstallation).mockResolvedValue(null);
    expect((await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW)).verdict)
      .toEqual({ owner: "exec_page_only", reason: "no_installation" });
    vi.mocked(isExecEnabled).mockReturnValue(false);
    expect((await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW)).verdict)
      .toEqual({ owner: "legacy", reason: "exec_disabled" });
  });

  it("OW09 the brief schema missing → tablesReady false, legacy/not_installed, and no other brief read", async () => {
    vi.mocked(briefSchemaReady).mockResolvedValue(false);
    const read = await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW);
    expect(read.facts.tablesReady).toBe(false);
    expect(read.verdict).toEqual({ owner: "legacy", reason: "not_installed" });
    expect(read.brief).toBeNull();
    expect(getBriefByDate).not.toHaveBeenCalled();
    expect(legacyDeliveredBetween).not.toHaveBeenCalled();
    // The probe answering by a schema-missing throw reads the same.
    vi.mocked(briefSchemaReady).mockRejectedValue(new FakeStoreError("42P01"));
    expect((await loadBriefOwnership(p, settings(), "2026-11-06", NOW)).facts.tablesReady).toBe(false);
    expect(getBriefByDate).not.toHaveBeenCalled();
  });

  it("OW09 the installation schema missing → installationActive false (no throw)", async () => {
    vi.mocked(getActiveInstallation).mockRejectedValue(new FakeStoreError("PGRST205"));
    const read = await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW);
    expect(read.facts.installationActive).toBe(false);
    expect(read.installation).toBeNull();
    expect(read.verdict).toEqual({ owner: "exec_page_only", reason: "no_installation" });
  });

  it("OW09 a brief store answering schema-missing after the probe → not installed", async () => {
    vi.mocked(getBriefByDate).mockRejectedValue(new FakeStoreError("42P01"));
    const read = await loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW);
    expect(read.facts.tablesReady).toBe(false);
    expect(read.verdict).toEqual({ owner: "legacy", reason: "not_installed" });
  });

  it.each([
    ["briefSchemaReady", () => vi.mocked(briefSchemaReady).mockRejectedValue(new FakeStoreError("57014"))],
    ["getBriefByDate", () => vi.mocked(getBriefByDate).mockRejectedValue(new FakeStoreError(null))],
    ["legacyDeliveredBetween", () => vi.mocked(legacyDeliveredBetween).mockRejectedValue(new FakeStoreError("08006"))],
    ["getActiveInstallation", () => vi.mocked(getActiveInstallation).mockRejectedValue(new FakeStoreError("57P01"))]
  ])("OW09 a non-missing error from %s throws (never a guessed verdict)", async (_name, arm) => {
    arm();
    await expect(loadBriefOwnership(p, settings({ briefEnabled: true, supersedeLegacyBrief: true }), "2026-11-06", NOW)).rejects.toBeInstanceOf(FakeStoreError);
  });

  it("OW10 a legacy brief delivered at 07:59 local today counts; one at 23:59 local yesterday doesn't", async () => {
    const s = settings({ briefEnabled: true, supersedeLegacyBrief: true });
    legacyRows = [{ delivered_at: "2026-11-06T04:59:00Z" }];   // 23:59 EST on 2026-11-05
    expect((await loadBriefOwnership(p, s, "2026-11-06", NOW)).facts.legacyDeliveredToday).toBe(false);
    legacyRows = [{ delivered_at: "2026-11-06T12:59:00Z" }];   // 07:59 EST on 2026-11-06
    const read = await loadBriefOwnership(p, s, "2026-11-06", NOW);
    expect(read.facts.legacyDeliveredToday).toBe(true);
    expect(read.verdict).toEqual({ owner: "exec_page_only", reason: "legacy_delivered" });
    // The day's bounds are the brief zone's local midnights.
    expect(legacyDeliveredBetween).toHaveBeenLastCalledWith("2026-11-06T05:00:00.000Z", "2026-11-07T05:00:00.000Z", expect.anything());
  });

  it("OW10b (fixer security-3) a legacy brief in flight (upserted, its post pending) counts as delivered: exec_page_only legacy_delivered, never a second DM", async () => {
    const s = settings({ briefEnabled: true, supersedeLegacyBrief: true });
    expect((await loadBriefOwnership(p, s, "2026-11-06", NOW)).verdict).toEqual({ owner: "exec", reason: "owns" });
    vi.mocked(legacyBriefInFlight).mockResolvedValue(true);
    const read = await loadBriefOwnership(p, s, "2026-11-06", NOW);
    expect(read.facts.legacyDeliveredToday).toBe(true);
    expect(read.verdict).toEqual({ owner: "exec_page_only", reason: "legacy_delivered" });
    // Its read failing is a read failure like any other (never a guessed verdict); the schema missing reads as not in flight.
    vi.mocked(legacyBriefInFlight).mockRejectedValue(new FakeStoreError("57014"));
    await expect(loadBriefOwnership(p, s, "2026-11-06", NOW)).rejects.toBeInstanceOf(FakeStoreError);
    vi.mocked(legacyBriefInFlight).mockRejectedValue(new FakeStoreError("42P01"));
    expect((await loadBriefOwnership(p, s, "2026-11-06", NOW)).facts.legacyDeliveredToday).toBe(false);
  });

  it("OW10 the bounds follow the brief zone across a DST change (a 25-hour local day)", async () => {
    await loadBriefOwnership(p, settings(), "2026-11-01", NOW);
    expect(legacyDeliveredBetween).toHaveBeenLastCalledWith("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", expect.anything());
    const manila = principal("Asia/Manila");
    await loadBriefOwnership(manila, settings(), "2026-11-06", NOW);
    expect(legacyDeliveredBetween).toHaveBeenLastCalledWith("2026-11-05T16:00:00.000Z", "2026-11-06T16:00:00.000Z", expect.anything());
  });

  it("refuses a malformed local date", async () => {
    await expect(loadBriefOwnership(p, settings(), "11/06/2026", NOW)).rejects.toThrow(RangeError);
  });
});

describe("checkinApprovalSource (M14, C46)", () => {
  const p = principal();

  it("OW11 verdict exec → counts today's proposed rows with expires_at > now (an expired-by-time row isn't counted)", async () => {
    const now = at("2026-11-06T15:00:00Z");   // 10:00 EST
    checkinRows = [
      { status: "proposed", local_date: "2026-11-06", expires_at: "2026-11-08T13:00:00Z", created_at: "2026-11-06T13:02:00Z" },
      { status: "proposed", local_date: "2026-11-06", expires_at: "2026-11-08T13:00:00Z", created_at: "2026-11-06T13:01:00Z" },
      { status: "proposed", local_date: "2026-11-06", expires_at: "2026-11-06T14:59:59Z", created_at: "2026-11-06T13:00:00Z" },
      { status: "sent", local_date: "2026-11-06", expires_at: "2026-11-08T13:00:00Z", created_at: "2026-11-06T13:00:00Z" },
      { status: "proposed", local_date: "2026-11-05", expires_at: "2026-11-07T13:00:00Z", created_at: "2026-11-05T13:00:00Z" }
    ];
    // The check-ins message reached his DM (checkins_ts set).
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "delivered", deliveredAt: "2026-11-06T13:02:00Z", checkinsTs: "1794000002.000100" }));
    await expect(checkinApprovalSource(p, now)).resolves.toEqual({ source: "exec", count: 2, oldestAt: "2026-11-06T13:01:00Z" });
    // Today in the brief zone, not UTC: 03:00Z on 2026-11-07 is still 2026-11-06 in New York.
    await checkinApprovalSource(p, at("2026-11-07T03:00:00Z"));
    expect(countPendingCheckins).toHaveBeenLastCalledWith(p, "2026-11-06", at("2026-11-07T03:00:00Z"));
    expect(loadSettings).toHaveBeenCalledWith("ep_1");
  });

  it("OW11 (fixer ui-3) the check-ins message never reached Slack (a page_only delivery_failed day, or not out yet) → count 0, none \"waiting in Slack\"", async () => {
    const now = at("2026-11-06T15:00:00Z");
    checkinRows = [{ status: "proposed", local_date: "2026-11-06", expires_at: "2026-11-08T13:00:00Z", created_at: "2026-11-06T13:02:00Z" }];
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "page_only", statusReason: "delivery_failed", checkinsTs: null }));
    vi.mocked(countPendingCheckins).mockClear();
    await expect(checkinApprovalSource(p, now)).resolves.toEqual({ source: "exec", count: 0, oldestAt: null });
    expect(countPendingCheckins).not.toHaveBeenCalled();
    vi.mocked(getBriefByDate).mockResolvedValue(null);
    await expect(checkinApprovalSource(p, now)).resolves.toEqual({ source: "exec", count: 0, oldestAt: null });
  });

  it("OW11 any other verdict → legacy, without counting", async () => {
    vi.mocked(getActiveInstallation).mockResolvedValue(null);
    await expect(checkinApprovalSource(p, at("2026-11-06T15:00:00Z"))).resolves.toEqual({ source: "legacy" });
    vi.mocked(loadSettings).mockResolvedValue(settings());
    vi.mocked(getActiveInstallation).mockResolvedValue(INSTALLATION);
    await expect(checkinApprovalSource(p, at("2026-11-06T15:00:00Z"))).resolves.toEqual({ source: "legacy" });
    expect(countPendingCheckins).not.toHaveBeenCalled();
  });

  it("OW11 a read error throws (no silent zero)", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "delivered", deliveredAt: "2026-11-06T13:02:00Z", checkinsTs: "1794000002.000100" }));
    vi.mocked(countPendingCheckins).mockRejectedValue(new FakeStoreError("57014"));
    await expect(checkinApprovalSource(p, at("2026-11-06T15:00:00Z"))).rejects.toBeInstanceOf(FakeStoreError);
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed: timeout"));
    await expect(checkinApprovalSource(p, at("2026-11-06T15:00:00Z"))).rejects.toThrow("exec_settings read failed");
  });
});
