// Facebook client onboarding — the shared definition of the checklist that
// sits on a Facebook department task (one task per client).
//
// Four phases, in order:
//   1. Access   — eight things the client has to clear before we can build.
//   2. Main zap — the Typeform Client Intake SOP as a step-by-step checklist.
//   3. Setup    — the Calendly + Failsafe zaps, our four Slack channels and the
//                 client's own notification delivery.
//   Main zap and Setup are soft-locked: visible and editable before access is
//   cleared, but flagged so nobody mistakes them for ready.
//   4. Test     — a scripted set of Typeform submissions run through the live
//               zaps. All must pass (or be N/A where allowed) before the
//               onboarding counts as complete.
//
// Nothing here alerts anyone. A blocked item is recorded with a note; it is on
// the onboarder to escalate it.
//
// Pure data + pure functions — imported by both the API route and the client
// panel, so no server-only imports.

// Marks a task as a Facebook client onboarding. Beyond labelling, it opens the
// task to the whole Facebook team even when a leader owns it (see
// taskViewReason) — the onboarding and its conversation are team work.
export const FB_ONBOARDING_TAG = "fb-onboarding";

export type EntryValue = boolean | string;
export interface Entry { v: EntryValue; by: string | null; at: string }
export type OnboardingState = Record<string, Entry>;

export type TestResult = "pass" | "fail" | "na";

interface Choice { key: string; label: string; options: { value: string; label: string }[] }
interface Check { key: string; label: string; hint?: string; optional?: boolean }
// `url` renders copy + open actions beside the field. `optional` keeps a
// field out of accessStatus's cleared test — it still renders and still
// saves, it just never holds the item back.
interface TextInput { key: string; label: string; placeholder?: string; url?: boolean; optional?: boolean }
// A variable-length list of named links. Stored as one JSON string rather
// than indexed keys because the count genuinely varies per client — some
// have two channels, some six — and indexed keys leave holes on delete.
interface ListInput { key: string; label: string; blurb?: string }

export interface AccessItem {
  id: string;
  label: string;
  blurb: string;
  choice?: Choice;
  checks: Check[];
  inputs?: TextInput[];
  lists?: ListInput[];
}

// Declared above ACCESS_ITEMS because the notify item references it.
export const SLACK_CHANNELS_KEY = "access.notify.slack_channels";

export const ACCESS_ITEMS: AccessItem[] = [
  {
    id: "zapier",
    label: "Zapier",
    blurb: "Where the zaps will live.",
    choice: {
      key: "access.zapier.mode",
      label: "Setup",
      options: [
        { value: "client_workspace", label: "Added to their workspace" },
        { value: "client_credentials", label: "Their credentials" },
        { value: "our_account", label: "Our account" }
      ]
    },
    checks: [{ key: "access.zapier.confirmed", label: "Logged in and can create zaps" }]
  },
  {
    id: "crm",
    label: "CRM",
    blurb: "Admin access, and proof Zapier can create a lead and attach insurance card pictures to it. If any step fails, access isn't cleared.",
    choice: {
      key: "access.crm.upload_mode",
      label: "Card upload works as",
      options: [
        { value: "file", label: "File upload (preferred)" },
        { value: "link", label: "Link only" }
      ]
    },
    checks: [
      { key: "access.crm.admin", label: "Admin access to the client's CRM" },
      { key: "access.crm.lead_created", label: "Created a test lead through Zapier" },
      { key: "access.crm.upload", label: "Uploaded card pictures to that lead through Zapier" }
    ]
  },
  {
    id: "calendly",
    label: "Calendly",
    blurb: "Whichever side hosts it, the org must be on a Team plan and able to run a round robin.",
    choice: {
      key: "access.calendly.mode",
      label: "Setup",
      options: [
        { value: "client_invites_us", label: "Client invites us to their workspace" },
        { value: "we_invite_client", label: "We set it up and invite the client" }
      ]
    },
    checks: [
      { key: "access.calendly.team_plan", label: "Org is on a Team plan" },
      { key: "access.calendly.round_robin", label: "Created a round robin event successfully" }
    ]
  },
  {
    id: "ctm",
    label: "CTM",
    blurb: "Access to start the first-time text flow. The number doesn't need to be cleared yet.",
    checks: [
      { key: "access.ctm.access_sent", label: "Access sent to henry@scaledai.org" },
      { key: "access.ctm.tracking_number", label: "Have a tracking number for first-time texts" },
      { key: "access.ctm.granted", label: "Access granted" }
    ],
    inputs: [{ key: "access.ctm.number", label: "Tracking number", placeholder: "+1…" }]
  },
  {
    id: "dashboard",
    label: "Dashboard",
    blurb: "The client's ad account feeding the dashboard, the client able to get into it, and their automated email report running.",
    choice: {
      key: "access.dashboard.report_cadence",
      label: "Email report sends",
      options: [
        { value: "daily", label: "Daily" },
        { value: "weekly", label: "Weekly" },
        { value: "monthly", label: "Monthly" }
      ]
    },
    checks: [
      { key: "access.dashboard.ad_account", label: "Ad account connected to the dashboard" },
      { key: "access.dashboard.client_login", label: "Client got their login and has signed in" },
      { key: "access.dashboard.report_on", label: "Automated email report scheduled on the dashboard" },
      { key: "access.dashboard.report_test", label: "Test report sent and arrived, with the right numbers in it" }
    ],
    inputs: [
      { key: "access.dashboard.link", label: "Dashboard link", placeholder: "https://…" },
      { key: "access.dashboard.report_to", label: "Report goes to", placeholder: "Client addresses on the report" }
    ]
  },
  {
    id: "ein",
    label: "EIN",
    blurb: "The client's Employer Identification Number, for ad account and billing setup.",
    checks: [],
    inputs: [{ key: "access.ein.number", label: "EIN", placeholder: "XX-XXXXXXX" }]
  },
  {
    id: "meta_account",
    label: "Meta account",
    blurb: "The ad account itself — its ID, what it spends monthly, and Meta's Trust Center verification.",
    checks: [
      { key: "access.meta_account.trust_submitted", label: "Trust Center verification submitted" },
      { key: "access.meta_account.trust_accepted", label: "Trust Center verification accepted" },
      { key: "access.meta_account.campaign_loaded", label: "Ad account loaded with campaign" }
    ],
    inputs: [
      { key: "access.meta_account.ad_account_id", label: "Ad account ID", placeholder: "act_…" },
      { key: "access.meta_account.monthly_spend", label: "Monthly spend", placeholder: "e.g. $5,000/mo" },
      { key: "access.meta_account.landing_page", label: "Landing page link", placeholder: "https://…", url: true },
      { key: "access.meta_account.typeform", label: "Typeform link", placeholder: "https://…", url: true },
      { key: "access.meta_account.account_metrics", label: "Account metrics link", placeholder: "https://…", url: true }
    ]
  },
  {
    id: "notify",
    label: "Notifications",
    blurb: "How the client hears about new Facebook leads — anything Zapier can post to.",
    choice: {
      key: "access.notify.channel",
      label: "Channel",
      options: [
        { value: "slack", label: "Slack" },
        { value: "email", label: "Email" },
        { value: "other", label: "Other" }
      ]
    },
    checks: [
      { key: "access.notify.reachable", label: "Zapier can post to it" },
      // Our own team's membership, not the client's access — optional so it
      // can't un-clear Notifications on every onboarding that already cleared.
      {
        key: "access.notify.team_added",
        label: "Team added to the Slack channels",
        hint: "Everyone working this client is in the lead channels",
        optional: true
      }
    ],
    inputs: [
      { key: "access.notify.target", label: "Where", placeholder: "Their Slack workspace / email address / tool" }
    ],
    lists: [
      {
        key: SLACK_CHANNELS_KEY,
        label: "Slack channels",
        blurb: "The channels for this client, so anyone can find them. A link opens the channel for people already in it — Slack has no link that adds someone to a private channel, so that is still Add people inside each one."
      }
    ]
  }
];

// A client's channels, as typed on the Notifications card. Free text: the
// names are chosen by hand per client (the Bright Paths channels are
// "bright-paths-…", not "bright-paths-recovery-…"), so nothing derives them.
export interface SlackChannel { name: string; url: string }
export const MAX_SLACK_CHANNELS = 12;

// Never throws: a malformed value reads as "no channels" rather than
// breaking every surface that renders the card.
export function parseChannels(raw: unknown): SlackChannel[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: SlackChannel[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().replace(/^#/, "").slice(0, 80) : "";
    const url = typeof r.url === "string" ? r.url.trim().slice(0, 300) : "";
    if (!name && !url) continue;
    out.push({ name, url });
    if (out.length >= MAX_SLACK_CHANNELS) break;
  }
  return out;
}

export const serialiseChannels = (list: SlackChannel[]): string =>
  JSON.stringify(list.filter((c) => c.name || c.url).slice(0, MAX_SLACK_CHANNELS));

export const channelsOf = (s: OnboardingState): SlackChannel[] => parseChannels(s[SLACK_CHANNELS_KEY]?.v);

export const blockedKey = (itemId: string) => `access.${itemId}.blocked`;
export const noteKey = (itemId: string) => `access.${itemId}.note`;

// Keys the list-page card reads/writes directly (its own compact "at a
// glance" block), independent of the full Access tab this same data also
// backs. Exported here, once, so the card and the tab never drift apart.
export const ZAPIER_MODE_KEY = "access.zapier.mode";
export const CRM_MODE_KEY = "access.crm.mode";
export const CALENDLY_MODE_KEY = "access.calendly.mode";
export const EIN_KEY = "access.ein.number";
export const AD_ACCOUNT_ID_KEY = "access.meta_account.ad_account_id";
export const MONTHLY_SPEND_KEY = "access.meta_account.monthly_spend";
export const LANDING_PAGE_KEY = "access.meta_account.landing_page";
export const TYPEFORM_LINK_KEY = "access.meta_account.typeform";
export const ACCOUNT_METRICS_KEY = "access.meta_account.account_metrics";
export const TRUST_SUBMITTED_KEY = "access.meta_account.trust_submitted";
export const TRUST_ACCEPTED_KEY = "access.meta_account.trust_accepted";
export const CAMPAIGN_LOADED_KEY = "access.meta_account.campaign_loaded";
export const CTM_GRANTED_KEY = "access.ctm.granted";
export const TEAM_ADDED_KEY = "access.notify.team_added";

// ---------------------------------------------------------------------------
// Launch — the actual campaign: where it runs, what it starts with, and the
// creative to run. Independent of the zap build, so it's soft-locked the
// same way Main zap and Setup are rather than gated behind Access.
// ---------------------------------------------------------------------------

export const CITIES_KEY = "launch.cities";
export const BUDGET_KEY = "launch.budget";
export const CREATIVES_KEY = "launch.creatives";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export const PROVIDER_KEY = "setup.provider";

export const ZAPS = [
  { id: "main", name: (p: string) => `${p} Facebook Zap Main`, blurb: "Built step by step in the Main Zap tab." },
  { id: "calendly", name: (p: string) => `${p} Calendly Zap`, blurb: "Call booked on Calendly → notification, plus any reminders the client asked for." },
  { id: "failsafe", name: (p: string) => `${p} Failsafe Zap`, blurb: "Either zap errors → internal alert in the failsafe channel." }
] as const;
export const zapBuiltKey = (id: string) => `setup.zap.${id}.built`;
export const zapUrlKey = (id: string) => `setup.zap.${id}.url`;

// ---------------------------------------------------------------------------
// Main zap — the Typeform Client Intake SOP, step by step.
// Labels and copy blocks may carry {Provider} / {slug}; the panel fills them.
// ---------------------------------------------------------------------------

// A step that only applies down one branch. The keys of a step whose condition
// is unmet are not counted AT ALL — the conditional-keys idiom setupKeys() uses
// for the notify channel — which is what lets the two delivery routes coexist:
// neither strands the other, and whichever one was actually chosen is genuinely
// required rather than merely suggested. `key` is a full state key.
export interface StepWhen { key: string; anyOf: string[] }

export interface SopStep {
  id: string;
  step: string;           // "Step 3", "Before you start", "QC"…
  title: string;
  blurb?: string;
  checks: Check[];
  choices?: Choice[];
  inputs?: TextInput[];
  copies?: { label: string; text: string }[];
  warn?: string;
  when?: StepWhen;
}

const DEDUP_HEADERS = ["submission token", "submission time", "name"].join("\t");

const COUNT_CODE = `const rowsRaw = inputData['rows'] ?? inputData.rows ?? '';

const count = String(rowsRaw)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')   // drop empty pieces (trailing commas, blanks)
  .length;

output = { count };`;

const AI_PROMPT = `Please create a concise summary based on the provided form
response. Focus on extracting key points and important
information, specifically the following questions "How ready
to go to treatment your are", "What type of treatment do you
require" and "What motivated you to reach out today?" to
ensure clarity and coherence.

KEEP THE SUMMARY UNDER 150 CHARACTERS

text: {raw text from the form fill out}`;

const SLACK_TEMPLATE = `@channel
*New Facebook Lead - VOB in {CRM}*
Name: {First name} {Last name}
DOB: {Date of birth}
Phone: {Step 9 — E.164 output}
Address: {Address}
Address 2: {Address line 2}
Insurance: {How do you receive your insurance}
Insurance Provider: {Insurance provider}
Substance: {Substance}
Front: {Front card — _file variant}
Back: {Back card — same _file variant}
Summary: {Step 10 — summary}`;

export const LEAD_SHEET_HEADERS = [
  "Are you looking for help with drug or alcohol use?",
  "Have you sought help for this in the past?",
  "What substance are you seeking help for?",
  "How do you receive your insurance?",
  "Please Select Your Insurance Provider",
  "Would you be able to provide a picture of your insurance information on this form?",
  "Please upload a clear picture of the front of your insurance card",
  "Please upload a clear picture of the back of your insurance card",
  "What is your date of birth",
  "First name",
  "Last name",
  "Phone number",
  "Email",
  "Address",
  "Address line 2",
  "City/Town",
  "State/Region/Province",
  "Zip/Post code",
  "Country",
  "Submitted At",
  "Token",
  "VOB"
];

export const MAIN_ZAP_STEPS: SopStep[] = [
  {
    id: "pre", step: "Before you start", title: "Prerequisites",
    checks: [
      { key: "accounts", label: "Client's Typeform and Google accounts connected in Zapier (or credentials on hand)" },
      { key: "sample", label: "Live Typeform has at least one real test submission to map from" },
      { key: "drive", label: "Access to the client's Google Drive folder for their sheets" }
    ],
    choices: [{
      key: "partials", label: "Partial submissions on the Typeform",
      options: [{ value: "on", label: "Enabled" }, { value: "off", label: "Disabled (count will almost always be 1)" }]
    }]
  },
  {
    id: "s1", step: "Step 1", title: "Create the deduplicator sheet",
    blurb: "Do this in Google Sheets before touching Zapier — the headers must exist or Zapier won't offer the columns.",
    checks: [
      { key: "created", label: "Created \"{Provider} - Deduplicator\" in the client's Drive folder" },
      { key: "headers", label: "Row 1 headers A–C: submission token · submission time · name", hint: "No blank or merged rows above them." },
      { key: "tab", label: "Tab left as Sheet1 (or renamed once, now — never again)" }
    ],
    inputs: [{ key: "url", label: "Deduplicator sheet URL", placeholder: "https://docs.google.com/spreadsheets/…" }],
    copies: [{ label: "Headers (paste into A1)", text: DEDUP_HEADERS }]
  },
  {
    id: "s2", step: "Step 2", title: "Trigger: Typeform → New Entry",
    checks: [
      { key: "trigger", label: "Typeform → New Entry on the client's connected account and intake form" },
      { key: "sample", label: "Trigger tested and a recent real entry kept selected as the sample" }
    ]
  },
  {
    id: "s3", step: "Step 3", title: "Google Sheets → Create Spreadsheet Row",
    blurb: "Logs the entry to the deduplicator so later runs can count it.",
    checks: [
      { key: "action", label: "Writes to \"{Provider} - Deduplicator\" / Sheet1" },
      { key: "mapped", label: "Mapped submission token ← Token, submission time ← Submitted At, name ← name field" },
      { key: "token", label: "Mapped token is the one shared by partial + complete entries, not an entry-specific ID" }
    ],
    warn: "An entry-specific ID makes every count 1 and the dedup does nothing."
  },
  {
    id: "s4", step: "Step 4", title: "Delay by Zapier → Delay For",
    checks: [{ key: "delay", label: "Delay For 10 minutes", hint: "Only longer if the client's form is unusually long." }]
  },
  {
    id: "s5", step: "Step 5", title: "Google Sheets → Lookup Spreadsheet Rows",
    checks: [
      { key: "action", label: "Used the plural / line-item Lookup Spreadsheet Rows action" },
      { key: "lookup", label: "Deduplicator / Sheet1, lookup column submission token = Token from Step 2" },
      { key: "all", label: "Return All Matches set to True" }
    ],
    warn: "The single-row lookup, or Return All Matches off, makes the count always 1."
  },
  {
    id: "s6", step: "Step 6", title: "Code by Zapier → count the matches",
    checks: [
      { key: "input", label: "Input Data key rows (lowercase) = the Row ID line-item field from Step 5" },
      { key: "code", label: "Code pasted exactly as written; output is count" }
    ],
    copies: [{ label: "JavaScript", text: COUNT_CODE }]
  },
  {
    id: "s7", step: "Step 7", title: "Filter — let one entry through",
    blurb: "Two condition groups joined by OR. \"+ AND\" adds to a group, \"+ OR\" starts a new one.",
    checks: [
      { key: "a", label: "Group A: count (Text) exactly matches 1" },
      { key: "b", label: "Group B (started with + OR): count (Number) greater than 1 AND time taken to complete Exists" }
    ]
  },
  {
    id: "s8", step: "Step 8", title: "Filter — require a phone number",
    checks: [{ key: "phone", label: "Separate filter step: Phone number Exists", hint: "Kept apart from Step 7 so Zap history shows which filter dropped a run." }]
  },
  {
    id: "s9", step: "Step 9", title: "Formatter → phone number to E.164",
    checks: [
      { key: "format", label: "Formatter → Phone Number → Format Phone Number, To Format E.164" },
      { key: "country", label: "Country code US (unless the client takes international traffic)" },
      { key: "downstream", label: "Every later step reads the Step 9 output, never the raw Typeform phone" }
    ]
  },
  {
    id: "s10", step: "Step 10", title: "AI by Zapier — lead summary",
    checks: [
      { key: "output", label: "Output field named summary" },
      { key: "prompt", label: "Prompt pasted verbatim (typo included) with the form response text mapped into {raw text…}" }
    ],
    copies: [{ label: "Prompt", text: AI_PROMPT }]
  },
  {
    id: "s11", step: "Step 11", title: "Paths by Zapier — VOB / Non-VOB",
    checks: [
      { key: "a", label: "Path A — VOB: Front card Exists AND Back card Exists" },
      { key: "b", label: "Path B — Non-VOB: Front card Does not exist AND Back card Does not exist" },
      { key: "dup", label: "Built Path A fully, then duplicated it into Path B and deleted the image upload", hint: "Never build the two independently — they drift." }
    ],
    choices: [{
      key: "one_card", label: "Only one card uploaded — agreed with the client",
      options: [
        { value: "non_vob", label: "Route to Non-VOB" },
        { value: "vob", label: "Route to VOB" },
        { value: "own_path", label: "Its own path" }
      ]
    }],
    warn: "A lead with one card matches neither path and vanishes silently unless this is handled."
  },
  {
    id: "s12", step: "Step 12", title: "Slack → notify the leads channel",
    checks: [
      { key: "action", label: "Slack → Send Channel Message, send as bot: Yes, include Zap link: No" },
      { key: "channels", label: "Path A → #{slug}-vob-leads, Path B → #{slug}-nonvob-leads" },
      { key: "fields", label: "Message rebuilt from this client's field picker — no IDs copied from another zap" },
      { key: "header", label: "Header bolded and reads VOB on Path A, Non-VOB on Path B" },
      { key: "files", label: "Front and Back use the same (_file) variant" },
      { key: "refs", label: "Phone reads the Step 9 output; Summary reads Step 10 summary" }
    ],
    choices: [{
      key: "b_cards", label: "Front / Back lines on the Path B message",
      options: [{ value: "kept", label: "Kept (blank)" }, { value: "stripped", label: "Stripped" }]
    }],
    copies: [{ label: "Message layout (pick each field fresh)", text: SLACK_TEMPLATE }]
  },
  {
    id: "s13", step: "Step 13", title: "CallTrackingMetrics → first text",
    blurb: "Zapier posts the lead into a CTM FormReactor; CTM sends the text.",
    checks: [
      { key: "reactor", label: "FormReactor created in CTM for this client's intake form" },
      { key: "first_text", label: "First text enabled on it, with the client-approved message" },
      { key: "creds", label: "Copied the FormReactor REST endpoint and API credentials" },
      { key: "post", label: "Webhooks by Zapier → POST to the endpoint, payload per CTM docs, CTM auth set" },
      { key: "data", label: "Data: phone = Step 9 E.164, name + email from Step 2" }
    ],
    warn: "A FormReactor without first text enabled returns 200 and sends nothing."
  },
  {
    id: "s14", step: "Step 14", title: "CRM → create the lead",
    checks: [
      { key: "action", label: "CRM → Create Record (Lead)" },
      { key: "basics", label: "First + last name, email, DOB and address from Step 2" },
      { key: "phone", label: "Phone = Step 9 E.164" },
      { key: "insurance", label: "Insurance type + provider and substance from Step 2" },
      { key: "notes", label: "Description / notes = Step 10 summary" },
      { key: "source", label: "Lead source = the client's campaign source (e.g. Facebook)" },
      { key: "vob", label: "VOB flag True on Path A, False on Path B" }
    ]
  },
  {
    id: "s14a", step: "Step 14a", title: "Path A only — upload the insurance cards",
    checks: [
      { key: "order", label: "Placed after Create Lead; related record = the Lead ID from Step 14" },
      { key: "files", label: "Front and back both uploaded (two steps if the action takes one file)" },
      { key: "names", label: "Files named predictably, e.g. lastname-insurance-front" }
    ]
  },
  {
    id: "s15", step: "Step 15", title: "Google Sheets → client lead sheet",
    blurb: "Every client gets their own lead sheet — never a shared one, never another client's.",
    checks: [
      { key: "created", label: "Created \"{Provider} - Leads\" in the client's Drive folder" },
      { key: "shared", label: "Shared with whoever on the client side needs to see leads" },
      { key: "headers", label: "All 22 headers pasted into row 1 in order before building the step" },
      { key: "action", label: "Create Spreadsheet Row into this client's Leads sheet / Sheet1 only" },
      { key: "mapping", label: "Phone (L) = Step 9 E.164; G + H mapped on both paths; Token (U) = the dedup token" },
      { key: "vob", label: "VOB column: Yes on Path A, No on Path B" }
    ],
    inputs: [{ key: "url", label: "Leads sheet URL", placeholder: "https://docs.google.com/spreadsheets/…" }],
    copies: [{ label: "22 headers (paste into A1)", text: LEAD_SHEET_HEADERS.join("\t") }]
  },
  {
    id: "qc", step: "QC", title: "Before going live",
    checks: [
      { key: "single", label: "One full live submission → exactly one deduplicator row, clears both filters" },
      { key: "partial", label: "Partial → abandon → complete: two rows land, only the completed run passes Step 7", hint: "Tick as done if partial submissions are disabled." },
      { key: "no_phone", label: "Submission with a blank phone stops at Step 8" },
      { key: "count", label: "Step 6 output in Zap History is a plain number (1, 2), not a string of row IDs" },
      { key: "e164", label: "Step 9 outputs +1XXXXXXXXXX and Steps 13, 14 and 15 all read it" },
      { key: "summary", label: "AI summary genuinely under 150 characters and reads cleanly in Slack" },
      { key: "paths", label: "Both paths tested: Slack, CTM text, CRM lead and sheet row on each; only Path A attaches images" },
      { key: "one_card", label: "One-image edge case tested and the client is happy with what it does" },
      { key: "handset", label: "CTM text actually arrived on a real handset (a 200 isn't proof)" },
      { key: "sheet", label: "Row landed in THIS client's lead sheet, 22 columns in order, VOB Yes/No correct" },
      { key: "live", label: "Zap turned on and named \"{Provider} Facebook Zap Main\"" }
    ]
  }
];

export const MAIN_ZAP_FAILURES: { symptom: string; cause: string }[] = [
  { symptom: "Count is always 1", cause: "Return All Matches not set to true, or the wrong lookup action was used" },
  { symptom: "Count is always 0 or blank", cause: "Input key is not spelled rows, or the wrong field was mapped into it" },
  { symptom: "Every run passes the filter", cause: "Conditions were added as OR when they should have been AND inside Group B" },
  { symptom: "No runs pass the filter", cause: "Group A and Group B were built as one AND group instead of two OR groups" },
  { symptom: "Duplicates still get through", cause: "The mapped submission token is unique per entry rather than shared across partial and complete" },
  { symptom: "Lead vanishes after Step 11", cause: "Only one of the two insurance card images was uploaded, so neither path matched" },
  { symptom: "CTM sends nothing but Zapier shows success", cause: "Posted to a FormReactor that does not have first text enabled" },
  { symptom: "Insurance images missing from the CRM record", cause: "Step 14a ran before the Lead was created, or the Lead ID was not mapped from Step 14" },
  { symptom: "Slack message shows blanks", cause: "Field IDs were copied from another client's Zap instead of re-picked" },
  { symptom: "Leads from two clients in one sheet", cause: "The Zap was duplicated for a new client without repointing Steps 1 and 15 at the new client's spreadsheets" }
];

// ---------------------------------------------------------------------------
// Scaled Sync — standing the client's CRM up, and pointing their Typeform at it.
//
// Only for clients whose CRM *is* Scaled Sync (crm.scaledai.org). That is the
// whole reason this phase is gated on SYNC_PLATFORM_KEY rather than always
// counted: plenty of Facebook clients run Kipu, BestNotes or a sheet, and a
// phase they can never finish would hold `progress().complete` false forever —
// which the API route turns into a CLEARED completed_at on the next PATCH
// (route.ts's reconcileCompletedAt), knocking a live client back off the board.
// An unanswered gate contributes zero keys, so adding this phase cannot move
// any onboarding that already exists. Same conditional-keys idiom as
// setupKeys()'s notify channel.
//
// Two halves, in dependency order: the org has to exist before there is a
// webhook URL to give Typeform.
// ---------------------------------------------------------------------------

export const SYNC_PLATFORM_KEY = "sync.platform";

// The gate. "other" is a real answer, not a skip — it records that somebody
// checked, which is why it reads differently from the unanswered state.
export const SYNC_PLATFORM_OPTIONS = [
  { value: "scaled_sync", label: "Scaled Sync" },
  { value: "other", label: "Another CRM" }
] as const;

export const syncKey = (stepId: string, key: string) => `sync.${stepId}.${key}`;

const SYNC_URL_SHAPE = `https://<project-ref>.supabase.co/functions/v1/typeform-intake/<hook-id>`;

// Everything a Typeform has to ask to fill a lead the way the Facebook build
// expects. Not a paste-in block like the zap's sheet headers — Typeform
// questions are authored in Typeform — so it is a checklist to read against
// the client's live form before mapping.
export const SYNC_REQUIRED_ANSWERS = [
  "First name",
  "Last name",
  "Phone number",
  "Email",
  "Date of birth",
  "What substance are you seeking help for?",
  "How do you receive your insurance?",
  "Please Select Your Insurance Provider",
  "Front of insurance card (file upload)",
  "Back of insurance card (file upload)"
];

export const SYNC_STEPS: SopStep[] = [
  {
    id: "pre", step: "Before you start", title: "Prerequisites",
    blurb: "All of this is Scaled Sync's own admin — none of it touches Zapier yet.",
    checks: [
      { key: "email", label: "A mailbox you control for the owner login, and you can open mail sent to it" },
      { key: "form", label: "The client's live Typeform is published and you can edit its Connect panel" },
      { key: "number", label: "Know the sending number this client will text from, or that it is not ready yet", hint: "Not having one is fine — the automated first text stays off until it is." }
    ]
  },
  {
    id: "a1", step: "Step 1", title: "Sign up the owner account",
    blurb: "Self-serve at /signup on the CRM. A brand-new account can see nothing at all until it has an org, so this is safe to do before anything else exists.",
    checks: [
      { key: "signed_up", label: "Signed up at the CRM's /signup (email + password, or Google)" },
      { key: "confirmed", label: "Confirmed the address from the email before going further", hint: "Open the link in the email itself — it decides which host your session lands on." }
    ],
    inputs: [
      { key: "crm_url", label: "CRM sign-in URL used", placeholder: "the host you actually signed in on", url: true },
      { key: "owner_email", label: "Owner login", placeholder: "who the org will belong to" }
    ],
    warn: "create_organization refuses an unconfirmed account. Confirm the address first or Step 2 fails with no useful error."
  },
  {
    id: "a2", step: "Step 2", title: "Create the organization",
    blurb: "The wizard's first screen asks for the business name. Whoever runs it becomes the owner of the new org, whatever role they hold anywhere else.",
    checks: [
      { key: "created", label: "Created the org and it is named as the client wants to be known" },
      { key: "name_check", label: "Name is what leads should see in an automated text, not an internal shorthand" }
    ],
    inputs: [{ key: "org_url", label: "Org (paste the URL once you are inside)", placeholder: "https://crm.scaledai.org/…", url: true }],
    choices: [{
      key: "route", label: "How you got to the wizard",
      options: [
        { value: "first_org", label: "First org on a fresh login" },
        { value: "additional", label: "Additional org (/onboarding?new=1)" }
      ]
    }],
    warn: "ONE LOGIN CAN OWN ONLY THREE ORGS. The fourth fails with a bare “organization limit reached”, and suspended orgs still count — so don't create every client under the same personal login. Also: already a member somewhere? /onboarding bounces you to the dashboard; /onboarding?new=1 is the only way to start another tenant."
  },
  {
    id: "a3", step: "Step 3", title: "The essentials",
    blurb: "Second wizard screen. Every field is optional and editable later in Settings; pipeline stages, lead sources and dispositions are already seeded.",
    checks: [
      { key: "line", label: "Sending number entered, or deliberately left blank" },
      { key: "auto_text_known", label: "Know that the automated first text is OFF until somebody turns it on" }
    ],
    warn: "auto_first_text_enabled defaults false on purpose — a new org has no verified line and no carrier registration. Nothing you do in this wizard starts sending SMS."
  },
  {
    id: "a4", step: "Step 4", title: "Add the people",
    blurb: "Settings > Team. Everyone gets their own login; nobody shares the owner account.",
    checks: [
      { key: "team", label: "Invited the client's staff who need the CRM, each with the right role", hint: "Settings > Team > Create invitation." },
      { key: "us", label: "Whoever on our side supports this client is in too" },
      { key: "owner_kept", label: "At least one owner login we control is kept" }
    ],
    warn: "Invitations are the only way in: “Add account with password” is not released yet, so don't go looking for it. Roles are owner, admin and member. Settings > Integrations is OWNER-ONLY — an admin cannot connect the Typeform, so the person doing the next half has to be an owner of this org."
  },
  {
    id: "b1", step: "Step 5", title: "Copy the webhook URL",
    blurb: "Settings > Integrations, the “Intake form (Typeform)” card. The URL is already there — org creation mints the routing id up front precisely so you have somewhere to point Typeform before any secret exists.",
    checks: [
      { key: "found", label: "Opened Settings > Integrations as an owner and found the Typeform card" },
      { key: "copied", label: "Copied the Webhook URL from that card — not typed from this page" }
    ],
    inputs: [{ key: "hook_url", label: "Webhook URL for this org", placeholder: SYNC_URL_SHAPE, url: true }],
    copies: [{ label: "Shape (yours is on the card — copy that one)", text: SYNC_URL_SHAPE }],
    warn: "A bare /typeform-intake with no id on the end is the one URL that breaks as soon as a second client exists. The URL must end in this org's hook id."
  },
  {
    id: "b2", step: "Step 6", title: "Save the signing secret — in the CRM first",
    blurb: "You choose this value; Typeform does not generate it. Saving it here before you touch Typeform is what stops the first real submissions from being thrown away.",
    checks: [
      { key: "generated", label: "Generated a long random string (20+ bytes of hex, nothing guessable)" },
      { key: "saved_crm", label: "Pasted it into “Webhook signing secret” on the Typeform card and saved", optional: true, hint: "Direct route only — the Zap route’s secret lives on its own card, in Step 7b." },
      { key: "stored", label: "Kept a copy where the team can find it — it is never readable back out of the CRM" }
    ],
    warn: "Until a signing secret exists the endpoint answers 401 and the submission is GONE — not queued, not retried into the CRM. Secret first, webhook second.",
    choices: [{
      key: "route", label: "How submissions will reach us",
      options: [
        { value: "native", label: "Typeform posts to us directly" },
        { value: "zap", label: "Forwarded by a Zap" },
        { value: "both", label: "Both" }
      ]
    }]
  },
  {
    id: "b3", step: "Step 7", title: "Add the webhook in Typeform",
    blurb: "Only when Typeform posts to us directly — pick that route in Step 6 and this step starts counting. In the form's Connect panel > Webhooks > Add a webhook: paste the URL, then open the webhook again and put the SAME secret in its Secret field.",
    checks: [
      { key: "added", label: "Webhook added with this org's URL as the destination" },
      { key: "secret_match", label: "Secret field holds the identical string saved in Step 6" },
      { key: "enabled", label: "Webhook toggled on, and SSL verification left on" },
      { key: "real_test", label: "Proved it with a real submission, not Typeform's Test button", hint: "Test sends sample data that need not match the live form, so it can pass while real entries fail — and fail while they would work." }
    ],
    when: { key: "sync.b2.route", anyOf: ["native", "both"] },
    warn: "A secret that differs by one character fails exactly like a missing one: a 401 on every submission, with nothing in the CRM to show it happened."
  },
  {
    id: "b3z", step: "Step 7b", title: "Forwarded by a Zap instead",
    blurb: "Only when a Zap forwards the submissions — pick that route in Step 6. A Zap cannot compute Typeform's signature, so it authenticates with a bearer secret on a SEPARATE card: “Intake form via Zapier (Typeform)”.",
    checks: [
      { key: "own_card", label: "Used the Zapier card, NOT the Typeform card above" },
      { key: "partner_secret", label: "Saved any long random string as the partner secret, which creates that card's private URL" },
      { key: "posts_to", label: "Zap POSTs to that private URL" },
      { key: "bearer", label: "Zap sends an Authorization header reading Bearer <the partner secret>" }
    ],
    inputs: [{ key: "url", label: "Private URL (Zapier)", placeholder: "the card's private URL", url: true }],
    when: { key: "sync.b2.route", anyOf: ["zap", "both"] },
    warn: "Saving the partner secret on the Typeform card instead REPLACES the signing secret, and the direct webhook starts answering 401 on every submission with nothing to show why. Two cards, two secrets, rotated independently."
  },
  {
    id: "b4", step: "Step 8", title: "Personal access token — only for file uploads",
    blurb: "Typeform posts a LINK to an uploaded file, not the file. Without a token the CRM cannot fetch an insurance card, so the lead arrives with no images.",
    checks: [
      { key: "created", label: "Token created in Typeform: Account > Personal tokens > Generate a new token" },
      { key: "scope", label: "Scope includes responses:read" },
      { key: "saved", label: "Pasted into “Personal access token” on the same Typeform card and saved" }
    ],
    warn: "Typeform shows the token once. Lose it before saving it here and you generate a new one — there is no way to read it back."
  },
  {
    id: "b5", step: "Step 9", title: "Send one real test response",
    blurb: "Do this BEFORE mapping. The field list the mapper offers is built from what a submission actually carried — the catalogue is empty until the form has been submitted at least once.",
    checks: [
      { key: "submitted", label: "Submitted the live form once, answering every question including both card uploads" },
      { key: "landed", label: "The lead appeared in the CRM" },
      { key: "questions", label: "Read the client's form against the answer list below and know what is missing" }
    ],
    copies: [{ label: "Answers the Facebook build expects", text: SYNC_REQUIRED_ANSWERS.join("\n") }],
    warn: "No submission yet means the mapping screen shows an empty list and there is nothing to map. This is the step people skip and then report the mapper as broken."
  },
  {
    id: "b6", step: "Step 10", title: "Map the fields",
    blurb: "Bottom of Settings > Integrations. One list of the form's questions, each pointed at where it should land on the lead.",
    checks: [
      { key: "identity", label: "First name, last name, phone, email and date of birth all mapped" },
      { key: "clinical", label: "Substance, insurance type and insurance provider mapped" },
      { key: "files", label: "Both insurance card uploads mapped" },
      { key: "unmapped", label: "Looked at what is left unmapped and confirmed none of it matters" },
      { key: "saved", label: "Saved, then reloaded and confirmed the choices stuck" },
      { key: "form_id", label: "Left the form-ID field alone unless you have a reason to pin it", hint: "A pinned ID that stops matching the form rejects every submission as “invalid signature” — pointing at the secret, which is fine." }
    ],
    warn: "Mapping is per-question-reference. Rebuilding or duplicating the Typeform gives its questions new references and silently un-maps everything — re-map after any form rebuild."
  },
  {
    id: "b7", step: "Step 11", title: "Consent and partial responses",
    blurb: "Whether a submission on its own counts as permission to text is an org setting with no UI. It is off for every new org, so hand this to engineering with a decision from the client.",
    checks: [
      { key: "asked", label: "Asked the client whether the form itself carries an SMS-consent question" },
      { key: "decided", label: "Got a decision on whether submitting the form counts as consent" },
      { key: "handed_over", label: "Handed the decision to engineering — it is a SQL change, not a toggle" }
    ],
    choices: [{
      key: "policy", label: "What was agreed",
      options: [
        { value: "form_asks", label: "The form asks for consent — nothing to set" },
        { value: "implied", label: "Submitting implies consent — needs the setting on" },
        { value: "none", label: "No automated texts from this form" }
      ]
    }],
    warn: "A consent question the form really asks always wins, in BOTH directions — a recorded “No” is honoured no matter what the org setting says. And a partial response with no phone number is dropped, by design."
  },
  {
    id: "qc", step: "QC", title: "Before handing over",
    checks: [
      { key: "end_to_end", label: "A fresh submission creates a lead with every mapped field populated" },
      { key: "images", label: "Both insurance card images are attached to that lead and open" },
      { key: "once", label: "Exactly ONE lead per submission — no duplicate from a second delivery route" },
      { key: "phone_format", label: "Phone landed in a shape the team can dial" },
      { key: "intake_ticked", label: "“Connect lead intake” is ticked on the CRM's own setup checklist" },
      { key: "owner_access", label: "The client can sign in, see the lead, and knows who to ask for help" },
      { key: "zap_crm_step", label: "If the main zap also writes to this CRM, Step 14 points at THIS org" }
    ],
    warn: "Wiring the native webhook AND a Zap for the same form means two deliveries of every submission. Only do both deliberately."
  }
];

export const SYNC_FAILURES: { symptom: string; cause: string }[] = [
  { symptom: "Every submission 401s", cause: "No signing secret saved yet, or the string in Typeform does not match the one in the CRM" },
  { symptom: "Nothing arrives and there is no error anywhere", cause: "The webhook URL is missing this org's hook id on the end" },
  { symptom: "Leads arrive but the mapping screen is empty", cause: "The form has never been submitted, so there is no captured field catalogue to map from" },
  { symptom: "Mapping was correct and silently stopped working", cause: "The Typeform was rebuilt or duplicated, giving every question a new reference" },
  { symptom: "Lead arrives with no insurance card images", cause: "No personal access token saved, or its scope is missing responses:read" },
  { symptom: "The native webhook starts 401ing right after wiring up Zapier", cause: "The Zap's partner secret was saved on the Typeform card instead of the separate Zapier card, replacing the signing secret" },
  { symptom: "Two leads, or two copies of each photo, per submission", cause: "Typeform posts directly AND a Zap forwards the same submission" },
  { symptom: "No first text on any lead", cause: "The form asks no consent question and the org's submission-implies-consent setting was never turned on" },
  { symptom: "401 invalid signature, and the secret is definitely right", cause: "A form ID is pinned on the org and no longer matches the form being submitted — the same 401 covers both" },
  { symptom: "Typeform's Test webhook passes but real entries never arrive", cause: "Test posts sample data; it proves the URL and secret, not the field mapping" },
  { symptom: "The webhook silently turned itself off", cause: "Typeform disables a webhook after a 404 or 410 — usually the URL lost its hook id or the function was removed" },
  { symptom: "Someone on the client side cannot open Integrations", cause: "They are an admin, not an owner — that screen is owner-only" },
  { symptom: "The wizard will not let you create the client's org", cause: "You are already a member of one; reach it at /onboarding?new=1" },
  { symptom: "organization limit reached", cause: "That login already owns three orgs — suspended ones still count; create it from a different login" }
];

export const mainKey = (stepId: string, key: string) => `main.${stepId}.${key}`;

// Every key a step needs filled for it to count as done. Parameterised by the
// key builder so the two step-by-step SOPs cannot drift on what "done" means —
// a choice counts as text because an unanswered one is the empty string.
// `optional` is honoured here for the same reason accessStatus honours it: a
// step that only applies on one route (Typeform posting to us vs a Zap
// forwarding it) would otherwise strand every client on the other route, hold
// progress().complete false and let the API route clear a completed_at. Before
// this the flag existed on Check/TextInput but did nothing inside a
// step-by-step SOP — only accessStatus read it. An optional entry still renders
// and still saves; it just never counts.
export function stepKeys(
  st: SopStep,
  keyFor: (stepId: string, key: string) => string
): { key: string; kind: "check" | "text" }[] {
  return [
    ...st.checks.filter((c) => !c.optional).map((c) => ({ key: keyFor(st.id, c.key), kind: "check" as const })),
    ...(st.choices ?? []).map((c) => ({ key: keyFor(st.id, c.key), kind: "text" as const })),
    ...(st.inputs ?? []).filter((i) => !i.optional).map((i) => ({ key: keyFor(st.id, i.key), kind: "text" as const }))
  ];
}

export const mainStepKeys = (st: SopStep) => stepKeys(st, mainKey);

export function fillTokens(text: string, provider: string): string {
  return text
    .replace(/\{Provider\}/g, provider || "{Provider}")
    .replace(/\{slug\}/g, channelSlug(provider) || "{provider}");
}

// Suffixes match the live Scaledai workspace (checked against Bright Paths
// Recovery: bright-paths-vob-leads / -nonvob-leads / -calendly / -zap-errors).
// These are a SUGGESTION, not the truth: the real slug is shortened by hand
// ("bright-paths" from "Bright Paths Recovery"), so what a client actually
// has is whatever is typed into the Notifications card's channel list.
export const SLACK_CHANNELS = [
  { id: "vob", suffix: "vob-leads", blurb: "All VOB leads" },
  { id: "non_vob", suffix: "nonvob-leads", blurb: "All non-VOB leads" },
  { id: "calendly", suffix: "calendly", blurb: "Bookings and reminder notifications" },
  { id: "failsafe", suffix: "zap-errors", blurb: "Zap error notifications" }
] as const;
export const slackKey = (id: string) => `setup.slack.${id}`;

// The client-side mirror of our channels, minus failsafe (that one is internal).
export const CLIENT_STREAMS = SLACK_CHANNELS.filter((c) => c.id !== "failsafe");
export const clientKey = (channel: string, id: string) => `setup.client.${channel}.${id}`;
export const CLIENT_OTHER_KEY = "setup.client.other.wired";

export function channelSlug(provider: string): string {
  return provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Test dataset — submitted through the client's live Typeform.
// ---------------------------------------------------------------------------

export const TEST_PHONE_NOTE =
  "Use a team phone you can receive texts on — the CTM text has to actually arrive.";

// The client's intake form, question by question, with the default test answer.
// Cases below override individual answers.
export const TYPEFORM_BASE: { q: string; a: string }[] = [
  { q: "Are you looking for help with drug or alcohol use?", a: "Yes" },
  { q: "What kind of support, if any, have you had in the past?", a: "None" },
  { q: "What kind of addiction or substance do you want help with?", a: "Alcohol" },
  { q: "How do you receive your insurance?", a: "Through Employer" },
  { q: "Let’s see what your insurance can cover.", a: "Aetna" },
  { q: "First name", a: "Test" },
  { q: "Last name", a: "Test" },
  { q: "Phone number", a: "<team test phone, with +1>" },
  { q: "Email", a: "test@teser.com" },
  { q: "Can you share a photo of your insurance card?", a: "Yes" },
  { q: "Please upload a clear picture of the front of your insurance card", a: "<dummy card image — never a real card>" },
  { q: "Please upload a clear picture of the back of your insurance card", a: "<dummy card image — never a real card>" },
  { q: "What motivated you to reach out today?", a: "Onboarding test" },
  { q: "What is your date of birth", a: "1990-01-01" },
  { q: "Address", a: "test" },
  { q: "Address line 2", a: "test" },
  { q: "City/Town", a: "test" },
  { q: "State/Region/Province", a: "test" },
  { q: "Zip/Post Code", a: "10001" },
  { q: "Country", a: "usa" }
];

export interface TestCase {
  id: string;
  title: string;
  why: string;
  // Question text -> answer. "(skip)" means leave it blank / not reached.
  answers?: Record<string, string>;
  steps?: string[];
  expect: string[];
  // Optional cases may be marked N/A (e.g. the form forces both card uploads).
  optional?: string;
}

const Q = {
  last: "Last name",
  phone: "Phone number",
  share: "Can you share a photo of your insurance card?",
  front: "Please upload a clear picture of the front of your insurance card",
  back: "Please upload a clear picture of the back of your insurance card",
  why: "What motivated you to reach out today?"
};

export function testCases(slug: string): TestCase[] {
  const ch = (suffix: string) => `#${slug || "{provider}"}-${suffix}`;
  return [
    {
      id: "vob",
      title: "VOB lead — both cards",
      why: "The main happy path, end to end.",
      answers: { [Q.last]: "VOB", [Q.why]: "Onboarding test — VOB path, ready to start treatment this week" },
      expect: [
        `Exactly one post in ${ch("vob-leads")} with the VOB header and @channel, every field filled`,
        "AI summary is present and under 150 characters",
        "Phone shows in E.164 (+1XXXXXXXXXX) in Slack and the CRM",
        "Lead created in the client's CRM with the right name, DOB, phone, insurance and substance",
        "Front and back card images attached to that lead (as files, or links if that's what was agreed)",
        "First-time text arrives from the CTM tracking number",
        "Row appended to the client lead sheet",
        "The client got the notification on their channel"
      ]
    },
    {
      id: "non_vob",
      title: "Non-VOB lead — no cards",
      why: "The second path, and that it stays out of the VOB channel.",
      answers: {
        [Q.last]: "NonVOB",
        [Q.share]: "No",
        [Q.front]: "(skip)",
        [Q.back]: "(skip)",
        [Q.why]: "Onboarding test — non-VOB path"
      },
      expect: [
        `Exactly one post in ${ch("nonvob-leads")} with the Non-VOB header — nothing in ${ch("vob-leads")}`,
        "Lead created in the CRM, with no image upload attempted",
        "First-time text arrives",
        "Row appended to the client lead sheet",
        "The client got the notification on their channel"
      ]
    },
    {
      id: "one_card",
      title: "Only one card uploaded",
      why: "The SOP's known gap: a lead matching neither path falls out silently.",
      answers: { [Q.last]: "OneCard", [Q.back]: "(skip)", [Q.why]: "Onboarding test — front card only" },
      expect: [
        "Lead lands in whichever path was agreed with the client (default: non-VOB)",
        "Zap history does NOT show the run stopping with no path matched"
      ],
      optional: "N/A if the form won't let you skip the back card."
    },
    {
      id: "dedupe",
      title: "Duplicate — partial, then complete",
      why: "Proves the deduplicator lets exactly one run through.",
      answers: { [Q.last]: "Dedupe", [Q.why]: "Onboarding test — dedupe" },
      steps: [
        "Fill the form through Email, then close the tab without submitting.",
        "Within a few minutes, reopen the same link in the same browser and finish it.",
        "Wait out the 10-minute delay before checking."
      ],
      expect: [
        "Deduplicator sheet has 2 rows with the same submission token",
        "Exactly one Slack post, one CRM lead and one text",
        "The other run shows as filtered in Zap history"
      ],
      optional: "N/A if partial submissions are off on the Typeform."
    },
    {
      id: "phone_format",
      title: "Phone typed without the country code",
      why: "The formatter step has to normalise whatever the lead types.",
      answers: {
        [Q.last]: "PhoneFormat",
        [Q.phone]: "<team test phone, local format, no +1>",
        [Q.share]: "No",
        [Q.front]: "(skip)",
        [Q.back]: "(skip)",
        [Q.why]: "Onboarding test — phone format"
      },
      expect: [
        "Phone is E.164 in Slack, the CRM and the lead sheet",
        "The CTM text still arrives"
      ]
    },
    {
      id: "calendly",
      title: "Calendly booking",
      steps: ["Book a slot on the round robin event as Test VOB (same email as the VOB case)."],
      why: "Calendly zap, round robin assignment and reminders.",
      expect: [
        `Post in ${ch("calendly")} with the lead and the booked time`,
        "Booking went to a host through round robin",
        "The client got the booking notification",
        "Any reminders the client asked for fire on schedule"
      ]
    },
    {
      id: "failsafe",
      title: "Failsafe fires",
      why: "An error has to reach the team, not die quietly in Zap history.",
      steps: [
        "Temporarily break a step in the Main zap (e.g. an invalid CRM field) and submit a non-VOB style entry.",
        "Do the same for the Calendly zap with a test booking.",
        "Restore both zaps and replay the failed runs."
      ],
      expect: [
        `An error post in ${ch("zap-errors")} for each zap, naming which zap failed`,
        "Both replays go through cleanly after the fix"
      ]
    },
    {
      id: "cleanup",
      title: "Clean up test data",
      why: "The client shouldn't be working test leads.",
      steps: [
        "Delete the test leads from the client's CRM.",
        "Delete the test rows from the deduplicator and lead sheets.",
        "Cancel the test Calendly booking.",
        "Tell the client the test notifications they saw were tests."
      ],
      expect: ["No test data left anywhere the client works"]
    }
  ];
}

export const testResultKey = (id: string) => `test.${id}.result`;
export const testNoteKey = (id: string) => `test.${id}.note`;

// ---------------------------------------------------------------------------
// Onboarding-level flags
// ---------------------------------------------------------------------------
//
// One of each per onboarding, settable in ANY stage. These are NOT the six
// access.<id>.blocked flags, which stay exactly as they are: those say "this
// one access item is stuck", these say "the whole thing is parked" / "the ball
// is with them".
//
// Both are ordinary state keys, so they inherit the generic { v, by, at }
// stamp the PATCH route applies to every write. That is why there is no
// hold_since column: state[HOLD_KEY].at IS "held since", and .by is who
// paused it.

// Who the ball is with. "" is a REAL, reachable value, not an absence:
// fb_onboarding_set only ever MERGES, there is no key-deletion path, so
// clearing the flag means writing "". testResultKey registers "" for the
// same reason.
export const WAITING_ON_KEY = "waiting.on";
export const WAITING_NOTE_KEY = "waiting.note";
export type WaitingOn = "" | "us" | "client";

// Manual pause. "Not on hold" is { v: false }, never key-absent.
export const HOLD_KEY = "hold.active";
export const HOLD_NOTE_KEY = "hold.note";

// Answers for one case, question order preserved, ready to paste or read off.
export function caseAnswers(tc: TestCase): { q: string; a: string }[] {
  return TYPEFORM_BASE.map(({ q, a }) => ({ q, a: tc.answers?.[q] ?? a }));
}

// ---------------------------------------------------------------------------
// Key registry — the API only accepts these.
// ---------------------------------------------------------------------------

type KeyKind = { kind: "check" } | { kind: "text" } | { kind: "choice"; options: string[] } | { kind: "list" };

function buildRegistry(): Map<string, KeyKind> {
  const r = new Map<string, KeyKind>();
  for (const it of ACCESS_ITEMS) {
    if (it.choice) r.set(it.choice.key, { kind: "choice", options: it.choice.options.map((o) => o.value) });
    for (const c of it.checks) r.set(c.key, { kind: "check" });
    for (const i of it.inputs ?? []) r.set(i.key, { kind: "text" });
    for (const l of it.lists ?? []) r.set(l.key, { kind: "list" });
    r.set(blockedKey(it.id), { kind: "check" });
    r.set(noteKey(it.id), { kind: "text" });
  }
  r.set(CITIES_KEY, { kind: "text" });
  r.set(BUDGET_KEY, { kind: "text" });
  r.set(CREATIVES_KEY, { kind: "text" });
  r.set(PROVIDER_KEY, { kind: "text" });
  // CRM has no granted/our-account choice on the Access tab (its existing
  // `choice` slot is taken by upload_mode) — this is card-only, same shape
  // as Zapier's, standalone rather than borrowed from an AccessItem.
  r.set(CRM_MODE_KEY, { kind: "choice", options: ["granted", "our_account", ""] });
  for (const z of ZAPS) {
    r.set(zapBuiltKey(z.id), { kind: "check" });
    r.set(zapUrlKey(z.id), { kind: "text" });
  }
  for (const st of MAIN_ZAP_STEPS) {
    for (const c of st.checks) r.set(mainKey(st.id, c.key), { kind: "check" });
    for (const c of st.choices ?? []) r.set(mainKey(st.id, c.key), { kind: "choice", options: c.options.map((o) => o.value) });
    for (const i of st.inputs ?? []) r.set(mainKey(st.id, i.key), { kind: "text" });
  }
  r.set(SYNC_PLATFORM_KEY, { kind: "choice", options: [...SYNC_PLATFORM_OPTIONS.map((o) => o.value), ""] });
  for (const st of SYNC_STEPS) {
    for (const c of st.checks) r.set(syncKey(st.id, c.key), { kind: "check" });
    for (const c of st.choices ?? []) r.set(syncKey(st.id, c.key), { kind: "choice", options: c.options.map((o) => o.value) });
    for (const i of st.inputs ?? []) r.set(syncKey(st.id, i.key), { kind: "text" });
  }
  for (const c of SLACK_CHANNELS) r.set(slackKey(c.id), { kind: "check" });
  for (const ch of ["slack", "email"]) for (const s of CLIENT_STREAMS) r.set(clientKey(ch, s.id), { kind: "check" });
  r.set(CLIENT_OTHER_KEY, { kind: "check" });
  // Test ids don't depend on the slug, so any slug works to enumerate them.
  for (const t of testCases("")) {
    r.set(testResultKey(t.id), { kind: "choice", options: ["pass", "fail", "na", ""] });
    r.set(testNoteKey(t.id), { kind: "text" });
  }
  // Onboarding-level flags. A choice rather than a check for "waiting on":
  // a boolean would collapse "nobody has flagged this" into "waiting on us",
  // because isOn() is false for both an absent key and an explicit false.
  r.set(WAITING_ON_KEY, { kind: "choice", options: ["us", "client", ""] });
  r.set(WAITING_NOTE_KEY, { kind: "text" });
  r.set(HOLD_KEY, { kind: "check" });
  r.set(HOLD_NOTE_KEY, { kind: "text" });
  return r;
}

const REGISTRY = buildRegistry();

// Validates and normalises a value for `key`. null = reject.
export function normaliseValue(key: string, value: unknown): EntryValue | null {
  const k = REGISTRY.get(key);
  if (!k) return null;
  if (k.kind === "check") return typeof value === "boolean" ? value : null;
  if (typeof value !== "string") return null;
  if (k.kind === "text") return value.trim().slice(0, 500);
  // Re-serialised from the parsed form, so whatever is stored is always
  // canonical, capped and free of extra fields — never the raw client string.
  if (k.kind === "list") return serialiseChannels(parseChannels(value));
  return k.options.includes(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const isOn = (s: OnboardingState, key: string) => s[key]?.v === true;
const str = (s: OnboardingState, key: string) => (typeof s[key]?.v === "string" ? (s[key].v as string) : "");

export type AccessStatus = "blocked" | "cleared" | "in_progress" | "not_started";

export function accessStatus(s: OnboardingState, it: AccessItem): AccessStatus {
  if (isOn(s, blockedKey(it.id))) return "blocked";
  // Optional entries never hold an item back from "cleared" — an optional
  // input nobody fills would otherwise strand the item, and progress()
  // .complete with it. They still count as activity, so filling only an
  // optional field reads "in progress" rather than "not started".
  const parts = [
    ...it.checks.filter((c) => !c.optional).map((c) => isOn(s, c.key)),
    ...(it.choice ? [str(s, it.choice.key) !== ""] : []),
    ...(it.inputs ?? []).filter((i) => !i.optional).map((i) => str(s, i.key) !== "")
  ];
  const extras = [
    ...it.checks.filter((c) => c.optional).map((c) => isOn(s, c.key)),
    ...(it.inputs ?? []).filter((i) => i.optional).map((i) => str(s, i.key) !== ""),
    ...(it.lists ?? []).map((l) => parseChannels(s[l.key]?.v).length > 0)
  ];
  if (parts.every(Boolean)) return "cleared";
  return parts.some(Boolean) || extras.some(Boolean) ? "in_progress" : "not_started";
}

export function setupKeys(s: OnboardingState): string[] {
  const keys: string[] = [
    // The main zap has its own step-by-step tab; only the other two are one tick.
    ...ZAPS.filter((z) => z.id !== "main").map((z) => zapBuiltKey(z.id)),
    ...SLACK_CHANNELS.map((c) => slackKey(c.id))
  ];
  const channel = str(s, "access.notify.channel");
  if (channel === "slack" || channel === "email") keys.push(...CLIENT_STREAMS.map((c) => clientKey(channel, c.id)));
  else if (channel === "other") keys.push(CLIENT_OTHER_KEY);
  return keys;
}

// Whether a step applies to this client at all.
export function stepApplies(s: OnboardingState, st: SopStep): boolean {
  return !st.when || st.when.anyOf.includes(str(s, st.when.key));
}

// The Scaled Sync phase's countable keys. Empty for a client who is not on
// Scaled Sync, which is what stops this phase from un-completing every
// onboarding that predates it — see the SYNC_STEPS header.
export function syncKeys(s: OnboardingState): { key: string; kind: "check" | "text" }[] {
  if (str(s, SYNC_PLATFORM_KEY) !== "scaled_sync") return [];
  return SYNC_STEPS.filter((st) => stepApplies(s, st)).flatMap((st) => stepKeys(st, syncKey));
}

export function progress(s: OnboardingState) {
  const access = ACCESS_ITEMS.map((it) => accessStatus(s, it));
  const accessCleared = access.filter((a) => a === "cleared").length;
  const blocked = access.filter((a) => a === "blocked").length;

  const launchTotal = 3;
  const launchDone = (str(s, CITIES_KEY) ? 1 : 0) + (str(s, BUDGET_KEY) ? 1 : 0) + (str(s, CREATIVES_KEY) ? 1 : 0);

  const sKeys = setupKeys(s);
  // No channel picked yet means client delivery can't be set up — count it as
  // one outstanding step so setup can't read as done.
  const channelMissing = str(s, "access.notify.channel") === "";
  // The provider name counts as a step too — every zap and channel is named off it.
  const setupTotal = 1 + sKeys.length + (channelMissing ? 1 : 0);
  const setupDone = (str(s, PROVIDER_KEY) ? 1 : 0) + sKeys.filter((k) => isOn(s, k)).length;

  const sync = syncKeys(s);
  const syncTotal = sync.length;
  const syncDone = sync.filter(({ key, kind }) => (kind === "check" ? isOn(s, key) : str(s, key) !== "")).length;

  const mainKeys = MAIN_ZAP_STEPS.flatMap(mainStepKeys);
  const mainTotal = mainKeys.length;
  const mainDone = mainKeys.filter(({ key, kind }) => (kind === "check" ? isOn(s, key) : str(s, key) !== "")).length;

  const cases = testCases("");
  const testsDone = cases.filter((t) => {
    const r = str(s, testResultKey(t.id));
    return r === "pass" || (r === "na" && !!t.optional);
  }).length;
  const testsFailed = cases.filter((t) => str(s, testResultKey(t.id)) === "fail").length;

  const complete =
    accessCleared === ACCESS_ITEMS.length &&
    launchDone === launchTotal &&
    syncDone === syncTotal &&
    mainDone === mainTotal &&
    setupDone === setupTotal &&
    testsDone === cases.length;

  return {
    accessCleared, accessTotal: ACCESS_ITEMS.length, blocked,
    launchDone, launchTotal,
    syncDone, syncTotal,
    mainDone, mainTotal,
    setupDone, setupTotal,
    testsDone, testsTotal: cases.length, testsFailed,
    complete
  };
}

export type Progress = ReturnType<typeof progress>;

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------
//
// Phase is a TAB ID — which of the panel's four panes is open. Stage is a
// LIFECYCLE POSITION and adds one rung the panel has no tab for: Live. They
// share ids on purpose, so Stage is literally Phase | "live" and converting
// between them is compiler-checked rather than a lookup table.
//
// The product words live in STAGE_LABEL. Note the id "main" is labelled
// "Build": the id stays "main" so it lines up with the main.* keys inside
// `state`, and renaming it would create a second id vocabulary needing
// translation at every filter and stored value.

export type Phase = "access" | "launch" | "sync" | "main" | "setup" | "test";
export type Stage = Phase | "live";

export const PHASES: Phase[] = ["access", "launch", "sync", "main", "setup", "test"];
export const STAGES: Stage[] = ["access", "launch", "sync", "main", "setup", "test", "live"];

export const STAGE_LABEL: Record<Stage, string> = {
  access: "Access",
  launch: "Launch",
  sync: "Scaled Sync",
  main: "Build",
  setup: "Setup",
  test: "Testing",
  live: "Live"
};

export const STAGE_BLURB: Record<Stage, string> = {
  access: "Waiting on the client to clear us.",
  launch: "Cities, starting budget and the ad creatives.",
  sync: "Their CRM account, and their Typeform pointed at it.",
  main: "The main zap, step by step.",
  setup: "The other zaps, our channels and the client's delivery.",
  test: "Live Typeform runs. All must pass.",
  live: "Handed over and running."
};

export const stagePhase = (s: Stage): Phase => (s === "live" ? "test" : s);

// THE ladder — derived from the checklist, never typed by a human.
//
// `completedAt` is the RECORDED completion (the stored column), not
// p.complete: the two disagree for exactly the duration of a PATCH, and
// keying Live off the recomputed value would flip the board to Live
// optimistically and straight back again. A caller that is about to WRITE
// completion passes the value it is about to write.
export function stage(p: Progress, completedAt: string | null): Stage {
  if (completedAt) return "live";
  if (p.accessCleared < p.accessTotal) return "access";
  if (p.launchDone < p.launchTotal) return "launch";
  // 0/0 for a client who is not on Scaled Sync, so this rung is simply absent
  // for them rather than being something to skip.
  if (p.syncDone < p.syncTotal) return "sync";
  if (p.mainDone < p.mainTotal) return "main";
  if (p.setupDone < p.setupTotal) return "setup";
  return "test";
}

// How far through the stage a client is actually in — the one bar worth
// showing on a card, instead of four competing for attention.
export function stageProgress(p: Progress, st: Stage): { done: number; total: number } {
  if (st === "access") return { done: p.accessCleared, total: p.accessTotal };
  if (st === "launch") return { done: p.launchDone, total: p.launchTotal };
  if (st === "sync") return { done: p.syncDone, total: p.syncTotal };
  if (st === "main") return { done: p.mainDone, total: p.mainTotal };
  if (st === "setup") return { done: p.setupDone, total: p.setupTotal };
  if (st === "test") return { done: p.testsDone, total: p.testsTotal };
  return { done: 1, total: 1 };
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

// Fixed day budgets per stage, tuned by editing this table. No medians and no
// learning — which is also why there is no stage-history table. Access gets a
// long rope because it waits on six external systems the client controls;
// Build and Setup are our own work.
export const STAGE_AGING: Record<Stage, { amber: number; red: number } | null> = {
  access: { amber: 9, red: 12 },
  launch: { amber: 3, red: 5 },
  // Our own admin, and short: the only wait inside it is the client confirming
  // an email, which is minutes.
  sync: { amber: 3, red: 5 },
  main: { amber: 6, red: 8 },
  setup: { amber: 3, red: 4 },
  test: { amber: 5, red: 6 },
  live: null
};

export type AgeBand = "ok" | "amber" | "red" | "hold";

// Elapsed 24h periods — the house idiom (see daysSince in client-touchpoint),
// not ET calendar days. Duplicated rather than imported because that module is
// server-only and this one is imported by the client panel.
export function elapsedDays(fromIso: string | null, to: Date = new Date()): number | null {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return null;
  return Math.max(0, Math.floor((to.getTime() - from) / 86_400_000));
}

// Days in the current stage. A hold FREEZES the number at the instant the hold
// started.
//
// KNOWN SIMPLIFICATION: releasing a hold does not credit the held days back —
// the count resumes from stageEnteredAt including them. Only the CURRENT hold
// is excluded. Crediting held time needs an accumulator, and the only place to
// keep one is `state`, which means read-modify-write: the pattern this work
// exists to remove. Holds are expected to be few and long, so excluding the
// current one carries nearly all the value.
export function stageAgeDays(
  stageEnteredAt: string | null,
  heldSince: string | null,
  now: Date = new Date()
): number | null {
  return elapsedDays(stageEnteredAt, heldSince ? new Date(heldSince) : now);
}

export function ageBand(st: Stage, days: number | null, held: boolean): AgeBand {
  if (held) return "hold";
  const t = STAGE_AGING[st];
  if (!t || days === null) return "ok";
  if (days >= t.red) return "red";
  return days >= t.amber ? "amber" : "ok";
}

// ---------------------------------------------------------------------------
// Flag readers
// ---------------------------------------------------------------------------

export function waitingOn(s: OnboardingState): WaitingOn {
  const v = str(s, WAITING_ON_KEY);
  return v === "us" || v === "client" ? v : "";
}
export function waitingSince(s: OnboardingState): string | null {
  return waitingOn(s) ? s[WAITING_ON_KEY]?.at ?? null : null;
}
export function waitingNote(s: OnboardingState): string {
  return str(s, WAITING_NOTE_KEY);
}
export function onHold(s: OnboardingState): boolean {
  return isOn(s, HOLD_KEY);
}
export function holdSince(s: OnboardingState): string | null {
  return onHold(s) ? s[HOLD_KEY]?.at ?? null : null;
}
export function holdNote(s: OnboardingState): string {
  return str(s, HOLD_NOTE_KEY);
}
