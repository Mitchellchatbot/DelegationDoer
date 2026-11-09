import { describe, expect, it } from "vitest";

import { bucketFromDedupeKey, isInWorkWindow, sweepBucketDue, type WeeklySchedule } from "@/lib/exec/slack-schedule";
import { intervalBucket } from "@/lib/exec/time";

// P7a §5.16 SD01-SD08 (Area B): the sweep's work window and due rule (N6, C14). Pure; every instant is UTC and the window
// is judged in the principal's zone.

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);
const WEEKDAYS_9_TO_5: WeeklySchedule = { mon: { start: "09:00", end: "17:00" }, tue: { start: "09:00", end: "17:00" } };

describe("isInWorkWindow: the default window (no usable schedule)", () => {
  it("SD01 a weekday 10:00 in New York is in the default 08:00-19:00 Monday-Friday window", () => {
    // 2026-11-09 is a Monday; 15:00Z = 10:00 EST.
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, {})).toBe(true);
    expect(isInWorkWindow(at("2026-11-13T15:00:00Z"), NY, {})).toBe(true);   // Friday
  });

  it("SD02 Saturday and Sunday 10:00 are out", () => {
    expect(isInWorkWindow(at("2026-11-14T15:00:00Z"), NY, {})).toBe(false);
    expect(isInWorkWindow(at("2026-11-15T15:00:00Z"), NY, {})).toBe(false);
  });

  it("SD03 19:00 is out, 18:59 in; 07:59 out, 08:00 in (the end is exclusive)", () => {
    expect(isInWorkWindow(at("2026-11-10T00:00:00Z"), NY, {})).toBe(false);   // Mon 19:00 EST
    expect(isInWorkWindow(at("2026-11-09T23:59:00Z"), NY, {})).toBe(true);    // Mon 18:59
    expect(isInWorkWindow(at("2026-11-09T12:59:00Z"), NY, {})).toBe(false);   // Mon 07:59
    expect(isInWorkWindow(at("2026-11-09T13:00:00Z"), NY, {})).toBe(true);    // Mon 08:00
    // The same instant is judged in his zone, not the server's: 15:00Z on a Monday is 07:00 in Los Angeles.
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), "America/Los_Angeles", {})).toBe(false);
  });

  it("a schedule whose days are all null, missing or malformed reads as empty: the default window", () => {
    const allNull: WeeklySchedule = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, allNull)).toBe(true);
    const malformed = { mon: { start: "9am", end: "5pm" }, tue: { start: "25:00", end: "26:00" } } as WeeklySchedule;
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, malformed)).toBe(true);
    expect(isInWorkWindow(at("2026-11-14T15:00:00Z"), NY, malformed)).toBe(false);
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, null as unknown as WeeklySchedule)).toBe(true);
  });
});

describe("isInWorkWindow: his weekly_schedule", () => {
  it("SD04 a Tuesday-Saturday schedule: Saturday 11:00 in, Monday 11:00 out", () => {
    const tueSat: WeeklySchedule = {
      tue: { start: "10:00", end: "18:00" }, wed: { start: "10:00", end: "18:00" }, thu: { start: "10:00", end: "18:00" },
      fri: { start: "10:00", end: "18:00" }, sat: { start: "10:00", end: "18:00" }
    };
    expect(isInWorkWindow(at("2026-11-14T16:00:00Z"), NY, tueSat)).toBe(true);    // Sat 11:00
    expect(isInWorkWindow(at("2026-11-09T16:00:00Z"), NY, tueSat)).toBe(false);   // Mon 11:00
    expect(isInWorkWindow(at("2026-11-10T14:59:00Z"), NY, tueSat)).toBe(false);   // Tue 09:59
    expect(isInWorkWindow(at("2026-11-10T15:00:00Z"), NY, tueSat)).toBe(true);    // Tue 10:00
    expect(isInWorkWindow(at("2026-11-10T23:00:00Z"), NY, tueSat)).toBe(false);   // Tue 18:00
  });

  it("SD05 an overnight shift (22:00-06:00): 23:00 that day in, 02:00 the next day in, 07:00 out, 21:00 out", () => {
    const nights: WeeklySchedule = { mon: { start: "22:00", end: "06:00" } };
    expect(isInWorkWindow(at("2026-11-10T04:00:00Z"), NY, nights)).toBe(true);    // Mon 23:00
    expect(isInWorkWindow(at("2026-11-10T07:00:00Z"), NY, nights)).toBe(true);    // Tue 02:00 (Monday's tail)
    expect(isInWorkWindow(at("2026-11-10T10:59:00Z"), NY, nights)).toBe(true);    // Tue 05:59
    expect(isInWorkWindow(at("2026-11-10T11:00:00Z"), NY, nights)).toBe(false);   // Tue 06:00
    expect(isInWorkWindow(at("2026-11-10T12:00:00Z"), NY, nights)).toBe(false);   // Tue 07:00
    expect(isInWorkWindow(at("2026-11-10T02:00:00Z"), NY, nights)).toBe(false);   // Mon 21:00
    // A Sunday night shift runs into Monday.
    expect(isInWorkWindow(at("2026-11-09T07:00:00Z"), NY, { sun: { start: "22:00", end: "06:00" } })).toBe(true);   // Mon 02:00
  });

  it("SD06 DST change days: the window follows the wall clock across the change", () => {
    // US DST starts Sunday 2026-03-08; Monday 2026-03-09 08:00 EDT = 12:00Z (it was 13:00Z the week before).
    expect(isInWorkWindow(at("2026-03-09T12:00:00Z"), NY, {})).toBe(true);
    expect(isInWorkWindow(at("2026-03-09T11:59:00Z"), NY, {})).toBe(false);
    expect(isInWorkWindow(at("2026-03-02T12:00:00Z"), NY, {})).toBe(false);   // 07:00 EST the Monday before
    // DST ends Sunday 2026-11-01; Monday 2026-11-02 08:00 EST = 13:00Z.
    expect(isInWorkWindow(at("2026-11-02T13:00:00Z"), NY, {})).toBe(true);
    expect(isInWorkWindow(at("2026-11-02T12:59:00Z"), NY, {})).toBe(false);
    // A Sunday schedule on the change day itself: 02:30 doesn't exist on 2026-03-08, 03:30 EDT (07:30Z) is in a 03:00-04:00 span.
    expect(isInWorkWindow(at("2026-03-08T07:30:00Z"), NY, { sun: { start: "03:00", end: "04:00" } })).toBe(true);
  });

  it("SD07 a malformed entry is skipped; the other days still decide (and the default doesn't come back)", () => {
    const mixed = { mon: { start: "9:00", end: "17:00" }, tue: { start: "09:00", end: "17:00" }, wed: "always", thu: { start: "09:00" } } as unknown as WeeklySchedule;
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, mixed)).toBe(false);   // Mon 10:00: mon is malformed
    expect(isInWorkWindow(at("2026-11-10T15:00:00Z"), NY, mixed)).toBe(true);    // Tue 10:00
    expect(isInWorkWindow(at("2026-11-11T15:00:00Z"), NY, mixed)).toBe(false);   // Wed
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, WEEKDAYS_9_TO_5)).toBe(true);
    // A zero-length day is no window.
    expect(isInWorkWindow(at("2026-11-09T15:00:00Z"), NY, { mon: { start: "10:00", end: "10:00" }, tue: { start: "09:00", end: "17:00" } })).toBe(false);
  });
});

describe("sweepBucketDue and bucketFromDedupeKey (SD08)", () => {
  it("SD08 sweepBucketDue: forced or in the window always; otherwise every sixth bucket (every 3 h at 30 minutes)", () => {
    const table: [number, boolean, boolean, boolean][] = [
      [7, false, true, true], [7, true, false, true], [7, false, false, false], [6, false, false, true], [0, false, false, true],
      [12, false, false, true], [13, false, false, false], [5, false, false, false], [-6, false, false, false], [Number.NaN, false, false, false],
      [6.5, false, false, false]
    ];
    for (const [bucket, inWindow, forced, due] of table) expect(sweepBucketDue(bucket, inWindow, forced), `${bucket} ${inWindow} ${forced}`).toBe(due);
    // The scheduler's 30-minute buckets: one off-window run every 3 hours.
    const base = intervalBucket(at("2026-11-14T00:00:00Z"), 30);
    const due = Array.from({ length: 12 }, (_, i) => sweepBucketDue(base + i, false, false)).filter(Boolean);
    expect(due).toHaveLength(2);
  });

  it("SD08 bucketFromDedupeKey reads the scheduler's interval key, and nothing else", () => {
    expect(bucketFromDedupeKey("exec.slack-read-sweep:ep_0123456789abcdef:i986583")).toBe(986583);
    expect(bucketFromDedupeKey("exec.slack-read-sweep:ep_x:i0")).toBe(0);
    for (const key of [null, "", "exec.slack-read-sweep:ep_x:2026-11-14", "exec.slack-read-sweep:ep_x:i", "exec.slack-read-sweep:ep_x:i12a",
      "exec.slack-read-sweep:i12", "a:b:c:i12", "exec.slack-read-sweep:ep_x:i1234567890123456", " exec.slack-read-sweep:ep_x:i3"]) {
      expect(bucketFromDedupeKey(key), String(key)).toBeNull();
    }
  });
});
