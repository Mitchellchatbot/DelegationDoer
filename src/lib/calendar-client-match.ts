// Client matching for Google Calendar events. Extracted from the
// /api/calendar/meetings route so the Upcoming-meetings panel and the
// widget meeting-reminder share ONE matcher — keeping "what counts as a
// client meeting" single-sourced rather than forked across routes.
//
// Matching order, most precise first:
//   1. an attendee email exactly in a client's contact_emails
//   2. an attendee email's domain matches a client's website/contact domain
//      (generic mailbox providers like gmail are skipped)
//   3. the client's name (>= 4 chars) appears in the event title

import type { CalendarEvent } from "@/lib/google-calendar";

export interface ClientLite {
  id: string;
  name: string;
}

// The lightweight client row both callers select (no touchpoint round-trip).
export interface ClientMatchRow {
  id: string;
  name: string | null;
  contact_emails: string[] | null;
  website: string | null;
  websites: string[] | null;
}

export interface ClientMatchIndex {
  emailToClient: Map<string, ClientLite>;
  domainToClient: Map<string, ClientLite>;
  named: Array<{ name: string; client: ClientLite }>;
}

// Generic mailbox providers whose domain says nothing about which client an
// attendee belongs to — never used for domain matching.
export const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "aol.com", "msn.com",
  "proton.me", "protonmail.com"
]);

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : null;
}

// URL or bare host → registrable host, lowercased, www stripped.
export function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = raw.includes("://") ? raw : `https://${raw}`;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

// Build the match indices once from the client rows.
export function buildClientMatchIndex(clients: ClientMatchRow[]): ClientMatchIndex {
  const emailToClient = new Map<string, ClientLite>();
  const domainToClient = new Map<string, ClientLite>();
  const named: Array<{ name: string; client: ClientLite }> = [];
  for (const c of clients) {
    if (!c.name) continue;
    const lite: ClientLite = { id: c.id, name: c.name };
    for (const raw of c.contact_emails ?? []) {
      const e = raw.trim().toLowerCase();
      if (!e) continue;
      if (!emailToClient.has(e)) emailToClient.set(e, lite);
      const d = emailDomain(e);
      if (d && !GENERIC_EMAIL_DOMAINS.has(d) && !domainToClient.has(d)) {
        domainToClient.set(d, lite);
      }
    }
    for (const w of [c.website, ...(c.websites ?? [])]) {
      const d = hostOf(w);
      if (d && !GENERIC_EMAIL_DOMAINS.has(d) && !domainToClient.has(d)) {
        domainToClient.set(d, lite);
      }
    }
    // Names shorter than 4 chars are too collision-prone for substring
    // matching against free-text event titles.
    if (c.name.trim().length >= 4) named.push({ name: c.name.toLowerCase(), client: lite });
  }
  return { emailToClient, domainToClient, named };
}

export function matchEventToClient(ev: CalendarEvent, index: ClientMatchIndex): ClientLite | null {
  const emails = (ev.attendees ?? []).map((a) => a.email.toLowerCase());
  for (const e of emails) {
    const hit = index.emailToClient.get(e);
    if (hit) return hit;
  }
  for (const e of emails) {
    const d = emailDomain(e);
    if (d) {
      const hit = index.domainToClient.get(d);
      if (hit) return hit;
    }
  }
  const summary = (ev.summary ?? "").toLowerCase();
  for (const n of index.named) {
    if (summary.includes(n.name)) return n.client;
  }
  return null;
}
