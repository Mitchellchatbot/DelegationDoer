import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyConversation, toClassRow, type ClassifierContext } from "@/lib/exec/slack-classes";
import type { Classification, ConversationMeta, ConvType } from "@/lib/exec/slack-read-types";

// P10 §5.1 (RA01-RA06; contract §3.3.1, C2, T1, H9; Area B): the read-all switch in the never-watch classifier. It changes
// exactly two defaults for conversations he is a member of: a finance-named channel defaults to watched with no mute, and his
// Slack mutes are ignored. The class and financeName never move (every finance protection on Slack surfaces stays), and the
// deny, hub, unclassified and external rules still win first. The P7a fixture (slack-classes.json) is replayed as is.

type Row = { id: string; name: string; meta: ConversationMeta; ctx?: Record<string, unknown>; expect: Classification };
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./__tests__/fixtures/slack-classes.json", import.meta.url)), "utf8")) as {
  base: Record<string, unknown>; rows: Row[];
};
const setOf = (v: unknown): Set<string> => new Set(Array.isArray(v) ? (v as string[]) : []);

function contextFor(overrides: Record<string, unknown> = {}, readAll?: boolean): ClassifierContext {
  const m: Record<string, unknown> = { ...fixture.base, ...overrides };
  const ctx: ClassifierContext = {
    principalSlackUserId: m.principalSlackUserId as string,
    assistantDmChannelId: m.assistantDmChannelId as string,
    assistantBotUserId: m.assistantBotUserId as string,
    ddBotUserId: (m.ddBotUserId as string | null) ?? null,
    ddBotDmChannelIds: setOf(m.ddBotDmChannelIds),
    botUserIds: m.botUserIds === null ? null : setOf(m.botUserIds),
    fbLeadChannelIds: setOf(m.fbLeadChannelIds),
    fbLeadNames: setOf(m.fbLeadNames),
    leadSlugs: (m.leadSlugs as string[]) ?? [],
    outboundChannelId: (m.outboundChannelId as string | null) ?? null,
    clientEmailChannelId: (m.clientEmailChannelId as string | null) ?? null,
    grantedTypes: new Set((m.grantedTypes as ConvType[]) ?? []),
    slackMutedIds: m.slackMutedIds === null || m.slackMutedIds === undefined ? null : setOf(m.slackMutedIds)
  };
  if (readAll !== undefined) ctx.readAll = readAll;
  return ctx;
}
const meta = (over: Partial<ConversationMeta>): ConversationMeta => ({
  id: "C0TEST", convType: "channel", name: "general-chat", isMember: true, isPrivate: false, isExtShared: false,
  isPendingExtShared: false, isArchived: false, imUser: null, ...over
});

describe("RA01 read-all false or absent: P7a's classifier exactly", () => {
  it("every CL01-CL30 row gives the base's Classification with readAll absent and with readAll false", () => {
    expect(fixture.rows.length).toBeGreaterThanOrEqual(31);
    for (const r of fixture.rows) {
      expect(classifyConversation(r.meta, contextFor(r.ctx)), r.id).toEqual(r.expect);
      expect(classifyConversation(r.meta, contextFor(r.ctx, false)), `${r.id} false`).toEqual(r.expect);
    }
  });
});

describe("RA02 / RA03 finance-named member channels under read-all", () => {
  it("a member finance channel → finance, financeName, watched, no mute; a non-member one → unwatched", () => {
    const m = meta({ id: "C0FIN", name: "zenith-house-finance" });
    expect(classifyConversation(m, contextFor({}, false))).toEqual({ class: "finance", denyReason: null, hubKind: null, financeName: true, defaultWatch: "muted", defaultMute: "default_finance" });
    expect(classifyConversation(m, contextFor({}, true))).toEqual({ class: "finance", denyReason: null, hubKind: null, financeName: true, defaultWatch: "watched", defaultMute: null });
    expect(classifyConversation({ ...m, isMember: false }, contextFor({}, true))).toEqual({ class: "finance", denyReason: null, hubKind: null, financeName: true, defaultWatch: "unwatched", defaultMute: null });
    for (const name of ["payroll-2026", "acme-hr", "legal-team", "billing", "zenith-tax", "contracts", "compliance-ops", "acme-accounting"]) {
      expect(classifyConversation(meta({ name }), contextFor({}, true)), name).toMatchObject({ class: "finance", financeName: true, defaultWatch: "watched", defaultMute: null });
    }
  });
  it("RA03 a finance-named Slack Connect member channel → external, financeName, watched", () => {
    const m = meta({ id: "C0EXTFIN", name: "acme-billing-shared", isExtShared: true });
    expect(classifyConversation(m, contextFor({}, true))).toEqual({ class: "external", denyReason: null, hubKind: null, financeName: true, defaultWatch: "watched", defaultMute: null });
    expect(classifyConversation({ ...m, isExtShared: false, isPendingExtShared: true }, contextFor({}, true))).toMatchObject({ class: "external", financeName: true, defaultWatch: "watched" });
    expect(classifyConversation(m, contextFor({}, false))).toMatchObject({ class: "external", financeName: true, defaultWatch: "muted", defaultMute: "default_finance" });
  });
});

describe("RA04 his Slack mutes (C34)", () => {
  it("a Slack-muted standard member channel: read-all false → muted / slack; true → watched, no mute", () => {
    const m = meta({ id: "C0MUTED", name: "zenith-house-general" });
    const muted = { slackMutedIds: ["C0MUTED", "D0MUTEDIM"] };
    expect(classifyConversation(m, contextFor(muted, false))).toMatchObject({ class: "standard", defaultWatch: "muted", defaultMute: "slack" });
    expect(classifyConversation(m, contextFor(muted, true))).toMatchObject({ class: "standard", defaultWatch: "watched", defaultMute: null });
    const im = meta({ id: "D0MUTEDIM", convType: "im", name: null, imUser: "U0SOMEONE" });
    expect(classifyConversation(im, contextFor(muted, false))).toMatchObject({ class: "standard", defaultWatch: "muted", defaultMute: "slack" });
    expect(classifyConversation(im, contextFor(muted, true))).toMatchObject({ class: "standard", defaultWatch: "watched", defaultMute: null });
  });
});

describe("RA05 read-all changes nothing for deny, hubs, unclassified, IMs and group DMs", () => {
  it("every fixture row whose expectation isn't a readable finance or Slack-muted default classifies the same under read-all", () => {
    for (const r of fixture.rows) {
      const e = r.expect;
      const opened = (e.financeName && e.defaultWatch === "muted") || e.defaultMute === "slack";
      if (opened) continue;
      expect(classifyConversation(r.meta, contextFor(r.ctx, true)), r.id).toEqual(e);
    }
  });
  it("the deny cases, both hubs and the unclassified cases by hand", () => {
    const ctx = contextFor({ slackMutedIds: ["G0BPVOB", "C0OUT", "C0EMAILN", "D0X"] }, true);
    const cases: [ConversationMeta, Partial<Classification>][] = [
      [meta({ id: "D0EA", convType: "im", name: null, imUser: "U0EABOT" }), { class: "deny", denyReason: "assistant_dm" }],
      [meta({ id: "D0DDBOT", convType: "im", name: null, imUser: "U0OTHER" }), { class: "deny", denyReason: "dd_bot_dm" }],
      [meta({ id: "D0DD2", convType: "im", name: null, imUser: "U0DDBOT" }), { class: "deny", denyReason: "dd_bot_dm" }],
      [meta({ id: "D0SELF", convType: "im", name: null, imUser: "U0MITCH" }), { class: "deny", denyReason: "self_dm" }],
      [meta({ id: "D0SB", convType: "im", name: null, imUser: "USLACKBOT" }), { class: "deny", denyReason: "bot_im" }],
      [meta({ id: "D0ZAP", convType: "im", name: null, imUser: "U0ZAP" }), { class: "deny", denyReason: "bot_im" }],
      [meta({ id: "G0BPVOB", convType: "group", name: "anything" }), { class: "deny", denyReason: "fb_list" }],
      [meta({ id: "C0BPN", name: "bright-paths-vob-leads" }), { class: "deny", denyReason: "fb_list" }],
      [meta({ id: "C0LEAD", name: "zenith-house-finance-vob-leads" }), { class: "deny", denyReason: "lead_name" }],
      [meta({ id: "C0OUT", name: "dd-outbound" }), { class: "hub", hubKind: "outbound", defaultMute: null }],
      [meta({ id: "C0EMAILN", name: "client-email" }), { class: "hub", hubKind: "client_email", defaultMute: null }],
      [meta({ id: "C0NONAME", name: null }), { class: "unclassified" }],
      [meta({ id: "D0X", convType: "im", name: null, imUser: null }), { class: "unclassified" }]
    ];
    for (const [m, want] of cases) expect(classifyConversation(m, ctx), m.id).toMatchObject(want);
    const ungranted = contextFor({ grantedTypes: ["channel", "group"] }, true);
    expect(classifyConversation(meta({ id: "D0NEW", convType: "im", name: null, imUser: "U0SOMEONE" }), ungranted)).toMatchObject({ class: "unclassified" });
    expect(classifyConversation(meta({ id: "D0NEW", convType: "mpim", name: null }), contextFor({}, true))).toMatchObject({ class: "standard", defaultWatch: "watched", defaultMute: null });
  });
});

describe("RA06 toClassRow of a read-all finance member", () => {
  it("finance_name true, default_watch watched, default_mute null (class finance kept)", () => {
    const m = meta({ id: "C0FIN", name: "zenith-house-finance" });
    const row = toClassRow(m, classifyConversation(m, contextFor({}, true)));
    expect(row).toMatchObject({ channel_id: "C0FIN", class: "finance", finance_name: true, default_watch: "watched", default_mute: null, name: "zenith-house-finance", is_member: true });
  });
});
