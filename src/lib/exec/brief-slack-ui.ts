import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import type { BriefScreen, BriefWithheldReason } from "@/lib/exec/brief-screen";
import { BRIEF_LIMITS, BRIEF_SECTION_KEYS } from "@/lib/exec/brief-types";
import type { BriefContent, BriefSectionContent, BriefSectionKey, BriefStateNote, CheckinView } from "@/lib/exec/brief-types";
import { formatInZone } from "@/lib/exec/format";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { chunkMrkdwn, escapeMrkdwn, safeMrkdwn, sanitizeChars, section, slackLink } from "@/lib/exec/slack-ui";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import type { MrkdwnText, PlainText, SlackBlock, SlackButton, SlackMessageParts } from "@/lib/exec/slack-types";
import type { SourceRef } from "@/lib/exec/types";

// P8 Block Kit (contract §3.16, C25, M7; Area D; pure, B-P8-5): every Slack message P8 emits, built only from P6's
// slack-ui primitives (section, safeMrkdwn, escapeMrkdwn, slackLink, chunkMrkdwn): every mrkdwn text verbatim, every
// model/email/DD/Slack string through safeMrkdwn, every fixed string through escapeMrkdwn, links only allow-listed (slackLink
// answers null for anything else, and then no link is printed at all, never a raw URL). unfurl_links / unfurl_media off is
// postInDm's job. The top-level text of every message is a fixed neutral string (its copy), never content, except
// renderCheckinPost (his own note is the notification).

export interface BriefDmView {
  prettyDate: string;                       // "Friday, Nov 6" in the brief zone
  modeLine: string;                         // BRIEF_COPY.modeAi or fillBrief(modeDeterministic, { reason })
  headline: string | null;
  counts: { new: number; pending: number; unchanged: number };
  top3: { title: string; next: string | null; href: string | null }[];
  sections: { key: BriefSectionKey; title: string; stateLine: string | null;
    lines: { text: string; kind: "fact" | "recommendation"; href: string | null }[];
    pending: string[]; unchanged: number; more: number }[];
  restrictedEmail: number | null;
  briefHref: string;                        // appOrigin() + "/executive/brief"
  generatedAt: string; tz: string;
}

// --- small pieces ------------------------------------------------------------------------------

const mrkdwn = (text: string): MrkdwnText => ({ type: "mrkdwn", text, verbatim: true });
const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: false });
const context = (texts: readonly string[]): SlackBlock => ({ type: "context", elements: texts.map(mrkdwn) });
const divider = (): SlackBlock => ({ type: "divider" });
const HEADER_MAX = 150;
const BUTTON_TEXT_MAX = 75;
const NAME_MAX = 40;
const LABEL_MAX = 60;

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Clip to max UTF-16 units without splitting a surrogate pair; "…" marks a cut. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  const c = s.charCodeAt(cut);
  if (cut > 0 && c >= 0xdc00 && c <= 0xdfff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** A short label from content (a first name, a network prefix): controls and bidi stripped, whitespace collapsed, clipped. */
function shortLabel(v: unknown, max: number): string {
  return clip(sanitizeChars(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim(), max);
}

/** A plain-text header: Slack shows it as written (no mrkdwn), so only the characters are cleaned. */
function header(text: string): SlackBlock {
  return { type: "header", text: plain(clip(sanitizeChars(text).replace(/\s+/g, " ").trim(), HEADER_MAX)) };
}

/** " <url|label>" when the URL is allow-listed, else "" (no raw URL ever). */
function linkAfter(href: string | null, label: string): string {
  const link = href === null ? null : slackLink(href, label);
  return link === null ? "" : ` ${link}`;
}

/** The first ref whose URL passes isAllowedLinkUrl, else null. */
function firstHref(refs: readonly SourceRef[] | null | undefined): string | null {
  for (const r of Array.isArray(refs) ? refs : []) {
    if (r && typeof r.url === "string" && isAllowedLinkUrl(r.url)) return r.url;
  }
  return null;
}

/** "Friday, Nov 6" for a YYYY-MM-DD local date (a calendar date: formatted in UTC so no zone moves it); "" when malformed. */
export function briefPrettyDate(localDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof localDate === "string" ? localDate : "");
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(d);
}

/** A time in the zone ("8:02 AM"), or "" when unreadable (formatInZone answers "—" then). */
function timeIn(iso: string | null | undefined, tz: string): string {
  const t = formatInZone(iso ?? null, tz, "time");
  return t === "—" ? "" : t;
}

function stateLineOf(s: BriefSectionContent): string | null {
  if (s.state === "ok") return null;
  const note = s.stateNote as BriefStateNote | null;
  return note !== null && Object.prototype.hasOwnProperty.call(BRIEF_COPY.state, note) ? BRIEF_COPY.state[note] : BRIEF_COPY.state.unavailable;
}

// --- the brief DM -------------------------------------------------------------------------------

/** content → view: drops scrubbed lines' links, keeps each line's first ref whose url passes isAllowedLinkUrl (else null).
 *  opts.screen (§3.17.7, intel-13): a withheld item renders removedRestricted / removedSlack / removedUnavailable (P9) with no link; withheld pending lines and
 *  top-3 entries are left out; headline null when screen.hideHeadline. Pure (BriefScreen is an `import type`). */
export function briefDmToView(content: BriefContent, opts: { tz: string; briefHref: string; screen: BriefScreen }): BriefDmView {
  const screen = opts.screen;
  const withheldItems = screen?.items ?? new Map<string, BriefWithheldReason>();
  const withheldPending = screen?.pending ?? new Set<string>();
  const withheldTop3 = screen?.top3 ?? new Set<string>();
  const reasonKey = content.modeReason !== null && Object.prototype.hasOwnProperty.call(BRIEF_COPY.modeReason, content.modeReason)
    ? content.modeReason : "model_error";
  const modeLine = content.mode === "ai" ? BRIEF_COPY.modeAi : fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason[reasonKey] });
  const headline = screen?.hideHeadline === true || content.headlineScrubbed === true || typeof content.headline !== "string" ||
    content.headline.trim().length === 0 ? null : content.headline;

  const byKey = new Map<BriefSectionKey, BriefSectionContent>();
  for (const s of Array.isArray(content.sections) ? content.sections : []) if (s && !byKey.has(s.key)) byKey.set(s.key, s);

  const sections: BriefDmView["sections"] = [];
  for (const key of BRIEF_SECTION_KEYS) {
    const s = byKey.get(key);
    if (!s) continue;
    const lines = (Array.isArray(s.items) ? s.items : []).map((item) => {
      const why = withheldItems.get(item.id);
      if (why !== undefined) {
        // P9 seed S2: "unavailable" reads BRIEF_COPY.removedUnavailable (no producer until Area C's F7/F11 screen).
        const text = why === "slack" ? BRIEF_COPY.removedSlack : why === "unavailable" ? BRIEF_COPY.removedUnavailable : BRIEF_COPY.removedRestricted;
        return { text, kind: "fact" as const, href: null };
      }
      // A scrubbed item's text is already the removed copy (the scrub RPC wrote it) and its refs are empty.
      if (item.scrubbed === true) return { text: item.text, kind: "fact" as const, href: null };
      return { text: item.text, kind: item.kind === "recommendation" ? "recommendation" as const : "fact" as const, href: firstHref(item.refs) };
    });
    const pending = (Array.isArray(s.pending) ? s.pending : []).filter((p) => !withheldPending.has(p.fp)).map((p) => p.title);
    sections.push({ key, title: BRIEF_COPY.sectionTitle[key], stateLine: stateLineOf(s), lines, pending, unchanged: count(s.unchanged), more: count(s.more) });
  }

  const top3 = (Array.isArray(content.top3) ? content.top3 : [])
    .filter((t) => !withheldTop3.has(t.alias) && !(t.itemId !== null && withheldItems.has(t.itemId)))
    .slice(0, BRIEF_LIMITS.top3)
    .map((t) => ({ title: t.title, next: typeof t.next === "string" && t.next.trim().length > 0 ? t.next : null, href: firstHref(t.refs) }));

  const c = content.counts;
  return {
    prettyDate: briefPrettyDate(content.localDate),
    modeLine,
    headline,
    counts: { new: count(c?.new) + count(c?.changed) + count(c?.escalated), pending: count(c?.pending), unchanged: count(c?.unchanged) },
    top3,
    sections,
    restrictedEmail: typeof c?.restrictedEmail === "number" && Number.isFinite(c.restrictedEmail) ? Math.max(0, Math.floor(c.restrictedEmail)) : null,
    briefHref: opts.briefHref,
    generatedAt: content.builtAt,
    tz: opts.tz
  };
}

type DmSection = BriefDmView["sections"][number];

function sectionBody(s: DmSection): string | null {
  const parts: string[] = [];
  const shown = s.lines.slice(0, BRIEF_LIMITS.dmLinesPerSection);
  for (const line of shown) {
    const rec = line.kind === "recommendation" ? ` _(${escapeMrkdwn(BRIEF_COPY.suggested)})_` : "";
    parts.push(`• ${safeMrkdwn(line.text)}${rec}${linkAfter(line.href, "Open")}`);
  }
  for (const title of s.pending) parts.push(`• ${escapeMrkdwn(BRIEF_COPY.pendingPrefix)}${safeMrkdwn(title)}`);
  const more = count(s.more) + Math.max(0, s.lines.length - shown.length);
  if (more > 0) parts.push(escapeMrkdwn(fillBrief(BRIEF_COPY.more, { n: more })));
  if (count(s.unchanged) > 0) parts.push(escapeMrkdwn(fillBrief(BRIEF_COPY.unchanged, { n: count(s.unchanged) })));
  if (parts.length === 0) return s.stateLine !== null ? escapeMrkdwn(s.stateLine) : null;
  if (s.stateLine !== null && s.lines.length === 0 && s.pending.length === 0) parts.unshift(escapeMrkdwn(s.stateLine));
  return parts.join("\n");
}

function briefBlocks(v: BriefDmView, sections: readonly DmSection[]): SlackBlock[] {
  const blocks: SlackBlock[] = [header(fillBrief(BRIEF_COPY.dmHeader, { date: v.prettyDate }))];
  blocks.push(context([`${escapeMrkdwn(fillBrief(BRIEF_COPY.dmCounts, { new: count(v.counts.new), pending: count(v.counts.pending), unchanged: count(v.counts.unchanged) }))} · ${escapeMrkdwn(v.modeLine)}`]));
  if (typeof v.headline === "string" && v.headline.trim().length > 0) {
    for (const piece of chunkMrkdwn(safeMrkdwn(v.headline))) blocks.push(section(piece));
  }
  if (v.top3.length > 0) {
    const lines = v.top3.map((t, i) => {
      const next = t.next !== null ? ` · _${escapeMrkdwn(BRIEF_COPY.suggested)}:_ ${safeMrkdwn(t.next)}` : "";
      return `${i + 1}. ${safeMrkdwn(t.title)}${next}${linkAfter(t.href, "Open")}`;
    });
    for (const piece of chunkMrkdwn(`*${escapeMrkdwn(BRIEF_COPY.top3Title)}*\n${lines.join("\n")}`)) blocks.push(section(piece));
  }
  blocks.push(divider());
  for (const s of sections) {
    const body = sectionBody(s);
    if (body === null) continue;
    for (const piece of chunkMrkdwn(`*${escapeMrkdwn(s.title)}*\n${body}`)) blocks.push(section(piece));
  }
  const restricted = v.restrictedEmail ?? 0;
  if (restricted > 0) {
    const copy = restricted === 1 ? BRIEF_COPY.restrictedOne : fillBrief(BRIEF_COPY.restricted, { n: restricted });
    blocks.push(section(`${escapeMrkdwn(copy)}${linkAfter(v.briefHref, "Open DD")}`));
  }
  blocks.push(divider());
  const full = slackLink(v.briefHref, BRIEF_COPY.dmOpenFull) ?? escapeMrkdwn(BRIEF_COPY.dmOpenFull);
  const time = timeIn(v.generatedAt, v.tz);
  blocks.push(context([time.length > 0 ? `${full} · ${escapeMrkdwn(fillBrief(BRIEF_COPY.dmGenerated, { time }))}` : full]));
  return blocks;
}

/** C25 layout 1. Over 45 blocks, the lowest sections' lines become their "+N more in DD" counts until it fits (never a slice);
 *  the result is asserted (assertDmBudget). */
export function renderBriefDm(v: BriefDmView): SlackMessageParts {
  const sections: DmSection[] = v.sections.map((s) => ({ ...s, lines: [...s.lines], pending: [...s.pending] }));
  let blocks = briefBlocks(v, sections);
  for (let i = sections.length - 1; i >= 0 && blocks.length > BRIEF_LIMITS.dmBlocksMax; i--) {
    const s = sections[i];
    if (s.lines.length === 0 && s.pending.length === 0) continue;
    sections[i] = { ...s, more: count(s.more) + s.lines.length + s.pending.length, lines: [], pending: [] };
    blocks = briefBlocks(v, sections);
  }
  const parts: SlackMessageParts = { blocks, text: BRIEF_COPY.dmFallbackText };
  assertDmBudget(parts, BRIEF_LIMITS.dmBlocksMax);
  return parts;
}

// --- the check-ins message ----------------------------------------------------------------------

export interface CheckinMessageView { rows: CheckinView[]; paused: keyof typeof BRIEF_COPY.checkinsPaused | null; tz: string }

type CheckinStatusKey = keyof typeof BRIEF_COPY.checkinStatus;

function statusKeyOf(row: CheckinView): CheckinStatusKey | null {
  switch (row.status) {
    case "expired":
      return row.statusReason === "superseded" ? "replaced" : "expired";
    case "failed":
      return row.statusReason === "recipient_changed" ? "recipient" : "failed";
    case "sending":
    case "sent":
    case "unknown":
      return row.status;
    default:
      return null;
  }
}

/** ≤ 3 rows: a regenerate's superseded rows give way to the current ones (the message is edited in place, C12). */
function rowsShown(rows: readonly CheckinView[]): CheckinView[] {
  const all = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === "string") : [];
  const max = BRIEF_LIMITS.checkinsPerBrief;
  if (all.length <= max) return all;
  const current = all.filter((r) => !(r.status === "expired" && r.statusReason === "superseded"));
  return (current.length > 0 ? current : all).slice(0, max);
}

/** C25 layout 2: ≤ 8 blocks. Buttons only on a proposed row with a value while not paused; the paused note (shown only when a row
 *  is still proposed) replaces every button. */
export function renderCheckinsMessage(v: CheckinMessageView): SlackMessageParts {
  const rows = rowsShown(v.rows);
  const paused = v.paused !== null && Object.prototype.hasOwnProperty.call(BRIEF_COPY.checkinsPaused, v.paused) ? v.paused : null;
  const blocks: SlackBlock[] = [section(`*${escapeMrkdwn(BRIEF_COPY.checkinsTitle)}*\n${escapeMrkdwn(BRIEF_COPY.checkinsIntro)}`)];
  if (paused !== null && rows.some((r) => r.status === "proposed")) blocks.push(section(escapeMrkdwn(BRIEF_COPY.checkinsPaused[paused])));
  rows.forEach((row, i) => {
    const name = shortLabel(row.firstName, NAME_MAX) || "—";
    const note = safeMrkdwn(typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "");
    // The note on its own line, without Slack's ">" quote marker: P6's rule 4 allows a raw ">" only inside an allow-listed link.
    blocks.push(section(`*${escapeMrkdwn(fillBrief(BRIEF_COPY.checkinTo, { name }))}*\n${note.length > 0 ? note : "—"}`));
    if (row.status === "proposed") {
      if (paused === null && typeof row.value === "string" && row.value.length > 0 && row.value.length <= SLACK_LIMITS.actionValueChars) {
        const send: SlackButton = {
          type: "button", action_id: "ea_ci_send", style: "primary", value: row.value,
          text: plain(clip(sanitizeChars(fillBrief(BRIEF_COPY.checkinSend, { name })), BUTTON_TEXT_MAX))
        };
        const rewrite: SlackButton = { type: "button", action_id: "ea_ci_rewrite", value: row.value, text: plain(BRIEF_COPY.checkinRewrite) };
        blocks.push({ type: "actions", block_id: `ea_ci_${i + 1}`, elements: [send, rewrite] });
      } else if (paused === null) {
        // A proposed row whose button couldn't be made (its MAC key unavailable): no button, the try-again note.
        blocks.push(context([escapeMrkdwn(BRIEF_COPY.checkinsPaused.busy)]));
      }
      return;
    }
    const key = statusKeyOf(row);
    if (key === null) return;
    const time = timeIn(row.sentAt, v.tz);
    const line = fillBrief(BRIEF_COPY.checkinStatus[key], { name, time: time.length > 0 ? time : "—" });
    blocks.push(context([escapeMrkdwn(line)]));
  });
  blocks.push(context([escapeMrkdwn(BRIEF_COPY.checkinsFooter)]));
  const parts: SlackMessageParts = { blocks, text: BRIEF_COPY.checkinsFallbackText };
  assertDmBudget(parts, BRIEF_LIMITS.checkinsMessageBlocksMax);
  return parts;
}

// --- one-liners ----------------------------------------------------------------------------------

function noteWithLink(copy: string, briefHref: string): SlackMessageParts {
  return { blocks: [section(`${escapeMrkdwn(copy)}${linkAfter(briefHref, BRIEF_COPY.dmOpenFull)}`)], text: BRIEF_COPY.dmFallbackText };
}

/** C34: after a watchdog fallback, the full brief stays in DD; this one line says so. */
export function renderLateNote(briefHref: string): SlackMessageParts {
  return noteWithLink(BRIEF_COPY.lateNote, briefHref);
}

/** C15: a delivered DM whose stored content was later scrubbed is replaced by this note (no content). */
export function renderScrubbedNote(briefHref: string): SlackMessageParts {
  return noteWithLink(BRIEF_COPY.dmScrubbedNote, briefHref);
}

// --- the DD bot's watchdog mini-brief (M7) ----------------------------------------------------------

export interface FallbackMiniBrief {
  prettyDate: string;
  bands: { critical: number; high: number; normal: number } | null;
  ddTitles: { title: string; href: string | null }[];       // ≤ 5, source "dd" only
  email: number | null; slack: number | null; approvals: number | null; restrictedEmail: number | null;
  execHref: string;                                         // appOrigin() + "/executive"
  /** P8 fixer ui-1 (M4, never "nothing"): email or Slack simply off or not set up → its BRIEF_COPY.state line in place of a count. */
  emailNote?: BriefStateNote | null; slackNote?: BriefStateNote | null;
}

/** "Email: {n} items need you." → the count, or "Email: Couldn't load this." when the count couldn't be read. */
function countLine(template: string, n: number | null): string {
  if (typeof n === "number" && Number.isFinite(n)) return fillBrief(template, { n: Math.max(0, Math.floor(n)) });
  const colon = template.indexOf(":");
  return colon > 0 ? `${template.slice(0, colon)}: ${BRIEF_COPY.fallbackUnavailable}` : BRIEF_COPY.fallbackUnavailable;
}

/** C25 layout 4. Counts by band, the top DD-sourced titles, email / Slack / approvals as counts only, the restricted count; no
 *  email or Slack titles and no buttons (M7). */
export function renderFallbackMiniBrief(m: FallbackMiniBrief): SlackMessageParts {
  const blocks: SlackBlock[] = [header(fillBrief(BRIEF_COPY.fallbackHeader, { date: m.prettyDate })), section(escapeMrkdwn(BRIEF_COPY.fallbackIntro))];
  blocks.push(section(escapeMrkdwn(m.bands !== null
    ? fillBrief(BRIEF_COPY.fallbackBands, { critical: count(m.bands.critical), high: count(m.bands.high), normal: count(m.bands.normal) })
    : BRIEF_COPY.fallbackUnavailable)));
  const titles = (Array.isArray(m.ddTitles) ? m.ddTitles : []).slice(0, 5);
  if (titles.length > 0) {
    const lines = titles.map((t) => `• ${safeMrkdwn(t.title)}${linkAfter(t.href, "Open")}`);
    for (const piece of chunkMrkdwn(`*${escapeMrkdwn(BRIEF_COPY.fallbackDdTitle)}*\n${lines.join("\n")}`)) blocks.push(section(piece));
  }
  const stateOr = (note: BriefStateNote | null | undefined, template: string, n: number | null) =>
    note != null && typeof BRIEF_COPY.state[note] === "string" ? BRIEF_COPY.state[note] : countLine(template, n);
  const countLines = [
    stateOr(m.emailNote, BRIEF_COPY.fallbackEmail, m.email), stateOr(m.slackNote, BRIEF_COPY.fallbackSlack, m.slack),
    countLine(BRIEF_COPY.fallbackApprovals, m.approvals)
  ].map(escapeMrkdwn);
  const restricted = m.restrictedEmail ?? 0;
  if (restricted > 0) countLines.push(escapeMrkdwn(restricted === 1 ? BRIEF_COPY.restrictedOne : fillBrief(BRIEF_COPY.restricted, { n: restricted })));
  blocks.push(section(countLines.join("\n")));
  blocks.push(context([slackLink(m.execHref, BRIEF_COPY.fallbackOpen) ?? escapeMrkdwn(BRIEF_COPY.fallbackOpen)]));
  const parts: SlackMessageParts = { blocks, text: BRIEF_COPY.fallbackText };
  assertDmBudget(parts, BRIEF_LIMITS.dmBlocksMax);
  return parts;
}

// --- the new-network alert (M13) ----------------------------------------------------------------------

export function renderNetworkAlertDm(v: { net: string; family: string; at: string; tz: string }): SlackMessageParts {
  const time = formatInZone(v?.at ?? null, v?.tz ?? "UTC", "datetime");
  const line = fillBrief(BRIEF_COPY.networkDm, { net: shortLabel(v?.net, LABEL_MAX) || "—", family: shortLabel(v?.family, LABEL_MAX) || "—", time });
  return { blocks: [section(escapeMrkdwn(line))], text: BRIEF_COPY.networkFallbackText };
}

/** Mitchell's own message: one section of escapeMrkdwn(sanitizeChars(text)); text = the same escaped string (his note is the notification). */
export function renderCheckinPost(text: string): SlackMessageParts {
  const escaped = escapeMrkdwn(sanitizeChars(typeof text === "string" ? text : ""));
  return { blocks: [section(escaped)], text: escaped };
}

// --- the budget ---------------------------------------------------------------------------------------

/** ≤ 45 blocks (brief), ≤ 8 (check-ins), every section ≤ 3,000, every button value ≤ 200 and text ≤ 75; throws otherwise. */
export function assertDmBudget(parts: SlackMessageParts, max: number): void {
  const fail = (what: string): never => {
    throw new Error(`dm_over_budget: ${what}`);
  };
  if (!parts || !Array.isArray(parts.blocks)) fail("no blocks");
  if (!Number.isInteger(max) || max < 1 || max > SLACK_LIMITS.blocksPerMessage) fail("bad maximum");
  if (parts.blocks.length > max) fail(`${parts.blocks.length} blocks > ${max}`);
  if (typeof parts.text !== "string" || parts.text.length === 0) fail("no fallback text");
  parts.blocks.forEach((b, i) => {
    if (b.type === "section" && b.text.text.length > SLACK_LIMITS.sectionChars) fail(`section ${i} over ${SLACK_LIMITS.sectionChars}`);
    if (b.type === "header" && b.text.text.length > HEADER_MAX) fail(`header ${i} over ${HEADER_MAX}`);
    if (b.type === "context" && b.elements.length > SLACK_LIMITS.contextElements) fail(`context ${i} too many elements`);
    if (b.type === "context" && b.elements.some((e) => e.text.length > SLACK_LIMITS.sectionChars)) fail(`context ${i} over ${SLACK_LIMITS.sectionChars}`);
    if (b.type === "actions") {
      for (const el of b.elements) {
        if (typeof el.value === "string" && el.value.length > SLACK_LIMITS.actionValueChars) fail(`button value ${i}`);
        if (el.text.text.length > BUTTON_TEXT_MAX) fail(`button text ${i}`);
      }
    }
  });
}
