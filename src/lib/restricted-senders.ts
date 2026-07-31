// Sender-scoped mail privacy.
//
// inbox_privacy (src/lib/inbox-access.ts) hides a WHOLE mailbox. This hides
// individual CONVERSATIONS inside an otherwise-shared mailbox, keyed on who
// is corresponding. Motivating case: Deel payroll mail in the boss's inbox,
// which seven people read via the "Boss's mail" inbox_space — see the
// migration header in supabase/migrations/20260807000000_restricted_senders.sql.
//
// Model mirrors inbox_privacy: a matching thread is visible ONLY to the users
// listed as viewers on every rule it matches. Role is irrelevant — leaders and
// stealth admins are excluded too, exactly like a private inbox.
//
// A rule with an EMPTY viewer list hides the mail from everyone, mailbox owner
// included. That's not a degenerate case to defend against — it's how the Deel
// rules are seeded: the mail keeps arriving in Microsoft 365 and is read there,
// DD just stops surfacing it anywhere.
//
// Matching is CORRESPONDENT-wide, not "the sender": a thread matches if any
// participant (list shape) or any message from/to/cc (detail shape) matches.
// Matching only the newest sender would leak a Deel thread whose latest
// message is our own outbound reply.
//
// FAIL OPEN, deliberately. A missing table (code deployed ahead of the
// migration) or a transient Supabase error yields "nothing is restricted"
// rather than "nothing is visible". Failing closed would blank every inbox
// for every user on any DB hiccup — a far worse and far likelier outcome than
// a brief window on threads the same people could already read yesterday.
// getPrivateInboxOwners set this precedent; keep the two consistent.
//
// No `import "server-only"`: this module is pulled in by the setInterval
// loops registered in src/instrumentation.ts (email-intake-bootstrap,
// email-notifications-poller), same as inbox-access.ts.

import { cache } from "@/lib/safe-cache";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { rawEmail } from "@/lib/email-format";
import type { MissiveThread, MissiveMessage } from "@/lib/missive-client";

export type RestrictedMatchKind = "domain" | "exact";

export interface RestrictedSenderRule {
  id: string;
  /** Lower-cased domain or full address. */
  pattern: string;
  matchKind: RestrictedMatchKind;
  label: string;
  viewerUserIds: Set<string>;
}

// Structural shapes so call sites can pass raw missive objects through
// unchanged, and leaner ones (badges) don't have to fabricate fields.
export type ThreadLike = Pick<MissiveThread, "participants"> & {
  last_from?: string | null;
};
export type MessageLike = Pick<MissiveMessage, "from_addr" | "to_addrs" | "cc_addrs">;

interface RuleRow {
  id: string;
  pattern: string;
  match_kind: string;
  label: string;
}

// Best-effort load of the enabled rules + their viewers. See the fail-open
// note above: any error yields [], i.e. nothing is restricted. Mirrors
// getPrivateInboxOwners, including only logging when the error isn't about
// our own (possibly not-yet-migrated) table.
async function fetchRules(): Promise<RestrictedSenderRule[]> {
  const supabase = getSupabaseAdmin();
  const { data: ruleRows, error: ruleErr } = await supabase
    .from("restricted_senders")
    .select("id, pattern, match_kind, label")
    .eq("enabled", true);
  if (ruleErr) {
    if (!/restricted_senders/.test(ruleErr.message)) {
      console.error("[restricted-senders] rule lookup failed", ruleErr);
    }
    return [];
  }
  const rows = (ruleRows ?? []) as RuleRow[];
  if (rows.length === 0) return [];

  const { data: viewerRows, error: viewerErr } = await supabase
    .from("restricted_sender_viewers")
    .select("rule_id, user_id")
    .in("rule_id", rows.map((r) => r.id));
  if (viewerErr) {
    if (!/restricted_sender_viewers/.test(viewerErr.message)) {
      console.error("[restricted-senders] viewer lookup failed", viewerErr);
    }
    // Viewers unknown — treat as "nobody is restricted" rather than
    // restricting everyone out of a rule we can't resolve access for.
    return [];
  }

  const viewersByRule = new Map<string, Set<string>>();
  for (const v of (viewerRows ?? []) as { rule_id: string; user_id: string }[]) {
    let set = viewersByRule.get(v.rule_id);
    if (!set) {
      set = new Set<string>();
      viewersByRule.set(v.rule_id, set);
    }
    set.add(v.user_id);
  }

  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern.trim().toLowerCase(),
    matchKind: r.match_kind === "exact" ? "exact" : "domain",
    label: r.label,
    viewerUserIds: viewersByRule.get(r.id) ?? new Set<string>()
  }));
}

// Request-scoped memoization. Deliberately NOT unstable_cache: a deny rule
// must take effect immediately (a TTL is a window where restricted mail is
// still visible after someone restricts it), this module runs in the
// instrumentation/cron layer where unstable_cache doesn't belong, and the
// query is one indexed select over a handful of rows on a path that already
// makes a clone round-trip.
export const getRestrictedSenderRules: () => Promise<RestrictedSenderRule[]> =
  cache(fetchRules);

// ---------------------------------------------------------------------------
// Pure predicates — no DB, so they're cheap to reason about and to smoke-test.
// ---------------------------------------------------------------------------

// One raw field may carry SEVERAL addresses. missive-client's toStringArray
// normally splits these (participants is stored as "a; b", to_addrs as "a, b"),
// but this module must not depend on the caller having normalized: rawEmail
// only extracts the FIRST <…>, so an unsplit "Me <me@x>; Them <them@deel.com>"
// would resolve to me@x and silently miss the restricted party. Split on the
// same delimiters toStringArray uses before matching.
//
// A display name containing a comma ("Toledo, Lívia" <l@deel.com>) splits into
// a junk fragment with no "@" (dropped) plus the fragment carrying the real
// address — so the address is still found. Same trade-off toStringArray makes.
function normalizeAddresses(addr: string | null | undefined): string[] {
  if (!addr) return [];
  return String(addr)
    .split(/[;,]/)
    .map((part) => rawEmail(part).trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/**
 * The rule matching `addr`, or null. First match wins. `addr` may hold several
 * addresses ("a; b") — any one of them matching is a match.
 */
export function addressMatches(
  addr: string | null | undefined,
  rules: RestrictedSenderRule[]
): RestrictedSenderRule | null {
  if (rules.length === 0) return null;
  for (const email of normalizeAddresses(addr)) {
    const at = email.lastIndexOf("@");
    const domain = at > 0 ? email.slice(at + 1) : "";
    for (const r of rules) {
      if (r.matchKind === "exact") {
        if (email === r.pattern) return r;
        continue;
      }
      // Domain equality or a subdomain of it. Never a substring test —
      // "deel.com".includes would also match deel.com.evil.tld.
      if (domain === r.pattern || domain.endsWith(`.${r.pattern}`)) return r;
    }
  }
  return null;
}

// Coerce a list-ish field to an array WITHOUT spreading. The clone stores
// these as TEXT and missive-client's toStringArray normally splits them, but
// the types say string[] while the wire shape is a string — and `[...aString]`
// silently explodes into single characters, none of which contain "@", so a
// restricted thread would match nothing at all. Never spread these directly.
// (normalizeAddresses below does the actual "a; b" splitting.)
function asList(v: unknown): Array<string | null | undefined> {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") return [v];
  return [];
}

function firstMatch(
  addrs: Iterable<string | null | undefined>,
  rules: RestrictedSenderRule[]
): RestrictedSenderRule | null {
  for (const a of addrs) {
    const hit = addressMatches(a, rules);
    if (hit) return hit;
  }
  return null;
}

/** Thread-list shape: every participant, plus the newest sender. */
export function threadMatches(
  t: ThreadLike,
  rules: RestrictedSenderRule[]
): RestrictedSenderRule | null {
  if (rules.length === 0) return null;
  return firstMatch([...asList(t.participants), t.last_from], rules);
}

/** Detail shape: every from/to/cc across every message. Authoritative. */
export function messagesMatch(
  msgs: MessageLike[],
  rules: RestrictedSenderRule[]
): RestrictedSenderRule | null {
  if (rules.length === 0) return null;
  for (const m of msgs) {
    const hit = firstMatch(
      [m.from_addr, ...asList(m.to_addrs), ...asList(m.cc_addrs)],
      rules
    );
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-actor guard
// ---------------------------------------------------------------------------

export interface RestrictedSenderGuard {
  blocksThread(t: ThreadLike): boolean;
  blocksMessages(msgs: MessageLike[]): boolean;
  blocksAddress(addr: string | null | undefined): boolean;
  /** Matching rule label, for intake audit rows. */
  reasonForThread(t: ThreadLike): string | null;
  reasonForMessages(msgs: MessageLike[]): string | null;
}

// `null` means "this actor may see everything" — either no rules are enabled
// (the overwhelmingly common case) or the actor is a viewer on all of them.
// Deliberately the same null-means-unrestricted convention as
// visibleAccountIdsFor, so every call site reads the same way:
//
//     const restrict = await restrictionsFor(me);
//     const rows = restrict ? raw.filter((t) => !restrict.blocksThread(t)) : raw;
//
// A thread restricted by several rules requires viewer access on ALL of them,
// which is what makes this compose with viewerIdsForAddresses below.
export async function restrictionsFor(
  actor: { id: string }
): Promise<RestrictedSenderGuard | null> {
  const rules = await getRestrictedSenderRules();
  const applicable = rules.filter((r) => !r.viewerUserIds.has(actor.id));
  if (applicable.length === 0) return null;
  return {
    blocksThread: (t) => threadMatches(t, applicable) !== null,
    blocksMessages: (msgs) => messagesMatch(msgs, applicable) !== null,
    blocksAddress: (addr) => addressMatches(addr, applicable) !== null,
    reasonForThread: (t) => threadMatches(t, applicable)?.label ?? null,
    reasonForMessages: (msgs) => messagesMatch(msgs, applicable)?.label ?? null
  };
}

// For the notification fan-out, which filters a USER LIST rather than a row
// list. Returns the ids allowed to be notified about mail involving these
// addresses, or null when nothing matches (→ don't filter at all).
//
// Intersection across every matching rule, to agree with restrictionsFor:
// matching two rules means you must be a viewer on both.
export async function viewerIdsForAddresses(
  addrs: Iterable<string | null | undefined>
): Promise<Set<string> | null> {
  const rules = await getRestrictedSenderRules();
  if (rules.length === 0) return null;
  const matched = new Map<string, RestrictedSenderRule>();
  for (const a of addrs) {
    const hit = addressMatches(a, rules);
    if (hit) matched.set(hit.id, hit);
  }
  if (matched.size === 0) return null;
  let allowed: Set<string> | null = null;
  for (const rule of matched.values()) {
    if (allowed === null) {
      allowed = new Set(rule.viewerUserIds);
    } else {
      for (const id of [...allowed]) {
        if (!rule.viewerUserIds.has(id)) allowed.delete(id);
      }
    }
  }
  return allowed ?? new Set<string>();
}
