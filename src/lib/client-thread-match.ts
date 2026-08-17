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

// Which signal claimed an address. "exact" = the address is listed in the
// client's contact_emails; "domain" = it merely ends with one of the client's
// website domains, so nobody actually told us this address belongs to them.
//
// The distinction matters wherever a domain match is too weak to act on: a
// client's own WordPress install sends as wordfence@theirdomain.com and their
// helpdesk as support@theirdomain.com, both of which match on "domain" and
// neither of which is the client writing to us. See the #email-notifs Slack
// ping in client-email-slack.ts for the first consumer.
export type ClientMatchVia = "exact" | "domain";

export interface ClientMatch {
  id: string;
  name: string;
  via: ClientMatchVia;
}

export interface LoadedClientMatcher {
  // Returns the first client that claims this email/domain. Kept for
  // legacy callers that only want one attribution (e.g. attributing
  // an inbound email-task to a single client).
  match(email: string | null | undefined): { id: string; name: string } | null;
  // Returns *every* client that claims this email/domain. Needed when
  // multiple clients share a contact (e.g. one CSM coordinating four
  // Villa-* accounts via the same `cmackey@` address) — otherwise the
  // touchpoint dashboard only lights up for whichever client happens
  // to be alphabetically first.
  matchAll(email: string | null | undefined): Array<{ id: string; name: string }>;
  // Same as matchAll, but says HOW each client claimed the address. Exact
  // hits always sort before domain hits, so [0] is the strongest verdict.
  matchAllDetailed(email: string | null | undefined): ClientMatch[];
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

  // Flat lookup for the common case (single-email match). Multi-value:
  // an email shared across N clients lands all N in the entry list.
  // Domain matches fall back to a linear scan; with <100 clients this
  // is fine.
  const byEmail = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of indexed) {
    for (const e of c.signals.emailSet) {
      const existing = byEmail.get(e);
      const slim = { id: c.id, name: c.name };
      if (existing) existing.push(slim);
      else byEmail.set(e, [slim]);
    }
  }

  // Exact hits are pushed first and the dedupe below is first-wins, so a
  // client that both lists the address AND owns the domain is recorded as
  // "exact" — the stronger verdict survives.
  function findAllDetailed(email: string | null | undefined): ClientMatch[] {
    const addr = parseEmail(email ?? "");
    if (!addr) return [];
    const out: ClientMatch[] = [];
    const seen = new Set<string>();
    const pushUnique = (m: ClientMatch) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      out.push(m);
    };

    const exactHits = byEmail.get(addr);
    if (exactHits) for (const m of exactHits) pushUnique({ ...m, via: "exact" });

    const at = addr.lastIndexOf("@");
    if (at >= 0) {
      const domain = addr.slice(at + 1);
      for (const c of indexed) {
        if (c.signals.domainSet.has(domain)) {
          pushUnique({ id: c.id, name: c.name, via: "domain" });
        }
      }
    }
    return out;
  }

  function findAll(email: string | null | undefined): Array<{ id: string; name: string }> {
    return findAllDetailed(email).map(({ id, name }) => ({ id, name }));
  }

  return {
    clientsLoaded: indexed.length,
    match(email) {
      const all = findAll(email);
      return all.length > 0 ? all[0] : null;
    },
    matchAll: findAll,
    matchAllDetailed: findAllDetailed
  };
}
