import { describe, expect, it } from "vitest";
import { MISSING, ageLabel, formatCount, formatInZone, pluralize } from "@/lib/exec/format";

// ICU builds before 74 put a narrow no-break space before AM/PM; compare
// without caring which space the runtime's ICU picked.
const NNBSP = String.fromCharCode(0x202f);
const norm = (s: string) => s.split(NNBSP).join(" ");
const fmt = (...args: Parameters<typeof formatInZone>) => norm(formatInZone(...args));

const NY = "America/New_York";

describe("formatInZone", () => {
  it("formats an instant in the principal's zone, with the zone named", () => {
    expect(fmt("2026-11-04T13:02:00Z", NY, "datetime")).toBe("Nov 4, 8:02 AM EST");
    expect(fmt("2026-11-04T13:02:00Z", NY, "time")).toBe("8:02 AM EST");
    expect(fmt("2026-11-04T13:02:00Z", NY, "date")).toBe("Nov 4");
    expect(fmt("2026-11-04T13:02:00Z", "Asia/Karachi", "datetime")).toBe("Nov 4, 6:02 PM GMT+5");
  });

  it("defaults to datetime", () => {
    expect(fmt("2026-11-04T13:02:00Z", NY)).toBe("Nov 4, 8:02 AM EST");
  });

  it("follows daylight saving time (EDT in July, EST in November)", () => {
    expect(fmt("2026-07-04T13:02:00Z", NY, "time")).toBe("9:02 AM EDT");
    expect(fmt("2026-11-01T05:30:00Z", NY, "time")).toBe("1:30 AM EDT");
    expect(fmt("2026-11-01T06:30:00Z", NY, "time")).toBe("1:30 AM EST");
  });

  it("dates by the principal's calendar, not UTC's", () => {
    // 02:00 UTC on Nov 5 is still the evening of Nov 4 in New York.
    expect(fmt("2026-11-05T02:00:00Z", NY, "date")).toBe("Nov 4");
    expect(fmt("2026-11-05T02:00:00Z", "UTC", "date")).toBe("Nov 5");
  });

  it("reads Postgres timestamptz text (microseconds, explicit offset)", () => {
    expect(fmt("2026-11-04T13:02:00.123456+00:00", NY, "datetime")).toBe("Nov 4, 8:02 AM EST");
  });

  it("gives a dash, never a throw, for missing or unreadable input", () => {
    for (const bad of [null, undefined, "", "not a date", "2026-13-45T00:00:00Z"]) {
      expect(formatInZone(bad as string | null | undefined, NY, "datetime")).toBe(MISSING);
    }
    expect(MISSING).toBe("—");
  });

  it("falls back to New York (and says EST/EDT) for a zone Intl doesn't know", () => {
    expect(fmt("2026-11-04T13:02:00Z", "Mars/Olympus_Mons", "datetime")).toBe("Nov 4, 8:02 AM EST");
    expect(fmt("2026-11-04T13:02:00Z", "", "time")).toBe("8:02 AM EST");
  });

  it("formats a bare YYYY-MM-DD as that calendar date in every zone", () => {
    for (const tz of [NY, "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Karachi"]) {
      expect(fmt("2026-11-04", tz, "date")).toBe("Nov 4");
      expect(fmt("2026-11-04", tz, "datetime")).toBe("Nov 4");
      // A calendar date has no time of day to show.
      expect(fmt("2026-11-04", tz, "time")).toBe(MISSING);
    }
  });

  it("refuses a calendar date that doesn't exist", () => {
    expect(fmt("2026-02-30", NY, "date")).toBe(MISSING);
    expect(fmt("2026-00-10", NY, "date")).toBe(MISSING);
  });

  it("adds the year only when `now` is in a different year, so last December doesn't read as upcoming", () => {
    const now = new Date("2026-11-04T15:00:00Z");
    expect(fmt("2025-12-15T15:00:00Z", NY, "date", now)).toBe("Dec 15, 2025");
    expect(fmt("2025-12-15T15:00:00Z", NY, "datetime", now)).toBe("Dec 15, 2025, 10:00 AM EST");
    expect(fmt("2025-12-15", NY, "date", now)).toBe("Dec 15, 2025");
    expect(fmt("2026-03-01T15:00:00Z", NY, "date", now)).toBe("Mar 1");
    expect(fmt("2026-03-01", NY, "date", now.toISOString())).toBe("Mar 1");
    // A time never carries a year.
    expect(fmt("2025-12-15T15:00:00Z", NY, "time", now)).toBe("10:00 AM EST");
    // An unreadable `now` just means "don't know the year": no year added.
    expect(fmt("2025-12-15T15:00:00Z", NY, "date", "nonsense")).toBe("Dec 15");
  });

  it("compares years in the principal's zone", () => {
    // 03:00 UTC on Jan 1 2026 is 10 PM on Dec 31 2025 in New York.
    const now = new Date("2026-01-01T03:00:00Z");
    expect(fmt("2026-01-01T03:00:00Z", NY, "date", now)).toBe("Dec 31");
    expect(fmt("2025-06-01T12:00:00Z", NY, "date", now)).toBe("Jun 1");
    expect(fmt("2026-01-01T12:00:00Z", NY, "date", now)).toBe("Jan 1, 2026");
  });
});

describe("ageLabel", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("is a bare duration: just now, minutes, hours, days", () => {
    expect(ageLabel(ago(0), now)).toBe("just now");
    expect(ageLabel(ago(59_000), now)).toBe("just now");
    expect(ageLabel(ago(60_000), now)).toBe("1 min");
    expect(ageLabel(ago(5 * 60_000), now)).toBe("5 min");
    expect(ageLabel(ago(59 * 60_000 + 59_000), now)).toBe("59 min");
    expect(ageLabel(ago(60 * 60_000), now)).toBe("1 h");
    expect(ageLabel(ago(3 * 3_600_000), now)).toBe("3 h");
    expect(ageLabel(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe("23 h");
    expect(ageLabel(ago(24 * 3_600_000), now)).toBe("1 d");
    expect(ageLabel(ago(4 * 86_400_000), now)).toBe("4 d");
    expect(ageLabel(ago(45 * 86_400_000), now)).toBe("45 d");
  });

  it("never says 'ago', so no caller can build 'just now ago'", () => {
    for (const ms of [0, 90_000, 7_200_000, 900_000_000]) expect(ageLabel(ago(ms), now)).not.toMatch(/ago/);
  });

  it("reads a timestamp slightly in the future (clock skew) as just now", () => {
    expect(ageLabel(new Date(now.getTime() + 30_000).toISOString(), now)).toBe("just now");
  });

  it("takes now as an ISO string too", () => {
    expect(ageLabel(ago(5 * 60_000), now.toISOString())).toBe("5 min");
  });

  it("gives a dash for missing or unreadable input", () => {
    expect(ageLabel(null, now)).toBe(MISSING);
    expect(ageLabel(undefined, now)).toBe(MISSING);
    expect(ageLabel("garbage", now)).toBe(MISSING);
    expect(ageLabel(ago(60_000), "garbage")).toBe(MISSING);
  });
});

describe("formatCount and pluralize", () => {
  it("formats counts with separators, a dash for unknown", () => {
    expect(formatCount(1204)).toBe("1,204");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(2.25)).toBe("2.3");
    expect(formatCount(null)).toBe(MISSING);
    expect(formatCount(undefined)).toBe(MISSING);
    expect(formatCount(Number.NaN)).toBe(MISSING);
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });

  it("picks singular only for exactly one", () => {
    expect(pluralize(1, "task")).toBe("1 task");
    expect(pluralize(0, "task")).toBe("0 tasks");
    expect(pluralize(3, "task")).toBe("3 tasks");
    expect(pluralize(1204, "task")).toBe("1,204 tasks");
    expect(pluralize(1, "person", "people")).toBe("1 person");
    expect(pluralize(2, "person", "people")).toBe("2 people");
  });
});
