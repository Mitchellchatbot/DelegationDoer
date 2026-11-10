import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/drafts-store", () => ({ listDraftArtifacts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  countEnabledMailPinnedPrincipals: vi.fn(async () => 1)
}));
vi.mock("@/lib/exec/sync-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn(async () => null),
  putSyncState: vi.fn(async () => undefined)
}));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CloneEaError } from "@/lib/exec/clone-ea-types";
import { listDraftArtifacts } from "@/lib/exec/drafts-store";
import type { EaReadinessReason } from "@/lib/exec/drafts-types";
import { notifyOps } from "@/lib/exec/ops";
import { countEnabledMailPinnedPrincipals, principalFromRows } from "@/lib/exec/principal";
import {
  createNewDraft,
  createReplyDraft,
  deleteOutlookDraft,
  eaTokenConfigured,
  EaUnavailableError,
  findSentCopy,
  getEaReadiness,
  getOutlookDraft,
  invalidateEaReadiness,
  listAllReplyArtifacts,
  listPrincipalMessagesFeed,
  listReplyArtifacts,
  MailScopeError,
  overlayAnswered,
  peekEaReadiness,
  readPrincipalThread,
  recreateOutlookDraft,
  type NewDraftInput,
  type RecreateInput,
  type ReplyDraftInput
} from "@/lib/exec/sources/mail";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { __resetMessagesFeedProbeForTests } from "@/lib/missive-client";
import { cl2Error, expressNotFound, installFakeCl2, readBackFixture, type Cl2Request, type FakeCl2 } from "../__tests__/fake-clone";
import { createFakePostgrest } from "../__tests__/fake-postgrest";

// The P4 half of sources/mail.ts against the CL2 fake: the draft functions'
// order of checks and bodies, the EA readiness check and its cache, the
// persisted verdict, findSentCopy, the feed's direction, the overlay and the
// artifact merge. Contract §3.3, §3.14 X2, §5.3 MA01-MA12, §5.9 PX01-PX02.

function mint(accounts: string[], id = "ep_owner"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const HIS = "acc_his";
const principal = mint([HIS]);
const JTI = "jti_0123456789abcdef";
const FUTURE_EXP = 2_000_000_000;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify(claims))}.c2ln`;
const draftClaims = (over: Record<string, unknown> = {}) => ({ id: "u_ea", workspace_id: "w1", scope: ["read", "draft"], accounts: [HIS], jti: JTI, exp: FUTURE_EXP, ...over });
const DRAFT_TOKEN = jwt(draftClaims());
const KEY = "ed_0123456789abcdef0123456789abcdef:v1:save:n0nce1234567890ab";
const GRAPH_ID = "AAMkAGraphId=";
const HASH = "b".repeat(64);
const T0 = 1_762_250_000_000;
const at = (minutes: number) => String(T0 + minutes * 60_000);

const replyInput: ReplyDraftInput = {
  threadId: "t1",
  parentMessageId: "m_in",
  accountId: HIS,
  to: [{ address: "client@acme.io", name: "Client" }],
  cc: [{ address: "cc@acme.io", name: null }],
  bodyHtml: "<p>hi</p>",
  timezone: "America/New_York",
  idempotencyKey: KEY
};
const newInput: NewDraftInput = {
  accountId: HIS,
  to: [{ address: "a@x.io", name: "" }],
  cc: [],
  bcc: [{ address: "b@x.io", name: "B" }],
  subject: "Hello",
  bodyHtml: "<p>new</p>",
  timezone: "UTC",
  idempotencyKey: KEY
};
const recreateReply: RecreateInput = {
  accountId: HIS,
  graphId: GRAPH_ID,
  kind: "reply",
  to: [{ address: "client@acme.io", name: "Client" }],
  cc: [],
  bcc: [{ address: "never@x.io", name: null }],
  subject: "ignored on a reply",
  bodyHtml: "<p>v2</p>",
  timezone: "America/New_York",
  ifContentHash: HASH,
  idempotencyKey: KEY
};

const ENV = { ...process.env };
let fake: FakeCl2;
const okReadBack = (over = {}) => ({ status: 201, body: readBackFixture({ accountId: HIS, ...over }) });

beforeEach(() => {
  invalidateEaReadiness();
  __resetMessagesFeedProbeForTests();
  fake = installFakeCl2(vi.stubGlobal, { draftToken: DRAFT_TOKEN, sendToken: "send-token", accounts: [HIS] });
  process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
  vi.mocked(countEnabledMailPinnedPrincipals).mockResolvedValue(1);
  vi.mocked(listDraftArtifacts).mockResolvedValue(new Map());
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.mocked(putSyncState).mockResolvedValue(undefined);
  vi.mocked(notifyOps).mockResolvedValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

const draftCalls = {
  createReplyDraft: () => createReplyDraft(principal, replyInput),
  createNewDraft: () => createNewDraft(principal, newInput),
  getOutlookDraft: () => getOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID }),
  recreateOutlookDraft: () => recreateOutlookDraft(principal, recreateReply),
  deleteOutlookDraft: () => deleteOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID, ifContentHash: null, idempotencyKey: KEY })
};
const foreign = {
  createReplyDraft: () => createReplyDraft(principal, { ...replyInput, accountId: "acc_other" }),
  createNewDraft: () => createNewDraft(principal, { ...newInput, accountId: "acc_other" }),
  getOutlookDraft: () => getOutlookDraft(principal, { accountId: "acc_other", graphId: GRAPH_ID }),
  recreateOutlookDraft: () => recreateOutlookDraft(principal, { ...recreateReply, accountId: "acc_other" }),
  deleteOutlookDraft: () => deleteOutlookDraft(principal, { accountId: "acc_other", graphId: GRAPH_ID, ifContentHash: null, idempotencyKey: KEY }),
  findSentCopy: () => findSentCopy(principal, { accountId: "acc_other", internetMessageId: "x@y", threadId: null, sinceMs: T0 })
};

describe("MA01 a foreign account", () => {
  it.each(Object.keys(foreign))("%s is a MailScopeError before any fetch", async (name) => {
    await expect(foreign[name as keyof typeof foreign]()).rejects.toBeInstanceOf(MailScopeError);
    expect(fake.requests).toHaveLength(0);
  });

  it("an empty pin refuses too", async () => {
    await expect(createReplyDraft(mint([]), replyInput)).rejects.toBeInstanceOf(MailScopeError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("MA02 readiness not ok", () => {
  it.each(Object.keys(draftCalls))("%s throws EaUnavailableError and makes no draft call", async (name) => {
    fake.answer("status", { status: 200, body: { cl2: { ready: false, send: "off" } } });
    const call = draftCalls[name as keyof typeof draftCalls];
    let caught: unknown;
    try {
      await call();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EaUnavailableError);
    expect((caught as EaUnavailableError).reason).toBe("cl2_not_ready");
    expect((caught as EaUnavailableError).errorClass).toBe("fatal");
    expect(fake.requests.map((r) => r.route)).toEqual(["status"]);
  });
});

describe("MA03 no fallback to the legacy token", () => {
  it("MISSIVE_EA_TOKEN unset while MISSIVE_API_TOKEN is set is token_missing, with no fetch", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    expect(process.env.MISSIVE_API_TOKEN).toBeTruthy();
    const verdict = await getEaReadiness(principal);
    expect([verdict.ok, verdict.reason, verdict.tokenFp]).toEqual([false, "token_missing", null]);
    await expect(createReplyDraft(principal, replyInput)).rejects.toMatchObject({ reason: "token_missing" });
    expect(fake.requests).toHaveLength(0);
    process.env.MISSIVE_EA_TOKEN = "   ";
    expect((await getEaReadiness(principal)).reason).toBe("token_missing");
  });
});

describe("MA04 request bodies", () => {
  it("createReplyDraft: { parentMessageId, to, cc, bodyHtml, timezone }, names omitted when null, never accountId/bcc/subject", async () => {
    fake.answer("create_reply", okReadBack());
    const result = await createReplyDraft(principal, replyInput);
    const req = fake.of("create_reply")[0];
    expect(req.path).toBe("/api/threads/t1/outlook-draft");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe(`Bearer ${DRAFT_TOKEN}`);
    expect(req.headers["idempotency-key"]).toBe(KEY);
    expect(Object.keys(req.json as object)).toEqual(["parentMessageId", "to", "cc", "bodyHtml", "timezone"]);
    expect(req.json).toEqual({
      parentMessageId: "m_in",
      to: [{ address: "client@acme.io", name: "Client" }],
      cc: [{ address: "cc@acme.io" }],
      bodyHtml: "<p>hi</p>",
      timezone: "America/New_York"
    });
    expect(result.replay).toBe(false);
    expect(result.readBack.graphId).toBe("AAMkAGraphId=");
    expect(fake.requests.map((r) => r.route)).toEqual(["status", "auth_me", "create_reply"]);
  });

  it("createNewDraft: { accountId, to, cc, bcc, subject, bodyHtml, timezone }, an empty name omitted", async () => {
    fake.answer("create_new", okReadBack({ kind: "new", threadId: null, parentMessageId: null }));
    await createNewDraft(principal, newInput);
    const req = fake.of("create_new")[0];
    expect(req.path).toBe("/api/compose/outlook-draft");
    expect(req.json).toEqual({
      accountId: HIS,
      to: [{ address: "a@x.io" }],
      cc: [],
      bcc: [{ address: "b@x.io", name: "B" }],
      subject: "Hello",
      bodyHtml: "<p>new</p>",
      timezone: "UTC"
    });
    expect(Object.keys(req.json as object)).toEqual(["accountId", "to", "cc", "bcc", "subject", "bodyHtml", "timezone"]);
  });

  it("recreateOutlookDraft: a reply sends { to, cc, bodyHtml, timezone, ifContentHash }; a new draft adds bcc and subject; ifContentHash absent when null", async () => {
    fake.answer("recreate", { status: 200, body: readBackFixture({ accountId: HIS, replaces: GRAPH_ID, graphId: "AAMkNew=" }) });
    const result = await recreateOutlookDraft(principal, recreateReply);
    const reply = fake.of("recreate")[0];
    expect(reply.method).toBe("PATCH");
    expect(reply.path).toBe("/api/outlook-drafts/AAMkAGraphId%3D");
    expect(reply.json).toEqual({ to: [{ address: "client@acme.io", name: "Client" }], cc: [], bodyHtml: "<p>v2</p>", timezone: "America/New_York", ifContentHash: HASH });
    expect(result.readBack.replaces).toBe(GRAPH_ID);

    fake.answer("recreate", { status: 200, body: readBackFixture({ accountId: HIS, kind: "new", threadId: null, parentMessageId: null }) });
    await recreateOutlookDraft(principal, {
      ...recreateReply,
      kind: "new",
      subject: "Subject",
      bcc: [{ address: "b@x.io", name: "B" }],
      ifContentHash: null,
      idempotencyKey: `${KEY}2`
    });
    const fresh = fake.of("recreate")[1];
    expect(fresh.json).toEqual({
      to: [{ address: "client@acme.io", name: "Client" }],
      cc: [],
      bcc: [{ address: "b@x.io", name: "B" }],
      subject: "Subject",
      bodyHtml: "<p>v2</p>",
      timezone: "America/New_York"
    });
    expect(Object.keys(fresh.json as object)).not.toContain("ifContentHash");
  });

  it("recreateOutlookDraft refuses a new draft without a subject before any I/O (CL2 would store the 400 under the key)", async () => {
    await expect(recreateOutlookDraft(principal, { ...recreateReply, kind: "new", subject: null })).rejects.toBeInstanceOf(NonRetryableError);
    expect(fake.requests).toHaveLength(0);
  });

  it("deleteOutlookDraft: {} or { ifContentHash }", async () => {
    fake.answer("delete", { status: 200, body: { graphId: GRAPH_ID, status: "deleted" } });
    fake.answer("delete", { status: 200, body: { graphId: GRAPH_ID, status: "deleted" } });
    const plain = await deleteOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID, ifContentHash: null, idempotencyKey: KEY });
    expect(plain).toEqual({ deleted: { graphId: GRAPH_ID, status: "deleted" }, replay: false });
    await deleteOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID, ifContentHash: HASH, idempotencyKey: `${KEY}2` });
    const [a, b] = fake.of("delete");
    expect([a.method, a.json, a.body]).toEqual(["DELETE", {}, "{}"]);
    expect(b.json).toEqual({ ifContentHash: HASH });
  });

  it("getOutlookDraft: a GET with no body, the registry view passes through", async () => {
    fake.answer("get_draft", { status: 200, body: { live: false, graphId: GRAPH_ID, status: "sent", flags: ["unverified"], internetMessageId: "id@x", webLink: null, verifiedAt: null } });
    const read = await getOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID });
    expect(read.live).toBe(false);
    const req = fake.of("get_draft")[0];
    expect([req.method, req.body, req.headers["idempotency-key"], req.headers["content-type"]]).toEqual(["GET", null, undefined, undefined]);
  });

  it("a malformed graph id or thread id is refused before any I/O", async () => {
    await expect(getOutlookDraft(principal, { accountId: HIS, graphId: "bad id!" })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(createReplyDraft(principal, { ...replyInput, threadId: "" })).rejects.toBeInstanceOf(NonRetryableError);
    expect(fake.requests).toHaveLength(0);
  });

  it("a clone error carries through with its fields; a 2xx that doesn't parse is invalid_body with the real status", async () => {
    fake.answer("create_reply", cl2Error(409, "parent_missing"));
    await expect(createReplyDraft(principal, replyInput)).rejects.toMatchObject({ kind: "parent_missing", status: 409, errorClass: "fatal" });
    fake.answer("create_reply", { status: 201, body: { graphId: GRAPH_ID } });
    let caught: unknown;
    try {
      await createReplyDraft(principal, { ...replyInput, idempotencyKey: `${KEY}2` });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloneEaError);
    expect([(caught as CloneEaError).kind, (caught as CloneEaError).status]).toEqual(["invalid_body", 201]);
  });

  it("a replayed answer is reported", async () => {
    fake.answer("create_reply", okReadBack());
    await createReplyDraft(principal, replyInput);
    expect((await createReplyDraft(principal, replyInput)).replay).toBe(true);
  });
});

describe("MA05 getEaReadiness reasons", () => {
  const reasonOf = async (): Promise<EaReadinessReason | null> => (await getEaReadiness(principal)).reason;

  it("no_pin", async () => {
    expect((await getEaReadiness(mint([]))).reason).toBe("no_pin");
    expect(fake.requests).toHaveLength(0);
  });
  it("multiple_principals", async () => {
    vi.mocked(countEnabledMailPinnedPrincipals).mockResolvedValue(2);
    expect(await reasonOf()).toBe("multiple_principals");
    expect(fake.requests).toHaveLength(0);
  });
  it("a failed principal count throws and caches nothing", async () => {
    vi.mocked(countEnabledMailPinnedPrincipals).mockRejectedValueOnce(new Error("db down"));
    await expect(getEaReadiness(principal)).rejects.toThrow("db down");
    expect((await getEaReadiness(principal)).ok).toBe(true);
  });
  it("token_missing, base_url_missing", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    expect(await reasonOf()).toBe("token_missing");
    process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
    delete process.env.MISSIVE_API_URL;
    expect(await reasonOf()).toBe("base_url_missing");
    expect(fake.requests).toHaveLength(0);
  });
  it("not_scoped for a legacy token (no scope key) and for a token that doesn't decode", async () => {
    process.env.MISSIVE_EA_TOKEN = jwt({ id: "u", workspace_id: "w", exp: FUTURE_EXP });
    expect(await reasonOf()).toBe("not_scoped");
    process.env.MISSIVE_EA_TOKEN = "legacy-opaque-token";
    expect(await reasonOf()).toBe("not_scoped");
    expect(fake.requests).toHaveLength(0);
  });
  it("token_expired offline", async () => {
    process.env.MISSIVE_EA_TOKEN = jwt(draftClaims({ exp: 1_700_000_000 }));
    const verdict = await getEaReadiness(principal);
    expect([verdict.reason, verdict.expiresAt]).toEqual(["token_expired", new Date(1_700_000_000_000).toISOString()]);
    expect(fake.requests).toHaveLength(0);
  });
  it("clone_unreachable: transport, a 503 and an unparseable /api/status", async () => {
    fake.answer("status", () => {
      throw new Error("connection refused");
    });
    expect(await reasonOf()).toBe("clone_unreachable");
    invalidateEaReadiness();
    fake.answer("status", cl2Error(503, "not_ready"));
    expect(await reasonOf()).toBe("clone_unreachable");
    invalidateEaReadiness();
    fake.answer("status", { status: 200, body: { cl2: { ready: "yes" } } });
    expect(await reasonOf()).toBe("clone_unreachable");
    expect(fake.of("auth_me")).toHaveLength(0);
  });
  it("cl2_missing, cl2_not_ready", async () => {
    fake.answer("status", { status: 200, body: { ok: true } });
    expect(await reasonOf()).toBe("cl2_missing");
    invalidateEaReadiness();
    fake.answer("status", { status: 200, body: { cl2: { ready: false, send: "all" } } });
    const verdict = await getEaReadiness(principal);
    expect([verdict.reason, verdict.cl2Ready, verdict.cl2Send]).toEqual(["cl2_not_ready", false, "all"]);
    expect(fake.of("auth_me")).toHaveLength(0);
  });
  it.each([401, 403, 404, 500])("me_failed on a %s from /api/auth/me", async (status) => {
    fake.answer("auth_me", cl2Error(status, status === 401 ? "invalid_token" : status === 403 ? "forbidden_scope" : status === 404 ? "not_found" : "server_error"));
    expect(await reasonOf()).toBe("me_failed");
  });
  it("me_no_auth, not_scoped (kind), wrong_scopes, wrong_accounts, token_expired from /me", async () => {
    const me = (auth: Record<string, unknown> | null) => ({ status: 200, body: { user: { id: "u" }, ...(auth === null ? {} : { auth }) } });
    const scoped = (over: Record<string, unknown>) => ({ kind: "scoped", scopes: ["draft", "read"], accounts: [HIS], jti: JTI, expiresAt: null, sendEnabled: true, ...over });
    const cases: [EaReadinessReason, Record<string, unknown> | null][] = [
      ["me_no_auth", null],
      ["not_scoped", scoped({ kind: "legacy" })],
      ["wrong_scopes", scoped({ scopes: ["read"] })],
      ["wrong_scopes", scoped({ scopes: ["draft", "read", "send"] })],
      ["wrong_scopes", scoped({ scopes: ["send"] })],
      ["wrong_accounts", scoped({ accounts: [] })],
      ["wrong_accounts", scoped({ accounts: [HIS, "acc_2"] })],
      ["wrong_accounts", scoped({ accounts: ["acc_2"] })],
      ["token_expired", scoped({ expiresAt: "2020-01-01T00:00:00.000Z" })]
    ];
    for (const [reason, auth] of cases) {
      invalidateEaReadiness();
      fake.answer("auth_me", me(auth));
      expect(await reasonOf()).toBe(reason);
    }
  });
  it("the success fixture: ok with cl2Send and sendEnabled, scopes in any order", async () => {
    fake.answer("status", { status: 200, body: { cl2: { ready: true, send: "some" } } });
    fake.answer("auth_me", { status: 200, body: { auth: { kind: "scoped", scopes: ["read", "draft"], accounts: [HIS], jti: JTI, expiresAt: "2027-11-04T00:00:00.000Z", sendEnabled: true } } });
    const verdict = await getEaReadiness(principal);
    expect(verdict).toMatchObject({ ok: true, reason: null, cl2Ready: true, cl2Send: "some", sendEnabled: true, expiresAt: "2027-11-04T00:00:00.000Z" });
    expect(verdict.tokenFp).toMatch(/^[0-9a-f]{12}$/);
    expect(fake.of("status")[0].headers.authorization).toBeUndefined();
    expect(fake.of("auth_me")[0].headers.authorization).toBe(`Bearer ${DRAFT_TOKEN}`);
    invalidateEaReadiness();
    fake.answer("auth_me", { status: 200, body: { auth: { kind: "scoped", scopes: ["draft", "read"], accounts: [HIS], jti: JTI, expiresAt: null, sendEnabled: false } } });
    const off = await getEaReadiness(principal);
    expect([off.ok, off.sendEnabled, off.expiresAt]).toEqual([true, false, new Date(FUTURE_EXP * 1000).toISOString()]);
  });
});

describe("MA06 the cache", () => {
  it("ok is cached 5 min, a failure 60 s, fresh bypasses, a new token fp misses", async () => {
    vi.useFakeTimers({ now: T0 });
    await getEaReadiness(principal);
    await getEaReadiness(principal);
    expect(fake.of("status")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999);
    await getEaReadiness(principal);
    expect(fake.of("status")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await getEaReadiness(principal);
    expect(fake.of("status")).toHaveLength(2);
    await getEaReadiness(principal, { fresh: true });
    expect(fake.of("status")).toHaveLength(3);

    fake.answer("status", { status: 200, body: { cl2: { ready: false, send: "off" } } });
    expect((await getEaReadiness(principal, { fresh: true })).ok).toBe(false);
    expect(fake.of("status")).toHaveLength(4);
    await getEaReadiness(principal);
    expect(fake.of("status")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await getEaReadiness(principal)).ok).toBe(true);
    expect(fake.of("status")).toHaveLength(5);

    process.env.MISSIVE_EA_TOKEN = jwt(draftClaims({ jti: "jti_fedcba9876543210" }));
    await getEaReadiness(principal);
    expect(fake.of("status")).toHaveLength(6);
    // Another principal has its own entry.
    await getEaReadiness(mint([HIS], "ep_two"));
    expect(fake.of("status")).toHaveLength(7);
  });
});

describe("MA07 the persisted ea-token verdict", () => {
  it("holds no token or jti, and a failed write doesn't fail the check", async () => {
    await getEaReadiness(principal);
    expect(putSyncState).toHaveBeenCalledTimes(1);
    const [p, source, key, value] = vi.mocked(putSyncState).mock.calls[0];
    expect([p.id, source, key]).toEqual([principal.id, "clone-ea", "ea-token"]);
    expect(Object.keys(value as object).sort()).toEqual(["checkedAt", "cl2Ready", "cl2Send", "expiresAt", "ok", "reason", "sendEnabled", "tokenFp"]);
    const text = JSON.stringify(value);
    expect(text).not.toContain(DRAFT_TOKEN);
    expect(text).not.toContain(JTI);
    expect(text).not.toContain("acc_his");
    expect(value).toMatchObject({ ok: true, reason: null, cl2Ready: true, cl2Send: "all", sendEnabled: true });

    vi.mocked(putSyncState).mockRejectedValueOnce(new Error("db down"));
    invalidateEaReadiness();
    fake.answer("status", { status: 200, body: { cl2: { ready: false, send: "off" } } });
    const verdict = await getEaReadiness(principal);
    expect(verdict.reason).toBe("cl2_not_ready");
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("ea-token"))).toBe(true);
    const failed = vi.mocked(putSyncState).mock.calls[1][3] as Record<string, unknown>;
    expect(failed).toMatchObject({ ok: false, reason: "cl2_not_ready", sendEnabled: null });
    // A failure raises the rate-limited ops alert with the reason only.
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual(["clone-ea-readiness:cl2_not_ready"]);
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toContain(DRAFT_TOKEN);
  });

  // P9 F18 (lead decision L1): a process without the EA token must not overwrite the shared verdict another process owns.
  it("P9 F18: a verdict computed without a token writes no ea-token row; it is still cached and alerted; with the token it is written", async () => {
    delete process.env.MISSIVE_EA_TOKEN;
    const verdict = await getEaReadiness(principal);
    expect([verdict.ok, verdict.reason]).toEqual([false, "token_missing"]);
    expect(putSyncState).not.toHaveBeenCalled();
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual(["clone-ea-readiness:token_missing"]);
    // The local cache still holds it (the peek answers it without reading the persisted row).
    vi.mocked(getSyncState).mockClear();
    expect(await peekEaReadiness(principal)).toMatchObject({ ok: false, reason: "token_missing" });
    expect(getSyncState).not.toHaveBeenCalled();
    // A fresh check without the token: still no write. "token === null" covers a blank value too.
    process.env.MISSIVE_EA_TOKEN = "   ";
    await getEaReadiness(principal, { fresh: true });
    expect(putSyncState).not.toHaveBeenCalled();
    // The token back: the verdict is written as before.
    process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
    await getEaReadiness(principal, { fresh: true });
    expect(putSyncState).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putSyncState).mock.calls[0].slice(1, 3)).toEqual(["clone-ea", "ea-token"]);
  });

  it("P9 F18: eaTokenConfigured is whether this process holds the EA token (trimmed), never a network call", () => {
    expect(eaTokenConfigured()).toBe(true);
    process.env.MISSIVE_EA_TOKEN = "  ";
    expect(eaTokenConfigured()).toBe(false);
    delete process.env.MISSIVE_EA_TOKEN;
    expect(eaTokenConfigured()).toBe(false);
    process.env.MISSIVE_EA_TOKEN = "x";
    expect(eaTokenConfigured()).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("MA08 peekEaReadiness", () => {
  it("never fetches: the cache first, then the persisted verdict, else null", async () => {
    expect(await peekEaReadiness(principal)).toBeNull();
    expect(getSyncState).toHaveBeenCalledTimes(1);
    vi.mocked(getSyncState).mockResolvedValueOnce({
      value: { ok: false, reason: "wrong_scopes", checkedAt: "2026-11-05T12:00:00.000Z", cl2Ready: true, cl2Send: "all", sendEnabled: null, expiresAt: null, tokenFp: "0123456789ab" },
      rev: 3
    });
    expect(await peekEaReadiness(principal)).toEqual({
      ok: false,
      reason: "wrong_scopes",
      cl2Ready: true,
      cl2Send: "all",
      sendEnabled: false,
      expiresAt: null,
      checkedAt: "2026-11-05T12:00:00.000Z",
      tokenFp: "0123456789ab"
    });
    expect(fake.requests).toHaveLength(0);
    const live = await getEaReadiness(principal);
    vi.mocked(getSyncState).mockClear();
    expect(await peekEaReadiness(principal)).toEqual(live);
    expect(getSyncState).not.toHaveBeenCalled();
    expect(fake.requests.map((r) => r.route)).toEqual(["status", "auth_me"]);
  });
});

describe("MA08b (P9 fixer correctness-2) peekEaReadiness in a process without the EA token", () => {
  it("answers token_missing (never the stored ok another process wrote), not written, not alerted, no clone call; with the token, the stored verdict", async () => {
    const storedOk = {
      value: { ok: true, reason: null, checkedAt: "2026-11-05T12:00:00.000Z", cl2Ready: true, cl2Send: "all", sendEnabled: true, expiresAt: null, tokenFp: "0123456789ab" },
      rev: 4
    };
    vi.mocked(getSyncState).mockResolvedValue(storedOk as never);
    delete process.env.MISSIVE_EA_TOKEN;
    invalidateEaReadiness();
    expect(await peekEaReadiness(principal)).toMatchObject({ ok: false, reason: "token_missing", cl2Ready: null, sendEnabled: false, tokenFp: null });
    expect(vi.mocked(getSyncState).mock.calls.filter((c) => c[2] === "ea-token")).toEqual([]);
    expect(putSyncState).not.toHaveBeenCalled();
    expect(notifyOps).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
    // The checks before the token's still come first: no pinned account → no_pin.
    expect(await peekEaReadiness(mint([]))).toMatchObject({ ok: false, reason: "no_pin" });
    // The token back: the persisted verdict, as MA08.
    process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
    invalidateEaReadiness();
    expect(await peekEaReadiness(principal)).toMatchObject({ ok: true, reason: null, cl2Send: "all" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("MA09 an auth answer invalidates the cache", () => {
  it("the next call probes the clone again", async () => {
    fake.answer("create_reply", cl2Error(401, "invalid_token"));
    await expect(createReplyDraft(principal, replyInput)).rejects.toMatchObject({ kind: "auth", errorClass: "auth" });
    expect(fake.of("status")).toHaveLength(1);
    fake.answer("create_reply", okReadBack());
    await createReplyDraft(principal, { ...replyInput, idempotencyKey: `${KEY}2` });
    expect(fake.of("status")).toHaveLength(2);
    // A non-auth error keeps the cache.
    fake.answer("create_reply", cl2Error(503, "not_ready"));
    await expect(createReplyDraft(principal, { ...replyInput, idempotencyKey: `${KEY}3` })).rejects.toMatchObject({ kind: "not_ready" });
    fake.answer("create_reply", okReadBack());
    await createReplyDraft(principal, { ...replyInput, idempotencyKey: `${KEY}4` });
    expect(fake.of("status")).toHaveLength(2);
  });
});

// A clone message row as GET /api/threads/:id?defer_bodies=1 sends it (P3's shape).
function cloneMsg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "m_x",
    thread_id: "t1",
    account_id: HIS,
    workspace_id: "w1",
    direction: "inbound",
    folder: "Inbox",
    message_id: null,
    in_reply_to: null,
    subject: "s",
    from_addr: "Client <client@acme.io>",
    to_addrs: "mitchell@scaledai.org",
    cc_addrs: "",
    sent_at: at(0),
    created_at: at(0),
    is_automated: 0,
    has_attachments: 0,
    body_html: null,
    body_text: null,
    body_deferred: true,
    attachments: [],
    ...over
  };
}
const threadDetail = (messages: Record<string, unknown>[]) => ({
  thread: { id: "t1", subject: "s", participants: "client@acme.io; mitchell@scaledai.org", last_message_at: at(90) },
  messages,
  comments: []
});
const feedRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "f1",
  thread_id: "t9",
  account_id: HIS,
  direction: "outbound",
  folder: "Sent Items",
  message_id: null,
  in_reply_to: null,
  from_addr: "mitchell@scaledai.org",
  to_addrs: "a@x.io",
  cc_addrs: null,
  subject: null,
  sent_at: at(1),
  created_at: at(1),
  has_attachments: 0,
  graph_id: null,
  web_link: null,
  is_read: true,
  importance: "normal",
  flag_status: null,
  categories: null,
  parent_folder_id: null,
  inference_classification: null,
  change_key: null,
  removed_at: null,
  removed_reason: null,
  signals_updated_at: null,
  ...over
});

describe("MA10 findSentCopy", () => {
  const serveThread = (messages: Record<string, unknown>[]) =>
    fake.defaultAnswer("other", (req: Cl2Request) => (req.path === "/api/threads/t1" ? { status: 200, body: threadDetail(messages) } : cl2Error(404, "not_found")));

  it("a reply is found through the thread read, brackets and case ignored", async () => {
    serveThread([
      cloneMsg({ id: "m_in", message_id: "<in@acme.io>" }),
      cloneMsg({ id: "m_out", direction: "outbound", folder: "Sent Items", from_addr: "", message_id: "<MW4PR.Sent@Outlook.com>", sent_at: at(5), created_at: at(5), body_deferred: false })
    ]);
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "mw4pr.sent@outlook.com", threadId: "t1", sinceMs: T0 })).toBe("found");
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/threads/t1"]);
    expect(fake.requests[0].url.searchParams.get("defer_bodies")).toBe("1");
    expect(fake.requests[0].headers.authorization).toBe("Bearer clone-test-token");
  });

  it("not found when none of his outbound messages carries the id, or the thread isn't his", async () => {
    serveThread([cloneMsg({ id: "m_in", message_id: "<in@acme.io>" }), cloneMsg({ id: "m_team", account_id: "acc_team", direction: "outbound", message_id: "<x@y>" })]);
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "x@y", threadId: "t1", sinceMs: T0 })).toBe("not_found");
    fake.defaultAnswer("other", cl2Error(404, "not_found"));
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "x@y", threadId: "t1", sinceMs: T0 })).toBe("not_found");
  });

  it("a thread handed in is used instead of a new read; a read error throws", async () => {
    serveThread([cloneMsg({ id: "m_out", direction: "outbound", folder: "Sent Items", message_id: "<x@y>" })]);
    const read = await readPrincipalThread(principal, "t1");
    if (read.kind !== "ok") throw new Error("fixture thread did not read");
    fake.requests.length = 0;
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "<X@Y>", threadId: "t1", sinceMs: T0, thread: read.thread })).toBe("found");
    expect(fake.requests).toHaveLength(0);
    fake.defaultAnswer("other", cl2Error(500, "server_error"));
    await expect(findSentCopy(principal, { accountId: HIS, internetMessageId: "x@y", threadId: "t1", sinceMs: T0 })).rejects.toThrow();
  });

  it("a new draft is found on feed page 2 (direction outbound, since 5 min before the anchor)", async () => {
    fake.defaultAnswer("other", (req: Cl2Request) => {
      if (req.path !== "/api/messages") return cl2Error(404, "not_found");
      const cursor = req.url.searchParams.get("cursor");
      if (cursor === null) return { status: 200, body: { messages: [feedRow({ id: "f1", message_id: "<other@x>" })], next_cursor: "c2", has_more: true, settled_through: at(2) } };
      return { status: 200, body: { messages: [feedRow({ id: "f2", message_id: "<Sent.Copy@outlook.com>" })], next_cursor: "c3", has_more: false, settled_through: at(2) } };
    });
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "sent.copy@outlook.com", threadId: null, sinceMs: T0 })).toBe("found");
    const [p1, p2] = fake.requests;
    expect(p1.url.searchParams.get("direction")).toBe("outbound");
    expect(p1.url.searchParams.get("order")).toBe("created");
    expect(p1.url.searchParams.get("account_id")).toBe(HIS);
    expect(p1.url.searchParams.get("since")).toBe(new Date(T0 - 300_000).toISOString());
    expect(p1.url.searchParams.get("limit")).toBe("200");
    expect(p2.url.searchParams.get("cursor")).toBe("c2");
    expect(p2.url.searchParams.get("since")).toBeNull();
  });

  it("not found after five pages; a pre-CL1 feed is unsupported", async () => {
    let pages = 0;
    fake.defaultAnswer("other", () => {
      pages += 1;
      return { status: 200, body: { messages: [feedRow({ id: `f${pages}`, message_id: `<p${pages}@x>` })], next_cursor: `c${pages + 1}`, has_more: true, settled_through: at(2) } };
    });
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "never@x", threadId: null, sinceMs: T0 })).toBe("not_found");
    expect(pages).toBe(5);
    fake.defaultAnswer("other", (req: Cl2Request) => expressNotFound(req.path));
    __resetMessagesFeedProbeForTests();
    expect(await findSentCopy(principal, { accountId: HIS, internetMessageId: "never@x", threadId: null, sinceMs: T0 })).toBe("unsupported");
  });

  it("an empty id is refused", async () => {
    await expect(findSentCopy(principal, { accountId: HIS, internetMessageId: " <> ", threadId: null, sinceMs: T0 })).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("MA11 listPrincipalMessagesFeed direction", () => {
  it("passes direction through and omits it when absent", async () => {
    fake.defaultAnswer("other", { status: 200, body: { messages: [], next_cursor: "c1", has_more: false, settled_through: at(0) } });
    await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: new Date(T0).toISOString(), limit: 50, direction: "outbound" });
    await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: new Date(T0).toISOString(), limit: 50 });
    await listPrincipalMessagesFeed(principal, HIS, { order: "changed", cursor: "c9", sinceIso: null, limit: 50, direction: "inbound" });
    const params = fake.requests.map((r) => r.url.searchParams.get("direction"));
    expect(params).toEqual(["outbound", null, "inbound"]);
    await expect(
      listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: null, limit: 50, direction: "sideways" as "inbound" })
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("MA12 a read-back for another account", () => {
  it("is a MailScopeError from every function that returns one", async () => {
    fake.answer("create_reply", okReadBack({ accountId: "acc_other" }));
    await expect(createReplyDraft(principal, replyInput)).rejects.toBeInstanceOf(MailScopeError);
    fake.answer("create_new", okReadBack({ accountId: "acc_other", kind: "new" }));
    await expect(createNewDraft(principal, newInput)).rejects.toBeInstanceOf(MailScopeError);
    fake.answer("recreate", okReadBack({ accountId: "acc_other" }));
    await expect(recreateOutlookDraft(principal, recreateReply)).rejects.toBeInstanceOf(MailScopeError);
    fake.answer("get_draft", okReadBack({ accountId: "acc_other" }));
    await expect(getOutlookDraft(principal, { accountId: HIS, graphId: GRAPH_ID })).rejects.toBeInstanceOf(MailScopeError);
  });
});

describe("PX01 overlayAnswered", () => {
  const row = { answeredState: "awaiting_reply" as const, newestInboundMessageId: "m1" };
  const legacy = { scheduledFor: null, draftPending: false };

  it("reply_sent_pending only when execSentParents holds the row's newest inbound id", () => {
    expect(overlayAnswered(row, undefined, { ...legacy, execSentParents: ["m1"] })).toBe("reply_sent_pending");
    expect(overlayAnswered(row, undefined, { ...legacy, execSentParents: ["m0"] })).toBe("awaiting_reply");
    expect(overlayAnswered({ ...row, newestInboundMessageId: "m2" }, undefined, { ...legacy, execSentParents: ["m1"] })).toBe("awaiting_reply");
    expect(overlayAnswered({ ...row, newestInboundMessageId: null }, undefined, { ...legacy, execSentParents: ["m1"] })).toBe("awaiting_reply");
    expect(overlayAnswered(row, undefined, { ...legacy, execDraft: { id: "ed_1", status: "saved" } })).toBe("awaiting_reply");
    expect(overlayAnswered(row, undefined, legacy)).toBe("awaiting_reply");
    expect(overlayAnswered(row, undefined, undefined)).toBe("awaiting_reply");
  });

  it("after handled_in_outlook, before reply_scheduled and draft_pending", () => {
    const sent = { ...legacy, execSentParents: ["m1"] };
    expect(overlayAnswered(row, { messageId: "m1", removedAt: "2026-11-05T12:00:00Z" }, sent)).toBe("handled_in_outlook");
    expect(overlayAnswered(row, undefined, { ...sent, scheduledFor: "2026-11-06T12:00:00Z", draftPending: true })).toBe("reply_sent_pending");
    expect(overlayAnswered(row, undefined, { ...legacy, scheduledFor: "2026-11-06T12:00:00Z" })).toBe("reply_scheduled");
    expect(overlayAnswered({ answeredState: "answered", newestInboundMessageId: "m1" }, undefined, sent)).toBe("answered");
    expect(overlayAnswered({ answeredState: null, newestInboundMessageId: "m1" }, undefined, sent)).toBeNull();
  });
});

describe("PX02 the artifact merge", () => {
  beforeEach(() => {
    const db = createFakePostgrest({
      tables: {
        scheduled_emails: [{ id: "se1", thread_id: "t2", scheduled_for: "2026-11-06T09:00:00.000Z", status: "pending", account_id: HIS }],
        email_drafts: [{ id: "dr1", source_thread_id: "t3", status: "pending", dismissed_at: null, account_id: HIS }]
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  });

  it("merges exec artifacts; a thread with only exec artifacts gets the legacy defaults", async () => {
    vi.mocked(listDraftArtifacts).mockResolvedValue(
      new Map([
        ["t1", { execDraft: { id: "ed_1", status: "saved" }, execSentParents: ["m1"] }],
        ["t2", { execDraft: null, execSentParents: ["m7"] }]
      ])
    );
    const signal = new AbortController().signal;
    const out = await listReplyArtifacts(principal, ["t1", "t2", "t3", "t1"], { signal });
    expect(out.get("t1")).toEqual({ scheduledFor: null, draftPending: false, execDraft: { id: "ed_1", status: "saved" }, execSentParents: ["m1"] });
    expect(out.get("t2")).toEqual({ scheduledFor: "2026-11-06T09:00:00.000Z", draftPending: false, execDraft: null, execSentParents: ["m7"] });
    expect(out.get("t3")).toEqual({ scheduledFor: null, draftPending: true });
    expect(vi.mocked(listDraftArtifacts).mock.calls[0][0].id).toBe(principal.id);
    expect(vi.mocked(listDraftArtifacts).mock.calls[0][1]).toEqual(["t1", "t2", "t3"]);
    expect(vi.mocked(listDraftArtifacts).mock.calls[0][2]).toBeInstanceOf(Date);
    expect(vi.mocked(listDraftArtifacts).mock.calls[0][3]).toEqual({ signal });
    const all = await listAllReplyArtifacts(principal);
    expect(all.get("t1")?.execDraft?.id).toBe("ed_1");
    expect(vi.mocked(listDraftArtifacts).mock.calls[1][1]).toBe("all");
  });

  it("the table missing (an empty map) gives legacy-only artifacts without exec fields", async () => {
    const out = await listReplyArtifacts(principal, ["t2", "t3"]);
    expect(out.get("t2")).toEqual({ scheduledFor: "2026-11-06T09:00:00.000Z", draftPending: false });
    expect("execDraft" in (out.get("t2") as object)).toBe(false);
  });

  it("an exec read error fails open: legacy-only output, one log line with the code, no throw (C73)", async () => {
    vi.mocked(listDraftArtifacts).mockRejectedValueOnce(Object.assign(new Error("statement timeout"), { code: "57014" }));
    const out = await listReplyArtifacts(principal, ["t2"]);
    expect(out.get("t2")).toEqual({ scheduledFor: "2026-11-06T09:00:00.000Z", draftPending: false });
    expect(vi.mocked(console.warn).mock.calls.map((c) => c.join(" "))).toEqual(["[exec-drafts] artifacts unavailable 57014"]);
    vi.mocked(listDraftArtifacts).mockRejectedValueOnce(new TypeError("boom"));
    const all = await listAllReplyArtifacts(principal);
    expect(all.get("t3")).toEqual({ scheduledFor: null, draftPending: true });
    expect(vi.mocked(console.warn).mock.calls[1]).toEqual(["[exec-drafts] artifacts unavailable TypeError"]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("statement timeout");
  });
});
