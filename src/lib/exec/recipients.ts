import { createHash } from "node:crypto";
import { looksRoleAddress, looksUnreplyable } from "@/lib/email-intake-filters";
import type { DraftAddress, DraftKind, ReplyCandidates, ReplyMode } from "@/lib/exec/drafts-types";
import type { HisMessage, ParsedAddress, PrincipalMailThread } from "@/lib/exec/email-types";
import { computeAnswered, parseAddressList } from "@/lib/exec/sources/mail";
import { addressMatches, type RestrictedSenderRule } from "@/lib/restricted-senders";

// Recipient derivation and checks (P4 contract §3.5; Area B). Pure at call
// time: no I/O, every input is handed in. It imports P3's computeAnswered and
// parseAddressList from sources/mail.ts (the contract's anchor rule, L8), so
// it is server-side code: a client component must not import it.
//
// Addresses follow CL2C §3.0.3 (trimmed, at most 254 characters, exactly one
// "@", a "." after it, no whitespace, control characters or <>,;") and are
// lowercased; display names come from senders and are cleaned, never trusted
// (C75: a recipient is shown by its address).

export interface DraftAddressInput { address: string; name?: string | null }

const MAX_ADDRESS_CHARS = 254;
const MAX_NAME_CHARS = 256;
const MAX_RECIPIENTS = 20;
const MAX_THREAD_ADDRESSES = 200;

/** Control, zero-width, bidi-override and BOM characters: they can make a name read differently from what it is. */
function isInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** A display name as DD shows it: invisible characters out, whitespace collapsed, at most 256 characters; empty is null. */
function cleanName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let out = "";
  for (const ch of raw) out += isInvisible(ch.codePointAt(0) as number) ? " " : ch;
  const name = out.replace(/\s+/g, " ").trim();
  if (name.length === 0) return null;
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

/** CL2C §3.0.3 rule: trimmed, ≤254, exactly one "@", a "." after it, no whitespace, control characters or <>,;"; lowercased. Name: control characters stripped, ≤256, empty → null. null when invalid. */
export function normalizeDraftAddress(a: DraftAddressInput): DraftAddress | null {
  if (typeof a !== "object" || a === null || typeof a.address !== "string") return null;
  const s = a.address.trim();
  if (s.length === 0 || s.length > MAX_ADDRESS_CHARS) return null;
  if (/\s/.test(s)) return null;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return null;
  const dot = s.indexOf(".", at + 2);
  if (dot === -1 || dot === s.length - 1) return null;
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
    if (ch === "<" || ch === ">" || ch === "," || ch === ";" || ch === '"') return null;
  }
  return { address: s.toLowerCase(), name: cleanName(a.name) };
}

const lower = (s: string): string => s.trim().toLowerCase();
const lowerSet = (set: Iterable<string>): Set<string> => new Set([...set].map(lower));
const fromParsed = (p: ParsedAddress): DraftAddress | null => normalizeDraftAddress({ address: p.email, name: p.name });
const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/** The addresses of `list` that aren't his and aren't in `exclude`, deduplicated, in order; each kept address is added to `exclude`. */
function keep(list: readonly ParsedAddress[], own: ReadonlySet<string>, exclude: Set<string>): DraftAddress[] {
  const out: DraftAddress[] = [];
  for (const p of list) {
    const a = fromParsed(p);
    if (a === null || own.has(a.address) || exclude.has(a.address)) continue;
    exclude.add(a.address);
    out.push(a);
  }
  return out;
}

export interface DerivedReply {
  mode: ReplyMode; parent: HisMessage; to: DraftAddress[]; cc: DraftAddress[];
  candidates: ReplyCandidates; threadAddresses: string[];
}

/**
 * L8 + C8. Anchor = computeAnswered(his, { ownAddresses }).newestInbound (junk
 * and self-copies skipped); none → follow-up on his newest non-junk outbound;
 * neither (or a parent without a parsable From, or a follow-up whose To is
 * empty once his addresses are removed) → no_anchor.
 *
 * Reply: To = the anchor's From; Cc = (its To ∪ Cc) minus his addresses and
 * To, only with Reply all. Follow-up: To = his message's To minus his
 * addresses; Cc = its Cc minus his addresses and To, only with Reply all; the
 * candidates' `from` is the first follow-up recipient (there is no counterpart
 * From on his own message).
 */
export function deriveReplyRecipients(t: PrincipalMailThread,
  opts: { ownAddresses: ReadonlySet<string>; replyAll: boolean }): DerivedReply | { error: "no_anchor" } {
  const own = lowerSet(opts.ownAddresses);
  const facts = computeAnswered(t.his, { ownAddresses: own });
  const threadAddresses = threadAddressSet(t);
  const anchor = facts.newestInbound;
  if (anchor !== null) {
    const from = anchor.from === null ? null : fromParsed(anchor.from);
    if (from === null) return { error: "no_anchor" };
    const taken = new Set<string>([from.address]);
    const candidateTo = keep(anchor.to, own, taken);
    const candidateCc = keep(anchor.cc, own, taken);
    return {
      mode: opts.replyAll ? "reply_all" : "reply",
      parent: anchor,
      to: [from],
      cc: opts.replyAll ? [...candidateTo, ...candidateCc] : [],
      candidates: { from, to: candidateTo, cc: candidateCc },
      threadAddresses
    };
  }
  const parent = facts.newestOutbound;
  if (parent === null) return { error: "no_anchor" };
  const taken = new Set<string>();
  const to = keep(parent.to, own, taken);
  if (to.length === 0) return { error: "no_anchor" };
  const cc = keep(parent.cc, own, taken);
  return {
    mode: "follow_up",
    parent,
    to,
    cc: opts.replyAll ? cc : [],
    candidates: { from: to[0], to, cc },
    threadAddresses
  };
}

/** Parsed participants (parseAddressList) ∪ his messages' from/to/cc, lowercased, deduped, ≤200. */
export function threadAddressSet(t: PrincipalMailThread): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (email: string): void => {
    if (out.length >= MAX_THREAD_ADDRESSES) return;
    const a = normalizeDraftAddress({ address: email });
    if (a === null || seen.has(a.address)) return;
    seen.add(a.address);
    out.push(a.address);
  };
  for (const p of parseAddressList(t.participants)) add(p.email);
  for (const m of t.his) {
    if (m.from !== null) add(m.from.email);
    for (const a of m.to) add(a.email);
    for (const a of m.cc) add(a.email);
  }
  return out;
}

export interface RecipientContext {
  kind: DraftKind;
  /** principal.email ∪ the usable pinned accounts' emails (mail/accounts), lowercased. */
  ownAddresses: ReadonlySet<string>;
  /** listInternalAddresses().domains. */
  internalDomains: ReadonlySet<string>;
  /** applicableRules(loadRestrictedRulesStrict()): loaded strictly, never "clean on error". */
  restrictedRules: readonly RestrictedSenderRule[];
  /** Addresses that may be ADDED (reply Cc; every new-draft recipient). null skips membership (read-back stage). */
  allowed: ReadonlySet<string> | null;
  /** Reply only: the derived lists (always allowed; To may only shrink). */
  derivedTo: ReadonlySet<string>; derivedCc: ReadonlySet<string>;
  /** Read-back stage: his account address; from/sender must be null or equal it (C22). */
  expectedFrom: string | null;
}
export interface RecipientSetInput {
  to: DraftAddressInput[]; cc: DraftAddressInput[]; bcc: DraftAddressInput[];
  from?: DraftAddressInput | null; sender?: DraftAddressInput | null; replyTo?: DraftAddressInput[];
}
export type RecipientError = "empty_to" | "invalid_address" | "own_address" | "no_reply_address"
  | "restricted_recipient" | "too_many" | "not_allowed" | "to_not_derived" | "bcc_on_reply"
  | "from_mismatch" | "sender_mismatch" | "reply_to_restricted"
  /** C62: produced by factsRecipientsOutside at save, reported in the same 422 recipients_blocked list. */
  | "facts_recipient";
export type RecipientWarning =
  | { code: "external_domain"; value: string } | { code: "role_address"; value: string } | { code: "reply_to_present"; value: null };
export type RecipientCheck =
  | { ok: true; to: DraftAddress[]; cc: DraftAddress[]; bcc: DraftAddress[]; warnings: RecipientWarning[]; signature: string }
  | { ok: false; errors: { code: RecipientError; address: string | null }[]; warnings: RecipientWarning[] };

/** What a refusal reports back for an input that didn't normalize: the raw address, cleaned and clipped, or null. */
function rawAddressOf(a: DraftAddressInput | null | undefined): string | null {
  if (typeof a !== "object" || a === null || typeof a.address !== "string") return null;
  const cleaned = cleanName(a.address);
  return cleaned === null ? null : cleaned.slice(0, MAX_ADDRESS_CHARS).toLowerCase();
}

/** A domain is internal when it is one of `internal` or a subdomain of one. */
function isInternalDomain(domain: string, internal: ReadonlySet<string>): boolean {
  if (internal.has(domain)) return true;
  for (const d of internal) if (domain.endsWith(`.${d}`)) return true;
  return false;
}

/**
 * The order of §3.5 (every error is collected; ok only with none): normalize
 * each (invalid_address); dedupe within and across lists (To wins over Cc over
 * Bcc); empty_to; too_many (> 20); per address own_address, no_reply_address
 * (looksUnreplyable, C9), restricted_recipient (addressMatches); membership
 * (skipped when `allowed` is null: the read-back stage): reply To ⊆ derivedTo,
 * reply Cc ∈ derivedCc ∪ allowed, no reply Bcc, new-draft recipients ∈ allowed;
 * expectedFrom: from/sender null or equal to it; replyTo: restricted →
 * reply_to_restricted, non-empty → the reply_to_present warning. Warnings: one
 * external_domain per domain outside internalDomains, role_address per
 * looksRoleAddress hit.
 */
export function checkRecipients(input: RecipientSetInput, ctx: RecipientContext): RecipientCheck {
  const errors: { code: RecipientError; address: string | null }[] = [];
  const warnings: RecipientWarning[] = [];
  const fail = (code: RecipientError, address: string | null = null): void => {
    errors.push({ code, address });
  };

  const seen = new Set<string>();
  const lists: { to: DraftAddress[]; cc: DraftAddress[]; bcc: DraftAddress[] } = { to: [], cc: [], bcc: [] };
  let invalidTo = false;
  for (const list of ["to", "cc", "bcc"] as const) {
    for (const raw of Array.isArray(input[list]) ? input[list] : []) {
      const a = normalizeDraftAddress(raw);
      if (a === null) {
        fail("invalid_address", rawAddressOf(raw));
        if (list === "to") invalidTo = true;
        continue;
      }
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      lists[list].push(a);
    }
  }
  const all = [...lists.to, ...lists.cc, ...lists.bcc];
  // A To made only of invalid entries is reported as invalid, not as empty: the fix is the address, not another one.
  if (lists.to.length === 0 && !invalidTo) fail("empty_to");
  if (all.length > MAX_RECIPIENTS) fail("too_many");

  const own = lowerSet(ctx.ownAddresses);
  const rules = [...ctx.restrictedRules];
  for (const a of all) {
    if (own.has(a.address)) fail("own_address", a.address);
    if (looksUnreplyable(a.address, null).filtered) fail("no_reply_address", a.address);
    if (rules.length > 0 && addressMatches(a.address, rules) !== null) fail("restricted_recipient", a.address);
  }

  if (ctx.allowed !== null) {
    const allowed = lowerSet(ctx.allowed);
    if (ctx.kind === "reply") {
      const derivedTo = lowerSet(ctx.derivedTo);
      const derivedCc = lowerSet(ctx.derivedCc);
      for (const a of lists.to) if (!derivedTo.has(a.address)) fail("to_not_derived", a.address);
      for (const a of lists.cc) if (!derivedCc.has(a.address) && !allowed.has(a.address)) fail("not_allowed", a.address);
      for (const a of lists.bcc) fail("bcc_on_reply", a.address);
    } else {
      for (const a of all) if (!allowed.has(a.address)) fail("not_allowed", a.address);
    }
  }

  if (ctx.expectedFrom !== null) {
    const expected = lower(ctx.expectedFrom);
    if (input.from !== undefined && input.from !== null) {
      const from = normalizeDraftAddress(input.from);
      if (from === null || from.address !== expected) fail("from_mismatch", from?.address ?? rawAddressOf(input.from));
    }
    if (input.sender !== undefined && input.sender !== null) {
      const sender = normalizeDraftAddress(input.sender);
      if (sender === null || sender.address !== expected) fail("sender_mismatch", sender?.address ?? rawAddressOf(input.sender));
    }
  }

  const replyTo = Array.isArray(input.replyTo) ? input.replyTo : [];
  for (const raw of replyTo) {
    const r = normalizeDraftAddress(raw);
    if (r !== null && rules.length > 0 && addressMatches(r.address, rules) !== null) fail("reply_to_restricted", r.address);
  }
  if (replyTo.length > 0) warnings.push({ code: "reply_to_present", value: null });

  const internal = lowerSet(ctx.internalDomains);
  const externalDomains = new Set<string>();
  for (const a of all) {
    const domain = domainOf(a.address);
    if (!isInternalDomain(domain, internal) && !externalDomains.has(domain)) {
      externalDomains.add(domain);
      warnings.push({ code: "external_domain", value: domain });
    }
    if (looksRoleAddress(a.address).filtered) warnings.push({ code: "role_address", value: a.address });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, to: lists.to, cc: lists.cc, bcc: lists.bcc, warnings, signature: recipientsSignature(lists) };
}

/** C10: sha256 hex of JSON.stringify({ to, cc, bcc }) over lowercased, deduped, sorted addresses. */
export function recipientsSignature(set: { to: readonly DraftAddress[]; cc: readonly DraftAddress[]; bcc: readonly DraftAddress[] }): string {
  const canon = (list: readonly DraftAddress[]): string[] => [...new Set(list.map((a) => lower(a.address)))].sort();
  return createHash("sha256")
    .update(JSON.stringify({ to: canon(set.to), cc: canon(set.cc), bcc: canon(set.bcc) }), "utf8")
    .digest("hex");
}

/** C62. The matcher half P4 needs, so the function stays pure (built from P3's ClientMatcher). */
export interface FactsGate {
  clientId: string;
  ownAddresses: ReadonlySet<string>;
  isInternal(address: string): boolean;
  /** matcher.match([address]) */
  match(address: string): { clientId: string | null; via: "exact" | "domain" | null; candidates: number };
}
/**
 * The external addresses of To ∪ Cc ∪ Bcc that don't belong to gate.clientId
 * (lowercased, deduped, in order). Empty = the gate passes. External = not his
 * and not internal; belongs = the match names gate.clientId through an exact
 * contact, or through a website domain only that client claims (C62).
 */
export function factsRecipientsOutside(set: { to: readonly DraftAddressInput[]; cc: readonly DraftAddressInput[]; bcc: readonly DraftAddressInput[] },
  gate: FactsGate): string[] {
  const own = lowerSet(gate.ownAddresses);
  const seen = new Set<string>();
  const outside: string[] = [];
  for (const raw of [...set.to, ...set.cc, ...set.bcc]) {
    const a = normalizeDraftAddress(raw);
    if (a === null || seen.has(a.address)) continue;
    seen.add(a.address);
    if (own.has(a.address) || gate.isInternal(a.address)) continue;
    const r = gate.match(a.address);
    const belongs = r.clientId === gate.clientId && (r.via === "exact" || r.candidates === 1);
    if (!belongs) outside.push(a.address);
  }
  return outside;
}

/** C75: how a recipient is shown: the address first, the untrusted name after it ("x@evil.example (accounts@client.com)"). */
export function recipientLabel(a: DraftAddress): { primary: string; secondary: string | null } {
  const name = cleanName(a.name);
  return { primary: a.address, secondary: name !== null && name.toLowerCase() !== a.address ? name : null };
}
