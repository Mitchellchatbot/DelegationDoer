import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import type { DraftAddress } from "@/lib/exec/drafts-types";
import type { HisMessage, MessageDirection, ParsedAddress, PrincipalMailThread } from "@/lib/exec/email-types";
import {
  checkRecipients,
  deriveReplyRecipients,
  factsRecipientsOutside,
  normalizeDraftAddress,
  recipientLabel,
  recipientsSignature,
  threadAddressSet,
  type DraftAddressInput,
  type FactsGate,
  type RecipientCheck,
  type RecipientContext
} from "@/lib/exec/recipients";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// Recipient derivation and checks (contract §3.5, L8, C7-C10, C22, C62, C75; §5.4 RC01-RC12).

const T0 = 1_762_250_000_000;
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const addr = (email: string, name: string | null = null): ParsedAddress => ({ name, email });
const OWN: ReadonlySet<string> = new Set(["mitchell@scaledai.org"]);

function msg(over: Partial<HisMessage> & { id: string; direction: MessageDirection }): HisMessage {
  return {
    threadId: "t1",
    accountId: "acc_his",
    folder: over.direction === "outbound" ? "Sent Items" : "Inbox",
    isJunk: false,
    rfcMessageId: `<${over.id}@x>`,
    inReplyTo: null,
    subject: "s",
    from: null,
    to: [],
    cc: [],
    sentAt: iso(0),
    createdAtMs: T0,
    isAutomated: false,
    attachments: [],
    bodyDeferred: false,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}
function thread(his: HisMessage[], participants: string[] = []): PrincipalMailThread {
  return {
    threadId: "t1",
    participants,
    his,
    all: [],
    snapshot: { identityCount: his.length, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: T0, readDoneAtMs: T0 },
    lastMessageAt: null
  };
}
const rule = (pattern: string, matchKind: "exact" | "domain"): RestrictedSenderRule => ({ id: `r_${pattern}`, pattern, matchKind, label: "", viewerUserIds: new Set() });
const input = (list: readonly (string | DraftAddressInput)[]): DraftAddressInput[] => list.map((a) => (typeof a === "string" ? { address: a } : a));
const codes = (r: RecipientCheck): string[] => (r.ok ? [] : r.errors.map((e) => e.code));
const errorAddresses = (r: RecipientCheck, code: string): (string | null)[] => (r.ok ? [] : r.errors.filter((e) => e.code === code).map((e) => e.address));

function ctx(over: Partial<RecipientContext> = {}): RecipientContext {
  return {
    kind: "new",
    ownAddresses: OWN,
    internalDomains: new Set(["scaledai.org"]),
    restrictedRules: [],
    allowed: null,
    derivedTo: new Set(),
    derivedCc: new Set(),
    expectedFrom: null,
    ...over
  };
}
const check = (to: readonly (string | DraftAddressInput)[], over: Partial<RecipientContext> = {}, lists: { cc?: readonly (string | DraftAddressInput)[]; bcc?: readonly (string | DraftAddressInput)[] } = {}) =>
  checkRecipients({ to: input(to), cc: input(lists.cc ?? []), bcc: input(lists.bcc ?? []) }, ctx(over));

describe("normalizeDraftAddress", () => {
  it("trims, lowercases, cleans the name", () => {
    expect(normalizeDraftAddress({ address: "  Jane@Acme.IO ", name: `  Jane${String.fromCharCode(0)} Doe  ` })).toEqual({ address: "jane@acme.io", name: "Jane Doe" });
    expect(normalizeDraftAddress({ address: "a@x.io", name: "" })).toEqual({ address: "a@x.io", name: null });
    expect(normalizeDraftAddress({ address: "a@x.io", name: null })).toEqual({ address: "a@x.io", name: null });
    expect(normalizeDraftAddress({ address: "a@x.io", name: "n".repeat(300) })?.name?.length).toBe(256);
    expect(normalizeDraftAddress({ address: "a@x.io", name: "Jane" + String.fromCharCode(0x202e) + "Doe" })?.name).toBe("Jane Doe");
  });
});

describe("RC01 reply: To = the newest qualifying inbound's From", () => {
  it("skips self-copies and junk; a quoted comma name is one address", () => {
    const t = thread([
      msg({ id: "m1", direction: "inbound", from: addr("old@x.io", "Old"), sentAt: iso(0) }),
      msg({ id: "m2", direction: "inbound", from: addr("j@x.io", "Doe, Jane"), to: [addr("mitchell@scaledai.org")], sentAt: iso(10) }),
      msg({ id: "m3", direction: "inbound", from: addr("mitchell@scaledai.org", "Me"), to: [addr("j@x.io")], sentAt: iso(20) }),
      msg({ id: "m4", direction: "inbound", from: addr("spam@x.io"), isJunk: true, sentAt: iso(30) }),
      msg({ id: "m5", direction: "outbound", from: addr("mitchell@scaledai.org"), to: [addr("other@x.io")], sentAt: iso(5) })
    ]);
    const derived = deriveReplyRecipients(t, { ownAddresses: OWN, replyAll: false });
    if ("error" in derived) throw new Error("no anchor");
    expect(derived.mode).toBe("reply");
    expect(derived.parent.id).toBe("m2");
    expect(derived.to).toEqual([{ address: "j@x.io", name: "Doe, Jane" }]);
    expect(derived.cc).toEqual([]);
    expect(derived.candidates).toEqual({ from: { address: "j@x.io", name: "Doe, Jane" }, to: [], cc: [] });
    expect(derived.threadAddresses).toEqual(["old@x.io", "j@x.io", "mitchell@scaledai.org", "spam@x.io", "other@x.io"]);
  });
});

describe("RC02 reply all", () => {
  it("Cc = parent To ∪ Cc minus his addresses (any case) and To", () => {
    const t = thread([
      msg({
        id: "m2",
        direction: "inbound",
        from: addr("j@x.io", "Jane"),
        to: [addr("Mitchell@ScaledAI.org"), addr("bob@x.io", "Bob")],
        cc: [addr("carol@x.io"), addr("J@X.IO"), addr("bob@x.io")]
      })
    ]);
    const derived = deriveReplyRecipients(t, { ownAddresses: new Set(["MITCHELL@scaledai.org"]), replyAll: true });
    if ("error" in derived) throw new Error("no anchor");
    expect(derived.mode).toBe("reply_all");
    expect(derived.to).toEqual([{ address: "j@x.io", name: "Jane" }]);
    expect(derived.cc).toEqual([
      { address: "bob@x.io", name: "Bob" },
      { address: "carol@x.io", name: null }
    ]);
    expect(derived.candidates.to).toEqual([{ address: "bob@x.io", name: "Bob" }]);
    expect(derived.candidates.cc).toEqual([{ address: "carol@x.io", name: null }]);
  });
});

describe("RC03 follow-up and no_anchor", () => {
  it("an outbound-only thread drafts a follow-up on his newest outbound (C8)", () => {
    const t = thread([
      msg({ id: "o1", direction: "outbound", to: [addr("first@x.io")], sentAt: iso(0) }),
      msg({ id: "o2", direction: "outbound", from: addr("mitchell@scaledai.org"), to: [addr("a@x.io", "A"), addr("mitchell@scaledai.org")], cc: [addr("b@x.io"), addr("a@x.io")], sentAt: iso(10) }),
      msg({ id: "o3", direction: "outbound", to: [addr("junk@x.io")], isJunk: true, sentAt: iso(20) })
    ]);
    const plain = deriveReplyRecipients(t, { ownAddresses: OWN, replyAll: false });
    if ("error" in plain) throw new Error("no anchor");
    expect([plain.mode, plain.parent.id]).toEqual(["follow_up", "o2"]);
    expect(plain.to).toEqual([{ address: "a@x.io", name: "A" }]);
    expect(plain.cc).toEqual([]);
    expect(plain.candidates).toEqual({ from: { address: "a@x.io", name: "A" }, to: [{ address: "a@x.io", name: "A" }], cc: [{ address: "b@x.io", name: null }] });
    const all = deriveReplyRecipients(t, { ownAddresses: OWN, replyAll: true });
    if ("error" in all) throw new Error("no anchor");
    expect(all.cc).toEqual([{ address: "b@x.io", name: null }]);
  });

  it("no_anchor when nothing qualifies", () => {
    expect(deriveReplyRecipients(thread([]), { ownAddresses: OWN, replyAll: false })).toEqual({ error: "no_anchor" });
    expect(deriveReplyRecipients(thread([msg({ id: "m1", direction: "inbound", from: null })]), { ownAddresses: OWN, replyAll: false })).toEqual({ error: "no_anchor" });
    expect(deriveReplyRecipients(thread([msg({ id: "m1", direction: "inbound", from: addr("not an address") })]), { ownAddresses: OWN, replyAll: false })).toEqual({ error: "no_anchor" });
    expect(deriveReplyRecipients(thread([msg({ id: "o1", direction: "outbound", to: [addr("mitchell@scaledai.org")] })]), { ownAddresses: OWN, replyAll: true })).toEqual({ error: "no_anchor" });
    expect(deriveReplyRecipients(thread([msg({ id: "m1", direction: "inbound", from: addr("x@x.io"), isJunk: true })]), { ownAddresses: OWN, replyAll: false })).toEqual({ error: "no_anchor" });
  });
});

describe("RC04 each RecipientError alone", () => {
  it.each([
    ["whitespace", "a b@x.io"],
    ["angle brackets", "<a@x.io>"],
    ["no dot after the @", "a@xio"],
    ["a dot right after the @", "a@.io"],
    ["a trailing dot", "a@x."],
    ["255 characters", `${"a".repeat(250)}@x.io`],
    ["a comma", "a@x.io,"],
    ["a quote", 'a"b@x.io'],
    ["two @", "a@b@x.io"],
    ["an empty local part", "@x.io"],
    ["empty", ""],
    ["a control character", `a${String.fromCharCode(1)}@x.io`]
  ])("invalid_address: %s", (_what, address) => {
    const r = check([address]);
    expect(codes(r)).toEqual(["invalid_address"]);
    expect(codes(check([address, "ok@x.io"]))).toEqual(["invalid_address"]);
  });

  it("254 characters is the limit", () => {
    expect(check([`${"a".repeat(249)}@x.io`]).ok).toBe(true);
  });

  it("own_address", () => {
    const r = check(["MITCHELL@scaledai.org"]);
    expect(codes(r)).toEqual(["own_address"]);
    expect(errorAddresses(r, "own_address")).toEqual(["mitchell@scaledai.org"]);
  });

  it.each(["noreply@x.io", "no-reply@x.io", "donotreply@x.io", "do-not-reply@x.io", "mailer-daemon@x.io", "postmaster@x.io", "x.noreply@x.io", "NoReply.billing@x.io"])(
    "no_reply_address: %s",
    (address) => {
      expect(codes(check([address]))).toEqual(["no_reply_address"]);
    }
  );

  it("restricted_recipient: exact, domain and subdomain, never a substring", () => {
    const rules = [rule("boss@deel.com", "exact"), rule("deel.com", "domain")];
    expect(codes(check(["boss@deel.com"], { restrictedRules: rules }))).toEqual(["restricted_recipient"]);
    expect(codes(check(["x@deel.com"], { restrictedRules: rules }))).toEqual(["restricted_recipient"]);
    expect(codes(check(["x@hr.deel.com"], { restrictedRules: rules }))).toEqual(["restricted_recipient"]);
    expect(check(["x@deel.com.evil.tld"], { restrictedRules: rules }).ok).toBe(true);
    expect(check(["x@notdeel.com"], { restrictedRules: rules }).ok).toBe(true);
    expect(check(["x@deel.com"]).ok).toBe(true);
  });

  it("too_many: 21 recipients", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `p${i}@x.io`);
    expect(check(twenty).ok).toBe(true);
    expect(codes(check(twenty, {}, { bcc: ["extra@x.io"] }))).toEqual(["too_many"]);
  });

  it("not_allowed (new draft), to_not_derived, not_allowed (reply Cc), bcc_on_reply", () => {
    expect(codes(check(["z@x.io"], { allowed: new Set(["a@x.io"]) }))).toEqual(["not_allowed"]);
    expect(check(["A@X.IO"], { allowed: new Set(["a@x.io"]) }).ok).toBe(true);
    const reply = { kind: "reply" as const, allowed: new Set(["p@x.io"]), derivedTo: new Set(["j@x.io"]), derivedCc: new Set(["c@x.io"]) };
    const r = check(["j@x.io", "other@x.io"], reply, { cc: ["c@x.io", "p@x.io", "q@x.io"], bcc: ["b@x.io"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { code: "to_not_derived", address: "other@x.io" },
      { code: "not_allowed", address: "q@x.io" },
      { code: "bcc_on_reply", address: "b@x.io" }
    ]);
    expect(check(["j@x.io"], reply, { cc: ["c@x.io", "p@x.io"] }).ok).toBe(true);
  });

  it("from_mismatch and sender_mismatch against expectedFrom (C22), case-insensitive", () => {
    const expected = { expectedFrom: "mitchell@scaledai.org" };
    const r = checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], from: { address: "other@scaledai.org" }, sender: { address: "delegate@scaledai.org", name: "D" } }, ctx(expected));
    expect(codes(r)).toEqual(["from_mismatch", "sender_mismatch"]);
    expect(checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], from: { address: "Mitchell@ScaledAI.org" }, sender: { address: "mitchell@scaledai.org" } }, ctx(expected)).ok).toBe(true);
    expect(codes(checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], from: { address: "not an address" } }, ctx(expected)))).toEqual(["from_mismatch"]);
    // Without expectedFrom (save stage) from/sender are not examined.
    expect(checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], from: { address: "other@scaledai.org" } }, ctx()).ok).toBe(true);
  });

  it("reply_to_restricted", () => {
    const rules = [rule("deel.com", "domain")];
    const r = checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], replyTo: [{ address: "pay@deel.com" }, { address: "ok@x.io" }] }, ctx({ restrictedRules: rules }));
    expect(codes(r)).toEqual(["reply_to_restricted"]);
    expect(r.warnings).toContainEqual({ code: "reply_to_present", value: null });
  });

  it("empty_to", () => {
    expect(codes(check([]))).toEqual(["empty_to"]);
    expect(codes(check([], {}, { cc: ["c@x.io"] }))).toEqual(["empty_to"]);
  });

  it("errors are collected, not short-circuited", () => {
    const r = check(["mitchell@scaledai.org", "noreply@x.io", "bad"], { restrictedRules: [rule("deel.com", "domain")] }, { cc: ["x@deel.com"] });
    expect(codes(r).sort()).toEqual(["invalid_address", "no_reply_address", "own_address", "restricted_recipient"]);
  });
});

describe("RC05 warnings", () => {
  it("one external_domain per domain; subdomains of an internal domain are internal; support@ is a warning; reply_to_present", () => {
    const r = checkRecipients(
      { to: input(["a@acme.io", "b@acme.io", "c@beta.io", "d@scaledai.org", "e@mail.scaledai.org", "support@acme.io"]), cc: [], bcc: [], replyTo: [{ address: "r@acme.io" }] },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      { code: "reply_to_present", value: null },
      { code: "external_domain", value: "acme.io" },
      { code: "external_domain", value: "beta.io" },
      { code: "role_address", value: "support@acme.io" }
    ]);
    expect(check(["d@scaledai.org"]).warnings).toEqual([]);
  });
});

describe("RC06 dedupe and lowercasing", () => {
  it("To wins over Cc over Bcc; every address comes back lowercased", () => {
    const r = check(["A@X.io", "b@x.io"], {}, { cc: ["a@x.io", "B@X.IO", "C@x.io"], bcc: ["c@x.io", "D@x.io"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to.map((a) => a.address)).toEqual(["a@x.io", "b@x.io"]);
    expect(r.cc.map((a) => a.address)).toEqual(["c@x.io"]);
    expect(r.bcc.map((a) => a.address)).toEqual(["d@x.io"]);
  });
});

describe("RC07 the signature", () => {
  const a: DraftAddress = { address: "a@x.io", name: "A" };
  const b: DraftAddress = { address: "b@x.io", name: null };
  const c: DraftAddress = { address: "c@x.io", name: "C" };
  it("is order- and case-independent, ignores names, changes with Bcc and with the list an address sits in", () => {
    const base = recipientsSignature({ to: [a, b], cc: [c], bcc: [] });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientsSignature({ to: [{ address: "B@X.IO", name: "Other" }, { address: "a@x.io", name: null }], cc: [{ address: "C@x.io", name: null }], bcc: [] })).toBe(base);
    expect(recipientsSignature({ to: [a, b, a], cc: [c], bcc: [] })).toBe(base);
    expect(recipientsSignature({ to: [a, b], cc: [c], bcc: [{ address: "hidden@x.io", name: null }] })).not.toBe(base);
    expect(recipientsSignature({ to: [a], cc: [b, c], bcc: [] })).not.toBe(base);
    const ok = check(["b@x.io", "a@x.io"], {}, { cc: ["c@x.io"] });
    expect(ok.ok && ok.signature).toBe(base);
  });
});

describe("RC08 the read-back stage", () => {
  it("allowed: null skips membership and keeps the other refusals", () => {
    const reply = { kind: "reply" as const, allowed: null, derivedTo: new Set(["j@x.io"]), derivedCc: new Set<string>() };
    expect(check(["z@x.io"], reply, { cc: ["q@x.io"], bcc: ["b@x.io"] }).ok).toBe(true);
    expect(codes(check(["mitchell@scaledai.org"], reply))).toEqual(["own_address"]);
    expect(codes(check(["noreply@x.io"], reply))).toEqual(["no_reply_address"]);
    expect(codes(check(["x@deel.com"], { ...reply, restrictedRules: [rule("deel.com", "domain")] }))).toEqual(["restricted_recipient"]);
  });
});

describe("RC09 a null from/sender", () => {
  it("passes with expectedFrom set (C22)", () => {
    const expected = ctx({ expectedFrom: "mitchell@scaledai.org" });
    expect(checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [], from: null, sender: null }, expected).ok).toBe(true);
    expect(checkRecipients({ to: input(["a@x.io"]), cc: [], bcc: [] }, expected).ok).toBe(true);
  });
});

describe("RC10 threadAddressSet", () => {
  it("includes participants and his from/to/cc, lowercased and deduped, at most 200", () => {
    const t = thread(
      [msg({ id: "m1", direction: "inbound", from: addr("J@X.io"), to: [addr("mitchell@scaledai.org")], cc: [addr("c@z.io")] })],
      ["Jane <J@X.io>; b@y.io", "c@z.io, d@w.io"]
    );
    expect(threadAddressSet(t)).toEqual(["j@x.io", "b@y.io", "c@z.io", "d@w.io", "mitchell@scaledai.org"]);
    const many = thread([msg({ id: "m1", direction: "inbound", from: addr("x@x.io"), to: Array.from({ length: 250 }, (_, i) => addr(`p${i}@x.io`)) })]);
    expect(threadAddressSet(many)).toHaveLength(200);
  });
});

describe("RC11 factsRecipientsOutside (C62)", () => {
  const matches: Record<string, ReturnType<FactsGate["match"]>> = {
    "jane@acme.io": { clientId: "c1", via: "exact", candidates: 1 },
    "bob@acme.io": { clientId: "c1", via: "domain", candidates: 1 },
    "x@shared.io": { clientId: "c1", via: "domain", candidates: 2 },
    "exact@shared.io": { clientId: "c1", via: "exact", candidates: 2 },
    "o@other.io": { clientId: "c2", via: "exact", candidates: 1 }
  };
  const gate: FactsGate = {
    clientId: "c1",
    ownAddresses: OWN,
    isInternal: (a) => a.endsWith("@scaledai.org"),
    match: (a) => matches[a] ?? { clientId: null, via: null, candidates: 0 }
  };

  it("an exact contact and a single-claim domain pass; shared domains, free mail, vendors and other clients are outside", () => {
    expect(factsRecipientsOutside({ to: input(["jane@acme.io"]), cc: input(["bob@acme.io", "exact@shared.io"]), bcc: [] }, gate)).toEqual([]);
    expect(
      factsRecipientsOutside(
        {
          to: input(["jane@acme.io", "V@Vendor.io"]),
          cc: input(["bob@acme.io", "x@shared.io", "p@gmail.com", "mitchell@scaledai.org"]),
          bcc: input(["team@scaledai.org", "o@other.io", "exact@shared.io", "v@vendor.io"])
        },
        gate
      )
    ).toEqual(["v@vendor.io", "x@shared.io", "p@gmail.com", "o@other.io"]);
    expect(factsRecipientsOutside({ to: [], cc: [], bcc: input(["p@gmail.com"]) }, gate)).toEqual(["p@gmail.com"]);
    expect(factsRecipientsOutside({ to: input(["not an address"]), cc: [], bcc: [] }, gate)).toEqual([]);
  });
});

describe("RC12 recipientLabel (C75)", () => {
  it("the address is always primary; the untrusted name is secondary", () => {
    expect(recipientLabel({ address: "x@evil.example", name: "accounts@client.com" })).toEqual({ primary: "x@evil.example", secondary: "accounts@client.com" });
    expect(recipientLabel({ address: "a@x.io", name: null })).toEqual({ primary: "a@x.io", secondary: null });
    expect(recipientLabel({ address: "a@x.io", name: "A@X.IO" })).toEqual({ primary: "a@x.io", secondary: null });
    expect(recipientLabel({ address: "a@x.io", name: "  " })).toEqual({ primary: "a@x.io", secondary: null });
  });
});
