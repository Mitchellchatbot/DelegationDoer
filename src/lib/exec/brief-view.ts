import "server-only";

import type { FactBasis, PriorityBand } from "@/lib/exec/attention-types";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { catchUpCutoff, scheduledInstant } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { screenBriefContent, withholdAllEmail, type BriefScreen, type BriefWithheldReason } from "@/lib/exec/brief-screen";
import { briefSchemaReady, checkinCounts, getBriefByDate, getLatestBrief, listCheckinsForBrief } from "@/lib/exec/brief-store";
import { BRIEF_LIMITS, BRIEF_SECTION_KEYS } from "@/lib/exec/brief-types";
import type {
  BriefChannel,
  BriefContent,
  BriefMode,
  BriefOwner,
  BriefOwnerReason,
  BriefRow,
  BriefSectionKey,
  BriefStatus,
  CheckinRow,
  CheckinStatus
} from "@/lib/exec/brief-types";
import { formatInZone } from "@/lib/exec/format";
import type { OverviewBriefSystem } from "@/lib/exec/overview";
import { loadSettings } from "@/lib/exec/principal";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { OwnerHomeBrief } from "@/lib/exec/slack-ui";
import { listUsers } from "@/lib/exec/sources/dd";
import { addLocalDays, localDateString } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings, SourceRef } from "@/lib/exec/types";

// P8 brief views (contract §3.17.1, M3-M5, M12, C31, C41, C42; Area E; server-only): the page, the Overview card, the header
// pill, the App Home line and the System card row. Every stored line goes through brief-screen.ts screenBriefContent at
// render (C31); nothing here persists. No MAC or button value ever leaves it (UI23).
//
// "Today" is the principal's brief-zone day (principal.briefTimezone, M3), the day exec_briefs is keyed on. The page shows
// today's row (or the state that explains its absence); the Overview card shows today's brief, or yesterday's until today's
// brief time (C41). The render-time screen (C31): email-derived lines re-screened against the current rules and thread rows,
// Slack-derived lines withheld unless slackIntelState is "ok"; a withheld line shows its fixed "[Removed: …]" text with no
// link, a withheld top-3 entry and pending line likewise, and the AI headline is hidden whenever anything is withheld (it
// cites no refs, intel-14). A failed screen read withholds every email-derived line (withholdAllEmail) plus the Slack rule.
//
// Logs carry ids and error names only (§0.3 rule 4, B-P8-6).

export type BriefPageState = "not_installed" | "off" | "none" | "building" | "ready" | "failed";

export interface BriefContentView {
  headline: string | null; modeLine: string;
  top3: { title: string; next: string | null; href: string | null; withheld: boolean }[];
  sections: { key: BriefSectionKey; title: string; stateLine: string | null;
    lines: { id: string; text: string; kind: "fact" | "recommendation"; basis: FactBasis; band: PriorityBand;
      refs: { label: string; href: string | null }[]; withheld: BriefWithheldReason | null }[];
    pending: { title: string; withheld: boolean }[]; unchanged: number; more: number; stats: Record<string, number> }[];
  restrictedEmail: number | null; financeHref: "/finance";
}

export interface CheckinPageRow { id: string; firstName: string; text: string; status: CheckinStatus; statusLine: string; sentAt: string | null }

export interface BriefPageView {
  state: BriefPageState; generatedAt: string; tz: string;
  settings: { enabled: boolean; time: string; tz: string; supersede: boolean; checkinsEnabled: boolean };
  brief: { id: string; localDate: string; rev: number; status: BriefStatus; statusLine: string; channel: BriefChannel;
    owner: BriefOwner | null; mode: BriefMode | null; builtAt: string | null; deliveredAt: string | null;
    fallbackSentAt: string | null; content: BriefContentView | null } | null;
  checkins: CheckinPageRow[]; checkinsPosted: boolean;
  canRegenerate: boolean; expectedRev: number | null; dueAt: string | null;
  /** P9 F31 (additive): state "none" more than BRIEF_LATE_AFTER_MS past dueAt (briefIsLate); absent = not late. */
  late?: boolean;
}

export interface BriefPillView { label: string; state: keyof typeof BRIEF_COPY.pillState }

/** P8 fixer ui-6: mode / modeLine label the model-written headline and top 3 on the card (plan §2 rule 6), as on the page. */
export interface BriefCardView {
  localDate: string; headline: string | null; top3: BriefContentView["top3"]; statusLine: string; pill: BriefPillView;
  mode?: BriefMode | null; modeLine?: string;
}

/** Additive (C42): what the header needs on the Overview and the Brief page: the pill, and Regenerate's state for today's row. */
export interface BriefHeaderView { pill: BriefPillView; canRegenerate: boolean; expectedRev: number | null }

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function requirePrincipal(principal: ExecPrincipal, fn: string): void {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) throw new TypeError(`${fn}: an ExecPrincipal is required`);
}

function validNow(now: Date, fn: string): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError(`${fn}: now must be a valid Date`);
  return now;
}

// ---------------------------------------------------------------------------
// Pure pieces (exported for the components' tests and the routes)
// ---------------------------------------------------------------------------

// Some ICU builds put a narrow no-break space (U+202F) or a no-break space (U+00A0) before "AM"/"PM" in formatToParts' literals;
// the pill and the Home line use a plain space.
const ODD_SPACES = new RegExp(`[${String.fromCodePoint(0x202f)}${String.fromCodePoint(0xa0)}]`, "g");

/** An instant's time and zone abbreviation, apart ("8:02 AM", "EST"), in tz; "—" and "" when either can't be read. */
export function briefTimeParts(iso: string | null | undefined, tz: string): { time: string; zone: string } {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return { time: "—", zone: "" };
  const at = new Date(iso);
  const parts = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(at);
  let list: Intl.DateTimeFormatPart[];
  try {
    list = parts(tz);
  } catch {
    list = parts("America/New_York");
  }
  const time = list.filter((p) => p.type !== "timeZoneName").map((p) => p.value).join("").replace(ODD_SPACES, " ").trim();
  return { time: time.length > 0 ? time : "—", zone: list.find((p) => p.type === "timeZoneName")?.value ?? "" };
}

const timeIn = (iso: string | null | undefined, tz: string): string => formatInZone(iso, tz, "time");

/** today's scheduled instant (ISO) for the settings' brief time, or null when it can't be computed. */
function dueAtOf(localDate: string, settings: ExecSettings, tz: string): string | null {
  try {
    return scheduledInstant(localDate, settings.briefLocalTime, tz).toISOString();
  } catch {
    return null;
  }
}

/** §3.17.1 channel: delivered → exec_bot; a backup sent and not delivered → dd_bot_fallback; page_only → page_only;
 *  building / built / failed → none; delivering / delivery_unknown → unknown. */
export function briefChannel(row: Pick<BriefRow, "status" | "fallbackSlackTs" | "fallbackSentAt">): BriefChannel {
  if (row.status === "delivered") return "exec_bot";
  if (row.fallbackSlackTs !== null || row.fallbackSentAt !== null) return "dd_bot_fallback";
  if (row.status === "page_only") return "page_only";
  if (row.status === "delivering" || row.status === "delivery_unknown") return "unknown";
  return "none";
}

const PAGE_ONLY_KEYS: ReadonlySet<string> = new Set(Object.keys(BRIEF_COPY.pageOnlyReason));

/** §3.17.1 statusLine: BRIEF_COPY.status[status] (+ pageOnlyReason[reason] for page_only, + status.fallback when a backup went out). */
export function briefStatusLine(
  row: Pick<BriefRow, "status" | "statusReason" | "deliveredAt" | "fallbackSentAt" | "localDate" | "scheduledAt" | "tz">
    & Partial<Pick<BriefRow, "content" | "deliveryStartedAt">>,
  tz: string
): string {
  const zone = row.tz && row.tz.length > 0 ? row.tz : tz;
  const parts: string[] = [];
  if (row.status === "delivered") parts.push(fillBrief(BRIEF_COPY.status.delivered, { time: timeIn(row.deliveredAt, zone) }));
  else parts.push(BRIEF_COPY.status[row.status]);
  if (regeneratedAfterSend(row)) parts.push(BRIEF_COPY.status.regeneratedAfterSend);
  if (row.status === "page_only" && row.statusReason !== null && PAGE_ONLY_KEYS.has(row.statusReason)) {
    const reason = row.statusReason as keyof typeof BRIEF_COPY.pageOnlyReason;
    let cutoff = "—";
    if (reason === "after_cutoff") {
      try {
        cutoff = timeIn(catchUpCutoff(row.localDate, new Date(row.scheduledAt), zone).toISOString(), zone);
      } catch {
        cutoff = "—";
      }
    }
    parts.push(fillBrief(BRIEF_COPY.pageOnlyReason[reason], { cutoff }));
  }
  if (row.fallbackSentAt !== null) parts.push(fillBrief(BRIEF_COPY.status.fallback, { time: timeIn(row.fallbackSentAt, zone) }));
  return parts.join(" ");
}

/** P8 fixer ui-4: the shown content was built (a regenerate, M3: page-only) after the DM went out, so Slack holds an earlier
 *  version. Keyed on the content's own build time against the send (a regenerate made before a same-day send was sent as is). */
function regeneratedAfterSend(row: Partial<Pick<BriefRow, "status" | "content" | "deliveredAt" | "deliveryStartedAt">>): boolean {
  const sentAt = row.status === "delivered" ? row.deliveredAt : row.status === "delivery_unknown" ? row.deliveryStartedAt : null;
  const builtAt = row.content?.builtAt;
  if (typeof sentAt !== "string" || typeof builtAt !== "string") return false;
  const sent = Date.parse(sentAt);
  const built = Date.parse(builtAt);
  return Number.isFinite(sent) && Number.isFinite(built) && built > sent;
}

/** §3.17.1 / C48 (UI29): Regenerate is offered for a built-or-later row (or a failed one) while the brief is on, never while a
 *  build or a send is running, a fresh "built" row only once the backup went out or it is 10 minutes old (the RPC's own rule),
 *  never under a live regenerate lock. */
export function canRegenerateBrief(
  row: Pick<BriefRow, "status" | "fallbackSentAt" | "builtAt" | "regenLockUntil">,
  settings: Pick<ExecSettings, "briefEnabled">,
  now: Date
): boolean {
  if (settings.briefEnabled !== true) return false;
  if (row.status === "building" || row.status === "delivering") return false;
  const nowMs = now.getTime();
  if (row.status === "built" && row.fallbackSentAt === null) {
    const built = row.builtAt === null ? Number.NaN : Date.parse(row.builtAt);
    if (!Number.isFinite(built) || nowMs - built < BRIEF_LIMITS.staleBuiltMs) return false;
  }
  if (row.regenLockUntil !== null) {
    const lock = Date.parse(row.regenLockUntil);
    if (!Number.isFinite(lock) || lock > nowMs) return false;
  }
  return true;
}

function linkOf(ref: SourceRef): string | null {
  return typeof ref?.url === "string" && isAllowedLinkUrl(ref.url) ? ref.url : null;
}

function refViews(refs: readonly SourceRef[] | undefined): { label: string; href: string | null }[] {
  return (Array.isArray(refs) ? refs : [])
    .filter((r) => r && typeof r.label === "string")
    .slice(0, BRIEF_LIMITS.itemRefsMax)
    .map((r) => ({ label: r.label, href: linkOf(r) }));
}

// P9 seed S2: "unavailable" reads BRIEF_COPY.removedUnavailable (no producer until Area C's F7/F11 screen).
const removedText = (why: BriefWithheldReason): string =>
  why === "slack" ? BRIEF_COPY.removedSlack : why === "unavailable" ? BRIEF_COPY.removedUnavailable : BRIEF_COPY.removedRestricted;

/** A withheld entry with no reason of its own: Slack-only refs read as Slack, anything else as restricted mail (fail closed). */
function reasonOf(x: { threadIds?: readonly string[]; slackChannels?: readonly string[] }): "restricted" | "slack" {
  const threads = Array.isArray(x.threadIds) ? x.threadIds.length : 0;
  const channels = Array.isArray(x.slackChannels) ? x.slackChannels.length : 0;
  return threads === 0 && channels > 0 ? "slack" : "restricted";
}

const STAT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * The content as the page and the card show it, under one screen (C31). Pure. A line the screen withholds shows its fixed
 * "[Removed: …]" text with no refs; a line a scrub already rewrote (scrubbed) shows the text the scrub stored, with no refs.
 * Sections come in BRIEF_SECTION_KEYS order; a section the content lacks is left out. stats keeps the named counters (never
 * the gather's dropped count, which `more` carries).
 */
export function briefContentView(content: BriefContent, screen: BriefScreen): BriefContentView {
  const reasonKey = content.mode === "deterministic" && content.modeReason !== null && content.modeReason in BRIEF_COPY.modeReason ? content.modeReason : "model_error";
  const modeLine = content.mode === "ai" ? BRIEF_COPY.modeAi : fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason[reasonKey] });
  const itemReason = new Map<string, BriefWithheldReason>();
  const sections: BriefContentView["sections"] = [];
  const byKey = new Map((Array.isArray(content.sections) ? content.sections : []).map((s) => [s.key, s]));
  for (const key of BRIEF_SECTION_KEYS) {
    const s = byKey.get(key);
    if (!s) continue;
    const lines = (Array.isArray(s.items) ? s.items : []).map((item) => {
      const screened = screen.items.get(item.id) ?? null;
      const scrubbed = item.scrubbed === true ? (item.text === BRIEF_COPY.removedSlack ? "slack" : "restricted") : null;
      const withheld = screened ?? scrubbed;
      if (withheld !== null) itemReason.set(item.id, withheld);
      return {
        id: item.id,
        text: screened !== null ? removedText(screened) : scrubbed !== null ? removedText(scrubbed) : item.text,
        kind: item.kind === "recommendation" ? ("recommendation" as const) : ("fact" as const),
        basis: item.basis,
        band: item.band,
        refs: withheld !== null ? [] : refViews(item.refs),
        withheld
      };
    });
    const pending = (Array.isArray(s.pending) ? s.pending : []).map((p) => {
      const withheld = screen.pending.has(p.fp);
      return { title: withheld ? removedText(reasonOf(p)) : p.title, withheld };
    });
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.stats ?? {})) if (k !== "more" && STAT_KEY.test(k) && typeof v === "number" && Number.isFinite(v)) stats[k] = v;
    const unchanged = Number.isSafeInteger(s.unchanged) && s.unchanged > 0 ? s.unchanged : 0;
    const more = Number.isSafeInteger(s.more) && s.more > 0 ? s.more : 0;
    let stateLine: string | null = null;
    if (s.stateNote !== null && s.stateNote in BRIEF_COPY.state) stateLine = BRIEF_COPY.state[s.stateNote];
    else if (s.state !== "ok") stateLine = BRIEF_COPY.state.unavailable;
    else if (lines.length === 0 && pending.length === 0) stateLine = BRIEF_COPY.nothingNew;
    sections.push({ key, title: BRIEF_COPY.sectionTitle[key], stateLine, lines, pending, unchanged, more, stats });
  }
  const top3 = (Array.isArray(content.top3) ? content.top3 : []).slice(0, BRIEF_LIMITS.top3).map((t) => {
    const withheld = screen.top3.has(t.alias) || (t.itemId !== null && itemReason.has(t.itemId));
    if (withheld) {
      const why = t.itemId !== null ? (itemReason.get(t.itemId) ?? reasonOf(t)) : reasonOf(t);
      return { title: removedText(why), next: null, href: null, withheld: true };
    }
    const href = (Array.isArray(t.refs) ? t.refs : []).map(linkOf).find((h): h is string => h !== null) ?? null;
    return { title: t.title, next: t.next ?? null, href, withheld: false };
  });
  const restricted = content.counts?.restrictedEmail;
  return {
    headline: screen.hideHeadline || content.headlineScrubbed === true || typeof content.headline !== "string" ? null : content.headline,
    modeLine,
    top3,
    sections,
    restrictedEmail: typeof restricted === "number" && Number.isFinite(restricted) ? restricted : null,
    financeHref: "/finance"
  };
}

type CheckinStatusKey = keyof typeof BRIEF_COPY.checkinStatus;

/** A check-in row's line on the page (the Slack message's words): none while proposed (the page note says where to send it). */
export function checkinStatusLine(row: Pick<CheckinRow, "status" | "statusReason" | "sentAt">, firstName: string, tz: string): string {
  let key: CheckinStatusKey | null;
  switch (row.status) {
    case "expired":
      key = row.statusReason === "superseded" ? "replaced" : "expired";
      break;
    case "failed":
      key = row.statusReason === "recipient_changed" ? "recipient" : "failed";
      break;
    case "sending":
    case "sent":
    case "unknown":
      key = row.status;
      break;
    default:
      key = null;
  }
  if (key === null) return "";
  return fillBrief(BRIEF_COPY.checkinStatus[key], { name: firstName.length > 0 ? firstName : "—", time: timeIn(row.sentAt, tz) });
}

/** P9 F31: today's brief that hasn't started this long after its time is late (the page, the pill, the System row). */
export const BRIEF_LATE_AFTER_MS = 45 * 60_000;

/** P9 F31: true when `now` is more than BRIEF_LATE_AFTER_MS past `dueAt`; false when either can't be read. */
export function briefIsLate(dueAt: string | null | undefined, now: Date | string): boolean {
  const due = typeof dueAt === "string" ? Date.parse(dueAt) : Number.NaN;
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(due) && Number.isFinite(at) && at - due > BRIEF_LATE_AFTER_MS;
}

/**
 * P9 F31 (pure): today's pill. Not installed, off, then no row: "late" once briefIsLate, else "none"; a row: its status
 * (delivered shows the send time, the rest the scheduled time).
 */
export function briefTodayPill(input: {
  installed: boolean; enabled: boolean; row: Pick<BriefRow, "status" | "deliveredAt" | "scheduledAt" | "tz"> | null;
  dueAt: string | null; tz: string; now: Date;
}): BriefPillView {
  const { row, dueAt, tz } = input;
  if (!input.installed) return briefPillOf("not_installed", dueAt, tz);
  if (!input.enabled) return briefPillOf("off", dueAt, tz);
  if (row === null) return briefPillOf(briefIsLate(dueAt, input.now) ? "late" : "none", dueAt, tz);
  const zone = row.tz.length > 0 ? row.tz : tz;
  return row.status === "delivered" ? briefPillOf("delivered", row.deliveredAt, zone) : briefPillOf(row.status, row.scheduledAt, zone);
}

/** The pill (C42): "Brief {time} {tz} · {state}"; the time is the send time once delivered, else the day's brief time. */
export function briefPillOf(state: keyof typeof BRIEF_COPY.pillState, timeIso: string | null, tz: string): BriefPillView {
  const { time, zone } = briefTimeParts(timeIso, tz);
  return { state, label: fillBrief(BRIEF_COPY.pill, { time, tz: zone, state: BRIEF_COPY.pillState[state] }).replace(/\s{2,}/g, " ") };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface Today { tz: string; localDate: string; dueAt: string | null }

function todayOf(principal: ExecPrincipal, settings: ExecSettings, now: Date): Today {
  const tz = principal.briefTimezone;
  const localDate = localDateString(now, tz);
  return { tz, localDate, dueAt: dueAtOf(localDate, settings, tz) };
}

/** C31: one screen over the content; a failed screen read → withholdAllEmail plus the Slack rule (slackIntelState never throws).
 *  Exported (additive) for the dry run, which screens its unpersisted content exactly as the page does (UI12). */
export async function screenedContent(principal: ExecPrincipal, settings: ExecSettings, content: BriefContent, now: Date): Promise<BriefContentView> {
  const r = await screenBriefContent(principal, settings, content, { now });
  if (r.ok) return briefContentView(content, r.screen);
  console.warn(`[exec-brief] principal ${principal.id} screen_unavailable at render`);
  const slackOk = (await slackIntelState(principal, settings)) === "ok";
  return briefContentView(content, withholdAllEmail(content, slackOk));
}

const firstWord = (v: unknown): string => (typeof v === "string" ? (v.trim().split(/\s+/)[0] ?? "").slice(0, 40) : "");

/** The brief's check-ins as the page lists them: a regenerate's superseded rows give way to the current ones (≤ 3, as the
 *  Slack message shows them). Fails soft: a failed read lists none, a failed name read shows "—" (both logged by id). */
async function pageCheckins(principal: ExecPrincipal, row: BriefRow, tz: string): Promise<CheckinPageRow[]> {
  let rows: CheckinRow[];
  try {
    rows = await listCheckinsForBrief(principal, row.id);
  } catch (err) {
    console.warn(`[exec-brief] brief ${row.id} checkins_unavailable (${errName(err)})`);
    return [];
  }
  if (rows.length === 0) return [];
  const max = BRIEF_LIMITS.checkinsPerBrief;
  const current = rows.filter((r) => !(r.status === "expired" && r.statusReason === "superseded"));
  const shown = rows.length <= max ? rows : (current.length > 0 ? current : rows).slice(0, max);
  const names = new Map<string, string>();
  try {
    for (const u of await listUsers(principal)) names.set(u.id, firstWord(u.name));
  } catch (err) {
    console.warn(`[exec-brief] brief ${row.id} checkin_names_unavailable (${errName(err)})`);
  }
  return shown.map((r) => {
    const firstName = names.get(r.recipientUserId) ?? "";
    return { id: r.id, firstName, text: r.text, status: r.status, statusLine: checkinStatusLine(r, firstName, tz), sentAt: r.sentAt };
  });
}

function pillFor(settings: ExecSettings, installed: boolean, row: BriefRow | null, today: Today, now: Date): BriefPillView {
  return briefTodayPill({ installed, enabled: settings.briefEnabled === true, row, dueAt: today.dueAt, tz: today.tz, now });
}

/** C31: email-derived lines re-screened at render; Slack-derived lines withheld unless slackIntelState is ok. Never persists. */
export async function getBriefPageView(principal: ExecPrincipal, now: Date): Promise<BriefPageView> {
  requirePrincipal(principal, "getBriefPageView");
  validNow(now, "getBriefPageView");
  const settings = await loadSettings(principal.id);
  const today = todayOf(principal, settings, now);
  const base: Omit<BriefPageView, "state"> = {
    generatedAt: now.toISOString(),
    tz: today.tz,
    settings: { enabled: settings.briefEnabled === true, time: settings.briefLocalTime, tz: today.tz, supersede: settings.supersedeLegacyBrief === true, checkinsEnabled: settings.checkinsEnabled === true },
    brief: null,
    checkins: [],
    checkinsPosted: false,
    canRegenerate: false,
    expectedRev: null,
    dueAt: today.dueAt
  };
  if (!(await briefSchemaReady())) return { ...base, state: "not_installed" };
  const row = await getBriefByDate(principal, today.localDate);
  if (row === null) {
    if (settings.briefEnabled !== true) return { ...base, state: "off" };
    // P9 F31: past its time by more than 45 minutes and not started: the page says so (in amber).
    return briefIsLate(today.dueAt, now) ? { ...base, state: "none", late: true } : { ...base, state: "none" };
  }
  const state: BriefPageState = row.status === "building" ? "building" : row.status === "failed" ? "failed" : "ready";
  const content = row.content !== null && row.status !== "building" ? await screenedContent(principal, settings, row.content, now) : null;
  const checkins = await pageCheckins(principal, row, today.tz);
  return {
    ...base,
    state,
    brief: {
      id: row.id, localDate: row.localDate, rev: row.rev, status: row.status, statusLine: briefStatusLine(row, today.tz),
      channel: briefChannel(row), owner: row.owner, mode: row.mode, builtAt: row.builtAt, deliveredAt: row.deliveredAt,
      fallbackSentAt: row.fallbackSentAt, content
    },
    checkins,
    checkinsPosted: row.checkinsTs !== null,
    canRegenerate: (state === "ready" || state === "failed") && canRegenerateBrief(row, settings, now),
    expectedRev: row.rev
  };
}

/** C41: today's brief (brief zone), or yesterday's before today's brief time; null otherwise (TodayGlance renders). */
export async function getBriefCardView(principal: ExecPrincipal, now: Date): Promise<BriefCardView | null> {
  requirePrincipal(principal, "getBriefCardView");
  validNow(now, "getBriefCardView");
  const settings = await loadSettings(principal.id);
  if (settings.briefEnabled !== true) return null;
  if (!(await briefSchemaReady())) return null;
  const today = todayOf(principal, settings, now);
  const row = await getLatestBrief(principal, today.localDate);
  if (row === null || row.content === null || row.status === "building") return null;
  const isToday = row.localDate === today.localDate;
  const beforeBriefTime = today.dueAt !== null && now.getTime() < Date.parse(today.dueAt);
  if (!isToday && !(row.localDate === addLocalDays(today.localDate, -1) && beforeBriefTime)) return null;
  const view = await screenedContent(principal, settings, row.content, now);
  return {
    localDate: row.localDate,
    headline: view.headline,
    top3: view.top3,
    statusLine: briefStatusLine(row, today.tz),
    pill: pillFor(settings, true, isToday ? row : null, today, now),
    mode: row.mode,
    modeLine: view.modeLine
  };
}

/** C42 (additive): the header's pill and Regenerate's state for today's row, from one schema probe and one row read. */
export async function getBriefHeaderView(principal: ExecPrincipal, settings: ExecSettings, now: Date): Promise<BriefHeaderView> {
  requirePrincipal(principal, "getBriefHeaderView");
  validNow(now, "getBriefHeaderView");
  const today = todayOf(principal, settings, now);
  if (!(await briefSchemaReady())) return { pill: pillFor(settings, false, null, today, now), canRegenerate: false, expectedRev: null };
  const row = await getBriefByDate(principal, today.localDate);
  return {
    pill: pillFor(settings, true, row, today, now),
    canRegenerate: row !== null && row.status !== "building" && canRegenerateBrief(row, settings, now),
    expectedRev: row?.rev ?? null
  };
}

export async function getBriefPill(principal: ExecPrincipal, settings: ExecSettings, now: Date): Promise<BriefPillView> {
  return (await getBriefHeaderView(principal, settings, now)).pill;
}

/** K13 / §3.21.3: the App Home's brief line. building, built and delivering all read "being built" (the Home has no send state). */
export async function getBriefHomeLine(principal: ExecPrincipal, settings: ExecSettings, now: Date): Promise<OwnerHomeBrief> {
  requirePrincipal(principal, "getBriefHomeLine");
  validNow(now, "getBriefHomeLine");
  const today = todayOf(principal, settings, now);
  const due = briefTimeParts(today.dueAt, today.tz);
  const line = (state: OwnerHomeBrief["state"], sentAt: string | null = null): OwnerHomeBrief => ({ state, time: due.time, tz: due.zone, sentAt });
  // P8 fixer ui-9: no "Daily at 8:00 AM" schedule line for a brief that doesn't run (the renderer skips an empty time or zone).
  const noSchedule = (state: "not_installed" | "off"): OwnerHomeBrief => ({ state, time: "", tz: "", sentAt: null });
  if (!(await briefSchemaReady())) return noSchedule("not_installed");
  if (settings.briefEnabled !== true) return noSchedule("off");
  const row = await getBriefByDate(principal, today.localDate);
  if (row === null) return line("none");
  switch (row.status) {
    case "delivered": {
      const sent = briefTimeParts(row.deliveredAt, row.tz.length > 0 ? row.tz : today.tz);
      return line("delivered", sent.zone.length > 0 ? `${sent.time} ${sent.zone}` : sent.time);
    }
    case "page_only":
    case "failed":
    case "delivery_unknown":
      return line(row.status);
    default:
      return line("building");
  }
}

/** M12 (§3.17.6): the System card's "Morning brief" row; null while the brief is off or its tables aren't installed. An ownership
 *  read failure shows the owner as "unknown" (and the DD brief's day as unknown); a failed row or check-in read throws. */
export async function getBriefSystemView(principal: ExecPrincipal, settings: ExecSettings, now: Date): Promise<OverviewBriefSystem | null> {
  requirePrincipal(principal, "getBriefSystemView");
  validNow(now, "getBriefSystemView");
  if (settings.briefEnabled !== true) return null;
  if (!(await briefSchemaReady())) return null;
  const { localDate } = todayOf(principal, settings, now);
  let owner: BriefOwner | "unknown" = "unknown";
  let ownerReason: BriefOwnerReason | null = null;
  let legacyDeliveredToday: boolean | null = null;
  let row: BriefRow | null;
  try {
    const own = await loadBriefOwnership(principal, settings, localDate, now);
    owner = own.verdict.owner;
    ownerReason = own.verdict.reason;
    legacyDeliveredToday = own.facts.legacyDeliveredToday;
    row = own.brief;
  } catch (err) {
    console.warn(`[exec-brief] principal ${principal.id} ownership_unavailable (${errName(err)})`);
    row = await getBriefByDate(principal, localDate);
  }
  const checkins = await checkinCounts(principal, localDate);
  return {
    localDate,
    owner,
    ownerReason,
    status: row?.status ?? "none",
    statusReason: row?.statusReason ?? null,
    channel: row === null ? "none" : briefChannel(row),
    mode: row?.mode ?? null,
    modeReason: row?.modeReason ?? null,
    builtAt: row?.builtAt ?? null,
    deliveredAt: row?.deliveredAt ?? null,
    fallbackSentAt: row?.fallbackSentAt ?? null,
    fallbackErrorCode: row?.fallbackErrorCode ?? null,
    legacyDeliveredToday,
    checkins
  };
}
