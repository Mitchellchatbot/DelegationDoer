// Test support for Area D's route and sweep tests (P4 contract §5.8): fixtures
// and one setup call over the module mocks each test file declares itself
// (vi.mock is hoisted per file, so the mocks can't live here). The test file
// must mock, at least: @/lib/supabase-admin, @/lib/supabase-server,
// @/lib/exec/ops, @/lib/exec/access (requireExecPrincipal), @/lib/exec/audit,
// @/lib/exec/principal (loadSettings, countEnabledMailPinnedPrincipals),
// @/lib/exec/sync-state (getSyncState, putSyncState), @/lib/exec/jobs
// (enqueueJob), @/lib/exec/email-store (getEmailThread, listCorrespondentRows,
// listThreadScreenRows), @/lib/exec/sources/dd (getMailTimezone, listUsers,
// listClientMatchSignals), @/lib/exec/correlate (loadClientMatcher) and
// @/lib/exec/sources/mail (readPrincipalThread, loadScreeningPolicy,
// findSentCopy, listInternalAddresses, listReplyArtifacts).
//
// exec_drafts (and exec_audit_log for the rate limits) live in Area A's
// fake-drafts-db; the clone is Area B's CL2 fake, reached through the REAL
// sources/mail.ts draft functions, EA readiness included.

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { vi } from "vitest";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { buildClientMatcher, loadClientMatcher } from "@/lib/exec/correlate";
import type { ExecDraftRow } from "@/lib/exec/drafts-types";
import { getEmailThread, listCorrespondentRows, listThreadScreenRows } from "@/lib/exec/email-store";
import type { HisMessage, MessageMeta, PrincipalMailThread } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { DEFAULT_SETTINGS, countEnabledMailPinnedPrincipals, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { getMailTimezone, listClientMatchSignals, listUsers } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals } from "@/lib/exec/sources/dd-types";
import {
  findSentCopy,
  invalidateEaReadiness,
  listInternalAddresses,
  listReplyArtifacts,
  loadScreeningPolicy,
  readPrincipalThread,
  restrictedPolicyHash
} from "@/lib/exec/sources/mail";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { installFakeCl2, type FakeCl2, type FakeCl2Options } from "./fake-clone";
import { createFakeDraftsDb, draftDefaults, type FakeDraftsDb, type FakeDraftsDbConfig, type Row } from "./fake-drafts-db";

export const HIS = "acc_his";
export const OWN_EMAIL = "mitchell@scaledai.org";
export const CLIENT = "client@acme.io";
export const THREAD = "t1";
export const PARENT = "m_in";
export const GRAPH = "AAMkAGraphId=";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const ID1 = `ed_${"0".repeat(31)}1`;
export const ID2 = `ed_${"0".repeat(31)}2`;
export const ID3 = `ed_${"0".repeat(31)}3`;

export function mintPrincipal(accounts: string[] = [HIS], id = "ep_owner"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: OWN_EMAIL, name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
export const PRINCIPAL = mintPrincipal();

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
export const jwt = (claims: Record<string, unknown>) => `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify(claims))}.c2ln`;
const FUTURE_EXP = 2_000_000_000;
export const DRAFT_TOKEN = jwt({ id: "u_ea", workspace_id: "w1", scope: ["read", "draft"], accounts: [HIS], jti: "jti_0123456789abcdef", exp: FUTURE_EXP });
export const SEND_TOKEN = jwt({ id: "u_ea", workspace_id: "w1", scope: ["send"], accounts: [HIS], jti: "jti_send0123456789ab", exp: FUTURE_EXP });

export const EMPTY_POLICY_HASH = restrictedPolicyHash("hidden", []);
export const rule = (pattern: string, matchKind: "exact" | "domain" = "domain"): RestrictedSenderRule => ({
  id: `r_${pattern}`, pattern, matchKind, label: "", viewerUserIds: new Set()
});
export function policyOf(rules: RestrictedSenderRule[]): { rules: RestrictedSenderRule[]; hash: string } {
  return { rules, hash: restrictedPolicyHash("hidden", rules) };
}

export function settingsOn(over: Partial<ExecSettings> = {}): ExecSettings {
  return {
    ...DEFAULT_SETTINGS,
    principalId: PRINCIPAL.id,
    emailEnabled: true,
    emailSchemaReady: true,
    draftsEnabled: true,
    sendEnabled: true,
    voiceEnabled: true,
    draftsSchemaReady: true,
    ...over
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-05T12:00:00.000Z");
export const minutesAgo = (m: number, from = Date.now()) => new Date(from - m * 60_000).toISOString();

export function hisMessage(over: Partial<HisMessage> & { id: string; direction: HisMessage["direction"] }): HisMessage {
  return {
    threadId: THREAD,
    accountId: HIS,
    folder: over.direction === "outbound" ? "Sent Items" : "Inbox",
    isJunk: false,
    rfcMessageId: `<${over.id}@x>`,
    inReplyTo: null,
    subject: "Website update",
    from: null,
    to: [],
    cc: [],
    sentAt: new Date(T0).toISOString(),
    createdAtMs: T0,
    isAutomated: false,
    attachments: [],
    bodyDeferred: false,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}

/** A thread of his: one inbound from the client to him (the default parent), plus `extra`. `all` mirrors `his`. */
export function threadFixture(opts: { extra?: HisMessage[]; inboundFrom?: string; cc?: string[]; sentAt?: string } = {}): PrincipalMailThread {
  const inbound = hisMessage({
    id: PARENT,
    direction: "inbound",
    from: { name: "Client", email: opts.inboundFrom ?? CLIENT },
    to: [{ name: "Mitchell", email: OWN_EMAIL }],
    cc: (opts.cc ?? []).map((email) => ({ name: null, email })),
    sentAt: opts.sentAt ?? minutesAgo(120)
  });
  const his = [inbound, ...(opts.extra ?? [])];
  const all: MessageMeta[] = his.map((m) => ({
    id: m.id,
    accountId: m.accountId,
    direction: m.direction,
    from: m.from?.email ?? "",
    to: m.to.map((a) => a.email),
    cc: m.cc.map((a) => a.email),
    rfcMessageId: m.rfcMessageId,
    inReplyTo: m.inReplyTo,
    createdAtMs: m.createdAtMs,
    sentAt: m.sentAt
  }));
  return {
    threadId: THREAD,
    participants: [],
    his,
    all,
    snapshot: { identityCount: his.length, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: T0, readDoneAtMs: T0 },
    lastMessageAt: null
  };
}

// ---------------------------------------------------------------------------
// exec_drafts rows (snake_case, valid under the §2.1 CHECK subset)
// ---------------------------------------------------------------------------

const DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Thanks, we're on it." }] }] };

/** A reply draft in `draft`, DD-only, with body and derived recipients. */
export function draftRow(over: Row = {}): Row {
  const now = new Date();
  return {
    ...draftDefaults(now),
    id: ID1,
    principal_id: PRINCIPAL.id,
    account_id: HIS,
    kind: "reply",
    status: "draft",
    version: 1,
    thread_id: THREAD,
    parent_message_id: PARENT,
    reply_mode: "reply",
    thread_subject: "Website update",
    reply_candidates: { from: { address: CLIENT, name: "Client" }, to: [], cc: [] },
    thread_addresses: [CLIENT, OWN_EMAIL],
    to_recipients: [{ address: CLIENT, name: "Client" }],
    body_doc: DOC,
    body_html: "<p>Thanks, we're on it.</p>",
    body_text: "Thanks, we're on it.",
    screen_hashes: [],
    screen_truncated: false,
    screened_policy_hash: EMPTY_POLICY_HASH,
    render_nonce: "0123456789abcdef01234567",
    created_at: minutesAgo(30),
    updated_at: minutesAgo(30),
    ...over
  };
}

/** A saved reply draft linked to GRAPH, content hash HASH_A. */
export function savedRow(over: Row = {}): Row {
  return draftRow({
    status: "saved",
    saved_version: 1,
    outlook_graph_id: GRAPH,
    internet_message_id: "<draft.1@outlook.com>",
    web_link: "https://outlook.office365.com/owa/?ItemID=x",
    content_hash: HASH_A,
    observed_content_hash: HASH_A,
    recipients_sig: null,
    ...over
  });
}

/** A saved row with a valid review (HASH_A, now) and its recipients. */
export function reviewedRow(over: Row = {}): Row {
  return savedRow({
    review_hash: HASH_A,
    review_at: new Date().toISOString(),
    review_blockers: [],
    review_recipients: { from: null, sender: null, replyTo: [], to: [{ address: CLIENT, name: "Client" }], cc: [], bcc: [] },
    ...over
  });
}

/** A new (non-reply) draft. */
export function newDraftRow(over: Row = {}): Row {
  return draftRow({
    kind: "new",
    thread_id: null,
    parent_message_id: null,
    reply_mode: null,
    thread_subject: null,
    reply_candidates: null,
    thread_addresses: [],
    subject: "Quick update",
    screened_policy_hash: null,
    ...over
  });
}

export function rowOf(db: FakeDraftsDb, id = ID1): Row {
  const r = (db.tables.exec_drafts ?? []).find((x) => x.id === id);
  if (!r) throw new Error(`no exec_drafts row ${id}`);
  return r;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function jsonRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "sec-fetch-site": "same-origin", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(`https://ops.test${path}`, { method, headers: h, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The setup
// ---------------------------------------------------------------------------

export interface DraftEnv {
  db: FakeDraftsDb;
  fake: FakeCl2;
  settings: ExecSettings;
  auditIds: { n: number };
}

export interface DraftEnvOptions {
  rows?: Row[];
  audit?: Row[];
  settings?: Partial<ExecSettings>;
  clone?: FakeCl2Options;
  db?: Omit<FakeDraftsDbConfig, "tables">;
  thread?: PrincipalMailThread;
  clients?: DdClientMatchSignals[];
}

/** One call per test: the fake DB and the CL2 fake, the env tokens, every mock's default. */
export function setupDraftEnv(opts: DraftEnvOptions = {}): DraftEnv {
  vi.clearAllMocks();
  invalidateEaReadiness();
  const db = createFakeDraftsDb({ ...(opts.db ?? {}), tables: { exec_drafts: [...(opts.rows ?? [])], exec_audit_log: [...(opts.audit ?? [])] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  const fake = installFakeCl2(vi.stubGlobal, { draftToken: DRAFT_TOKEN, sendToken: SEND_TOKEN, accounts: [HIS], send: "all", ...(opts.clone ?? {}) });
  process.env.MISSIVE_EA_TOKEN = DRAFT_TOKEN;
  process.env.MISSIVE_EA_SEND_TOKEN = SEND_TOKEN;
  const settings = settingsOn(opts.settings);
  const auditIds = { n: 100 };

  vi.mocked(requireExecPrincipal).mockImplementation(async () => ({ ok: true, principal: PRINCIPAL }));
  vi.mocked(loadSettings).mockImplementation(async () => settings);
  vi.mocked(countEnabledMailPinnedPrincipals).mockResolvedValue(1);
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.mocked(putSyncState).mockResolvedValue(undefined);
  vi.mocked(auditStart).mockImplementation(async () => (auditIds.n += 1));
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(auditEvent).mockResolvedValue(undefined);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(notifyOps).mockResolvedValue(false);
  vi.mocked(getEmailThread).mockResolvedValue(null);
  vi.mocked(listCorrespondentRows).mockResolvedValue([]);
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(getMailTimezone).mockResolvedValue("America/New_York");
  vi.mocked(listUsers).mockResolvedValue([]);
  vi.mocked(listClientMatchSignals).mockResolvedValue(opts.clients ?? []);
  const internal = { addresses: [OWN_EMAIL], domains: ["scaledai.org"] };
  vi.mocked(listInternalAddresses).mockResolvedValue(internal);
  vi.mocked(loadClientMatcher).mockImplementation(async () => buildClientMatcher(opts.clients ?? [], internal));
  vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([]));
  const thread = opts.thread ?? threadFixture();
  vi.mocked(readPrincipalThread).mockImplementation(async () => ({ kind: "ok", thread }));
  vi.mocked(findSentCopy).mockResolvedValue("not_found");
  vi.mocked(listReplyArtifacts).mockResolvedValue(new Map());
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return { db, fake, settings, auditIds };
}

/** The gate refusing (non-owner, link session) or failing (outage). */
export function gateAnswers(status: 401 | 404 | 503): void {
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status }) });
}

/** The draft rows as ExecDraftRow-ish views for assertions. */
export function statusOf(db: FakeDraftsDb, id = ID1): ExecDraftRow["status"] {
  return rowOf(db, id).status as ExecDraftRow["status"];
}
