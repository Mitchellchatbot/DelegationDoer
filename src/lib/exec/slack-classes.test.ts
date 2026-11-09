import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import {
  channelSlug,
  classifyConversation,
  isFinanceName,
  isLeadName,
  leadSlugsFrom,
  toClassRow,
  type ClassifierContext
} from "@/lib/exec/slack-classes";
import { ddOutboundChannelId } from "@/lib/exec/slack-config";
import type { Classification, ClassRow, ConversationMeta, ConvType } from "@/lib/exec/slack-read-types";

// P7a §5.1 (Area B): the never-watch classifier, the most important file of the phase (N1, N22). Every CL row of the
// lead's fixture (slack-classes.json; RQ08 replays the same JSON through exec_slack_apply_classes on PGlite), the
// helpers, the toClassRow bare-marker rule against a TS statement of §2.6.1's CHECKs, and the fail-closed edges.

interface Base {
  principalSlackUserId: string; assistantDmChannelId: string; assistantBotUserId: string; ddBotUserId: string | null; ddBotDmChannelIds: string[];
  botUserIds: string[] | null; fbLeadChannelIds: string[]; fbLeadNames: string[]; leadSlugs: string[]; outboundChannelId: string | null;
  clientEmailChannelId: string | null; grantedTypes: ConvType[]; slackMutedIds: string[] | null;
}
interface Row { id: string; name: string; meta: ConversationMeta; ctx?: Partial<Record<keyof Base, unknown>>; expect: Classification; expectClassRow?: Partial<ClassRow> }
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./__tests__/fixtures/slack-classes.json", import.meta.url)), "utf8")) as {
  base: Base; inputs: { clientNames: string[] }; rows: Row[];
};

const setOf = (v: unknown): ReadonlySet<string> => new Set(Array.isArray(v) ? (v as string[]) : []);

/** The base context with a row's overrides (arrays become sets; null stays null). */
function contextFor(overrides: Partial<Record<keyof Base, unknown>> = {}): ClassifierContext {
  const merged: Record<string, unknown> = { ...fixture.base, ...overrides };
  return {
    principalSlackUserId: merged.principalSlackUserId as string,
    assistantDmChannelId: merged.assistantDmChannelId as string,
    assistantBotUserId: merged.assistantBotUserId as string,
    ddBotUserId: (merged.ddBotUserId as string | null) ?? null,
    ddBotDmChannelIds: setOf(merged.ddBotDmChannelIds),
    botUserIds: merged.botUserIds === null ? null : setOf(merged.botUserIds),
    fbLeadChannelIds: setOf(merged.fbLeadChannelIds),
    fbLeadNames: setOf(merged.fbLeadNames),
    leadSlugs: (merged.leadSlugs as string[]) ?? [],
    outboundChannelId: (merged.outboundChannelId as string | null) ?? null,
    clientEmailChannelId: (merged.clientEmailChannelId as string | null) ?? null,
    grantedTypes: new Set((merged.grantedTypes as ConvType[]) ?? []),
    slackMutedIds: merged.slackMutedIds === null || merged.slackMutedIds === undefined ? null : setOf(merged.slackMutedIds)
  };
}

const ROWS = fixture.rows;
const rowsOf = (id: string) => ROWS.filter((r) => r.id === id);
const classify = (r: Row) => classifyConversation(r.meta as ConversationMeta, contextFor(r.ctx));
const meta = (over: Partial<ConversationMeta>): ConversationMeta => ({
  id: "C0TEST", convType: "channel", name: "general-chat", isMember: true, isPrivate: false, isExtShared: false,
  isPendingExtShared: false, isArchived: false, imUser: null, ...over
});

/** §2.6.1's CHECKs (and §2.8.5's row validation) as TS: what exec_slack_apply_classes would refuse or bare. */
function checkProblems(row: ClassRow): string[] {
  const p: string[] = [];
  if (!/^[CGD][A-Z0-9]{2,30}$/.test(row.channel_id)) p.push("id_check");
  if (!["channel", "group", "im", "mpim"].includes(row.conv_type)) p.push("type_check");
  if (row.class === "deny") {
    if (row.deny_reason === null || row.name !== null || row.im_user_id !== null || row.default_watch !== "unwatched"
        || row.default_mute !== null || row.is_ext_shared || row.finance_name) p.push("deny_check");
  }
  if ((row.class === "deny") !== (row.deny_reason !== null)) p.push("reason_pair_check");
  if ((row.class === "hub") !== (row.hub_kind !== null)) p.push("hub_pair_check");
  if (row.class === "unclassified" && (row.default_watch !== "unwatched" || row.name !== null || row.finance_name)) p.push("unclassified_check");
  if (row.class === "finance" && !row.finance_name) p.push("finance_name_check (class)");
  if (row.finance_name && !((row.conv_type === "channel" || row.conv_type === "group") && (row.class === "finance" || row.class === "external"))) {
    p.push("finance_name_check (flag)");
  }
  if ((row.default_watch === "muted") !== (row.default_mute !== null)) p.push("mute_pair_check");
  if (row.im_user_id !== null && row.conv_type !== "im") p.push("im_check");
  if (row.conv_type !== "channel" && !row.is_private) p.push("private_check");
  if (row.is_ext_shared && (row.class === "standard" || row.class === "finance")) p.push("external_check");
  if (row.name !== null && !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(row.name)) p.push("name_check");
  if ((row.conv_type === "im" || row.conv_type === "mpim") && row.name !== null) p.push("im/mpim name");
  return p;
}

let consoleCapture: ReturnType<typeof captureConsole> | null = null;
afterEach(() => {
  // The classifier is pure and silent: nothing it decides is logged (N14).
  consoleCapture?.assertClean();
  expect(consoleCapture?.calls() ?? []).toEqual([]);
  consoleCapture = null;
  vi.unstubAllEnvs();
});

describe("the fixture (§5.1)", () => {
  it("base.leadSlugs is leadSlugsFrom(clientNames, base.fbLeadNames), as a set", () => {
    const slugs = leadSlugsFrom({ clientNames: fixture.inputs.clientNames, fbLeadNames: fixture.base.fbLeadNames });
    expect(new Set(slugs)).toEqual(new Set(fixture.base.leadSlugs));
    expect(slugs).toHaveLength(new Set(slugs).size);
  });

  it("every CL id CL01-CL30 and CL15b has at least one row", () => {
    const ids = new Set(ROWS.map((r) => r.id));
    for (let i = 1; i <= 30; i++) expect(ids.has(`CL${String(i).padStart(2, "0")}`), `CL${i}`).toBe(true);
    expect(ids.has("CL15b")).toBe(true);
  });
});

describe("classifyConversation: every fixture row (CL01-CL30, CL15b)", () => {
  it.each(ROWS.map((r) => [`${r.id} ${r.name}`, r] as const))("%s", (_name, row) => {
    consoleCapture = captureConsole();
    const c = classify(row);
    expect(c).toEqual(row.expect);
    const classRow = toClassRow(row.meta as ConversationMeta, c);
    if (row.expectClassRow) expect(classRow).toMatchObject(row.expectClassRow);
    // CL30: every row through the CHECKs exec_slack_apply_classes would write it under.
    expect(checkProblems(classRow)).toEqual([]);
  });
});

describe("the never-watch rules, one by one (N1)", () => {
  it("CL01 / CL02 the assistant DM, by id and by its bot counterpart", () => {
    expect(rowsOf("CL01").map(classify)).toEqual([expect.objectContaining({ class: "deny", denyReason: "assistant_dm" })]);
    expect(rowsOf("CL02").map(classify)).toEqual([expect.objectContaining({ class: "deny", denyReason: "assistant_dm" })]);
    // By id whatever the type: a conversation the installation calls its DM is denied even as a channel.
    expect(classifyConversation(meta({ id: "D0EA", convType: "channel", name: "general" }), contextFor())).toMatchObject({ class: "deny", denyReason: "assistant_dm" });
  });

  it("CL03-CL05 the DD-bot DM: daily_briefings ids, the DD bot's user, and the bot set when dd-bot.ts has no identity", () => {
    expect(classify(rowsOf("CL03")[0])).toMatchObject({ class: "deny", denyReason: "dd_bot_dm" });
    expect(classify(rowsOf("CL04")[0])).toMatchObject({ class: "deny", denyReason: "dd_bot_dm" });
    expect(classify(rowsOf("CL05")[0])).toMatchObject({ class: "deny", denyReason: "bot_im" });
    // With no identity and the DD bot not in the bot set, an unknown counterpart is still never "standard" when the set is unknown.
    expect(classifyConversation(meta({ id: "D0X", convType: "im", name: null, isPrivate: true, imUser: "U0DDBOT" }),
      contextFor({ ddBotUserId: null, botUserIds: null }))).toMatchObject({ class: "unclassified" });
  });

  it("CL06 his self-DM (mutant N01)", () => {
    expect(classify(rowsOf("CL06")[0])).toMatchObject({ class: "deny", denyReason: "self_dm" });
    // Denied before the bot set is consulted: even with users.list down.
    expect(classifyConversation(rowsOf("CL06")[0].meta as ConversationMeta, contextFor({ botUserIds: null }))).toMatchObject({ class: "deny", denyReason: "self_dm" });
  });

  it("CL07 / CL08 Slackbot and every bot in the users.list set", () => {
    expect(classify(rowsOf("CL07")[0])).toMatchObject({ class: "deny", denyReason: "bot_im" });
    expect(classify(rowsOf("CL08")[0])).toMatchObject({ class: "deny", denyReason: "bot_im" });
    expect(classifyConversation(rowsOf("CL07")[0].meta as ConversationMeta, contextFor({ botUserIds: null }))).toMatchObject({ class: "deny", denyReason: "bot_im" });
  });

  it("CL09 / CL10 an IM whose counterpart can't be judged stays unclassified, never standard (fail closed; mutant N05)", () => {
    expect(classify(rowsOf("CL09")[0])).toEqual({ class: "unclassified", denyReason: null, hubKind: null, financeName: false, defaultWatch: "unwatched", defaultMute: null });
    expect(classify(rowsOf("CL10")[0])).toMatchObject({ class: "unclassified", defaultWatch: "unwatched" });
    // A counterpart that isn't a user id is unknown too.
    for (const imUser of ["", "u0jane", "B0ZAP", "U0JANE ", "SENTINEL-SLACK-TEXT-7f3a"]) {
      expect(classifyConversation(meta({ id: "D0ODD", convType: "im", name: null, isPrivate: true, imUser }), contextFor()).class, imUser).toBe("unclassified");
    }
  });

  it("CL11 an IM with a colleague is standard and watched", () => {
    expect(classify(rowsOf("CL11")[0])).toMatchObject({ class: "standard", defaultWatch: "watched", defaultMute: null });
  });

  it("CL12-CL14 the FB list by id (whatever the name) and by normalized name (mutant N02)", () => {
    expect(classify(rowsOf("CL12")[0])).toMatchObject({ class: "deny", denyReason: "fb_list" });
    expect(classify(rowsOf("CL13")[0])).toMatchObject({ class: "deny", denyReason: "fb_list" });
    expect(classify(rowsOf("CL14")[0])).toMatchObject({ class: "deny", denyReason: "fb_list" });
    // "#Name", upper case and stray spaces in the DD list all normalize to the Slack name.
    for (const listed of ["#Bright-Paths-Intake", "  bright-paths-intake  ", "BRIGHT-PATHS-INTAKE", "#bright paths intake"]) {
      expect(classifyConversation(meta({ name: "bright-paths-intake" }), contextFor({ fbLeadNames: [listed] })).denyReason, listed).toBe("fb_list");
    }
    // An unrelated listed name doesn't deny.
    expect(classifyConversation(meta({ name: "bright-paths-ops" }), contextFor({ fbLeadNames: ["bright-paths-intake"] })).class).toBe("standard");
  });

  it("CL15 N1's suffixes and CL15b the legacy SOP names deny by the token rule; the near misses don't (mutant N63)", () => {
    for (const row of [...rowsOf("CL15"), ...rowsOf("CL15b")]) {
      const expectDeny = row.expect.class === "deny";
      expect(isLeadName(row.meta.name as string, []), row.meta.name as string).toBe(expectDeny);
      expect(classify(row).class, row.meta.name as string).toBe(row.expect.class);
    }
    expect(isLeadName("smt-calendly-call-booked", [])).toBe(true);
    expect(isLeadName("west_zap_errors", [])).toBe(true);
    expect(isLeadName("west.vob", [])).toBe(true);
    expect(isLeadName("SUMMIT-VOB-LEADS", [])).toBe(true);
    expect(isLeadName("calendly", [])).toBe(true);
    for (const name of ["calendar", "vobis", "fbi-tools", "leadership-fb", "zap-tools", "error-zap", "leadsfb", "fbleads"]) {
      expect(isLeadName(name, []), name).toBe(false);
    }
  });

  it("CL16-CL20 a name with 'leads' denies only together with a client slug or an FB prefix (mutant N03)", () => {
    expect(classify(rowsOf("CL16")[0])).toMatchObject({ class: "deny", denyReason: "lead_name" });
    expect(classify(rowsOf("CL17")[0])).toMatchObject({ class: "deny", denyReason: "lead_name" });
    expect(classify(rowsOf("CL18")[0])).toMatchObject({ class: "deny", denyReason: "lead_name" });
    expect(classify(rowsOf("CL19")[0])).toMatchObject({ class: "standard" });
    expect(classify(rowsOf("CL20")[0])).toMatchObject({ class: "standard" });
    const slugs = fixture.base.leadSlugs;
    expect(isLeadName("bright-paths-new-leads", slugs)).toBe(true);
    expect(isLeadName("bright-paths-new-leads", [])).toBe(false);
    expect(isLeadName("summit-wellness-leads-intake", slugs)).toBe(true);
    expect(isLeadName("summit-wellness-intake", slugs)).toBe(false);
    // Slugs shorter than 4 characters never count.
    expect(isLeadName("abc-leads", ["abc"])).toBe(false);
  });

  it("CL21 / CL22 the DD hubs: watched when a member, unwatched otherwise; his Slack mutes never apply", () => {
    const [member, nonMember] = rowsOf("CL21");
    expect(classify(member)).toEqual({ class: "hub", denyReason: null, hubKind: "outbound", financeName: false, defaultWatch: "watched", defaultMute: null });
    expect(classify(nonMember)).toMatchObject({ class: "hub", hubKind: "outbound", defaultWatch: "unwatched" });
    expect(classify(rowsOf("CL22")[0])).toMatchObject({ class: "hub", hubKind: "client_email", defaultWatch: "watched" });
    // No hub when the env isn't set.
    expect(classifyConversation(member.meta as ConversationMeta, contextFor({ outboundChannelId: null })).class).toBe("standard");
  });

  it("CL23 / CL24 deny beats external, hub beats external (mutant N04)", () => {
    expect(classify(rowsOf("CL23")[0])).toMatchObject({ class: "deny", denyReason: "lead_name" });
    expect(classify(rowsOf("CL24")[0])).toMatchObject({ class: "hub", hubKind: "outbound" });
    // A Slack Connect channel on the FB list by id or name is denied too.
    expect(classifyConversation(meta({ id: "G0BPVOB", isExtShared: true }), contextFor()).class).toBe("deny");
    expect(classifyConversation(meta({ name: "bright-paths-vob-leads", isExtShared: true }), contextFor()).class).toBe("deny");
  });

  it("CL25-CL27 Slack Connect is external; a finance name keeps every finance protection (C10; mutant N66)", () => {
    expect(classify(rowsOf("CL25")[0])).toMatchObject({ class: "external", financeName: false, defaultWatch: "watched" });
    expect(classify(rowsOf("CL26")[0])).toMatchObject({ class: "external", financeName: false });
    const [finMember, finNonMember, general] = rowsOf("CL27");
    const c = classify(finMember);
    expect(c).toEqual({ class: "external", denyReason: null, hubKind: null, financeName: true, defaultWatch: "muted", defaultMute: "default_finance" });
    expect(toClassRow(finMember.meta as ConversationMeta, c)).toMatchObject({ class: "external", finance_name: true, is_ext_shared: true });
    expect(classify(finNonMember)).toMatchObject({ class: "external", financeName: true, defaultWatch: "unwatched", defaultMute: null });
    expect(classify(general)).toMatchObject({ class: "external", financeName: false, defaultWatch: "watched" });
    // A finance-named Slack Connect channel isn't moved off its finance default by his Slack mutes either.
    expect(classifyConversation(finMember.meta as ConversationMeta, contextFor({ slackMutedIds: [finMember.meta.id] })))
      .toMatchObject({ defaultWatch: "muted", defaultMute: "default_finance" });
    // An external IM or group DM has no name, so never a finance name.
    expect(classifyConversation(meta({ id: "D0EXT", convType: "im", name: null, isPrivate: true, imUser: "U0EXT", isExtShared: true }), contextFor()))
      .toMatchObject({ class: "external", financeName: false, defaultWatch: "watched" });
  });

  it("CL28 finance / payroll / HR / legal names, on word boundaries only (mutant N06)", () => {
    for (const row of rowsOf("CL28")) expect(classify(row).class, row.meta.name as string).toBe(row.expect.class);
    for (const name of ["finance", "team-payroll", "hr", "legal-contracts", "billing.ops", "taxes", "tax", "people-ops", "peopleops",
      "ops_accounting", "invoice", "invoices", "contract", "salary", "salaries", "compliance", "bookkeeping", "financial", "Finance"]) {
      expect(isFinanceName(name), name).toBe(true);
    }
    for (const name of ["hrm-tools", "shrink", "paperwork", "taxi", "legalese", "financed", "chr", "contractor-chat", "people"]) {
      expect(isFinanceName(name), name).toBe(false);
    }
  });

  it("CL29 no usable name → unclassified; an MPIM → standard, watched, no name in toClassRow", () => {
    const [noName, mpim] = rowsOf("CL29");
    expect(classify(noName)).toMatchObject({ class: "unclassified", defaultWatch: "unwatched" });
    const c = classify(mpim);
    expect(c).toMatchObject({ class: "standard", defaultWatch: "watched" });
    expect(toClassRow({ ...(mpim.meta as ConversationMeta), name: "mpdm-mitchell--jane--bob-1" }, c).name).toBeNull();
    // A malformed name is no name.
    for (const name of ["Bad Name!", "-leading", "a".repeat(81), "SENTINEL-SLACK-TEXT-7f3a"]) {
      expect(classifyConversation(meta({ name }), contextFor()).class, name).toBe("unclassified");
    }
  });

  it("CL30 his Slack mutes (C34) mute a watched default only; deny and hub stay as they are", () => {
    const [standard, denied, hubRow] = rowsOf("CL30");
    expect(classify(standard)).toMatchObject({ class: "standard", defaultWatch: "muted", defaultMute: "slack" });
    expect(classify(denied)).toMatchObject({ class: "deny", defaultWatch: "unwatched", defaultMute: null });
    expect(classify(hubRow)).toMatchObject({ class: "hub", defaultWatch: "watched", defaultMute: null });
    // An unwatched default (not a member) isn't muted, and a null mute list mutes nothing.
    expect(classifyConversation(meta({ id: "C0RANDOM", isMember: false }), contextFor({ slackMutedIds: ["C0RANDOM"] })))
      .toMatchObject({ defaultWatch: "unwatched", defaultMute: null });
    expect(classifyConversation(meta({ id: "C0RANDOM" }), contextFor({ slackMutedIds: null }))).toMatchObject({ defaultWatch: "watched" });
  });
});

describe("fail closed beyond the table", () => {
  it("a type the consent didn't grant is never readable, but the deny rules still apply first", () => {
    const noIm = contextFor({ grantedTypes: ["channel", "group"] });
    expect(classifyConversation(meta({ id: "D0JANE", convType: "im", name: null, isPrivate: true, imUser: "U0JANE" }), noIm).class).toBe("unclassified");
    expect(classifyConversation(meta({ id: "D0SELF", convType: "im", name: null, isPrivate: true, imUser: "U0MITCH" }), noIm)).toMatchObject({ class: "deny", denyReason: "self_dm" });
    expect(classifyConversation(meta({ id: "G0MP", convType: "mpim", name: null, isPrivate: true }), contextFor({ grantedTypes: ["channel", "group", "im"] })).class).toBe("unclassified");
  });

  it("every class decision is one of the six, every default a legal pair", () => {
    const seen = new Set<string>();
    for (const row of ROWS) {
      const c: Classification = classify(row);
      seen.add(c.class);
      expect(["unclassified", "deny", "hub", "finance", "external", "standard"]).toContain(c.class);
      expect(c.defaultWatch === "muted").toBe(c.defaultMute !== null);
      if (c.class === "deny" || c.class === "unclassified") expect(c).toMatchObject({ defaultWatch: "unwatched", defaultMute: null, financeName: false });
    }
    expect([...seen].sort()).toEqual(["deny", "external", "finance", "hub", "standard", "unclassified"]);
  });
});

describe("toClassRow (C5, C9: the bare marker)", () => {
  it("a deny row carries no name, no counterpart, no share flag, no finance flag and the defaults' booleans", () => {
    for (const row of ROWS.filter((r) => r.expect.class === "deny")) {
      const named = { ...(row.meta as ConversationMeta), name: "bright-paths-vob-leads", isExtShared: true, isMember: true, isArchived: true };
      const out = toClassRow(named, classify(row));
      expect(out).toMatchObject({ class: "deny", name: null, im_user_id: null, is_ext_shared: false, finance_name: false, is_member: false,
        is_private: true, is_archived: false, default_watch: "unwatched", default_mute: null, hub_kind: null });
      expect(out.deny_reason).toBe(row.expect.denyReason);
    }
  });

  it("an unclassified row carries the id and type only; a readable IM its counterpart; a named channel its name", () => {
    expect(toClassRow(meta({ id: "D0UNK", convType: "im", name: null, isPrivate: true, imUser: "U0STRANGER" }),
      { class: "unclassified", denyReason: null, hubKind: null, financeName: false, defaultWatch: "unwatched", defaultMute: null }))
      .toMatchObject({ name: null, im_user_id: null });
    const im = meta({ id: "D0JANE", convType: "im", name: null, isPrivate: true, imUser: "U0JANE" });
    expect(toClassRow(im, classifyConversation(im, contextFor()))).toMatchObject({ im_user_id: "U0JANE", name: null, is_private: true });
    const ch = meta({ id: "C0GENERAL", name: "general" });
    expect(toClassRow(ch, classifyConversation(ch, contextFor()))).toEqual({
      channel_id: "C0GENERAL", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null, finance_name: false,
      default_watch: "watched", default_mute: null, name: "general", im_user_id: null, is_member: true, is_private: false,
      is_ext_shared: false, is_archived: false
    });
  });

  it("every row has the identical key set (§0.3 rule 10) and a pending share counts as shared", () => {
    const keys = new Set<string>();
    for (const row of ROWS) keys.add(Object.keys(toClassRow(row.meta as ConversationMeta, classify(row))).sort().join(","));
    expect(keys.size).toBe(1);
    const pending = rowsOf("CL26")[0];
    expect(toClassRow(pending.meta as ConversationMeta, classify(pending)).is_ext_shared).toBe(true);
  });
});

describe("the helpers", () => {
  it("channelSlug lowercases, turns every run of other characters into one hyphen, and trims hyphens", () => {
    expect(channelSlug("Bright Paths Recovery")).toBe("bright-paths-recovery");
    expect(channelSlug("#Brightpaths-Intake")).toBe("brightpaths-intake");
    expect(channelSlug("  Summit -- Wellness!! ")).toBe("summit-wellness");
    expect(channelSlug("billing.ops_team")).toBe("billing-ops-team");
    expect(channelSlug("")).toBe("");
    expect(channelSlug("!!!")).toBe("");
  });

  it("leadSlugsFrom: slug, first two tokens, a first token of 5+, the FB prefix; only entries of 4+, deduplicated", () => {
    expect(leadSlugsFrom({ clientNames: ["Bright Paths Recovery"], fbLeadNames: [] })).toEqual(["bright-paths-recovery", "bright-paths", "bright"]);
    expect(leadSlugsFrom({ clientNames: ["ABC Co"], fbLeadNames: [] })).toEqual(["abc-co"]);
    expect(leadSlugsFrom({ clientNames: ["Ace"], fbLeadNames: [] })).toEqual([]);
    expect(leadSlugsFrom({ clientNames: [], fbLeadNames: ["west-coast-fb-leads-vob", "smt-calendly", "harbor-failsafe", "#North-Star-Intake"] }))
      .toEqual(["west-coast", "harbor", "north-star-intake"]);
    expect(leadSlugsFrom({ clientNames: ["Summit Wellness", "Summit Wellness"], fbLeadNames: ["summit-wellness-vob-leads"] })).toEqual(["summit-wellness", "summit"]);
  });
});

describe("ddOutboundChannelId (§3.6.3; the outbound hub)", () => {
  it("SLACK_OUTBOUND_CHANNEL trimmed when it is a C/G id, else null; re-read on every call", () => {
    vi.stubEnv("SLACK_OUTBOUND_CHANNEL", " C0OUT ");
    expect(ddOutboundChannelId()).toBe("C0OUT");
    vi.stubEnv("SLACK_OUTBOUND_CHANNEL", "G0OUTBOUND");
    expect(ddOutboundChannelId()).toBe("G0OUTBOUND");
    for (const bad of ["", "D0MITCH", "#outbound", "c0out", "C0", "C0OUT x"]) {
      vi.stubEnv("SLACK_OUTBOUND_CHANNEL", bad);
      expect(ddOutboundChannelId(), bad).toBeNull();
    }
    vi.stubEnv("SLACK_OUTBOUND_CHANNEL", undefined);
    expect(ddOutboundChannelId()).toBeNull();
  });
});
