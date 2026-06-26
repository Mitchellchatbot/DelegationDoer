// Server-only helpers for the bulk "monthly SEO update" email tool.
//
// The tool writes ONE email and sends it to many clients in a single
// action (one outbound Missive thread per client, via composeNewThread).
// This module is the single source of truth for:
//   - the full client roster (every client is listed so the picker is
//     complete; canEmail flags whether a contact address is on file —
//     clients without one are shown disabled and are never sent to),
//   - the "shared recipient" overlap flag (one contact email that's also
//     the contact for another client — flagged so the approver can
//     manually exclude duplicates; see [[thread-read-auth-invariant]]
//     siblings in digest-recommendations for the same grouping idea),
//   - per-client placeholder rendering ({{client_name}} etc.),
//   - a small bounded-concurrency runner so we don't fire N sends at once.
//
// Deliberately does NOT touch email_drafts — these blasts must stay out
// of touchpoint health (see lib/client-touchpoint.ts). The route logs the
// created thread ids to bulk_email_threads purely so touchpoint-sync can
// EXCLUDE them; the only other record of a send is the route's response +
// the resulting Missive threads.

import { getClients, type Client } from "@/lib/clients-data";

export interface SharedEmail {
  email: string;
  others: Array<{ clientId: string; name: string }>;
}

export interface BulkRecipientClient {
  clientId: string;
  name: string;
  contactName: string | null;
  website: string | null;
  // Cleaned (trimmed, non-empty) contact addresses, original casing.
  // May be empty when canEmail is false.
  contactEmails: string[];
  // False when no contact email is on file — the client is still listed
  // (disabled) for visibility but is never sent to (also enforced in the route).
  canEmail: boolean;
  updateCadence: Client["updateCadence"];
  status: string;
  teamId: string | null;
  // Non-empty when one of this client's addresses is ALSO the contact for
  // another client — surfaced as a warning tag in the UI.
  sharedEmails: SharedEmail[];
}

// Normalize for identity comparison only — sends use the original casing.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Every client, in display order (getClients already sorts by display_order
// asc, then name). Status is not a gate — non-active clients with an email
// are valid recipients. A client with no usable contact email is flagged
// canEmail=false so the UI can list it (disabled) without ever sending to it.
// Each client carries its sharedEmails overlap so the UI can warn about
// contacts that span multiple businesses.
export async function getBulkRoster(): Promise<{ clients: BulkRecipientClient[] }> {
  const all = await getClients();

  // Keep the whole roster; emails may be empty (→ canEmail=false below).
  const roster = all
    .map((c) => ({ client: c, emails: c.contactEmails.map((e) => e.trim()).filter(Boolean) }));

  // Index every client's addresses → who else holds that address. A client
  // with no contact email contributes nothing, so it can never appear here.
  const clientsByEmail = new Map<string, Array<{ clientId: string; name: string }>>();
  for (const { client, emails } of roster) {
    for (const raw of emails) {
      const key = normalizeEmail(raw);
      if (!key) continue;
      const list = clientsByEmail.get(key) ?? [];
      list.push({ clientId: client.id, name: client.name });
      clientsByEmail.set(key, list);
    }
  }

  const clients: BulkRecipientClient[] = roster.map(({ client, emails }) => {
    const sharedEmails: SharedEmail[] = [];
    for (const raw of emails) {
      const key = normalizeEmail(raw);
      const others = (clientsByEmail.get(key) ?? []).filter((o) => o.clientId !== client.id);
      if (others.length > 0) sharedEmails.push({ email: key, others });
    }
    return {
      clientId: client.id,
      name: client.name,
      contactName: client.contactName,
      website: client.website ?? client.websites[0] ?? null,
      contactEmails: emails,
      canEmail: emails.length > 0,
      updateCadence: client.updateCadence,
      status: client.status,
      teamId: client.teamId,
      sharedEmails
    };
  });

  return { clients };
}

// Fill the three supported placeholders for one client. Case-insensitive,
// tolerant of inner whitespace ({{ client_name }}). Unknown tokens are
// left untouched so a stray brace can't blank out copy. Applied to BOTH
// subject and body, server-side, once per client.
export function renderTemplate(template: string, c: BulkRecipientClient): string {
  return template
    .replace(/\{\{\s*client_name\s*\}\}/gi, c.name)
    .replace(/\{\{\s*contact_name\s*\}\}/gi, c.contactName ?? "there")
    .replace(/\{\{\s*website\s*\}\}/gi, c.website ?? "");
}

// Run `fn` over items with at most `limit` in flight, preserving input
// order in the result array. Keeps us from opening N simultaneous SMTP
// sends against the missiveclone backend.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
