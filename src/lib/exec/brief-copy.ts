// P8 morning brief: every fixed string (P8 contract §3.2; stage 0, lead seed, frozen). Pure and client-safe: no imports.
// Exactly the contract's block (a sha256 pin in p8-seed.test.ts); a change goes through the lead. Copy never holds a
// link or a URL (the renderers build links), nor brief text, names or ids. Placeholders are {name}, filled by fillBrief.

export const BRIEF_COPY = Object.freeze({
  sectionTitle: {
    emails: "Important emails", slack: "Important Slack conversations", client_requests: "Client requests",
    progress: "Company-wide progress", work: "Completed and outstanding work", delayed: "Delayed projects",
    blockers: "Operational blockers", approvals: "Pending approvals", decisions: "Important decisions",
    commitments: "Commitments needing follow-up"
  },
  top3Title: "Your top 3",
  state: {
    email_off: "Email intelligence is off.", email_no_pin: "No mailbox is connected.", email_unavailable: "Couldn't load email.",
    slack_not_installed: "Slack isn't set up yet.", slack_not_connected: "Slack isn't connected.",
    slack_reading_revoked: "Slack reading was stopped.", slack_reading_off: "Slack reading is off.",
    slack_discovering: "Slack is still being set up.", slack_unavailable: "Couldn't load Slack.",
    ddtext_off: "AI-assessed blockers from comments and EODs are off.", unavailable: "Couldn't load this section."
  },
  nothingNew: "Nothing new.",
  pendingPrefix: "Still pending: ",
  unchanged: "+{n} unchanged, open in DD",
  more: "+{n} more in DD",
  restricted: "{n} restricted-sender emails need you.",
  restrictedOne: "1 restricted-sender email needs you.",
  financeLine: "Finance isn't in this brief.",
  financeLink: "Open Finance",
  modeAi: "AI summary",
  modeDeterministic: "AI summary unavailable today ({reason}).",
  modeReason: {
    refused: "the model declined", truncated: "the summary was cut off", budget: "the daily AI budget is used up",
    invalid_output: "the summary failed its checks", model_error: "the AI service failed", timeout: "the summary took too long"
  },
  removedRestricted: "[Removed: restricted sender]",
  removedSlack: "[Removed: no longer available in Slack]",
  suggested: "Suggested",
  basis: { record: "Record", derived: "Derived", ai: "AI-assessed" },
  // DM (C25)
  dmHeader: "Morning brief · {date}",
  dmFallbackText: "Your morning brief",
  dmCounts: "{new} new · {pending} still pending · {unchanged} unchanged",
  dmOpenFull: "Open the full brief in DD",
  dmGenerated: "Generated {time}",
  dmScrubbedNote: "Part of this brief cited mail or Slack messages that are no longer available, so it was removed here. The current brief is in DD.",
  lateNote: "Your full brief is ready in DD.",
  // check-ins (M6)
  checkinsTitle: "Check-ins",
  checkinsIntro: "Short personal notes you can send as yourself. Nothing is sent until you press Send.",
  checkinsFooter: "Written from DD data only. Sent from your own Slack account.",
  checkinsFallbackText: "Check-ins from your morning brief",
  checkinTo: "To {name}:",
  checkinSend: "Send to {name}",
  checkinRewrite: "Rewrite",
  checkinStatus: {
    sending: "Sending…", sent: "Sent to {name} at {time}.",
    unknown: "We couldn't confirm this was sent. Check your DM with {name} before sending it again.",
    failed: "Couldn't send. You can send it yourself in Slack.", expired: "Expired.",
    replaced: "Replaced by a newer version.", stale: "This button is from an older version of the message.",
    recipient: "Couldn't send: their Slack account changed or can't be checked."
  },
  checkinsPaused: {
    token: "Sending is paused: the Slack account DD sends from isn't yours. Reconnect Slack in DD (your profile's Slack connection).",
    missing: "Sending is paused: DD has no Slack connection for your account. Connect Slack in DD (your profile's Slack connection).",
    disabled: "Check-ins are turned off in Executive AI settings.",
    notOwned: "This brief no longer sends check-ins.",
    busy: "Couldn't do that right now. Try again in a moment."
  },
  // DD-bot watchdog mini-brief (M7)
  fallbackHeader: "Morning brief (backup) · {date}",
  fallbackText: "Your morning brief (backup)",
  fallbackIntro: "Your full brief didn't arrive on time, so here is a short version from DD.",
  fallbackBands: "Needs attention: {critical} critical, {high} high, {normal} normal.",
  fallbackDdTitle: "From DD",
  fallbackEmail: "Email: {n} items need you.",
  fallbackSlack: "Slack: {n} items need you.",
  fallbackApprovals: "Waiting for approval: {n}.",
  fallbackUnavailable: "Couldn't load this.",
  fallbackOpen: "Open Executive AI in DD",
  // new-network alert (M13)
  networkDm: "New sign-in to your Executive AI page from network {net} ({family}) at {time}. If this wasn't you, change your DD password (that signs out your other sessions).",
  networkFallbackText: "New sign-in to Executive AI",
  // legacy expiry (M1, C37)
  legacyExpired: "Expired: check-ins now come from your Executive Assistant's brief.",
  // page and header
  tab: "Brief",
  pageTitle: "Morning brief",
  pill: "Brief {time} {tz} · {state}",
  pillState: {
    delivered: "live", page_only: "page only", building: "building", built: "building", delivering: "sending",
    delivery_unknown: "check Slack", failed: "failed", none: "not yet", off: "off", not_installed: "not installed"
  },
  status: {
    delivered: "Sent to you in Slack at {time}.", page_only: "In DD only.", building: "Being built.",
    built: "Built, sending to Slack.", delivering: "Sending to Slack.", failed: "Couldn't be built today.",
    delivery_unknown: "We couldn't confirm it reached Slack. Check your DM with the assistant.",
    fallback: "The DD bot sent a short backup at {time}.",
    regeneratedAfterSend: "This version was regenerated in DD; Slack has the earlier one."
  },
  pageOnlyReason: {
    legacy_delivered: "The DD brief already went out today.", not_superseding: "The DD brief sends your morning DM until you switch.",
    no_installation: "Slack isn't connected.", after_cutoff: "It was built after {cutoff}, so it stayed in DD.",
    after_fallback: "The backup already went out, so this stayed in DD.", delivery_failed: "Slack refused the message.",
    rate_limited: "Slack was busy.", ownership_lapsed: "The settings changed before it was sent.", regenerated: "Regenerated in DD.",
    screen_unavailable: "Its sources couldn't be re-checked before sending, so it stayed in DD."
  },
  notInstalled: "The morning brief isn't installed yet.",
  off: "The morning brief is off. Turn it on in Settings.",
  none: "Today's brief hasn't been built yet. It's due at {time}.",
  regenerate: "Regenerate",
  regenerateConfirm: "Build a new version of today's brief? It stays in DD and isn't sent to Slack again.",
  regenerateQueued: "Regenerating. This page updates when it's ready.",
  regenerateBusy: "A brief is being built right now. Try again in a few minutes.",
  regenerateConflict: "The brief changed while you were looking at it. Reload and try again.",
  regenerateRateLimited: "Too many regenerations. Try again in {n} minutes.",
  regenerateFailed: "Couldn't regenerate the brief.",
  checkinsPageTitle: "Check-ins",
  checkinsPageNote: "Send or rewrite them from the brief in your assistant's Slack DM.",
  checkinsNotPosted: "These weren't posted to Slack.",
  openBrief: "Open the brief",
  // settings (C22)
  settings: {
    title: "Morning brief",
    enabled: "Build a morning brief", enabledHelp: "Built every day at your brief time and shown here.",
    time: "Brief time", timezone: "Time zone", timezoneDefault: "Use my work time zone ({tz})",
    checkins: "Suggest check-ins", checkinsHelp: "Up to 3 personal notes a day, written from DD data only. Nothing is sent until you press Send in Slack. Only when the brief is sent to Slack.",
    supersede: "Send the brief to Slack instead of the 8am DD brief",
    supersedeHelp: "Your assistant DMs the brief and the old DD brief stops. You can switch back at any time.",
    supersedeConfirmTitle: "Replace the 8am DD brief?",
    supersedeConfirmBody: "From the next brief, your Executive Assistant sends the morning brief and the old DD brief stops. The new brief doesn't include:",
    supersedeConfirmFoot: "Finance stays on the Finance page.",
    supersedeConfirm: "Replace it", cancel: "Cancel", save: "Save", saved: "Saved.",
    conflict: "These settings changed in another tab. Reload and try again.", failed: "Couldn't save.",
    sameDay: "Today's brief will be sent to Slack shortly.",
    timeZoneNote: "Changing the time zone moves today's brief date too."
  },
  supersedeLose: [
    "Stripe MRR, net new revenue, and new and churned clients",
    "Past-due client names, emails and amounts",
    "P&L burn and margin, and the top expense categories",
    "MOVES TO SCALE, weighted by your brain memories",
    "The daily needle mover (replaced by your top 3 actions)"
  ],
  // App Home (K13)
  home: {
    off: "Morning brief: off.", none: "Morning brief: not built yet today.", building: "Morning brief: being built.",
    page_only: "Morning brief: in DD only today.", delivered: "Morning brief: sent at {time}.",
    failed: "Morning brief: couldn't be built today.", delivery_unknown: "Morning brief: check this DM.",
    not_installed: "Morning brief: not installed yet."
  },
  homeSchedule: "Daily at {time} ({tz}). Change it in DD.",
  // approvals (M14, C46)
  approvalsCheckins: {
    title: "{n} check-ins from today's brief not sent yet",
    titleOne: "1 check-in from today's brief not sent yet",
    what: "{n} check-in messages on today's brief haven't been sent. They're sent from your assistant's Slack DM.",
    whatOne: "1 check-in message on today's brief hasn't been sent. It's sent from your assistant's Slack DM.",
    next: "Send or rewrite them from the brief in your assistant's Slack DM."
  },
  // System card (M12)
  system: {
    brief: "Morning brief", owner: { exec: "Assistant", legacy: "DD brief", exec_page_only: "DD brief (assistant in DD only)", unknown: "Unknown" },
    channel: { exec_bot: "Sent by the assistant", dd_bot_fallback: "Backup sent by the DD bot", page_only: "In DD only", none: "Not sent", unknown: "Unknown" },
    legacyToday: "DD brief today: {state}", legacySent: "sent", legacyNotSent: "not sent",
    token: "Slack token for check-ins",
    tokenState: { ok: "Yours, checked {time}", mismatch: "Not yours: check-ins paused", missing: "Not connected",
      revoked: "Revoked ({code})", error: "Couldn't check ({code})", no_installation: "Assistant not connected", unchecked: "Not checked yet" },
    spend: "AI spend today: ${spent} of ${cap}",
    refusals: "Model refusals in 24 hours: {n}"
  }
});

/** Ops alert keys and titles (M12). Detail strings carry ids, dates and codes only. */
export const BRIEF_OPS = Object.freeze({
  failed: { key: (p: string) => `brief-failed:${p}`, title: "exec morning brief failed" },
  deliveryUnknown: { key: (p: string) => `brief-delivery-unknown:${p}`, title: "exec morning brief delivery unclear; not posting again" },
  fallback: { key: (p: string) => `brief-fallback:${p}`, title: "exec morning brief watchdog fired; the DD bot sent the backup" },
  fallbackFailed: { key: (p: string) => `brief-fallback-failed:${p}`, title: "exec morning brief backup failed" },
  late: { key: (p: string) => `brief-late:${p}`, title: "exec morning brief built after the cutoff; kept in DD" },
  notOwned: { key: (p: string) => `brief-not-owned:${p}`, title: "exec morning brief can't be delivered by the assistant; the DD brief delivers" },
  tokenMismatch: { key: (p: string) => `checkin-token-mismatch:${p}`, title: "check-in sending paused: the DD Slack token isn't Mitchell's" },
  reaped: { key: (kind: string) => `job-reaped:${kind}`, title: "jobs killed by the lease reaper" },
  newNetwork: { key: (p: string) => `exec-access-new-network:${p}`, title: "new sign-in network on the Executive AI page" }
});

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Substitutes each {name} with vars[name] (own properties only). Numbers are written with String(); strings must already
 * be escaped for where they go (the renderers escape). An unknown {name} is left as it is, so a missing value shows.
 */
export function fillBrief(template: string, vars: Record<string, string | number>): string {
  if (typeof template !== "string") return "";
  const v = vars ?? {};
  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(v, name)) return whole;
    const value = v[name];
    return typeof value === "number" || typeof value === "string" ? String(value) : whole;
  });
}

/** Every nested object and array of the copy is frozen too (Object.freeze above is shallow). */
function freezeDeep(o: unknown): void {
  if (o === null || typeof o !== "object") return;
  for (const v of Object.values(o as Record<string, unknown>)) freezeDeep(v);
  Object.freeze(o);
}
freezeDeep(BRIEF_COPY);
freezeDeep(BRIEF_OPS);
