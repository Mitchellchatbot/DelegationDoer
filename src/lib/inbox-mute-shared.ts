// Pure mute-rule helpers — no DB, no server-only imports, so the thread-row
// mute control can share exactly the matching and naming logic the server uses.
// Anything that touches Supabase lives in lib/inbox-mute.ts.

export type MuteMatchType =
  | "sender_exact"
  | "sender_domain"
  | "sender_local"
  | "subject_contains";

export const MUTE_MATCH_TYPES: MuteMatchType[] = [
  "sender_exact", "sender_domain", "sender_local", "subject_contains"
];

export interface MuteRule {
  id: string;
  matchType: MuteMatchType;
  value: string;
  note: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

// Pull the bare address out of `"Name" <addr@host>` or a plain `addr@host`.
export function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const bare = (angle ? angle[1] : raw).trim().toLowerCase();
  return bare.includes("@") ? bare : null;
}

export function splitAddress(addr: string): { local: string; domain: string } {
  const at = addr.lastIndexOf("@");
  return at === -1
    ? { local: addr, domain: "" }
    : { local: addr.slice(0, at), domain: addr.slice(at + 1) };
}

// Normalize a rule's value for storage + comparison. Strips the decoration
// people naturally type — "*@mailchimp.com", "wordpress@*", "@example.com" —
// down to the bare thing each type compares against.
export function normalizeRuleValue(matchType: MuteMatchType, raw: string): string {
  const v = raw.trim().toLowerCase();
  if (matchType === "sender_domain") return v.replace(/^\*?@/, "");
  if (matchType === "sender_local") return v.replace(/@\*?$/, "");
  return v;
}

// How a rule reads in the UI.
export function describeRule(matchType: MuteMatchType, value: string): string {
  switch (matchType) {
    case "sender_exact": return value;
    case "sender_domain": return "*@" + value;
    case "sender_local": return value + "@*";
    case "subject_contains": return `subject contains "${value}"`;
  }
}

export function matchTypeLabel(matchType: MuteMatchType): string {
  switch (matchType) {
    case "sender_exact": return "This sender";
    case "sender_domain": return "Whole domain";
    case "sender_local": return "Same mailbox name, any domain";
    case "subject_contains": return "Subject contains";
  }
}

export interface MuteCandidate {
  from: string | null;
  subject: string | null;
}

// A compiled rule set. `match` returns the RULE that caught the message, not a
// boolean — that's what lets the Muted view say which rule is responsible,
// which is the difference between a filter people trust and one they route
// around. Sender rules are checked before subject rules, and exact before
// broad, so the most specific explanation wins.
export interface MuteMatcher {
  rules: MuteRule[];
  match: (candidate: MuteCandidate) => MuteRule | null;
  isEmpty: boolean;
}

export function compileMuteRules(rules: MuteRule[]): MuteMatcher {
  const active = rules.filter((r) => r.enabled);
  const exact = new Map<string, MuteRule>();
  const domain = new Map<string, MuteRule>();
  const local = new Map<string, MuteRule>();
  const subject: MuteRule[] = [];
  for (const r of active) {
    if (r.matchType === "sender_exact") exact.set(r.value, r);
    else if (r.matchType === "sender_domain") domain.set(r.value, r);
    else if (r.matchType === "sender_local") local.set(r.value, r);
    else subject.push(r);
  }

  return {
    rules: active,
    isEmpty: active.length === 0,
    match(candidate) {
      const addr = addressOf(candidate.from);
      if (addr) {
        const hit = exact.get(addr);
        if (hit) return hit;
        const parts = splitAddress(addr);
        const d = domain.get(parts.domain);
        if (d) return d;
        const l = local.get(parts.local);
        if (l) return l;
      }
      if (subject.length > 0 && candidate.subject) {
        const s = candidate.subject.toLowerCase();
        for (const r of subject) {
          if (s.includes(r.value)) return r;
        }
      }
      return null;
    }
  };
}

// Local-parts that are automation by convention rather than by domain. These
// are exactly the ones that arrive as <name>@<every client's own domain> —
// WordPress plugin mail being the case that motivated the whole feature — so a
// domain rule can't catch them without also killing that client's real mail.
const AUTOMATION_LOCAL_PARTS = new Set([
  "wordpress", "wp", "noreply", "no-reply", "donotreply", "do-not-reply",
  "notifications", "notification", "alerts", "alert", "automated", "auto",
  "mailer-daemon", "postmaster", "cron", "system", "bot", "updates"
]);

export interface MuteSuggestion {
  matchType: MuteMatchType;
  value: string;
  // Rendered as the option's caption — says what this rule will and won't catch.
  hint: string;
  // Pre-selected option. Only ever one.
  recommended?: boolean;
  // Flags an option that can plausibly swallow real mail, so the UI can warn.
  broad?: boolean;
}

// Offer the rules that would catch this message, safest-first, with the one
// most likely to be right pre-selected. Returns [] when there's no address to
// work from (subject-only rules stay a manual choice — too easy to overreach).
export function suggestRules(candidate: MuteCandidate): MuteSuggestion[] {
  const addr = addressOf(candidate.from);
  if (!addr) return [];
  const { local, domain } = splitAddress(addr);
  const automation = AUTOMATION_LOCAL_PARTS.has(local);

  const out: MuteSuggestion[] = [
    {
      matchType: "sender_exact",
      value: addr,
      hint: "Only this exact address.",
      recommended: !automation
    }
  ];

  if (automation && domain) {
    // Put the local-part rule FIRST when the sender looks like automation:
    // it's both the safest broad option (it can't catch a human at that
    // domain) and the only one that generalizes across clients.
    out.unshift({
      matchType: "sender_local",
      value: local,
      hint: `Every ${local}@… address, whatever the domain. Catches this across all clients.`,
      recommended: true
    });
  }

  if (domain) {
    out.push({
      matchType: "sender_domain",
      value: domain,
      hint: `Everything from ${domain} — including people.`,
      broad: true
    });
  }

  return out;
}
