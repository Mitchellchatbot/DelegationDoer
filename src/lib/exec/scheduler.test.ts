import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { isValidJobKind: actual.isValidJobKind, enqueueJob: vi.fn(), reapExpiredLeases: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn() };
});

import { enqueueJob, reapExpiredLeases } from "@/lib/exec/jobs";
import { listEnabledPrincipals, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import {
  __resetSchedulerForTests,
  dueDedupeKey,
  getScheduledWork,
  listScheduledWork,
  registerScheduledWork,
  runSchedulerTick,
  type ScheduledWork
} from "@/lib/exec/scheduler";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

const NY = "America/New_York";
const KHI = "Asia/Karachi";
const at = (iso: string) => new Date(iso);

function principal(id: string, tz: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: `${id}@scaledai.org`, name: id, work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

function settings(principalId: string, overrides: Partial<ExecSettings> = {}): ExecSettings {
  return { ...settingsFromRow(null, principalId), ...overrides };
}

const nyP = principal("ep_1", NY);
const khiP = principal("ep_2", KHI);

const intervalWork: ScheduledWork = { kind: "test.interval", lane: "bulk", cadence: { kind: "interval", minutes: 5 } };
const briefWork: ScheduledWork = {
  kind: "test.brief",
  lane: "bulk",
  cadence: { kind: "daily", at: (s) => s.briefLocalTime },
  enabled: (s) => s.briefEnabled
};
const fixedDaily = (hhmm: string): ScheduledWork => ({ kind: "test.daily", lane: "bulk", cadence: { kind: "daily", at: () => hhmm } });
const weekly = (isoWeekday: number, hhmm: string): ScheduledWork => ({
  kind: "test.weekly",
  lane: "bulk",
  cadence: { kind: "weekly", isoWeekday, at: hhmm }
});

beforeEach(() => {
  __resetSchedulerForTests();
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.mocked(reapExpiredLeases).mockResolvedValue(0);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settings(id));
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSchedulerForTests();
});

// ---------------------------------------------------------------------------

describe("dueDedupeKey: interval", () => {
  it("is always due, keyed by the epoch bucket", () => {
    const s = settings("ep_1");
    // 2026-11-04T12:00Z is epoch minute 29,896,560 → 5-minute bucket 5,979,312.
    expect(dueDedupeKey(intervalWork, nyP, s, at("2026-11-04T12:00:00Z"))).toBe("test.interval:ep_1:i5979312");
    expect(dueDedupeKey(intervalWork, nyP, s, at("2026-11-04T12:04:59Z"))).toBe("test.interval:ep_1:i5979312");
    expect(dueDedupeKey(intervalWork, nyP, s, at("2026-11-04T12:05:00Z"))).toBe("test.interval:ep_1:i5979313");
  });

  it("buckets the same for every zone and includes the principal", () => {
    const now = at("2026-11-04T12:00:00Z");
    expect(dueDedupeKey(intervalWork, khiP, settings("ep_2"), now)).toBe("test.interval:ep_2:i5979312");
  });
});

describe("dueDedupeKey: daily", () => {
  const s = settings("ep_1", { briefLocalTime: "08:00" });

  it("is not due before the local time", () => {
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-04T12:59:59Z"))).toBeNull(); // 07:59:59 EST
  });

  it("is due from the local time to local midnight, under one key per local date", () => {
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-04T13:00:00Z"))).toBe("test.brief:ep_1:2026-11-04");
    // Catch-up: 23:59 local is still due, and still the same key (the UTC date is already the 5th).
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-05T04:59:00Z"))).toBe("test.brief:ep_1:2026-11-04");
    // Local midnight: a new day, not yet due again.
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-05T05:00:00Z"))).toBeNull();
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-05T13:00:00Z"))).toBe("test.brief:ep_1:2026-11-05");
  });

  it("reads the time from the principal's settings", () => {
    const early = settings("ep_1", { briefLocalTime: "07:30" });
    const late = settings("ep_1", { briefLocalTime: "09:00" });
    const instant = at("2026-11-04T12:45:00Z"); // 07:45 EST
    expect(dueDedupeKey(briefWork, nyP, early, instant)).toBe("test.brief:ep_1:2026-11-04");
    expect(dueDedupeKey(briefWork, nyP, late, instant)).toBeNull();
  });

  it("evaluates in the principal's zone (Karachi, UTC+5)", () => {
    expect(dueDedupeKey(briefWork, khiP, settings("ep_2"), at("2026-11-04T02:59:00Z"))).toBeNull(); // 07:59 PKT
    expect(dueDedupeKey(briefWork, khiP, settings("ep_2"), at("2026-11-04T03:00:00Z"))).toBe("test.brief:ep_2:2026-11-04");
    // 18:59Z = 23:59 PKT still on the 4th; 19:00Z is the 5th locally.
    expect(dueDedupeKey(briefWork, khiP, settings("ep_2"), at("2026-11-04T18:59:00Z"))).toBe("test.brief:ep_2:2026-11-04");
    expect(dueDedupeKey(briefWork, khiP, settings("ep_2"), at("2026-11-04T19:00:00Z"))).toBeNull();
  });

  it("stays at 08:00 local across the spring-forward change", () => {
    // 08:00 EST on 03-07 is 13:00Z; 08:00 EDT on 03-08 is 12:00Z.
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-03-07T12:59:00Z"))).toBeNull();
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-03-07T13:00:00Z"))).toBe("test.brief:ep_1:2026-03-07");
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-03-08T11:59:00Z"))).toBeNull();
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-03-08T12:00:00Z"))).toBe("test.brief:ep_1:2026-03-08");
  });

  it("runs a time inside the skipped hour at 03:00 on the spring-forward day", () => {
    const work = fixedDaily("02:30");
    expect(dueDedupeKey(work, nyP, s, at("2026-03-08T06:59:59Z"))).toBeNull(); // 01:59:59 EST
    expect(dueDedupeKey(work, nyP, s, at("2026-03-08T07:00:00Z"))).toBe("test.daily:ep_1:2026-03-08"); // 03:00 EDT
  });

  it("gives both readings of the repeated fall-back hour the same key", () => {
    const work = fixedDaily("01:30");
    const first = dueDedupeKey(work, nyP, s, at("2026-11-01T05:30:00Z")); // 01:30 EDT
    const second = dueDedupeKey(work, nyP, s, at("2026-11-01T06:30:00Z")); // 01:30 EST
    expect(first).toBe("test.daily:ep_1:2026-11-01");
    expect(second).toBe(first);
    // Between them the wall clock reads 01:00-01:29 again; already enqueued under that key.
    expect(dueDedupeKey(work, nyP, s, at("2026-11-01T06:10:00Z"))).toBeNull();
  });

  it("stays at 08:00 local across the fall-back change", () => {
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-10-31T12:00:00Z"))).toBe("test.brief:ep_1:2026-10-31"); // 08:00 EDT
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-01T12:59:00Z"))).toBeNull(); // 07:59 EST
    expect(dueDedupeKey(briefWork, nyP, s, at("2026-11-01T13:00:00Z"))).toBe("test.brief:ep_1:2026-11-01");
  });

  it("is never due for a malformed time", () => {
    expect(dueDedupeKey(fixedDaily("8:00"), nyP, s, at("2026-11-05T04:00:00Z"))).toBeNull();
    expect(dueDedupeKey(fixedDaily("24:00"), nyP, s, at("2026-11-05T04:00:00Z"))).toBeNull();
  });
});

describe("dueDedupeKey: weekly", () => {
  const s = settings("ep_1");
  const mondayNine = weekly(1, "09:00");

  it("is due on its ISO weekday from the local time, keyed by ISO week", () => {
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-09T13:59:00Z"))).toBeNull(); // Mon 08:59 EST
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-09T14:00:00Z"))).toBe("test.weekly:ep_1:2026-W46");
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-10T04:59:00Z"))).toBe("test.weekly:ep_1:2026-W46"); // Mon 23:59
  });

  it("is not due on other days", () => {
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-08T15:00:00Z"))).toBeNull(); // Sunday
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-10T15:00:00Z"))).toBeNull(); // Tuesday
    expect(dueDedupeKey(mondayNine, nyP, s, at("2026-11-10T05:00:00Z"))).toBeNull(); // Tuesday 00:00 local
  });

  it("decides the weekday in the principal's zone", () => {
    const mondaySeven = weekly(1, "07:00");
    const instant = at("2027-01-04T03:00:00Z"); // Mon 08:00 PKT, Sun 22:00 EST
    expect(dueDedupeKey(mondaySeven, khiP, settings("ep_2"), instant)).toBe("test.weekly:ep_2:2027-W01");
    expect(dueDedupeKey(mondaySeven, nyP, s, instant)).toBeNull();
  });

  it("uses the ISO year at year boundaries", () => {
    const fridayNoon = weekly(5, "12:00");
    expect(dueDedupeKey(fridayNoon, khiP, settings("ep_2"), at("2027-01-01T07:00:00Z"))).toBe("test.weekly:ep_2:2026-W53");
  });

  it("handles a Sunday slot inside the skipped spring-forward hour", () => {
    const sunday = weekly(7, "02:30");
    expect(dueDedupeKey(sunday, nyP, s, at("2026-03-08T06:59:00Z"))).toBeNull();
    expect(dueDedupeKey(sunday, nyP, s, at("2026-03-08T07:00:00Z"))).toBe("test.weekly:ep_1:2026-W10");
  });
});

// ---------------------------------------------------------------------------

describe("registerScheduledWork", () => {
  it("registers once per kind and lists in order", () => {
    registerScheduledWork(intervalWork);
    registerScheduledWork(briefWork);
    expect(getScheduledWork("test.interval")).toBe(intervalWork);
    expect(listScheduledWork().map((w) => w.kind)).toEqual(["test.interval", "test.brief"]);
    expect(() => registerScheduledWork({ ...intervalWork })).toThrow(/already registered/);
  });

  it.each<[string, unknown]>([
    ["missing kind", { ...intervalWork, kind: "" }],
    ["a kind with spaces", { ...intervalWork, kind: "test interval" }],
    ["a non-string kind", { ...intervalWork, kind: 42 }],
    ["bad lane", { ...intervalWork, lane: "urgent" }],
    ["zero minutes", { ...intervalWork, cadence: { kind: "interval", minutes: 0 } }],
    ["fractional minutes", { ...intervalWork, cadence: { kind: "interval", minutes: 2.5 } }],
    ["daily without a function", { ...intervalWork, cadence: { kind: "daily", at: "08:00" } }],
    ["weekday 0", { ...intervalWork, cadence: { kind: "weekly", isoWeekday: 0, at: "08:00" } }],
    ["weekday 8", { ...intervalWork, cadence: { kind: "weekly", isoWeekday: 8, at: "08:00" } }],
    ["malformed weekly time", { ...intervalWork, cadence: { kind: "weekly", isoWeekday: 1, at: "8am" } }],
    ["unknown cadence", { ...intervalWork, cadence: { kind: "monthly" } }],
    ["no cadence", { ...intervalWork, cadence: undefined }]
  ])("rejects %s", (_label, work) => {
    expect(() => registerScheduledWork(work as ScheduledWork)).toThrow();
    expect(listScheduledWork()).toEqual([]);
  });

  it("forgets everything on reset", () => {
    registerScheduledWork(intervalWork);
    __resetSchedulerForTests();
    expect(listScheduledWork()).toEqual([]);
    expect(getScheduledWork("test.interval")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("runSchedulerTick", () => {
  const noon = at("2026-11-04T17:00:00Z"); // 12:00 EST, 22:00 PKT

  it("does nothing while EXEC_ENABLED is not 'true'", async () => {
    vi.stubEnv("EXEC_ENABLED", "1");
    registerScheduledWork(intervalWork);
    await expect(runSchedulerTick(noon)).resolves.toEqual({ principals: 0, enqueued: 0, reaped: 0, summary: "disabled" });
    expect(reapExpiredLeases).not.toHaveBeenCalled();
    expect(listEnabledPrincipals).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("is idle when there is nothing to do", async () => {
    registerScheduledWork(intervalWork);
    await expect(runSchedulerTick(noon)).resolves.toEqual({ principals: 0, enqueued: 0, reaped: 0, summary: "idle" });
  });

  it("reaps expired leases before scheduling", async () => {
    const order: string[] = [];
    vi.mocked(reapExpiredLeases).mockImplementation(async () => {
      order.push("reap");
      return 3;
    });
    vi.mocked(listEnabledPrincipals).mockImplementation(async () => {
      order.push("list");
      return [];
    });
    const r = await runSchedulerTick(noon);
    expect(order).toEqual(["reap", "list"]);
    expect(r).toEqual({ principals: 0, enqueued: 0, reaped: 3, summary: "principals=0 enqueued=0 reaped=3" });
  });

  it("enqueues each due item per principal with its dedupe key, payload and attempts", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP, khiP]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => settings(id, { briefEnabled: id === "ep_1" }));
    registerScheduledWork({ ...intervalWork, payload: (p) => ({ principalRef: p.id }), maxAttempts: 3 });
    registerScheduledWork(briefWork);
    registerScheduledWork(weekly(1, "09:00")); // Wednesday: not due

    const r = await runSchedulerTick(noon);

    expect(vi.mocked(enqueueJob).mock.calls.map(([input]) => input)).toEqual([
      {
        kind: "test.interval",
        lane: "bulk",
        principalId: "ep_1",
        payload: { principalRef: "ep_1" },
        dedupeKey: "test.interval:ep_1:i5979372",
        maxAttempts: 3
      },
      {
        kind: "test.brief",
        lane: "bulk",
        principalId: "ep_1",
        payload: {},
        dedupeKey: "test.brief:ep_1:2026-11-04",
        maxAttempts: undefined
      },
      {
        kind: "test.interval",
        lane: "bulk",
        principalId: "ep_2",
        payload: { principalRef: "ep_2" },
        dedupeKey: "test.interval:ep_2:i5979372",
        maxAttempts: 3
      }
      // ep_2's brief is switched off in its settings.
    ]);
    expect(loadSettings).toHaveBeenCalledWith("ep_1");
    expect(loadSettings).toHaveBeenCalledWith("ep_2");
    expect(r).toEqual({ principals: 2, enqueued: 3, reaped: 0, summary: "principals=2 enqueued=3 reaped=0" });
  });

  it("doesn't count an enqueue the dedupe key absorbed, so a repeat tick is idle", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP]);
    vi.mocked(enqueueJob).mockResolvedValue({ enqueued: false, id: null });
    registerScheduledWork(intervalWork);
    const r = await runSchedulerTick(noon);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(r.summary).toBe("idle");
    expect(r.enqueued).toBe(0);
  });

  it("keeps going when one principal's settings fail to load", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP, khiP]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => {
      if (id === "ep_1") throw new Error("exec_settings read failed: timeout");
      return settings(id);
    });
    registerScheduledWork(intervalWork);

    const r = await runSchedulerTick(noon);

    expect(vi.mocked(enqueueJob).mock.calls.map(([input]) => input.principalId)).toEqual(["ep_2"]);
    expect(r.summary).toBe("principals=2 enqueued=1 reaped=0 errors=1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("principal ep_1: could not load settings"));
  });

  it("keeps going when one item's enqueue fails or its gate throws", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP]);
    vi.mocked(enqueueJob).mockImplementation(async (input) => {
      if (input.kind === "test.interval") throw new Error("exec_jobs enqueue failed (test.interval): boom");
      return { enqueued: true, id: 7 };
    });
    registerScheduledWork(intervalWork);
    registerScheduledWork({
      kind: "test.gated",
      lane: "bulk",
      cadence: { kind: "interval", minutes: 10 },
      enabled: () => {
        throw new Error("gate exploded");
      }
    });
    registerScheduledWork(briefWork);
    vi.mocked(loadSettings).mockResolvedValue(settings("ep_1", { briefEnabled: true }));

    const r = await runSchedulerTick(noon);

    expect(vi.mocked(enqueueJob).mock.calls.map(([input]) => input.kind)).toEqual(["test.interval", "test.brief"]);
    expect(r).toEqual({ principals: 1, enqueued: 1, reaped: 0, summary: "principals=1 enqueued=1 reaped=0 errors=2" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("test.interval for principal ep_1 failed"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("test.gated for principal ep_1 failed: gate exploded"));
  });

  it("still schedules when reaping fails, and reports it", async () => {
    vi.mocked(reapExpiredLeases).mockRejectedValue(new Error("exec_reap_expired_leases failed: timeout"));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP]);
    registerScheduledWork(intervalWork);
    const r = await runSchedulerTick(noon);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(r.summary).toBe("principals=1 enqueued=1 reaped=0 errors=1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("could not reap expired leases"));
  });

  it("fails the tick when the principals can't be listed", async () => {
    vi.mocked(listEnabledPrincipals).mockRejectedValue(new Error("exec_principals read failed: connection refused"));
    registerScheduledWork(intervalWork);
    await expect(runSchedulerTick(noon)).rejects.toThrow(/exec_principals read failed/);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("uses the current time by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(at("2026-11-04T12:00:00Z"));
      vi.mocked(listEnabledPrincipals).mockResolvedValue([nyP]);
      registerScheduledWork(intervalWork);
      await runSchedulerTick();
      expect(vi.mocked(enqueueJob).mock.calls[0]?.[0].dedupeKey).toBe("test.interval:ep_1:i5979312");
    } finally {
      vi.useRealTimers();
    }
  });
});
