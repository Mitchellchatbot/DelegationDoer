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
