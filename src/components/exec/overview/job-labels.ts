import type { JobKindHealth } from "@/lib/exec/overview";

// The System card's words for the assistant's background jobs (P9 F26). Plain data and a pure grouping, so the card
// never shows a raw job kind (an id the logs use, not a word for him): every kind runtime.ts registers has a label here
// (ui/overview-view.test.ts checks this map against runtime.ts's BUILT_IN_JOB_KINDS; this file must not import
// runtime.ts, which would pull every server module into the page's bundle). The Slack reading jobs (P7a's reading and
// P7b's digests and links) share one row with the worst status of the group; any kind not listed here (a later
// phase's, before its label lands) reads as "Other background jobs", never as its id.

export const JOB_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "exec.purge": "Retention cleanup",
  "exec.dd-attention": "Needs Attention refresh",
  "exec.email-triage": "Email assessment",
  "exec.email-reconcile": "Mail sync check",
  "exec.email-attention": "Email Needs Attention refresh",
  "exec.draft-generate": "Drafting",
  "exec.draft-reconcile": "Draft checks",
  "exec.voice-refresh": "Voice profile",
  "exec.ddtext-triage": "DD text triage",
  // P6: the Slack app.
  "exec.slack-reply": "Slack replies",
  "exec.slack-action": "Slack button clicks",
  "exec.slack-card": "Slack draft cards",
  "exec.slack-home": "Slack Home tab",
  "exec.slack-uninstall": "Slack disconnect",
  "exec.slack-sweep": "Slack upkeep",
  "exec.slack-dm-purge": "Slack message cleanup",
  // P8: the morning brief and its check-ins.
  "exec.brief": "Morning brief",
  "exec.brief-deliver": "Morning brief delivery",
  "exec.brief-fallback": "Morning brief backup",
  "exec.brief-prep": "Morning brief Slack check",
  "exec.brief-sweep": "Morning brief upkeep",
  "exec.brief-health": "Check-in token check",
  "exec.checkin-send": "Check-in send",
  "exec.checkin-rewrite": "Check-in rewrite",
  "exec.ops-watch": "Job watch",
  "exec.access-alert": "Sign-in alert"
});

/** The Slack reading row's kinds: P7a's reading jobs and P7b's digests and links. */
export const SLACK_READING_JOB_KINDS: ReadonlySet<string> = new Set([
  "exec.slack-discover",
  "exec.slack-classify",
  "exec.slack-read-sweep",
  "exec.slack-probe",
  "exec.slack-triage",
  "exec.slack-attention",
  "exec.slack-rekey",
  "exec.slack-user-check",
  "exec.slack-read-purge",
  "exec.slack-read-recheck",
  "exec.slack-correlate",
  "exec.slack-digest",
  "exec.slack-digest-plan",
  "exec.slack-intel-sweep"
]);

export const SLACK_READING_JOBS_LABEL = "Slack reading jobs";
export const OTHER_JOBS_LABEL = "Other background jobs";

/** A kind's words: its own label, the Slack reading group's, or the generic one. Never the kind itself. */
export function jobLabel(kind: string): string {
  if (Object.prototype.hasOwnProperty.call(JOB_LABELS, kind)) return JOB_LABELS[kind];
  return SLACK_READING_JOB_KINDS.has(kind) ? SLACK_READING_JOBS_LABEL : OTHER_JOBS_LABEL;
}

export interface SystemJobRow {
  /** A React key: the kind, or the group's name. */
  key: string;
  label: string;
  /** The group's worst: null when any member had no success in the look-back, else the oldest member's last success. */
  lastSuccessAt: string | null;
  /** The group's runs that died in the last 24 hours, summed. */
  dead24h: number;
}

/**
 * The card's rows, in the order the overview lists the kinds: a labelled kind is its own row; the Slack reading kinds
 * and the unlabelled kinds each fold into one row (where the group's first member stood) with the worst status.
 */
export function systemJobRows(kinds: readonly JobKindHealth[]): SystemJobRow[] {
  const rows: SystemJobRow[] = [];
  const groups = new Map<string, SystemJobRow>();
  for (const job of kinds) {
    const label = jobLabel(job.kind);
    const grouped = label === SLACK_READING_JOBS_LABEL || label === OTHER_JOBS_LABEL;
    const dead = Number.isFinite(job.dead24h) && job.dead24h > 0 ? job.dead24h : 0;
    if (!grouped) {
      rows.push({ key: job.kind, label, lastSuccessAt: job.lastSuccessAt, dead24h: dead });
      continue;
    }
    const group = groups.get(label);
    if (group === undefined) {
      const row: SystemJobRow = { key: `group:${label}`, label, lastSuccessAt: job.lastSuccessAt, dead24h: dead };
      groups.set(label, row);
      rows.push(row);
      continue;
    }
    group.dead24h += dead;
    if (group.lastSuccessAt === null || job.lastSuccessAt === null) group.lastSuccessAt = null;
    else if (Date.parse(job.lastSuccessAt) < Date.parse(group.lastSuccessAt)) group.lastSuccessAt = job.lastSuccessAt;
  }
  return rows;
}
