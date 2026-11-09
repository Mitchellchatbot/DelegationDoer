import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { slackScreenAllows } from "@/lib/exec/attention-read";
import type { SlackScreenRows } from "@/lib/exec/slack-read-store";
import {
  compareTs as p7aCompareTs,
  msToTs as p7aMsToTs,
  slackMsgFingerprint,
  type ChannelRow,
  type ItemSourceClass
} from "@/lib/exec/slack-read-types";
import {
  SLACK_INTEL_JOB_KINDS,
  SLACK_INTEL_LIMITS,
  SLACK_ITEM_KINDS,
  compareTs,
  localDateOfTs,
  msToTs,
  slackDigestKey,
  slackItemPolicy,
  slackMessageKey,
  slackPrivacyOf,
  slackUsePolicy,
  storedSearchChannels,
  tsOfDate,
  type SlackIntelState,
  type SlackItemUse,
  type SlackUse
} from "@/lib/exec/slack-intel-types";

// P7b §5.1 (TY01–TY06; lead-written at stage 0, run by Area A): the read policy, the privacy chip, the ts helpers and the
// key builders of slack-intel-types.ts against the frozen fixture channels (fixtures/slack-intel/channels.json). The
// expected tables below are written by hand from §3.1's rows as amended by the bindings (AM-P7b-2: slackItemPolicy and
// storedSearchChannels follow P7a's FINAL C20 screen, attention-read.ts slackScreenAllows); a mutant of any row turns
// TY01/TY05/TY06 red.

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));
const channelsFixture = JSON.parse(readFileSync(`${EXEC_DIR}__tests__/fixtures/slack-intel/channels.json`, "utf8")) as {
  rows: Record<string, ChannelRow>;
};
const CH = channelsFixture.rows;
const KEYS = Object.keys(CH);
const USES: readonly SlackUse[] = ["page", "chat_web", "chat_slack", "digest", "draft", "brief", "live_read"];
const ITEM_USES: readonly SlackItemUse[] = ["page", "chat_web", "chat_slack"];
const STATES: readonly SlackIntelState[] = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering", "ok"];

/** "x:<reason>" for a denial, the privacy for an allow. */
const verdict = (r: ReturnType<typeof slackUsePolicy>): string => (r.allowed ? r.privacy : `x:${r.reason}`);
const all = (v: string) => Object.fromEntries(USES.map((u) => [u, v]));
const row = (page: string, web: string, slack: string, digest: string, draft: string, brief: string, live: string) =>
  ({ page, chat_web: web, chat_slack: slack, digest, draft, brief, live_read: live });

/** §3.1's slackUsePolicy table, row by row, for every fixture channel × every use (state ok). */
const EXPECTED_USE: Record<string, Record<string, string>> = {
  denyLead: all("x:never_watch"),
  hubOutbound: all("x:hub"),
  hubClientEmail: all("x:hub"),
  unclassified: all("x:unclassified"),
  publicWatched: all("public"),
  publicUnwatched: all("x:unwatched"),
  privateWatched: row("private", "private", "private", "private", "x:not_public", "private", "private"),
  leftPrivate: all("x:inaccessible"),
  mpim: row("group_dm", "group_dm", "group_dm", "group_dm", "x:not_public", "group_dm", "group_dm"),
  im: row("dm", "dm", "dm", "x:dm", "x:dm", "dm", "dm"),
  publicMuted: all("x:muted"),
  publicSlackMuted: all("x:muted"),
  financeMuted: all("x:muted"),
  financeWatched: row("finance", "finance", "x:finance", "finance", "x:finance", "x:finance", "finance"),
  externalShared: row("external", "external", "external", "external", "x:not_public", "external", "external"),
  externalFinanceName: all("x:muted"),
  extEverUnshared: row("external", "external", "external", "external", "x:not_public", "external", "external"),
  archived: row("public", "public", "public", "public", "public", "public", "x:archived"),
  ddBotDm: all("x:never_watch"),
  selfDm: all("x:never_watch")
};

describe("TY01 slackUsePolicy (§3.1 table; fails closed)", () => {
  it("every fixture channel × every use matches the checked-in table", () => {
    expect(Object.keys(EXPECTED_USE).sort()).toEqual([...KEYS].sort());
    const got: Record<string, Record<string, string>> = {};
    for (const k of KEYS) got[k] = Object.fromEntries(USES.map((u) => [u, verdict(slackUsePolicy("ok", CH[k], u))]));
    expect(got).toEqual(EXPECTED_USE);
  });

  it("a null channel is unclassified; any state but ok denies with 'state' before anything else", () => {
    for (const u of USES) expect(slackUsePolicy("ok", null, u)).toEqual({ allowed: false, reason: "unclassified" });
    for (const s of STATES.filter((x) => x !== "ok")) {
      for (const k of KEYS) for (const u of USES) expect(slackUsePolicy(s, CH[k], u)).toEqual({ allowed: false, reason: "state" });
      expect(slackUsePolicy(s, null, "page")).toEqual({ allowed: false, reason: "state" });
    }
  });

  it("only a watched channel is ever allowed, and unknown values fail closed", () => {
    for (const k of KEYS) for (const u of USES) if (slackUsePolicy("ok", CH[k], u).allowed) expect(CH[k].watchState).toBe("watched");
    const odd = { ...CH.publicWatched, watchState: "paused" } as unknown as ChannelRow;
    expect(slackUsePolicy("ok", odd, "page")).toEqual({ allowed: false, reason: "unwatched" });
    const oddClass = { ...CH.publicWatched, class: "legacy" } as unknown as ChannelRow;
    expect(slackUsePolicy("ok", oddClass, "page")).toEqual({ allowed: false, reason: "unclassified" });
    expect(slackUsePolicy("ok", CH.publicWatched, "everything" as SlackUse)).toEqual({ allowed: false, reason: "state" });
    expect(slackUsePolicy("bogus" as SlackIntelState, CH.publicWatched, "page")).toEqual({ allowed: false, reason: "state" });
  });

  it("row order: a left hub is a hub, a left finance channel is inaccessible, an archived muted channel is muted", () => {
    expect(slackUsePolicy("ok", { ...CH.hubOutbound, leftAt: "2026-11-05T00:00:00.000Z" }, "page")).toEqual({ allowed: false, reason: "hub" });
    expect(slackUsePolicy("ok", { ...CH.financeWatched, leftAt: "2026-11-05T00:00:00.000Z" }, "page")).toEqual({ allowed: false, reason: "inaccessible" });
    expect(slackUsePolicy("ok", { ...CH.publicMuted, isArchived: true }, "live_read")).toEqual({ allowed: false, reason: "muted" });
    // finance (row 9) before dm (row 10) before not_public (row 11)
    expect(slackUsePolicy("ok", CH.financeWatched, "draft")).toEqual({ allowed: false, reason: "finance" });
  });
});

describe("TY02 slackPrivacyOf (finance > external > conv_type)", () => {
  it("each fixture channel's chip", () => {
    const got = Object.fromEntries(KEYS.map((k) => [k, slackPrivacyOf(CH[k])]));
    expect(got).toEqual({
      denyLead: "private", hubOutbound: "public", hubClientEmail: "private", unclassified: "public", publicWatched: "public",
      publicUnwatched: "public", privateWatched: "private", leftPrivate: "private", mpim: "group_dm", im: "dm", publicMuted: "public",
      publicSlackMuted: "public", financeMuted: "finance", financeWatched: "finance", externalShared: "external",
      externalFinanceName: "finance", extEverUnshared: "external", archived: "public", ddBotDm: "dm", selfDm: "dm"
    });
  });

  it("finance by class or by name beats external; external by class, share or ext_ever beats the type; unknown types are private", () => {
    const base = { convType: "channel", isPrivate: false, class: "standard", isExtShared: false, extEver: false, financeName: false } as const;
    expect(slackPrivacyOf(base)).toBe("public");
    expect(slackPrivacyOf({ ...base, financeName: true, class: "external", isExtShared: true, extEver: true })).toBe("finance");
    expect(slackPrivacyOf({ ...base, class: "finance", financeName: true })).toBe("finance");
    expect(slackPrivacyOf({ ...base, class: "external" })).toBe("external");
    expect(slackPrivacyOf({ ...base, isExtShared: true })).toBe("external");
    expect(slackPrivacyOf({ ...base, extEver: true })).toBe("external");
    expect(slackPrivacyOf({ ...base, isPrivate: true })).toBe("private");
    expect(slackPrivacyOf({ ...base, convType: "group", isPrivate: true })).toBe("private");
    expect(slackPrivacyOf({ ...base, convType: "mpim", isPrivate: true })).toBe("group_dm");
    expect(slackPrivacyOf({ ...base, convType: "im", isPrivate: true })).toBe("dm");
    expect(slackPrivacyOf({ ...base, convType: "huddle" as ChannelRow["convType"] })).toBe("private");
    expect(slackPrivacyOf(CH.externalFinanceName)).toBe("finance");
    expect(slackPrivacyOf(CH.extEverUnshared)).toBe("external");
  });
});

describe("TY03 compareTs / msToTs are P7a's", () => {
  it("re-exported, not re-implemented", () => {
    expect(compareTs).toBe(p7aCompareTs);
    expect(msToTs).toBe(p7aMsToTs);
    expect(compareTs("9.000100", "10.000001")).toBeLessThan(0);
    expect(compareTs("1794060000.000100", "1794060000.0001")).toBe(0);
    expect(() => compareTs("1794060000", "1.0")).toThrow(TypeError);
  });

  it("tsOfDate(d) === msToTs(d.getTime()); invalid or negative dates throw", () => {
    for (const iso of ["2026-11-08T15:00:00.000Z", "2026-11-07T05:00:00.123Z", "1970-01-01T00:00:00.000Z"]) {
      const d = new Date(iso);
      expect(tsOfDate(d)).toBe(msToTs(d.getTime()));
    }
    expect(tsOfDate(new Date("2026-11-08T15:00:00.000Z"))).toBe("1794150000.000000");
    expect(() => tsOfDate(new Date(Number.NaN))).toThrow(TypeError);
    expect(() => tsOfDate(new Date(-1))).toThrow(TypeError);
    expect(() => tsOfDate("2026-11-08" as unknown as Date)).toThrow(TypeError);
  });
});

describe("TY04 localDateOfTs / tsOfDate across the US DST changes (dayBounds: Area C's DG17)", () => {
  it("America/New_York and Asia/Karachi around 2026-03-08 and 2026-11-01", () => {
    const at = (iso: string) => tsOfDate(new Date(iso));
    // 2026-03-08 02:00 EST → 03:00 EDT (07:00Z). Local midnight before it is 05:00Z, after it (03-09) is 04:00Z.
    expect(localDateOfTs(at("2026-03-08T04:59:59.000Z"), "America/New_York")).toBe("2026-03-07");
    expect(localDateOfTs(at("2026-03-08T05:00:00.000Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateOfTs(at("2026-03-09T03:59:59.000Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateOfTs(at("2026-03-09T04:00:00.000Z"), "America/New_York")).toBe("2026-03-09");
    // 2026-11-01 02:00 EDT → 01:00 EST (06:00Z). Local midnight of 11-01 is 04:00Z, of 11-02 is 05:00Z.
    expect(localDateOfTs(at("2026-11-01T03:59:59.000Z"), "America/New_York")).toBe("2026-10-31");
    expect(localDateOfTs(at("2026-11-01T04:00:00.000Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateOfTs(at("2026-11-02T04:59:59.000Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateOfTs(at("2026-11-02T05:00:00.000Z"), "America/New_York")).toBe("2026-11-02");
    // Karachi has no DST: UTC+5 on both dates.
    expect(localDateOfTs(at("2026-03-07T18:59:59.000Z"), "Asia/Karachi")).toBe("2026-03-07");
    expect(localDateOfTs(at("2026-03-07T19:00:00.000Z"), "Asia/Karachi")).toBe("2026-03-08");
    expect(localDateOfTs(at("2026-10-31T19:00:00.000Z"), "Asia/Karachi")).toBe("2026-11-01");
    // The history-day fixture's bounds.
    expect(localDateOfTs("1794027600.000000", "America/New_York")).toBe("2026-11-07");
    expect(localDateOfTs("1794113999.999999", "America/New_York")).toBe("2026-11-07");
    expect(localDateOfTs("1794114000.000000", "America/New_York")).toBe("2026-11-08");
    expect(() => localDateOfTs("not-a-ts", "America/New_York")).toThrow(TypeError);
  });
});

/** "x:<reason>" or the privacy, for one item use. */
const iv = (r: ReturnType<typeof slackItemPolicy>): string => (r.allowed ? r.privacy : `x:${r.reason}`);
const ITEM = (bypassMute: boolean, sourceClass: ItemSourceClass) => ({ bypassMute, sourceClass });

/** The SlackScreenRows P7a's screen would read for one channel row and one stored item (reading live, the message row
 *  present, no deleted marker): the twin input for slackScreenAllows. */
function screenRowsFor(ch: ChannelRow, ts: string, item: { bypassMute: boolean; sourceClass: ItemSourceClass }): SlackScreenRows {
  const fp = slackMsgFingerprint(ch.channelId, ts);
  return {
    readingLive: true,
    channels: new Map([[ch.channelId, { class: ch.class, watchState: ch.watchState, muteSource: ch.muteSource, financeName: ch.financeName }]]),
    items: new Map([[fp, item]]),
    messages: new Set([fp]),
    markers: new Set()
  };
}

describe("TY05 key builders and slackItemPolicy (P7a's final C20 + the left row)", () => {
  it("the consulted keys", () => {
    expect(slackMessageKey("C0ACMESEO", "1794060000.000100")).toBe("m:C0ACMESEO:1794060000.000100");
    expect(slackDigestKey("C0ACMESEO", "2026-11-07", 0)).toBe("d:C0ACMESEO:2026-11-07:0");
    expect(slackDigestKey("G0MPIMTEAM", "2026-11-07", 3)).toBe("d:G0MPIMTEAM:2026-11-07:3");
    expect([...SLACK_ITEM_KINDS]).toEqual(["request", "question", "decision", "commitment", "action_item", "fyi"]);
    expect(Object.isFrozen(SLACK_ITEM_KINDS)).toBe(true);
  });

  it("muted (by him or Slack) shows only bypass items; unwatched, finance mutes and finance channels never bypass", () => {
    for (const u of ITEM_USES) {
      expect(iv(slackItemPolicy("ok", CH.publicMuted, ITEM(true, "public"), u))).toBe("public");
      expect(iv(slackItemPolicy("ok", CH.publicMuted, ITEM(false, "public"), u))).toBe("x:not_bypass");
      expect(iv(slackItemPolicy("ok", CH.publicSlackMuted, ITEM(true, "public"), u))).toBe("public");
      expect(iv(slackItemPolicy("ok", CH.publicSlackMuted, ITEM(false, "public"), u))).toBe("x:not_bypass");
      // AM-P7b-2: never "Don't watch" / unwatched, never a finance default mute, never a finance-named channel.
      expect(iv(slackItemPolicy("ok", CH.publicUnwatched, ITEM(true, "public"), u))).toBe("x:not_bypass");
      expect(iv(slackItemPolicy("ok", CH.financeMuted, ITEM(true, "finance"), u))).toBe("x:not_bypass");
      expect(iv(slackItemPolicy("ok", CH.externalFinanceName, ITEM(true, "finance"), u))).toBe("x:not_bypass");
      expect(iv(slackItemPolicy("ok", { ...CH.financeWatched, watchState: "muted", muteSource: "owner" }, ITEM(true, "finance"), u))).toBe("x:not_bypass");
      expect(iv(slackItemPolicy("ok", { ...CH.publicMuted, muteSource: null }, ITEM(true, "public"), u))).toBe("x:not_bypass");
    }
  });

  it("finance by item source class, channel class or finance name is withheld on chat_slack only", () => {
    expect(iv(slackItemPolicy("ok", CH.publicWatched, ITEM(false, "finance"), "page"))).toBe("finance");
    expect(iv(slackItemPolicy("ok", CH.publicWatched, ITEM(false, "finance"), "chat_web"))).toBe("finance");
    expect(iv(slackItemPolicy("ok", CH.publicWatched, ITEM(false, "finance"), "chat_slack"))).toBe("x:finance");
    expect(iv(slackItemPolicy("ok", CH.financeWatched, ITEM(false, "private"), "chat_web"))).toBe("finance");
    expect(iv(slackItemPolicy("ok", CH.financeWatched, ITEM(false, "private"), "chat_slack"))).toBe("x:finance");
    const shared = { ...CH.externalFinanceName, watchState: "watched", muteSource: null } as ChannelRow;
    expect(iv(slackItemPolicy("ok", shared, ITEM(false, "private"), "chat_web"))).toBe("finance");
    expect(iv(slackItemPolicy("ok", shared, ITEM(false, "private"), "chat_slack"))).toBe("x:finance");
    expect(iv(slackItemPolicy("ok", CH.publicWatched, { bypassMute: false, sourceClass: "secret" as ItemSourceClass }, "chat_slack"))).toBe("x:finance");
  });

  it("left, deny, hub, unclassified, a null channel and any state but ok deny everything", () => {
    for (const u of ITEM_USES) {
      for (const b of [true, false]) {
        expect(iv(slackItemPolicy("ok", CH.leftPrivate, ITEM(b, "private"), u))).toBe("x:inaccessible");
        expect(iv(slackItemPolicy("ok", CH.denyLead, ITEM(b, "private"), u))).toBe("x:never_watch");
        expect(iv(slackItemPolicy("ok", CH.hubOutbound, ITEM(b, "public"), u))).toBe("x:hub");
        expect(iv(slackItemPolicy("ok", CH.unclassified, ITEM(b, "public"), u))).toBe("x:unclassified");
        expect(iv(slackItemPolicy("ok", null, ITEM(b, "public"), u))).toBe("x:unclassified");
        for (const s of STATES.filter((x) => x !== "ok")) expect(iv(slackItemPolicy(s, CH.publicWatched, ITEM(b, "public"), u))).toBe("x:state");
      }
    }
    expect(iv(slackItemPolicy("ok", CH.publicWatched, ITEM(false, "public"), "draft" as SlackItemUse))).toBe("x:state");
  });

  it("twin of P7a's slackScreenAllows (attention-read.ts) for every fixture channel × bypass × source class × use", () => {
    const ts = "1794060000.000100";
    let compared = 0;
    for (const k of KEYS) {
      const ch = CH[k];
      for (const b of [true, false]) {
        for (const sc of ["public", "private", "finance"] as ItemSourceClass[]) {
          for (const u of ITEM_USES) {
            const item = ITEM(b, sc);
            const mine = slackItemPolicy("ok", ch, item, u).allowed;
            const p7a = slackScreenAllows(screenRowsFor(ch, ts, item), { channelId: ch.channelId, ts }, item, u === "chat_slack" ? "slack" : "web");
            // P7b's policy is never looser than P7a's screen; it is stricter only on a left channel (P7b's row 5).
            if (ch.leftAt === null) expect(`${k}/${b}/${sc}/${u}:${mine}`).toBe(`${k}/${b}/${sc}/${u}:${p7a}`);
            else expect(mine).toBe(false);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(KEYS.length * 2 * 3 * 3);
  });
});

describe("TY06 the fail-closed rows (coherence-2, intel-1)", () => {
  it("an unwatched public channel (member or not) and a left private channel are denied for every use", () => {
    const member = { ...CH.publicUnwatched, isMember: true };
    for (const u of USES) {
      expect(slackUsePolicy("ok", CH.publicUnwatched, u)).toEqual({ allowed: false, reason: "unwatched" });
      expect(slackUsePolicy("ok", member, u)).toEqual({ allowed: false, reason: "unwatched" });
      expect(slackUsePolicy("ok", CH.leftPrivate, u)).toEqual({ allowed: false, reason: "inaccessible" });
      for (const k of ["publicMuted", "publicSlackMuted", "financeMuted", "externalFinanceName"]) {
        expect(slackUsePolicy("ok", CH[k], u)).toEqual({ allowed: false, reason: "muted" });
      }
    }
  });

  it("storedSearchChannels: watched → full; owner/Slack-muted non-finance → bypass only; the rest in neither", () => {
    const rows = KEYS.map((k) => CH[k]);
    const web = storedSearchChannels("ok", rows, "chat_web");
    expect(web.full).toEqual(["C0ACMESEO", "C0PRIVOPS", "G0MPIMTEAM", "D0JANE", "C0PAYROLL", "C0PARTNER", "C0EXEVER", "C0OLDLAUNCH"]);
    expect(web.bypass).toEqual(["C0DESIGN", "C0LAUNCH"]);
    const slack = storedSearchChannels("ok", rows, "chat_slack");
    expect(slack.full).toEqual(["C0ACMESEO", "C0PRIVOPS", "G0MPIMTEAM", "D0JANE", "C0PARTNER", "C0EXEVER", "C0OLDLAUNCH"]);
    expect(slack.bypass).toEqual(["C0DESIGN", "C0LAUNCH"]);
    expect(storedSearchChannels("ok", rows, "page")).toEqual(web);
    for (const id of [...web.full, ...web.bypass, ...slack.full, ...slack.bypass]) {
      expect(["C0FBLEADS", "C0OUTBOUND", "C0EMAILHUB", "C0UNCLASS", "C0RANDOM", "C0LEFTPRIV", "C0FINANCE", "C0EXTBOOKS", "D0DDBOT", "D0SELF"]).not.toContain(id);
    }
    for (const s of STATES.filter((x) => x !== "ok")) expect(storedSearchChannels(s, rows, "chat_web")).toEqual({ full: [], bypass: [] });
    expect(storedSearchChannels("ok", [CH.publicWatched, CH.publicWatched], "page")).toEqual({ full: ["C0ACMESEO"], bypass: [] });
    expect(storedSearchChannels("ok", rows, "digest" as SlackItemUse)).toEqual({ full: [], bypass: [] });
  });
});

describe("§3.1 constants", () => {
  it("job kinds and limits are frozen and as written", () => {
    expect(SLACK_INTEL_JOB_KINDS).toEqual({ correlate: "exec.slack-correlate", digest: "exec.slack-digest", digestPlan: "exec.slack-digest-plan", sweep: "exec.slack-intel-sweep" });
    expect(Object.isFrozen(SLACK_INTEL_JOB_KINDS)).toBe(true);
    expect(Object.isFrozen(SLACK_INTEL_LIMITS)).toBe(true);
    expect(SLACK_INTEL_LIMITS).toMatchObject({
      nameRuleMinSlugChars: 4, digestSummaryChars: 1_200, digestLineChars: 200, digestLines: 6, digestVerbatimMaxRun: 160, digestVerbatimKeep: 140,
      searchLiveChannels: 3, searchLiveDaysMax: 30, consultedRefs: 600, consultedChannels: 200, ownerInstructionChars: 2_000, briefDigests: 6,
      clientUpdatesPerTurn: 1, overviewReadTimeoutMs: 8_000
    });
    expect(Object.keys(SLACK_INTEL_LIMITS)).toHaveLength(59);
  });
});
