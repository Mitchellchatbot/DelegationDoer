import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/dd")>();
  return { ...actual, listClientMatchSignals: vi.fn() };
});
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, listInternalAddresses: vi.fn() };
});

import {
  buildClientMatcher,
  isActiveClientStatus,
  loadClientMatcher,
  matchThreadClient,
  threadCorrespondents,
  type ClientMatch
} from "@/lib/exec/correlate";
import type { HisMessage, ParsedAddress } from "@/lib/exec/email-types";
import { principalFromRows } from "@/lib/exec/principal";
import { listClientMatchSignals } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals } from "@/lib/exec/sources/dd-types";
import { listInternalAddresses } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";

// The client matcher (contract §3.12, L14): the full confidence table, the
// internal-address screen and its client-claimed-domain carve-out, active
// clients only, and which addresses of a thread are matched.

function client(id: string, name: string, over: Partial<DdClientMatchSignals> = {}): DdClientMatchSignals {
  return { id, name, status: "active", website: null, websites: [], contactEmails: [], priority: null, ...over };
}

const CLIENTS: DdClientMatchSignals[] = [
  client("cl_acme", "Acme", { website: "https://www.acme.com/about", contactEmails: ["Jane@Acme.com "] }),
  client("cl_beta", "Beta Labs", { websites: ["beta.io"], contactEmails: ["ceo@beta.io"] }),
  // One CSM writes for three clients (the Villa cohort).
  client("cl_villa1", "Villa One", { contactEmails: ["csm@villagroup.com"] }),
  client("cl_villa2", "Villa Two", { contactEmails: ["csm@villagroup.com"] }),
  client("cl_villa3", "Villa Three", { contactEmails: ["csm@villagroup.com"] }),
  // Seeded with our own team address as a contact, as in production.
  client("cl_outpatient", "Outpatient", { contactEmails: ["team@scaledai.org"], website: "outpatient.example" }),
  // A client whose website is the domain one of our mailboxes sits on.
  client("cl_shared", "Shared Host", { website: "partnerhost.com" }),
  client("cl_paused", "Paused Co", { status: "paused", website: "paused.com", contactEmails: ["p@paused.com"] }),
  client("cl_null", "Null Status", { status: null, contactEmails: ["n@nullstatus.com"] }),
  client("cl_empty", "Empty Status", { status: "", contactEmails: ["e@emptystatus.com"] })
];

const INTERNAL = {
  addresses: ["mitchell@scaledai.org", "team@scaledai.org", "ops@partnerhost.com"],
  domains: ["scaledai.org", "partnerhost.com"]
};

const matcher = buildClientMatcher(CLIENTS, INTERNAL);
const none: ClientMatch = { clientId: null, clientName: null, via: null, confidence: null, candidates: 0 };

describe("the match table (L14)", () => {
  it.each<[string, string[], ClientMatch]>([
    ["an exact contact is high", ["jane@acme.com"], { clientId: "cl_acme", clientName: "Acme", via: "exact", confidence: "high", candidates: 1 }],
    ["a display name and odd case still match exactly", ['"Doe, Jane" <JANE@ACME.COM>'], { clientId: "cl_acme", clientName: "Acme", via: "exact", confidence: "high", candidates: 1 }],
    ["a person on the website domain is medium", ["bob@acme.com"], { clientId: "cl_acme", clientName: "Acme", via: "domain", confidence: "medium", candidates: 1 }],
    ["a role address on the website domain is low", ["support@acme.com"], { clientId: "cl_acme", clientName: "Acme", via: "domain", confidence: "low", candidates: 1 }],
    ["the client's own automation is low", ["wordfence@beta.io"], { clientId: "cl_beta", clientName: "Beta Labs", via: "domain", confidence: "low", candidates: 1 }],
    ["an address claimed by several clients is low, with the count", ["csm@villagroup.com"], { clientId: "cl_villa1", clientName: "Villa One", via: "exact", confidence: "low", candidates: 3 }],
    ["a subdomain is not the website domain (DD's host equality)", ["jane@mail.acme.com"], none],
    ["a lookalike domain is no client", ["jane@acme.com.evil.io"], none],
    ["an unknown sender is no client", ["someone@elsewhere.org"], none],
    ["our own address never matches, even listed as a contact", ["team@scaledai.org"], none],
    ["our own domain never matches", ["newhire@scaledai.org"], none],
    ["a paused client is ignored", ["p@paused.com"], none],
    ["a null status is active", ["n@nullstatus.com"], { clientId: "cl_null", clientName: "Null Status", via: "exact", confidence: "high", candidates: 1 }],
    ["an empty status is active", ["e@emptystatus.com"], { clientId: "cl_empty", clientName: "Empty Status", via: "exact", confidence: "high", candidates: 1 }],
    ["garbage is no client", ["not an address", "", "@acme.com"], none],
    ["no addresses is no client", [], none]
  ])("%s", (_name, addresses, expected) => {
    expect(matcher.match(addresses)).toEqual(expected);
  });

  it("a domain one of our mailboxes is on, but a client claims, matches the client; the mailbox itself never does", () => {
    expect(matcher.match(["someone@partnerhost.com"])).toEqual({
      clientId: "cl_shared",
      clientName: "Shared Host",
      via: "domain",
      confidence: "medium",
      candidates: 1
    });
    expect(matcher.match(["ops@partnerhost.com"])).toEqual(none);
  });

  it("the strongest evidence wins over the newest address", () => {
    // Newest first: a role address on Acme's domain, then Jane herself.
    expect(matcher.match(["support@acme.com", "jane@acme.com"])).toEqual({
      clientId: "cl_acme",
      clientName: "Acme",
      via: "exact",
      confidence: "high",
      candidates: 1
    });
  });

  it("two clients in one thread is ambiguous: the strongest, then the newest, leads", () => {
    expect(matcher.match(["bob@acme.com", "ceo@beta.io"])).toEqual({
      clientId: "cl_beta",
      clientName: "Beta Labs",
      via: "exact",
      confidence: "low",
      candidates: 2
    });
    expect(matcher.match(["ceo@beta.io", "jane@acme.com"])).toEqual({
      clientId: "cl_beta",
      clientName: "Beta Labs",
      via: "exact",
      confidence: "low",
      candidates: 2
    });
  });

  it("skips our own addresses and keeps looking", () => {
    expect(matcher.match(["mitchell@scaledai.org", "jane@acme.com"])).toEqual(expect.objectContaining({ clientId: "cl_acme", confidence: "high" }));
  });

  it("is deterministic whatever order the clients came in", () => {
    const reversed = buildClientMatcher([...CLIENTS].reverse(), INTERNAL);
    for (const a of ["csm@villagroup.com", "bob@acme.com", "support@acme.com"]) expect(reversed.match([a])).toEqual(matcher.match([a]));
  });

  it("counts only active clients", () => {
    expect(matcher.activeClients).toBe(9);
  });
});

describe("isInternal", () => {
  it.each([
    ["mitchell@scaledai.org", true],
    ["Team <TEAM@scaledai.org>", true],
    ["newhire@scaledai.org", true],
    ["ops@partnerhost.com", true],
    // A client claims partnerhost.com, so other addresses there are the client's.
    ["someone@partnerhost.com", false],
    ["jane@acme.com", false],
    ["garbage", false],
    ["", false]
  ])("%s → %s", (address, internal) => {
    expect(matcher.isInternal(address)).toBe(internal);
  });

  it("knows only what it was given", () => {
    const bare = buildClientMatcher([], { addresses: [], domains: [] });
    expect(bare.isInternal("mitchell@scaledai.org")).toBe(false);
    expect(bare.match(["jane@acme.com"])).toEqual(none);
  });
});

describe("isActiveClientStatus", () => {
  it.each([
    [null, true],
    [undefined, true],
    ["", true],
    ["active", true],
    ["Active", false],
    ["paused", false],
    ["churned", false]
  ])("%j → %s", (status, active) => {
    expect(isActiveClientStatus(status as string | null)).toBe(active);
  });
});

// ---------------------------------------------------------------------------

function addr(email: string, name: string | null = null): ParsedAddress {
  return { name, email };
}

function msg(id: string, over: Partial<HisMessage>): HisMessage {
  return {
    id,
    threadId: "th",
    accountId: "acct-1",
    direction: "inbound",
    folder: "INBOX",
    isJunk: false,
    rfcMessageId: `<${id}@x>`,
    inReplyTo: null,
    subject: "s",
    from: null,
    to: [],
    cc: [],
    sentAt: "2026-11-01T00:00:00.000Z",
    createdAtMs: null,
    isAutomated: false,
    attachments: [],
    bodyDeferred: true,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}

describe("matchThreadClient", () => {
  it("matches his inbound senders, newest first, and skips junk", () => {
    const his = [
      msg("m1", { from: addr("support@acme.com"), sentAt: "2026-11-01T00:00:00.000Z" }),
      msg("m2", { from: addr("ceo@beta.io"), sentAt: "2026-11-03T00:00:00.000Z" }),
      msg("m3", { from: addr("jane@acme.com"), sentAt: "2026-11-04T00:00:00.000Z", isJunk: true }),
      msg("m4", { direction: "outbound", to: [addr("jane@acme.com")], sentAt: "2026-11-05T00:00:00.000Z" })
    ];
    expect(threadCorrespondents({ his })).toEqual(["ceo@beta.io", "support@acme.com"]);
    expect(matchThreadClient({ his }, matcher)).toEqual({
      clientId: "cl_beta",
      clientName: "Beta Labs",
      clientMatchVia: "exact",
      matchConfidence: "low",
      clientCandidates: 2
    });
  });

  it("uses his outbound recipients when he only sent", () => {
    const his = [
      msg("m1", { direction: "outbound", to: [addr("bob@acme.com")], cc: [addr("ceo@beta.io")], sentAt: "2026-11-01T00:00:00.000Z" }),
      msg("m2", { direction: "outbound", to: [addr("mitchell@scaledai.org")], sentAt: "2026-11-02T00:00:00.000Z" })
    ];
    expect(threadCorrespondents({ his })).toEqual(["mitchell@scaledai.org", "bob@acme.com"]);
    expect(matchThreadClient({ his }, matcher)).toEqual({
      clientId: "cl_acme",
      clientName: "Acme",
      clientMatchVia: "domain",
      matchConfidence: "medium",
      clientCandidates: 1
    });
  });

  it("is no client for a thread with nothing to match", () => {
    expect(matchThreadClient({ his: [msg("m1", { from: null })] }, matcher)).toEqual({
      clientId: null,
      clientName: null,
      clientMatchVia: null,
      matchConfidence: null,
      clientCandidates: 0
    });
  });
});

describe("loadClientMatcher", () => {
  const principal: ExecPrincipal = (() => {
    const p = principalFromRows(
      { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: ["acct-1"], slack_team_id: null, slack_user_id: null },
      { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
      null
    );
    if (!p) throw new Error("fixture principal did not mint");
    return p;
  })();

  it("builds from the clients and the team's addresses, passing the signal and the clone timeout", async () => {
    vi.mocked(listClientMatchSignals).mockResolvedValue(CLIENTS);
    vi.mocked(listInternalAddresses).mockResolvedValue(INTERNAL);
    const signal = new AbortController().signal;
    const m = await loadClientMatcher(principal, { signal, timeoutMs: 30_000 });
    expect(m.match(["jane@acme.com"]).confidence).toBe("high");
    expect(m.isInternal("team@scaledai.org")).toBe(true);
    expect(listClientMatchSignals).toHaveBeenCalledWith(principal, { signal });
    expect(listInternalAddresses).toHaveBeenCalledWith(principal, { signal, timeoutMs: 30_000 });
  });

  it("throws when either read fails, never matching against nothing", async () => {
    vi.mocked(listClientMatchSignals).mockRejectedValue(new Error("DD read failed (clients): timeout"));
    vi.mocked(listInternalAddresses).mockResolvedValue(INTERNAL);
    await expect(loadClientMatcher(principal)).rejects.toThrow(/clients/);
    vi.mocked(listClientMatchSignals).mockResolvedValue(CLIENTS);
    vi.mocked(listInternalAddresses).mockRejectedValue(new Error("clone account list answered HTTP 503"));
    await expect(loadClientMatcher(principal)).rejects.toThrow(/503/);
  });
});
