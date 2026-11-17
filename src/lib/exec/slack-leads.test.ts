import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import fbList from "@/lib/exec/__tests__/fixtures/p10/fb-list.json";
import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import { assertNoLeadText } from "@/lib/exec/__tests__/p10-assert";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import {
  briefLeadsFrom,
  briefLeadsText,
  leadChannelHref,
  leadCountsLine,
  leadCountsViewFrom,
  leadDayCovered,
  leadKindOf,
  leadLinkOf,
  leadMapRows,
  leadNeedsFinal,
  leadPrefixOf,
  leadRetentionDays,
  leadRunDue,
  leadStatesCover,
  leadsViewStateOf,
  leadWindowFor,
  tallyShapes,
  withBriefLeads
} from "@/lib/exec/slack-leads";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type {
  BriefLeads,
  BriefLeadsBlock,
  FbLeadListRow,
  LeadChannelState,
  LeadKind,
  LeadMarkerRow,
  LeadPostShape,
  LeadRunSummary,
  LeadSummaryRow
} from "@/lib/exec/slack-p10-types";
import { msToTs } from "@/lib/exec/slack-read-types";
import { addLocalDays, localTimeToUtc } from "@/lib/exec/time";

// P10 §5.2 (LK01-LK18; contract §3.4.2, C13-C20, C44, C56, C62): slack-leads.ts, pure. Fixtures: the lead's frozen
// fb-list.json and lead-history-pages.json (invented names only).

const TZ = "America/New_York";
const NOW_MS = Date.parse("2026-11-10T15:00:00.000Z");
const H = 3_600_000;

const shape = (ts: string, over: Partial<LeadPostShape> = {}): LeadPostShape => ({
  ts, reply: false, bot: true, excluded: false, hidden: false, subtypeClass: "bot_message", ...over
});
/** A ts at local hh:mm on a local date in TZ. */
const tsAt = (day: string, hhmm: string, micro = "000100"): string => {
  const ms = localTimeToUtc(day, hhmm, TZ).getTime();
  return `${Math.floor(ms / 1000)}.${micro}`;
};

describe("LK01 leadKindOf (C19)", () => {
  const table: [string | null, LeadKind][] = [
    ["zenith-house-vob-leads", "vob"],
    ["zenith-house-nonvob-leads", "nonvob"],
    ["vs-non-vob-leads", "nonvob"],
    ["vs-fb-leads-vob", "vob"],
    ["vs-fb-leads-non-vob", "nonvob"],
    ["vs-calendly", "calendly"],
    ["vs-calendly-call-booked", "calendly"],
    ["vs-zap-errors", "zap_errors"],
    ["vs-zap-error", "zap_errors"],
    ["vs-failsafe", "zap_errors"],
    ["vs-leads", "other"],
    ["vs-vob-calendly", "other"],
    ["vs-team", "other"],
    [null, "other"],
    ["", "other"],
    ["ZENITH_HOUSE.VOB.LEADS", "vob"],
    ["Zenith_House_Non_Vob", "nonvob"],
    ["zenith.house.Calendly", "calendly"],
    ["acme-zap", "other"]
  ];
  for (const [name, kind] of table) it(`${String(name)} → ${kind}`, () => expect(leadKindOf(name)).toBe(kind));
  it("non + vob consumes the vob (never counted as both, so never 'other' by two kinds)", () => {
    expect(leadKindOf("x-non-vob")).toBe("nonvob");
    expect(leadKindOf("x-vob-non-vob")).toBe("other");
  });
});

describe("LK02 leadPrefixOf", () => {
  it("the tokens before the lead suffix, ≥ 3 characters", () => {
    expect(leadPrefixOf("zenith-house-vob-leads")).toBe("zenith-house");
    expect(leadPrefixOf("vs-vob-leads")).toBeNull();
    expect(leadPrefixOf("vob-leads")).toBeNull();
    expect(leadPrefixOf("zenith-house-zap-errors")).toBe("zenith-house");
    expect(leadPrefixOf("zenith-house-non-vob")).toBe("zenith-house");
    expect(leadPrefixOf("zenith-house-fb-leads")).toBe("zenith-house");
    expect(leadPrefixOf("Acme Recovery Calendly")).toBe("acme-recovery");
    expect(leadPrefixOf("zenith-house-team")).toBeNull();
    expect(leadPrefixOf(null)).toBeNull();
  });
});

describe("LK03-LK07 leadLinkOf (C20) over fb-list.json", () => {
  for (const c of fbList.cases) {
    it(c.id, () => {
      const r = leadLinkOf(c.channel, c.list as FbLeadListRow[]);
      expect(r.link).toBe(c.expect.link);
      expect(r.row?.taskId ?? null).toBe(c.expect.taskId);
      expect(r.row?.clientId ?? null).toBe(c.expect.clientId);
    });
  }
  it("LK03 the id rule first: a typed URL id beats a name typed on another onboarding", () => {
    const c = fbList.cases[0];
    expect(leadLinkOf(c.channel, c.list as FbLeadListRow[]).link).toBe("fb_id");
  });
  it("an id typed on two different clients' cards is ambiguous (first match: the id rule)", () => {
    const list: FbLeadListRow[] = [
      { taskId: "t_a", clientId: "cl_a", clientLabel: "Acme Recovery", name: null, channelId: "C0DUP1", i: 0 },
      { taskId: "t_b", clientId: "cl_b", clientLabel: "Zenith House", name: null, channelId: "C0DUP1", i: 0 }
    ];
    expect(leadLinkOf({ id: "C0DUP1", slackName: "x-vob-leads" }, list)).toEqual({ link: "ambiguous", row: null });
  });
});

describe("LK08 leadMapRows (C18-C20, C24) over lead-history-pages.json", () => {
  const members = new Map(leadPages.memberPages.flatMap((p) => p.response.channels).map((c) => [c.id, c.name] as const));
  const markers = leadPages.markers as LeadMarkerRow[];
  const list = leadPages.fbList as FbLeadListRow[];
  it("the counted set is deny lead markers ∩ members; kinds, links, the not-member entries and toClassify", () => {
    const map = leadMapRows({ members, markers, list });
    expect(map.rows).toEqual(leadPages.expectMap.rows);
    expect(map.listedNotMember).toBe(leadPages.expectMap.listedNotMember);
    expect(new Set(map.notMember.map((n) => `${n.taskId}#${n.i}`))).toEqual(new Set(leadPages.expectMap.notMember.map((n) => `${n.taskId}#${n.i}`)));
    expect(map.toClassify).toEqual(leadPages.expectMap.toClassify);
  });
  it("a marker he isn't a member of is never counted; the order is the channel id's, whatever the input order", () => {
    const map = leadMapRows({ members, markers: [...markers].reverse(), list });
    expect(map.rows.map((r) => r.channelId)).toEqual([...map.rows.map((r) => r.channelId)].sort());
    expect(map.rows.some((r) => r.channelId === "C0LEADNOT1")).toBe(false);
    const none = leadMapRows({ members: new Map(), markers, list });
    expect(none.rows).toEqual([]);
    expect(none.listedNotMember).toBe(list.filter((r) => r.channelId !== null || r.name !== null).length);
  });
  it("the map carries no Slack name, nothing from a post (H3): ids, enums and DD labels only", () => {
    const map = leadMapRows({ members, markers, list });
    expect(JSON.stringify(map)).not.toContain("sentinel-patient-name");
    expect(() => assertNoLeadText(map)).not.toThrow();
  });
  it("notMember stays within the stored bound (≤ 50) while listedNotMember counts them all", () => {
    const many: FbLeadListRow[] = Array.from({ length: 70 }, (_, k) => ({ taskId: `t_${String(k).padStart(3, "0")}`, clientId: null, clientLabel: "Acme Recovery",
      name: `acme-${k}-vob-leads`, channelId: null, i: 0 }));
    const map = leadMapRows({ members: new Map(), markers: [], list: many });
    expect(map.listedNotMember).toBe(70);
    expect(map.notMember).toHaveLength(50);
  });
});

describe("LK09 leadNeedsFinal / leadWindowFor (C15, v1.1 correctness-2)", () => {
  const today = "2026-11-10";
  const iso = (ms: number) => new Date(ms).toISOString();
  const table: [Pick<LeadChannelState, "finalThrough" | "finalAttemptAt">, boolean][] = [
    [{ finalThrough: null, finalAttemptAt: null }, true],
    [{ finalThrough: "2026-11-08", finalAttemptAt: null }, true],
    [{ finalThrough: "2026-11-09", finalAttemptAt: null }, false],
    [{ finalThrough: "2026-11-08", finalAttemptAt: iso(NOW_MS - 5 * H) }, false],
    [{ finalThrough: "2026-11-08", finalAttemptAt: iso(NOW_MS - 7 * H) }, true],
    [{ finalThrough: null, finalAttemptAt: iso(NOW_MS - 1 * H) }, false],
    [{ finalThrough: null, finalAttemptAt: "not a time" }, true]
  ];
  for (const [state, needs] of table) {
    it(`${JSON.stringify(state)} → ${needs ? "8 days, final" : "today only"}`, () => {
      expect(leadNeedsFinal(state, today, NOW_MS)).toBe(needs);
      expect(leadWindowFor(state, today, NOW_MS)).toEqual(needs ? { from: "2026-11-03", to: today, final: true } : { from: today, to: today, final: false });
    });
  }
});

describe("LK10 tallyShapes: the counting rule (C13)", () => {
  const day = "2026-11-09";
  const window = { from: day, to: day };
  const ts = tsAt(day, "12:00");
  const subs: LeadPostShape["subtypeClass"][] = ["none", "bot_message", "tombstone", "other"];
  for (const bot of [true, false]) for (const reply of [true, false]) for (const hidden of [true, false]) for (const excluded of [true, false]) for (const sub of subs) {
    const counted = bot && !reply && !hidden && !excluded && (sub === "none" || sub === "bot_message");
    const skipped = !bot && !reply && !hidden && sub === "none";
    it(`bot ${bot} reply ${reply} hidden ${hidden} excluded ${excluded} ${sub} → n ${counted ? 1 : 0}, skipped ${skipped ? 1 : 0}`, () => {
      const r = tallyShapes([shape(ts, { bot, reply, hidden, excluded, subtypeClass: sub })], TZ, window, false);
      expect(r).toEqual({ days: [{ day, n: counted ? 1 : 0, skipped: skipped ? 1 : 0, complete: true }], partialFrom: null });
    });
  }
  it("every day of the window is written, zero days included; the fixture's channels tally to their expect.days", () => {
    for (const ch of leadPages.channels) {
      const r = tallyShapes(ch.expect.shapes as LeadPostShape[], leadPages.tz, leadPages.window, false);
      expect(r.days, ch.channelId).toEqual(ch.expect.days);
      expect(r.partialFrom).toBeNull();
    }
    expect(tallyShapes([], TZ, { from: "2026-11-03", to: "2026-11-10" }, false).days).toHaveLength(8);
  });
  it("a malformed ts never counts; a shape outside the window is ignored", () => {
    const r = tallyShapes([shape("nope"), shape(tsAt("2026-11-01", "12:00"))], TZ, { from: "2026-11-09", to: "2026-11-09" }, false);
    expect(r.days).toEqual([{ day: "2026-11-09", n: 0, skipped: 0, complete: true }]);
  });
});

describe("LK11 local days across DST (America/New_York, 2026-03-08 and 2026-11-01)", () => {
  for (const change of ["2026-03-08", "2026-11-01"]) {
    it(`posts at 00:30 and 23:30 local land on their own days around ${change}`, () => {
      const days = [addLocalDays(change, -1), change, addLocalDays(change, 1)];
      const shapes = days.flatMap((d, k) => [shape(tsAt(d, "00:30", `00010${k}`)), shape(tsAt(d, "23:30", `00020${k}`))]);
      const r = tallyShapes(shapes, TZ, { from: days[0], to: days[2] }, false);
      expect(r.days.map((d) => [d.day, d.n])).toEqual(days.map((d) => [d, 2]));
    });
  }
});

describe("LK12 a capped read (v1.1 correctness-2)", () => {
  const w = { from: "2026-11-03", to: "2026-11-10" };
  it("days after the oldest read day are complete (zeros included), that day is a lower bound, older days are absent", () => {
    const shapes = [shape(tsAt("2026-11-10", "09:00")), shape(tsAt("2026-11-08", "10:00")), shape(tsAt("2026-11-07", "23:00"))];
    const r = tallyShapes(shapes, TZ, w, true);
    expect(r.partialFrom).toBe("2026-11-07");
    expect(r.days).toEqual([
      { day: "2026-11-07", n: 1, skipped: 0, complete: false },
      { day: "2026-11-08", n: 1, skipped: 0, complete: true },
      { day: "2026-11-09", n: 0, skipped: 0, complete: true },
      { day: "2026-11-10", n: 1, skipped: 0, complete: true }
    ]);
    expect(r.days.some((d) => d.day < "2026-11-07")).toBe(false);
  });
  it("not capped → partialFrom null; capped with no usable shape → [] and partialFrom = the window's end", () => {
    expect(tallyShapes([shape(tsAt("2026-11-09", "09:00"))], TZ, w, false).partialFrom).toBeNull();
    expect(tallyShapes([], TZ, w, true)).toEqual({ days: [], partialFrom: "2026-11-10" });
    expect(tallyShapes([shape("bad")], TZ, w, true)).toEqual({ days: [], partialFrom: "2026-11-10" });
  });
  it("a one-day window (the per-day fallback) counts only that day's shapes", () => {
    const d = "2026-11-08";
    const shapes = [shape(tsAt("2026-11-09", "00:00", "000000")), shape(tsAt(d, "23:59")), shape(tsAt(d, "00:00", "000000"))];
    expect(tallyShapes(shapes, TZ, { from: d, to: d }, false).days).toEqual([{ day: d, n: 2, skipped: 0, complete: true }]);
    expect(tallyShapes(shapes, TZ, { from: d, to: d }, true).days).toEqual([{ day: d, n: 2, skipped: 0, complete: false }]);
  });
});

describe("LK13 leadRunDue (C16)", () => {
  const last = (over: Partial<LeadRunSummary> = {}): LeadRunSummary => ({
    at: "2026-11-10T14:00:00.000Z", complete: true, partial: false, needsFinal: 0, channels: 6, counted: 6, pages: 7, listedNotMember: 0,
    classifyEnqueued: 0, errors: {}, failingRuns: 0, failCode: null, notMember: [], ...over
  });
  it("forced, partial, needsFinal, the window's buckets, an unknown bucket", () => {
    expect(leadRunDue({ forced: true, bucket: 1, inWindow: false, last: last() })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 1, inWindow: false, last: last({ partial: true }) })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 1, inWindow: false, last: last({ needsFinal: 2 }) })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 4, inWindow: true, last: last() })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 5, inWindow: true, last: last() })).toBe(false);
    expect(leadRunDue({ forced: false, bucket: 12, inWindow: false, last: last() })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 13, inWindow: false, last: last() })).toBe(false);
    expect(leadRunDue({ forced: false, bucket: 8, inWindow: false, last: last() })).toBe(false);
    expect(leadRunDue({ forced: false, bucket: null, inWindow: false, last: last() })).toBe(true);
    expect(leadRunDue({ forced: false, bucket: 3, inWindow: false, last: null })).toBe(false);
  });
});

const row = (over: Partial<LeadSummaryRow>): LeadSummaryRow => ({
  groupKey: "c:cl_zenith", clientId: "cl_zenith", taskId: "t_zenith_onb", clientLabel: "Zenith House", kind: "vob", day: "2026-11-09",
  n: 0, channels: 1, complete: true, oldestCountedAt: "2026-11-10T12:00:00.000Z", ...over
});
const state = (over: Partial<LeadChannelState>): LeadChannelState => ({
  channelId: "C0LEADVOB1", kind: "vob", link: "fb_id", countedFrom: "2026-11-03", finalThrough: "2026-11-09", countedAt: "2026-11-10T12:00:00.000Z",
  lastErrorCode: null, finalAttemptAt: null, taskId: "t_zenith_onb", clientId: "cl_zenith", clientLabel: "Zenith House", ...over
});

describe("LK14 briefLeadsFrom (C56, v1.1 product-2, product-9)", () => {
  const day = "2026-11-09";
  const opts = { failing: false, dated: false, firstRun: false };
  it("linked groups sorted by vob + nonvob + calendly, then label; totals over linked groups only; other and unlinked into unlinked", () => {
    const rows = [
      row({ kind: "vob", n: 10 }), row({ kind: "nonvob", n: 8 }), row({ kind: "calendly", n: 3 }), row({ kind: "zap_errors", n: 2 }),
      row({ groupKey: "c:cl_acme", clientId: "cl_acme", taskId: "t_acme_onb", clientLabel: "Acme Recovery", kind: "vob", n: 4 }),
      row({ groupKey: "t:t_harbor", clientId: null, taskId: "t_harbor", clientLabel: "Harbor Light onboarding", kind: "vob", n: 4 }),
      row({ groupKey: "unlinked", clientId: null, taskId: null, clientLabel: null, kind: "vob", n: 5 }),
      row({ kind: "vob", n: 99, day: "2026-11-08" })
    ];
    const b = briefLeadsFrom(rows, [], day, "2026-11-10T12:00:00.000Z", opts);
    expect(b.rows.map((r) => r.label)).toEqual(["Zenith House", "Acme Recovery", "Harbor Light onboarding"]);
    expect(b.rows[0]).toEqual({ label: "Zenith House", clientId: "cl_zenith", vob: 10, nonvob: 8, calendly: 3, zapErrors: 2, complete: true,
      kinds: ["vob", "nonvob", "calendly", "zap_errors"] });
    expect(b.totals).toEqual({ vob: 18, nonvob: 8, calendly: 3, zapErrors: 2 });
    expect(b.totalKinds).toEqual(["vob", "nonvob", "calendly", "zap_errors"]);
    expect(b.unlinked).toBe(5);
    expect(b.more).toBe(0);
    expect(b.incomplete).toBe(false);
    expect(b).toMatchObject({ v: 1, localDate: day, asOf: "2026-11-10T12:00:00.000Z", notCounted: 0, failing: false, dated: false, firstRun: false });
  });
  it("≤ 12 rows, the rest in more; a lower bound marks the block incomplete", () => {
    const rows = Array.from({ length: 15 }, (_, k) => row({ groupKey: `c:cl_${k}`, clientId: `cl_${k}`, clientLabel: `Client ${String(k).padStart(2, "0")}`, n: k }));
    const b = briefLeadsFrom([...rows, row({ groupKey: "c:cl_3", clientId: "cl_3", kind: "nonvob", n: 1, complete: false })], [], day, null, opts);
    expect(b.rows).toHaveLength(12);
    expect(b.more).toBe(3);
    expect(b.incomplete).toBe(true);
    expect(b.rows[0].label).toBe("Client 14");
  });
  it("notCounted: linked, non-other channels with no complete row for the day; failing, firstRun and dated pass through", () => {
    const states = [
      state({ channelId: "C0LEADVOB1", kind: "vob" }), state({ channelId: "C0LEADNON1", kind: "nonvob" }),
      state({ channelId: "C0LEADCAL1", kind: "calendly" }), state({ channelId: "C0ZENTEAM", kind: "other" }),
      state({ channelId: "G0LEADUNL1", kind: "vob", link: "none", taskId: null, clientId: null, clientLabel: null })
    ];
    const rows = [row({ kind: "vob", n: 2 }), row({ kind: "nonvob", n: 1, complete: false })];
    const b = briefLeadsFrom(rows, states, day, null, { failing: true, dated: true, firstRun: true });
    // The non-VOB lower bound, the Calendly channel with no row and (P10 fixer correctness-2) the unlinked VOB channel with no
    // row: its rows feed the "Not linked" line and the "none" sentence too. Never other.
    expect(b.notCounted).toBe(3);
    expect(b).toMatchObject({ failing: true, dated: true, firstRun: true });
    expect(briefLeadsFrom([row({ kind: "vob", n: 0, channels: 1 })], [state({})], day, null, opts).notCounted).toBe(0);
  });
  it("P10 fixer correctness-2: a complete row from before the day ended (its final pass hasn't covered the day) is not counted", () => {
    // The 22:00 snapshot of the 9th says complete for what it read; the 01:00 final pass failed, so final_through is the 8th.
    const snapshot = [row({ kind: "vob", n: 4, channels: 1 })];
    const b = briefLeadsFrom(snapshot, [state({ finalThrough: "2026-11-08" })], day, null, opts);
    expect(b.notCounted).toBe(1);
    // All zeros from such snapshots never read as "No new lead posts yesterday.".
    const zero = briefLeadsFrom([row({ kind: "vob", n: 0, channels: 1 })], [state({ finalThrough: "2026-11-08" })], day, null, opts);
    expect(zero.notCounted).toBe(1);
    expect(briefLeadsText(zero, { maxRows: 8, labelMax: 60, datePhrase: "" }).lines.map((l) => l.text))
      .toEqual([SLACK_P10_COPY.leads.brief.notReadyOne]);
    // Covered by its final pass → counted; an unlinked channel too.
    const unl = state({ channelId: "G0LEADUNL1", link: "none", taskId: null, clientId: null, clientLabel: null, finalThrough: "2026-11-08" });
    const both = briefLeadsFrom([row({ kind: "vob", n: 0 }), row({ groupKey: "unlinked", clientId: null, taskId: null, clientLabel: null, kind: "vob", n: 0 })],
      [state({}), unl], day, null, opts);
    expect(both.notCounted).toBe(1);
  });
  it("P10 fixer ui-12: the unlinked group's lead posts by kind, never its Zapier errors", () => {
    const u = (kind: LeadSummaryRow["kind"], n: number) => row({ groupKey: "unlinked", clientId: null, taskId: null, clientLabel: null, kind, n });
    const b = briefLeadsFrom([u("vob", 2), u("nonvob", 1), u("zap_errors", 5)], [], day, null, opts);
    expect(b.unlinked).toBe(3);
    expect(b.unlinkedCounts).toEqual({ vob: 2, nonvob: 1, calendly: 0, kinds: ["vob", "nonvob"] });
    expect(briefLeadsText(b, { maxRows: 8, labelMax: 60, datePhrase: "" }).lines.find((l) => l.kind === "unlinked")?.text)
      .toBe("Not linked to a client: 2 VOBs · 1 non-VOB");
    const zapOnly = briefLeadsFrom([u("zap_errors", 5)], [], day, null, opts);
    expect(zapOnly.unlinked).toBe(0);
    expect(briefLeadsText(zapOnly, { maxRows: 8, labelMax: 60, datePhrase: "" }).lines.map((l) => l.kind)).toEqual(["status"]);
  });
});

describe("P10 fixer: leadDayCovered, leadWindowFor's brief force (correctness-2), leadsViewStateOf (ui-5)", () => {
  const today = "2026-11-10";
  it("a past day is whole once its final pass covered it; today once counted since local midnight; a future day never", () => {
    const s = state({ finalThrough: "2026-11-09", countedAt: "2026-11-10T05:30:00.000Z" });   // 00:30 in New York
    expect(leadDayCovered(s, "2026-11-09", today, TZ)).toBe(true);
    expect(leadDayCovered(s, "2026-11-03", today, TZ)).toBe(true);
    expect(leadDayCovered(state({ finalThrough: "2026-11-08" }), "2026-11-09", today, TZ)).toBe(false);
    expect(leadDayCovered(state({ finalThrough: null }), "2026-11-09", today, TZ)).toBe(false);
    expect(leadDayCovered(s, today, today, TZ)).toBe(true);
    expect(leadDayCovered(state({ countedAt: "2026-11-10T04:30:00.000Z" }), today, today, TZ)).toBe(false);   // 23:30 the day before
    expect(leadDayCovered(state({ countedAt: null }), today, today, TZ)).toBe(false);
    expect(leadDayCovered(s, "2026-11-11", today, TZ)).toBe(false);
    expect(leadStatesCover([s, state({ kind: "other", finalThrough: null, countedAt: null })], "2026-11-04", today, today, TZ)).toBe(true);
    expect(leadStatesCover([s, state({ countedAt: "2026-11-09T22:00:00.000Z" })], "2026-11-04", today, today, TZ)).toBe(false);
  });
  it("the brief's forced run takes the final window past the 6-hour gate while yesterday isn't covered; never otherwise", () => {
    const nowMs = Date.parse("2026-11-10T11:45:00.000Z");
    const failedAt1am = state({ finalThrough: "2026-11-08", finalAttemptAt: "2026-11-10T06:00:00.000Z" });
    expect(leadWindowFor(failedAt1am, today, nowMs)).toEqual({ from: today, to: today, final: false });
    expect(leadWindowFor(failedAt1am, today, nowMs, { force: true })).toEqual({ from: "2026-11-03", to: today, final: true });
    const covered = state({ finalThrough: "2026-11-09", finalAttemptAt: "2026-11-10T06:00:00.000Z" });
    expect(leadWindowFor(covered, today, nowMs, { force: true })).toEqual({ from: today, to: today, final: false });
  });
  it("no_channels only after a complete, non-failing run; failing → unavailable; a partial listing → first_run", () => {
    const run: LeadRunSummary = { at: "2026-11-10T14:30:00.000Z", complete: true, partial: false, needsFinal: 0, channels: 0, counted: 0, pages: 0,
      listedNotMember: 0, classifyEnqueued: 0, errors: {}, failingRuns: 0, failCode: null, notMember: [] };
    const none = { channels: 0, linked: 0, unlinked: 0, ambiguous: 0, otherKind: 0, withError: 0, neverCounted: 0, oldestCountedAt: null, skippedToday: 0 };
    expect(leadsViewStateOf(null, none)).toBe("first_run");
    expect(leadsViewStateOf(run, { ...none, channels: 2 })).toBe("ok");
    expect(leadsViewStateOf({ ...run, failingRuns: 1, failCode: "store" }, { ...none, channels: 2 })).toBe("ok");
    expect(leadsViewStateOf(run, none)).toBe("no_channels");
    expect(leadsViewStateOf({ ...run, failingRuns: 1, failCode: "store", complete: false, partial: true }, none)).toBe("unavailable");
    expect(leadsViewStateOf({ ...run, complete: false, partial: true }, none)).toBe("first_run");
    expect(leadsViewStateOf(run, null)).toBe("no_channels");
  });
});

describe("LK15 leadCountsLine (v1.1 product-9, product-19)", () => {
  it("every counted kind in order, zeros included, singular for 1, never a kind the client has no channel for", () => {
    expect(leadCountsLine({ vob: 10, nonvob: 8, calendly: 3, kinds: ["vob", "nonvob", "calendly"] })).toBe("10 VOBs · 8 non-VOBs · 3 Calendly posts");
    expect(leadCountsLine({ vob: 10, nonvob: 0, calendly: 0, kinds: ["vob", "nonvob"] })).toBe("10 VOBs · 0 non-VOBs");
    expect(leadCountsLine({ vob: 0, nonvob: 0, calendly: 0, kinds: ["nonvob"] })).toBe("0 non-VOBs");
    expect(leadCountsLine({ vob: 1, nonvob: 1, calendly: 1, kinds: ["calendly", "vob", "nonvob"] })).toBe("1 VOB · 1 non-VOB · 1 Calendly post");
    expect(leadCountsLine({ vob: 0, nonvob: 0, calendly: 2, kinds: ["calendly"] })).toBe("2 Calendly posts");
    expect(leadCountsLine({ vob: 5, nonvob: 5, calendly: 5, kinds: [] })).toBe("");
    expect(leadCountsLine({ vob: 5, nonvob: 5, calendly: 5, kinds: ["zap_errors"] })).toBe("");
    expect(leadCountsLine({ vob: 3, nonvob: 0, calendly: 0, kinds: ["vob"] })).not.toMatch(/calls booked/i);
  });
});

describe("LK16 withBriefLeads", () => {
  it("null leaves the content untouched (the same object); a block is added under leads", () => {
    const content: { localDate: string; sections: unknown[]; leads?: BriefLeadsBlock | null } = { localDate: "2026-11-10", sections: [] };
    expect(withBriefLeads(content, null)).toBe(content);
    const block = { v: 1 as const, unavailable: true as const, localDate: "2026-11-09" };
    expect(withBriefLeads(content, block)).toEqual({ ...content, leads: block });
    expect(content).not.toHaveProperty("leads");
  });
});

describe("LK17 leadRetentionDays (v1.1 correctness-11)", () => {
  it("retention_days_slack clamped to 7..365; a non-number → the default (90)", () => {
    expect(leadRetentionDays({ retentionDaysSlack: 1 })).toBe(7);
    expect(leadRetentionDays({ retentionDaysSlack: 7 })).toBe(7);
    expect(leadRetentionDays({ retentionDaysSlack: 90 })).toBe(90);
    expect(leadRetentionDays({ retentionDaysSlack: 365 })).toBe(365);
    expect(leadRetentionDays({ retentionDaysSlack: 3650 })).toBe(365);
    expect(leadRetentionDays({ retentionDaysSlack: Number.NaN })).toBe(90);
    expect(leadRetentionDays({ retentionDaysSlack: "30" as unknown as number })).toBe(90);
  });
});

describe("LK18 leadChannelHref (v1.1 product-10, C62)", () => {
  it("the app_redirect form, allow-listed; a malformed id → null", () => {
    const href = leadChannelHref("T0AB", "C0LEAD1");
    expect(href).toBe("https://slack.com/app_redirect?channel=C0LEAD1&team=T0AB");
    expect(isAllowedLinkUrl(href as string)).toBe(true);
    expect(leadChannelHref("T0AB", "G0LEAD1")).toBe("https://slack.com/app_redirect?channel=G0LEAD1&team=T0AB");
    expect(leadChannelHref("T0AB", "D0LEAD1")).toBeNull();
    expect(leadChannelHref("T0AB", "c0lead1")).toBeNull();
    expect(leadChannelHref("T0AB", "C0LEAD1&app=A1")).toBeNull();
    expect(leadChannelHref("x", "C0LEAD1")).toBeNull();
  });
});

describe("leadCountsViewFrom (LV09's pure half; v1.1 product-9, -10, -19)", () => {
  const today = "2026-11-10";
  const run: LeadRunSummary = { at: "2026-11-10T14:30:00.000Z", complete: true, partial: false, needsFinal: 0, channels: 6, counted: 6, pages: 7,
    listedNotMember: 2, classifyEnqueued: 0, errors: {}, failingRuns: 0, failCode: null,
    notMember: [{ taskId: "t_acme_onb", i: 1 }, { taskId: "t_zenith_onb", i: 2 }] };
  const coverage = { channels: 7, linked: 5, unlinked: 1, ambiguous: 0, otherKind: 1, withError: 0, neverCounted: 0,
    oldestCountedAt: "2026-11-10T14:00:00.000Z", skippedToday: 1 };
  const rows = [
    row({ kind: "vob", day: today, n: 2 }), row({ kind: "vob", day: "2026-11-09", n: 3 }), row({ kind: "vob", day: "2026-11-05", n: 1 }),
    row({ kind: "zap_errors", day: today, n: 1 }), row({ kind: "zap_errors", day: "2026-11-09", n: 2 }),
    row({ groupKey: "c:cl_acme", clientId: "cl_acme", taskId: "t_acme_onb", clientLabel: "Acme Recovery", kind: "calendly", day: today, n: 1 }),
    row({ groupKey: "unlinked", clientId: null, taskId: null, clientLabel: null, kind: "vob", day: today, n: 4 }),
    row({ kind: "vob", day: "2026-11-02", n: 50 })
  ];
  const states = [state({}), state({ channelId: "G0LEADUNL1", link: "none", taskId: null, clientId: null, clientLabel: null }),
    state({ channelId: "C0AMB1", link: "ambiguous", taskId: null, clientId: null, clientLabel: null, kind: "nonvob" }),
    state({ channelId: "C0ZENTEAM", kind: "other", link: "none", taskId: null, clientId: null, clientLabel: null })];
  it("today, yesterday and the 7 days (never older), the All clients row over linked clients, Zapier by day, the fix lists", () => {
    const v = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run, states, list: leadPages.fbList as FbLeadListRow[], teamId: "T0AB" });
    expect(v.state).toBe("ok");
    const zen = v.clients.find((c) => c.label === "Zenith House");
    expect(zen).toMatchObject({ today: { vob: 2, nonvob: 0, calendly: 0 }, yesterday: { vob: 3, nonvob: 0, calendly: 0 }, last7: { vob: 6, nonvob: 0, calendly: 0 },
      kinds: ["vob", "zap_errors"], zapToday: 1, zapYesterday: 2, incomplete: false });
    expect(v.totals).toEqual({ today: { vob: 2, nonvob: 0, calendly: 1 }, yesterday: { vob: 3, nonvob: 0, calendly: 0 }, last7: { vob: 6, nonvob: 0, calendly: 1 },
      kinds: ["vob", "calendly", "zap_errors"] });
    expect(v.unlinked).toEqual({ today: { vob: 4, nonvob: 0, calendly: 0 }, yesterday: { vob: 0, nonvob: 0, calendly: 0 }, last7: { vob: 4, nonvob: 0, calendly: 0 } });
    expect(v.coverage).toMatchObject({ listedNotMember: 2, lastRunAt: run.at, lastError: null, skippedToday: 1 });
    expect(v.fix?.unlinked).toEqual([{ href: "https://slack.com/app_redirect?channel=G0LEADUNL1&team=T0AB", kind: "vob" }]);
    expect(v.fix?.ambiguous).toEqual([{ href: "https://slack.com/app_redirect?channel=C0AMB1&team=T0AB", kind: "nonvob" }]);
    expect(v.fix?.notMember).toEqual([{ client: "Acme Recovery", names: ["#acme-recovery-calendly"] }, { client: "Zenith House", names: ["#zenith-house-fb-leads"] }]);
    expect(v.asOf).toBe("2026-11-10T12:00:00.000Z");
  });
  it("no run summary → first_run; no lead channels → no_channels; a typed-list or team failure → counts only", () => {
    expect(leadCountsViewFrom({ today, tz: TZ, rows: [], coverage, run: null, states: [], list: null, teamId: null }).state).toBe("first_run");
    const none = leadCountsViewFrom({ today, tz: TZ, rows: [], coverage: { ...coverage, channels: 0 }, run, states: [], list: leadPages.fbList as FbLeadListRow[], teamId: "T0AB" });
    expect(none.state).toBe("no_channels");
    expect(none.fix?.notMember).toHaveLength(2);
    const bare = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run, states, list: null, teamId: null });
    expect(bare.fix).toEqual({ unlinked: [], ambiguous: [], notMember: [], more: 0 });
    expect(bare.clients.length).toBeGreaterThan(0);
  });
  it("P10 fixer correctness-3: a channel with no whole count for a day of the window marks its client and the view incomplete", () => {
    const all = (over: Partial<LeadChannelState>) => states.map((s) => ({ ...s, ...over }));
    const fresh = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run, states, list: null, teamId: null });
    expect(fresh.incomplete).toBe(false);
    expect(fresh.clients.every((c) => !c.incomplete)).toBe(true);
    // Between local midnight and the day's first run: nothing counted today yet (and "today" is no zero).
    const beforeFirstRun = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run, states: all({ countedAt: "2026-11-10T04:00:00.000Z" }), list: null, teamId: null });
    expect(beforeFirstRun.clients.find((c) => c.label === "Zenith House")?.incomplete).toBe(true);
    expect(beforeFirstRun.incomplete).toBe(true);
    // Yesterday not covered by its final pass yet (the pre-midnight snapshot).
    const snapshot = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run, states: [state({ finalThrough: "2026-11-08" })], list: null, teamId: null });
    expect(snapshot.clients.find((c) => c.label === "Zenith House")?.incomplete).toBe(true);
    // Only the unlinked channel is behind: no client row says so, the view does.
    const unl = leadCountsViewFrom({ today, tz: TZ, rows, coverage, run,
      states: [state({}), state({ channelId: "G0LEADUNL1", link: "none", taskId: null, clientId: null, clientLabel: null, countedAt: "2026-11-09T20:00:00.000Z" })],
      list: null, teamId: null });
    expect(unl.clients.every((c) => !c.incomplete)).toBe(true);
    expect(unl.incomplete).toBe(true);
    // ui-5: the state rule (a failing run with nothing mapped is unavailable, never no_channels).
    expect(leadCountsViewFrom({ today, tz: TZ, rows: [], coverage: { ...coverage, channels: 0 }, run: { ...run, failingRuns: 2, failCode: "store" }, states: [],
      list: null, teamId: null }).state).toBe("unavailable");
  });
});

describe("briefLeadsText: the DM's and the page's one rule (C56, v1.1 product-2, product-9)", () => {
  const base = (over: Partial<BriefLeads> = {}): BriefLeads => ({
    v: 1, localDate: "2026-11-09", rows: [], more: 0, totals: { vob: 0, nonvob: 0, calendly: 0, zapErrors: 0 }, totalKinds: [], unlinked: 0,
    incomplete: false, asOf: null, notCounted: 0, failing: false, dated: false, firstRun: false, ...over
  });
  const B = SLACK_P10_COPY.leads.brief;
  const opts = { maxRows: 8, labelMax: 60, datePhrase: "Monday, Nov 9" };
  it("the total first, ≤ maxRows client lines, +N more, the Zapier line, the unlinked line", () => {
    const rows = Array.from({ length: 10 }, (_, k) => ({ label: `Client ${k}`, clientId: `cl_${k}`, vob: 10 - k, nonvob: 1, calendly: 0, zapErrors: k === 0 ? 2 : 0,
      complete: true, kinds: ["vob", "nonvob"] as LeadKind[] }));
    const t = briefLeadsText(base({ rows, more: 2, totals: { vob: 55, nonvob: 10, calendly: 0, zapErrors: 2 }, totalKinds: ["vob", "nonvob", "zap_errors"], unlinked: 3 }), opts);
    expect(t.title).toBe(B.title);
    expect(t.lines[0]).toEqual({ kind: "total", text: "All clients: 55 VOBs · 10 non-VOBs" });
    expect(t.lines.filter((l) => l.kind === "client")).toHaveLength(8);
    expect(t.lines.find((l) => l.kind === "more")?.text).toBe("+4 more in DD");
    expect(t.lines.find((l) => l.kind === "zap")?.text).toBe("Zapier errors: Client 0 2");
    expect(t.lines.find((l) => l.kind === "unlinked")?.text).toBe("Not linked to a client: 3");
    expect(t.lines.some((l) => l.text === B.none)).toBe(false);
  });
  it("none only when every counted channel has a complete zero day; notReady / notReadyFirst otherwise; unavailable; dated; partial", () => {
    expect(briefLeadsText(base(), opts).lines).toEqual([{ kind: "status", text: B.none }]);
    expect(briefLeadsText(base({ notCounted: 2 }), opts).lines).toEqual([{ kind: "status", text: "Lead counts for yesterday aren't ready yet (2 channels not counted)." }]);
    expect(briefLeadsText(base({ failing: true }), opts).lines).toEqual([{ kind: "status", text: B.notReadyFirst }]);
    expect(briefLeadsText(base({ firstRun: true, notCounted: 3 }), opts).lines).toEqual([{ kind: "status", text: B.notReadyFirst }]);
    expect(briefLeadsText(base({ incomplete: true }), opts)).toEqual({ title: `${B.title} ${B.partial}`, lines: [] });
    expect(briefLeadsText(base({ dated: true }), opts).title).toBe("Leads Monday, Nov 9");
    expect(briefLeadsText({ v: 1, unavailable: true, localDate: "2026-11-09" }, opts)).toEqual({ title: B.title, lines: [{ kind: "status", text: B.unavailable }] });
  });
});

describe("slack-leads.ts imports only its allow-list (B-P10-3's pure half, §3.4.2)", () => {
  it("slack-p10-types, slack-p10-copy, slack-classes (channelSlug), slack-read-types, time and a type from types", () => {
    const src = readFileSync(new URL("./slack-leads.ts", import.meta.url), "utf8");
    const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(specs).toEqual(["@/lib/exec/slack-classes", "@/lib/exec/slack-p10-copy", "@/lib/exec/slack-p10-types", "@/lib/exec/slack-read-types", "@/lib/exec/time", "@/lib/exec/types"]);
    expect(src).toMatch(/import \{ channelSlug \} from "@\/lib\/exec\/slack-classes";/);
    expect(src).toMatch(/import type \{ ExecSettings \} from "@\/lib\/exec\/types";/);
    expect(src).not.toContain("callModel");
    expect(src).not.toContain("@/lib/exec/llm");
    void msToTs;
  });
});
