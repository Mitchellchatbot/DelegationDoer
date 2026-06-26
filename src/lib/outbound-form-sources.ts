// The typeforms a manual lead can be attributed to. Operators pick one in the
// "Add a lead" modal so the leads table reflects where a lead originated.
//
// This array is the SINGLE source of truth: to add a future typeform, add a
// string here and it automatically shows up in the modal dropdown and is
// accepted by POST /api/outbound/leads. Webhook-ingested leads carry no form
// attribution (form_source stays null) — this is manual entry only.
//
// Kept in its own client-safe module (no server imports) so both the
// "use client" modal (AddLeadButton.tsx) and the server route can import it.
// It must NOT live in outbound-leads.ts, which pulls in the server-only
// Supabase admin client.
export const FORM_SOURCES = [
  "Mike's Facebook Campaign",
  "LinkedIn Leads",
  "Website Builder",
  "Main typeform"
] as const;

export type FormSource = (typeof FORM_SOURCES)[number];
