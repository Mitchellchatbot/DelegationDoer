import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { HisMessage, MessageMeta, ThreadScreenRow } from "@/lib/exec/email-types";
import { principalFromRows } from "@/lib/exec/principal";
import {
  applicableRules,
  cloneTimeToIso,
  cloneTimeToMs,
  computeAnswered,
  isPartialThread,
  isPinnedAccount,
  loadRestrictedRulesStrict,
  loadScreeningPolicy,
  MailScopeError,
  overlayAnswered,
  parseAddress,
  parseAddressList,
  pinnedAccounts,
  restrictedPolicyHash,
  RestrictedRulesError,
  screenByHashes,
  screenFeedRow,
  feedRowScreenHashes,
  screenHashesFor,
  screenRestricted,
  screenStoredRow,
  usableAccounts,
  type ScreenInput
} from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";
import { toStringArray } from "@/lib/missive-client";
import { messagesMatch, ruleFromRow, threadMatches, type RestrictedSenderRule } from "@/lib/restricted-senders";
import { createFakePostgrest, type FakeFilter, type Row } from "../__tests__/fake-postgrest";

const inValues = (f: FakeFilter | undefined): readonly unknown[] => (f && f.kind === "in" ? f.values : []);

// The pure half of sources/mail.ts: address parsing (display), the restricted
// screens (live, hashed, stored), the policy hash, answered state, partial
// threads, clone times and the pin helpers. Contract §3.5, L2, L3, L11, L17,
// A2, §5 A.

function mint(over: { id?: string; userId?: string; accounts?: string[]; email?: string } = {}): ExecPrincipal {
  const userId = over.userId ?? "u_owner";
  const p = principalFromRows(
    {
      id: over.id ?? "ep_owner",
      user_id: userId,
      enabled: true,
      mail_account_ids: over.accounts ?? ["acc_his"],
      slack_team_id: null,
      slack_user_id: null
    },
    { id: userId, email: over.email ?? "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint();

const rule = (id: string, pattern: string, matchKind: "exact" | "domain" = "domain", viewers: string[] = []): RestrictedSenderRule => ({
  id,
  pattern,
  matchKind,
  label: id,
  viewerUserIds: new Set(viewers)
});

// ---------------------------------------------------------------------------
// parseAddressList / parseAddress
// ---------------------------------------------------------------------------

describe("parseAddressList on the fragments normalizeMessage produces", () => {
  // normalizeMessage runs toStringArray over to_addrs / cc_addrs: it cuts on
  // every "," and ";", inside quotes or not. These are the raw clone strings.
  const viaClient = (raw: string) => parseAddressList(toStringArray(raw));

  it("a quoted name with a comma (mailparser) comes back whole", () => {
    expect(toStringArray('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual(['"Doe', 'Jane" <jane@x.com>', "bob@y.com"]);
    expect(viaClient('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual([
      { name: "Doe, Jane", email: "jane@x.com" },
      { name: null, email: "bob@y.com" }
    ]);
  });

  it("an unquoted name with a comma (Graph) merges its @-less fragment forward", () => {
    expect(toStringArray("Toledo, Lívia <l.toledo@deel.com>, Ops <ops@x.com>")).toEqual(["Toledo", "Lívia <l.toledo@deel.com>", "Ops <ops@x.com>"]);
    expect(viaClient("Toledo, Lívia <l.toledo@deel.com>, Ops <ops@x.com>")).toEqual([
      { name: "Toledo, Lívia", email: "l.toledo@deel.com" },
      { name: "Ops", email: "ops@x.com" }
    ]);
  });

  it("several @-less fragments all merge into the next address; a trailing one is dropped", () => {
    expect(viaClient("Smith, John, Jr. <j@x.com>, undisclosed-recipients:;")).toEqual([{ name: "Smith, John, Jr.", email: "j@x.com" }]);
  });

  it("semicolons, bare addresses, case and whitespace", () => {
    expect(viaClient("  A@X.COM ;  B <B@Y.org>")).toEqual([
      { name: null, email: "a@x.com" },
      { name: "B", email: "b@y.org" }
    ]);
  });

  it("an address in the display name doesn't win over the real one in brackets", () => {
    expect(viaClient('"support@x.com via Zendesk" <notifications@x.com>')).toEqual([
      { name: "support@x.com via Zendesk", email: "notifications@x.com" }
    ]);
  });

  it("bracket-only, mailto:, comments and junk", () => {
    expect(parseAddressList(["<only@x.com>"])).toEqual([{ name: null, email: "only@x.com" }]);
    expect(parseAddressList("Ann <mailto:Ann@X.com>")).toEqual([{ name: "Ann", email: "ann@x.com" }]);
    expect(parseAddressList("John (Sales, EU) <j@x.com>")).toEqual([{ name: "John (Sales, EU)", email: "j@x.com" }]);
    expect(parseAddressList(["not an address", "x@", "@y"])).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(42)).toEqual([]);
  });

  it("an unbalanced quote falls back to splitting without quotes", () => {
    expect(parseAddressList('O"Brien <o@x.com>, b@y.com')).toEqual([
      { name: "O\"Brien", email: "o@x.com" },
      { name: null, email: "b@y.com" }
    ]);
  });

  it("strips control, zero-width and bidi characters from names and clips them", () => {
    const sneaky = `Pay${String.fromCodePoint(0x202e)}moc.leed${String.fromCodePoint(0x200b)}\u0007 <p@x.com>`;
    const [parsed] = parseAddressList(sneaky);
    expect(parsed.email).toBe("p@x.com");
    expect(parsed.name).toBe("Pay moc.leed");
    const [long] = parseAddressList(`${"n".repeat(500)} <l@x.com>`);
    expect(long.name).toHaveLength(200);
  });

  it("parseAddress takes the first address (a From field)", () => {
    expect(parseAddress("Toledo, Lívia <l@deel.com>")).toEqual({ name: "Toledo, Lívia", email: "l@deel.com" });
    expect(parseAddress("a@x.com, b@y.com")).toEqual({ name: null, email: "a@x.com" });
    expect(parseAddress("")).toBeNull();
    expect(parseAddress(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The strict rule loader
// ---------------------------------------------------------------------------

describe("loadRestrictedRulesStrict", () => {
  function rulesDb(rules: Row[], viewers: Row[] = [], fail?: (table: string) => string | null) {
    const db = createFakePostgrest({
      tables: { restricted_senders: rules, restricted_sender_viewers: viewers },
      fail: (q) => fail?.(q.table) ?? null
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    return db;
  }

  it("maps rows exactly like DD's fetchRules: pattern trimmed and lowercased, non-exact kinds are domain", async () => {
    const db = rulesDb(
      [
        { id: "rs_deel", pattern: "  Deel.COM ", match_kind: "domain", label: "Deel", enabled: true },
        { id: "rs_rm", pattern: "RMReyesTaxServices@Gmail.com", match_kind: "exact", label: "RM", enabled: true },
        { id: "rs_odd", pattern: "Stripe.com", match_kind: "suffix", label: "odd", enabled: true },
        { id: "rs_off", pattern: "off.com", match_kind: "domain", label: "off", enabled: false }
      ],
      [
        { rule_id: "rs_deel", user_id: "u_viewer" },
        { rule_id: "rs_off", user_id: "u_x" }
      ]
    );
    const rules = await loadRestrictedRulesStrict();
    const expected = [
      ruleFromRow({ id: "rs_deel", pattern: "  Deel.COM ", match_kind: "domain", label: "Deel" }, new Set(["u_viewer"])),
      ruleFromRow({ id: "rs_odd", pattern: "Stripe.com", match_kind: "suffix", label: "odd" }, new Set()),
      ruleFromRow({ id: "rs_rm", pattern: "RMReyesTaxServices@Gmail.com", match_kind: "exact", label: "RM" }, new Set())
    ];
    expect(rules).toEqual(expected);
    expect(rules.map((r) => [r.id, r.pattern, r.matchKind])).toEqual([
      ["rs_deel", "deel.com", "domain"],
      ["rs_odd", "stripe.com", "domain"],
      ["rs_rm", "rmreyestaxservices@gmail.com", "exact"]
    ]);
    const [ruleQuery] = db.on("restricted_senders");
    expect(ruleQuery.columns).toBe("id, pattern, match_kind, label");
    expect(ruleQuery.filters).toEqual([{ kind: "eq", column: "enabled", value: true }]);
    expect(ruleQuery.orders).toEqual([{ column: "id", ascending: true }]);
    expect(ruleQuery.range).toEqual([0, 999]);
    expect(db.on("restricted_sender_viewers")[0].columns).toBe("rule_id, user_id");
  });

  it("no enabled rules: [] without a viewer query", async () => {
    const db = rulesDb([]);
    expect(await loadRestrictedRulesStrict()).toEqual([]);
    expect(db.on("restricted_sender_viewers")).toHaveLength(0);
  });

  it("throws, never fails open, when either table can't be read", async () => {
    rulesDb([{ id: "rs_a", pattern: "a.com", match_kind: "domain", label: "a", enabled: true }], [], (t) =>
      t === "restricted_senders" ? "relation does not exist" : null
    );
    await expect(loadRestrictedRulesStrict()).rejects.toBeInstanceOf(RestrictedRulesError);
    rulesDb([{ id: "rs_a", pattern: "a.com", match_kind: "domain", label: "a", enabled: true }], [], (t) =>
      t === "restricted_sender_viewers" ? "timeout" : null
    );
    await expect(loadRestrictedRulesStrict()).rejects.toBeInstanceOf(RestrictedRulesError);
  });

  it("throws on a malformed rule row instead of dropping the rule", async () => {
    rulesDb([{ id: "rs_a", pattern: null, match_kind: "domain", label: "a", enabled: true }]);
    await expect(loadRestrictedRulesStrict()).rejects.toThrow(/malformed/);
  });

  it("reads viewers in chunks of at most 200 rule ids", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `rs_${String(i).padStart(3, "0")}`, pattern: `d${i}.com`, match_kind: "domain", label: "x", enabled: true }));
    const db = rulesDb(many, [{ rule_id: "rs_249", user_id: "u_v" }]);
    const rules = await loadRestrictedRulesStrict();
    expect(rules).toHaveLength(250);
    const chunks = db.on("restricted_sender_viewers").map((q) => inValues(q.filters.find((f) => f.column === "rule_id")).length);
    expect(chunks).toEqual([200, 50]);
    expect(rules.find((r) => r.id === "rs_249")?.viewerUserIds.has("u_v")).toBe(true);
  });

  it("applicableRules drops the rules he is a viewer on; loadScreeningPolicy hashes what is left", async () => {
    rulesDb(
      [
        { id: "rs_a", pattern: "a.com", match_kind: "domain", label: "a", enabled: true },
        { id: "rs_b", pattern: "b.com", match_kind: "domain", label: "b", enabled: true }
      ],
      [{ rule_id: "rs_a", user_id: principal.userId }]
    );
    const all = await loadRestrictedRulesStrict();
    expect(applicableRules(all, principal).map((r) => r.id)).toEqual(["rs_b"]);
    const policy = await loadScreeningPolicy(principal);
    expect(policy.rules.map((r) => r.id)).toEqual(["rs_b"]);
    expect(policy.hash).toBe(restrictedPolicyHash("hidden", [rule("rs_b", "b.com")]));
  });
});

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

const meta = (from: string, to: string[] = [], cc: string[] = []): MessageMeta => ({
  id: `m_${Math.random().toString(36).slice(2)}`,
  accountId: "acc_any",
  direction: "inbound",
  from,
  to,
  cc,
  rfcMessageId: null,
  inReplyTo: null,
  createdAtMs: null,
  sentAt: null
});

const RULES: RestrictedSenderRule[] = [
  ruleFromRow({ id: "rs_deel", pattern: " Deel.COM ", match_kind: "domain", label: "Deel" }, new Set()),
  ruleFromRow({ id: "rs_stripe", pattern: "stripe.com", match_kind: "domain", label: "Stripe" }, new Set()),
  ruleFromRow({ id: "rs_rm", pattern: "rmreyestaxservices@gmail.com", match_kind: "exact", label: "RM" }, new Set()),
  ruleFromRow({ id: "rs_bill", pattern: "bill.com", match_kind: "suffix", label: "Bill" }, new Set()),
  ruleFromRow({ id: "rs_com", pattern: "com", match_kind: "domain", label: "tld" }, new Set()),
  ruleFromRow({ id: "rs_empty", pattern: "   ", match_kind: "domain", label: "empty" }, new Set())
];

const CORPUS: [string, ScreenInput][] = [
  ["exact, mixed case", { all: [meta("RM Reyes <RMReyesTaxServices@Gmail.com>")], participants: [] }],
  ["domain", { all: [meta("a@client.io", ["payroll@deel.com"])], participants: [] }],
  ["subdomain", { all: [meta("a@client.io", [], ["Hello <hello@mail.deel.com>"])], participants: [] }],
  ["lookalikes", { all: [meta("x@deel.com.evil.tld", ["y@notdeel.com"], ["z@deelcom.net", "w@mybill.com"])], participants: [] }],
  ["a raw two-address from", { all: [meta("Me <me@x.org>; Them <t@deel.com>")], participants: [] }],
  ["@x", { all: [meta("@deel.com")], participants: [] }],
  ["trailing dot", { all: [meta("a@client.io", ["a@deel.com."])], participants: [] }],
  ["case and whitespace", { all: [meta("a@client.io", ["  A@DEEL.COM  "])], participants: [] }],
  ["display names", { all: [meta("a@client.io", ['"payroll@deel.com" <ops@safe.io>'])], participants: ["Deel Payroll <noreply@inform.bill.com>"] }],
  ["participants only", { all: [meta("a@client.io", ["b@client.io"])], participants: ["x@stripe.com"] }],
  ["clean", { all: [meta("a@client.org", ["mitchell@scaledai.org"])], participants: ["a@client.org"] }],
  ["normalizeMessage fragments", { all: [meta("a@client.org", toStringArray('"Toledo, Lívia" <l@deel.com>'))], participants: [] }],
  ["empty and junk", { all: [meta("", [], ["not-an-address", "x@"])], participants: ["", "nobody"] }],
  ["a list field as a string", { all: [{ from: "a@client.org", to: "Q <q@stripe.com>" as unknown as string[], cc: [] }], participants: "p@deel.com" as unknown as string[] }]
];

// DD's own predicates over the same input, computed independently of mail.ts.
function ddVerdict(t: ScreenInput, rules: RestrictedSenderRule[]) {
  const asList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : []);
  const msgs = t.all.map((m) => ({ from_addr: m.from, to_addrs: asList(m.to), cc_addrs: asList(m.cc) }));
  const thread = { participants: asList(t.participants) };
  return {
    verdict: messagesMatch(msgs, rules) || threadMatches(thread, rules) ? "restricted" : "clean",
    ruleIds: rules.filter((r) => messagesMatch(msgs, [r]) || threadMatches(thread, [r])).map((r) => r.id)
  };
}

describe("screenRestricted = messagesMatch over every message ∨ threadMatches over the participants", () => {
  it.each(CORPUS)("%s", (_name, t) => {
    for (const rules of [RULES, ...RULES.map((r) => [r]), []]) {
      expect(screenRestricted(t, rules)).toEqual(ddVerdict(t, rules));
    }
  });

  it("sees a restricted CC on any account's message, not just his", () => {
    const t: ScreenInput = { all: [meta("client@x.io", ["mitchell@scaledai.org"]), { ...meta("teammate@scaledai.org", [], ["ops@deel.com"]), accountId: "acc_other" }], participants: [] };
    expect(screenRestricted(t, RULES).verdict).toBe("restricted");
  });
});

describe("screenHashesFor / screenByHashes ≡ DD's matching", () => {
  it.each(CORPUS)("%s", (_name, t) => {
    const { hashes, truncated } = screenHashesFor(t);
    expect(truncated).toBe(false);
    expect(hashes).toEqual([...hashes].sort());
    for (const rules of [RULES, ...RULES.map((r) => [r]), []]) {
      expect(screenByHashes(hashes, rules)).toEqual(ddVerdict(t, rules));
    }
  });

  it("stores no address: every entry is 32 hex characters", () => {
    const { hashes } = screenHashesFor(CORPUS[1][1]);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(hashes)).not.toContain("deel");
  });

  it("more than 600 entries: keeps the first 600 of the sorted set, deterministically, and marks it truncated", () => {
    const addrs = Array.from({ length: 400 }, (_, i) => `u${i}@d${i}.example.com`);
    const a = screenHashesFor({ all: [meta("x@y.com", addrs)], participants: [] });
    const b = screenHashesFor({ all: [meta("x@y.com", [...addrs].reverse())], participants: [] });
    expect(a.truncated).toBe(true);
    expect(a.hashes).toHaveLength(600);
    expect(a.hashes).toEqual([...a.hashes].sort());
    expect(b).toEqual(a);
  });

  it("the feed-row helpers screen one row the same way", () => {
    const row = { from: "a@client.io", to: ["Payroll <payroll@deel.com>"], cc: [] };
    expect(screenFeedRow(row, RULES)).toEqual(screenRestricted({ all: [row], participants: [] }, RULES));
    expect(screenFeedRow(row, RULES).ruleIds).toContain("rs_deel");
    expect(screenByHashes(feedRowScreenHashes(row).hashes, RULES)).toEqual(screenFeedRow(row, RULES));
  });
});

describe("restrictedPolicyHash", () => {
  const rules = [rule("rs_a", "a.com"), rule("rs_b", "b@x.com", "exact")];

  it("is a sha256 hex, and dd_only hashes exactly as hidden (L31)", () => {
    const h = restrictedPolicyHash("hidden", rules);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(restrictedPolicyHash("dd_only", rules)).toBe(h);
  });

  it("moves only with the (kind, pattern) set", () => {
    const h = restrictedPolicyHash("hidden", rules);
    expect(restrictedPolicyHash("hidden", [...rules].reverse())).toBe(h);
    expect(restrictedPolicyHash("hidden", [...rules, rule("rs_dup", "a.com")])).toBe(h);
    expect(restrictedPolicyHash("hidden", [rule("other_id", "a.com", "domain", ["u_x"]), rules[1]])).toBe(h);
    expect(restrictedPolicyHash("hidden", [rule("rs_a", "a.org"), rules[1]])).not.toBe(h);
    expect(restrictedPolicyHash("hidden", [rule("rs_a", "a.com", "exact"), rules[1]])).not.toBe(h);
    expect(restrictedPolicyHash("hidden", [])).not.toBe(h);
  });
});

describe("screenStoredRow (A2)", () => {
  const H = restrictedPolicyHash("hidden", RULES);
  const OLD = "0".repeat(64);
  const deelHashes = screenHashesFor({ all: [meta("payroll@deel.com")], participants: [] }).hashes;
  const cleanHashes = screenHashesFor({ all: [meta("client@client.io")], participants: [] }).hashes;
  const rowOf = (over: Partial<ThreadScreenRow>): ThreadScreenRow => ({
    threadId: "t1",
    accountId: "acc_his",
    state: "triaged",
    screenHashes: cleanHashes,
    screenTruncated: false,
    screenedPolicyHash: H,
    ...over
  });
  const verdict = (over: Partial<ThreadScreenRow>, rules = RULES.slice(0, 3)) => screenStoredRow(rowOf(over), rules, H);

  it("a tombstone is restricted", () => {
    expect(verdict({ state: "restricted_hidden", screenHashes: [] })).toMatchObject({ verdict: "restricted", reason: "tombstone" });
  });

  it("a stored hash matching a current rule is restricted, in every state including gone", () => {
    for (const state of ["triaged", "filtered", "triage_failed", "deferred_budget", "gone"] as const) {
      expect(verdict({ state, screenHashes: deelHashes })).toMatchObject({ verdict: "restricted", reason: "rule_match", ruleIds: ["rs_deel"] });
    }
  });

  it("a truncated row screened under another policy is restricted; under the current one it is clean", () => {
    expect(verdict({ screenTruncated: true, screenedPolicyHash: OLD })).toMatchObject({ verdict: "restricted", reason: "stale_truncated" });
    expect(verdict({ screenTruncated: true, screenedPolicyHash: null })).toMatchObject({ verdict: "restricted", reason: "stale_truncated" });
    expect(verdict({ screenTruncated: true, screenedPolicyHash: H })).toEqual({ verdict: "clean", ruleIds: [], reason: null });
  });

  it("a complete hash set screened under an old policy is judged by its hashes alone", () => {
    expect(verdict({ screenedPolicyHash: OLD })).toEqual({ verdict: "clean", ruleIds: [], reason: null });
    expect(verdict({ screenedPolicyHash: OLD, screenHashes: deelHashes })).toMatchObject({ verdict: "restricted", reason: "rule_match" });
  });

  it("fails closed on a row it can't read", () => {
    expect(verdict({ screenHashes: null as unknown as string[] })).toMatchObject({ verdict: "restricted", reason: "unscreenable" });
    expect(verdict({ screenTruncated: null as unknown as boolean, screenedPolicyHash: OLD })).toMatchObject({ verdict: "restricted" });
  });
});

// ---------------------------------------------------------------------------
// Answered (L3), overlay, partial threads (L17)
// ---------------------------------------------------------------------------

let seq = 0;
function msg(over: Partial<HisMessage> & Pick<HisMessage, "direction" | "sentAt">): HisMessage {
  seq += 1;
  return {
    id: `m${String(seq).padStart(3, "0")}`,
    threadId: "t1",
    accountId: "acc_his",
    folder: over.direction === "inbound" ? "Inbox" : "Sent Items",
    isJunk: false,
    rfcMessageId: `<r${seq}@mail>`,
    inReplyTo: null,
    subject: "s",
    from: null,
    to: [],
    cc: [],
    createdAtMs: Date.parse(over.sentAt),
    isAutomated: false,
    attachments: [],
    bodyDeferred: false,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}

const CLIENT = { name: "Client", email: "client@acme.io" };
const MITCH = { name: "Mitchell", email: "mitchell@scaledai.org" };
const inbound = (sentAt: string, over: Partial<HisMessage> = {}) => msg({ direction: "inbound", sentAt, from: CLIENT, to: [MITCH], ...over });
const outbound = (sentAt: string, over: Partial<HisMessage> = {}) => msg({ direction: "outbound", sentAt, from: MITCH, to: [CLIENT], ...over });

describe("computeAnswered", () => {
  it("no inbound at all is no_inbound, anchored on the newest message", () => {
    const o = outbound("2026-11-01T10:00:00.000Z");
    const r = computeAnswered([o]);
    expect(r).toMatchObject({ state: "no_inbound", answeredAt: null, newestInbound: null, newestOutbound: o, newestMessage: o, newestIsOutbound: true, anchorMessageId: o.id });
    expect(computeAnswered([])).toMatchObject({ state: "no_inbound", newestMessage: null, newestIsOutbound: null, anchorMessageId: null, outboundAutomatedOnly: false });
  });

  it("a later, non-automated outbound to the sender answers it", () => {
    const i = inbound("2026-11-01T10:00:00.000Z");
    const o = outbound("2026-11-01T11:00:00.000Z");
    expect(computeAnswered([i, o])).toMatchObject({
      state: "answered",
      answeredAt: o.sentAt,
      answeredMessageId: o.id,
      lastInboundAt: i.sentAt,
      lastOutboundAt: o.sentAt,
      newestIsOutbound: true,
      anchorMessageId: i.id
    });
  });

  it("the first qualifying reply is the one recorded", () => {
    const i = inbound("2026-11-01T10:00:00.000Z");
    const o1 = outbound("2026-11-01T11:00:00.000Z");
    const o2 = outbound("2026-11-01T12:00:00.000Z");
    expect(computeAnswered([o2, i, o1]).answeredMessageId).toBe(o1.id);
  });

  it("an outbound sent before, or at the same instant as, the inbound doesn't answer it", () => {
    expect(computeAnswered([outbound("2026-11-01T09:00:00.000Z"), inbound("2026-11-01T10:00:00.000Z")]).state).toBe("awaiting_reply");
    expect(computeAnswered([inbound("2026-11-01T10:00:00.000Z"), outbound("2026-11-01T10:00:00.000Z")]).state).toBe("awaiting_reply");
  });

  it("an automated outbound (is_automated 1) doesn't answer; is_automated 0 does", () => {
    const i = inbound("2026-11-01T10:00:00.000Z");
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { isAutomated: true })])).toMatchObject({
      state: "awaiting_reply",
      outboundAutomatedOnly: true
    });
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { isAutomated: false })])).toMatchObject({
      state: "answered",
      outboundAutomatedOnly: false
    });
  });

  it("a forward to staff (not to the sender, not a reply to it) doesn't answer", () => {
    const i = inbound("2026-11-01T10:00:00.000Z");
    const fwd = outbound("2026-11-01T11:00:00.000Z", { to: [{ name: null, email: "staff@scaledai.org" }] });
    expect(computeAnswered([i, fwd]).state).toBe("awaiting_reply");
  });

  it("the sender on cc, or in_reply_to = its Message-ID (brackets and case aside), answers it", () => {
    const i = inbound("2026-11-01T10:00:00.000Z", { rfcMessageId: "<Abc.123@Mail.Acme.io>" });
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { to: [], cc: [CLIENT] })]).state).toBe("answered");
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { to: [], inReplyTo: "abc.123@mail.acme.io" })]).state).toBe("answered");
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { to: [], inReplyTo: "<other@mail>" })]).state).toBe("awaiting_reply");
  });

  it("mixed-case addresses compare lowercased (as parsed)", () => {
    const [sender] = parseAddressList(["Client <Client@ACME.io>"]);
    const [recipient] = parseAddressList(["client@acme.IO"]);
    const i = inbound("2026-11-01T10:00:00.000Z", { from: sender });
    expect(computeAnswered([i, outbound("2026-11-01T11:00:00.000Z", { to: [recipient] })]).state).toBe("answered");
  });

  it("only the newest inbound counts: an answered older one doesn't answer a newer one", () => {
    const i1 = inbound("2026-11-01T10:00:00.000Z");
    const o = outbound("2026-11-01T11:00:00.000Z");
    const i2 = inbound("2026-11-01T12:00:00.000Z");
    expect(computeAnswered([i1, o, i2])).toMatchObject({ state: "awaiting_reply", newestInbound: i2, newestMessage: i2, newestIsOutbound: false, anchorMessageId: i2.id });
  });

  it("junk is ignored entirely", () => {
    const o = outbound("2026-11-01T09:00:00.000Z");
    const spam = inbound("2026-11-01T10:00:00.000Z", { isJunk: true, folder: "Junk Email" });
    expect(computeAnswered([o, spam])).toMatchObject({ state: "no_inbound", lastInboundAt: null, anchorMessageId: o.id });
  });

  it("with ownAddresses, a self-cc'd inbound copy of his own mail isn't mail to answer", () => {
    const i = inbound("2026-11-01T10:00:00.000Z");
    const o = outbound("2026-11-01T11:00:00.000Z");
    const selfCopy = inbound("2026-11-01T11:00:00.000Z", { from: { name: "Mitchell", email: "mitchell@scaledai.org" } });
    expect(computeAnswered([i, o, selfCopy]).state).toBe("awaiting_reply");
    expect(computeAnswered([i, o, selfCopy], { ownAddresses: ["Mitchell@ScaledAI.org"] })).toMatchObject({ state: "answered", newestIsOutbound: true });
  });
});

describe("overlayAnswered", () => {
  const row = { answeredState: "awaiting_reply" as const, newestInboundMessageId: "m_in" };
  const removed = { messageId: "m_in", removedAt: "2026-11-02T10:00:00.000Z" };

  it("handled_in_outlook only from the newest inbound's own signals row", () => {
    expect(overlayAnswered(row, removed)).toBe("handled_in_outlook");
    // Archived an older message, then new mail arrived: awaiting again.
    expect(overlayAnswered(row, { messageId: "m_older", removedAt: removed.removedAt })).toBe("awaiting_reply");
    expect(overlayAnswered(row, { messageId: "m_in", removedAt: null })).toBe("awaiting_reply");
    expect(overlayAnswered({ ...row, newestInboundMessageId: null }, removed)).toBe("awaiting_reply");
  });

  it("a scheduled reply, then a pending draft", () => {
    expect(overlayAnswered(row, undefined, { scheduledFor: "2026-11-05T09:00:00.000Z", draftPending: true })).toBe("reply_scheduled");
    expect(overlayAnswered(row, undefined, { scheduledFor: null, draftPending: true })).toBe("draft_pending");
    expect(overlayAnswered(row, undefined, { scheduledFor: null, draftPending: false })).toBe("awaiting_reply");
    expect(overlayAnswered(row, removed, { scheduledFor: "2026-11-05T09:00:00.000Z", draftPending: true })).toBe("handled_in_outlook");
  });

  it("other stored states pass through; no state is null", () => {
    expect(overlayAnswered({ ...row, answeredState: "answered" }, removed, { scheduledFor: "x", draftPending: true })).toBe("answered");
    expect(overlayAnswered({ ...row, answeredState: "no_inbound" }, undefined)).toBe("no_inbound");
    expect(overlayAnswered({ ...row, answeredState: null }, removed)).toBeNull();
  });
});

describe("isPartialThread", () => {
  const all = (...ids: (string | null)[]) => ids.map((id) => ({ ...meta("x@y.com"), rfcMessageId: id }));

  it("a reply whose parent is in the thread (any account) isn't partial", () => {
    expect(isPartialThread([outbound("2026-11-01T11:00:00.000Z", { inReplyTo: "<p1@mail>" })], all("<p1@mail>"))).toBe(false);
    expect(isPartialThread([outbound("2026-11-01T11:00:00.000Z", { inReplyTo: "P1@MAIL" })], all("<p1@mail>"))).toBe(false);
  });

  it("a reply to a message the thread doesn't have is partial", () => {
    expect(isPartialThread([outbound("2026-11-01T11:00:00.000Z", { inReplyTo: "<gone@mail>" })], all("<p1@mail>", null))).toBe(true);
  });

  it("messages without in_reply_to never make it partial", () => {
    expect(isPartialThread([inbound("2026-11-01T10:00:00.000Z")], all())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clone times and the pin
// ---------------------------------------------------------------------------

describe("cloneTimeToMs / cloneTimeToIso", () => {
  it("reads BIGINT digit strings, numbers and ISO strings", () => {
    expect(cloneTimeToMs("1762259200000")).toBe(1_762_259_200_000);
    expect(cloneTimeToMs(1_762_259_200_000)).toBe(1_762_259_200_000);
    expect(cloneTimeToMs("2026-11-04T12:00:00.000+00:00")).toBe(Date.parse("2026-11-04T12:00:00.000Z"));
    expect(cloneTimeToIso("1762259200000")).toBe("2025-11-04T12:26:40.000Z");
  });

  it("anything else is null, never an invalid date", () => {
    for (const v of [null, undefined, "", "soon", "12abc", {}, Number.NaN, "99999999999999999", 9e15]) {
      expect(cloneTimeToMs(v)).toBeNull();
      expect(cloneTimeToIso(v)).toBeNull();
    }
  });
});

describe("the pin", () => {
  it("pinnedAccounts dedupes; isPinnedAccount and usableAccounts follow it", () => {
    const p = mint({ accounts: ["acc_a", "acc_b", "acc_a"] });
    expect(pinnedAccounts(p)).toEqual(["acc_a", "acc_b"]);
    expect(isPinnedAccount(p, "acc_b")).toBe(true);
    expect(isPinnedAccount(p, "acc_c")).toBe(false);
    expect(isPinnedAccount(p, "")).toBe(false);
    expect(isPinnedAccount(p, null)).toBe(false);
    expect(usableAccounts(p, new Set(["acc_a", "acc_zzz"]))).toEqual(["acc_b"]);
    expect(usableAccounts(mint({ accounts: [] }), new Set())).toEqual([]);
  });

  it("MailScopeError is non-retryable", () => {
    const e = new MailScopeError("x");
    expect(e.errorClass).toBe("fatal");
    expect(e.name).toBe("MailScopeError");
  });
});

beforeEach(() => {
  seq = 0;
});
