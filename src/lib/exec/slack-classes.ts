import type {
  ChannelClass,
  Classification,
  ClassRow,
  ConversationMeta,
  ConvType,
  DenyReason,
  HubKind,
  WatchState
} from "@/lib/exec/slack-read-types";

// P7a never-watch classifier (P7a contract §3.5, N1, N2, N10, N12; Area B;
// pure). The single never-watch decision (B-P7a-9): only
// handlers/slack-discover.ts and handlers/slack-classify.ts call
// classifyConversation, and nothing else in exec code exports a class
// decision. The ack RPC, every sweep, the classify job, the triage writer and
// the S3 screen re-check the STORED class; only this function sets it.
//
// The rules (first match wins; CL01-CL30 pin every row):
//   1-3  by id, any type: the assistant DM, a daily_briefings (DD bot) DM, an FB-listed lead channel  -> deny
//   4-9  an IM, by its counterpart: him (self_dm), the assistant bot, Slackbot, the DD bot, the users.list bot set
//        -> deny; an unknown counterpart (null, or the bot set couldn't be read) -> unclassified (fail closed)
//   10   a channel / group without a usable name -> unclassified (the lead-name rules can't run)
//   11   an FB-listed name -> deny fb_list;  12  a lead name (isLeadName, C37) -> deny lead_name
//   13-14 the DD hubs (outbound, client email) -> hub
//   15   Slack Connect (shared or pending) -> external (financeName for a finance-named channel / group, C10)
//   16   a finance / payroll / HR / legal name -> finance;  17  standard
// A type not in grantedTypes is never read: after the deny rules it is unclassified (fail closed).
//
// Fail closed everywhere: over-denying is harmless (contract Appendix A.2), under-denying is a PHI exposure
// (42 CFR Part 2 lead channels). Nothing here logs, and nothing here reads message text.

const DENY_TOKENS: ReadonlySet<string> = new Set(["vob", "nonvob", "calendly", "failsafe"]);
const LEAD_WORDS: ReadonlySet<string> = new Set(["lead", "leads"]);
const ZAP_ERROR: ReadonlySet<string> = new Set(["error", "errors"]);
const FINANCE_RE =
  /(^|[-_.])(finance|financial|payroll|accounting|bookkeeping|invoices?|billing|tax(es)?|hr|people-?ops|legal|contracts?|compliance|salary|salaries)([-_.]|$)/;
/** exec_slack_channels_name_check / the reads' name filter. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const USER_RE = /^[UW][A-Z0-9]{2,30}$/;
const SLACKBOT = "USLACKBOT";
const MIN_SLUG = 4;
const FIRST_TOKEN_MIN = 5;

export interface ClassifierContext {
  principalSlackUserId: string;            // the installation's user_id
  assistantDmChannelId: string;            // the installation's slack_dm_channel_id
  assistantBotUserId: string;              // the installation's bot_user_id
  ddBotUserId: string | null;              // dd-bot.ts; null when unknown
  ddBotDmChannelIds: ReadonlySet<string>;  // daily_briefings.slack_channel values
  botUserIds: ReadonlySet<string> | null;  // users.list bots (+ USLACKBOT); null = the read failed → unknown IM counterparts stay unclassified
  fbLeadChannelIds: ReadonlySet<string>;   // exec_slack_fb_lead_channels() ids
  fbLeadNames: ReadonlySet<string>;        // its names, lowercased
  leadSlugs: readonly string[];            // leadSlugsFrom(...)
  outboundChannelId: string | null;        // SLACK_OUTBOUND_CHANNEL
  clientEmailChannelId: string | null;     // workspace_settings.client_email_channel_id
  grantedTypes: ReadonlySet<ConvType>;
  slackMutedIds: ReadonlySet<string> | null;   // C34
}

const isNamedType = (t: ConvType): boolean => t === "channel" || t === "group";

function deny(reason: DenyReason): Classification {
  return { class: "deny", denyReason: reason, hubKind: null, financeName: false, defaultWatch: "unwatched", defaultMute: null };
}

function unclassified(): Classification {
  return { class: "unclassified", denyReason: null, hubKind: null, financeName: false, defaultWatch: "unwatched", defaultMute: null };
}

function hub(kind: HubKind, meta: ConversationMeta): Classification {
  // A hub is read only for DD's own posts (anchors); his Slack mutes never apply to it (C34, C35).
  return { class: "hub", denyReason: null, hubKind: kind, financeName: false, defaultWatch: meta.isMember ? "watched" : "unwatched", defaultMute: null };
}

/** standard / external / finance with §3.5's defaults, then C34 (his Slack mutes) on a default of watched. */
function readable(cls: Extract<ChannelClass, "standard" | "external" | "finance">, financeName: boolean, meta: ConversationMeta,
  slackMutedIds: ReadonlySet<string> | null): Classification {
  let defaultWatch: WatchState;
  let defaultMute: "default_finance" | "slack" | null = null;
  if (financeName) {
    // C10: finance, and a finance-named Slack Connect channel: muted by default (never bypassed, N11), unwatched when not a member.
    defaultWatch = meta.isMember ? "muted" : "unwatched";
    defaultMute = meta.isMember ? "default_finance" : null;
  } else if (meta.convType === "im" || meta.convType === "mpim") {
    defaultWatch = "watched";
  } else {
    defaultWatch = meta.isMember ? "watched" : "unwatched";
  }
  if (defaultWatch === "watched" && slackMutedIds !== null && slackMutedIds.has(meta.id)) {
    defaultWatch = "muted";
    defaultMute = "slack";
  }
  return { class: cls, denyReason: null, hubKind: null, financeName, defaultWatch, defaultMute };
}

/** The one name normalization of the FB-list match: a listed name may carry "#", upper case or spaces. */
const listedNameKey = (s: string): string => channelSlug(s);

export function classifyConversation(meta: ConversationMeta, ctx: ClassifierContext): Classification {
  // 1-3: by id, whatever the type or name.
  if (meta.id === ctx.assistantDmChannelId) return deny("assistant_dm");
  if (ctx.ddBotDmChannelIds.has(meta.id)) return deny("dd_bot_dm");
  if (ctx.fbLeadChannelIds.has(meta.id)) return deny("fb_list");

  if (meta.convType === "im") {
    // 4-9: by the IM's counterpart. A counterpart that isn't a well-formed user id is unknown.
    const counterpart = typeof meta.imUser === "string" && USER_RE.test(meta.imUser) ? meta.imUser : null;
    if (counterpart !== null) {
      if (counterpart === ctx.principalSlackUserId) return deny("self_dm");
      if (counterpart === ctx.assistantBotUserId) return deny("assistant_dm");
      if (counterpart === SLACKBOT) return deny("bot_im");
      if (ctx.ddBotUserId !== null && counterpart === ctx.ddBotUserId) return deny("dd_bot_dm");
    }
    if (counterpart === null || ctx.botUserIds === null) return unclassified();
    if (ctx.botUserIds.has(counterpart)) return deny("bot_im");
  }

  const named = isNamedType(meta.convType);
  const name = named && typeof meta.name === "string" && NAME_RE.test(meta.name) ? meta.name : null;
  if (named) {
    // 10-12: a channel or group is judged by its name; no usable name, no judgement (fail closed).
    if (name === null) return unclassified();
    const key = listedNameKey(name);
    for (const listed of ctx.fbLeadNames) {
      if (typeof listed === "string" && listedNameKey(listed) === key && key.length > 0) return deny("fb_list");
    }
    if (isLeadName(name, ctx.leadSlugs)) return deny("lead_name");
  }

  // A type the consent didn't grant is never read (the listing doesn't request it): fail closed.
  if (!ctx.grantedTypes.has(meta.convType)) return unclassified();

  // 13-14: DD's hubs: anchors only.
  if (ctx.outboundChannelId !== null && meta.id === ctx.outboundChannelId) return hub("outbound", meta);
  if (ctx.clientEmailChannelId !== null && meta.id === ctx.clientEmailChannelId) return hub("client_email", meta);

  // 15: Slack Connect is never standard or finance (N10); a finance name keeps every finance protection (C10).
  if (meta.isExtShared || meta.isPendingExtShared) return readable("external", name !== null && isFinanceName(name), meta, ctx.slackMutedIds);

  // 16-17.
  if (name !== null && isFinanceName(name)) return readable("finance", true, meta, ctx.slackMutedIds);
  return readable("standard", false, meta, ctx.slackMutedIds);
}

/** The name split into lowercase alphanumeric tokens (a superset of §3.5's "-", "_", "." split: fail closed). */
function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** C37's token rule (the SQL twin is exec_slack_lead_name): a vob / nonvob / calendly / failsafe token, zap then
 *  error(s), or fb right before or after lead(s). */
function hasLeadTokens(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (DENY_TOKENS.has(t)) return true;
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (t === "zap" && next !== null && ZAP_ERROR.has(next)) return true;
    if (t === "fb" && next !== null && LEAD_WORDS.has(next)) return true;
    if (LEAD_WORDS.has(t) && next === "fb") return true;
  }
  return false;
}

export function isLeadName(name: string, leadSlugs: readonly string[]): boolean {
  if (typeof name !== "string") return true;   // nothing to judge: fail closed
  if (hasLeadTokens(nameTokens(name))) return true;
  const lower = name.toLowerCase();
  if (!lower.includes("leads")) return false;
  for (const slug of leadSlugs) {
    if (typeof slug !== "string") continue;
    const s = slug.toLowerCase();
    if (s.length >= MIN_SLUG && lower.includes(s)) return true;
  }
  return false;
}

export function isFinanceName(name: string): boolean {
  if (typeof name !== "string") return false;
  return FINANCE_RE.test(name.toLowerCase());
}

export function channelSlug(s: string): string {   // lowercase; every run of non-[a-z0-9] → "-"; trimmed of "-"
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The index of the first token of a lead suffix (C37's tokens, "non" + "vob", or a bare lead / leads), or -1. */
function leadSuffixStart(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (DENY_TOKENS.has(t) || LEAD_WORDS.has(t)) return i;
    if (t === "non" && next === "vob") return i;
    if (t === "zap" && next !== null && ZAP_ERROR.has(next)) return i;
    if (t === "fb" && next !== null && LEAD_WORDS.has(next)) return i;
  }
  return -1;
}

/** For each client name: its slug, the slug's first two "-" tokens, and its first token when ≥ 5 characters; for each FB-listed
 *  name: the part before its lead suffix. Deduplicated; only entries ≥ 4 characters. */
export function leadSlugsFrom(input: { clientNames: readonly string[]; fbLeadNames: readonly string[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (s.length >= MIN_SLUG && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const raw of input.clientNames ?? []) {
    const slug = channelSlug(raw);
    if (slug === "") continue;
    const tokens = slug.split("-");
    add(slug);
    add(tokens.slice(0, 2).join("-"));
    if (tokens[0].length >= FIRST_TOKEN_MIN) add(tokens[0]);
  }
  for (const raw of input.fbLeadNames ?? []) {
    const slug = channelSlug(raw);
    if (slug === "") continue;
    const tokens = slug.split("-");
    const at = leadSuffixStart(tokens);
    // A listed name with no recognizable suffix contributes itself: more slugs only ever deny more (fail closed).
    add(at === -1 ? slug : tokens.slice(0, at).join("-"));
  }
  return out;
}

export function toClassRow(meta: ConversationMeta, c: Classification): ClassRow {   // name null for im/mpim and for deny/unclassified; finance_name = c.financeName
  const isDeny = c.class === "deny";
  // C5 / C9: a deny row is a bare marker and an unclassified row holds the id and type only (no name, no counterpart).
  const bare = isDeny || c.class === "unclassified";
  const name = !bare && isNamedType(meta.convType) && typeof meta.name === "string" && NAME_RE.test(meta.name) ? meta.name : null;
  const imUser = !bare && meta.convType === "im" && typeof meta.imUser === "string" && USER_RE.test(meta.imUser) ? meta.imUser : null;
  return {
    channel_id: meta.id,
    conv_type: meta.convType,
    class: c.class,
    deny_reason: isDeny ? c.denyReason : null,
    hub_kind: c.class === "hub" ? c.hubKind : null,
    finance_name: isDeny ? false : c.financeName,
    default_watch: c.defaultWatch,
    default_mute: c.defaultMute,
    name,
    im_user_id: imUser,
    is_member: isDeny ? false : meta.isMember === true,
    is_private: isDeny ? true : meta.convType === "channel" ? meta.isPrivate === true : true,
    // A pending share counts as shared (N10, fail closed).
    is_ext_shared: isDeny ? false : meta.isExtShared === true || meta.isPendingExtShared === true,
    is_archived: isDeny ? false : meta.isArchived === true
  };
}
