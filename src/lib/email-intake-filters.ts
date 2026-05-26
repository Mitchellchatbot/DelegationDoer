// Pre-classifier filters for the email-intake cron. The goal is to drop
// obviously-automated messages (verification codes, security alert
// digests, calendar invites, undelivered-mail bounces, etc.) BEFORE we
// pay Claude to read them and BEFORE they end up as routing-review
// drafts that a human has to manually deny.
//
// This is intentionally narrow: only patterns where a false-positive
// won't hide real work. If a real client email matches one of these
// patterns the user can always re-process it via the manual "Create
// task from this thread" button — which does NOT run these filters.
//
// Used by /api/cron/email-intake only.

// Sender-address patterns. Match case-insensitively against the
// extracted email address (already lowercased by callers, but the
// matchers tolerate either).
const SENDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // no-reply / do-not-reply variants
  { re: /^(no-?reply|donotreply|do-not-reply)@/i, label: "no-reply sender" },
  { re: /^(notifications?|automated|mailer-daemon|postmaster)@/i, label: "automated sender" },
  // WordPress / WP plugin notifications
  { re: /^wordpress@/i, label: "wordpress notifier" },
  { re: /@wordfence\./i, label: "wordfence alert" },
  // Verification / 2FA senders
  { re: /^(verify|verification|otp|auth|2fa)@/i, label: "verification sender" },
  // Common transactional providers
  { re: /^(notification|alerts?)@(google|mail\.google|github|stripe|paypal|venmo)\./i, label: "transactional provider" },
  // Calendar / meeting platforms
  { re: /@(calendar-server|calendly|google-calendar)\./i, label: "calendar notifier" }
];

// Subject patterns. These are intentionally more permissive than the
// sender list because they're checked AFTER the sender list (so a real
// client emailing about "Out of office coverage" wouldn't be filtered
// unless their sender also matches an automated pattern). All lowercased.
const SUBJECT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(verification|verify|confirmation)\s+code\b/i, label: "verification code" },
  { re: /\bone[-\s]?time\s+(code|password|pin|link)\b/i, label: "one-time code" },
  { re: /^your\s+.*\s+code\s+is\b/i, label: "your X code is" },
  { re: /\[wordfence/i, label: "wordfence alert subject" },
  { re: /weekly\s+citation\s+update/i, label: "weekly citation update" },
  { re: /\b(delivery (failed|status notification)|undeliverable|returned mail|mail delivery)\b/i, label: "delivery failure" },
  { re: /\b(out\s+of\s+office|auto[-\s]?reply|automatic reply)\b/i, label: "auto-reply" },
  { re: /\bunsubscribe\s+(success|confirmation)\b/i, label: "unsubscribe confirmation" }
];

export interface FilterResult {
  /** true = drop this thread, don't classify or create a task */
  filtered: boolean;
  /** Human-readable reason, persisted in email_intake_log for audit */
  reason: string | null;
}

export function looksAutomated(
  fromEmail: string | null,
  subject: string | null
): FilterResult {
  const from = (fromEmail ?? "").trim();
  if (from) {
    for (const p of SENDER_PATTERNS) {
      if (p.re.test(from)) return { filtered: true, reason: p.label };
    }
  }
  const subj = (subject ?? "").trim();
  if (subj) {
    for (const p of SUBJECT_PATTERNS) {
      if (p.re.test(subj)) return { filtered: true, reason: p.label };
    }
  }
  return { filtered: false, reason: null };
}
