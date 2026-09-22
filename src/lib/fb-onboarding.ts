// Facebook client onboarding — the shared definition of the checklist that
// sits on a Facebook department task (one task per client).
//
// Four phases, in order:
//   1. Access   — six things the client has to clear before we can build.
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
interface Check { key: string; label: string; hint?: string }
interface TextInput { key: string; label: string; placeholder?: string }

export interface AccessItem {
  id: string;
  label: string;
  blurb: string;
  choice?: Choice;
  checks: Check[];
  inputs?: TextInput[];
}

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
      { key: "access.ctm.tracking_number", label: "Have a tracking number for first-time texts" }
    ],
    inputs: [{ key: "access.ctm.number", label: "Tracking number", placeholder: "+1…" }]
  },
  {
    id: "dashboard",
    label: "Dashboard",
    blurb: "The client's ad account feeding the dashboard, and the client able to get into it.",
    checks: [
      { key: "access.dashboard.ad_account", label: "Ad account connected to the dashboard" },
      { key: "access.dashboard.client_login", label: "Client got their login and has signed in" }
    ],
    inputs: [{ key: "access.dashboard.link", label: "Dashboard link", placeholder: "https://…" }]
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
    checks: [{ key: "access.notify.reachable", label: "Zapier can post to it" }],
    inputs: [{ key: "access.notify.target", label: "Where", placeholder: "Their Slack workspace / email address / tool" }]
  }
];

export const blockedKey = (itemId: string) => `access.${itemId}.blocked`;
export const noteKey = (itemId: string) => `access.${itemId}.note`;

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

export interface MainZapStep {
  id: string;
  step: string;           // "Step 3", "Before you start", "QC"…
  title: string;
  blurb?: string;
  checks: Check[];
  choices?: Choice[];
  inputs?: TextInput[];
  copies?: { label: string; text: string }[];
  warn?: string;
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

export const MAIN_ZAP_STEPS: MainZapStep[] = [
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
      { key: "channels", label: "Path A → #{slug}-fb-leads-vob, Path B → #{slug}-fb-leads-non-vob" },
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

export const mainKey = (stepId: string, key: string) => `main.${stepId}.${key}`;

// Every key a step needs filled for it to count as done.
export function mainStepKeys(st: MainZapStep): { key: string; kind: "check" | "text" }[] {
  return [
    ...st.checks.map((c) => ({ key: mainKey(st.id, c.key), kind: "check" as const })),
    ...(st.choices ?? []).map((c) => ({ key: mainKey(st.id, c.key), kind: "text" as const })),
    ...(st.inputs ?? []).map((i) => ({ key: mainKey(st.id, i.key), kind: "text" as const }))
  ];
}

export function fillTokens(text: string, provider: string): string {
  return text
    .replace(/\{Provider\}/g, provider || "{Provider}")
    .replace(/\{slug\}/g, channelSlug(provider) || "{provider}");
}

export const SLACK_CHANNELS = [
  { id: "vob", suffix: "fb-leads-vob", blurb: "All VOB leads" },
  { id: "non_vob", suffix: "fb-leads-non-vob", blurb: "All non-VOB leads" },
  { id: "calendly", suffix: "calendly-call-booked", blurb: "Bookings and reminder notifications" },
  { id: "failsafe", suffix: "failsafe", blurb: "Zap error notifications" }
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
        `Exactly one post in ${ch("fb-leads-vob")} with the VOB header and @channel, every field filled`,
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
        `Exactly one post in ${ch("fb-leads-non-vob")} with the Non-VOB header — nothing in ${ch("fb-leads-vob")}`,
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
        `Post in ${ch("calendly-call-booked")} with the lead and the booked time`,
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
        `An error post in ${ch("failsafe")} for each zap, naming which zap failed`,
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

// Answers for one case, question order preserved, ready to paste or read off.
export function caseAnswers(tc: TestCase): { q: string; a: string }[] {
  return TYPEFORM_BASE.map(({ q, a }) => ({ q, a: tc.answers?.[q] ?? a }));
}

// ---------------------------------------------------------------------------
// Key registry — the API only accepts these.
// ---------------------------------------------------------------------------

type KeyKind = { kind: "check" } | { kind: "text" } | { kind: "choice"; options: string[] };

function buildRegistry(): Map<string, KeyKind> {
  const r = new Map<string, KeyKind>();
  for (const it of ACCESS_ITEMS) {
    if (it.choice) r.set(it.choice.key, { kind: "choice", options: it.choice.options.map((o) => o.value) });
    for (const c of it.checks) r.set(c.key, { kind: "check" });
    for (const i of it.inputs ?? []) r.set(i.key, { kind: "text" });
    r.set(blockedKey(it.id), { kind: "check" });
    r.set(noteKey(it.id), { kind: "text" });
  }
  r.set(PROVIDER_KEY, { kind: "text" });
  for (const z of ZAPS) {
    r.set(zapBuiltKey(z.id), { kind: "check" });
    r.set(zapUrlKey(z.id), { kind: "text" });
  }
  for (const st of MAIN_ZAP_STEPS) {
    for (const c of st.checks) r.set(mainKey(st.id, c.key), { kind: "check" });
    for (const c of st.choices ?? []) r.set(mainKey(st.id, c.key), { kind: "choice", options: c.options.map((o) => o.value) });
    for (const i of st.inputs ?? []) r.set(mainKey(st.id, i.key), { kind: "text" });
  }
  for (const c of SLACK_CHANNELS) r.set(slackKey(c.id), { kind: "check" });
  for (const ch of ["slack", "email"]) for (const s of CLIENT_STREAMS) r.set(clientKey(ch, s.id), { kind: "check" });
  r.set(CLIENT_OTHER_KEY, { kind: "check" });
  // Test ids don't depend on the slug, so any slug works to enumerate them.
  for (const t of testCases("")) {
    r.set(testResultKey(t.id), { kind: "choice", options: ["pass", "fail", "na", ""] });
    r.set(testNoteKey(t.id), { kind: "text" });
  }
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
  const parts = [
    ...it.checks.map((c) => isOn(s, c.key)),
    ...(it.choice ? [str(s, it.choice.key) !== ""] : []),
    ...(it.inputs ?? []).map((i) => str(s, i.key) !== "")
  ];
  if (parts.every(Boolean)) return "cleared";
  return parts.some(Boolean) ? "in_progress" : "not_started";
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

export function progress(s: OnboardingState) {
  const access = ACCESS_ITEMS.map((it) => accessStatus(s, it));
  const accessCleared = access.filter((a) => a === "cleared").length;
  const blocked = access.filter((a) => a === "blocked").length;

  const sKeys = setupKeys(s);
  // No channel picked yet means client delivery can't be set up — count it as
  // one outstanding step so setup can't read as done.
  const channelMissing = str(s, "access.notify.channel") === "";
  // The provider name counts as a step too — every zap and channel is named off it.
  const setupTotal = 1 + sKeys.length + (channelMissing ? 1 : 0);
  const setupDone = (str(s, PROVIDER_KEY) ? 1 : 0) + sKeys.filter((k) => isOn(s, k)).length;

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
    mainDone === mainTotal &&
    setupDone === setupTotal &&
    testsDone === cases.length;

  return {
    accessCleared, accessTotal: ACCESS_ITEMS.length, blocked,
    mainDone, mainTotal,
    setupDone, setupTotal,
    testsDone, testsTotal: cases.length, testsFailed,
    complete
  };
}
