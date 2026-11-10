import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/drafts-store", () => ({ listDraftArtifacts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), countEnabledMailPinnedPrincipals: vi.fn(async () => 1), loadPrincipalById: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(async () => null), putSyncState: vi.fn(async () => undefined) }));
vi.mock("@/lib/missive-socket", () => ({ startMissiveSocketBridge: vi.fn(), getMissiveSocketStatus: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { pinnedRowMap, pinnedRows } from "@/lib/exec/email-view";
import { EMAIL_TRIAGE_JOB_KIND, __resetJobsForTests } from "@/lib/exec/jobs";
import { __resetMailHookForTests, ensureMailHook } from "@/lib/exec/mail-hook";
import { principalFromRows } from "@/lib/exec/principal";
import * as mail from "@/lib/exec/sources/mail";
import { MailScopeError } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";
import { publish } from "@/lib/inbox-event-bus";
import { __resetMessagesFeedProbeForTests } from "@/lib/missive-client";
import { createFakePipelineDb, type FakePipelineDb, type Row } from "./fake-pipeline-db";
import { installFakeCl2, type FakeCl2 } from "./fake-clone";

// P9 §2.2 (Area B): mailbox scope. (a) every export of sources/mail.ts that takes an account, thread or message id refuses a
// foreign one before any clone call, and the table covers the module's exports (a new export with no row fails here);
// (b) stored-row parity: the page surfaces and the chat tools leave out the same rows of a mailbox no longer pinned (the
// chat side runs in agent/tools-email.test.ts "P9 F7"; the brief screen is Area C's brief-screen.test.ts); recipient
// suggestions too; (c) a bus event from a foreign account is dropped; (d) an EA token whose accounts differ from the pin
// turns drafting off (wrong_accounts).

const HIS = "acc_his";
const FOREIGN = "acc_foreign";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify(claims))}.c2ln`;
const DRAFT_TOKEN = jwt({ id: "u_ea", workspace_id: "w1", scope: ["read", "draft"], accounts: [HIS], jti: "jti_0123456789abcdef", exp: 2_000_000_000 });

function mint(accounts: string[], id = "ep_owner"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint([HIS]);
const unpinned = mint([]);
const ENV = { ...process.env };

let fake: FakeCl2;
beforeEach(() => {
  mail.invalidateEaReadiness();
  __resetMessagesFeedProbeForTests();
  fake = installFakeCl2(vi.stubGlobal, { draftToken: DRAFT_TOKEN, sendToken: "send-token", accounts: [HIS] });
  process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

const addr = (address: string) => ({ address, name: null });
const hisMessage = (accountId: string) => ({
  id: "m_1", threadId: "th_1", accountId, direction: "inbound" as const, folder: "INBOX", isJunk: false, rfcMessageId: "<m1@x>", inReplyTo: null, subject: "s",
  from: { name: null, email: "c@client.example" }, to: [], cc: [], sentAt: "2026-11-03T12:00:00.000Z", createdAtMs: null, isAutomated: false, attachments: [],
  bodyDeferred: true, bodyHtml: null, bodyText: null
});
const threadOn = (accountId: string) => ({
  threadId: "th_1", participants: [], his: [hisMessage(accountId)], all: [], lastMessageAt: null,
  snapshot: { identityCount: 1, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: 0, readDoneAtMs: 0 }
});

/** (a) Every export that takes an account, thread or message id: called with a foreign one. */
const FOREIGN_ROWS: Record<string, () => Promise<unknown>> = {
  readPrincipalThread: () => mail.readPrincipalThread(principal, "th_1", { usable: [FOREIGN] }),
  loadHisBodies: () => mail.loadHisBodies(principal, threadOn(FOREIGN) as never, ["m_1"]),
  listPrincipalThreadsSince: () => mail.listPrincipalThreadsSince(principal, FOREIGN, { afterIso: "2026-11-01T00:00:00.000Z", limit: 10, offset: 0 }),
  searchPrincipalThreads: () => mail.searchPrincipalThreads(principal, { query: "", from: "", sinceMs: 0, folders: ["INBOX"], limit: 10, usable: [FOREIGN] } as never),
  listPrincipalMessagesFeed: () => mail.listPrincipalMessagesFeed(principal, FOREIGN, { order: "created", cursor: null, sinceIso: null, limit: 10 }),
  createReplyDraft: () => mail.createReplyDraft(principal, { threadId: "th_1", parentMessageId: "m_1", accountId: FOREIGN, to: [addr("c@client.example")], cc: [], bodyHtml: "<p>x</p>", timezone: "America/New_York", idempotencyKey: "k".repeat(40) }),
  createNewDraft: () => mail.createNewDraft(principal, { accountId: FOREIGN, to: [addr("c@client.example")], cc: [], bcc: [], subject: "s", bodyHtml: "<p>x</p>", timezone: "America/New_York", idempotencyKey: "k".repeat(40) }),
  getOutlookDraft: () => mail.getOutlookDraft(principal, { accountId: FOREIGN, graphId: "AAMkAGraphId=" }),
  recreateOutlookDraft: () => mail.recreateOutlookDraft(principal, { accountId: FOREIGN, graphId: "AAMkAGraphId=", kind: "reply", to: [addr("c@client.example")], cc: [], bcc: [], subject: null, bodyHtml: "<p>x</p>", timezone: "America/New_York", ifContentHash: null, idempotencyKey: "k".repeat(40) }),
  deleteOutlookDraft: () => mail.deleteOutlookDraft(principal, { accountId: FOREIGN, graphId: "AAMkAGraphId=", ifContentHash: null, idempotencyKey: "k".repeat(40) }),
  findSentCopy: () => mail.findSentCopy(principal, { accountId: FOREIGN, internetMessageId: "x@y", threadId: null, sinceMs: 0 })
};
/** Exports scoped to the pin as a whole (no id parameter): with no pinned mailbox they refuse before any read. */
const PIN_SCOPED: Record<string, () => Promise<unknown>> = {
  checkPinnedAccounts: () => mail.checkPinnedAccounts(unpinned),
  listInternalAddresses: () => mail.listInternalAddresses(unpinned),
  listReplyArtifacts: () => mail.listReplyArtifacts(unpinned, ["th_1"]),
  listAllReplyArtifacts: () => mail.listAllReplyArtifacts(unpinned),
  countPendingReplyArtifacts: () => mail.countPendingReplyArtifacts(unpinned)
};
/** Exports that take no account, thread or message id at all (pure helpers, the rules, the EA readiness of the pin, (d)). */
const NO_ID = new Set([
  "pinnedAccounts", "isPinnedAccount", "usableAccounts", "cloneTimeToMs", "cloneTimeToIso", "parseAddressList", "parseAddress", "loadRestrictedRulesStrict",
  "applicableRules", "restrictedPolicyHash", "loadScreeningPolicy", "screenRestricted", "screenHashesFor", "screenByHashes", "screenStoredRow", "screenFeedRow",
  "feedRowScreenHashes", "computeAnswered", "overlayAnswered", "isPartialThread", "eaTokenConfigured", "getEaReadiness", "peekEaReadiness", "invalidateEaReadiness"
]);
const isClass = (v: unknown) => typeof v === "function" && /^class[\s{]/.test(Function.prototype.toString.call(v));

describe("§2.2 (a): sources/mail.ts refuses a foreign account, thread or message", () => {
  it("every function export is classified: a foreign-id row, a pin-scoped row or no id at all (a new export with no row fails)", () => {
    const fns = Object.entries(mail).filter(([, v]) => typeof v === "function" && !isClass(v)).map(([k]) => k).sort();
    const classified = new Set([...Object.keys(FOREIGN_ROWS), ...Object.keys(PIN_SCOPED), ...NO_ID]);
    expect(fns.filter((n) => !classified.has(n)), "unclassified exports").toEqual([]);
    expect([...classified].filter((n) => !fns.includes(n)), "rows for exports that no longer exist").toEqual([]);
  });

  it.each(Object.keys(FOREIGN_ROWS))("%s: a foreign id is a MailScopeError before any clone call", async (name) => {
    await expect(FOREIGN_ROWS[name]()).rejects.toBeInstanceOf(MailScopeError);
    expect(fake.requests).toHaveLength(0);
  });

  it.each(Object.keys(PIN_SCOPED))("%s: with no pinned mailbox it refuses before any read", async (name) => {
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no read may happen");
    });
    await expect(PIN_SCOPED[name]()).rejects.toBeInstanceOf(MailScopeError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("§2.2 (b): page and chat leave out the same rows of a mailbox no longer pinned", () => {
  const B = "acc_new_pin";
  const rows = [
    { threadId: "th_a", accountId: "acc_old_pin" },
    { threadId: "th_b", accountId: B },
    { threadId: "th_c", accountId: "" }
  ];
  it("pinnedRows / pinnedRowMap (the pages' filter) keep exactly the pinned mailbox's rows", () => {
    const p = mint([B]);
    expect(pinnedRows(p, rows).map((r) => r.threadId)).toEqual(["th_b"]);
    expect([...pinnedRowMap(p, new Map(rows.map((r) => [r.threadId, r]))).keys()]).toEqual(["th_b"]);
  });

  it("every page surface and the chat memo filter stored rows by the pin (source scan: the rule can't be skipped silently)", () => {
    const src = (f: string) => readFileSync(path.join(process.cwd(), "src/lib/exec", f), "utf8");
    for (const [file, call] of [["overview.ts", "pinnedRows("], ["overview.ts", "pinnedRowMap("], ["email-view.ts", "pinnedRows(principal"], ["email-view.ts", "pinnedRowMap(principal"],
      ["attention-read.ts", "pinnedRowMap("], ["projects-view.ts", "isPinnedAccount"]] as const) {
      expect(src(file).includes(call), `${file} ${call}`).toBe(true);
    }
    const tools = src("agent/tools.ts");
    expect(tools).toMatch(/listBucketRows\(principal, now, \{ signal \}\)\)\.filter\(\(r\) => isPinnedAccount\(principal, r\.accountId\)\)/);
    expect(tools).toMatch(/if \(row && !isPinnedAccount\(ctx\.principal, row\.accountId\)\) continue;/);
    expect(tools).toMatch(/if \(stored !== null && !isPinnedAccount\(ctx\.principal, stored\.accountId\)\) return \{ \.\.\.UNAVAILABLE_THREAD \};/);
    expect(src("drafts.ts")).toMatch(/if \(!isPinnedAccount\(principal, r\.accountId\)\) continue;/);
  });
});

// ---------------------------------------------------------------------------
// (b) recipient suggestions, through the real drafts.ts suggestion builder (F7)
// ---------------------------------------------------------------------------

describe("§2.2 (b): recipient suggestions come only from the pinned mailbox's correspondents (F7)", () => {
  it("a correspondent of a row on a mailbox no longer pinned is never suggested (nor allowed for a new draft)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/exec/email-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/email-store")>()), listCorrespondentRows: vi.fn(async () => [
      { threadId: "t_old", accountId: "acc_old_pin", state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: null, correspondents: ["old.contact@legacy.example"] },
      { threadId: "t_new", accountId: HIS, state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: null, correspondents: ["pat@partner.example"] }
    ]) }));
    vi.doMock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn(async () => []), listClientMatchSignals: vi.fn(async () => []) }));
    vi.doMock("@/lib/exec/sources/mail", async (orig) => ({
      ...(await orig<typeof import("@/lib/exec/sources/mail")>()),
      loadScreeningPolicy: vi.fn(async () => ({ rules: [], hash: (await orig<typeof import("@/lib/exec/sources/mail")>()).restrictedPolicyHash("hidden", []) }))
    }));
    vi.doMock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn(async () => ({ draftsSchemaReady: true, draftsEnabled: true, emailEnabled: true, emailSchemaReady: true })) }));
    const { recipientSuggestions } = await import("@/lib/exec/drafts");
    const list = await recipientSuggestions(principal);
    const addresses = list.map((s) => s.address);
    expect(addresses).toContain("pat@partner.example");
    expect(addresses).not.toContain("old.contact@legacy.example");
    vi.doUnmock("@/lib/exec/email-store");
    vi.doUnmock("@/lib/exec/sources/dd");
    vi.doUnmock("@/lib/exec/sources/mail");
    vi.doUnmock("@/lib/exec/principal");
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// (c) the mail-hook bus and (d) the EA token's accounts
// ---------------------------------------------------------------------------

describe("§2.2 (c): a bus event from a foreign account is dropped", () => {
  let db: FakePipelineDb;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
    process.env.EXEC_ENABLED = "true";
    __resetMailHookForTests();
    __resetJobsForTests();
    const tables: Record<string, Row[]> = {
      exec_sync_state: [], exec_principals: [{ id: "ep_1", user_id: "u_ep_1", enabled: true, mail_account_ids: [HIS], slack_team_id: null, slack_user_id: null }],
      exec_settings: [{ principal_id: "ep_1", email_enabled: true }]
    };
    db = createFakePipelineDb({ pg: { tables } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  });
  afterEach(() => {
    __resetMailHookForTests();
  });

  it("message:new on his mailbox becomes a triage job; on a foreign mailbox it is dropped with nothing queued", async () => {
    ensureMailHook();
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    };
    publish({ event: "message:new", account_id: FOREIGN, thread_id: "th_x", message_id: "m_foreign", ts: Date.now() });
    await settle();
    expect(db.jobsOf(EMAIL_TRIAGE_JOB_KIND)).toHaveLength(0);
    publish({ event: "message:new", account_id: HIS, thread_id: "th_1", message_id: "m_his", ts: Date.now() });
    await settle();
    expect(db.jobsOf(EMAIL_TRIAGE_JOB_KIND)).toHaveLength(1);
    expect(JSON.stringify(db.jobsOf(EMAIL_TRIAGE_JOB_KIND))).not.toContain(FOREIGN);
  });
});

describe("§2.2 (d): an EA token whose accounts differ from the pin turns drafting off", () => {
  it("getEaReadiness answers wrong_accounts (the draft gates then refuse to draft or send)", async () => {
    const me = (accounts: string[]) => ({ status: 200, body: { user: { id: "u" }, auth: { kind: "scoped", scopes: ["draft", "read"], accounts, jti: "jti_0123456789abcdef", expiresAt: null, sendEnabled: true } } });
    for (const accounts of [[FOREIGN], [HIS, FOREIGN], []]) {
      mail.invalidateEaReadiness();
      fake.answer("auth_me", me(accounts));
      const verdict = await mail.getEaReadiness(principal);
      expect([verdict.ok, verdict.reason], JSON.stringify(accounts)).toEqual([false, "wrong_accounts"]);
    }
    mail.invalidateEaReadiness();
    fake.answer("auth_me", me([HIS]));
    expect((await mail.getEaReadiness(principal)).ok).toBe(true);
  });
});
