import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { READ_BACK_FRAME_SANDBOX, ReadBackFrame } from "@/components/exec/drafts/ReadBackFrame";
import { ANSWERED_LABEL } from "@/components/exec/email/labels";
import {
  CloneEaError,
  MAILBOX_NOT_CONNECTED_DETAILS,
  THROTTLED_DEFAULT_RETRY_MS,
  classifyCloneEa,
  type CloneEaErrorKind,
  type CloneEaFailure,
  type CloneEaRoute,
  type CloneErrorBody,
  type CloneReadBack
} from "@/lib/exec/clone-ea-types";
import { DRAFT_SCHEMA_NEW_V1, DRAFT_SCHEMA_REPLY_V1 } from "@/lib/exec/drafts-doc";
import { DRAFT_COLUMNS } from "@/lib/exec/drafts-store";
import { DRAFT_JOB_KINDS, DRAFT_STATUSES } from "@/lib/exec/drafts-types";
import { READ_BACK_CSP, READ_BACK_CSP_META, readBackSrcdoc, toReadBackView } from "@/lib/exec/drafts-view";
import { MAX_EMAIL_HTML_CHARS } from "@/lib/exec/email-srcdoc";
import { draftGenerateJobHandler } from "@/lib/exec/handlers/draft-generate";
import { draftReconcileJobHandler, draftReconcileScheduledWork } from "@/lib/exec/handlers/draft-reconcile";
import { voiceRefreshJobHandler, voiceRefreshScheduledWork } from "@/lib/exec/handlers/voice-refresh";
import { classifyError } from "@/lib/exec/jobs";
import { DEFAULT_SETTINGS, countEnabledMailPinnedPrincipals, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { CLONE_EA_PATHS } from "@/lib/exec/sources/clone-ea";
import { getMailTimezone, listOpenTasksForClient } from "@/lib/exec/sources/dd";
import { EaUnavailableError, MailScopeError, createReplyDraft } from "@/lib/exec/sources/mail";
import { getSyncState, parseEaTokenState, parseSendTokenState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { NonRetryableError, type ErrorClass, type ExecPrincipal } from "@/lib/exec/types";
import { createFakePostgrest } from "./__tests__/fake-postgrest";

// The P4 stage-0 seeds (lead-owned): the §3.2.3 classifier table, the
// CloneEaError contract, the read-back adapters (§3.13.1, C64), the ReadBackFrame
// island, and the additive seeds the areas compile against (§0.2 step 3).
// Area B's clone-ea-types.test.ts may repeat the classifier cases; neither
// file edits the other.

function mint(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint("ep_owner");

const body = (over: Partial<CloneErrorBody> & { error: string }): CloneErrorBody => ({
  detail: null,
  draftStatus: null,
  graphStatus: null,
  graphCode: null,
  replacedBy: null,
  ...over
});

// --- §3.2.3: the classifier -----------------------------------------------------------------

describe("classifyCloneEa: the §8.5 table, keyed on (route, HTTP, error, detail/graphCode)", () => {
  const rows: [string, CloneEaRoute, number | null, CloneErrorBody | null, CloneEaFailure | undefined, CloneEaErrorKind, ErrorClass][] = [
    ["K01", "send", 401, body({ error: "invalid_token" }), undefined, "auth", "auth"],
    ["K02", "send", 403, body({ error: "forbidden_scope", detail: "send_disabled" }), undefined, "send_disabled", "fatal"],
    ["K03", "get_draft", 403, body({ error: "forbidden_scope", detail: "account not in token" }), undefined, "auth", "auth"],
    ["K03 (no detail)", "create_new", 403, body({ error: "forbidden_scope" }), undefined, "auth", "auth"],
    ["K04 create_reply", "create_reply", 400, body({ error: "bad_request", detail: "not a connected Microsoft mailbox" }), undefined, "mailbox_not_connected", "fatal"],
    ["K04 create_new", "create_new", 400, body({ error: "bad_request", detail: "not_microsoft" }), undefined, "mailbox_not_connected", "fatal"],
    ["K04 recreate", "recreate", 400, body({ error: "bad_request", detail: "mailbox_not_connected" }), undefined, "mailbox_not_connected", "fatal"],
    ["K04 not on a read", "get_draft", 400, body({ error: "bad_request", detail: "not_microsoft" }), undefined, "bad_request", "fatal"],
    ["K05", "create_reply", 400, body({ error: "bad_request", detail: "bcc is not allowed on a reply" }), undefined, "bad_request", "fatal"],
    ["K06", "get_draft", 404, body({ error: "not_found" }), undefined, "not_found", "fatal"],
    ["K07", "send", 404, body({ error: "gone", draftStatus: "saved" }), undefined, "gone", "fatal"],
    ["K08", "recreate", 409, body({ error: "changed" }), undefined, "changed", "fatal"],
    ["K09", "send", 409, body({ error: "already_sending" }), undefined, "already_sending", "retryable"],
    ["K10", "send", 409, body({ error: "already_sent" }), undefined, "already_sent", "fatal"],
    ["K11", "send", 409, body({ error: "sent_externally" }), undefined, "sent_externally", "fatal"],
    ["K12", "create_reply", 409, body({ error: "parent_missing" }), undefined, "parent_missing", "fatal"],
    ["K13", "send", 422, body({ error: "idempotency_mismatch" }), undefined, "idempotency_mismatch", "fatal"],
    ["K14", "create_new", 429, body({ error: "throttled" }), undefined, "throttled", "retryable"],
    ["K15", "send", 502, body({ error: "graph_error", graphCode: "token_refresh_failed:invalid_grant" }), undefined, "mailbox_reconnect", "auth"],
    ["K16", "send", 502, body({ error: "graph_error", graphCode: "ErrorItemNotFound", graphStatus: 404 }), undefined, "graph_error", "retryable"],
    ["K17", "status", 503, body({ error: "not_ready" }), undefined, "not_ready", "retryable"],
    ["K18", "send", 504, body({ error: "graph_timeout" }), undefined, "graph_timeout", "retryable"],
    ["K19", "delete", 500, body({ error: "server_error" }), undefined, "server_error", "retryable"],
    ["K20 4xx edge", "get_draft", 404, null, undefined, "edge", "retryable"],
    ["K20 5xx edge", "send", 502, null, undefined, "edge", "retryable"],
    ["K20 explicit", "send", 503, null, "edge", "edge", "retryable"],
    ["K21 4xx", "send", 418, body({ error: "teapot" }), undefined, "unknown_code", "fatal"],
    ["K21 5xx", "send", 599, body({ error: "weird" }), undefined, "unknown_code", "retryable"],
    ["K21 known code, wrong status", "send", 409, body({ error: "not_found" }), undefined, "unknown_code", "fatal"],
    ["K21 known code, wrong status (5xx)", "send", 500, body({ error: "throttled" }), undefined, "unknown_code", "retryable"],
    ["K22", "status", null, null, "transport", "transport", "retryable"],
    ["K22 (no status, no failure)", "status", null, null, undefined, "transport", "retryable"],
    ["K23", "send", null, null, "timeout", "timeout", "retryable"],
    ["K24", "create_reply", 200, null, "invalid_body", "invalid_body", "retryable"],
    ["K24 (2xx, no body)", "create_reply", 201, null, undefined, "invalid_body", "retryable"]
  ];
  it.each(rows)("%s", (_label, route, status, b, failure, kind, errorClass) => {
    expect(classifyCloneEa(route, status, b, failure)).toEqual({ kind, errorClass });
  });

  it("reads detail and graphCode by exact equality only", () => {
    expect(classifyCloneEa("send", 403, body({ error: "forbidden_scope", detail: "send_disabled " })).kind).toBe("auth");
    expect(classifyCloneEa("send", 403, body({ error: "forbidden_scope", detail: "SEND_DISABLED" })).kind).toBe("auth");
    expect(classifyCloneEa("create_new", 400, body({ error: "bad_request", detail: "Not a connected Microsoft mailbox" })).kind).toBe("bad_request");
    expect(classifyCloneEa("send", 502, body({ error: "graph_error", graphCode: "token_refresh_failed:invalid_grant_x" })).kind).toBe("graph_error");
    expect(MAILBOX_NOT_CONNECTED_DETAILS).toEqual(["not a connected Microsoft mailbox", "not_microsoft", "mailbox_not_connected"]);
  });
});

describe("CloneEaError", () => {
  it("carries codes only in its message, and the body's fields as properties", () => {
    const err = new CloneEaError({
      route: "recreate",
      status: 409,
      body: body({ error: "changed", detail: "the draft was edited: Re: invoice", draftStatus: "saved", graphStatus: 412, graphCode: "ErrorIrresolvableConflict", replacedBy: null }),
      replay: true
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CloneEaError");
    expect(err.message).toBe("clone recreate answered 409 changed");
    expect(err.message).not.toContain("invoice");
    expect(err.detail).toBe("the draft was edited: Re: invoice");
    expect(err.code).toBe("changed");
    expect(err.kind).toBe("changed");
    expect(err.errorClass).toBe("fatal");
    expect(err.status).toBe(409);
    expect(err.draftStatus).toBe("saved");
    expect(err.graphStatus).toBe(412);
    expect(err.graphCode).toBe("ErrorIrresolvableConflict");
    expect(err.replacedBy).toBeNull();
    expect(err.replay).toBe(true);
    expect(err.retryAfterMs).toBeNull();
  });

  it("names the failure when there is no answer", () => {
    const t = new CloneEaError({ route: "status", status: null, body: null, code: "transport" });
    expect(t.message).toBe("clone status answered no status transport");
    expect(t).toMatchObject({ kind: "transport", errorClass: "retryable", code: "transport", status: null, replay: false, detail: null });
    const o = new CloneEaError({ route: "send", status: null, body: null, code: "timeout" });
    expect(o).toMatchObject({ kind: "timeout", errorClass: "retryable" });
    const e = new CloneEaError({ route: "send", status: 502, body: null, code: "edge" });
    expect(e).toMatchObject({ kind: "edge", errorClass: "retryable", code: "edge" });
    const i = new CloneEaError({ route: "send", status: 202, body: null, code: "invalid_body" });
    expect(i).toMatchObject({ kind: "invalid_body", errorClass: "retryable", status: 202 });
    expect(new CloneEaError({ route: "send", status: 502, body: null })).toMatchObject({ kind: "edge", code: "unknown_code" });
    expect(new CloneEaError({ route: "send", status: null, body: null })).toMatchObject({ kind: "transport", code: "transport" });
  });

  it("defaults retryAfterMs for a throttled answer and keeps a given one", () => {
    expect(new CloneEaError({ route: "send", status: 429, body: body({ error: "throttled" }) }).retryAfterMs).toBe(THROTTLED_DEFAULT_RETRY_MS);
    expect(THROTTLED_DEFAULT_RETRY_MS).toBe(30_000);
    expect(new CloneEaError({ route: "send", status: 429, body: body({ error: "throttled" }), retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000);
    expect(new CloneEaError({ route: "send", status: 500, body: body({ error: "server_error" }), retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000);
  });

  it("is classified by P2a's job runner through its errorClass property", () => {
    expect(classifyError(new CloneEaError({ route: "send", status: 401, body: body({ error: "invalid_token" }) }))).toBe("auth");
    expect(classifyError(new CloneEaError({ route: "send", status: 429, body: body({ error: "throttled" }) }))).toBe("retryable");
    expect(classifyError(new CloneEaError({ route: "send", status: 409, body: body({ error: "already_sent" }) }))).toBe("fatal");
  });
});

// --- §3.13.1: the read-back adapters -----------------------------------------------------------

describe("readBackSrcdoc", () => {
  const HTML = '<p>Hi <img src="https://img.example/a.png" alt="x"> <script>alert(1)</script><a href="https://client.example/x">link</a></p>';

  it("puts P4's CSP first in <head>, then P3's own, with remote images withheld", () => {
    const r = readBackSrcdoc(HTML);
    expect(r.srcdoc.startsWith(`<!DOCTYPE html><html><head>${READ_BACK_CSP_META}`)).toBe(true);
    expect(r.srcdoc.slice(`<!DOCTYPE html><html><head>${READ_BACK_CSP_META}`.length).startsWith('<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    expect(r.srcdoc.split('http-equiv="Content-Security-Policy"').length - 1).toBe(2);
    expect(r.remoteImageCount).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.srcdoc).not.toContain("img.example");
    expect(r.srcdoc).not.toContain("<script");
    expect(r.srcdoc).toContain("<body>");
  });

  it("locks everything down: no scripts, no remote loads, no frames, no forms, no base URL", () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'none'",
      "img-src data:",
      "style-src 'unsafe-inline'",
      "font-src data:",
      "media-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ]) {
      expect(READ_BACK_CSP.split("; ")).toContain(directive);
    }
    expect(READ_BACK_CSP).not.toContain("https:");
    expect(READ_BACK_CSP_META).toBe(`<meta http-equiv="Content-Security-Policy" content="${READ_BACK_CSP}">`);
  });

  it("reports P3's truncation of an over-long body", () => {
    expect(readBackSrcdoc("x".repeat(MAX_EMAIL_HTML_CHARS + 1)).truncated).toBe(true);
    expect(readBackSrcdoc("<p>short</p>").truncated).toBe(false);
  });

  it("refuses a document that doesn't open the way P3's builder promises (C64)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/exec/email-srcdoc", () => ({
      buildEmailSrcdoc: () => ({ srcdoc: "<html><head></head><body></body></html>", remoteImages: 0, inlineImages: 0, truncated: false })
    }));
    try {
      const mod = await import("@/lib/exec/drafts-view");
      expect(() => mod.readBackSrcdoc("<p>x</p>")).toThrow(/does not open as expected/);
    } finally {
      vi.doUnmock("@/lib/exec/email-srcdoc");
      vi.resetModules();
    }
  });
});

describe("toReadBackView", () => {
  const CR_LF = String.fromCharCode(13, 10);
  const NUL = String.fromCharCode(0);
  const rb: CloneReadBack = {
    live: true,
    graphId: "AAMkAGI2=",
    status: "saved",
    kind: "reply",
    accountId: "acc_1",
    threadId: "t1",
    parentMessageId: "m1",
    replaces: null,
    changeKey: "CQAAABYAAAD",
    contentHash: "a".repeat(64),
    internetMessageId: null,
    conversationId: null,
    webLink: "https://outlook.office.com/mail/deeplink/x",
    isDraft: true,
    lastModified: "2026-11-05T10:00:00Z",
    sentAt: null,
    from: { address: " Mitchell@ScaledAI.org ", name: "Mitchell" },
    sender: null,
    replyTo: [{ address: "Billing@Other.example", name: "" }],
    to: [{ address: "Jane@Client.com ", name: ` Jane${NUL} Doe${CR_LF}CEO ` }],
    cc: [{ address: "support@client.com", name: "" }],
    bcc: [{ address: "someone@other.example", name: "x".repeat(300) }],
    subject: `Re:\tHello${CR_LF}there`,
    bodyHtml: "<p>Hi</p>",
    attachments: [{ id: "a1", name: "image001.png", size: 1234, isInline: true, contentType: "image/png" }],
    flags: ["signature_skipped"]
  };
  const ctx = {
    internalDomains: new Set(["scaledai.org"]),
    storedTo: [{ address: "jane@client.com", name: null }],
    storedCc: [],
    threadAddresses: new Set(["jane@client.com", "mitchell@scaledai.org"])
  };

  it("normalizes addresses and names, badges recipients, and passes the clone's hash through untouched", () => {
    const v = toReadBackView(rb, ctx);
    expect(v.from).toEqual({ address: "mitchell@scaledai.org", name: "Mitchell" });
    expect(v.sender).toBeNull();
    expect(v.replyTo).toEqual([{ address: "billing@other.example", name: null }]);
    expect(v.to).toEqual([{ address: "jane@client.com", name: "Jane Doe CEO", badges: ["external"] }]);
    expect(v.cc).toEqual([{ address: "support@client.com", name: null, badges: ["external", "role", "not_in_thread", "added_in_outlook"] }]);
    expect(v.bcc[0].address).toBe("someone@other.example");
    expect(v.bcc[0].name).toHaveLength(256);
    expect(v.bcc[0].badges).toEqual(["external", "not_in_thread", "added_in_outlook"]);
    expect(v.subject).toBe("Re: Hello there");
    expect(v.srcdoc.startsWith(`<!DOCTYPE html><html><head>${READ_BACK_CSP_META}`)).toBe(true);
    expect(v.remoteImageCount).toBe(0);
    expect(v.truncated).toBe(false);
    expect(v.attachments).toEqual([{ name: "image001.png", size: 1234, isInline: true, contentType: "image/png" }]);
    expect(v.signatureSkipped).toBe(true);
    expect(v.contentHash).toBe("a".repeat(64));
    expect(JSON.stringify(v)).not.toContain("outlook.office.com");
  });

  it("gives an internal, stored recipient no badge, and skips the thread badge when no thread set is given", () => {
    const v = toReadBackView(
      { ...rb, to: [{ address: "ops@scaledai.org", name: "" }], cc: [], bcc: [], flags: [] },
      { internalDomains: new Set(["scaledai.org"]), storedTo: [{ address: "ops@scaledai.org", name: null }] }
    );
    expect(v.to).toEqual([{ address: "ops@scaledai.org", name: null, badges: [] }]);
    expect(v.signatureSkipped).toBe(false);
  });
});

describe("ReadBackFrame", () => {
  const FILE = fileURLToPath(new URL("../../components/exec/drafts/ReadBackFrame.tsx", import.meta.url));

  it("renders an opaque-origin frame with no srcdoc in the server's HTML", () => {
    const out = renderToStaticMarkup(createElement(ReadBackFrame, { srcdoc: "<p>the draft text</p>", title: "Read-back of your draft" }));
    expect(READ_BACK_FRAME_SANDBOX).toBe("");
    expect(out).toContain('sandbox=""');
    expect(out.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('title="Read-back of your draft"');
    expect(out).not.toContain("the draft text");
    expect(out.toLowerCase()).not.toContain("srcdoc");
    expect(out).not.toContain("allow-");
  });

  it("never sets srcdoc from markup and never widens the sandbox (source rule)", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src.trimStart().startsWith('"use client";')).toBe(true);
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/srcDoc=/);
    expect(code).not.toContain("allow-scripts");
    expect(code).not.toContain("allow-same-origin");
    expect(code).not.toContain("allow-popups");
    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(src).toContain('READ_BACK_FRAME_SANDBOX = ""');
  });
});

// --- §0.2 step 3: the additive seeds -----------------------------------------------------------

describe("stage-0 additive seeds", () => {
  it("labels: the reply_sent_pending overlay has its words (X1)", () => {
    expect(ANSWERED_LABEL.reply_sent_pending).toBe("Reply sent, syncing");
  });

  it("settings: the four P4 fields exist and default to off (Y1, Y2)", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady: false });
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady: false });
    expect(settingsFromRow(null, "ep_1", { emailSchemaReady: true })).toMatchObject({ draftsEnabled: false, draftsSchemaReady: false });
  });

  // The seeds below were throwing stubs at stage 0; the integrator replaced the
  // "is a stub" checks with the real behaviour each owner landed (Areas A, B, C, D).
  it("principal.ts: countEnabledMailPinnedPrincipals counts enabled principals with a non-empty pin (Area A)", async () => {
    const db = createFakePostgrest({
      tables: {
        exec_principals: [
          { id: "ep_a", enabled: true, mail_account_ids: ["acc_1"] },
          { id: "ep_b", enabled: true, mail_account_ids: [] },
          { id: "ep_c", enabled: false, mail_account_ids: ["acc_2"] }
        ]
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    expect(await countEnabledMailPinnedPrincipals()).toBe(1);
  });

  it("sources/dd.ts: getMailTimezone falls back to the default; listOpenTasksForClient skips a blank name (Y11)", async () => {
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no database in this test");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await getMailTimezone(principal)).toBe("America/New_York");
      expect(await listOpenTasksForClient(principal, "   ")).toEqual([]);
    } finally {
      warn.mockRestore();
      vi.mocked(getSupabaseAdmin).mockReset();
    }
  });

  it("sync-state.ts: clone-ea is a source; the two parsers refuse a malformed value (X3)", async () => {
    const db = createFakePostgrest({ tables: { exec_sync_state: [] } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const parseAny = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);
    expect(await getSyncState(principal, "clone-ea", "ea-token", parseAny)).toBeNull();
    await expect(getSyncState(principal, "bogus" as "mail", "k", parseAny)).rejects.toBeInstanceOf(NonRetryableError);
    expect(parseEaTokenState({})).toBeNull();
    expect(parseSendTokenState({})).toBeNull();
  });

  it("sources/mail.ts: EaUnavailableError is fatal and carries its reason; the draft functions refuse a foreign account before any I/O (§3.3)", async () => {
    const err = new EaUnavailableError("wrong_scopes");
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.errorClass).toBe("fatal");
    expect(err.reason).toBe("wrong_scopes");
    expect(err.name).toBe("EaUnavailableError");
    await expect(
      createReplyDraft(principal, { threadId: "t1", parentMessageId: "m1", accountId: "acc_foreign", to: [], cc: [], bodyHtml: "<p>x</p>", timezone: "UTC", idempotencyKey: "k" })
    ).rejects.toBeInstanceOf(MailScopeError);
  });
});

// --- the seeded constants the areas build on -----------------------------------------------------

describe("stage-0 constants", () => {
  it("DRAFT_COLUMNS maps every one of the 83 ExecDraftRow fields to its snake_case column, uniquely", () => {
    const keys = Object.keys(DRAFT_COLUMNS);
    // P5b (F7, F12): instruction_by is the 82nd, appended by P5b's migration after expires_at; chat_message_id
    // (review security-2) the 83rd, appended by the same migration.
    expect(keys).toHaveLength(83);
    expect(keys[0]).toBe("id");
    expect(keys[keys.length - 3]).toBe("expiresAt");
    expect(keys[keys.length - 2]).toBe("instructionBy");
    expect(keys[keys.length - 1]).toBe("chatMessageId");
    const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    for (const k of keys) expect(DRAFT_COLUMNS[k as keyof typeof DRAFT_COLUMNS], k).toBe(snake(k));
    expect(new Set(Object.values(DRAFT_COLUMNS)).size).toBe(83);
    expect(DRAFT_STATUSES).toHaveLength(13);
  });

  it("CLONE_EA_PATHS are the CL2 routes, ids encoded with their case kept", () => {
    expect(CLONE_EA_PATHS.status()).toBe("/api/status");
    expect(CLONE_EA_PATHS.authMe()).toBe("/api/auth/me");
    expect(CLONE_EA_PATHS.createReply("t/1 x")).toBe("/api/threads/t%2F1%20x/outlook-draft");
    expect(CLONE_EA_PATHS.createNew()).toBe("/api/compose/outlook-draft");
    expect(CLONE_EA_PATHS.draft("AAMk=Ab")).toBe("/api/outlook-drafts/AAMk%3DAb");
    expect(CLONE_EA_PATHS.send("G")).toBe("/api/outlook-drafts/G/send");
  });

  it("the handler and schedule consts carry §3.11's kinds, lanes, timeouts and gates", async () => {
    expect(DRAFT_JOB_KINDS).toEqual({ generate: "exec.draft-generate", reconcile: "exec.draft-reconcile", voice: "exec.voice-refresh" });
    expect(draftGenerateJobHandler).toMatchObject({ kind: "exec.draft-generate", lane: "interactive", timeoutMs: 150_000 });
    expect(draftReconcileJobHandler).toMatchObject({ kind: "exec.draft-reconcile", lane: "bulk", timeoutMs: 240_000 });
    expect(voiceRefreshJobHandler).toMatchObject({ kind: "exec.voice-refresh", lane: "bulk", timeoutMs: 300_000 });
    expect(draftReconcileScheduledWork).toMatchObject({ kind: "exec.draft-reconcile", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 2 });
    expect(voiceRefreshScheduledWork).toMatchObject({ kind: "exec.voice-refresh", lane: "bulk", cadence: { kind: "weekly", isoWeekday: 7, at: "04:00" }, maxAttempts: 2 });
    const base = settingsFromRow(null, "ep_1");
    const on = { ...base, draftsSchemaReady: true, draftsEnabled: true, voiceEnabled: true, emailSchemaReady: true, emailEnabled: true };
    expect(draftReconcileScheduledWork.enabled?.(base)).toBe(false);
    expect(draftReconcileScheduledWork.enabled?.({ ...base, draftsSchemaReady: true })).toBe(true);
    expect(voiceRefreshScheduledWork.enabled?.(on)).toBe(true);
    for (const off of ["draftsSchemaReady", "draftsEnabled", "voiceEnabled", "emailSchemaReady", "emailEnabled"] as const) {
      expect(voiceRefreshScheduledWork.enabled?.({ ...on, [off]: false }), off).toBe(false);
    }
    // A job without a principal is refused before any read (the handlers are real now).
    const ctx = { job: { id: 1, payload: {} } as never, principal: null, signal: new AbortController().signal, workerId: "w" };
    await expect(draftGenerateJobHandler.run(ctx)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(draftReconcileJobHandler.run(ctx)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(voiceRefreshJobHandler.run(ctx)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("the two output schemas are closed objects with every property required and no length bounds", () => {
    expect(DRAFT_SCHEMA_REPLY_V1).toMatchObject({ type: "object", additionalProperties: false, required: ["paragraphs", "sign_off", "note_for_mitchell", "placeholders"] });
    expect(DRAFT_SCHEMA_NEW_V1).toMatchObject({ type: "object", additionalProperties: false, required: ["paragraphs", "sign_off", "note_for_mitchell", "placeholders", "subject"] });
    for (const schema of [DRAFT_SCHEMA_REPLY_V1, DRAFT_SCHEMA_NEW_V1]) {
      const text = JSON.stringify(schema);
      expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([...(schema.required as string[])].sort());
      expect(text).not.toMatch(/minLength|maxLength|reasoning|thinking|trace/);
    }
  });
});
