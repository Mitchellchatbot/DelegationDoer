import { describe, expect, it } from "vitest";
import { snoozePresets, type SnoozePreset } from "@/lib/exec/ui/snooze-presets";

// P5a contract §5.5 test 68 (C4): the snooze presets, in his zone, across days
// and DST changes, always inside the route's bounds.

const NY = "America/New_York";
const at = (presets: SnoozePreset[], key: SnoozePreset["key"]) => presets.find((p) => p.key === key)?.until;

describe("snoozePresets (test 68)", () => {
  it("labels, in order", () => {
    expect(snoozePresets(new Date("2026-11-06T15:00:00.000Z"), NY).map((p) => p.label)).toEqual(["3 hours", "Tomorrow 8:00", "Monday 8:00", "In a week, 8:00"]);
  });

  it("at 23:30 in New York, 'Tomorrow 8:00' is the next local day, not the next UTC day", () => {
    // Thursday Nov 5, 23:30 EST = Friday 04:30Z.
    const p = snoozePresets(new Date("2026-11-06T04:30:00.000Z"), NY);
    expect(at(p, "tomorrow")).toBe("2026-11-06T13:00:00.000Z");
    expect(at(p, "3h")).toBe("2026-11-06T07:30:00.000Z");
  });

  it("on a Friday, 'Monday 8:00' is the coming Monday; on a Monday it is the next one", () => {
    expect(at(snoozePresets(new Date("2026-11-06T15:00:00.000Z"), NY), "monday")).toBe("2026-11-09T13:00:00.000Z");
    // Monday Nov 9, 07:00 EST: not later today, a week on.
    expect(at(snoozePresets(new Date("2026-11-09T12:00:00.000Z"), NY), "monday")).toBe("2026-11-16T13:00:00.000Z");
    // Sunday evening: tomorrow and Monday are the same morning.
    const sunday = snoozePresets(new Date("2026-11-08T23:00:00.000Z"), NY);
    expect(at(sunday, "monday")).toBe("2026-11-09T13:00:00.000Z");
    expect(at(sunday, "tomorrow")).toBe("2026-11-09T13:00:00.000Z");
  });

  it("DST ends (Nov 1, 2026): 8:00 is 8:00 EST, not 7:00", () => {
    // Saturday Oct 31, 22:00 EDT = Nov 1 02:00Z.
    const p = snoozePresets(new Date("2026-11-01T02:00:00.000Z"), NY);
    expect(at(p, "tomorrow")).toBe("2026-11-01T13:00:00.000Z");
    expect(at(p, "monday")).toBe("2026-11-02T13:00:00.000Z");
    expect(at(p, "week")).toBe("2026-11-07T13:00:00.000Z");
    expect(at(p, "3h")).toBe("2026-11-01T05:00:00.000Z");
  });

  it("DST starts (Mar 8, 2026): 8:00 is 8:00 EDT", () => {
    // Saturday Mar 7, 20:00 EST = Mar 8 01:00Z.
    const p = snoozePresets(new Date("2026-03-08T01:00:00.000Z"), NY);
    expect(at(p, "tomorrow")).toBe("2026-03-08T12:00:00.000Z");
    expect(at(p, "week")).toBe("2026-03-14T12:00:00.000Z");
  });

  it("in another zone (Karachi), 8:00 local", () => {
    const p = snoozePresets(new Date("2026-11-06T15:00:00.000Z"), "Asia/Karachi");
    expect(at(p, "tomorrow")).toBe("2026-11-07T03:00:00.000Z");
  });

  it("every preset is more than a minute and at most 90 days ahead (C4)", () => {
    for (const iso of ["2026-11-06T04:59:30.000Z", "2026-11-06T15:00:00.000Z", "2026-03-08T01:00:00.000Z", "2026-12-31T23:59:59.000Z"]) {
      const now = new Date(iso).getTime();
      for (const p of snoozePresets(new Date(iso), NY)) {
        const t = Date.parse(p.until);
        expect(t).toBeGreaterThan(now + 60_000);
        expect(t).toBeLessThanOrEqual(now + 90 * 86_400_000);
      }
    }
  });

  it("an unknown zone falls back to New York; a bad date gives none", () => {
    expect(snoozePresets(new Date("2026-11-06T04:30:00.000Z"), "Mars/Base")).toEqual(snoozePresets(new Date("2026-11-06T04:30:00.000Z"), NY));
    expect(snoozePresets(new Date("nope"), NY)).toEqual([]);
  });
});
