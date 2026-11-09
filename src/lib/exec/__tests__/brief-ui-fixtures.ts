import { BRIEF_SECTION_KEYS, type BriefContent, type BriefItem, type BriefRow, type BriefSectionContent, type BriefSectionKey, type CheckinRow } from "@/lib/exec/brief-types";
import type { BriefCardView, BriefContentView, BriefPageView, BriefPillView } from "@/lib/exec/brief-view";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSettings, SourceRef } from "@/lib/exec/types";
import { BRIEF_TEXT_SENTINELS } from "./brief-assert";

// P8 Area E test fixtures (contract §5.16): a principal in America/New_York, his settings with the brief on, today's
// exec_briefs row (BriefRow and the snake_case database row), a content with one line per kind of source (email, Slack,
// DD) carrying the shared sentinels, check-in rows and the page / card views the components render. The clock: Monday
// 2026-11-09, 9:00 AM EST (14:00Z); the brief time 08:00 (13:00Z); the catch-up cutoff 12:00 EST (17:00Z).

export const NOW = new Date("2026-11-09T14:00:00.000Z");
export const NOW_ISO = NOW.toISOString();
export const TZ = "America/New_York";
export const TODAY = "2026-11-09";
export const YESTERDAY = "2026-11-08";
export const SCHEDULED_AT = "2026-11-09T13:00:00.000Z";
export const BRIEF_ID = `eb_${"a".repeat(32)}`;
export const DD_TASK_URL = "https://operations.scaledai.org/tasks/t_42";
export const SLACK_URL = "https://acme.slack.com/archives/C0ACMESEO/p1762693200000100";
export const OUTLOOK_URL = "https://outlook.office.com/mail/inbox/id/AAMkAGI2";

export function mintPrincipal(tz: string = TZ): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

export const principal = mintPrincipal();

export function briefSettings(over: Partial<ExecSettings> = {}): ExecSettings {
  return {
    principalId: principal.id,
    ...DEFAULT_SETTINGS,
    emailSchemaReady: true,
    draftsSchemaReady: true,
    ddtextSchemaReady: true,
    chatSchemaReady: true,
    slackReadingSchemaReady: true,
    briefEnabled: true,
    briefLocalTime: "08:00",
    briefTimezone: null,
    supersedeLegacyBrief: false,
    checkinsEnabled: true,
    ...over
  } as ExecSettings;
}

const ddRef = (label: string, url: string | null = DD_TASK_URL): SourceRef => ({ system: "dd", label, url, class: "internal" } as SourceRef);
const slackRef = (label: string): SourceRef => ({ system: "slack", label, url: SLACK_URL, class: "internal" } as SourceRef);
const mailRef = (label: string): SourceRef => ({ system: "outlook", label, url: OUTLOOK_URL, class: "internal" } as SourceRef);

export function item(id: string, over: Partial<BriefItem> = {}): BriefItem {
  return {
    id, text: `Line ${id}`, kind: "fact", basis: "derived", band: "normal", aliases: ["i1"], fps: [`dd:${id}`], refs: [ddRef("Task t_42")],
    threadIds: [], slackKeys: [], slackChannels: [], ...over
  };
}

function section(key: BriefSectionKey, over: Partial<BriefSectionContent> = {}): BriefSectionContent {
  return { key, state: "ok", stateNote: null, items: [], pending: [], unchanged: 0, more: 0, stats: {}, ...over };
}

/** One line per source: an email-derived line (thread t_mail), a Slack line (C0ACMESEO), DD lines, a recommendation, a
 *  pending line, an unavailable section and an off one. Sentinels sit in the lines (the page shows them; logs never may). */
export function content(over: Partial<BriefContent> = {}): BriefContent {
  const sections = BRIEF_SECTION_KEYS.map((key) => {
    switch (key) {
      case "emails":
        return section(key, {
          items: [item("b1", { text: `Reply to Acme: ${BRIEF_TEXT_SENTINELS.emailSubject}`, basis: "ai", band: "high", refs: [mailRef("Acme renewal")], threadIds: ["t_mail"] })],
          stats: { reply: 4, urgent: 1, important: 3, waiting: 2, decisionAsks: 0, more: 2 },
          more: 2
        });
      case "slack":
        return section(key, {
          items: [item("b2", { text: "Acme asked about the launch in #acme-seo", basis: "ai", refs: [slackRef("#acme-seo")], slackKeys: ["m:C0ACMESEO:1762693200.000100"], slackChannels: ["C0ACMESEO"] })],
          stats: { requests: 2, decisions: 1, commitments: 1, notAssessed: 0 }
        });
      case "work":
        return section(key, {
          items: [
            item("b3", { text: `${BRIEF_TEXT_SENTINELS.briefLine} three tasks closed yesterday`, basis: "record" }),
            item("b4", { text: "Ask Dana to move the Acme audit up", kind: "recommendation", basis: "ai", band: "critical" })
          ],
          pending: [{ fp: "dd:pending:1", title: "Approve the Q4 plan", band: "high", since: "2026-11-05T15:00:00.000Z", refs: [], threadIds: [], slackKeys: [], slackChannels: [] }],
          unchanged: 3,
          stats: { completedYesterday: 3, openOverdue: 5 }
        });
      case "blockers":
        return section(key, { state: "off", stateNote: "ddtext_off" });
      case "delayed":
        return section(key, { state: "unavailable", stateNote: "unavailable" });
      default:
        return section(key);
    }
  });
  return {
    v: 1, localDate: TODAY, tz: TZ, rev: 1, builtAt: "2026-11-09T13:01:00.000Z", trigger: "schedule", mode: "ai", modeReason: null, top3Fallback: false,
    headline: `Acme renewal is the morning's one decision ${BRIEF_TEXT_SENTINELS.briefLine}`,
    sections,
    top3: [
      { itemId: "b1", alias: "i1", fp: "email:thread:t_mail:a", title: "Answer Acme", next: "Reply today", refs: [mailRef("Acme renewal")], threadIds: ["t_mail"], slackKeys: [], slackChannels: [] },
      { itemId: "b4", alias: "i2", fp: "dd:task:t_42", title: "Move the Acme audit", next: null, refs: [ddRef("Task t_42")], threadIds: [], slackKeys: [], slackChannels: [] },
      { itemId: "b2", alias: "i3", fp: "slack:m:C0ACMESEO", title: "Answer the launch question", next: null, refs: [slackRef("#acme-seo")], threadIds: [], slackKeys: ["m:C0ACMESEO:1762693200.000100"], slackChannels: ["C0ACMESEO"] }
    ],
    novelty: {},
    counts: { new: 3, changed: 0, escalated: 0, pending: 1, unchanged: 3, restrictedEmail: 2, slackUnanswered: 3 },
    failures: [],
    ...over
  };
}

export function briefRow(over: Partial<BriefRow> = {}): BriefRow {
  return {
    id: BRIEF_ID, principalId: principal.id, localDate: TODAY, tz: TZ, scheduledAt: SCHEDULED_AT, rev: 1,
    status: "delivered", statusReason: null, owner: "exec", ownerReason: "owns", mode: "ai", modeReason: null, content: content(),
    buildStartedAt: "2026-11-09T13:00:05.000Z", builtAt: "2026-11-09T13:01:00.000Z", regenLockUntil: null, regenSeq: 0, noveltyMarkedAt: "2026-11-09T13:01:00.000Z",
    deliveryStartedAt: "2026-11-09T13:01:05.000Z", postAttempts: 1, deliveredAt: "2026-11-09T13:02:00.000Z", slackChannelId: "D0OWNER", slackTs: "1762693320.000100",
    checkinsTs: "1762693321.000100", lateNoteTs: null, fallbackSentAt: null, fallbackSlackTs: null, fallbackChannelId: null, fallbackDeleteAfter: null,
    fallbackDeletedAt: null, fallbackErrorCode: null, scrubbedAt: null, dmFollowedAt: null, errorCode: null,
    contentExpiresAt: "2026-12-10T05:00:00.000Z", contentPurgedAt: null, expiresAt: "2027-05-09T04:00:00.000Z",
    createdAt: "2026-11-09T13:00:05.000Z", updatedAt: "2026-11-09T13:02:00.000Z",
    ...over
  };
}

/** The same row as exec_briefs stores it (snake_case), for the fake brief database. */
export function briefDbRow(over: Partial<BriefRow> = {}): Record<string, unknown> {
  const r = briefRow(over);
  return {
    id: r.id, principal_id: r.principalId, local_date: r.localDate, tz: r.tz, scheduled_at: r.scheduledAt, rev: r.rev, status: r.status,
    status_reason: r.statusReason, owner: r.owner, owner_reason: r.ownerReason, mode: r.mode, mode_reason: r.modeReason, content: r.content,
    build_started_at: r.buildStartedAt, built_at: r.builtAt, regen_lock_until: r.regenLockUntil, regen_seq: r.regenSeq, novelty_marked_at: r.noveltyMarkedAt,
    delivery_started_at: r.deliveryStartedAt, post_attempts: r.postAttempts, delivered_at: r.deliveredAt, slack_channel_id: r.slackChannelId,
    slack_ts: r.slackTs, checkins_ts: r.checkinsTs, late_note_ts: r.lateNoteTs, fallback_sent_at: r.fallbackSentAt, fallback_slack_ts: r.fallbackSlackTs,
    fallback_channel_id: r.fallbackChannelId, fallback_delete_after: r.fallbackDeleteAfter, fallback_deleted_at: r.fallbackDeletedAt,
    fallback_error_code: r.fallbackErrorCode, scrubbed_at: r.scrubbedAt, dm_followed_at: r.dmFollowedAt, error_code: r.errorCode,
    content_expires_at: r.contentExpiresAt, content_purged_at: r.contentPurgedAt, expires_at: r.expiresAt, created_at: r.createdAt, updated_at: r.updatedAt
  };
}

export function checkinRow(n: number, over: Partial<CheckinRow> = {}): CheckinRow {
  return {
    id: `ebc_${String(n).repeat(32).slice(0, 32)}`, briefId: BRIEF_ID, principalId: principal.id, localDate: TODAY, briefRev: 1, rev: 1,
    recipientUserId: `u_${n}`, recipientSlackId: `U0PERSON${n}`, text: `${BRIEF_TEXT_SENTINELS.checkinText} note ${n}`, status: "proposed",
    statusReason: null, sendingAt: null, sentAt: null, slackChannelId: null, slackTs: null, auditId: null,
    expiresAt: "2026-11-11T13:01:00.000Z", purgeAt: "2026-12-09T13:01:00.000Z", createdAt: "2026-11-09T13:01:00.000Z", updatedAt: "2026-11-09T13:01:00.000Z",
    ...over
  };
}

export const pill = (over: Partial<BriefPillView> = {}): BriefPillView => ({ state: "delivered", label: "Brief 8:02 AM EST · live", ...over });

export function contentView(over: Partial<BriefContentView> = {}): BriefContentView {
  return {
    headline: "Acme renewal is the morning's one decision", modeLine: "AI summary",
    top3: [
      { title: "Answer Acme", next: "Reply today", href: OUTLOOK_URL, withheld: false },
      { title: "Move the Acme audit", next: null, href: DD_TASK_URL, withheld: false },
      { title: "[Removed: no longer available in Slack]", next: null, href: null, withheld: true }
    ],
    sections: BRIEF_SECTION_KEYS.map((key) => ({
      key, title: key, stateLine: null, lines: [], pending: [], unchanged: 0, more: 0, stats: {}
    })),
    restrictedEmail: 2, financeHref: "/finance",
    ...over
  };
}

export function pageView(over: Partial<BriefPageView> = {}): BriefPageView {
  return {
    state: "ready", generatedAt: NOW_ISO, tz: TZ,
    settings: { enabled: true, time: "08:00", tz: TZ, supersede: true, checkinsEnabled: true },
    brief: {
      id: BRIEF_ID, localDate: TODAY, rev: 1, status: "delivered", statusLine: "Sent to you in Slack at 8:02 AM EST.", channel: "exec_bot",
      owner: "exec", mode: "ai", builtAt: "2026-11-09T13:01:00.000Z", deliveredAt: "2026-11-09T13:02:00.000Z", fallbackSentAt: null, content: contentView()
    },
    checkins: [], checkinsPosted: true, canRegenerate: true, expectedRev: 1, dueAt: SCHEDULED_AT,
    ...over
  };
}

export function cardView(over: Partial<BriefCardView> = {}): BriefCardView {
  const v = contentView();
  return { localDate: TODAY, headline: v.headline, top3: v.top3, statusLine: "Sent to you in Slack at 8:02 AM EST.", pill: pill(), ...over };
}
