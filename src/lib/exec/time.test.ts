import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  endOfLocalDateUtc,
  intervalBucket,
  isLocalTimeReached,
  isoWeekKey,
  localDateString,
  localMinutes,
  localTimeToUtc,
  parseLocalTime,
  startOfLocalDayUtc,
  tzOffsetMinutes,
  zonedParts
} from "@/lib/exec/time";

// Reference instants were checked against this runtime's tz database
// (Node 24, ICU 78, tz 2026a). The 2026 US transitions:
//   spring forward  Sun 2026-03-08 07:00Z: 01:59:59 EST → 03:00:00 EDT
//   fall back       Sun 2026-11-01 06:00Z: 01:59:59 EDT → 01:00:00 EST
// Asia/Karachi is UTC+5 all year; Kolkata +5:30 and Kathmandu +5:45 cover
// sub-hour offsets.

const NY = "America/New_York";
const KHI = "Asia/Karachi";
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("zonedParts", () => {
  it("reads wall-clock fields in UTC", () => {
    expect(zonedParts(at("2026-11-04T00:00:00Z"), "UTC")).toEqual({
      year: 2026,
      month: 11,
      day: 4,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 3
    });
  });

  it("crosses the date line backwards in New York and forwards in Karachi", () => {
    expect(zonedParts(at("2026-11-04T03:30:15Z"), NY)).toEqual({
      year: 2026,
      month: 11,
      day: 3,
      hour: 22,
      minute: 30,
      second: 15,
      weekday: 2
    });
    expect(zonedParts(at("2026-11-04T19:00:00Z"), KHI)).toMatchObject({ month: 11, day: 5, hour: 0, minute: 0, weekday: 4 });
  });

  it("maps weekdays to ISO numbers, Sunday = 7", () => {
    expect(zonedParts(at("2026-11-08T12:00:00Z"), "UTC").weekday).toBe(7);
    expect(zonedParts(at("2026-11-09T12:00:00Z"), "UTC").weekday).toBe(1);
    expect(zonedParts(at("2026-11-07T12:00:00Z"), "UTC").weekday).toBe(6);
  });

  it("reports midnight as hour 0, not 24", () => {
    expect(zonedParts(at("2026-03-08T05:00:00Z"), NY).hour).toBe(0);
    expect(zonedParts(at("2026-11-04T19:00:00Z"), KHI).hour).toBe(0);
  });

  it("follows both 2026 New York DST transitions", () => {
    expect(zonedParts(at("2026-03-08T06:59:59Z"), NY)).toMatchObject({ hour: 1, minute: 59, second: 59 });
    expect(zonedParts(at("2026-03-08T07:00:00Z"), NY)).toMatchObject({ hour: 3, minute: 0, second: 0 });
    expect(zonedParts(at("2026-11-01T05:59:59Z"), NY)).toMatchObject({ hour: 1, minute: 59, second: 59 });
    expect(zonedParts(at("2026-11-01T06:00:00Z"), NY)).toMatchObject({ hour: 1, minute: 0, second: 0 });
  });
});

describe("localDateString", () => {
  it("is the calendar date in the given zone", () => {
    const instant = at("2026-11-04T03:00:00Z");
    expect(localDateString(instant, NY)).toBe("2026-11-03");
    expect(localDateString(instant, KHI)).toBe("2026-11-04");
    expect(localDateString(instant, "UTC")).toBe("2026-11-04");
  });

  it("zero-pads month and day", () => {
    expect(localDateString(at("2026-03-08T12:00:00Z"), NY)).toBe("2026-03-08");
    expect(localDateString(at("2027-01-01T00:00:00Z"), "UTC")).toBe("2027-01-01");
  });

  it("keeps one date across both readings of the repeated fall-back hour", () => {
    expect(localDateString(at("2026-11-01T05:30:00Z"), NY)).toBe("2026-11-01");
    expect(localDateString(at("2026-11-01T06:30:00Z"), NY)).toBe("2026-11-01");
  });
});

describe("localMinutes", () => {
  it("counts minutes since local midnight", () => {
    expect(localMinutes(at("2026-11-04T00:00:00Z"), "UTC")).toBe(0);
    expect(localMinutes(at("2026-11-04T23:59:59Z"), "UTC")).toBe(1439);
    expect(localMinutes(at("2026-11-04T03:00:00Z"), KHI)).toBe(8 * 60);
  });

  it("jumps across the missing spring-forward hour and repeats the fall-back hour", () => {
    expect(localMinutes(at("2026-03-08T06:59:00Z"), NY)).toBe(119);
    expect(localMinutes(at("2026-03-08T07:00:00Z"), NY)).toBe(180);
    expect(localMinutes(at("2026-11-01T05:30:00Z"), NY)).toBe(90);
    expect(localMinutes(at("2026-11-01T06:30:00Z"), NY)).toBe(90);
  });
});

describe("parseLocalTime", () => {
  it.each([
    ["00:00", 0],
    ["08:00", 480],
    ["03:30", 210],
    ["23:59", 1439]
  ])("parses %s", (hhmm, minutes) => {
    expect(parseLocalTime(hhmm)).toBe(minutes);
  });

  it.each(["24:00", "7:30", "07:60", "", "07:30:00", " 07:30", "0730", "ab:cd", "-1:00"])("rejects %j", (hhmm) => {
    expect(parseLocalTime(hhmm)).toBeNull();
  });
});

describe("isLocalTimeReached", () => {
  it("is false before, true at and after the local time", () => {
    expect(isLocalTimeReached(at("2026-11-04T12:59:59Z"), NY, "08:00")).toBe(false);
    expect(isLocalTimeReached(at("2026-11-04T13:00:00Z"), NY, "08:00")).toBe(true);
    expect(isLocalTimeReached(at("2026-11-05T04:59:00Z"), NY, "08:00")).toBe(true);
  });

  it("uses the zone's wall clock, not the server's", () => {
    const instant = at("2026-11-04T03:00:00Z");
    expect(isLocalTimeReached(instant, KHI, "08:00")).toBe(true);
    expect(isLocalTimeReached(instant, NY, "08:00")).toBe(true); // 22:00 the evening before
    expect(isLocalTimeReached(instant, "UTC", "08:00")).toBe(false);
  });

  it("resets at local midnight", () => {
    expect(isLocalTimeReached(at("2026-11-04T18:59:00Z"), KHI, "23:00")).toBe(true);
    expect(isLocalTimeReached(at("2026-11-04T19:00:00Z"), KHI, "23:00")).toBe(false);
  });

  it("treats a time inside the skipped spring-forward hour as reached at 03:00", () => {
    expect(isLocalTimeReached(at("2026-03-08T06:59:59Z"), NY, "02:30")).toBe(false);
    expect(isLocalTimeReached(at("2026-03-08T07:00:00Z"), NY, "02:30")).toBe(true);
  });

  it("reads the repeated fall-back hour as wall time, so 01:30 is reached twice", () => {
    expect(isLocalTimeReached(at("2026-11-01T05:29:59Z"), NY, "01:30")).toBe(false);
    expect(isLocalTimeReached(at("2026-11-01T05:30:00Z"), NY, "01:30")).toBe(true);
    // The clock goes back to 01:00 EST, and 01:30 isn't reached again until 06:30Z.
    expect(isLocalTimeReached(at("2026-11-01T06:00:00Z"), NY, "01:30")).toBe(false);
    expect(isLocalTimeReached(at("2026-11-01T06:30:00Z"), NY, "01:30")).toBe(true);
  });

  it("is never reached for a malformed time", () => {
    expect(isLocalTimeReached(at("2026-11-04T23:59:00Z"), "UTC", "25:00")).toBe(false);
    expect(isLocalTimeReached(at("2026-11-04T23:59:00Z"), "UTC", "8:00")).toBe(false);
  });
});

describe("tzOffsetMinutes", () => {
  it.each([
    ["2026-01-15T12:00:00Z", NY, -300],
    ["2026-07-15T12:00:00Z", NY, -240],
    ["2026-03-08T06:59:59Z", NY, -300],
    ["2026-03-08T07:00:00Z", NY, -240],
    ["2026-11-01T05:59:59Z", NY, -240],
    ["2026-11-01T06:00:00Z", NY, -300],
    ["2026-07-15T12:00:00Z", KHI, 300],
    ["2026-01-15T12:00:00Z", KHI, 300],
    ["2026-07-15T12:00:00Z", "Asia/Kolkata", 330],
    ["2026-07-15T12:00:00Z", "Asia/Kathmandu", 345],
    ["2026-07-15T12:00:00Z", "UTC", 0]
  ])("%s in %s is %i", (instant, tz, minutes) => {
    expect(tzOffsetMinutes(at(instant), tz)).toBe(minutes);
  });

  it("ignores sub-second precision", () => {
    expect(tzOffsetMinutes(at("2026-07-15T12:00:00.999Z"), NY)).toBe(-240);
    expect(tzOffsetMinutes(at("2026-07-15T12:00:00.001Z"), KHI)).toBe(300);
  });
});

describe("startOfLocalDayUtc", () => {
  it.each([
    // New York, ordinary days on each side of DST
    ["2026-01-15T12:00:00Z", NY, "2026-01-15T05:00:00.000Z"],
    ["2026-07-15T12:00:00Z", NY, "2026-07-15T04:00:00.000Z"],
    // Spring-forward day: midnight was still EST, wherever in the day we ask
    ["2026-03-08T06:59:59Z", NY, "2026-03-08T05:00:00.000Z"],
    ["2026-03-08T07:00:00Z", NY, "2026-03-08T05:00:00.000Z"],
    ["2026-03-08T12:00:00Z", NY, "2026-03-08T05:00:00.000Z"],
    ["2026-03-09T03:59:59Z", NY, "2026-03-08T05:00:00.000Z"],
    ["2026-03-09T12:00:00Z", NY, "2026-03-09T04:00:00.000Z"],
    // Fall-back day: midnight was still EDT, including during the repeated hour
    ["2026-11-01T05:30:00Z", NY, "2026-11-01T04:00:00.000Z"],
    ["2026-11-01T06:30:00Z", NY, "2026-11-01T04:00:00.000Z"],
    ["2026-11-01T12:00:00Z", NY, "2026-11-01T04:00:00.000Z"],
    ["2026-11-02T04:59:59Z", NY, "2026-11-01T04:00:00.000Z"],
    ["2026-11-02T12:00:00Z", NY, "2026-11-02T05:00:00.000Z"],
    // Karachi (no DST), both sides of its midnight
    ["2026-11-04T18:59:59Z", KHI, "2026-11-03T19:00:00.000Z"],
    ["2026-11-04T19:00:00Z", KHI, "2026-11-04T19:00:00.000Z"],
    ["2026-07-01T00:00:00Z", KHI, "2026-06-30T19:00:00.000Z"],
    // UTC, and a half-hour zone
    ["2026-11-04T23:59:59.999Z", "UTC", "2026-11-04T00:00:00.000Z"],
    ["2026-11-04T00:00:00Z", "UTC", "2026-11-04T00:00:00.000Z"],
    ["2026-11-04T18:29:59Z", "Asia/Kolkata", "2026-11-03T18:30:00.000Z"],
    // Santiago springs forward AT midnight (23:59:59 → 01:00), so that local
    // day starts at 01:00 local
    ["2026-09-06T12:00:00Z", "America/Santiago", "2026-09-06T04:00:00.000Z"]
  ])("%s in %s → %s", (instant, tz, expected) => {
    expect(iso(startOfLocalDayUtc(at(instant), tz))).toBe(expected);
  });

  it("returns an instant whose local date is the input's local date, at 00:00", () => {
    for (const instant of ["2026-03-08T12:00:00Z", "2026-11-01T12:00:00Z", "2026-11-04T03:00:00Z"]) {
      const start = startOfLocalDayUtc(at(instant), NY);
      expect(localDateString(start, NY)).toBe(localDateString(at(instant), NY));
      expect(localMinutes(start, NY)).toBe(0);
      expect(start.getTime()).toBeLessThanOrEqual(at(instant).getTime());
    }
  });
});

describe("isoWeekKey", () => {
  it.each([
    ["2026-11-04T12:00:00Z", "2026-W45"],
    ["2026-11-08T12:00:00Z", "2026-W45"], // Sunday still belongs to Monday's week
    ["2026-11-09T12:00:00Z", "2026-W46"],
    // 2026 starts on a Thursday: its week 1 begins Mon 2025-12-29 …
    ["2025-12-29T12:00:00Z", "2026-W01"],
    ["2026-01-01T12:00:00Z", "2026-W01"],
    ["2026-01-04T12:00:00Z", "2026-W01"],
    ["2026-01-05T12:00:00Z", "2026-W02"],
    // … and it has 53 weeks, so the first days of 2027 are still 2026-W53
    ["2026-12-31T12:00:00Z", "2026-W53"],
    ["2027-01-01T12:00:00Z", "2026-W53"],
    ["2027-01-03T12:00:00Z", "2026-W53"],
    ["2027-01-04T12:00:00Z", "2027-W01"],
    // The end of December can belong to next year's week 1
    ["2024-12-29T12:00:00Z", "2024-W52"],
    ["2024-12-30T12:00:00Z", "2025-W01"],
    // 2020 (leap year starting on a Wednesday) had a week 53
    ["2021-01-03T12:00:00Z", "2020-W53"],
    ["2021-01-04T12:00:00Z", "2021-W01"]
  ])("%s → %s", (instant, key) => {
    expect(isoWeekKey(at(instant), "UTC")).toBe(key);
  });

  it("uses the local date, so one instant can fall in different weeks by zone", () => {
    const instant = at("2027-01-04T03:00:00Z");
    expect(isoWeekKey(instant, "UTC")).toBe("2027-W01");
    expect(isoWeekKey(instant, KHI)).toBe("2027-W01");
    expect(isoWeekKey(instant, NY)).toBe("2026-W53"); // still Sunday evening
  });
});

describe("intervalBucket", () => {
  // 2026-11-04T12:00:00Z is epoch minute 29,896,560 (a multiple of 5, 10, 30 and 60).
  it("is floor(epochMinutes / minutes)", () => {
    const noon = at("2026-11-04T12:00:00Z");
    expect(intervalBucket(noon, 5)).toBe(5_979_312);
    expect(intervalBucket(noon, 10)).toBe(2_989_656);
    expect(intervalBucket(noon, 30)).toBe(996_552);
    expect(intervalBucket(noon, 60)).toBe(498_276);
    expect(intervalBucket(at("1970-01-01T00:00:00Z"), 5)).toBe(0);
  });

  it("stays constant within a bucket and steps at its boundary", () => {
    expect(intervalBucket(at("2026-11-04T12:04:59.999Z"), 5)).toBe(5_979_312);
    expect(intervalBucket(at("2026-11-04T12:05:00Z"), 5)).toBe(5_979_313);
  });

  it("is independent of time zones and DST (epoch-based)", () => {
    const before = intervalBucket(at("2026-11-01T05:59:00Z"), 60);
    const after = intervalBucket(at("2026-11-01T06:00:00Z"), 60);
    expect(after - before).toBe(1);
  });

  it("floors fractional minutes and treats anything under 1 as 1", () => {
    const t = at("2026-11-04T12:03:00Z");
    expect(intervalBucket(t, 2.9)).toBe(intervalBucket(t, 2));
    expect(intervalBucket(t, 0)).toBe(intervalBucket(t, 1));
    expect(intervalBucket(t, -5)).toBe(intervalBucket(t, 1));
    expect(intervalBucket(t, 1)).toBe(29_896_563);
  });
});

// ---------------------------------------------------------------------------
// P8 (contract §3.6, §5.4 SC01-SC05): localTimeToUtc, addLocalDays, endOfLocalDateUtc
// ---------------------------------------------------------------------------

describe("localTimeToUtc (P8)", () => {
  it("SC01 08:00 in New York: 13:00Z in winter (EST), 12:00Z in summer (EDT)", () => {
    expect(iso(localTimeToUtc("2026-11-06", "08:00", NY))).toBe("2026-11-06T13:00:00.000Z");
    expect(iso(localTimeToUtc("2026-07-06", "08:00", NY))).toBe("2026-07-06T12:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "00:00", NY))).toBe("2026-11-06T05:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "23:59", NY))).toBe("2026-11-07T04:59:00.000Z");
  });

  it("SC02 a zone east of UTC (Manila, +8) and a half-hour offset (Kolkata, +5:30), across the UTC date line", () => {
    expect(iso(localTimeToUtc("2026-11-06", "08:00", "Asia/Manila"))).toBe("2026-11-06T00:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "06:00", "Asia/Manila"))).toBe("2026-11-05T22:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "08:00", "Asia/Kolkata"))).toBe("2026-11-06T02:30:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "03:00", "Asia/Kolkata"))).toBe("2026-11-05T21:30:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "08:00", KHI))).toBe("2026-11-06T03:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-06", "08:00", "UTC"))).toBe("2026-11-06T08:00:00.000Z");
  });

  it("SC03 spring forward (2027-03-14): 02:30 doesn't exist and maps to 03:00 EDT = 07:00Z, as isLocalTimeReached does", () => {
    const t = localTimeToUtc("2027-03-14", "02:30", NY);
    expect(iso(t)).toBe("2027-03-14T07:00:00.000Z");
    expect(localDateString(t, NY)).toBe("2027-03-14");
    expect(localMinutes(t, NY)).toBe(180);
    // The scheduler finds 02:30 due at that same instant and not a minute before.
    expect(isLocalTimeReached(t, NY, "02:30")).toBe(true);
    expect(isLocalTimeReached(new Date(t.getTime() - 60_000), NY, "02:30")).toBe(false);
    // The hour around the gap: 01:59 EST and 03:00 EDT are one minute apart.
    expect(iso(localTimeToUtc("2027-03-14", "01:59", NY))).toBe("2027-03-14T06:59:00.000Z");
    expect(iso(localTimeToUtc("2027-03-14", "03:00", NY))).toBe("2027-03-14T07:00:00.000Z");
    expect(iso(localTimeToUtc("2026-03-08", "02:00", NY))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("SC04 fall back (2026-11-01): 01:30 happens twice and maps to its first occurrence, 05:30Z (EDT)", () => {
    expect(iso(localTimeToUtc("2026-11-01", "01:30", NY))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(localTimeToUtc("2026-11-01", "00:59", NY))).toBe("2026-11-01T04:59:00.000Z");
    expect(iso(localTimeToUtc("2026-11-01", "02:00", NY))).toBe("2026-11-01T07:00:00.000Z");
    expect(iso(localTimeToUtc("2026-11-01", "08:00", NY))).toBe("2026-11-01T13:00:00.000Z");
  });

  it("refuses a malformed date or time (RangeError)", () => {
    for (const [d, t] of [["2026-11-31", "08:00"], ["2026-11-6", "08:00"], ["2026-11-06", "8:00"], ["2026-11-06", "24:00"], ["2026-02-29", "08:00"]]) {
      expect(() => localTimeToUtc(d, t, NY), `${d} ${t}`).toThrow(RangeError);
    }
    expect(iso(localTimeToUtc("2028-02-29", "08:00", NY))).toBe("2028-02-29T13:00:00.000Z");
  });
});

describe("addLocalDays and endOfLocalDateUtc (P8)", () => {
  it("SC05 addLocalDays crosses month and year ends and leap days, both ways", () => {
    expect(addLocalDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addLocalDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addLocalDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addLocalDays("2026-11-06", 0)).toBe("2026-11-06");
    expect(addLocalDays("2026-10-15", 180)).toBe("2027-04-13");
    expect(() => addLocalDays("2026-11-06", 1.5)).toThrow(RangeError);
    expect(() => addLocalDays("2026-13-01", 1)).toThrow(RangeError);
  });

  it("SC05 endOfLocalDateUtc on both DST days: a 23-hour and a 25-hour local day", () => {
    const spring = "2027-03-14";
    expect(iso(endOfLocalDateUtc(spring, NY))).toBe("2027-03-15T04:00:00.000Z");
    expect(endOfLocalDateUtc(spring, NY).getTime() - localTimeToUtc(spring, "00:00", NY).getTime()).toBe(23 * 3_600_000);
    const fall = "2026-11-01";
    expect(iso(endOfLocalDateUtc(fall, NY))).toBe("2026-11-02T05:00:00.000Z");
    expect(endOfLocalDateUtc(fall, NY).getTime() - localTimeToUtc(fall, "00:00", NY).getTime()).toBe(25 * 3_600_000);
    // The end of a day is the start of the next, by startOfLocalDayUtc too.
    expect(iso(endOfLocalDateUtc("2026-11-06", NY))).toBe(iso(startOfLocalDayUtc(at("2026-11-07T12:00:00Z"), NY)));
    expect(iso(endOfLocalDateUtc("2026-11-06", "Asia/Kolkata"))).toBe("2026-11-06T18:30:00.000Z");
  });
});
