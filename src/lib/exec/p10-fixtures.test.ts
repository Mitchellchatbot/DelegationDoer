import { describe, expect, it } from "vitest";

import fbList from "@/lib/exec/__tests__/fixtures/p10/fb-list.json";
import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import replyThreads from "@/lib/exec/__tests__/fixtures/p10/reply-threads.json";
import voiceSamples from "@/lib/exec/__tests__/fixtures/p10/voice-samples.json";
import {
  LEAD_TEXT_KEYS,
  P10_PHI_SENTINELS,
  assertNoLeadText,
  assertNoReplyText,
  assertNoSentinel,
  expandCodePoints,
  expandFixture,
  findLeadText
} from "@/lib/exec/__tests__/p10-assert";
import { SETTINGS_FIELDS } from "@/lib/exec/settings-fields";
import { SLACK_P10_COPY, fillP10 } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS, P10_LIMITS, type LeadPostShape } from "@/lib/exec/slack-p10-types";
import { tsToMs } from "@/lib/exec/slack-read-types";
import { addLocalDays, localDateString } from "@/lib/exec/time";

// P10 stage 0 (lead-owned; contract §0.2 step 5): the frozen fixtures are self-consistent and the shared helper does what its
// header says. The expectations below are recomputed here, independently of the generator (the real zone conversion through
// time.ts, the C12 shape rule and the C13 counting rule restated), so a wrong frozen number can't reach an area's tests.

type Msg = Record<string, unknown>;
const TS_RE = /^[0-9]{1,12}\.[0-9]{1,8}$/;

/** C12 (§3.4.1), restated: the shape of one message given the exclusions. */
function shapeOf(m: Msg, ex: { userIds: string[]; botIds: string[]; appIds: string[] }): LeadPostShape {
  const ts = String(m.ts);
  const thread = m.thread_ts;
  const reply = typeof thread === "string" && TS_RE.test(thread) && thread !== ts;
  const bot = Boolean(m.bot_id) || (typeof m.bot_profile === "object" && m.bot_profile !== null) || m.subtype === "bot_message";
  const user = typeof m.user === "string" ? m.user : null;
  const excluded = user === "USLACKBOT" || (user !== null && ex.userIds.includes(user)) || ex.botIds.includes(String(m.bot_id)) || ex.appIds.includes(String(m.app_id));
  const subtype = typeof m.subtype === "string" ? m.subtype : null;
  const subtypeClass = subtype === null ? "none" : subtype === "bot_message" ? "bot_message" : subtype === "tombstone" ? "tombstone" : "other";
  return { ts, reply, bot, excluded, hidden: m.hidden === true, subtypeClass };
}
const counted = (s: LeadPostShape) => s.bot && !s.reply && !s.hidden && !s.excluded && (s.subtypeClass === "none" || s.subtypeClass === "bot_message");
const skipped = (s: LeadPostShape) => !s.bot && !s.reply && !s.hidden && s.subtypeClass === "none";

describe("P10 fixtures: lead-history-pages.json (§0.2 step 5, C12-C14)", () => {
  const ex = leadPages.exclusions as { userIds: string[]; botIds: string[]; appIds: string[] };

  it("every channel's expect.shapes is the C12 reduction of its pages, in page order", () => {
    expect(leadPages.channels).toHaveLength(6);
    for (const ch of leadPages.channels) {
      const msgs = ch.pages.flatMap((p) => p.response.messages as Msg[]);
      expect(ch.expect.shapes, ch.channelId).toEqual(msgs.map((m) => shapeOf(m, ex)));
      for (const s of ch.expect.shapes) expect(Object.keys(s).sort()).toEqual(["bot", "excluded", "hidden", "reply", "subtypeClass", "ts"]);
    }
  });

  it("every channel's expect.days is the C13 tally per local day (time.ts, America/New_York), zero days included", () => {
    const days: string[] = [];
    for (let d = leadPages.window.from; d <= leadPages.window.to; d = addLocalDays(d, 1)) days.push(d);
    expect(days).toHaveLength(8);
    for (const ch of leadPages.channels) {
      const shapes = ch.expect.shapes as LeadPostShape[];
      const dayOf = (s: LeadPostShape) => localDateString(new Date(tsToMs(s.ts)), leadPages.tz);
      const want = days.map((day) => ({
        day, n: shapes.filter((s) => dayOf(s) === day && counted(s)).length, skipped: shapes.filter((s) => dayOf(s) === day && skipped(s)).length, complete: true
      }));
      expect(ch.expect.days, ch.channelId).toEqual(want);
      for (const s of shapes) expect(dayOf(s) >= leadPages.window.from && dayOf(s) <= leadPages.window.to, `${ch.channelId} ${s.ts} in the window`).toBe(true);
    }
  });

  it("the pages are newest first and every ts is unique; the paged channel chains next_cursor / has_more", () => {
    const all = new Set<string>();
    for (const ch of leadPages.channels) {
      const msgs = ch.pages.flatMap((p) => p.response.messages as Msg[]);
      const ts = msgs.map((m) => String(m.ts));
      expect([...ts].sort((a, b) => tsToMs(b) - tsToMs(a)), ch.channelId).toEqual(ts);
      for (const t of ts) {
        expect(all.has(t), t).toBe(false);
        all.add(t);
      }
      ch.pages.forEach((p, i) => {
        const last = i === ch.pages.length - 1;
        expect(p.response.has_more).toBe(!last);
        expect(p.response.response_metadata.next_cursor === "").toBe(last);
      });
    }
    expect(leadPages.channels.find((c) => c.channelId === "C0LEADNON1")?.pages).toHaveLength(2);
  });

  it("the sentinels are in every field the shape reader must never read, and in one channel name (channelSlug's form)", () => {
    const msgs = leadPages.channels.flatMap((c) => c.pages.flatMap((p) => p.response.messages as Msg[]));
    const fields = ["text", "blocks", "attachments", "files", "username", "bot_profile", "metadata", "user_profile"];
    for (const f of fields) expect(msgs.some((m) => findLeadText({ [f]: m[f] }, { keys: false }) !== null), f).toBe(true);
    for (const s of P10_PHI_SENTINELS) expect(JSON.stringify(msgs).toLowerCase(), s).toContain(s.toLowerCase());
    expect(leadPages.channels.map((c) => c.slackName)).toContain("sentinel-patient-name-vob-leads");
    expect(() => assertNoLeadText(leadPages.channels.map((c) => c.slackName))).toThrow(/lead sentinel #0/);
    expect(() => assertNoLeadText(leadPages.channels[0].pages)).toThrow();
    // What the reader may return passes: shapes only.
    for (const ch of leadPages.channels) expect(() => assertNoLeadText(ch.expect.shapes)).not.toThrow();
  });

  it("the run's map: the counted set, the links, listedNotMember / notMember and toClassify agree with the markers and members", () => {
    const members = new Map(leadPages.memberPages.flatMap((p) => p.response.channels).map((c) => [c.id, c.name]));
    const counted = leadPages.markers.filter((m) => m.class === "deny" && (m.denyReason === "fb_list" || m.denyReason === "lead_name") && members.has(m.channelId));
    expect(counted.map((m) => m.channelId).sort()).toEqual(leadPages.expectMap.rows.map((r) => r.channelId).sort());
    for (const ch of leadPages.channels) {
      const row = leadPages.expectMap.rows.find((r) => r.channelId === ch.channelId);
      expect(row, ch.channelId).toMatchObject({ kind: ch.expect.kind, link: ch.expect.link, taskId: ch.expect.taskId, clientId: ch.expect.clientId });
    }
    expect(leadPages.expectMap.toClassify).toEqual(leadPages.markers.filter((m) => m.listed && m.class !== "deny").map((m) => m.channelId));
    expect(leadPages.expectMap.listedNotMember).toBe(leadPages.expectMap.notMember.length);
    for (const nm of leadPages.expectMap.notMember) {
      const typed = leadPages.fbList.find((r) => r.taskId === nm.taskId && r.i === nm.i);
      expect(typed, JSON.stringify(nm)).toBeDefined();
      const byId = typed?.channelId ? members.has(typed.channelId) : false;
      const byName = [...members.values()].includes(typed?.name ?? "");
      expect(byId || byName).toBe(false);
    }
    for (const id of leadPages.neverRead) expect(leadPages.channels.some((c) => c.channelId === id), id).toBe(false);
  });
});

describe("P10 fixtures: fb-list.json, reply-threads.json, voice-samples.json", () => {
  it("fb-list: every case's rows carry their position among their task's rows", () => {
    for (const c of fbList.cases) {
      const byTask = new Map<string, number>();
      for (const r of c.list) {
        const i = byTask.get(r.taskId) ?? 0;
        expect(r.i, `${c.id} ${r.taskId}`).toBe(i);
        byTask.set(r.taskId, i + 1);
      }
      expect(["fb_id", "fb_name", "fb_sibling", "ambiguous", "none"]).toContain(c.expect.link);
    }
    expect(fbList.cases).toHaveLength(7);
  });

  it("reply-threads: each target is in its messages; C28's destination per conversation type", () => {
    for (const [name, c] of Object.entries(replyThreads.conversations)) {
      const msgs = c.messages as Msg[];
      const target = msgs.find((m) => m.ts === c.targetTs);
      expect(target, name).toBeDefined();
      const thread = typeof target?.thread_ts === "string" ? target.thread_ts : null;
      const isDm = c.channel.convType === "im" || c.channel.convType === "mpim";
      expect(c.expect.replyThreadTs, name).toBe(isDm ? thread : (thread ?? c.targetTs));
    }
    expect(replyThreads.conversations.connect.expect.external).toBe(true);
    expect(replyThreads.conversations.mpimForeign.channel.isExtShared).toBe(false);
    expect(replyThreads.conversations.mpimForeign.expect.external).toBe(true);
    expect(replyThreads.conversations.finance.expect.finance).toBe(true);
  });

  it("reply-threads: the read-back case carries VS16, a double space and an auto-linked email once expanded", () => {
    const rb = expandFixture(replyThreads.postedReadback);
    const vs16 = String.fromCodePoint(0xfe0f);   // VARIATION SELECTOR-16
    expect(rb.storedText).toContain(vs16);
    expect(rb.storedText).toContain("  ");
    expect(rb.wireText).toContain("<mailto:jane@acme-recovery.example|jane@acme-recovery.example>");
    expect(JSON.stringify(replyThreads)).not.toContain(vs16);   // never raw in the file
  });

  it("voice-samples: keep and excluded partition his and others' messages; at least voiceSamplesMin kept", () => {
    const keys = voiceSamples.messages.map((m) => `${m.channel}:${m.message.ts}`);
    expect([...voiceSamples.keep, ...Object.keys(voiceSamples.excluded)].sort()).toEqual([...keys].sort());
    expect(voiceSamples.keep.length).toBeGreaterThanOrEqual(P10_LIMITS.voiceSamplesMin);
    expect(new Set(Object.values(voiceSamples.excluded))).toEqual(new Set(["under_3_words", "bot_or_app", "subtype", "not_him", "checkin", "p10_sent"]));
  });
});

describe("P10 p10-assert.ts (§0.2 step 5)", () => {
  it("assertNoLeadText: a sentinel in a nested JSON string, in a key, in channelSlug's form; every LEAD_TEXT_KEYS key", () => {
    expect(() => assertNoLeadText({ a: [{ b: JSON.stringify({ c: "x 555-0199-7731 y" }) }] })).toThrow(/sentinel #1/);
    expect(() => assertNoLeadText({ "SENTINEL-INSURER-ID": 1 })).toThrow(/in a key/);
    expect(() => assertNoLeadText("sentinel-address-12-elm")).toThrow(/sentinel #4/);
    expect(() => assertNoLeadText(new Map([["k", "1984-02-29"]]))).toThrow(/sentinel #2/);
    expect(() => assertNoLeadText(new Error("boom SENTINEL-PATIENT-NAME"))).toThrow(/sentinel #0/);
    for (const k of LEAD_TEXT_KEYS) expect(() => assertNoLeadText({ ok: 1, deep: [{ [k]: 0 }] }), k).toThrow(`"${k}"`);
    expect(() => assertNoLeadText({ channels: 6, counted: 5, errors: { ratelimited: 1 }, notMember: [{ taskId: "t_1", i: 2 }], days: ["2026-11-09"] })).not.toThrow();
  });

  it("assertNoSentinel ignores keys; assertNoReplyText finds a text exactly or in any case, never an empty one", () => {
    expect(() => assertNoSentinel({ text: "fine", name: "fine" })).not.toThrow();
    expect(() => assertNoSentinel({ text: "SENTINEL-PATIENT-NAME" })).toThrow();
    expect(() => assertNoReplyText({ log: "draft: Thursday WORKS" }, ["thursday works"])).toThrow(/reply text #0/);
    expect(() => assertNoReplyText({ log: "ok" }, ["", "absent"])).not.toThrow();
  });

  it("expandCodePoints builds code points with String.fromCodePoint and leaves other text alone", () => {
    expect(expandCodePoints("a{{U+FE0F}}b")).toBe(`a${String.fromCodePoint(0xfe0f)}b`);
    expect(expandCodePoints("{{U+1F600}}")).toBe(String.fromCodePoint(0x1f600));
    expect(expandCodePoints("{{U+XYZ1}} {{u+00e9}}")).toBe("{{U+XYZ1}} {{u+00e9}}");
  });
});

describe("P10 seeds: copy, kinds, the registry's literals", () => {
  it("fillP10 fills {name} from own properties (numbers included) and leaves an unknown name as it is", () => {
    expect(fillP10(SLACK_P10_COPY.leads.brief.line, { client: "Zenith House", counts: "10 VOBs" })).toBe("Zenith House: 10 VOBs");
    expect(fillP10("{n} of {m}", { n: 3 })).toBe("3 of {m}");
    expect(fillP10("{toString}", {})).toBe("{toString}");
  });

  it("the settings registry's P10 rows carry SLACK_P10_COPY.settings' labels and help exactly", () => {
    const s = SLACK_P10_COPY.settings;
    const want: Record<string, [string, string]> = {
      slackReadAll: [s.readAllLabel, s.readAllHelp], slackLeadCountsEnabled: [s.leadsLabel, s.leadsHelp],
      slackRepliesEnabled: [s.repliesLabel, s.repliesHelp], slackReplySendEnabled: [s.sendLabel, s.sendHelp],
      slackReplyAuto: [s.autoLabel, s.autoHelp], slackReplyDailyCapUsd: [s.capLabel, s.capHelp], slackVoiceEnabled: [s.voiceLabel, s.voiceHelp]
    };
    const rows = SETTINGS_FIELDS.filter((d) => d.group === "slackP10");
    expect(rows.map((d) => d.key)).toEqual(Object.keys(want));
    for (const d of rows) {
      expect([d.label, d.help], d.key).toEqual(want[d.key]);
      expect(d.section).toBe("slack");
    }
  });

  it("P10_JOB_KINDS are distinct exec.* kinds; the Calendly kind is never 'calls booked' (Appendix C)", () => {
    const kinds = Object.values(P10_JOB_KINDS);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of kinds) expect(k).toMatch(/^exec\.[a-z-]+$/);
    expect(SLACK_P10_COPY.leads.kinds.calendly).toBe("Calendly posts");
    expect(SLACK_P10_COPY.leads.kindOne.calendly).toBe("Calendly post");
    expect(SLACK_P10_COPY.leads.calendlyNote).toBe("Calendly posts include reminders, not only bookings.");
  });
});
