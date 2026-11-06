import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sync-state", () => ({ putSyncState: vi.fn(async () => undefined) }));

import { principalFromRows } from "@/lib/exec/principal";
import { SEND_TIMEOUT_MS, sendSavedDraft, sendTokenReadiness } from "@/lib/exec/send";
import { putSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { cl2Error, installFakeCl2, installFakeClone, type FakeCl2 } from "./__tests__/fake-clone";

// The send path (contract §3.4, §5.3 SD01-SD09) against the CL2 fake: the
// offline token checks, exactly one fetch per call, the body and header, the
// 150 s timeout, the outcome mapping and the persisted verdict.

function mint(accounts: string[]): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const HIS = "acc_his";
const principal = mint([HIS]);
const HASH = "f".repeat(64);
const KEY = "ed_0123456789abcdef0123456789abcdef:v3:send:n0nce1234567890ab";
const GRAPH_ID = "AAMkAGraphId=";
const JTI = "jti_0123456789abcdef";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const FUTURE_EXP = 2_000_000_000;

function jwt(claims: Record<string, unknown>, payload?: string): string {
  return `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${payload ?? b64(JSON.stringify(claims))}.c2lnbmF0dXJl`;
}
const sendClaims = (over: Record<string, unknown> = {}) => ({ id: "u_ea", workspace_id: "w1", scope: ["send"], accounts: [HIS], jti: JTI, exp: FUTURE_EXP, ...over });
const SEND_TOKEN = jwt(sendClaims());

const input = { accountId: HIS, graphId: GRAPH_ID, confirmHash: HASH, idempotencyKey: KEY };
const ENV = { ...process.env };
let fake: FakeCl2;

beforeEach(() => {
  fake = installFakeCl2(vi.stubGlobal, { sendToken: SEND_TOKEN, draftToken: "draft-token", accounts: [HIS] });
  process.env.MISSIVE_EA_SEND_TOKEN = SEND_TOKEN;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

describe("SD01 sendTokenReadiness", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");
  const reasonFor = (token: string | undefined) => {
    if (token === undefined) delete process.env.MISSIVE_EA_SEND_TOKEN;
    else process.env.MISSIVE_EA_SEND_TOKEN = token;
    return sendTokenReadiness(principal, now);
  };

  it("ok: scope send, the pinned accounts, a future exp and a well-formed jti", () => {
    const verdict = reasonFor(SEND_TOKEN);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.expiresAt).toBe(new Date(FUTURE_EXP * 1000).toISOString());
    expect(verdict.checkedAt).toBe(now.toISOString());
    expect(verdict.tokenFp).toMatch(/^[0-9a-f]{12}$/);
  });

  it.each<[string, string | undefined]>([
    ["token_missing", undefined],
    ["token_missing", "   "],
    ["malformed", "not-a-jwt"],
    ["malformed", "a.b"],
    ["malformed", jwt({}, b64("[1,2]"))],
    ["malformed", jwt({}, "!!!")],
    ["not_scoped", jwt({ id: "u", workspace_id: "w", accounts: [HIS], jti: JTI, exp: FUTURE_EXP })],
    ["wrong_scopes", jwt(sendClaims({ scope: ["draft", "read"] }))],
    ["wrong_scopes", jwt(sendClaims({ scope: ["send", "read"] }))],
    ["wrong_scopes", jwt(sendClaims({ scope: "send" }))],
    ["wrong_scopes", jwt(sendClaims({ scope: [] }))],
    ["wrong_accounts", jwt(sendClaims({ accounts: ["acc_other"] }))],
    ["wrong_accounts", jwt(sendClaims({ accounts: [] }))],
    ["wrong_accounts", jwt(sendClaims({ accounts: [HIS, "acc_2"] }))],
    ["wrong_accounts", jwt(sendClaims({ accounts: "acc_his" }))],
    ["token_expired", jwt(sendClaims({ exp: 1_700_000_000 }))],
    ["token_expired", jwt(sendClaims({ exp: Math.floor(now.getTime() / 1000) }))],
    ["malformed", jwt(sendClaims({ exp: "later" }))],
    ["malformed", jwt(sendClaims({ jti: "short" }))],
    ["malformed", jwt(sendClaims({ jti: "has spaces in it ok" }))]
  ])("%s", (reason, token) => {
    const verdict = reasonFor(token);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  it("the order is the contract's: scope before accounts before expiry", () => {
    expect(reasonFor(jwt(sendClaims({ scope: ["draft"], accounts: ["x"], exp: 1 }))).reason).toBe("wrong_scopes");
    expect(reasonFor(jwt(sendClaims({ accounts: ["x"], exp: 1 }))).reason).toBe("wrong_accounts");
  });
});

describe("SD02 exactly one fetch per call, no retry", () => {
  it.each([
    ["202", () => fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: "id@x" } }), "accepted"],
    ["4xx", () => fake.answer("send", cl2Error(409, "changed", { draftStatus: "saved" })), "changed"],
    ["5xx", () => fake.answer("send", cl2Error(500, "server_error")), "server_error"],
    ["edge 5xx", () => fake.answer("send", new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })), "edge"]
  ])("%s", async (_name, arrange, expected) => {
    arrange();
    const outcome = await sendSavedDraft(principal, input);
    expect(outcome.kind === "accepted" ? "accepted" : outcome.error.kind).toBe(expected);
    expect(fake.of("send")).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });

  it("transport: a rejected fetch is one call and kind transport", async () => {
    installFakeClone(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    }, vi.stubGlobal);
    const outcome = await sendSavedDraft(principal, input);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect([outcome.error.kind, outcome.error.status]).toEqual(["transport", null]);
  });

  it("timeout: the hung fetch is one call and kind timeout", async () => {
    vi.useFakeTimers();
    fake.dropResponse.add("send");
    const pending = sendSavedDraft(principal, input);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error.kind).toBe("timeout");
    expect(fake.of("send")).toHaveLength(1);
  });
});

describe("SD03 the body and the header", () => {
  it("Idempotency-Key equals the body's idempotencyKey; the body's keys are exactly confirmHash, idempotencyKey", async () => {
    fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: null } });
    await sendSavedDraft(principal, input);
    const req = fake.of("send")[0];
    expect(req.headers["idempotency-key"]).toBe(KEY);
    expect(req.headers.authorization).toBe(`Bearer ${SEND_TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.path).toBe("/api/outlook-drafts/AAMkAGraphId%3D/send");
    expect(req.method).toBe("POST");
    expect(Object.keys(req.json as object)).toEqual(["confirmHash", "idempotencyKey"]);
    expect(req.json).toEqual({ confirmHash: HASH, idempotencyKey: KEY });
    expect(req.body).toBe(JSON.stringify({ confirmHash: HASH, idempotencyKey: KEY }));
  });
});

describe("SD04 refused before any fetch", () => {
  it("the token not ready", async () => {
    delete process.env.MISSIVE_EA_SEND_TOKEN;
    await expect(sendSavedDraft(principal, input)).rejects.toBeInstanceOf(NonRetryableError);
    process.env.MISSIVE_EA_SEND_TOKEN = jwt(sendClaims({ scope: ["draft", "read"] }));
    await expect(sendSavedDraft(principal, input)).rejects.toThrow(/wrong_scopes/);
    expect(fake.requests).toHaveLength(0);
  });

  it("a foreign account, a bad hash, a bad key, a bad graph id", async () => {
    await expect(sendSavedDraft(principal, { ...input, accountId: "acc_other" })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(sendSavedDraft(principal, { ...input, confirmHash: "abc" })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(sendSavedDraft(principal, { ...input, confirmHash: "F".repeat(64) })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(sendSavedDraft(principal, { ...input, idempotencyKey: "bad key" })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(sendSavedDraft(principal, { ...input, graphId: "bad id!" })).rejects.toBeInstanceOf(NonRetryableError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("SD05 the 150 s timeout", () => {
  it("is not reached a millisecond early and maps to kind timeout", async () => {
    vi.useFakeTimers();
    fake.dropResponse.add("send");
    let settled = false;
    const pending = sendSavedDraft(principal, input).then((o) => {
      settled = true;
      return o;
    });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    expect(settled).toBe(true);
    expect(outcome.kind === "error" && outcome.error.kind).toBe("timeout");
    expect(SEND_TIMEOUT_MS).toBe(150_000);
  });
});

describe("SD06 outcomes", () => {
  it("202 is accepted with the internetMessageId; a replayed 202 says so", async () => {
    fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: "MW4PR@outlook.com" } });
    expect(await sendSavedDraft(principal, input)).toEqual({ kind: "accepted", internetMessageId: "MW4PR@outlook.com", replay: false });
    // The same key again: the fake's key store replays the stored 202 with Idempotent-Replay.
    expect(await sendSavedDraft(principal, input)).toEqual({ kind: "accepted", internetMessageId: "MW4PR@outlook.com", replay: true });
    expect(fake.of("send")).toHaveLength(2);
  });

  it("a non-202 answer comes back with the error's fields", async () => {
    fake.answer("send", cl2Error(409, "changed", { draftStatus: "saved" }));
    const outcome = await sendSavedDraft(principal, input);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect([outcome.error.kind, outcome.error.status, outcome.error.draftStatus, outcome.error.errorClass, outcome.error.replay]).toEqual([
      "changed", 409, "saved", "fatal", false
    ]);
    fake.answer("send", cl2Error(403, "forbidden_scope", { detail: "send_disabled" }));
    const disabled = await sendSavedDraft(principal, { ...input, idempotencyKey: `${KEY}2` });
    expect(disabled.kind === "error" && disabled.error.kind).toBe("send_disabled");
    fake.answer("send", cl2Error(504, "graph_timeout", { draftStatus: "unknown" }));
    const unknown = await sendSavedDraft(principal, { ...input, idempotencyKey: `${KEY}3` });
    expect(unknown.kind === "error" && [unknown.error.kind, unknown.error.draftStatus]).toEqual(["graph_timeout", "unknown"]);
  });

  it("the fake refuses the draft token on /send with 403, which maps to auth", async () => {
    process.env.MISSIVE_EA_SEND_TOKEN = jwt(sendClaims());
    fake = installFakeCl2(vi.stubGlobal, { sendToken: "another-send-token", draftToken: process.env.MISSIVE_EA_SEND_TOKEN, accounts: [HIS] });
    const outcome = await sendSavedDraft(principal, input);
    expect(outcome.kind === "error" && [outcome.error.kind, outcome.error.status]).toEqual(["auth", 403]);
  });
});

describe("SD07 the persisted verdict", () => {
  it("holds codes, times and a fingerprint, never the token or a claim", () => {
    sendTokenReadiness(principal);
    expect(putSyncState).toHaveBeenCalledTimes(1);
    const [p, source, key, value] = vi.mocked(putSyncState).mock.calls[0];
    expect([p.id, source, key]).toEqual([principal.id, "clone-ea", "send-token"]);
    expect(Object.keys(value as object).sort()).toEqual(["checkedAt", "expiresAt", "ok", "reason", "tokenFp"]);
    const text = JSON.stringify(value);
    expect(text).not.toContain(SEND_TOKEN);
    expect(text).not.toContain(JTI);
    expect(text).not.toContain("acc_his");
    expect((value as { tokenFp: string }).tokenFp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a failed write is logged and never fails the check or the send", async () => {
    vi.mocked(putSyncState).mockRejectedValueOnce(new Error("db down"));
    expect(sendTokenReadiness(principal).ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("send-token"))).toBe(true);
    vi.mocked(putSyncState).mockRejectedValueOnce(new Error("db down"));
    fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: null } });
    expect((await sendSavedDraft(principal, input)).kind).toBe("accepted");
  });
});

describe("SD08 the token is read per call", () => {
  it("changing the env between calls changes the bearer", async () => {
    const tokenB = jwt(sendClaims({ jti: "jti_fedcba9876543210" }));
    fake = installFakeCl2(vi.stubGlobal, { accounts: [HIS] });
    fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: null } });
    fake.answer("send", { status: 202, body: { graphId: GRAPH_ID, status: "sent_pending_verification", internetMessageId: null } });
    await sendSavedDraft(principal, input);
    process.env.MISSIVE_EA_SEND_TOKEN = tokenB;
    await sendSavedDraft(principal, { ...input, idempotencyKey: `${KEY}b` });
    expect(fake.of("send").map((r) => r.headers.authorization)).toEqual([`Bearer ${SEND_TOKEN}`, `Bearer ${tokenB}`]);
    const fps = vi.mocked(putSyncState).mock.calls.map((c) => (c[3] as { tokenFp: string }).tokenFp);
    expect(new Set(fps).size).toBe(2);
  });
});

describe("SD09 a 2xx whose body doesn't parse", () => {
  it.each([
    ["a 200 with {}", { status: 200, body: {} }],
    ["a 202 with a bad graphId", { status: 202, body: { graphId: "bad id!", status: "sent_pending_verification", internetMessageId: null } }],
    ["a 202 with another status", { status: 202, body: { graphId: GRAPH_ID, status: "sent", internetMessageId: null } }]
  ])("%s is an error of kind invalid_body after exactly one fetch", async (_name, answer) => {
    fake.answer("send", answer);
    const outcome = await sendSavedDraft(principal, input);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect([outcome.error.kind, outcome.error.status, outcome.error.errorClass]).toEqual(["invalid_body", answer.status, "retryable"]);
    expect(fake.of("send")).toHaveLength(1);
  });
});
