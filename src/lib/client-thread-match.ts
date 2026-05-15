// Shared "does this email thread belong to this client?" predicate.
// Used by:
//   - /clients/[id]/page.tsx (rendering "Email history" under each client)
//   - any future surface that needs to bucket inbound mail (auto-file
//     webhooks, batch crawls, etc.)
//
// A thread matches a client when ANY participant address either:
//   - exactly equals one of client.contactEmails (case-insensitive), or
//   - ends with @<domain> for any of the client.websites domains.
//
// Both signals are computed once per client (cheap), then the predicate
// is O(participants × signals).

export interface ClientMatchSignals {
  emailSet: Set<string>;   // lowercased exact addresses
  domainSet: Set<string>;  // lowercased bare hostnames, no protocol/path
}

export function buildClientSignals(client: {
  website: string | null;
  websites: string[];
  contactEmails: string[];
}): ClientMatchSignals {
  const emails = new Set<string>();
  for (const e of client.contactEmails) {
    const lower = e.trim().toLowerCase();
    if (lower) emails.add(lower);
  }

  const domains = new Set<string>();
  for (const w of [client.website, ...client.websites]) {
    const d = extractDomain(w);
    if (d) domains.add(d);
  }

  return { emailSet: emails, domainSet: domains };
}

// True if the thread has any participant matching one of the signals.
export function threadMatchesClient(
  participants: string[] | null | undefined,
  signals: ClientMatchSignals
): boolean {
  if (!participants || participants.length === 0) return false;
  if (signals.emailSet.size === 0 && signals.domainSet.size === 0) return false;

  for (const p of participants) {
    const addr = parseEmail(p);
    if (!addr) continue;
    if (signals.emailSet.has(addr)) return true;
    for (const d of signals.domainSet) {
      if (addr.endsWith(`@${d}`)) return true;
    }
  }
  return false;
}

// "Name <addr>" → "addr"; bare addresses pass through; non-emails → "".
export function parseEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  const raw = (m ? m[1] : addr).trim().toLowerCase();
  return raw.includes("@") ? raw : "";
}

// "https://www.rwu.com/about" → "rwu.com". Used for the @<domain> match.
export function extractDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  const cleaned = website
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase();
  return cleaned || null;
}

// Database-backed client matcher. Loads every client once, builds the
// signal sets, and exposes a `match(email)` predicate that returns the
// best client id (or null) for a given email address. Used by:
//   - email-intake (file new tasks under the right client at create time)
//   - /api/clients/rescan (backfill client_name on existing tasks)
//   - anywhere else that needs "which client is this email from?"
import { getSupabaseAdmin } from "@/lib/supabase-admin";

interface ClientRow {
  id: string;
  name: string;
  website: string | null;
  websites: string[] | null;
  contact_emails: string[] | null;
}

export interface LoadedClientMatcher {
  match(email: string | null | undefined): { id: string; name: string } | null;
  clientsLoaded: number;
}

export async function loadClientMatcher(): Promise<LoadedClientMatcher> {
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("id, name, website, websites, contact_emails");
  const rows = (data ?? []) as ClientRow[];

  // Pre-compute signals once per client.
  const indexed = rows.map((r) => ({
    id: r.id,
    name: r.name,
    signals: buildClientSignals({
      website: r.website,
      websites: r.websites ?? [],
      contactEmails: r.contact_emails ?? []
    })
  }));

  // Flat lookup for the common case (single-email match). Domain
  // match falls back to a linear scan since clients can share none of
  // their domains and the list is small.
  const byEmail = new Map<string, { id: string; name: string }>();
  for (const c of indexed) {
    for (const e of c.signals.emailSet) {
      // First writer wins. Conflicts here would mean two clients
      // claim the same contact email — rare; leader can clean it up.
      if (!byEmail.has(e)) byEmail.set(e, { id: c.id, name: c.name });
    }
  }

  return {
    clientsLoaded: indexed.length,
    match(email) {
      const addr = parseEmail(email ?? "");
      if (!addr) return null;
      const exact = byEmail.get(addr);
      if (exact) return exact;
      const at = addr.lastIndexOf("@");
      if (at < 0) return null;
      const domain = addr.slice(at + 1);
      for (const c of indexed) {
        if (c.signals.domainSet.has(domain)) return { id: c.id, name: c.name };
      }
      return null;
    }
  };
}
