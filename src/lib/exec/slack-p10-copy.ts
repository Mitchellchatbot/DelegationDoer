// P10: every fixed string (contract §3.2; stage 0, lead seed, frozen; pinned by p10-seed.test.ts). Pure, no import.

export const SLACK_P10_COPY = Object.freeze({
  settings: Object.freeze({
    heading: "More from Slack",
    notInstalled: "These Slack features aren't installed yet (the P10 database update hasn't been applied).",
    notice: "Optional, each with its own switch: reading every conversation you're in, counting leads in your clients' lead channels, and drafting Slack replies in your style. Stop reading deletes everything they keep.",
    // v1.1 product-14: labelled by what it changes (next to P7a's "Only conversations I'm in" radio, slack-read-copy.ts:62-63).
    readAllLabel: "Also read finance, HR and legal channels and channels I muted in Slack",
    // v1.1 product-1: the finance-only rule is said only of finance-type channels (FINANCE_RE, slack-classes.ts:37).
    readAllHelp: "Also reads finance-type channels (finance, payroll, HR, legal, billing, accounting, tax, contracts, compliance) and channels you muted in Slack. What it finds in finance-type channels shows only in DD.",
    readAllStatus: "{finance} finance, HR or legal channels you're in are read.",
    // P10 fixer ui-10: the singular of every count template (filled when the count is 1).
    readAllStatusOne: "1 finance, HR or legal channel you're in is read.",
    readAllUpdating: "Updating your channel list…",
    readAllOffHelp: "Turning this off mutes finance, HR and legal channels again. Channels you muted in Slack stay read; mute them in the list below.",
    readAllConfirmTitle: "Read every conversation you're in?",
    readAllConfirmBody: "The assistant will also read the finance-type channels you're a member of (finance, payroll, HR, legal, billing, accounting, tax, contracts, compliance) and the channels you muted in Slack. As in any watched conversation, messages there that are addressed to you, and each day's messages from people for the digest, are sent to Anthropic's Claude. What it finds in finance-type channels shows only in DD: never in Slack, App Home, the brief or email drafts. Channels you muted in Slack become ordinary watched channels: their items can show in your Slack DM, App Home, the brief and email drafts. Still never read: channels named like lead channels, your DMs with bots, notes to yourself, DD's own channels and any channel listed on a client's FB onboarding card. You can mute any channel below.",
    // v1.1 security-5: the review step, rendered under the body.
    readAllConfirmOpens: "It will start reading these {n} channels:",
    readAllConfirmOpensOne: "It will start reading this channel:",
    readAllConfirmMore: "+{n} more",
    readAllConfirmMuteFirst: "Mute any channel that carries patient or lead data first.",
    // P10 fixer security-2: the list couldn't be read, so the confirm can't name what it opens (and can't be confirmed).
    readAllConfirmUnknown: "DD couldn't list the channels this would open. Reload the page and try again.",
    readAllConfirmCheck: "I want every conversation I'm in read.",
    leadsLabel: "Count leads in client lead channels",
    // v1.1 product-11: the counted set is every lead marker he is in, listed on a card or named like one.
    leadsHelp: "Counts each day's new posts in every lead channel you're in (the ones on your clients' FB onboarding cards and any channel named like one), by kind. Nothing from the posts is kept.",
    leadsConfirmTitle: "Count leads in client lead channels?",
    leadsConfirmBody: "DD will check every lead channel you're a member of: the ones listed on a client's FB onboarding Notifications card, and any channel named like one (such as …-vob-leads, …-calendly or …-zap-errors). It counts each day's new posts by kind: VOB, non-VOB, Calendly (bookings and reminders together) and Zapier errors. The posts reach DD's server only to be counted: no message text, name, phone number, insurance detail or poster is kept, logged, shown or sent to Anthropic. Only the counts are kept, for {days} days. They show on the Slack tab, in the morning brief (in DD and in your Slack DM) and in chat.",
    leadsConfirmCheck: "Counting lead channels this way is approved (42 CFR Part 2).",
    repliesLabel: "Draft Slack replies",
    repliesHelp: "Drafts a reply in your style when you ask, from that conversation only. Nothing is posted until you press Send.",
    repliesConfirmTitle: "Draft Slack replies?",
    repliesConfirmBody: "When you ask for a reply, in DD or in chat, the assistant sends that conversation's own recent messages and your instruction to Anthropic's Claude to draft it: never other conversations, email, or finance from elsewhere. Once a week a sample of your own recent messages in internal conversations is sent to learn your Slack style; only the style is kept. Drafts are kept in DD for 7 days after you're done with them.",
    repliesConfirmCheck: "Draft my Slack replies this way.",
    sendLabel: "Let me send drafted replies",
    sendHelp: "Posts a reply as you only when you press Send and confirm.",
    sendConfirmTitle: "Send drafted replies as you?",
    sendConfirmBody: "A reply is posted only when you press Send and confirm: exactly the text you approved, as you, from your own Slack account through DD's Slack connection, into the same thread or DM, once. If Slack's answer is unclear it isn't posted again; check Slack. People see an ordinary message from you. In Slack Connect conversations people outside the company see it too, so those send from DD only. Replies in finance channels are drafted and sent only from DD.",
    sendConfirmCheck: "The employee notice says I may send replies the assistant drafts from my own Slack account.",
    autoLabel: "Draft replies automatically",
    // v1.1 product-21: says what is sent to Anthropic and that urgent ones appear in the DM, during work hours only.
    autoHelp: "For requests, questions and decisions addressed to you in internal conversations, up to 15 a day, drafted from each conversation's recent messages. Urgent ones also appear in your assistant DM during work hours. Never sent on its own.",
    capLabel: "Automatic drafts daily budget",
    capHelp: "Automatic drafts stop for the day at this amount. Drafts you ask for count only toward the daily AI budget.",
    voiceLabel: "Learn my Slack writing style",
    voiceHelp: "Once a week, reads up to 60 of your own recent messages in internal conversations. Only the style is kept.",
    // v1.1 product-12: the profile's state, under the switch.
    voiceReady: "Learned from {n} of your messages on {date}.",
    voiceInsufficientEmail: "Not enough of your Slack messages yet; drafts use your email style.",
    voiceInsufficientHouse: "Not enough of your Slack messages yet; drafts use a default style.",
    voiceFailed: "Couldn't learn it ({reason}).",
    voiceNone: "Learns after your first draft, then weekly.",
    voiceReasons: Object.freeze({
      declined: "the AI declined", truncated: "the answer ran too long", invalid_output: "the AI's answer was malformed",
      budget: "the daily AI budget was used up", read_failed: "Slack couldn't be read", insufficient: "not enough messages"
    }),
    needsReplies: "Turn on \"Draft Slack replies\" first.",
    // v1.1 product-4: the send switch shows his DD Slack connection; {state} = P8's BRIEF_COPY.system.tokenState words.
    sendConnection: "Slack connection: {state}",
    dmNudge: "Your direct messages aren't read: they weren't allowed on Slack's screen. Allow reading again to include them.",
    groupDmNudge: "Your group DMs aren't read: they weren't allowed on Slack's screen. Allow reading again to include them.",
    allowAgain: "Allow reading again",
    needsReading: "Turn Slack reading on first.",
    // v1.1 product-13: while reading is paused every P10 switch saves but nothing runs.
    startsWhenReading: "Starts when Slack reading is on.",
    saveFailed: "Couldn't save. Try again.",
    stopAlso: "Stop reading also deletes lead counts, reply drafts and your Slack style.",
    // P10 fixer ui-9: the controls' own words (were typed in SlackP10Controls).
    saving: "Saving…",
    turnOn: "Turn on",
    cancel: "Cancel",
    on: "On",
    off: "Off"
  }),
  leads: Object.freeze({
    title: "Leads",
    countsOnly: "Counts only: nothing from the lead posts is stored, logged or shown to the AI.",
    columns: Object.freeze({ today: "Today", yesterday: "Yesterday", last7: "Last 7 days" }),
    // v1.2 (owner, 2026-11-10): the -calendly channels also post reminders, so the kind is "Calendly posts" (bookings and reminders together) for good, never "calls booked" (Appendix C).
    kinds: Object.freeze({ vob: "VOBs", nonvob: "non-VOBs", calendly: "Calendly posts", zap_errors: "Zapier errors" }),
    kindOne: Object.freeze({ vob: "VOB", nonvob: "non-VOB", calendly: "Calendly post", zap_errors: "Zapier error" }),
    asOf: "As of {time}",
    // v1.1 product-9: the totals row and line come first.
    allClients: "All clients",
    // v1.1 product-19: the Zapier chip says which day.
    zapToday: "{n} Zapier errors today",
    zapTodayOne: "1 Zapier error today",
    zapYesterday: "{n} Zapier errors yesterday",
    zapYesterdayOne: "1 Zapier error yesterday",
    // v1.1 correctness-2 / product-2: covers a day still being counted and a day whose read hit the page cap (a lower bound).
    incomplete: "Some days aren't fully counted yet; their numbers may be low.",
    unlinked: "Not linked to a client",
    unlinkedHelp: "{n} lead channels aren't on any client's FB onboarding Notifications card. Add them there to see them by client.",
    unlinkedHelpOne: "1 lead channel isn't on any client's FB onboarding Notifications card. Add it there to see it by client.",
    ambiguousHelp: "{n} lead channels match more than one client's card. Fix the cards to see them by client.",
    ambiguousHelpOne: "1 lead channel matches more than one client's card. Fix the cards to see it by client.",
    // v1.2 (owner, 2026-11-10): he stays in only the lead channels he is already in, so this is information, not a to-do (Appendix C).
    listedNotMember: "{n} listed lead channels aren't counted because you're not a member.",
    listedNotMemberOne: "1 listed lead channel isn't counted because you're not a member.",
    // v1.1 product-10: what to fix, by item. The link text is fixed copy; names come only from the FB cards (DD data).
    openInSlack: "Open in Slack",
    fixUnlinked: "Not on any client's card:",
    fixAmbiguous: "On more than one client's card:",
    fixNotMember: "Not counted for {client} (you're not a member): {names}",
    fixMore: "+{n} more",
    otherKind: "{n} listed channels aren't lead channels by name and aren't counted.",
    otherKindOne: "1 listed channel isn't a lead channel by name and isn't counted.",
    nonAppPosts: "{n} posts today came from people, not from Zapier, and weren't counted.",
    nonAppPostsOne: "1 post today came from a person, not from Zapier, and wasn't counted.",
    // v1.1 product-20: the table's caption.
    tableCaption: "Lead posts by client",
    // v1.2 (owner, 2026-11-10): under the table whenever a row shows the Calendly kind (Appendix C).
    calendlyNote: "Calendly posts include reminders, not only bookings.",
    states: Object.freeze({
      off: "Lead counts are off. Turn them on in Settings.",
      not_installed: "Lead counts aren't installed yet.",
      reading_off: "Slack reading is off, so leads aren't counted.",
      first_run: "Counting your lead channels for the first time. This takes a few minutes.",
      no_channels: "You're not a member of any client lead channels, so there's nothing to count.",
      unavailable: "Couldn't load lead counts."
    }),
    brief: Object.freeze({
      title: "Leads yesterday",
      titleDated: "Leads {date}",
      // v1.1 product-9: the block's first line.
      total: "All clients: {counts}",
      line: "{client}: {counts}",
      more: "+{n} more in DD",
      zap: "Zapier errors: {list}",
      // v1.1 product-2: "none" only when every counted lead channel has a complete zero day.
      none: "No new lead posts yesterday.",
      notReady: "Lead counts for yesterday aren't ready yet ({n} channels not counted).",
      notReadyOne: "Lead counts for yesterday aren't ready yet (1 channel not counted).",
      notReadyFirst: "Lead counts for yesterday aren't ready yet.",
      partial: "(not every post counted yet)",
      unavailable: "Couldn't load lead counts.",
      unlinked: "Not linked to a client: {counts}"
    }),
    countSep: " · ",
    chatNote: "Counts of new posts in the client's lead channels by kind; Calendly posts include reminders, so they aren't a count of calls booked. Nothing else from those channels is available.",
    // v1.1 product-18: every chat part says what its numbers cover.
    chatBasis: "Whole local days in {tz}; today so far as of {time}."
  }),
  replies: Object.freeze({
    draftReply: "Draft reply",
    draftReady: "Reply draft ready",
    // v1.1 product-16: one label per draft status, wherever a row shows its draft (catch-up, Needs Attention, the page).
    statusLabels: Object.freeze({
      generating: "Drafting reply…", draft: "Reply draft ready", generation_failed: "Reply draft failed", sending: "Sending…",
      unknown: "Reply may have posted: check", sent: "Replied {time}"
    }),
    newTitle: "Draft a Slack reply",
    instructionLabel: "What should the reply say? (optional)",
    instructionHelp: "Leave it empty to let the assistant draft from the conversation. It uses only this conversation and what you type here.",
    create: "Draft reply",
    pageTitle: "Slack reply draft",
    // v1.1 product-5: a place phrase + a thread suffix, used whole as a header and inside the two confirms.
    // {channel} = the stored P7a name cut as slackChannelLabel cuts it (P7b), without its leading "#"; a channel with no stored
    // name → place.unknown. {person} = the source item's author label (P7a's exec_slack_items.author_label; "External member"
    // for an outside author).
    destination: "Reply in {place}{thread}",
    place: Object.freeze({
      channel: "#{channel}", private: "#{channel} (private)", dm: "your DM with {person}", dmUnknown: "a direct message",
      group: "a group DM with {person} and others", groupUnknown: "a group DM", unknown: "the same conversation"
    }),
    thread: ", in the thread",
    replyingTo: "Replying to",
    replyingToFrom: "a message from {person}",
    openMessage: "Open the message in Slack",
    external: "People outside Scaled AI are in this conversation. They will see the reply.",
    finance: "Finance channel: this draft stays in DD.",
    generating: "Drafting…",
    rewriting: "Rewriting…",
    // v1.1 product-8: "Try again" only where trying again can help; reason-specific next steps otherwise.
    generationFailed: "Couldn't draft a reply ({reason}).",
    tryAgainHint: "Try again.",
    nextSteps: Object.freeze({
      budget: "Try again tomorrow, or raise the daily AI budget in Settings.",
      reading_off: "Turn Slack reading on."
    }),
    rewriteFailed: "Couldn't rewrite it ({reason}). The previous draft is below.",
    // v1.1 product-12: which style the draft used.
    style: Object.freeze({
      slack: "In your Slack style", email: "In your email style: your Slack style isn't learned yet", house: "In a default style"
    }),
    // v1.1 product-20: the textarea's label.
    textLabel: "Reply text",
    // v1.1 product-15: unsaved edits.
    saveFirst: "Save your changes first.",
    rewriteEditedConfirm: "Rewrite replaces your edited text.",
    reasons: Object.freeze({
      refused: "the AI declined", truncated: "it ran too long", invalid_output: "the AI's answer was malformed", empty: "the AI wrote nothing",
      too_long: "it ran too long", copied_external: "it repeated an outside person's words", timeout: "it took too long",
      model_error: "the AI service failed", budget: "the daily AI budget is used up", context_unavailable: "Slack couldn't be read",
      reading_off: "Slack reading is off", channel: "the conversation can't be read any more",
      context_deleted: "a message it used was deleted", author_optout: "it used messages DD may no longer read"
    }),
    note: "Note for you",
    placeholders: "Fill in {list} before sending.",
    // P10 fixer ui-9: a send refused for placeholders it doesn't name (was refusalText's typed "the blanks").
    placeholdersUnnamed: "Fill in the blanks before sending.",
    flags: "Check before sending: {list}.",
    flagNames: Object.freeze({
      unexpected_url: "a link", unexpected_email: "an email address", unexpected_phone: "a phone number", unexpected_amount: "an amount",
      unexpected_number: "a number", mention: "an @name (it won't notify anyone)", broadcast: "@channel or @here (it won't notify anyone)"
    }),
    injection: "A message in this conversation looked like instructions to the AI. Read the draft carefully.",
    edit: "Edit", save: "Save", cancel: "Cancel", copy: "Copy", copied: "Copied", rewrite: "Rewrite",
    rewriteWith: "Rewrite with this instruction", discard: "Discard", send: "Send as you…", openInSlack: "Open in Slack",
    sentLink: "See it in Slack",
    sendTitle: "Send this reply as you?",
    sendBody: "This exact text is posted as you in {place}{thread}. It can't be unsent from DD.",
    sendAcksTitle: "Before sending, confirm:",
    // v1.1 product-6: the send found a blocker the review (C59) didn't.
    changedSinceReview: "Something changed since you opened this: {list}.",
    acks: Object.freeze({
      external: "People outside Scaled AI will see this.",
      flags: "I checked the flagged details.",
      injection: "I read the draft; it says only what I want.",
      already_replied: "You replied after this draft was written. Send it anyway.",
      source_edited: "The message was edited after this draft was written. Send it anyway.",
      newer_messages: "There are newer messages in the conversation. Send it anyway.",
      unchecked: "DD couldn't check for newer messages. Send it anyway."
    }),
    sendConfirm: "Send", sending: "Sending…",
    sent: "Sent {time}.",
    // v1.1 security-7 / product-3: the two answers appear only after DD's third read-only check.
    unknown: "Slack didn't confirm whether this posted. DD is checking Slack until {time}. Don't send it again.",
    unknownChecked: "Slack didn't confirm whether this posted, and DD didn't find it in the conversation. Check Slack, then tell DD what happened.",
    tooEarly: "DD is still checking Slack. Try again after {time}.",
    alreadyPosted: "DD found this reply in Slack after all, so it's marked sent.",
    resolvePosted: "It posted", resolveNotPosted: "It didn't post", newFromText: "Start a new draft with this text",
    failed: "Not sent.",
    backToDraft: "Not sent: {reason}. Nothing was posted.",
    sendReasons: Object.freeze({
      not_in_channel: "you're not in the conversation", channel_not_found: "the conversation is gone",
      is_archived: "the conversation is archived", missing_scope: "your DD Slack connection can't post; reconnect Slack in your DD profile",
      restricted_action: "Slack doesn't let you post there", ratelimited: "Slack is busy; try again in a minute",
      msg_too_long: "the reply is too long", token_missing: "your DD Slack connection is missing; connect Slack in your DD profile",
      token_mismatch: "your DD Slack connection isn't your own account", token_revoked: "your DD Slack connection expired; reconnect it",
      other: "Slack refused it"
    }),
    discarded: "Discarded.",
    expired: "This draft expired.",
    removed: "This draft was removed: a message it used was deleted or can no longer be read.",
    sendOff: "Sending is off. Turn on \"Let me send drafted replies\" in Settings.",
    readingOff: "Turn Slack reading on to send.",
    stale: "This draft changed. Review it again.",
    notFound: "This draft is no longer available.",
    framed: "Changes are off in an embedded view.",
    cardTitle: "Reply draft",
    cardFallback: "A reply draft is ready in DD",
    cardDdOnly: "Check and send in DD",
    cardEditInDd: "Edit in DD",
    cardConfirmTitle: "Send as you?",
    // v1.1 product-5: ≤ 300 characters with an 80-character place (ST07).
    cardConfirmText: "Posts this exact text as you in {place}{thread}. It can't be unsent from here.",
    cardConfirmYes: "Send",
    cardConfirmNo: "Cancel",
    // v1.1 product-15: Discard nulls the text at once; Rewrite replaces a hand-edited text.
    cardDiscardConfirmTitle: "Discard this draft?",
    cardDiscardConfirmText: "Its text is deleted.",
    cardDiscardConfirmYes: "Discard",
    cardRewriteConfirmTitle: "Rewrite this draft?",
    cardRewriteConfirmText: "Rewrite replaces your edited text.",
    cardRewriteConfirmYes: "Rewrite",
    // v1.1 product-8: actions and reasons by state.
    cardTryAgain: "Try again",
    cardOpenInDd: "Open in DD",
    cardChecking: "DD checks Slack for 30 minutes.",
    cardNotSent: "Not sent from Slack. Nothing was posted.",
    cardDdWhy: "Send this one from DD: {reasons}.",
    cardDdReasons: Object.freeze({
      placeholders: "it has blanks to fill in", external: "people outside the company are in it", flags: "it has details to check",
      injection: "a message looked like instructions to the AI", already_replied: "you replied after it was written",
      source_edited: "the message was edited", newer_messages: "there are newer messages",
      unchecked: "DD couldn't check for newer messages", send_off: "sending is off", token: "your Slack connection isn't checked yet",
      too_long: "it's too long to show here in full"
    }),
    cardRemoved: "This reply draft is no longer available.",
    cardSent: "Sent as you.",
    cardCopyHint: "To copy the draft, select its text above, or open it in DD.",
    toolNotStored: "I can only draft replies to Slack messages the assistant has recorded. Open the message in Slack to reply.",
    toolFinanceSlack: "That message is in a finance channel, so its draft is only in DD.",
    toolOff: "Slack reply drafts are off. He can turn them on in Settings.",
    toolNothingSent: "Nothing is posted until he presses Send.",
    // v1.1 product-7: a second ask about the same message.
    toolRewriting: "Rewriting the open draft with his new instruction.",
    toolExistingEdited: "The open draft was edited by hand, so it was left as is; he can rewrite it in DD.",
    toolExistingBusy: "The open draft is being drafted or sent, so it was left as is.",
    // P10 fixer ui-9: the reply pages' own words (were REPLY_UI_COPY in reply-logic.ts; the rewrite box reuses instructionLabel).
    reviewChecking: "Checking the conversation…",
    callFailed: "Couldn't reach DD. Try again.",
    openReplyPage: "Open the reply page",
    pageOff: "Slack reply drafts are off. Turn them on in Settings.",
    notAllowed: "This message can't get a reply draft.",
    createCap: "Too many reply drafts were started just now. Try again in a few minutes."
  }),
  system: Object.freeze({
    leadsRow: "Slack lead counts",
    leadsLine: "Last run {time}: {channels} channels, {unlinked} not linked, {notMember} listed but not a member",
    leadsLineOne: "Last run {time}: 1 channel, {unlinked} not linked, {notMember} listed but not a member",
    // v1.1 product-2: amber when failingRuns > 0.
    leadsFailed: "Last run {time} failed ({code})",
    leadsNever: "Not run yet",
    repliesRow: "Slack replies",
    // v1.1 product-4: {token} = P8's BRIEF_COPY.system.tokenState words for slack-reply / token-health.
    repliesLine: "{open} drafts open, {sent} sent today, {unknown} unconfirmed · Slack connection: {token}",
    repliesLineOne: "1 draft open, {sent} sent today, {unknown} unconfirmed · Slack connection: {token}",
    // v1.1 product-12
    styleRow: "Slack style"
  })
});

export const SLACK_P10_OPS = Object.freeze({
  tokenMismatch: Object.freeze({
    key: (principalId: string) => `slack-reply-token-mismatch:${principalId}`,
    title: "Executive Assistant: sending Slack replies is paused (the DD Slack token isn't his)"
  }),
  leadRunFailing: Object.freeze({
    key: (principalId: string) => `slack-lead-run-failing:${principalId}`,
    title: "Executive Assistant: Slack lead counts are failing"
  })
});

/** {name} placeholders, as BRIEF_COPY's fill: an unknown name is left as is. */
export function fillP10(template: string, values: Readonly<Record<string, string | number>>): string {
  // Stage-0 body (lead): fillBrief's rule (brief-copy.ts), restated here because this file imports nothing. Own properties
  // only; a number is written with String(); a value of any other type, or a missing name, leaves {name} as it is.
  if (typeof template !== "string") return "";
  const v: Readonly<Record<string, string | number>> = values ?? {};
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(v, name)) return whole;
    const value = v[name];
    return typeof value === "number" || typeof value === "string" ? String(value) : whole;
  });
}
