// The guided tour's steps: one pass through the assistant's pages in tab order (Overview, Email, Slack, Team, Projects,
// Chat, then Settings), modelled on Scaled Sync's components/tour/steps.ts.
//
// Anchors are `[data-tour="..."]` attributes on real, always-rendered elements of each page (never a class: a class is
// styling and gets renamed; the attribute is a contract, and grepping for it finds the tour). src/lib/exec/ui/
// tour-steps.test.ts follows each step's route to its page and the components that page imports, and checks the anchor
// is rendered there, so a renamed or moved anchor fails a test instead of a tour step going quietly missing.
//
// SHORT BODIES. One or two sentences saying what the page ACTUALLY renders, written against the components, and nothing
// it doesn't. Each step's `ask` is the question that step tends to raise, handed to the assistant's Chat with one click
// ("Ask the assistant about this"): pre-filled in the composer and never sent, phrased as him because it lands in his
// box verbatim. Change a page's copy, change its step.
//
// `optional` marks a step whose anchor exists only with a feature on or with data: the Email card (email intelligence on
// and a mailbox pinned), the Slack catch-up (Slack intelligence "ok"), the chat (chat installed and on) and the Morning
// brief card (the brief's migration applied). The tour waits briefly for any anchor, then moves on, so a missing one is
// skipped, not a dead end.
//
// State lives in the URL (?tour=1&step=N), so a route change remounts the tour and it resumes where it was.

export type TourPlacement = "top" | "bottom" | "left" | "right";

export interface TourStep {
  /** The exec route this step lives on. The tour navigates there before showing it. */
  path: string;
  /** The anchor: always a [data-tour] attribute selector. */
  target: string;
  title: string;
  /** One or two short sentences about what the page shows. */
  body: string;
  /** What "Ask the assistant about this" puts in the Chat composer (never sent). */
  ask: string;
  /** Where the tooltip goes when there is room; it flips or moves aside when there isn't. */
  placement?: TourPlacement;
  /** The anchor needs a feature switched on or data to exist: skipped quietly when it isn't there. */
  optional?: boolean;
}

/** Where the tour starts, and the one page it starts itself on (once per browser). */
export const TOUR_HOME = "/executive";
/** Where "Ask the assistant about this" hands its question (?ask=, see lib/exec/chat/ask-prefill.ts). */
export const TOUR_CHAT_PATH = "/executive/chat";
/** localStorage key: set once the tour has been shown or closed in this browser, so it starts itself only once. */
export const TOUR_DONE_KEY = "dd.guidedTour.v1.done";

/** A tour URL: the step's page with the tour's two params. */
export function tourHref(path: string, step: number): string {
  return `${path}?tour=1&step=${step}`;
}

const anchor = (name: string) => `[data-tour="${name}"]`;

export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    path: "/executive",
    target: anchor("exec-header"),
    title: "Your assistant",
    // ExecHeader: the title, the Private pill, "Updated <time>", the tabs and the Settings gear.
    body: "The tabs move between the assistant's pages, and the gear opens Settings. Updated shows when this page's data was read.",
    ask: "Catch me up on everything important today",
    placement: "bottom"
  },
  {
    path: "/executive",
    target: anchor("exec-brief"),
    title: "Today's brief",
    // BriefCard takes TodayGlance's slot when a brief exists (today's, or before the brief time yesterday's); otherwise
    // TodayGlance's fixed sentences, labelled "From DD records, no AI". Both carry the anchor.
    body: "When a brief exists, this card shows its headline and your top 3, with a link to the full brief. Without one it sums up today from DD records, with no AI.",
    ask: "What are my top three priorities today, and why?",
    placement: "bottom"
  },
  {
    path: "/executive",
    target: anchor("exec-stats"),
    title: "Today in numbers",
    // OverviewTileRow: Completed today, Created today, Open overdue, Active people, EOD submitted, Hours logged (plus
    // Slack while Slack intelligence is on). A tile whose read failed shows "—" and "Couldn't load".
    body: "Tasks completed, created and overdue, active people, EOD reports and hours logged today. A number that couldn't load shows a dash, never a zero.",
    ask: "Who has overdue tasks, and how late are they?",
    placement: "bottom"
  },
  {
    path: "/executive",
    target: anchor("exec-attention"),
    title: "Needs attention",
    // AttentionRow: what happened, "Why it matters", "Suggested next step", facts and sources; FeedRowActions: Mark seen,
    // Snooze, Dismiss, Resolve (and Useful / Not useful).
    body: "Each row says what happened, why it matters and a suggested next step, with its sources. Snooze, Dismiss or Resolve it right on the row.",
    ask: "Which Needs Attention items are most urgent right now, and why?",
    placement: "right"
  },
  {
    path: "/executive/email",
    target: anchor("exec-email"),
    title: "Email, sorted",
    // EmailTabView's "Email" card: "Your mail from the last 30 days, sorted by the assistant", five buckets (Needs reply,
    // Urgent, Important, Waiting, Not assessed). A thread offers Draft reply while drafts are on; the draft page has Save
    // to Outlook, and once saved, "Review & send" opens a confirm dialog. Off or with no mailbox pinned the card isn't
    // there.
    body: "Your last 30 days of mail in five buckets, Needs reply first. Open a thread to draft a reply: Save to Outlook puts it in your Drafts, and sending is a separate step you confirm.",
    ask: "Which emails are waiting on my reply, most urgent first?",
    placement: "right",
    optional: true
  },
  {
    path: "/executive/slack",
    target: anchor("exec-slack"),
    title: "Slack catch-up",
    // SlackPageView with the intel state "ok": Catch-up beside Daily digests (the page intro's own words). In any other
    // state the page shows one sentence instead, and this step is skipped.
    body: "Catch-up lists what needs you in Slack, and the daily digests sum up each conversation by day. Summaries are AI-assessed; open Slack for the messages.",
    ask: "What's waiting on me in Slack?",
    placement: "top",
    optional: true
  },
  {
    path: "/executive/team",
    target: anchor("exec-team"),
    title: "Team workload",
    // TeamPageView: TEAM_INTRO and the "How these are measured" disclosure, above the Departments and People tables.
    body: "Workload and flow per department and person, from DD's records. Nothing here ranks people, and How these are measured defines every figure.",
    ask: "How is each department's workload looking this week?",
    placement: "bottom"
  },
  {
    path: "/executive/projects",
    target: anchor("exec-projects"),
    title: "Project health",
    // ProjectsListPageView: the filter bar (All, Needs attention, Has open work) over "Health from DD's records by fixed
    // rules, worst first".
    body: "Every DD project with its health from fixed rules, worst first. These filters narrow it to the ones that need attention or have open work.",
    ask: "Which projects are falling behind, and what's holding them up?",
    placement: "bottom"
  },
  {
    path: "/executive/chat",
    target: anchor("exec-chat"),
    title: "Ask anything",
    // ExecChat: "Ask about the company", answers with sources; a proposed task is created only on Confirm, and a draft
    // it starts is reviewed (and sent) by him from DD. Chat off or not installed: one line, and this step is skipped.
    body: "Ask about the company and get answers with their sources. A task it proposes is created only when you press Confirm, and a draft it starts is yours to review.",
    ask: "What can you do for me, and what won't you do without my say-so?",
    placement: "left",
    optional: true
  },
  {
    path: "/executive/settings",
    target: anchor("exec-settings"),
    title: "Your switches",
    // SettingsForm in the "Assistant settings" card: DD text triage, the Keep ... for fields, Daily AI budget, Learn my
    // writing style, Chat and its budget, Use the assistant for Ask AI. Each field is saved on its own.
    body: "Turn chat, DD text triage and learning your writing style on or off, and set how long things are kept and the daily AI budget. Each change is saved separately.",
    ask: "What do you do with my email, and do you ever send anything yourself?",
    placement: "right"
  },
  {
    path: "/executive/settings",
    target: anchor("exec-brief-settings"),
    title: "Morning brief",
    // BriefSettingsSection: Build a morning brief, Brief time, Time zone, Suggest check-ins, and sending it to Slack
    // instead of the 8am DD brief; saved with its own Save button.
    body: "Turn the morning brief on and set its time and time zone. You can also have it sent to you in Slack.",
    ask: "What would you put at the top of my brief right now?",
    placement: "left",
    optional: true
  },
  {
    path: "/executive/settings",
    target: anchor("exec-slack-settings"),
    title: "Slack",
    // SlackSection: Connect Slack (to ask in a DM) while not connected; Reconnect, Disconnect and the reading controls
    // (Read Slack, with its own confirmation) once connected.
    body: "Connect Slack here to ask the assistant in a direct message. Reading Slack is a separate switch, off until you turn it on.",
    ask: "What can you see in Slack, and what can't you?",
    placement: "left"
  }
]) as readonly TourStep[];
