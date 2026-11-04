import "server-only";

import { buildClientSignals, parseEmail, type ClientMatchSignals } from "@/lib/client-thread-match";
import { looksRoleAddress } from "@/lib/email-intake-filters";
import type { ThreadFacts } from "@/lib/exec/email-state";
import type { ClientMatchVia, HisMessage, MatchConfidence, PrincipalMailThread } from "@/lib/exec/email-types";
import { listClientMatchSignals } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals } from "@/lib/exec/sources/dd-types";
import { listInternalAddresses, type CloneCallOptions } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";

// Which client an email thread of his is about (contract §3.12, L14).
//
// DD already knows two signals per client (client-thread-match.ts): the exact
// addresses in clients.contact_emails, and the website hosts. Both are
// polluted in known ways, so the verdict carries a confidence and every hit
// is screened first:
//   - our own mail can match a client outright (team@scaledai.org is seeded
//     as a contact on three clients), so an address of the team's own (a
//     connected mailbox, or one of their domains) never matches a client.
//     A domain stops being "ours" when a client claims it as its website:
//     that client's real mail must not read as internal;
//   - a domain-only hit can be the client's own automation (wordfence@,
//     support@ on their domain), so a role address on a domain hit is only
//     a "low" match;
//   - one address (a shared CSM) can belong to several clients, which is
//     ambiguous: "low", with the number of candidates.
// Only active clients (status null or "active", as DD's own surfaces read
// it) take part, in the match and in the domain claims.
//
// Confidence (L14):
//   exact contact                      high
//   domain, not a role address         medium
//   domain + role address              low
//   several distinct clients           low (candidates = how many)
//
// Pure apart from loadClientMatcher, which reads the clients (sources/dd.ts)
// and the team's addresses (sources/mail.ts) and throws when either read
// fails: a matcher built from a failed read would call every client email
// "no client".

/** The client verdict for a list of correspondents, in the columns exec_email_threads stores. */
export type ThreadClientFacts = Pick<ThreadFacts, "clientId" | "clientName" | "clientMatchVia" | "matchConfidence" | "clientCandidates">;

export interface ClientMatch {
  clientId: string | null;
  clientName: string | null;
  via: ClientMatchVia | null;
  confidence: MatchConfidence | null;
  /** Distinct active clients the addresses pointed at; 0 means no client. */
  candidates: number;
}

export interface ClientMatcher {
  /**
   * The client these addresses point at, strongest evidence first: an exact
   * contact beats a domain hit, which beats a role address on a domain; among
   * equals the earlier address wins (callers pass the newest first). The
   * team's own addresses are skipped.
   */
  match(addresses: readonly string[]): ClientMatch;
  /** One of the team's own addresses, or on one of their domains that no active client claims. */
  isInternal(email: string): boolean;
  /** How many active clients the matcher knows. */
  readonly activeClients: number;
}

/** The team's own addresses and domains (listInternalAddresses: free-mail domains already left out). */
export interface InternalAddresses {
  addresses: readonly string[];
  domains: readonly string[];
}

const NO_CLIENT: Readonly<ClientMatch> = Object.freeze({ clientId: null, clientName: null, via: null, confidence: null, candidates: 0 });

/**
 * DD's own reading of clients.status (a free-text column nothing in the app
 * writes): a client is active when the column is empty or exactly "active".
 */
export function isActiveClientStatus(status: string | null | undefined): boolean {
  return status === null || status === undefined || status === "" || status === "active";
}

/** Everything after the last "@", as restricted-senders and DD's matcher read a domain; "" when there is none. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : "";
}

const lower = (s: string) => s.trim().toLowerCase();

// How strong one client's evidence is: lower is stronger.
const EXACT = 0;
const DOMAIN = 1;
const ROLE_DOMAIN = 2;
type Strength = typeof EXACT | typeof DOMAIN | typeof ROLE_DOMAIN;

interface IndexedClient {
  id: string;
  name: string;
  signals: ClientMatchSignals;
}

interface Hit {
  client: IndexedClient;
  strength: Strength;
  /** Index of the first address that produced this client's strongest evidence. */
  at: number;
}

/**
 * A matcher over these clients and the team's own addresses (L14). Inactive
 * clients are ignored entirely. `internal.domains` minus every domain an
 * active client claims as its website is what counts as an internal domain.
 */
export function buildClientMatcher(clients: readonly DdClientMatchSignals[], internal: InternalAddresses): ClientMatcher {
  const indexed: IndexedClient[] = clients
    .filter((c) => typeof c?.id === "string" && c.id.length > 0 && isActiveClientStatus(c.status))
    .map((c) => ({
      id: c.id,
      name: typeof c.name === "string" ? c.name : "",
      signals: buildClientSignals({
        website: c.website ?? null,
        websites: Array.isArray(c.websites) ? c.websites : [],
        contactEmails: Array.isArray(c.contactEmails) ? c.contactEmails : []
      })
    }));

  const byEmail = new Map<string, IndexedClient[]>();
  const byDomain = new Map<string, IndexedClient[]>();
  const claimed = new Set<string>();
  for (const c of indexed) {
    for (const e of c.signals.emailSet) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
    for (const d of c.signals.domainSet) {
      byDomain.set(d, [...(byDomain.get(d) ?? []), c]);
      claimed.add(d);
    }
  }

  const internalAddresses = new Set((internal?.addresses ?? []).filter((a) => typeof a === "string").map(lower).filter((a) => a.includes("@")));
  const internalDomains = new Set(
    (internal?.domains ?? [])
      .filter((d) => typeof d === "string")
      .map(lower)
      .filter((d) => d.length > 0 && !claimed.has(d))
  );

  const isInternalAddress = (address: string): boolean => {
    if (internalAddresses.has(address)) return true;
    const domain = domainOf(address);
    return domain.length > 0 && internalDomains.has(domain);
  };

  return {
    activeClients: indexed.length,
    isInternal(email: string): boolean {
      const address = parseEmail(typeof email === "string" ? email : "");
      return address.length > 0 && isInternalAddress(address);
    },
    match(addresses: readonly string[]): ClientMatch {
      const hits = new Map<string, Hit>();
      const record = (client: IndexedClient, strength: Strength, at: number) => {
        const seen = hits.get(client.id);
        if (!seen || strength < seen.strength) hits.set(client.id, { client, strength, at });
      };
      (Array.isArray(addresses) ? addresses : []).forEach((raw, at) => {
        const address = parseEmail(typeof raw === "string" ? raw : "");
        if (!address || isInternalAddress(address)) return;
        for (const c of byEmail.get(address) ?? []) record(c, EXACT, at);
        const domainHits = byDomain.get(domainOf(address)) ?? [];
        if (domainHits.length === 0) return;
        const strength: Strength = looksRoleAddress(address).filtered ? ROLE_DOMAIN : DOMAIN;
        for (const c of domainHits) record(c, strength, at);
      });
      if (hits.size === 0) return { ...NO_CLIENT };
      const ranked = [...hits.values()].sort(
        (a, b) =>
          a.strength - b.strength ||
          a.at - b.at ||
          (a.client.name < b.client.name ? -1 : a.client.name > b.client.name ? 1 : 0) ||
          (a.client.id < b.client.id ? -1 : a.client.id > b.client.id ? 1 : 0)
      );
      const top = ranked[0];
      const confidence: MatchConfidence = ranked.length > 1 ? "low" : top.strength === EXACT ? "high" : top.strength === DOMAIN ? "medium" : "low";
      return {
        clientId: top.client.id,
        clientName: top.client.name || null,
        via: top.strength === EXACT ? "exact" : "domain",
        confidence,
        candidates: ranked.length
      };
    }
  };
}

/** Newest first by sentAt, then by id, so the order never depends on how the clone listed them. */
function newestFirst(messages: readonly HisMessage[]): HisMessage[] {
  const ms = (m: HisMessage) => {
    const t = Date.parse(m.sentAt);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...messages].sort((a, b) => ms(b) - ms(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * The addresses a thread is matched on (§3.12): the senders of his inbound
 * messages, newest first; for a thread he only sent in, the "to" recipients
 * of his outbound messages, newest first. Junk-folder copies don't count.
 */
export function threadCorrespondents(t: Pick<PrincipalMailThread, "his">): string[] {
  const messages = (Array.isArray(t?.his) ? t.his : []).filter((m) => !m.isJunk);
  const inbound = newestFirst(messages.filter((m) => m.direction === "inbound"));
  const correspondents =
    inbound.length > 0
      ? inbound.map((m) => m.from?.email ?? "")
      : newestFirst(messages.filter((m) => m.direction === "outbound")).flatMap((m) => m.to.map((a) => a.email));
  return correspondents.filter((a) => a.length > 0);
}

/** The client facts of one of his threads: matcher.match over threadCorrespondents, as exec_email_threads stores them. */
export function matchThreadClient(t: Pick<PrincipalMailThread, "his">, matcher: ClientMatcher): ThreadClientFacts {
  const r = matcher.match(threadCorrespondents(t));
  return {
    clientId: r.clientId,
    clientName: r.clientName,
    clientMatchVia: r.via,
    matchConfidence: r.confidence,
    clientCandidates: r.candidates
  };
}

/**
 * The matcher for one triage job: every client's match signals and the
 * team's own addresses (a clone account read), loaded fresh. Either read
 * failing throws, and the job retries; it never matches against nothing.
 */
export async function loadClientMatcher(principal: ExecPrincipal, opts: CloneCallOptions = {}): Promise<ClientMatcher> {
  const [clients, internal] = await Promise.all([
    listClientMatchSignals(principal, { signal: opts.signal }),
    listInternalAddresses(principal, opts)
  ]);
  return buildClientMatcher(clients, internal);
}
