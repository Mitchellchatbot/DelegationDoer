import { describe, expect, it } from "vitest";

import {
  CloneEaError,
  classifyCloneEa,
  decodeTokenClaims,
  isCloneDraftStatus,
  parseCloneAuthMe,
  parseCloneDeleted,
  parseCloneDraftRead,
  parseCloneErrorBody,
  parseCloneReadBack,
  parseCloneSendAccepted,
  parseCloneStatus,
  parseRetryAfterMs,
  type CloneEaErrorKind,
  type CloneEaFailure,
  type CloneEaRoute,
  type CloneErrorBody
} from "@/lib/exec/clone-ea-types";
import type { ErrorClass } from "@/lib/exec/types";
import { readBackFixture } from "./__tests__/fake-clone";

// The §8.5 classifier row by row (CK01-CK24), the parsers (CK25-CK27) and the
// error's message contract (CK28, CK29). Contract §3.2, §5.2.

const body = (over: Partial<CloneErrorBody> & { error: string }): CloneErrorBody => ({
  detail: null,
  draftStatus: null,
  graphStatus: null,
  graphCode: null,
  replacedBy: null,
  ...over
});

type Row = [id: string, route: CloneEaRoute, status: number | null, body: CloneErrorBody | null, failure: CloneEaFailure | undefined, kind: CloneEaErrorKind, errorClass: ErrorClass];

const ROWS: Row[] = [
  ["K01", "send", 401, body({ error: "invalid_token" }), undefined, "auth", "auth"],
  ["K02", "send", 403, body({ error: "forbidden_scope", detail: "send_disabled" }), undefined, "send_disabled", "fatal"],
  ["K03", "send", 403, body({ error: "forbidden_scope", detail: "route not allowed" }), undefined, "auth", "auth"],
  ["K04", "create_reply", 400, body({ error: "bad_request", detail: "not a connected Microsoft mailbox" }), undefined, "mailbox_not_connected", "fatal"],
  ["K05", "create_reply", 400, body({ error: "bad_request", detail: "to" }), undefined, "bad_request", "fatal"],
  ["K06", "get_draft", 404, body({ error: "not_found" }), undefined, "not_found", "fatal"],
  ["K07", "get_draft", 404, body({ error: "gone", draftStatus: "deleted", replacedBy: "AAMkNew=" }), undefined, "gone", "fatal"],
  ["K08", "recreate", 409, body({ error: "changed", draftStatus: "saved" }), undefined, "changed", "fatal"],
  ["K09", "send", 409, body({ error: "already_sending", draftStatus: "sending" }), undefined, "already_sending", "retryable"],
  ["K10", "send", 409, body({ error: "already_sent", draftStatus: "sent" }), undefined, "already_sent", "fatal"],
  ["K11", "delete", 409, body({ error: "sent_externally", draftStatus: "sent_external" }), undefined, "sent_externally", "fatal"],
  ["K12", "create_reply", 409, body({ error: "parent_missing" }), undefined, "parent_missing", "fatal"],
  ["K13", "send", 422, body({ error: "idempotency_mismatch" }), undefined, "idempotency_mismatch", "fatal"],
  ["K14", "send", 429, body({ error: "throttled" }), undefined, "throttled", "retryable"],
  ["K15", "create_new", 502, body({ error: "graph_error", graphCode: "token_refresh_failed:invalid_grant" }), undefined, "mailbox_reconnect", "auth"],
  ["K16", "create_new", 502, body({ error: "graph_error", graphStatus: 503, graphCode: "ErrorServiceUnavailable" }), undefined, "graph_error", "retryable"],
  ["K17", "send", 503, body({ error: "not_ready" }), undefined, "not_ready", "retryable"],
  ["K18", "send", 504, body({ error: "graph_timeout", draftStatus: "unknown" }), undefined, "graph_timeout", "retryable"],
  ["K19", "send", 500, body({ error: "server_error" }), undefined, "server_error", "retryable"],
  ["K20", "send", 502, null, "edge", "edge", "retryable"],
  ["K21 (4xx)", "send", 418, body({ error: "teapot" }), undefined, "unknown_code", "fatal"],
  ["K21 (5xx)", "send", 599, body({ error: "weird" }), undefined, "unknown_code", "retryable"],
  ["K22", "send", null, null, "transport", "transport", "retryable"],
  ["K23", "send", null, null, "timeout", "timeout", "retryable"],
  ["K24", "send", 200, null, "invalid_body", "invalid_body", "retryable"]
];

describe("classifyCloneEa: one row per CL2C §8.5 line (CK01-CK24)", () => {
  it.each(ROWS)("%s", (_id, route, status, b, failure, kind, errorClass) => {
    expect(classifyCloneEa(route, status, b, failure)).toEqual({ kind, errorClass });
    // The class reaches the same verdict from the same inputs (the failures travel as `code`).
    const err = new CloneEaError({ route, status, body: b, ...(failure ? { code: failure } : {}) });
    expect([err.kind, err.errorClass]).toEqual([kind, errorClass]);
  });

  it("K02 and K04 key on the exact detail; a detail that merely contains the words is K03 / K05", () => {
    expect(classifyCloneEa("send", 403, body({ error: "forbidden_scope", detail: "x send_disabled y" })).kind).toBe("auth");
    expect(classifyCloneEa("send", 403, body({ error: "forbidden_scope", detail: "SEND_DISABLED" })).kind).toBe("auth");
    expect(classifyCloneEa("create_reply", 400, body({ error: "bad_request", detail: "not a connected Microsoft mailbox!" })).kind).toBe("bad_request");
    expect(classifyCloneEa("create_reply", 400, body({ error: "bad_request", detail: "mailbox_not_connected" })).kind).toBe("mailbox_not_connected");
    expect(classifyCloneEa("recreate", 400, body({ error: "bad_request", detail: "not_microsoft" })).kind).toBe("mailbox_not_connected");
    // K04 is a create-route row: the same detail on another route is K05.
    expect(classifyCloneEa("send", 400, body({ error: "bad_request", detail: "not_microsoft" })).kind).toBe("bad_request");
  });

  it("K15 keys on the exact graphCode", () => {
    expect(classifyCloneEa("send", 502, body({ error: "graph_error", graphCode: "token_refresh_failed:invalid_grant_x" })).kind).toBe("graph_error");
    expect(classifyCloneEa("send", 502, body({ error: "graph_error", graphCode: "TOKEN_REFRESH_FAILED:INVALID_GRANT" })).kind).toBe("graph_error");
  });

  it("a known code on the wrong status is K21", () => {
    expect(classifyCloneEa("send", 409, body({ error: "not_found" }))).toEqual({ kind: "unknown_code", errorClass: "fatal" });
    expect(classifyCloneEa("send", 500, body({ error: "throttled" }))).toEqual({ kind: "unknown_code", errorClass: "retryable" });
    expect(classifyCloneEa("send", 200, body({ error: "changed" }))).toEqual({ kind: "unknown_code", errorClass: "retryable" });
  });

  it("draftStatus is not an input to the classifier", () => {
    expect(classifyCloneEa("send", 404, body({ error: "gone", draftStatus: "saved" })).kind).toBe("gone");
    expect(classifyCloneEa("send", 404, body({ error: "gone", draftStatus: "sent" })).kind).toBe("gone");
  });
});

describe("parseCloneErrorBody (CK25)", () => {
  it("an HTML 404 page is null", () => {
    expect(parseCloneErrorBody("text/html; charset=utf-8", "<!DOCTYPE html><html><body><pre>Cannot GET /x</pre></body></html>")).toBeNull();
    expect(parseCloneErrorBody("application/json", "<!DOCTYPE html>")).toBeNull();
  });

  it("more than 8 KB is null", () => {
    const big = JSON.stringify({ error: "server_error", detail: "x".repeat(9000) });
    expect(parseCloneErrorBody("application/json", big)).toBeNull();
    expect(parseCloneErrorBody("application/json", JSON.stringify({ error: "server_error", detail: "x".repeat(7000) }))).not.toBeNull();
  });

  it("parses the clone's fields and nulls what doesn't fit", () => {
    const parsed = parseCloneErrorBody(
      "application/json; charset=utf-8",
      JSON.stringify({ error: "gone", detail: "x", draftStatus: "deleted", graphStatus: 404, graphCode: "ErrorItemNotFound", replacedBy: "AAMkNew=", message: "ignored" })
    );
    expect(parsed).toEqual({ error: "gone", detail: "x", draftStatus: "deleted", graphStatus: 404, graphCode: "ErrorItemNotFound", replacedBy: "AAMkNew=" });
    const loose = parseCloneErrorBody("application/json", JSON.stringify({ error: "gone", draftStatus: "lost", graphStatus: "404", replacedBy: "bad id!" }));
    expect(loose).toEqual({ error: "gone", detail: null, draftStatus: null, graphStatus: null, graphCode: null, replacedBy: null });
  });

  it("needs a string error code; no content type is tried as JSON; a non-JSON content type is not", () => {
    expect(parseCloneErrorBody("application/json", "{}")).toBeNull();
    expect(parseCloneErrorBody("application/json", JSON.stringify({ error: "" }))).toBeNull();
    expect(parseCloneErrorBody("application/json", JSON.stringify([1]))).toBeNull();
    expect(parseCloneErrorBody("application/json", "")).toBeNull();
    expect(parseCloneErrorBody(null, JSON.stringify({ error: "not_ready" }))?.error).toBe("not_ready");
    expect(parseCloneErrorBody("text/plain", JSON.stringify({ error: "not_ready" }))).toBeNull();
  });

  it("clips detail and codes", () => {
    const parsed = parseCloneErrorBody("application/json", JSON.stringify({ error: "e".repeat(150), detail: "d".repeat(300), graphCode: "g".repeat(150) }));
    expect(parsed?.error.length).toBe(100);
    expect(parsed?.detail?.length).toBe(200);
    expect(parsed?.graphCode?.length).toBe(100);
  });
});

describe("parseRetryAfterMs (CK26)", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  it("seconds", () => {
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs(" 2 ", now)).toBe(2_000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
  });
  it("an HTTP date, relative to now, never negative", () => {
    expect(parseRetryAfterMs(new Date(now + 60_000).toUTCString(), now)).toBe(60_000);
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });
  it("junk and absence are null", () => {
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("-5", now)).toBeNull();
  });
  it("is capped at an hour", () => {
    expect(parseRetryAfterMs("99999999", now)).toBe(3_600_000);
    expect(parseRetryAfterMs(new Date(now + 7_200_000).toUTCString(), now)).toBe(3_600_000);
  });
});

describe("parseCloneDraftRead and the other parsers (CK27)", () => {
  it("a read-back parses with every field, live defaulting to true", () => {
    const fixture = readBackFixture({
      from: { address: "m@scaledai.org", name: "Mitchell" },
      sender: { address: "m@scaledai.org", name: "" },
      replyTo: [{ address: "r@scaledai.org", name: "R" }],
      bcc: [{ address: "b@x.io", name: "B" }],
      attachments: [{ id: "att1", name: "logo.png", size: 1234, isInline: true, contentType: "image/png" }],
      flags: ["signature_skipped"]
    });
    const { live: _live, ...wire } = fixture;
    const read = parseCloneDraftRead("get_draft", wire);
    expect(read).toEqual(fixture);
    expect(parseCloneReadBack("create_reply", { ...wire, live: true })).toEqual(fixture);
  });

  it("tolerates cosmetic gaps: a missing name reads as '', absent lists as [], an attachment without a type", () => {
    const read = parseCloneDraftRead("get_draft", {
      ...readBackFixture(),
      to: [{ address: "a@x.io" }],
      cc: undefined,
      bcc: null,
      replyTo: undefined,
      attachments: [{ id: "a1", size: "big", isInline: "yes" }]
    });
    expect(read.live && read.to).toEqual([{ address: "a@x.io", name: "" }]);
    expect(read.live && [read.cc, read.bcc, read.replyTo]).toEqual([[], [], []]);
    expect(read.live && read.attachments).toEqual([{ id: "a1", name: "attachment", size: 0, isInline: false, contentType: null }]);
  });

  it("a registry view (live: false) parses to its own shape", () => {
    const view = parseCloneDraftRead("get_draft", {
      live: false,
      graphId: "AAMk=",
      status: "sent",
      flags: ["unverified"],
      internetMessageId: "id@x",
      webLink: null,
      verifiedAt: "2026-11-05T12:00:00Z"
    });
    expect(view).toEqual({ live: false, graphId: "AAMk=", status: "sent", flags: ["unverified"], internetMessageId: "id@x", webLink: null, verifiedAt: "2026-11-05T12:00:00Z" });
    expect(() => parseCloneReadBack("create_reply", { ...view })).toThrow(CloneEaError);
  });

  it.each([
    ["a missing contentHash", { contentHash: undefined }],
    ["a short contentHash", { contentHash: "abc" }],
    ["an uppercase contentHash", { contentHash: "A".repeat(64) }],
    ["a bad graphId", { graphId: "bad id!" }],
    ["an empty graphId", { graphId: "" }],
    ["a bad status", { status: "lost" }],
    ["a bad kind", { kind: "forward" }],
    ["a missing accountId", { accountId: null }],
    ["a non-boolean isDraft", { isDraft: "true" }],
    ["a recipient without an address", { to: [{ name: "x" }] }],
    ["a subject that isn't a string", { subject: null }],
    ["a body that isn't a string", { bodyHtml: 1 }],
    ["a bad replaces id", { replaces: "no spaces allowed" }],
    ["a live flag that is neither boolean", { live: "yes" }]
  ])("%s is invalid_body", (_what, over) => {
    const { live: _live, ...wire } = readBackFixture();
    let caught: unknown;
    try {
      parseCloneDraftRead("get_draft", { ...wire, ...over });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloneEaError);
    const err = caught as CloneEaError;
    expect([err.kind, err.errorClass, err.route, err.code, err.status]).toEqual(["invalid_body", "retryable", "get_draft", "invalid_body", null]);
  });

  it("a body that isn't an object is invalid_body", () => {
    for (const json of [null, "x", 3, [1], undefined]) expect(() => parseCloneDraftRead("get_draft", json)).toThrow(CloneEaError);
  });

  it("isCloneDraftStatus knows the registry's ten statuses", () => {
    for (const s of ["creating", "saved", "sending", "sent_pending_verification", "sent", "sent_mismatch", "sent_external", "unknown", "gone", "deleted"]) {
      expect(isCloneDraftStatus(s)).toBe(true);
    }
    expect(isCloneDraftStatus("draft")).toBe(false);
    expect(isCloneDraftStatus(null)).toBe(false);
  });

  it("parseCloneSendAccepted", () => {
    expect(parseCloneSendAccepted({ graphId: "AAMk=", status: "sent_pending_verification", internetMessageId: "id@x" })).toEqual({
      graphId: "AAMk=",
      status: "sent_pending_verification",
      internetMessageId: "id@x"
    });
    expect(parseCloneSendAccepted({ graphId: "AAMk=", status: "sent_pending_verification" }).internetMessageId).toBeNull();
    for (const json of [{}, { graphId: "AAMk=", status: "sent" }, { graphId: "bad id!", status: "sent_pending_verification" }, null]) {
      expect(() => parseCloneSendAccepted(json)).toThrow(CloneEaError);
    }
  });

  it("parseCloneDeleted", () => {
    expect(parseCloneDeleted({ graphId: "AAMk=", status: "deleted" })).toEqual({ graphId: "AAMk=", status: "deleted" });
    expect(() => parseCloneDeleted({ graphId: "AAMk=", status: "gone" })).toThrow(CloneEaError);
    expect(() => parseCloneDeleted({ status: "deleted" })).toThrow(CloneEaError);
  });

  it("parseCloneStatus: cl2 absent on a pre-CL2 build, strict otherwise", () => {
    expect(parseCloneStatus({ ok: true })).toEqual({ cl2: null });
    expect(parseCloneStatus({ ok: true, cl2: null })).toEqual({ cl2: null });
    expect(parseCloneStatus({ cl2: { ready: true, send: "some" } })).toEqual({ cl2: { ready: true, send: "some" } });
    expect(() => parseCloneStatus({ cl2: { ready: "yes", send: "all" } })).toThrow(CloneEaError);
    expect(() => parseCloneStatus({ cl2: { ready: true, send: "maybe" } })).toThrow(CloneEaError);
    expect(() => parseCloneStatus("ok")).toThrow(CloneEaError);
  });

  it("parseCloneAuthMe: auth absent for a legacy token, sendEnabled only when explicitly true", () => {
    expect(parseCloneAuthMe({ user: { id: "u" } })).toEqual({ auth: null });
    const me = parseCloneAuthMe({ auth: { kind: "scoped", scopes: ["read", "draft"], accounts: ["acc_1"], jti: "j", expiresAt: "2027-01-01T00:00:00Z", sendEnabled: true } });
    expect(me.auth).toEqual({ kind: "scoped", scopes: ["read", "draft"], accounts: ["acc_1"], jti: "j", expiresAt: "2027-01-01T00:00:00Z", sendEnabled: true });
    expect(parseCloneAuthMe({ auth: { kind: "scoped", scopes: [], accounts: [], sendEnabled: "true" } }).auth?.sendEnabled).toBe(false);
    expect(parseCloneAuthMe({ auth: { kind: "scoped", scopes: [], accounts: [] } }).auth?.jti).toBe("");
    expect(() => parseCloneAuthMe({ auth: { kind: "", scopes: [], accounts: [] } })).toThrow(CloneEaError);
    expect(() => parseCloneAuthMe({ auth: { kind: "scoped", scopes: "draft", accounts: [] } })).toThrow(CloneEaError);
  });
});

describe("CloneEaError's message carries codes only (CK28)", () => {
  it("never the detail, a token or response text", () => {
    const secret = "Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature";
    const err = new CloneEaError({ route: "send", status: 403, body: body({ error: "forbidden_scope", detail: secret }) });
    expect(err.message).toBe("clone send answered 403 forbidden_scope");
    expect(String(err)).toBe("CloneEaError: clone send answered 403 forbidden_scope");
    expect(err.message).not.toContain("eyJ");
    expect(err.detail).toBe(secret);
    expect(err.name).toBe("CloneEaError");
    expect(new CloneEaError({ route: "status", status: null, body: null, code: "transport" }).message).toBe("clone status answered no status transport");
    expect(new CloneEaError({ route: "get_draft", status: 502, body: null, code: "edge" }).message).toBe("clone get_draft answered 502 edge");
  });

  it("carries the body's fields, the replay flag and Retry-After", () => {
    const err = new CloneEaError({
      route: "send",
      status: 429,
      body: body({ error: "throttled", draftStatus: "saved", graphStatus: 429, graphCode: "ApplicationThrottled" }),
      retryAfterMs: 7_000,
      replay: true
    });
    expect([err.kind, err.errorClass, err.draftStatus, err.graphStatus, err.graphCode, err.retryAfterMs, err.replay]).toEqual([
      "throttled", "retryable", "saved", 429, "ApplicationThrottled", 7_000, true
    ]);
    expect(new CloneEaError({ route: "send", status: 429, body: body({ error: "throttled" }) }).retryAfterMs).toBe(30_000);
    expect(new CloneEaError({ route: "send", status: 429, body: body({ error: "throttled" }), retryAfterMs: null }).retryAfterMs).toBe(30_000);
    expect(new CloneEaError({ route: "send", status: 500, body: body({ error: "server_error" }) }).retryAfterMs).toBeNull();
  });
});

describe("the classifier ignores any message text (CK29)", () => {
  it("a misleading message field changes nothing", () => {
    const parsed = parseCloneErrorBody("application/json", JSON.stringify({ error: "changed", draftStatus: "saved", message: "invalid_token: please re-auth" }));
    expect(parsed).not.toBeNull();
    expect(classifyCloneEa("recreate", 409, parsed).kind).toBe("changed");
    const err = new CloneEaError({ route: "recreate", status: 409, body: parsed });
    expect(err.kind).toBe("changed");
    expect(err.message).not.toContain("re-auth");
    // Keyed on the status pair, never on words in detail.
    expect(classifyCloneEa("send", 500, body({ error: "server_error", detail: "invalid_token" })).kind).toBe("server_error");
  });
});

describe("decodeTokenClaims (the offline decode, L4)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  it("reads the payload of three base64url parts without verifying", () => {
    const token = `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify({ scope: ["send"], accounts: ["acc_1"], exp: 2_000_000_000, jti: "j".repeat(16) }))}.sig`;
    expect(decodeTokenClaims(token)).toEqual({ scope: ["send"], accounts: ["acc_1"], exp: 2_000_000_000, jti: "j".repeat(16) });
    expect(decodeTokenClaims(`${b64("{}")}.${b64(JSON.stringify({ a: 1 }))}==.sig`)).toEqual({ a: 1 });
  });
  it("is null for anything else", () => {
    expect(decodeTokenClaims("abc")).toBeNull();
    expect(decodeTokenClaims("a.b")).toBeNull();
    expect(decodeTokenClaims("a..b")).toBeNull();
    expect(decodeTokenClaims(`${b64("{}")}.${b64("[1]")}.sig`)).toBeNull();
    expect(decodeTokenClaims(`${b64("{}")}.${b64("not json")}.sig`)).toBeNull();
    expect(decodeTokenClaims(`${b64("{}")}.not+base64url/.sig`)).toBeNull();
  });
});
