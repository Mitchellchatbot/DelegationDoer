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
// Used by the auto-intake poll and real-time event paths (not manual
// run-once).

// Sender-address patterns. Match case-insensitively against the
// extracted email address (already lowercased by callers, but the
// matchers tolerate either).
const SENDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // no-reply / do-not-reply variants. Match the token at the START of the
  // local-part (no-reply@, noreply.security@, no-reply-account@) AND when
  // it's a SUFFIX on a compound local-part (notifications-noreply@,
  // account.noreply@). The compound suffix form leaked LinkedIn/Slack
  // notifier mail past the old start-anchored rule.
  { re: /^(no-?reply|donotreply|do-?not-?reply)([._+-]|@)/i, label: "no-reply sender" },
  { re: /[._+-](no-?reply|donotreply)@/i, label: "no-reply sender (compound)" },
  // Notification / automation local-parts, including compound forms like
  // "notifications-noreply@" and "automated-alerts@".
  { re: /^(notifications?|automated|mailer-daemon|postmaster)([._+-]|@)/i, label: "automated sender" },
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
  // Deel (payroll/contractor platform). Belt to the braces of the
  // restricted_senders DB rule enforced in email-intake-runner: payroll mail
  // must never become a team task. Covers deel.com + subdomains
  // (hello.deel.com) and deel.support. Only "no-reply@deel.support" matched
  // the generic rules above, so payments@/its-payday@/deelteam@ used to reach
  // the classifier and were stopped by nothing but its judgement.
  { re: /@(.*\.)?deel\.(com|support)$/i, label: "deel payroll platform" },
  // Stripe (payments/billing platform). Same shape and same reasoning as the
  // Deel entry above: belt to the braces of the restricted_senders DB rule
  // seeded in 20260808000000_restricted_senders_stripe.sql. Covers stripe.com
  // + subdomains (e.stripe.com, mail.stripe.com, notifications.stripe.com)
  // and stripe.dev. Not decorative: of the generic rules above only
  // "no-reply@stripe.com" matched — "receipts@stripe.com" did not, because the
  // transactional rule above spells "orders?" with an optional s but "receipt"
  // without one, so Stripe receipts reached the classifier and were stopped by
  // nothing but its judgement.
  { re: /@(.*\.)?stripe\.(com|dev)$/i, label: "stripe billing platform" },
  // R M Reyes Tax Services. Belt to the braces of the restricted_senders
  // rule `rs_rmreyes_gmail`, seeded in
  // 20260826000000_restricted_senders_rm_reyes.sql and enforced in
  // email-intake-runner. Two things make it unlike every other entry above,
  // and both are deliberate:
  //
  //   1. It is anchored to a WHOLE ADDRESS, not a local-part shape or a
  //      domain. The domain here is gmail.com, so there is nothing broader
  //      that could safely be written — /@gmail\.com$/ would swallow a large
  //      share of the real mail this pipeline exists to route.
  //   2. The sender is a HUMAN (an accountant), not an automated biller like
  //      Deel or Stripe. Nothing else in this list would ever match them, so
  //      this line is not catching a leak the generic rules miss — it exists
  //      solely because getRestrictedSenderRules() FAILS OPEN: on a Supabase
  //      hiccup the DB rule evaporates, and without this line the mail would
  //      reach the classifier and land in the leader-visible routing-review
  //      queue, which is precisely what the rule is there to prevent.
  //
  // `label` names the rule id rather than describing automation, because it
  // is persisted verbatim as the audit reason in email_intake_log and
  // filing a person under "automated sender" would be wrong.
  //
  // If rs_rmreyes_gmail is ever lifted (viewer added, or enabled = false),
  // DELETE THIS LINE TOO — otherwise intake stays suppressed for this sender
  // with no row in restricted_senders to explain why.
  { re: /^rmreyestaxservices@gmail\.com$/i, label: "restricted sender (rs_rmreyes_gmail)" },
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
  // LinkedIn notifier mail (impression recaps, "people you may know",
  // connection invites). Real human conversation stays in-app — every
  // @linkedin.com email is an automated digest/notification.
  { re: /@(.*\.)?linkedin\.com$/i, label: "linkedin digest" },
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
  // Plain "Sign in to <Service>" / "Log in to <Service>" subjects — the
  // body is a one-tap login link, never a task. (Composio, Atlassian, etc.)
  { re: /^(sign|log)[-\s]?in\s+to\b/i, label: "sign-in email" },
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
  // Social analytics recaps ("your posts got 1,187 impressions last week",
  // "you reached 42 new followers"). The number + metric is the tell.
  { re: /\b[\d,]+\s+(impressions?|profile\s+views?|new\s+followers?|reactions?|connections?)\b/i, label: "social stats digest" },
  // Community / platform engagement nudges ("Conversations you might want
  // to join in <workspace>") — Slack/forum prompts, no action needed.
  { re: /\bconversations?\s+you\s+might\s+want\s+to\s+join\b/i, label: "community nudge" },
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

// ---------------------------------------------------------------------------
// Narrow variant: "no human is on the other end of this"
// ---------------------------------------------------------------------------
// looksAutomated above is tuned for the intake cron, where the cost of a
// false positive is low (the thread can be re-processed by hand) and the cost
// of a false negative is a Claude call plus a routing-review draft. That makes
// it deliberately aggressive — billing@, updates@, "webinar invitation", and
// so on.
//
// The #email-notifs Slack ping has the opposite economics. It already gates on
// "the sender matches a known client", which removes essentially all of the
// junk those broad patterns exist for, and its whole purpose is that a client
// email never goes unanswered — so a false positive silently loses the very
// thing we built it for. A client writing from billing@theirdomain.com is a
// person you reply to.
//
// So this matches only senders/subjects where replying is meaningless: bot
// mailboxes, bounces, and out-of-office autoresponders. Kept here rather than
// in the Slack module so there is exactly one place patterns like these live.

const UNREPLYABLE_SENDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^(no-?reply|donotreply|do-?not-?reply)([._+-]|@)/i, label: "no-reply sender" },
  { re: /[._+-](no-?reply|donotreply)@/i, label: "no-reply sender (compound)" },
  { re: /^(mailer-daemon|postmaster|automated)([._+-]|@)/i, label: "system sender" }
];

const UNREPLYABLE_SUBJECT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(out\s+of\s+office|auto[-\s]?reply|automatic reply)\b/i,
    label: "auto-reply"
  },
  {
    re: /\b(delivery (failed|status notification)|undeliverable|returned mail|mail delivery)\b/i,
    label: "delivery failure"
  }
];

export function looksUnreplyable(
  fromEmail: string | null,
  subject: string | null
): FilterResult {
  const from = (fromEmail ?? "").trim();
  if (from) {
    for (const p of UNREPLYABLE_SENDER_PATTERNS) {
      if (p.re.test(from)) return { filtered: true, reason: p.label };
    }
  }
  const subj = (subject ?? "").trim();
  if (subj) {
    for (const p of UNREPLYABLE_SUBJECT_PATTERNS) {
      if (p.re.test(subj)) return { filtered: true, reason: p.label };
    }
  }
  return { filtered: false, reason: null };
}

// ---------------------------------------------------------------------------
// Role / shared-mailbox addresses
// ---------------------------------------------------------------------------
// "Is this local-part a function rather than a person?"
//
// Used by the #email-notifs Slack ping, and ONLY for senders that matched a
// client on the WEBSITE DOMAIN alone — meaning nobody ever listed this address
// in that client's contact_emails and we're inferring the relationship purely
// from the host. That inference is what puts wordfence@<clientdomain> and
// support@<clientdomain> in the channel: both are the client's own automated
// systems, not the client writing to us, and neither trips looksUnreplyable
// (which only knows no-reply/mailer-daemon/postmaster).
//
// This list is deliberately broader than looksUnreplyable BECAUSE of that
// narrow application. An address listed in contact_emails skips the check
// entirely, so the escape hatch for any false positive is to add the address
// to the client in DD — no code change, no deploy. That also means shared
// mailboxes a client genuinely writes from (info@, hello@) are safe to screen
// here: if the client really uses one, it belongs in contact_emails anyway.
//
// Longest-first so that a compound term wins over a prefix of itself
// (mailer@ must not be reported as mail@).
const ROLE_LOCAL_PARTS = [
  "wordfence", "wordpress", "wpengine", "wp",
  "notifications", "notification", "notify", "alerts", "alert",
  "billing", "invoices", "invoicing", "invoice", "receipts", "receipt",
  "accounting", "accounts", "payments", "payment",
  "servicedesk", "helpdesk", "support", "service", "help",
  "enquiries", "inquiries", "contact", "hello", "info",
  "administrator", "webmaster", "hostmaster", "postmaster", "admin",
  "newsletter", "marketing", "campaigns", "updates", "update", "digest", "news",
  "monitoring", "security", "monitor",
  "sysadmin", "system", "daemon", "mailer", "robot", "bot", "mail",
  "backups", "backup", "cron",
  "recruitment", "recruiting", "careers", "jobs", "hr",
  "appointments", "scheduling", "calendar"
].sort((a, b) => b.length - a.length);

// Anchored at the local-part start, ending at a separator or the end of the
// local-part. Matches billing@, billing-team@, wordfence.alerts@ — but not
// billingsley@, which is a surname.
const ROLE_LOCAL_PART_RE = new RegExp(
  `^(${ROLE_LOCAL_PARTS.join("|")})([._+-]|$)`,
  "i"
);

export function looksRoleAddress(fromEmail: string | null): FilterResult {
  const addr = (fromEmail ?? "").trim();
  const at = addr.lastIndexOf("@");
  // No local part to inspect (bare domain, or an empty/garbage address).
  if (at <= 0) return { filtered: false, reason: null };

  // `reason` is the matched role token alone ("support@"). The Slack caller
  // wraps it in its own skip-reason vocabulary; keeping the two separate
  // avoids a doubled-up "role-address: role address (...)" string.
  const m = addr.slice(0, at).match(ROLE_LOCAL_PART_RE);
  return m
    ? { filtered: true, reason: `${m[1].toLowerCase()}@` }
    : { filtered: false, reason: null };
}
