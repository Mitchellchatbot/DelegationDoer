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
  // WordPress / WP security notifications. Real-world Wordfence alerts
  // are sent FROM the WP install, so the From may be wordfence@<client>
  // rather than anything @wordfence.com — match the local-part too.
  { re: /^wordpress@/i, label: "wordpress notifier" },
  { re: /^wordfence@/i, label: "wordfence sender (local-part)" },
  { re: /@wordfence\./i, label: "wordfence alert" },
  // Verification / 2FA senders
  { re: /^(verify|verification|otp|auth|2fa)@/i, label: "verification sender" },
  // Marketing / newsletter / digest senders — generic local-parts that
  // are almost always automated outreach.
  { re: /^(news(letter)?|marketing|digest|updates?)@/i, label: "marketing/newsletter sender" },
  // Security / monitoring alert senders (Sucuri, generic monitoring
  // services, etc.) — high signal as automation when the local-part is
  // one of these and no real human signs the mail.
  { re: /^(security|alert|alerts|monitoring)@/i, label: "security/monitoring sender" },
  // Transactional / receipt senders. Catches Amazon order-update,
  // shipping carriers, billing systems.
  {
    re: /^(billing|receipt|invoice|orders?|order-update|shipment-tracking|ship-confirm|auto-confirm)@/i,
    label: "transactional/receipt sender"
  },
  // Specific automation-heavy vendors. Lean conservative: only domains
  // whose inbound mail is essentially always automated (no humans
  // emailing us FROM these). Add new ones as we observe leaks.
  { re: /@(anthropic|claude)\./i, label: "anthropic/claude" },
  { re: /@(amazon|amazonses)\./i, label: "amazon" },
  { re: /@vercel\./i, label: "vercel" },
  {
    re: /@(imagify|cloudflare|netlify|updraftplus|backupbuddy|sucuri)\./i,
    label: "plugin/hosting notifier"
  },
  // Calendar / meeting platforms
  { re: /@(calendar-server|calendly|google-calendar)\./i, label: "calendar notifier" },
  // Social platform digest mailers (Instagram "moments you've missed",
  // etc.) — real DMs come via the app, not these recap addresses.
  { re: /@mail\.instagram\.com$/i, label: "instagram digest" },
  // Slack platform mailers — workspace digests, "feedback on Slack" prompts.
  // Real human replies come from a workspace.slack.com host, not slack.com.
  { re: /^(feedback|digest|notifications?)@slack\.com$/i, label: "slack platform mail" },
  // Microsoft 365 Message Center (o365mc@microsoft.com) — admin service
  // advisories, never something we need to action as a task.
  { re: /^o365mc@/i, label: "microsoft 365 advisory" },
  // WP Remote / managed-WP service notifications.
  { re: /@wpremote\./i, label: "wp remote notifier" },
  // Vendor BI / market-intel digest local-parts (Connexity, etc.). The
  // existing newsletter/digest rule above misses "business_intelligence@".
  { re: /^(business[_-]?intelligence|market[_-]?intel|industry[_-]?digest)@/i, label: "vendor bi digest" }
];

// Subject patterns. These are intentionally more permissive than the
// sender list because they're checked AFTER the sender list (so a real
// client emailing about "Out of office coverage" wouldn't be filtered
// unless their sender also matches an automated pattern). All lowercased.
const SUBJECT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(verification|verify|confirmation)\s+code\b/i, label: "verification code" },
  { re: /\bone[-\s]?time\s+(code|password|pin|link)\b/i, label: "one-time code" },
  { re: /^your\s+.*\s+code\s+is\b/i, label: "your X code is" },
  { re: /\b(here'?s\s+your\s+code|your\s+(login|sign[-\s]?in|access)\s+code)\b/i, label: "your code (variants)" },
  // Login / magic-link emails. Common in Claude.ai, Notion, Slack
  // sign-in flows — never something we want as a routed task.
  {
    re: /\b(secure\s+link\s+to\s+(log|sign)[-\s]in|sign[-\s]in\s+link|log[-\s]in\s+link|magic\s+link)\b/i,
    label: "login/magic link"
  },
  // Wordfence-style alert subjects (Premium uses [Wordfence …]; the free
  // version uses plain "Security Alert: …" style copy).
  { re: /\[wordfence/i, label: "wordfence alert subject" },
  {
    re: /\b(security\s+alert|increased\s+attack\s+rate|locked\s+out|admin\s+login\s+from\s+a\s+new)\b/i,
    label: "wordfence-style alert"
  },
  // Citation / local-SEO tools (Whitespark, BrightLocal, Yext) ping us
  // any time something moves. Broader than the prior "weekly" anchor.
  { re: /\bcitation\s+(update|report|alert|monitoring)\b/i, label: "citation update" },
  // Backup-completion pings from UpdraftPlus, BackupBuddy, etc.
  { re: /\bbackup\s+(complete|completed|completion|successful|finished)\b/i, label: "backup notification" },
  // Plugin / theme / software update prompts.
  { re: /\b(plugin|theme|software)\s+update\s+(available|notification|required)\b/i, label: "plugin/theme update" },
  // CI/CD deploy failure mail (Vercel, Netlify, GitHub Actions).
  { re: /\b(build|deployment|deploy)\s+(failed|failure|error)\b/i, label: "build/deploy failure" },
  // Order receipts / post-purchase nudges (Amazon, Shopify, etc.).
  {
    re: /\b(thanks\s+for\s+your\s+(order|purchase)|your\s+order\s+(has\s+)?(shipped|been\s+placed|is\s+on\s+its\s+way)|happy\s+with\s+your\s+purchase|how\s+was\s+your\s+(order|purchase))\b/i,
    label: "order receipt"
  },
  // Webinar / workshop invites.
  { re: /\b(webinar|workshop)\s+(invitation|reminder|registration)\b/i, label: "webinar invite" },
  { re: /\b(delivery (failed|status notification)|undeliverable|returned mail|mail delivery)\b/i, label: "delivery failure" },
  // Instagram recap subject ("agencysites_ai, catch up on moments you've missed")
  { re: /catch\s+up\s+on\s+moments\s+you/i, label: "instagram recap subject" },
  // Slack-prefixed weekly digest subjects ("[Slack] X updates for the week of …")
  { re: /^\[slack\]\b/i, label: "slack digest subject" },
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
