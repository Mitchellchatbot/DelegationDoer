// Server-only helpers for the bulk "monthly SEO update" email tool.
//
// The tool writes ONE email and sends it to many clients in a single
// action (one outbound Missive thread per client, via composeNewThread).
// This module is the single source of truth for:
//   - which clients are eligible (active + at least one contact email),
//   - the "shared recipient" overlap flag (one contact email that's also
//     the contact for another client — flagged so the approver can
//     manually exclude duplicates; see [[thread-read-auth-invariant]]
//     siblings in digest-recommendations for the same grouping idea),
//   - per-client placeholder rendering ({{client_name}} etc.),
//   - a small bounded-concurrency runner so we don't fire N sends at once.
//
// Deliberately does NOT touch email_drafts — these blasts must stay out
// of touchpoint health (see lib/client-touchpoint.ts). The only record
// of a send is the route's response + the resulting Missive threads.

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
  contactEmails: string[];
  updateCadence: Client["updateCadence"];
  status: string;
  teamId: string | null;
  // Non-empty when one of this client's addresses is ALSO the contact for
  // another active client — surfaced as a warning tag in the UI.
  sharedEmails: SharedEmail[];
}

// Normalize for identity comparison only — sends use the original casing.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Active clients with at least one usable contact email, in display order
// (getClients already sorts by display_order asc, then name). Each client
// carries its sharedEmails overlap so the UI can warn about contacts that
// span multiple businesses.
export async function getBulkRoster(): Promise<{ clients: BulkRecipientClient[] }> {
  const all = await getClients();

  // Eligible = active (status null/empty treated as active, mirroring the
  // digest route) AND has >=1 non-empty contact email.
  const eligible = all
    .map((c) => ({ client: c, emails: c.contactEmails.map((e) => e.trim()).filter(Boolean) }))
    .filter(({ client, emails }) => (!client.status || client.status === "active") && emails.length > 0);

  // Index every eligible client's addresses → who else holds that address.
  // Built from the eligible set only: a client with no contact email can't
  // share one, so it can never appear here.
  const clientsByEmail = new Map<string, Array<{ clientId: string; name: string }>>();
  for (const { client, emails } of eligible) {
    for (const raw of emails) {
      const key = normalizeEmail(raw);
      if (!key) continue;
      const list = clientsByEmail.get(key) ?? [];
      list.push({ clientId: client.id, name: client.name });
      clientsByEmail.set(key, list);
    }
  }

  const clients: BulkRecipientClient[] = eligible.map(({ client, emails }) => {
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
