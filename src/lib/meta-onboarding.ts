import type { OnboardingState, EntryValue } from "./fb-onboarding";

// ---------------------------------------------------------------------------
// Meta onboarding: one client's Meta Instant Form → Google Sheet → Zap →
// Scaled Sync (the CRM, which records each lead) + Scaled Admissions (the AI,
// which texts it) setup. The SOP and its go-live checklist, worked per client
// on /meta-onboarding.
//
// DELIBERATELY SEPARATE FROM FB ONBOARDING. Its own table (meta_onboarding),
// its own route and its own completed_at, so nothing ticked here can move a
// client's FB onboarding stage or clear its completion. (#538 put this inside
// FB onboarding as a gated phase; it was moved out on request.)
//
// The go-live checklist is the thing that is tracked: 32 boxes, worded exactly
// as the SOP's own checklist, and a client is complete when all 32 are ticked.
// Each box belongs to the one SOP step that does the work, so the step-by-step
// view and the checklist view tick the SAME key — nobody ticks anything twice.
//
// Deliberately no field for any of the four secrets the SOP mints (partner
// secret, SA texting secret, update-address secret, lead-form key), nor for
// the lead Sheet's link: this state is readable by the whole Facebook team,
// and the Sheet holds the names and phone numbers of people contacting a
// treatment centre. scripts/check-meta-onboarding.mjs guards that.
//
// Type imports only, so the check script can load this module on its own.
// Text uses two inline markers, rendered by the panel: **bold** for a button or
// setting name, `code` for a literal value.
// ---------------------------------------------------------------------------

export type { OnboardingState, EntryValue };

export const META_ONBOARDING_TAG = "meta-onboarding";

// The client's name as the page shows it. Seeded from the task's client name
// when the onboarding is started.
export const META_CLIENT_KEY = "info.client";

export interface MetaChecklistItem {
  key: string;
  label: string;
  // The SOP step that does this work (a META_STEPS id).
  step: string;
}

export interface MetaChecklistGroup { id: string; title: string; items: MetaChecklistItem[] }

export const META_CHECKLIST_INTRO =
  "Every box should be ticked before the ads team turns the campaign on.";

export const META_CHECKLIST: MetaChecklistGroup[] = [
  {
    id: "client", title: "Client answers",
    items: [
      { key: "list.client.brand", label: "Brand name, persona, opening line and time zone confirmed", step: "pre" },
      { key: "list.client.did", label: "Meta DID confirmed: on the client's own CTM, SMS-enabled, on an approved 10DLC campaign", step: "pre" },
      { key: "list.client.clinic", label: "Admissions phone, hours, location, programs and insurance list received", step: "pre" },
      { key: "list.client.alerts", label: "Hand-off alert recipients named", step: "pre" },
      { key: "list.client.form", label: "Meta form asks for phone and insurance, with the texting disclaimer", step: "pre" },
      { key: "list.client.sheet", label: "Google Sheet link received", step: "pre" },
      { key: "list.client.cadence", label: "Follow-up cadence on or off agreed with the client", step: "cadence" }
    ]
  },
  {
    id: "crm", title: "Scaled Sync",
    items: [
      { key: "list.crm.ctm", label: "CTM keys and account ID saved, callback registered, texting provider = CTM", step: "a2" },
      { key: "list.crm.line", label: "Sending line = the Meta DID", step: "a2" },
      { key: "list.crm.lead_ads", label: "Lead ads partner secret saved; URL and secret copied", step: "a3" },
      { key: "list.crm.sa_texting", label: "Scaled Admissions texting secret saved", step: "a4" },
      { key: "list.crm.update_address", label: "Website forms secret saved (SA's update address)", step: "a5" },
      { key: "list.crm.stages", label: "AI stage field, AI Nurturing, Ready for Call and Needs Follow-Up stages in place", step: "a6" },
      { key: "list.crm.alerts", label: "Ready for hand-off alerts ticked for the right people", step: "a7" },
      { key: "list.crm.first_text", label: "First text under 160 characters with a long first name, straight apostrophes only", step: "a2" }
    ]
  },
  {
    id: "sa", title: "Scaled Admissions",
    items: [
      { key: "list.sa.workspace", label: "Workspace created with the exact brand name and time zone", step: "b1" },
      { key: "list.sa.ai_off", label: "AI saved OFF (“auto-replies off” showing)", step: "b2" },
      { key: "list.sa.text_line", label: "Text line shows “Connected to Scaled Sync”", step: "b3" },
      { key: "list.sa.lead_form_key", label: "Lead-form key set and probed (400 with the key, 401 without)", step: "b4" },
      { key: "list.sa.agent", label: "Agent set up: greeting, admissions phone, hours, call-in number, location, programs, payers", step: "b5" },
      { key: "list.sa.members", label: "Client staff invited as members", step: "b6" },
      { key: "list.sa.crm_link", label: "Scaled Sync connection: lead source `facebook`, auto-send on, connected with no error", step: "b7" }
    ]
  },
  {
    id: "zap", title: "Zap",
    items: [
      { key: "list.zap.chain", label: "Sheets trigger → Filter → POST Scaled Sync → POST Scaled Admissions", step: "c4" },
      { key: "list.zap.keys", label: "Question keys renamed; `leadgen_id` and `ad_id` mapped", step: "c3" },
      { key: "list.zap.test_deleted", label: "Zapier test lead deleted from the CRM", step: "c5" },
      { key: "list.zap.published", label: "Zap published and named", step: "c5" }
    ]
  },
  {
    id: "launch", title: "Launch",
    items: [
      { key: "list.launch.crm_test", label: "CRM test row arrived and got the CRM first text", step: "d1" },
      { key: "list.launch.switches", label: "Facebook source: first text off, arrival AI Nurturing; SA AI on (same minute)", step: "d2" },
      { key: "list.launch.ai_test", label: "AI test row: lead in AI Nurturing, AI opener received, reply answered", step: "d3" },
      { key: "list.launch.handoff", label: "Hand-off test: Ready for Call plus alert emails", step: "d4" },
      { key: "list.launch.cleanup", label: "Test lead and SA test contact deleted; test rows left in the Sheet", step: "d5" },
      { key: "list.launch.first_lead", label: "First real Meta lead seen in both systems", step: "d6" }
    ]
  }
];

export const META_CHECKLIST_ITEMS: MetaChecklistItem[] = META_CHECKLIST.flatMap((g) => g.items);
export const META_CHECKLIST_KEYS: string[] = META_CHECKLIST_ITEMS.map((i) => i.key);

// ---------------------------------------------------------------------------
// The SOP
// ---------------------------------------------------------------------------

export const META_HOW_IT_WORKS =
  "One Zap sends each Meta lead to two systems: Scaled Sync (the CRM) records it, and Scaled Admissions (the AI) texts it. The ads team owns the form and the Sheet. We own the Zap and the CRM and SA setup. The client owns the CTM number and calls the lead back.";

export const META_FLOW = `Meta Instant Form ──> Google Sheet ──> Zapier (new row, filter)
  (ads team builds)    (one row/lead)     │ 1st POST: the lead     │ 2nd POST: the lead
                                          v                        v
                              Scaled Sync (CRM) <── texts to send, AI stage updates ── Scaled Admissions (AI)
                              makes the lead,   ── replies, staff takeover ──────────> texts + qualifies,
                              moves stages,                                            hands off when ready
                              emails staff                                                    │ hand-off alert
                                  ^                                                           v
                                  │ every text, both ways                             Admissions staff
                                  v                                                   (call once Ready for Call)
                     Lead's phone <──> CTM · Meta DID (client's own number)`;

export const META_FLOW_NOTE =
  "The AI never texts directly. Its messages go out through the CRM's CTM line, and replies come back the same way.";

export const META_BUILD_ORDER =
  "Build in this order: CRM, then Scaled Admissions (SA) with the AI saved off, then the Zap, then launch. The AI stays off until the launch step, so no lead gets two first texts.";

export const META_SA_LEAD_FORM_URL = "https://scaled-admissions-production.up.railway.app/api/webhooks/lead-form";

export const META_ZAP_NAME = "{Client} | Meta <MON YYYY> Sheet → Scaled Sync + Scaled Admissions";

export interface MetaTable { head: string[]; rows: string[][] }

// An optional reference field: shown and saved for the client, never counted.
export interface MetaInput { key: string; label: string; placeholder?: string; url?: boolean }
export interface MetaChoice { key: string; label: string; options: { value: string; label: string }[] }

export interface MetaStep {
  id: string;
  section: MetaSectionId;
  step: string;           // "A2", "Before you start", "Cadence"
  title: string;
  text?: string[];        // paragraphs, before any bullets
  bullets?: string[];
  table?: MetaTable;
  after?: string[];       // paragraphs after the table
  inputs?: MetaInput[];
  choices?: MetaChoice[];
  copies?: { label: string; text: string }[];
  warn?: string;
}

export type MetaSectionId = "pre" | "a" | "b" | "c" | "d" | "cadence";

export const META_SECTIONS: { id: MetaSectionId; title: string; intro?: string }[] = [
  { id: "pre", title: "Before you start" },
  {
    id: "a", title: "A. Scaled Sync (the CRM)",
    intro: "Do these in the client's org, logged in as an owner. Settings › Integrations is owner-only; an admin sees the cards with no URLs."
  },
  { id: "b", title: "B. Scaled Admissions" },
  {
    id: "c", title: "C. The Zap",
    intro: "Build it in Mitchell Price's Zapier. Name it as below."
  },
  { id: "d", title: "D. Launch" },
  { id: "cadence", title: "Cadence" }
];

// Step C3's Sheet column → key table. The renames are the point.
export const META_ZAP_KEYS: MetaTable = {
  head: ["Sheet column", "Key to send"],
  rows: [
    ["id", "`leadgen_id` (required; it is the dedupe key)"],
    ["created_time, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, form_id, is_organic, platform", "the same names"],
    ["full_name, phone_number, email", "the same names"],
    ["“Who are you seeking help for?”", "`who_are_you_seeking_help_for?`"],
    ["the substance or struggle question", "`what_are_you_struggling_with?`"],
    ["“How long has this been a struggle?”", "`how_long_has_this_been_going_on?`"],
    ["“Do you have insurance?” (yes/no)", "`do_you_actively_have_a_health_plan?`"],
    ["the insurance company pick-list", "`insurance_provider`"],
    ["“Enter the name of your insurance”", "`name_of_the_insurance_provider`"],
    ["any other question", "Meta's own key, as in the Sheet header"]
  ]
};

// The same table as tab-separated text, for pasting. Markers stripped.
export const metaZapKeysTsv = (): string =>
  [META_ZAP_KEYS.head, ...META_ZAP_KEYS.rows].map((r) => r.map((c) => c.replace(/`/g, "")).join("\t")).join("\n");

export const META_STEPS: MetaStep[] = [
  {
    id: "pre", section: "pre", step: "Before you start", title: "The client's answers",
    text: ["Get every answer below before building anything. Two of them (the brand name and the texting number) are hard to change later."],
    table: {
      head: ["Item", "Why it matters"],
      rows: [
        ["Brand name, exactly as the AI should say it", "The Scaled Admissions workspace name is what the AI calls itself. SA has no rename button; a fix needs a database update."],
        ["AI persona name and opening line", "Sets the first text the lead gets."],
        ["Time zone", "Drives the AI's follow-up times. SA lists cities only (New York = Eastern)."],
        ["Meta texting number (the “Meta DID”)", "Leads are texted from it. It must be SMS-enabled and on the clinic's own approved 10DLC campaign in their CTM."],
        ["CTM account ID + API keys", "Scaled Sync sends and receives texts through CTM."],
        ["Admissions phone, hours, call-in number", "The AI gives these out and hands off during hours."],
        ["Location, programs, insurance accepted", "The AI is asked these on day one. Changes' AI had no location."],
        ["Who gets hand-off alerts (email and text)", "Only active SA members and ticked CRM recipients hear about a ready lead."],
        ["The Meta Instant Form's questions", "Each answer becomes a Sheet column you map in Zapier. Ask insurance on the form: the AI cannot receive card photos by text."],
        ["The Google Sheet link", "The ads team (Mujtaba) builds the ad account, the form and the Sheet."],
        ["Who texts first, per source", "The AI texts Meta leads; the CRM's own first text covers every other source. Leaving both on sends two texts."]
      ]
    },
    inputs: [
      { key: "info.brand_name", label: "Brand name, exactly as the AI says it", placeholder: "What the SA workspace will be called" },
      { key: "info.did_number", label: "Meta DID", placeholder: "+1…" }
    ],
    warn: "The Sheet holds names and phone numbers of people contacting a treatment centre. Keep it shared with as few people as possible, and don't paste its link or any secret into this page: everything here is visible to the whole Facebook team."
  },

  // A. Scaled Sync
  {
    id: "a1", section: "a", step: "A1", title: "Org",
    text: ["Use the client's existing org. A new one is made at `/onboarding?new=1`. The org owner's email must be confirmed first."]
  },
  {
    id: "a2", section: "a", step: "A2", title: "CTM",
    text: ["Settings › Integrations › CTM: save the API keys and account ID. Click **Create callback URL**, then **Register in CTM**, then set **Texting provider** to CTM."],
    bullets: [
      "Warn the client first: the first CTM sync turns about 150 recent inbound callers into leads.",
      "The sending line has no Settings field. It is set during onboarding or by an engineer. It must match a number that is SMS-enabled in CTM, or the whole org stops texting.",
      "In CTM, check the Meta DID is Active, rings the admissions line, and has text messaging on.",
      "Count the first text with a long first name and use straight apostrophes: CTM refuses a text over 160 characters with no warning in Settings, and the reason only shows on the lead's timeline."
    ],
    inputs: [{ key: "info.ctm_account", label: "CTM account ID", placeholder: "The client's CTM account" }]
  },
  {
    id: "a3", section: "a", step: "A3", title: "Lead ads hook",
    text: ["Settings › Integrations › Lead ads (Facebook / Instagram) › **Partner secret (Zapier)**. Paste a long random string and save. Copy the URL (`…/functions/v1/meta-leads/<hook id>`) and the secret now: the secret is write-only."],
    inputs: [{ key: "info.lead_ads_url", label: "Lead ads URL", placeholder: "…/functions/v1/meta-leads/<hook id>", url: true }],
    warn: "Copy the secret somewhere safe, not into this page."
  },
  {
    id: "a4", section: "a", step: "A4", title: "SA texting",
    text: ["Settings › Integrations › **Scaled Admissions texting**: save a second random secret. Copy the sa-message URL it shows."]
  },
  {
    id: "a5", section: "a", step: "A5", title: "SA update address",
    text: ["Settings › Integrations › **Website forms**: save a third random secret and copy the URL. This is only the address SA sends its updates to. It does not turn on website forms or website AI."]
  },
  {
    id: "a6", section: "a", step: "A6", title: "Stages and AI field (engineer)",
    text: ["Add the `AI stage` field and two stages after New Lead: **AI Nurturing** and **Ready for Call** (key `ai_ready`). Add **Needs Follow-Up** (key `follow_up`) if the pipeline lacks it: leads land there when staff turn the AI off and no call was agreed."]
  },
  {
    id: "a7", section: "a", step: "A7", title: "Alerts",
    text: ["Settings › Notifications: tick **Ready for hand-off** for each person who should hear about ready leads. SA also emails its own members, so a person in both gets two emails."]
  },
  {
    id: "a8", section: "a", step: "A8", title: "Optional, by org id (engineer PR)",
    text: ["Hide Bulk text, add the Website / Socials / Meta source tags. Only if the client wants it; nothing on the checklist depends on it."]
  },

  // B. Scaled Admissions
  {
    id: "b1", section: "b", step: "B1", title: "Create the workspace",
    text: ["Create the workspace with the exact brand name and time zone. There is no rename."]
  },
  {
    id: "b2", section: "b", step: "B2", title: "Save the AI off at once",
    text: ["A new workspace's AI is ON. In Settings › AI agent, untick **Answer new messages automatically** and press Save. The header should show “auto-replies off”."],
    warn: "Left on, Meta leads get the CRM first text and the AI opener."
  },
  {
    id: "b3", section: "b", step: "B3", title: "Text line",
    text: ["Settings › Channels › Text line: the Meta DID, the sa-message URL from A4 and the same secret. Expect “Connected to Scaled Sync”."]
  },
  {
    id: "b4", section: "b", step: "B4", title: "Lead-form key (engineer)",
    text: ["There is no UI. An engineer stores the key's hash on the text line. Probe: the key with `{}` answers 400 “leadgen_id is required”; a wrong key answers 401."]
  },
  {
    id: "b5", section: "b", step: "B5", title: "Agent setup",
    text: ["Persona and greeting, admissions phone, hours, call-in number (the Meta DID), location, programs and insurance payers."]
  },
  {
    id: "b6", section: "b", step: "B6", title: "Members",
    text: ["Invite the client's admissions staff. SA's hand-off and crisis emails reach only active members."]
  },
  {
    id: "b7", section: "b", step: "B7", title: "CRM link",
    text: ["Settings › Integrations › Scaled Sync: the Website forms URL and secret from A5, lead source `facebook`, auto-send and sending on, then **Connect**. Connect posts `{}`, so no lead is made."]
  },

  // C. The Zap
  {
    id: "c1", section: "c", step: "C1", title: "Trigger",
    text: ["Google Sheets › New Spreadsheet Row, the client's Sheet and worksheet. Paste the Sheet ID under Custom if it isn't listed."]
  },
  {
    id: "c2", section: "c", step: "C2", title: "Filter",
    text: ["Full Name does not contain “test lead”. Don't filter Medicaid or Medicare unless the client asks."]
  },
  {
    id: "c3", section: "c", step: "C3", title: "POST to Scaled Sync",
    text: ["Webhooks by Zapier › POST to the lead ads URL from A3."],
    bullets: [
      "Payload Type json, Wrap Request In Array No, Unflatten No.",
      "Header `Authorization` = `Bearer <secret>`. Press End after pasting and check that it ends on the last character of the secret.",
      "Data rows, one per Sheet column, keyed as below. Skip `form_name` and `lead_status`."
    ],
    table: META_ZAP_KEYS,
    after: ["The renames matter. With the Sheet's own keys, Help with and Insurance fill from the wrong question (Arrow read “Insurance: Yes”; Bright Mission read “Help with: More than a year”). Ask an engineer to check a new form's headers before go-live."]
  },
  {
    id: "c4", section: "c", step: "C4", title: "POST to Scaled Admissions",
    text: ["Duplicate C3. Change the URL to the one below and the header to `Bearer <SA lead-form key>`. Keep the CRM step first. Keep `ad_id` mapped (see Cadence)."],
    copies: [{ label: "SA lead-form URL", text: META_SA_LEAD_FORM_URL }]
  },
  {
    id: "c5", section: "c", step: "C5", title: "Test once, then publish",
    text: ["Testing C3 makes an `is_test` lead and emails every lead-alert recipient; delete that lead and don't retest. Testing C4 on Meta's dummy row answers 422 “no usable phone number” and stores nothing."],
    inputs: [{ key: "info.zap_url", label: "Zap URL", placeholder: "https://zapier.com/…", url: true }]
  },

  // D. Launch
  {
    id: "d1", section: "d", step: "D1", title: "Prove the CRM route",
    text: ["Add a new row to the Sheet with a team phone: id `l:<client>test1`, a created_time, full name “ScaledAI Test”, phone `p:+1…`. Expect the CRM lead in seconds and the CRM's first text. Then have an engineer delete the SA contact this row made, so the AI test in D3 starts fresh."]
  },
  {
    id: "d2", section: "d", step: "D2", title: "Flip both switches in the same minute",
    text: ["CRM Settings › Lead sources › **Facebook**: first text off and arrival stage AI Nurturing. SA: tick Answer new messages automatically and Save."],
    warn: "Facebook Typeform ads land on the same Facebook source, so turning its first text off silences the Typeform leads too. Split them into a “Facebook (Typeform)” source before this step."
  },
  {
    id: "d3", section: "d", step: "D3", title: "Prove the AI route",
    text: ["Add another test row. Expect: the lead in AI Nurturing with `first_text_skipped: source_disabled`; the AI's opener from the Meta DID; a reply answered within about 15 seconds; “Being nurtured” after the first turn."]
  },
  {
    id: "d4", section: "d", step: "D4", title: "Prove the hand-off",
    text: ["Reply asking for a call. Expect Ready for Call plus the alert emails. Warn the client's staff first: they may call the test phone."]
  },
  {
    id: "d5", section: "d", step: "D5", title: "Clean up",
    text: ["Delete the CRM test lead (backup first) and the SA test contact. SA keys contacts by phone, so a retest from the same phone needs the old contact gone. Leave the test rows in the Sheet."]
  },
  {
    id: "d6", section: "d", step: "D6", title: "Watch the first real lead",
    text: ["Confirm with the ads team that the campaign is live, then check the first real row reaches both systems."]
  },

  // Cadence
  {
    id: "cadence", section: "cadence", step: "Cadence", title: "Follow-up texts",
    text: [
      "The AI texts a new Meta lead as soon as Zapier delivers the row, then follows up with up to 11 check-ins over 5 days if the lead goes quiet. The follow-ups are off unless an engineer switches them on for the workspace.",
      "**First text.** The Sheets trigger polls, so the opener lags the form by Zapier's polling interval (1 to 15 minutes, by plan). After that the AI answers each reply within about 15 seconds.",
      "**Follow-ups after the AI's message goes unanswered:**"
    ],
    table: {
      head: ["When", "What is sent"],
      rows: [
        ["10 minutes", "“Are you there, {first name}?” Only if the AI's message asked a question, and at most once a day."],
        ["2 hours", "A check-in"],
        ["10am and 6pm in the lead's time zone, for 5 days", "A check-in, at least 3 hours apart, only between 8am and 9pm"],
        ["The last one", "A sign-off"]
      ]
    },
    after: [
      "The wording comes from 9 fixed lines; it can't be edited per client.",
      "**It stops when** the lead replies (a later silence starts a new schedule), staff text or take over, a call is booked or requested, the lead opts out or declines, the conversation reaches a finished stage, or the lead is referred to Medicaid.",
      "**The 5 days need an ad id.** A contact without one gets a 24-hour window: about 4 check-ins in a day. Map `ad_id` in the Zap's SA step.",
      "**Switching it on.** It is a per-workspace setting in SA (`nudges_enabled`, default off). An engineer flips it. Agree with the client before turning it on."
    ],
    choices: [{
      key: "info.cadence", label: "Follow-ups for this client",
      options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }]
    }]
  }
];

// The SOP's Known traps, as written: each came up during the Arrow Passage,
// Bright Mission or Changes setups.
export const META_TRAPS: { trap: string; happens: string; fix: string }[] = [
  { trap: "A row already in the Sheet when the Zap first runs", happens: "Zapier treats it as seen and never sends it", fix: "Add test rows only after publishing" },
  { trap: "Deleting, sorting or inserting Sheet rows", happens: "Zapier tracks rows by position, so a lead can arrive twice or never", fix: "Leave every row in place, test rows included" },
  { trap: "Retesting the Zap's CRM step", happens: "Each test makes a fake lead and emails every lead-alert recipient", fix: "Test once, delete that lead, don't retest" },
  { trap: "A line break pasted after a secret", happens: "Zapier gets a 401 that looks like a wrong secret", fix: "Press End after pasting; Zapier's Troubleshoot tab shows the stray character" },
  { trap: "SA AI left on by default", happens: "Meta leads get the CRM first text and the AI opener", fix: "Save the AI off right after creating the workspace" },
  { trap: "Sheet keys sent unchanged", happens: "Help with and Insurance fill from the wrong questions", fix: "Rename the question keys (the C3 table)" },
  { trap: "First text over 160 characters", happens: "CTM refuses it with no warning in Settings; the reason is on the lead's timeline", fix: "Count the text with a long first name; use straight apostrophes" },
  { trap: "Texting from another company's CTM number", happens: "A lead's bare “Yes” gets that company's opt-in reply (Bright Mission got Scaled AI LLC's)", fix: "Use the client's own CTM and 10DLC campaign" },
  { trap: "Lead texts a photo of their insurance card", happens: "Photos never reach the AI, so the lead gets no answer", fix: "Ask for the insurance company on the Meta form" },
  { trap: "Staff reply from the CRM", happens: "Each staff reply turns the AI off for that lead", fix: "Tell staff; turn the AI back on from the lead if wanted" },
  { trap: "Facebook Typeform ads run alongside Instant Forms", happens: "Both land on the Facebook source, so turning its first text off silences the Typeform leads too", fix: "Split them into a “Facebook (Typeform)” source before launch" },
  { trap: "Renaming Changes or Bright Mission", happens: "Their screen setup is matched by org name and drops on rename", fix: "Have an engineer add the new name first" },
  { trap: "The campaign never actually goes live", happens: "A quiet Zap looks the same as a broken one", fix: "Confirm the first real row reaches both systems" }
];

export const itemsForStep = (stepId: string): MetaChecklistItem[] =>
  META_CHECKLIST_ITEMS.filter((i) => i.step === stepId);

export const fillClient = (text: string, client: string): string =>
  text.replace(/\{Client\}/g, client || "<Client>");

// ---------------------------------------------------------------------------
// Validation: the only keys the API will store, and the shape of each.
// ---------------------------------------------------------------------------

type KeyKind = { kind: "check" } | { kind: "text" } | { kind: "choice"; options: string[] };

function buildRegistry(): Map<string, KeyKind> {
  const r = new Map<string, KeyKind>();
  for (const key of META_CHECKLIST_KEYS) r.set(key, { kind: "check" });
  r.set(META_CLIENT_KEY, { kind: "text" });
  for (const st of META_STEPS) {
    for (const i of st.inputs ?? []) r.set(i.key, { kind: "text" });
    // "" clears a choice.
    for (const c of st.choices ?? []) r.set(c.key, { kind: "choice", options: [...c.options.map((o) => o.value), ""] });
  }
  return r;
}

const REGISTRY = buildRegistry();

export const isMetaKey = (key: string): boolean => REGISTRY.has(key);

export function normaliseMetaValue(key: string, value: unknown): EntryValue | null {
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

export interface MetaProgress {
  done: number;
  total: number;
  complete: boolean;
  groups: { id: string; title: string; done: number; total: number }[];
  // The first checklist section with a box left, or null when complete.
  next: { id: string; title: string; done: number; total: number } | null;
}

const isOn = (s: OnboardingState, key: string) => s[key]?.v === true;

export function metaProgress(s: OnboardingState): MetaProgress {
  const groups = META_CHECKLIST.map((g) => ({
    id: g.id,
    title: g.title,
    done: g.items.filter((i) => isOn(s, i.key)).length,
    total: g.items.length
  }));
  const done = groups.reduce((n, g) => n + g.done, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  return {
    done,
    total,
    complete: total > 0 && done === total,
    groups,
    next: groups.find((g) => g.done < g.total) ?? null
  };
}

export const metaClientName = (s: OnboardingState): string =>
  typeof s[META_CLIENT_KEY]?.v === "string" ? (s[META_CLIENT_KEY].v as string) : "";
