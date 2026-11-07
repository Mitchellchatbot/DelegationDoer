import "server-only";

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { docToEmailHtml, plainTextToDoc } from "@/lib/email-doc";
import { looksRoleAddress, looksUnreplyable } from "@/lib/email-intake-filters";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { CloneEaError, type CloneDraftRead, type CloneReadBack } from "@/lib/exec/clone-ea-types";
import { isActiveClientStatus, loadClientMatcher } from "@/lib/exec/correlate";
import { buildBody, findPlaceholders, insertSafeProblems, validateBodyDoc } from "@/lib/exec/drafts-doc";
import {
  REVIEW_CLEARED_PATCH,
  applyDraftPatch,
  attentionRank,
  auditCode,
  canOfferNewReply,
  capabilitiesFor,
  changedSinceSaved,
  computeReviewBlockers,
  deleteKey,
  draftAttention,
  graphIdFp,
  guard,
  hasLink,
  isStaleLink,
  knownFlags,
  linkReplacement,
  mapCreateResult,
  mapDeleteResult,
  mapGetResult,
  mapRecreateResult,
  mirrorRegistry,
  newKeyNonce,
  nextCheckAt,
  pastSendHorizon,
  priorStatusOf,
  resolveRecreateByGet,
  reviewIsValid,
  saveKey,
  saveOutcomeUnknown,
  terminalPatch,
  type CloneAnswer,
  type DraftAction,
  type DraftPatch,
  type GuardContext,
  type Transition,
  type TransitionOptions
} from "@/lib/exec/drafts-state";
import {
  casDraft,
  countRecentAudit,
  getActiveDraftForThread,
  getDraft,
  getLatestDraftForParent,
  insertDraft,
  listDrafts,
  listDraftsForParent,
  purgeDraftsForThreads,
  type CasExpect,
  type NewDraftRow
} from "@/lib/exec/drafts-store";
import {
  CL2_MAPPED_TIMEZONES,
  DRAFT_LIMITS,
  REVIEW_BLOCKERS,
  type DraftAddress,
  type DraftCapabilities,
  type DraftErrorCode,
  type DraftKind,
  type DraftListItem,
  type DraftView,
  type ExecDraftRow,
  type ExecDraftStatus,
  type NewDraftSeed,
  type PriorStatus,
  type ReadBackView,
  type RecipientSuggestion,
  type RecipientView,
  type ReplyMode,
  type ResolveAction,
  type ReviewBlocker,
  type ReviewRecipients,
  type ReviewResult,
  type SendUnavailable,
  type SentCopyResult
} from "@/lib/exec/drafts-types";
import { toReadBackView, type ReadBackViewContext } from "@/lib/exec/drafts-view";
import { getEmailThread, listCorrespondentRows, listThreadScreenRows } from "@/lib/exec/email-store";
import type { ExecEmailThread, PrincipalMailThread, ReplyArtifacts, ThreadScreenRow } from "@/lib/exec/email-types";
import { draftGenerateJob } from "@/lib/exec/handlers/draft-generate";
import { alertTransition, casTransition, checkDraftOnce, cloneGet, draftReconcileKick, KICK_DELAY_MS } from "@/lib/exec/handlers/draft-reconcile";
import { jsonAnswer, jsonError, readJsonBody } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import {
  checkRecipients,
  deriveReplyRecipients,
  factsRecipientsOutside,
  normalizeDraftAddress,
  recipientsSignature,
  type DerivedReply,
  type DraftAddressInput,
  type FactsGate,
  type RecipientCheck,
  type RecipientContext
} from "@/lib/exec/recipients";
import { getMailTimezone, listClientMatchSignals, listUsers } from "@/lib/exec/sources/dd";
import {
  createNewDraft,
  createReplyDraft,
  deleteOutlookDraft,
  findSentCopy,
  getEaReadiness,
  isPinnedAccount,
  listInternalAddresses,
  listReplyArtifacts,
  loadScreeningPolicy,
  peekEaReadiness,
  pinnedAccounts,
  readPrincipalThread,
  recreateOutlookDraft,
  screenHashesFor,
  screenRestricted,
  screenStoredRow,
  usableAccounts,
  type EaReadiness
} from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, parseSendTokenState, problemAccountIds, type SendTokenState } from "@/lib/exec/sync-state";
import { cutQuotedText, htmlToText } from "@/lib/exec/triage/email-text";
import { AuditUnavailableError, NonRetryableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import { addressMatches, type RestrictedSenderRule } from "@/lib/restricted-senders";

// The service layer the P4 routes and pages call (P4 contract §3.12; Area D).
//
// Every route runs the gates of §3.12.2 in this order: the owner gate with the
// step-up and same-origin (in the route file itself, boundary B11), the id
// (G3), the body (G4), settings (G5 installed, G5b switched on), the account
// (G6), the rate limit (G7, from the audit log), EA readiness (G8, only for the
// actions that call the clone), the row (G9), the render-time screen (G10,
// which purges a restricted reply draft, T54) and the state guard (G11,
// drafts-state's guard). Every status change is a counted CAS (casDraft) under
// the key family of §2.5; zero rows re-read the row and answer 409.
//
// Clone calls never take the request's signal (L9, L10.4): each has its own
// timeout in sources/mail.ts. A side effect on his mailbox (save, delete) is
// audited first and refused when the audit row can't be written. The send
// flow lives in the send route file, the only importer of send.ts (B3); the
// helpers it needs are exported from here.
//
// Content stays in exec_drafts and in the answers to him (§0.3 rule 5): log
// lines, audit rows and alerts carry ids, counts, codes and fingerprints only.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAFT_ID_RE = /^ed_[0-9a-f]{32}$/;
/** exec_drafts.thread_id's CHECK (clone ids). */
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RATE_WINDOW_MS = 600_000;
/** C4: the route's thread reads (create, review) and the matcher (C62). */
const ROUTE_THREAD_TIMEOUT_MS = 15_000;
const MATCHER_TIMEOUT_MS = 15_000;
const INTERNAL_TIMEOUT_MS = 15_000;
const MAX_THREAD_SUBJECT_CHARS = 200;
const MAX_SUGGESTIONS = 1_000;
const MIN_MS = 60_000;

/** C56: request body caps. */
export const DRAFT_BODY_LIMITS = Object.freeze({ create: 16 * 1024, patch: 96 * 1024, other: 8 * 1024 });
/** C38: per principal, audit rows of the action in the last 10 min. */
export const DRAFT_RATE_LIMITS: Readonly<Record<RateAction, number>> = Object.freeze({
  "draft.generate.request": 20,
  "draft.save": 30,
  "draft.review": 30,
  "draft.send": 10,
  "draft.check": 30
});
export type RateAction = "draft.generate.request" | "draft.save" | "draft.review" | "draft.send" | "draft.check";

const iso = (ms: number) => new Date(ms).toISOString();
const lower = (s: string) => s.trim().toLowerCase();
const errorName = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : "error");
const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

// ---------------------------------------------------------------------------
// Errors and answers
// ---------------------------------------------------------------------------

export interface DraftGates { settings: ExecSettings; usable: readonly string[]; ownAddresses: ReadonlySet<string>; accountEmail: (accountId: string) => string | null }

/** Throws a typed DraftRouteError { status, code, extra } that the routes turn into jsonError. */
export class DraftRouteError extends Error {
  readonly httpStatus: number;
  readonly code: DraftErrorCode;
  readonly extra: Record<string, unknown>;
  constructor(httpStatus: number, code: DraftErrorCode, extra: Record<string, unknown> = {}) {
    super(`draft route ${httpStatus} ${code}`);
    this.name = "DraftRouteError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.extra = extra;
  }
}

function fail(status: number, code: DraftErrorCode, extra: Record<string, unknown> = {}): never {
  throw new DraftRouteError(status, code, extra);
}

/**
 * The route wrapper (additive): runs the route body and turns a
 * DraftRouteError into its answer; an audit outage is 503 audit_unavailable;
 * anything else is 503 unavailable with one log line (the route and the
 * error's name, never its message, which may quote a value).
 */
export async function answerDraftRoute(route: string, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DraftRouteError) return jsonError(err.httpStatus, err.code, err.extra);
    if (err instanceof AuditUnavailableError) return jsonError(503, "audit_unavailable");
    const code = typeof (err as { code?: unknown })?.code === "string" ? String((err as { code: string }).code) : "none";
    console.error(`[exec-drafts] ${route}: ${errorName(err)} (${auditCode(code)})`);
    return jsonError(503, "unavailable");
  }
}

/** G3: `ed_` + 32 hex, else 404. */
export function requireDraftId(raw: unknown): string {
  if (typeof raw !== "string" || !DRAFT_ID_RE.test(raw)) fail(404, "not_found");
  return raw as string;
}

/** G4: the body, bounded (C56), parsed, then the shape; size, syntax and shape are a 400. */
export async function parseDraftBody<T>(req: Request, maxBytes: number, schema: z.ZodType<T>): Promise<T> {
  const read = await readJsonBody(req, maxBytes);
  if (!read.ok) fail(400, "bad_request");
  const parsed = schema.safeParse((read as { ok: true; value: unknown }).value);
  if (!parsed.success) fail(400, "bad_request");
  return (parsed as { success: true; data: T }).data;
}

// ---------------------------------------------------------------------------
// Request bodies (R2-R12), .strict(): an unknown key is a 400
// ---------------------------------------------------------------------------

export type CreateDraftInput =
  | { kind: "reply"; threadId: string; generate: boolean; instruction?: string; replyAll?: boolean; checkedOutlook?: boolean }
  | { kind: "new"; generate: boolean; instruction?: string; accountId?: string; to: DraftAddressInput[]; cc?: DraftAddressInput[]; bcc?: DraftAddressInput[]; subject?: string };
export interface EditDraftInput {
  version: number; bodyDoc?: unknown; subject?: string | null;
  to?: DraftAddressInput[]; cc?: DraftAddressInput[]; bcc?: DraftAddressInput[]; replyAll?: boolean;
}
export interface RegenerateInput { version: number; instruction?: string | null }
/** confirmPrivate (P5b F3, C45): his "I've checked it" on a draft started in a chat that read other private material. */
export interface SaveInput { version: number; seenContentHash?: string; confirmPrivate?: true }
export interface DiscardInput { version: number; seenContentHash?: string; confirmRestrictedDelete?: true }
export interface ReviewInput { version: number }
export interface SendInput { reviewHash: string; acks: ReviewBlocker[] }
export interface ResolveInput { action: ResolveAction; checkedOutlook?: boolean; seenContentHash?: string }

const versionField = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hex64 = z.string().regex(HEX64_RE);
const addressInput = z.object({ address: z.string().max(1_000), name: z.string().max(1_000).nullable().optional() }).strict();
const addressList = z.array(addressInput).max(100);
const reviewBlocker = z.custom<ReviewBlocker>((v) => typeof v === "string" && (REVIEW_BLOCKERS as readonly string[]).includes(v));
const RESOLVE_ACTIONS = ["mark_sent", "not_sent_new_draft", "copy_to_new_draft", "keep_outlook_version", "check", "stop_generation"] as const;

export const CreateDraftBody: z.ZodType<CreateDraftInput> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reply"),
    threadId: z.string().max(200),
    generate: z.boolean(),
    instruction: z.string().optional(),
    replyAll: z.boolean().optional(),
    checkedOutlook: z.boolean().optional()
  }).strict(),
  z.object({
    kind: z.literal("new"),
    generate: z.boolean(),
    instruction: z.string().optional(),
    accountId: z.string().max(200).optional(),
    to: addressList,
    cc: addressList.optional(),
    bcc: addressList.optional(),
    subject: z.string().optional()
  }).strict()
]);
export const EditDraftBody: z.ZodType<EditDraftInput> = z.object({
  version: versionField,
  bodyDoc: z.unknown().optional(),
  subject: z.string().nullable().optional(),
  to: addressList.optional(),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  replyAll: z.boolean().optional()
}).strict();
export const RegenerateBody: z.ZodType<RegenerateInput> = z.object({ version: versionField, instruction: z.string().nullable().optional() }).strict();
export const SaveBody: z.ZodType<SaveInput> = z.object({ version: versionField, seenContentHash: hex64.optional(), confirmPrivate: z.literal(true).optional() }).strict();
export const DiscardBody: z.ZodType<DiscardInput> = z.object({
  version: versionField,
  seenContentHash: hex64.optional(),
  confirmRestrictedDelete: z.literal(true).optional()
}).strict();
export const ReviewBody: z.ZodType<ReviewInput> = z.object({ version: versionField }).strict();
export const SendBody: z.ZodType<SendInput> = z.object({
  reviewHash: hex64,
  // R10 says "≤10", written before v2 added facts_outside_client and unexpected_content: every
  // ackable blocker (C20, 12 today) must fit, or a review raising them all could never be sent.
  acks: z.array(reviewBlocker).max(REVIEW_BLOCKERS.length).refine((list) => new Set(list).size === list.length)
}).strict();
export const ResolveBody: z.ZodType<ResolveInput> = z.object({
  action: z.enum(RESOLVE_ACTIONS),
  checkedOutlook: z.boolean().optional(),
  seenContentHash: hex64.optional()
}).strict();
/** R11's body: `{}` (additive). */
export const OutlookOpenedBody: z.ZodType<Record<string, never>> = z.object({}).strict();

// ---------------------------------------------------------------------------
// Gates (§3.12.2)
// ---------------------------------------------------------------------------

/** Settings, the usable pinned accounts, his own addresses and each account's address (C22). */
export async function loadDraftGates(principal: ExecPrincipal): Promise<DraftGates> {
  const [settings, accountsState] = await Promise.all([
    loadSettings(principal.id),
    getSyncState(principal, "mail", "accounts", parseAccountsState)
  ]);
  const accounts = accountsState?.value ?? null;
  const usable = usableAccounts(principal, problemAccountIds(accounts));
  const pinned = new Set(pinnedAccounts(principal));
  const emails = new Map<string, string>();
  for (const a of accounts?.accounts ?? []) {
    const address = lower(a.email);
    if (pinned.has(a.id) && address.includes("@")) emails.set(a.id, address);
  }
  const own = new Set<string>();
  const mine = lower(principal.email);
  if (mine.includes("@")) own.add(mine);
  for (const address of emails.values()) own.add(address);
  return {
    settings,
    usable,
    ownAddresses: own,
    accountEmail: (accountId) => emails.get(accountId) ?? (pinned.has(accountId) && mine.includes("@") ? mine : null)
  };
}

/** G5: the P4 schema is installed; otherwise the feature doesn't exist (404). */
export function requireInstalled(gates: DraftGates): void {
  if (!gates.settings.draftsSchemaReady) fail(404, "not_found");
}

/** C25: drafts on = the switch, email on and installed, and a pin. */
export function draftsSwitchedOn(gates: DraftGates, principal: ExecPrincipal): boolean {
  const s = gates.settings;
  return s.draftsSchemaReady && s.draftsEnabled && s.emailEnabled && s.emailSchemaReady && pinnedAccounts(principal).length > 0;
}

/** G5b: mutations need drafts on (409 drafts_off); a send also needs send_enabled (409 send_off). */
export function requireDraftsOn(gates: DraftGates, principal: ExecPrincipal, opts: { send?: boolean } = {}): void {
  if (!draftsSwitchedOn(gates, principal)) fail(409, "drafts_off");
  if (opts.send === true && !gates.settings.sendEnabled) fail(409, "send_off");
}

/** G6: the account is pinned and not a problem account. */
export function requireUsableAccount(gates: DraftGates, accountId: string): void {
  if (gates.usable.length === 0 || !gates.usable.includes(accountId)) fail(409, "mailbox_problem");
}

/** G7 (C38): 429 rate_limited with Retry-After 60 once the action's count in the last 10 min reaches its limit. */
export async function requireRateLimit(principal: ExecPrincipal, action: RateAction, now: Date): Promise<void> {
  const since = iso(now.getTime() - RATE_WINDOW_MS);
  const count = await countRecentAudit(principal, action, since);
  if (count >= DRAFT_RATE_LIMITS[action]) fail(429, "rate_limited", { retryAfterSec: 60 });
}

/** G8 (C24): EA readiness, cached per process (L4). A read error is 503; not ready is 409 drafts_unavailable + reason. */
export async function requireReadiness(principal: ExecPrincipal): Promise<EaReadiness> {
  let ea: EaReadiness;
  try {
    ea = await getEaReadiness(principal);
  } catch (err) {
    console.warn(`[exec-drafts] EA readiness could not be checked (${errorName(err)})`);
    return fail(503, "unavailable");
  }
  if (!ea.ok) fail(409, "drafts_unavailable", { reason: ea.reason ?? "clone_unreachable" });
  return ea;
}

/** G9: the row by (id, principal), else 404. */
export async function loadRowOrThrow(principal: ExecPrincipal, id: string): Promise<ExecDraftRow> {
  const row = await getDraft(principal, id);
  if (row === null) fail(404, "not_found");
  return row as ExecDraftRow;
}

/** The retention a transition writes into expires_at (A's TransitionOptions). */
export function transitionOptions(gates: DraftGates): TransitionOptions {
  return { retentionDays: gates.settings.retentionDaysEmail };
}

// ---------------------------------------------------------------------------
// The render-time screen (C11, G10)
// ---------------------------------------------------------------------------

/**
 * C11's render-time screen (G10, the list, the pages): P3's screenStoredRow on the draft's own
 * (screen_hashes, screen_truncated, screened_policy_hash), plus restricted_purged, plus the P3 thread row when given.
 * Pure given its inputs; policy = loadScreeningPolicy's { rules, hash } (strict).
 */
export function screenDraftRow(row: Pick<ExecDraftRow, "kind" | "restrictedPurged" | "screenHashes" | "screenTruncated" | "screenedPolicyHash">,
  policy: { rules: readonly RestrictedSenderRule[]; hash: string }, p3Row: ThreadScreenRow | null):
  { restricted: boolean; reason: "purged" | "rule_match" | "stale_truncated" | "thread_row" | null } {
  if (row.restrictedPurged) return { restricted: true, reason: "purged" };
  if (row.kind === "reply") {
    // A truncated set with no stored policy hash can't be judged: it fails closed (screenStoredRow: null !== hash).
    const own = screenStoredRow(
      { state: "triaged", screenHashes: row.screenHashes, screenTruncated: row.screenTruncated, screenedPolicyHash: row.screenedPolicyHash },
      policy.rules,
      policy.hash
    );
    if (own.verdict === "restricted") return { restricted: true, reason: own.reason === "rule_match" ? "rule_match" : "stale_truncated" };
  }
  if (p3Row !== null && screenStoredRow(p3Row, policy.rules, policy.hash).verdict === "restricted") return { restricted: true, reason: "thread_row" };
  return { restricted: false, reason: null };
}

export interface ScreenedRow {
  row: ExecDraftRow;
  restricted: boolean;
  policy: { rules: RestrictedSenderRule[]; hash: string };
  p3Row: ExecEmailThread | null;
}

/** The screening policy, strictly: a failed rules read is 503 unavailable, never "clean". */
async function policyOrThrow(principal: ExecPrincipal): Promise<{ rules: RestrictedSenderRule[]; hash: string }> {
  try {
    return await loadScreeningPolicy(principal);
  } catch (err) {
    console.warn(`[exec-drafts] screening rules could not be read (${errorName(err)})`);
    return fail(503, "unavailable");
  }
}

/** T54: a restricted reply draft's thread is purged through the RPC; one audit event with the count. */
async function purgeRestrictedThread(principal: ExecPrincipal, row: ExecDraftRow): Promise<void> {
  if (row.kind !== "reply" || row.threadId === null) return;
  const purged = await purgeDraftsForThreads(principal, [row.threadId]);
  await auditEvent(principal, {
    actor: "owner",
    action: "draft.purge_restricted",
    target: `exec_drafts:${row.id}`,
    input: { draftId: row.id, counts: purged ?? 0 }
  });
}

/**
 * G10: screens the row with freshly loaded rules; a restricted reply draft is
 * purged (T54) and re-read, so the caller sees its content-free state.
 */
export async function screenOrPurge(principal: ExecPrincipal, row: ExecDraftRow): Promise<ScreenedRow> {
  const policy = await policyOrThrow(principal);
  let p3Row: ExecEmailThread | null = null;
  if (row.kind === "reply" && row.threadId !== null) p3Row = await getEmailThread(principal, row.threadId);
  const verdict = screenDraftRow(row, policy, p3Row);
  if (!verdict.restricted) return { row, restricted: false, policy, p3Row };
  if (!row.restrictedPurged) {
    await purgeRestrictedThread(principal, row);
    const reread = await getDraft(principal, row.id);
    if (reread !== null) return { row: reread, restricted: true, policy, p3Row };
  }
  return { row, restricted: true, policy, p3Row };
}

// ---------------------------------------------------------------------------
// Readiness for display (C19) and the guard context
// ---------------------------------------------------------------------------

/** The persisted clone-ea/send-token verdict (C19: never the network); null when none or unreadable. */
async function sendTokenVerdict(principal: ExecPrincipal): Promise<SendTokenState | null> {
  try {
    return (await getSyncState(principal, "clone-ea", "send-token", parseSendTokenState))?.value ?? null;
  } catch {
    return null;
  }
}

/** The in-process verdict, else the persisted one; null when neither exists or it can't be read. */
async function peekReadiness(principal: ExecPrincipal): Promise<EaReadiness | null> {
  try {
    return await peekEaReadiness(principal);
  } catch {
    return null;
  }
}

/** Why Send is off for display (null = offer it; the send route re-checks everything). */
export function sendUnavailableFor(settings: ExecSettings, ea: EaReadiness | null, sendToken: Pick<SendTokenState, "ok"> | null): SendUnavailable | null {
  if (!settings.sendEnabled) return "send_off";
  if (ea === null) return "clone_unreachable";
  if (!ea.ok) return ea.reason ?? "clone_unreachable";
  if (ea.cl2Send === "off" || ea.cl2Send === null || !ea.sendEnabled) return "clone_send_off";
  if (sendToken !== null && !sendToken.ok) return "send_token";
  return null;
}

/** Why drafting is off for this row (null = on). */
function draftsUnavailableFor(principal: ExecPrincipal, gates: DraftGates, ea: EaReadiness | null, accountId: string | null):
  DraftCapabilities["draftsUnavailable"] {
  if (!draftsSwitchedOn(gates, principal)) return "drafts_off";
  if (gates.usable.length === 0 || (accountId !== null && !gates.usable.includes(accountId))) return "mailbox_problem";
  if (ea === null) return "clone_unreachable";
  if (!ea.ok) return ea.reason ?? "clone_unreachable";
  return null;
}

interface GuardInputs {
  principal: ExecPrincipal;
  gates: DraftGates;
  ea: EaReadiness | null;
  sendToken: Pick<SendTokenState, "ok"> | null;
  restricted: boolean;
  now: Date;
}

function guardContext(row: ExecDraftRow, g: GuardInputs, extra: { checkedOutlook?: boolean; sentCopy?: SentCopyResult } = {}): GuardContext & {
  draftsUnavailable: DraftCapabilities["draftsUnavailable"]; sendUnavailable: SendUnavailable | null } {
  const draftsUnavailable = draftsUnavailableFor(g.principal, g.gates, g.ea, row.accountId);
  const sendUnavailable = sendUnavailableFor(g.gates.settings, g.ea, g.sendToken);
  // draftsOn = the switches and a usable pin (C25); a problem account only stops what calls the clone.
  const draftsOn = draftsSwitchedOn(g.gates, g.principal) && g.gates.usable.length > 0;
  return {
    now: g.now,
    draftsOn,
    sendOn: g.gates.settings.sendEnabled,
    draftsReady: g.ea !== null && g.ea.ok && g.gates.usable.includes(row.accountId),
    sendReady: sendUnavailable === null,
    restricted: g.restricted,
    ...extra,
    draftsUnavailable,
    sendUnavailable
  };
}

/** G11: the state guard; a refusal is 409 with its code (404 for the restricted refusals). */
function requireGuard(action: DraftAction, row: ExecDraftRow, ctx: ReturnType<typeof guardContext>): void {
  const g = guard(action, row, ctx);
  if (g.ok) return;
  const code = g.code;
  if (code === "not_found") fail(404, "not_found");
  if (code === "drafts_unavailable") fail(409, code, { reason: ctx.draftsUnavailable ?? "clone_unreachable" });
  if (code === "send_unavailable") fail(409, code, { reason: ctx.sendUnavailable ?? "send_token" });
  fail(409, code, code === "state_conflict" ? { status: row.status } : {});
}

// ---------------------------------------------------------------------------
// Recipients (L8, C7, C9, C62)
// ---------------------------------------------------------------------------

/** His addresses' domains: what the DB-only paths treat as internal (badges, warnings). */
function ownDomains(gates: DraftGates): Set<string> {
  return new Set([...gates.ownAddresses].map(domainOf).filter((d) => d !== ""));
}

/** listInternalAddresses' domains (one clone read, 15 s); his own domains when it fails (they only shape warnings). */
async function internalDomainsLive(principal: ExecPrincipal, gates: DraftGates): Promise<Set<string>> {
  const out = ownDomains(gates);
  try {
    const internal = await listInternalAddresses(principal, { timeoutMs: INTERNAL_TIMEOUT_MS });
    for (const d of internal.domains) out.add(lower(d));
  } catch (err) {
    console.warn(`[exec-drafts] internal domains unavailable (${errorName(err)})`);
  }
  return out;
}

/** DD-resolved contacts: internal users' and active clients' exact contact addresses (L8). */
async function ddContacts(principal: ExecPrincipal): Promise<Map<string, RecipientSuggestion>> {
  const [users, clients] = await Promise.all([listUsers(principal), listClientMatchSignals(principal)]);
  const out = new Map<string, RecipientSuggestion>();
  for (const u of users) {
    const a = normalizeDraftAddress({ address: u.email, name: u.name });
    if (a !== null && !out.has(a.address)) out.set(a.address, { address: a.address, name: a.name, source: "internal" });
  }
  for (const c of clients) {
    if (!isActiveClientStatus(c.status)) continue;
    for (const e of c.contactEmails) {
      const a = normalizeDraftAddress({ address: e, name: c.name });
      if (a !== null && !out.has(a.address)) out.set(a.address, { address: a.address, name: a.name, source: "client" });
    }
  }
  return out;
}

/** The reply's default lists from its stored candidates (C7, C8): To = the anchor's From (follow-up: its To); Cc only with Reply all. */
function derivedLists(row: Pick<ExecDraftRow, "replyCandidates" | "replyMode" | "toRecipients">, replyAll: boolean): { to: DraftAddress[]; cc: DraftAddress[] } {
  const c = row.replyCandidates;
  if (c === null) return { to: [...row.toRecipients], cc: [] };
  if (row.replyMode === "follow_up") return { to: [...c.to], cc: replyAll ? [...c.cc] : [] };
  const seen = new Set<string>([c.from.address]);
  const cc: DraftAddress[] = [];
  for (const a of [...c.to, ...c.cc]) {
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    cc.push(a);
  }
  return { to: [c.from], cc: replyAll ? cc : [] };
}

function addressSet(list: readonly DraftAddress[]): Set<string> {
  return new Set(list.map((a) => a.address));
}

/** The C62 gate for the row's facts client (the matcher, 15 s); a matcher failure is 503, never "inside". */
async function factsGateFor(principal: ExecPrincipal, gates: DraftGates, clientId: string): Promise<FactsGate> {
  try {
    const matcher = await loadClientMatcher(principal, { timeoutMs: MATCHER_TIMEOUT_MS });
    return {
      clientId,
      ownAddresses: gates.ownAddresses,
      isInternal: (address) => matcher.isInternal(address),
      match: (address) => {
        const r = matcher.match([address]);
        return { clientId: r.clientId, via: r.via, candidates: r.candidates };
      }
    };
  } catch (err) {
    console.warn(`[exec-drafts] the client matcher could not be loaded (${errorName(err)})`);
    return fail(503, "unavailable");
  }
}

function recipientContext(kind: DraftKind, gates: DraftGates, internalDomains: ReadonlySet<string>, rules: readonly RestrictedSenderRule[],
  opts: { allowed: ReadonlySet<string> | null; derivedTo?: ReadonlySet<string>; derivedCc?: ReadonlySet<string>; expectedFrom?: string | null }): RecipientContext {
  return {
    kind,
    ownAddresses: gates.ownAddresses,
    internalDomains,
    restrictedRules: rules,
    allowed: opts.allowed,
    derivedTo: opts.derivedTo ?? new Set<string>(),
    derivedCc: opts.derivedCc ?? new Set<string>(),
    expectedFrom: opts.expectedFrom ?? null
  };
}

function recipientsBlocked(check: Extract<RecipientCheck, { ok: false }>): never {
  return fail(422, "recipients_blocked", { errors: check.errors.map((e) => ({ code: e.code, address: e.address })) });
}

/** The allowed set for a reply's Cc additions: thread participants ∪ DD-resolved contacts (C7). */
async function replyAllowed(principal: ExecPrincipal, row: Pick<ExecDraftRow, "threadAddresses">): Promise<Set<string>> {
  const out = new Set<string>(row.threadAddresses.map(lower));
  for (const a of (await ddContacts(principal)).keys()) out.add(a);
  return out;
}

/** The allowed set of a new draft (L8): internal users, client contacts, screened correspondents. */
async function newDraftAllowed(principal: ExecPrincipal, gates: DraftGates, policy: { rules: RestrictedSenderRule[]; hash: string }): Promise<Set<string>> {
  return new Set((await suggestionsFor(principal, gates, policy)).map((s) => s.address));
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/** AM7: a render nonce of 24 hex characters (within ^[A-Za-z0-9]{16,64}$; never base64url). */
function newRenderNonce(): string {
  return randomBytes(12).toString("hex");
}

/** An empty TipTap document and its rebuilt body ("Write it myself", C27). */
function emptyBody(): { bodyDoc: NewDraftRow["bodyDoc"]; bodyHtml: string; bodyText: string } {
  const doc = plainTextToDoc("");
  return { bodyDoc: doc, bodyHtml: docToEmailHtml(doc), bodyText: "" };
}

/** Every NewDraftRow field with its blank value; the caller spreads what the transition sets (rule 11: one key set). */
function blankRow(principal: ExecPrincipal, accountId: string, kind: DraftKind): NewDraftRow {
  return {
    principalId: principal.id, accountId, kind, origin: "web",
    status: "draft", priorStatus: null, version: 1, savedVersion: null, generationSeq: 0,
    threadId: null, parentMessageId: null, replyMode: null, threadSubject: null, replyCandidates: null, threadAddresses: [],
    toRecipients: [], ccRecipients: [], bccRecipients: [], subject: null,
    bodyDoc: null, bodyHtml: null, bodyText: null, instruction: null, noteForMitchell: null, placeholders: [],
    reviewRecipients: null, recipientsSig: null, screenHashes: [], screenTruncated: false, screenedPolicyHash: null,
    renderNonce: newRenderNonce(), model: null, usage: null, generationError: null, generationFlags: [],
    factsStatus: null, clientId: null, generatedAt: null,
    outlookGraphId: null, internetMessageId: null, conversationId: null, webLink: null,
    contentHash: null, observedContentHash: null, reviewHash: null, reviewAt: null, reviewBlockers: [],
    confirmHash: null, saveAttemptKey: null, saveVersion: null, saveTimezone: null, saveIfContentHash: null, saveStartedAt: null,
    discardAttemptKey: null, discardStartedAt: null, sendAttemptKey: null, sendStartedAt: null, sendAcceptedAt: null, sentAt: null,
    sentAuditId: null, sentMismatch: false, unverified: false, goneUnconfirmed: false, signatureSkipped: false, outlookEdited: false,
    restrictedPurged: false, usesPrivateRefs: false, cloneFlags: [], ownerResolution: null, openedInOutlookAt: null,
    lastErrorCode: null, lastErrorAt: null, nextCheckAt: null, checkCount: 0, goneAt: null, terminalAt: null,
    contentPurgedAt: null, expiresAt: null,
    // P5b F7 (C44): every web insert (R2, new drafts, successors' base) is his own instruction.
    instructionBy: "owner",
    // P5b (security-2): no chat answer wrote a web insert.
    chatMessageId: null
  };
}

/** A clipped, single-line thread subject (exec_drafts.thread_subject ≤ 200). */
function threadSubjectOf(subject: string | null | undefined): string | null {
  if (typeof subject !== "string") return null;
  const s = subject.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (s === "") return null;
  return s.length > MAX_THREAD_SUBJECT_CHARS ? s.slice(0, MAX_THREAD_SUBJECT_CHARS) : s;
}

/** A new draft's subject: one line, ≤ 998; empty → null; a newline or a longer one is a 422. */
function cleanSubject(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (/[\r\n]/.test(s) || s.length > DRAFT_LIMITS.subjectChars) fail(422, "invalid", { problems: ["subject_invalid"] });
  return s;
}

/** His instruction, trimmed; ≤ 2 000 characters (a 422 beyond). */
function cleanInstruction(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s.length > DRAFT_LIMITS.instructionChars) fail(422, "invalid", { problems: ["instruction_too_long"] });
  return s;
}

/** The successor of T43 / T45: a new DD-only draft copying the content, recipients and screen of `old` (v1, new id and nonce). */
function successorRow(principal: ExecPrincipal, old: ExecDraftRow): NewDraftRow {
  return {
    ...blankRow(principal, old.accountId, old.kind),
    status: "draft",
    threadId: old.threadId, parentMessageId: old.parentMessageId, replyMode: old.replyMode, threadSubject: old.threadSubject,
    replyCandidates: old.replyCandidates, threadAddresses: [...old.threadAddresses],
    toRecipients: [...old.toRecipients], ccRecipients: [...old.ccRecipients], bccRecipients: [...old.bccRecipients],
    subject: old.subject, bodyDoc: old.bodyDoc, bodyHtml: old.bodyHtml, bodyText: old.bodyText,
    instruction: old.instruction, noteForMitchell: old.noteForMitchell, placeholders: [...old.placeholders],
    recipientsSig: old.recipientsSig, screenHashes: [...old.screenHashes], screenTruncated: old.screenTruncated,
    screenedPolicyHash: old.screenedPolicyHash, generationFlags: [...old.generationFlags], factsStatus: old.factsStatus,
    clientId: old.clientId, model: old.model, generatedAt: old.generatedAt,
    // P5b F7 (C44): who wrote the instruction travels with it; F3-F4 (C45): so does the second confirmation, because
    // the copied text came from the same chat; security-2: so does the answer that wrote it, so the chat purge by id
    // (C20) reaches the successor, which no card names.
    instructionBy: old.instructionBy, usesPrivateRefs: old.usesPrivateRefs, chatMessageId: old.chatMessageId
  };
}

async function insertSuccessor(principal: ExecPrincipal, old: ExecDraftRow): Promise<{ id: string; existing: boolean } | null> {
  if (old.restrictedPurged || old.bodyHtml === null) return null;
  const r = await insertDraft(principal, successorRow(principal, old));
  return r.inserted ? { id: r.row.id, existing: false } : { id: r.existingId, existing: true };
}

// ---------------------------------------------------------------------------
// CAS helpers
// ---------------------------------------------------------------------------

/** V: (id, principal, status, version) (§2.5). */
function versionKey(row: Pick<ExecDraftRow, "status" | "version">): CasExpect {
  return { status: row.status, version: row.version };
}

/** A counted CAS; zero rows re-read the row and answer 409 (state_conflict + the current status, or `code`). */
async function casOrConflict(principal: ExecPrincipal, row: ExecDraftRow, expect: CasExpect, patch: DraftPatch,
  code: "state_conflict" | "version_conflict" = "state_conflict"): Promise<void> {
  if (await casDraft(principal, row.id, expect, patch)) return;
  const current = await getDraft(principal, row.id);
  fail(409, code, { status: current?.status ?? null });
}

/** T44 / T50: a sent copy was found for an unknown or gone row: sent (a send attempt existed) or sent_external, unverified. */
async function recordSentCopy(principal: ExecPrincipal, row: ExecDraftRow, now: Date, opts: TransitionOptions): Promise<void> {
  if (row.status !== "gone" && row.status !== "unknown") return;
  const attempted = row.sendAttemptKey !== null || row.sendStartedAt !== null;
  const to = attempted ? "sent" : "sent_external";
  const patch: DraftPatch = {
    ...terminalPatch(row, to, now, opts),
    unverified: true,
    ...(to === "sent" ? { sent_at: row.sentAt ?? row.sendAcceptedAt ?? now.toISOString() } : {})
  };
  if (!(await casDraft(principal, row.id, versionKey(row), patch))) {
    console.warn(`[exec-drafts] ${row.id}: the sent-copy record lost its CAS`);
  }
}

/** The row a CAS of `patch` produces (for computing what comes next). */
function applied(row: ExecDraftRow, patch: DraftPatch): ExecDraftRow {
  return applyDraftPatch(row, patch);
}

/** The time a sent-copy search starts from (C54): send_started_at ?? opened_in_outlook_at ?? created_at. */
function sentCopyAnchorMs(row: Pick<ExecDraftRow, "sendStartedAt" | "openedInOutlookAt" | "createdAt">): number {
  const t = Date.parse(row.sendStartedAt ?? row.openedInOutlookAt ?? row.createdAt);
  return Number.isFinite(t) ? t : Date.now();
}

/** findSentCopy for a row (C54): a read error is 503, never "not found"; a row without a message id is `unsupported`. */
async function sentCopyFor(principal: ExecPrincipal, row: ExecDraftRow, thread?: PrincipalMailThread): Promise<SentCopyResult> {
  if (row.internetMessageId === null) return "unsupported";
  try {
    return await findSentCopy(principal, {
      accountId: row.accountId,
      internetMessageId: row.internetMessageId,
      threadId: row.kind === "reply" ? row.threadId : null,
      sinceMs: sentCopyAnchorMs(row),
      ...(thread !== undefined ? { thread } : {})
    });
  } catch (err) {
    console.warn(`[exec-drafts] ${row.id}: the sent-copy check failed (${errorName(err)})`);
    return fail(503, "unavailable");
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function recipientViews(list: readonly DraftAddress[], internal: ReadonlySet<string>, thread: ReadonlySet<string> | null): RecipientView[] {
  return list.map((a) => {
    const badges: RecipientView["badges"] = [];
    if (!internal.has(domainOf(a.address))) badges.push("external");
    if (looksRoleAddress(a.address).filtered) badges.push("role");
    if (thread !== null && !thread.has(a.address)) badges.push("not_in_thread");
    return { address: a.address, name: a.name, badges };
  });
}

// The facts client's DD name for the "<client>" copy (§3.13.4; additive). Read
// only for a row that used or withheld that client's status, cached 5 min per
// principal and client; restricted, unknown or unreadable -> null (the UI then
// says "the client"). Client names are DD data, never draft content.
const CLIENT_NAME_TTL_MS = 300_000;
const CLIENT_NAME_TIMEOUT_MS = 5_000;
const CLIENT_NAME_MAX = 120;
const clientNameCache = new Map<string, { name: string | null; until: number }>();

async function factsClientName(principal: ExecPrincipal, row: Pick<ExecDraftRow, "clientId" | "factsStatus">, restricted: boolean): Promise<string | null> {
  if (restricted || row.clientId === null) return null;
  if (row.factsStatus !== "used" && row.factsStatus !== "recipients_outside_client") return null;
  const key = `${principal.id}:${row.clientId}`;
  const nowMs = Date.now();
  const hit = clientNameCache.get(key);
  if (hit !== undefined && hit.until > nowMs) return hit.name;
  try {
    const clients = await listClientMatchSignals(principal, { signal: AbortSignal.timeout(CLIENT_NAME_TIMEOUT_MS) });
    const found = clients.find((c) => c.id === row.clientId);
    const cleaned = found !== undefined ? found.name.replace(/\s+/g, " ").trim().slice(0, CLIENT_NAME_MAX) : "";
    const name = cleaned === "" ? null : cleaned;
    clientNameCache.set(key, { name, until: nowMs + CLIENT_NAME_TTL_MS });
    return name;
  } catch (err) {
    console.warn(`[exec-drafts] the facts client's name is unavailable (${errorName(err)})`);
    return null;
  }
}

const withClientName = (name: string | null): { clientName?: string } => (name !== null ? { clientName: name } : {});

async function mailTimezoneOf(principal: ExecPrincipal): Promise<{ zone: string; mapped: boolean }> {
  let zone = "America/New_York";
  try {
    zone = await getMailTimezone(principal);
  } catch {
    zone = "America/New_York";
  }
  return { zone, mapped: (CL2_MAPPED_TIMEZONES as readonly string[]).includes(zone) };
}

interface ViewInputs {
  gates: DraftGates;
  ea: EaReadiness | null;
  sendToken: Pick<SendTokenState, "ok"> | null;
  restricted: boolean;
  p3Row: ExecEmailThread | null;
  now: Date;
}

/** DraftView (C59): server-computed capabilities; a restricted row carries no content (C11, C13). */
async function buildView(principal: ExecPrincipal, row: ExecDraftRow, v: ViewInputs): Promise<DraftView> {
  const restricted = v.restricted || row.restrictedPurged;
  const ctx = guardContext(row, { principal, gates: v.gates, ea: v.ea, sendToken: v.sendToken, restricted, now: v.now });
  const capabilities = capabilitiesFor(row, ctx);
  const internal = ownDomains(v.gates);
  const thread = row.kind === "reply" ? new Set(row.threadAddresses.map(lower)) : null;
  const reviewAt = row.reviewAt !== null ? Date.parse(row.reviewAt) : NaN;
  const goneAt = row.goneAt !== null ? Date.parse(row.goneAt) : NaN;
  const holdMs = Math.max(DRAFT_LIMITS.goneHoldMs, DRAFT_LIMITS.goneRecheckMs[DRAFT_LIMITS.goneRecheckMs.length - 1]);
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version, savedVersion: row.savedVersion,
    staleLink: row.status === "draft" && isStaleLink(row),
    restricted,
    threadId: row.threadId,
    threadSubject: restricted ? null : row.threadSubject,
    replyMode: row.replyMode,
    parentFrom: restricted ? null : row.replyCandidates?.from ?? null,
    replyCandidates: restricted ? null : row.replyCandidates,
    to: restricted ? [] : recipientViews(row.toRecipients, internal, thread),
    cc: restricted ? [] : recipientViews(row.ccRecipients, internal, thread),
    bcc: restricted ? [] : recipientViews(row.bccRecipients, internal, thread),
    subject: restricted ? null : row.subject,
    bodyDoc: restricted ? null : row.bodyDoc,
    bodyText: restricted ? null : row.bodyText,
    instruction: restricted ? null : row.instruction,
    noteForMitchell: restricted ? null : row.noteForMitchell,
    placeholders: restricted ? [] : [...row.placeholders],
    factsStatus: row.factsStatus,
    injectionSuspected: !restricted && v.p3Row !== null && v.p3Row.injectionSuspected === true,
    generationFlags: [...row.generationFlags],
    generationError: row.generationError,
    lastError: row.lastErrorCode !== null ? { code: row.lastErrorCode, at: row.lastErrorAt ?? row.updatedAt } : null,
    outlook: {
      linked: hasLink(row),
      webLink: restricted ? null : row.webLink,
      openedAt: row.openedInOutlookAt,
      signatureSkipped: row.signatureSkipped,
      edited: row.outlookEdited,
      changedSinceSaved: changedSinceSaved(row)
    },
    review: {
      valid: reviewIsValid(row, v.now),
      at: row.reviewAt,
      expiresAt: Number.isFinite(reviewAt) ? iso(reviewAt + DRAFT_LIMITS.reviewTtlMs) : null,
      blockers: [...row.reviewBlockers]
    },
    sent: {
      at: row.sentAt, mismatch: row.sentMismatch, unverified: row.unverified, ownerResolution: row.ownerResolution,
      pastHorizon: row.status === "unknown" && pastSendHorizon(row, v.now)
    },
    gone: { at: row.goneAt, unconfirmed: row.goneUnconfirmed, holdUntil: row.goneUnconfirmed && Number.isFinite(goneAt) ? iso(goneAt + holdMs) : null },
    cloneFlags: [...row.cloneFlags],
    mailTimezone: await mailTimezoneOf(principal),
    capabilities,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...withClientName(await factsClientName(principal, row, restricted)),
    // P5b F5: flags, not content (kept on restricted rows).
    usesPrivateRefs: row.usesPrivateRefs,
    instructionBy: row.instructionBy
  };
}

/** The view after a mutation: the row re-read, screened by what the caller already knows, readiness as it stands. */
async function viewAfter(principal: ExecPrincipal, id: string, v: Omit<ViewInputs, "sendToken"> & { sendToken?: Pick<SendTokenState, "ok"> | null }): Promise<DraftView> {
  const row = await getDraft(principal, id);
  if (row === null) return fail(404, "not_found");
  const sendToken = v.sendToken !== undefined ? v.sendToken : await sendTokenVerdict(principal);
  return buildView(principal, row, { ...v, sendToken });
}

/** The read-back as the dialog and the "changed" views show it; null when the preview can't be built safely (C64). */
function readBackViewOf(read: CloneReadBack, row: ExecDraftRow, internalDomains: ReadonlySet<string>): ReadBackView | null {
  const ctx: ReadBackViewContext = {
    internalDomains,
    storedTo: row.toRecipients,
    storedCc: row.ccRecipients,
    storedBcc: row.bccRecipients,
    ...(row.kind === "reply" ? { threadAddresses: new Set(row.threadAddresses.map(lower)) } : {})
  };
  try {
    return toReadBackView(read, ctx);
  } catch {
    return null;
  }
}

/**
 * A live, saved Outlook draft read (the only answer a review or a "show the
 * Outlook version" proceeds on). A read flagged send_status_unknown is not one
 * (data-1, C76): the send's outcome is in doubt, so review and keep-Outlook-
 * version mirror it (the row becomes unknown with the flag written) instead.
 */
function liveSaved(read: CloneDraftRead | null): CloneReadBack | null {
  return read !== null && read.live && read.status === "saved" && read.isDraft && !read.flags.includes("send_status_unknown") ? read : null;
}

/**
 * After a 409 `changed`: one GET of the Outlook draft (observed only, C66), and
 * its read-back view with contentHash for "Replace it" / "Delete anyway"
 * (buildability-1). Never for a restricted row (C13).
 */
async function changedReadBack(principal: ExecPrincipal, id: string, gates: DraftGates, now: Date): Promise<ReadBackView | null> {
  const row = await getDraft(principal, id);
  if (row === null || row.restrictedPurged || !hasLink(row)) return null;
  const answer = await cloneGet(principal, row);
  const read = answer.ok ? liveSaved(answer.value) : null;
  if (read === null) return null;
  // Observed only, and no status mirror: this read follows a refusal (409 changed) and must not move the row
  // (an unknown row inside T43 stays unknown, C76); the sweep's checks do the mirroring.
  await casDraft(principal, row.id, versionKey(row), { observed_content_hash: read.contentHash, updated_at: now.toISOString() });
  return readBackViewOf(read, row, ownDomains(gates));
}

// ---------------------------------------------------------------------------
// GET /api/exec/drafts/:id (R3) and the list (R1)
// ---------------------------------------------------------------------------

export async function getDraftView(principal: ExecPrincipal, id: string): Promise<DraftView | null> {
  if (typeof id !== "string" || !DRAFT_ID_RE.test(id)) return null;
  const gates = await loadDraftGates(principal);
  if (!gates.settings.draftsSchemaReady) return null;
  const found = await getDraft(principal, id);
  if (found === null) return null;
  const screened = await screenOrPurge(principal, found);
  const [ea, sendToken] = await Promise.all([peekReadiness(principal), sendTokenVerdict(principal)]);
  return buildView(principal, screened.row, { gates, ea, sendToken, restricted: screened.restricted, p3Row: screened.p3Row, now: new Date() });
}

/** "jane@client.com" / "jane@client.com +2": addresses, never display names (C75). */
function toSummaryOf(row: ExecDraftRow): string | null {
  const all = [...row.toRecipients, ...row.ccRecipients, ...row.bccRecipients];
  if (all.length === 0) return null;
  return all.length === 1 ? all[0].address : `${all[0].address} +${all.length - 1}`;
}

export async function listDraftItems(principal: ExecPrincipal, q: { view: "active" | "recent" | "all"; cursor?: string | null; limit?: number }):
  Promise<{ items: DraftListItem[]; nextCursor: string | null }> {
  const gates = await loadDraftGates(principal);
  if (!gates.settings.draftsSchemaReady) return { items: [], nextCursor: null };
  const now = new Date();
  let page: { rows: ExecDraftRow[]; nextCursor: string | null };
  try {
    page = await listDrafts(principal, { view: q.view, cursor: q.view === "all" ? q.cursor ?? null : null, limit: q.limit }, now);
  } catch (err) {
    if (err instanceof NonRetryableError) return fail(400, "bad_request");
    throw err;
  }
  if (page.rows.length === 0) return { items: [], nextCursor: page.nextCursor };
  const policy = await policyOrThrow(principal);
  const threadIds = [...new Set(page.rows.filter((r) => r.kind === "reply" && r.threadId !== null).map((r) => r.threadId as string))];
  const p3 = threadIds.length > 0 ? await listThreadScreenRows(principal, threadIds) : new Map<string, ThreadScreenRow>();
  const restrictedThreads = new Set<string>();
  const verdicts = page.rows.map((row) => {
    const p3Row = row.threadId !== null ? p3.get(row.threadId) ?? null : null;
    const v = screenDraftRow(row, policy, p3Row);
    if (v.restricted && !row.restrictedPurged && row.kind === "reply" && row.threadId !== null) restrictedThreads.add(row.threadId);
    return v.restricted;
  });
  if (restrictedThreads.size > 0) {
    const purged = await purgeDraftsForThreads(principal, [...restrictedThreads]);
    await auditEvent(principal, { actor: "owner", action: "draft.purge_restricted", target: "exec_drafts", input: { counts: purged ?? 0 } });
  }
  const items: DraftListItem[] = page.rows.map((row, i) => {
    const restricted = verdicts[i] || row.restrictedPurged;
    const shown = restricted ? { ...row, restrictedPurged: true } : row;
    return {
      id: row.id, kind: row.kind, status: row.status, threadId: row.threadId,
      label: restricted ? null : row.kind === "reply" ? row.threadSubject : row.subject,
      toSummary: restricted ? null : toSummaryOf(row),
      updatedAt: row.updatedAt, sentAt: row.sentAt, restricted,
      attention: draftAttention(shown)
    };
  });
  if (q.view === "active") {
    items.sort((a, b) => attentionRank(a.attention) - attentionRank(b.attention) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
  return { items, nextCursor: page.nextCursor };
}

// ---------------------------------------------------------------------------
// Reply preparation (shared by the create route and previewReply)
// ---------------------------------------------------------------------------

type ReplyPrep =
  | { ok: true; thread: PrincipalMailThread; policy: { rules: RestrictedSenderRule[]; hash: string }; p3Row: ExecEmailThread | null;
      derived: DerivedReply }
  | { ok: false; code: "not_found" | "restricted" | "thread_unavailable" | "unavailable" | "mailbox_problem" };

/**
 * C26: the live read (15 s), both screens (C11) and the derivation (L8, C8). No row exists yet: nothing to purge.
 * `opts` (additive, P5b F1): the chat's createChatReplyDraft passes its signal, and `rethrow` so a failed read or
 * screen throws to its caller (an infrastructure error) instead of answering `unavailable`. The routes pass nothing.
 */
async function prepareReply(principal: ExecPrincipal, gates: DraftGates, threadId: string, replyAll: boolean,
  opts: { rethrow?: boolean; signal?: AbortSignal } = {}): Promise<ReplyPrep> {
  if (!THREAD_ID_RE.test(threadId)) return { ok: false, code: "not_found" };
  const signalOpt = opts.signal !== undefined ? { signal: opts.signal } : null;
  let read: Awaited<ReturnType<typeof readPrincipalThread>>;
  try {
    read = await readPrincipalThread(principal, threadId, { usable: gates.usable, timeoutMs: ROUTE_THREAD_TIMEOUT_MS, ...(signalOpt ?? {}) });
  } catch (err) {
    if (opts.rethrow === true) throw err;
    console.warn(`[exec-drafts] thread read failed (${errorName(err)})`);
    return { ok: false, code: "unavailable" };
  }
  if (read.kind !== "ok") return { ok: false, code: "not_found" };
  const thread = read.thread;
  let policy: { rules: RestrictedSenderRule[]; hash: string };
  let p3Row: ExecEmailThread | null;
  try {
    policy = signalOpt !== null ? await loadScreeningPolicy(principal, signalOpt) : await loadScreeningPolicy(principal);
    p3Row = signalOpt !== null ? await getEmailThread(principal, threadId, signalOpt) : await getEmailThread(principal, threadId);
  } catch (err) {
    if (opts.rethrow === true) throw err;
    console.warn(`[exec-drafts] screening could not run (${errorName(err)})`);
    return { ok: false, code: "unavailable" };
  }
  if (screenRestricted({ all: thread.all, participants: thread.participants }, policy.rules).verdict === "restricted") return { ok: false, code: "restricted" };
  if (p3Row !== null && screenStoredRow(p3Row, policy.rules, policy.hash).verdict === "restricted") return { ok: false, code: "restricted" };
  const derived = deriveReplyRecipients(thread, { ownAddresses: gates.ownAddresses, replyAll });
  if ("error" in derived) return { ok: false, code: "thread_unavailable" };
  // C57: the reply's account is the parent's; it must be his, usable, and the parent not junk.
  if (derived.parent.isJunk || !THREAD_ID_RE.test(derived.parent.id)) return { ok: false, code: "thread_unavailable" };
  if (!gates.usable.includes(derived.parent.accountId)) return { ok: false, code: "mailbox_problem" };
  return { ok: true, thread, policy, p3Row, derived };
}

/**
 * C63's look-back: the newest inactive, unsent draft on the same parent; one
 * that was ever in Outlook (internet_message_id set) needs a sent-copy check
 * against the thread just read (no second clone read) before a new one starts.
 */
async function lookBack(principal: ExecPrincipal, gates: DraftGates, threadId: string, parentId: string, thread: PrincipalMailThread,
  checkedOutlook: boolean, now: Date): Promise<{ ok: true } | { ok: false; code: "hold" | "sent_copy_found" }> {
  const prior = await getLatestDraftForParent(principal, threadId, parentId);
  if (prior === null || prior.internetMessageId === null) return { ok: true };
  const account = isPinnedAccount(principal, prior.accountId) ? prior.accountId : (gates.usable[0] ?? prior.accountId);
  const sentCopy = await sentCopyFor(principal, { ...prior, accountId: account }, thread);
  const r = canOfferNewReply(prior, { sentCopy, checkedOutlook, now });
  if (r.ok) return { ok: true };
  if (r.code === "sent_copy_found") {
    // T50: an earlier gone draft is recorded as sent; a discarded one stays as it is.
    if (prior.status === "gone") await recordSentCopy(principal, prior, now, transitionOptions(gates));
    return { ok: false, code: "sent_copy_found" };
  }
  return { ok: false, code: "hold" };
}

/** For /executive/email/drafts/new: the derived recipients for a thread, or why not. hold / sent_copy_found come from the C63 look-back. */
export async function previewReply(principal: ExecPrincipal, threadId: string): Promise<{ ok: true; seed: NewDraftSeed }
  | { ok: false; code: "not_found" | "restricted" | "thread_unavailable" | "unavailable" | "hold" | "sent_copy_found" }> {
  const gates = await loadDraftGates(principal);
  if (!gates.settings.draftsSchemaReady) return { ok: false, code: "not_found" };
  const prep = await prepareReply(principal, gates, threadId, false);
  if (!prep.ok) return { ok: false, code: prep.code === "mailbox_problem" ? "unavailable" : prep.code };
  let look: { ok: true } | { ok: false; code: "hold" | "sent_copy_found" };
  try {
    look = await lookBack(principal, gates, threadId, prep.derived.parent.id, prep.thread, false, new Date());
  } catch (err) {
    if (err instanceof DraftRouteError) return { ok: false, code: "unavailable" };
    throw err;
  }
  if (!look.ok) return { ok: false, code: look.code };
  const d = prep.derived;
  return {
    ok: true,
    seed: {
      kind: "reply",
      threadId,
      threadSubject: threadSubjectOf(d.parent.subject),
      parentFrom: d.candidates.from,
      to: d.to,
      cc: d.cc,
      candidates: d.candidates,
      mode: d.mode,
      injectionSuspected: prep.p3Row !== null && prep.p3Row.injectionSuspected === true
    }
  };
}

// ---------------------------------------------------------------------------
// Recipient suggestions (new drafts, L8)
// ---------------------------------------------------------------------------

/** Internal users, active clients' contacts, then his screened P3 correspondents; minus his own, no-reply and restricted addresses. */
async function suggestionsFor(principal: ExecPrincipal, gates: DraftGates, policy: { rules: RestrictedSenderRule[]; hash: string }): Promise<RecipientSuggestion[]> {
  const out = await ddContacts(principal);
  for (const r of await listCorrespondentRows(principal)) {
    if (screenStoredRow(r, policy.rules, policy.hash).verdict === "restricted") continue;
    for (const raw of r.correspondents) {
      const a = normalizeDraftAddress({ address: raw });
      if (a !== null && !out.has(a.address)) out.set(a.address, { address: a.address, name: null, source: "correspondent" });
    }
  }
  const rules = [...policy.rules];
  const list: RecipientSuggestion[] = [];
  for (const s of out.values()) {
    if (gates.ownAddresses.has(s.address)) continue;
    if (looksUnreplyable(s.address, null).filtered) continue;
    if (rules.length > 0 && addressMatches(s.address, rules) !== null) continue;
    list.push(s);
    if (list.length >= MAX_SUGGESTIONS) break;
  }
  return list;
}

/** For new drafts: the allowed recipient set (names + addresses), screened. */
export async function recipientSuggestions(principal: ExecPrincipal): Promise<RecipientSuggestion[]> {
  const gates = await loadDraftGates(principal);
  if (!gates.settings.draftsSchemaReady) return [];
  const policy = await loadScreeningPolicy(principal);
  return suggestionsFor(principal, gates, policy);
}

// ---------------------------------------------------------------------------
// POST /api/exec/drafts (R2: T01-T04)
// ---------------------------------------------------------------------------

/** Enqueue the generation job; a failure closes the attempt (T06 / T07 with `stale`) and answers 503 (R2, R6). */
async function enqueueGeneration(principal: ExecPrincipal, row: ExecDraftRow): Promise<void> {
  try {
    await enqueueJob(draftGenerateJob(principal, row.id, row.generationSeq));
    return;
  } catch (err) {
    console.warn(`[exec-drafts] ${row.id}: the generation job was not queued (${errorName(err)})`);
  }
  const nowIso = new Date().toISOString();
  const patch: DraftPatch = row.priorStatus === null
    ? { status: "generation_failed", generation_error: "stale", prior_status: null, next_check_at: null, updated_at: nowIso }
    : { status: priorStatusOf(row), generation_error: "stale", last_error_code: "generation_stale", last_error_at: nowIso, prior_status: null, next_check_at: null, updated_at: nowIso };
  await casDraft(principal, row.id, { status: "generating", version: row.version, generationSeq: row.generationSeq }, patch);
  fail(503, "unavailable");
}

/**
 * A reply draft's row (R2, T01/T02) from a prepared reply: the derived recipients, the live screen's hashes and the
 * policy hash, generating (seq 1, the stale check) or an empty body. Shared by createDraft and createChatReplyDraft
 * (P5b F1), so both insert the identical key set.
 */
function replyRow(principal: ExecPrincipal, ok: Extract<ReplyPrep, { ok: true }>, threadId: string, generate: boolean,
  instruction: string | null, now: Date): NewDraftRow {
  const d = ok.derived;
  const hashes = screenHashesFor({ all: ok.thread.all, participants: ok.thread.participants });
  const body = generate ? { bodyDoc: null, bodyHtml: null, bodyText: null } : emptyBody();
  return {
    ...blankRow(principal, d.parent.accountId, "reply"),
    status: generate ? "generating" : "draft",
    generationSeq: generate ? 1 : 0,
    threadId,
    parentMessageId: d.parent.id,
    replyMode: d.mode,
    threadSubject: threadSubjectOf(d.parent.subject),
    replyCandidates: d.candidates,
    threadAddresses: d.threadAddresses,
    toRecipients: d.to,
    ccRecipients: d.cc,
    recipientsSig: recipientsSignature({ to: d.to, cc: d.cc, bcc: [] }),
    ...body,
    instruction,
    screenHashes: hashes.hashes,
    screenTruncated: hashes.truncated,
    screenedPolicyHash: ok.policy.hash,
    nextCheckAt: generate ? iso(now.getTime() + DRAFT_LIMITS.generatingStaleMs) : null
  };
}

export async function createDraft(principal: ExecPrincipal, input: CreateDraftInput): Promise<{ id: string; status: ExecDraftStatus; existing: boolean }> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  if (gates.usable.length === 0) fail(409, "mailbox_problem");
  const instruction = cleanInstruction(input.instruction);
  if (input.kind === "new" && input.generate && instruction === null) fail(422, "instruction_required");
  if (input.generate) await requireRateLimit(principal, "draft.generate.request", now);
  await requireReadiness(principal);

  let row: NewDraftRow;
  if (input.kind === "reply") {
    if (!THREAD_ID_RE.test(input.threadId)) fail(404, "not_found");
    const prep = await prepareReply(principal, gates, input.threadId, input.replyAll === true);
    if (!prep.ok) {
      if (prep.code === "unavailable") fail(503, "unavailable");
      if (prep.code === "thread_unavailable") fail(409, "thread_unavailable");
      if (prep.code === "mailbox_problem") fail(409, "mailbox_problem");
      fail(404, "not_found");
    }
    const ok = prep as Extract<ReplyPrep, { ok: true }>;
    const d = ok.derived;
    // T03 first: a thread with an active draft opens it (the look-back is for inactive ones, C63).
    const active = await getActiveDraftForThread(principal, input.threadId);
    if (active !== null) return { id: active.id, status: active.status, existing: true };
    const look = await lookBack(principal, gates, input.threadId, d.parent.id, ok.thread, input.checkedOutlook === true, now);
    if (!look.ok) fail(409, look.code);
    row = replyRow(principal, ok, input.threadId, input.generate, instruction, now);
  } else {
    let accountId: string;
    if (input.accountId !== undefined) {
      requireUsableAccount(gates, input.accountId);
      accountId = input.accountId;
    } else if (gates.usable.length === 1) {
      accountId = gates.usable[0];
    } else {
      return fail(422, "invalid", { problems: ["account_required"] });
    }
    const policy = await policyOrThrow(principal);
    const allowed = await newDraftAllowed(principal, gates, policy);
    const check = checkRecipients({ to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [] },
      recipientContext("new", gates, ownDomains(gates), policy.rules, { allowed }));
    if (!check.ok) recipientsBlocked(check);
    const passed = check as Extract<RecipientCheck, { ok: true }>;
    const subject = cleanSubject(input.subject);
    const body = input.generate ? { bodyDoc: null, bodyHtml: null, bodyText: null } : emptyBody();
    row = {
      ...blankRow(principal, accountId, "new"),
      status: input.generate ? "generating" : "draft",
      generationSeq: input.generate ? 1 : 0,
      toRecipients: passed.to,
      ccRecipients: passed.cc,
      bccRecipients: passed.bcc,
      recipientsSig: passed.signature,
      subject,
      ...body,
      instruction,
      nextCheckAt: input.generate ? iso(now.getTime() + DRAFT_LIMITS.generatingStaleMs) : null
    };
  }

  const inserted = await insertDraft(principal, row);
  if (!inserted.inserted) {
    // T03: the thread already has an active draft; "Draft reply" opens it.
    const existing = await getDraft(principal, inserted.existingId);
    return { id: inserted.existingId, status: existing?.status ?? "draft", existing: true };
  }
  const created = inserted.row;
  await auditEvent(principal, {
    actor: "owner",
    action: input.generate ? "draft.generate.request" : "draft.create",
    target: `exec_drafts:${created.id}`,
    input: { draftId: created.id, kind: created.kind, accountId: created.accountId, generationSeq: created.generationSeq }
  });
  if (input.generate) await enqueueGeneration(principal, created);
  return { id: created.id, status: created.status, existing: false };
}

// ---------------------------------------------------------------------------
// PATCH /api/exec/drafts/:id (R4: T13-T15)
// ---------------------------------------------------------------------------

export async function editDraft(principal: ExecPrincipal, id: string, input: EditDraftInput): Promise<DraftView> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  const loaded = await loadRowOrThrow(principal, id);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const [ea, sendToken] = await Promise.all([peekReadiness(principal), sendTokenVerdict(principal)]);
  const g: GuardInputs = { principal, gates, ea, sendToken, restricted: screened.restricted, now };
  requireGuard("edit", row, guardContext(row, g));
  if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });

  // The body (L7): the browser's TipTap JSON only; the server rebuilds the HTML.
  let body: Record<string, unknown> = {};
  if (input.bodyDoc !== undefined) {
    const v = validateBodyDoc(input.bodyDoc);
    if (!v.ok) fail(422, "invalid", { problems: v.problems });
    const doc = (v as { ok: true; doc: NonNullable<ExecDraftRow["bodyDoc"]> }).doc;
    const built = buildBody(doc);
    body = { body_doc: doc, body_html: built.html, body_text: built.text, placeholders: built.placeholders };
  } else if (row.status === "generation_failed") {
    fail(422, "invalid", { problems: ["body_required"] });
  }

  // The recipients (L8, C7): a reply keeps its derived To (removable only) and adds Cc from the thread and DD contacts.
  let recipients: Record<string, unknown> = {};
  if (row.kind === "reply") {
    if (input.subject !== undefined || input.bcc !== undefined) fail(422, "invalid", { problems: [input.subject !== undefined ? "subject_not_allowed" : "bcc_not_allowed"] });
    if (input.to !== undefined || input.cc !== undefined || input.replyAll !== undefined) {
      const replyAll = input.replyAll ?? row.replyMode === "reply_all";
      const derivedNow = derivedLists(row, replyAll);
      const derivedAll = derivedLists(row, true);
      const candidates = addressSet(derivedAll.cc);
      let cc: DraftAddressInput[];
      if (input.cc !== undefined) cc = input.cc;
      else if (input.replyAll === undefined) cc = row.ccRecipients;
      else if (replyAll) cc = [...row.ccRecipients, ...derivedNow.cc];
      else cc = row.ccRecipients.filter((a) => !candidates.has(a.address));
      const to = input.to ?? row.toRecipients;
      const allowed = await replyAllowed(principal, row);
      const policy = screened.policy;
      const check = checkRecipients({ to, cc, bcc: [] }, recipientContext("reply", gates, ownDomains(gates), policy.rules, {
        allowed, derivedTo: addressSet(derivedAll.to), derivedCc: candidates
      }));
      if (!check.ok) recipientsBlocked(check);
      const passed = check as Extract<RecipientCheck, { ok: true }>;
      const mode: ReplyMode = row.replyMode === "follow_up" ? "follow_up" : replyAll ? "reply_all" : "reply";
      recipients = { to_recipients: passed.to, cc_recipients: passed.cc, bcc_recipients: [], recipients_sig: passed.signature, reply_mode: mode };
    }
  } else {
    if (input.replyAll !== undefined) fail(422, "invalid", { problems: ["reply_all_not_allowed"] });
    if (input.subject !== undefined) recipients.subject = cleanSubject(input.subject);
    if (input.to !== undefined || input.cc !== undefined || input.bcc !== undefined) {
      const allowed = await newDraftAllowed(principal, gates, screened.policy);
      const check = checkRecipients({ to: input.to ?? row.toRecipients, cc: input.cc ?? row.ccRecipients, bcc: input.bcc ?? row.bccRecipients },
        recipientContext("new", gates, ownDomains(gates), screened.policy.rules, { allowed }));
      if (!check.ok) recipientsBlocked(check);
      const passed = check as Extract<RecipientCheck, { ok: true }>;
      Object.assign(recipients, { to_recipients: passed.to, cc_recipients: passed.cc, bcc_recipients: passed.bcc, recipients_sig: passed.signature });
    }
  }

  // T13 / T14 / T15: → draft, version + 1; a saved row's link is kept (now stale) and its review cleared.
  const base: Record<string, unknown> = {
    status: "draft",
    version: row.version + 1,
    prior_status: null,
    ...body,
    ...recipients,
    ...(row.status === "saved" ? REVIEW_CLEARED_PATCH : {}),
    ...(row.status === "generation_failed" ? { generation_error: null } : {}),
    updated_at: now.toISOString()
  };
  const patch: DraftPatch = { ...base, next_check_at: nextCheckAt(applied(row, base), now) };
  await casOrConflict(principal, row, versionKey(row), patch, "version_conflict");
  return viewAfter(principal, id, { gates, ea, sendToken, restricted: false, p3Row: screened.p3Row, now });
}

// ---------------------------------------------------------------------------
// POST …/regenerate (R6: T10-T12)
// ---------------------------------------------------------------------------

export async function requestRegeneration(principal: ExecPrincipal, id: string, input: { version: number; instruction?: string | null }): Promise<DraftView> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  await requireRateLimit(principal, "draft.generate.request", now);
  const ea = await requireReadiness(principal);
  const loaded = await loadRowOrThrow(principal, id);
  requireUsableAccount(gates, loaded.accountId);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const sendToken = await sendTokenVerdict(principal);
  requireGuard("regenerate", row, guardContext(row, { principal, gates, ea, sendToken, restricted: screened.restricted, now }));
  if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });
  const instruction = input.instruction === undefined ? row.instruction : cleanInstruction(input.instruction);
  if (row.kind === "new" && instruction === null) fail(422, "instruction_required");

  const seq = row.generationSeq + 1;
  const patch: DraftPatch = {
    status: "generating",
    prior_status: row.status as PriorStatus,
    generation_seq: seq,
    instruction,
    // P5b F7 (C44): an instruction he sent (a string, or null to clear it) is his own; none leaves who wrote it.
    ...(input.instruction !== undefined ? { instruction_by: "owner" } : {}),
    generation_error: null,
    ...(row.status === "saved" ? REVIEW_CLEARED_PATCH : {}),
    next_check_at: iso(now.getTime() + DRAFT_LIMITS.generatingStaleMs),
    updated_at: now.toISOString()
  };
  await casOrConflict(principal, row, versionKey(row), patch);
  await auditEvent(principal, {
    actor: "owner",
    action: "draft.generate.request",
    target: `exec_drafts:${row.id}`,
    input: { draftId: row.id, kind: row.kind, version: row.version, generationSeq: seq }
  });
  await enqueueGeneration(principal, applied(row, patch));
  return viewAfter(principal, id, { gates, ea, sendToken, restricted: false, p3Row: screened.p3Row, now });
}

// ---------------------------------------------------------------------------
// POST …/save (R7: T16-T25)
// ---------------------------------------------------------------------------

/** The CloneAnswer of a create / recreate call; a refusal before any I/O is "no answer" (the stale sweep replays the same key). */
async function saveCall(fn: () => Promise<{ readBack: CloneReadBack; replay: boolean }>): Promise<CloneAnswer<CloneReadBack>> {
  try {
    const r = await fn();
    return { ok: true, value: r.readBack, replay: r.replay };
  } catch (err) {
    if (err instanceof CloneEaError) return { ok: false, error: err };
    console.warn(`[exec-drafts] the save call failed before an answer (${errorName(err)})`);
    return { ok: false, noAnswer: true };
  }
}

/**
 * A GET whose answer §2.6.0's `saving` row maps: a replayed 2xx (this key's own result: the link written in the same
 * CAS), or a replacement followed from a 404 gone / deleted (`follow`: an earlier attempt's draft, linked stale, data-3).
 */
async function linkByRead(principal: ExecPrincipal, saving: ExecDraftRow, graphId: string, now: Date, opts: TransitionOptions, follow = false): Promise<Transition> {
  const read = await cloneGet(principal, saving, graphId);
  if (!read.ok) return saveOutcomeUnknown(saving, now);
  const t = follow
    ? linkReplacement(saving, read.value, now, opts)
    : mirrorRegistry(saving, { status: read.value.status, flags: read.value.flags, read: read.value }, now, opts);
  return t.to === "saving" ? saveOutcomeUnknown(saving, now) : t;
}

/**
 * A failed save back in `draft` records its code (T20, T21): the draftStatus branch of the maps (an error that
 * carries the registry status, e.g. a 409 changed with draftStatus saved) leaves last_error_code out of the patch.
 */
function withSaveCode(t: Transition, now: Date): Transition {
  if (t.to !== "draft" || t.code === null || "last_error_code" in t.patch) return t;
  return { ...t, patch: { ...t.patch, last_error_code: t.code, last_error_at: now.toISOString() } };
}

/** §2.6.1 / §2.6.2 for his click, the GET resolution included. */
async function settleSave(principal: ExecPrincipal, saving: ExecDraftRow, kind: "create" | "recreate", answer: CloneAnswer<CloneReadBack>,
  now: Date, opts: TransitionOptions): Promise<Transition> {
  return withSaveCode(await settleSaveRaw(principal, saving, kind, answer, now, opts), now);
}

async function settleSaveRaw(principal: ExecPrincipal, saving: ExecDraftRow, kind: "create" | "recreate", answer: CloneAnswer<CloneReadBack>,
  now: Date, opts: TransitionOptions): Promise<Transition> {
  if (answer.ok && answer.replay) return linkByRead(principal, saving, answer.value.graphId, now, opts);
  const replacedBy = !answer.ok && !("noAnswer" in answer) ? answer.error.replacedBy : null;
  if (kind === "create") {
    const t = mapCreateResult(saving, answer, now, opts);
    if (t.to === "saving" && t.code === "follow_replacement") return replacedBy ? linkByRead(principal, saving, replacedBy, now, opts, true) : saveOutcomeUnknown(saving, now);
    return t;
  }
  const r = mapRecreateResult(saving, answer, now, opts);
  if ("leaveSaving" in r) return saveOutcomeUnknown(saving, now);
  if ("needGetResolution" in r) {
    const old = await cloneGet(principal, saving);
    let replacement: CloneAnswer<CloneDraftRead> | null = null;
    if (!old.ok && !("noAnswer" in old) && old.error.kind === "gone" && old.error.draftStatus === "deleted" && old.error.replacedBy) {
      replacement = await cloneGet(principal, saving, old.error.replacedBy);
    }
    const g = resolveRecreateByGet(saving, old, replacement, r.code, now, opts);
    return "leaveSaving" in g ? saveOutcomeUnknown(saving, now) : g;
  }
  if (r.to === "saving" && r.code === "follow_replacement") return replacedBy ? linkByRead(principal, saving, replacedBy, now, opts, true) : saveOutcomeUnknown(saving, now);
  return r;
}

function httpStatusOf(answer: CloneAnswer<unknown>): number | null {
  if (answer.ok) return 200;
  return "noAnswer" in answer ? null : answer.error.status;
}

function draftStatusOf(answer: CloneAnswer<unknown>): string | null {
  if (answer.ok) return null;
  return "noAnswer" in answer ? null : answer.error.draftStatus;
}

export async function saveDraft(principal: ExecPrincipal, id: string, input: { version: number; seenContentHash?: string; confirmPrivate?: true }):
  Promise<{ status: ExecDraftStatus; code: string | null; readBack: ReadBackView | null; retryAfterSec?: number; view: DraftView }> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  await requireRateLimit(principal, "draft.save", now);
  const ea = await requireReadiness(principal);
  const loaded = await loadRowOrThrow(principal, id);
  requireUsableAccount(gates, loaded.accountId);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const sendToken = await sendTokenVerdict(principal);
  requireGuard("save", row, guardContext(row, { principal, gates, ea, sendToken, restricted: screened.restricted, now }));
  if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });
  // P5b F3 (C45): a draft started in a chat that read other private material saves only with his confirmation.
  if (row.usesPrivateRefs && input.confirmPrivate !== true) fail(409, "private_refs_unconfirmed");

  // The refusals, each before any audit row or clone call (RO10).
  if (row.bodyHtml === null || row.bodyText === null || row.bodyText.trim() === "") fail(422, "empty_body");
  const placeholders = findPlaceholders(`${row.bodyText ?? ""}${row.kind === "new" && row.subject !== null ? `\n${row.subject}` : ""}`);
  if (placeholders.length > 0) fail(422, "placeholders", { placeholders });
  const unsafe = insertSafeProblems(row.bodyHtml ?? "");
  if (unsafe.length > 0) fail(422, "unsafe_markup", { constructs: unsafe });
  if (row.kind === "new" && (row.subject === null || row.subject.trim() === "")) fail(422, "subject_required");
  const policy = screened.policy;
  let check: RecipientCheck;
  if (row.kind === "reply") {
    const derivedAll = derivedLists(row, true);
    check = checkRecipients({ to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients }, recipientContext("reply", gates, ownDomains(gates), policy.rules, {
      allowed: await replyAllowed(principal, row), derivedTo: addressSet(derivedAll.to), derivedCc: addressSet(derivedAll.cc)
    }));
  } else {
    check = checkRecipients({ to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients },
      recipientContext("new", gates, ownDomains(gates), policy.rules, { allowed: await newDraftAllowed(principal, gates, policy) }));
  }
  if (!check.ok) recipientsBlocked(check);
  if (row.factsStatus === "used" && row.clientId !== null) {
    const gate = await factsGateFor(principal, gates, row.clientId);
    const outside = factsRecipientsOutside({ to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients }, gate);
    if (outside.length > 0) {
      fail(422, "recipients_blocked", {
        errors: outside.map((address) => ({ code: "facts_recipient", address })),
        ...withClientName(await factsClientName(principal, row, false))
      });
    }
  }

  const opts = transitionOptions(gates);
  const kind: "create" | "recreate" = hasLink(row) ? "recreate" : "create";
  const ifContentHash = kind === "recreate" ? input.seenContentHash ?? row.contentHash : null;
  const timezone = (await mailTimezoneOf(principal)).zone;
  const key = saveKey(row.id, row.version, newKeyNonce());

  // The audit row first (fails closed), then the CAS to saving (T16 / T17).
  const auditId = await auditStart(principal, {
    actor: "owner",
    action: "draft.save",
    target: `exec_drafts:${row.id}`,
    input: { draftId: row.id, version: row.version, kind: row.kind, accountId: row.accountId, recipientCount: row.toRecipients.length + row.ccRecipients.length + row.bccRecipients.length }
  });
  // data-5 (C4, C67): the attempt's clock starts at the CAS, not at the request: the readiness check, the
  // matcher and the audit row before it must not eat into the stale sweep's margin over the clone call.
  const casAt = new Date();
  const savingPatch: Record<string, unknown> = {
    status: "saving",
    prior_status: null,
    save_attempt_key: key,
    save_version: row.version,
    save_timezone: timezone,
    save_if_content_hash: ifContentHash,
    save_started_at: casAt.toISOString(),
    last_error_code: null,
    last_error_at: null,
    next_check_at: iso(casAt.getTime() + DRAFT_LIMITS.savingStaleMs),
    updated_at: casAt.toISOString()
  };
  if (!(await casDraft(principal, row.id, versionKey(row), savingPatch))) {
    await auditFinish(auditId, { ok: false, error: "state_conflict" });
    const current = await getDraft(principal, row.id);
    return fail(409, "state_conflict", { status: current?.status ?? null });
  }
  const saving = applied(row, savingPatch);

  // The clone call, with its own timeout (create 200 s, recreate 340 s); never the request's signal.
  const answer = await saveCall(() => {
    if (kind === "recreate") {
      return recreateOutlookDraft(principal, {
        accountId: row.accountId, graphId: row.outlookGraphId as string, kind: row.kind,
        to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients, subject: row.subject,
        bodyHtml: row.bodyHtml as string, timezone, ifContentHash, idempotencyKey: key
      });
    }
    if (row.kind === "reply") {
      return createReplyDraft(principal, {
        threadId: row.threadId as string, parentMessageId: row.parentMessageId as string, accountId: row.accountId,
        to: row.toRecipients, cc: row.ccRecipients, bodyHtml: row.bodyHtml as string, timezone, idempotencyKey: key
      });
    }
    return createNewDraft(principal, {
      accountId: row.accountId, to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients,
      subject: row.subject as string, bodyHtml: row.bodyHtml as string, timezone, idempotencyKey: key
    });
  });
  const doneAt = new Date();
  const t = await settleSave(principal, saving, kind, answer, doneAt, opts);
  const outcome = await casTransition(principal, saving, t, doneAt, null);
  if (outcome === "missed") console.warn(`[exec-drafts] ${row.id}: the save outcome lost its CAS (the row moved on)`);
  const ok = t.to === "saved";
  await auditFinish(auditId, {
    ok,
    result: { outcome: t.to, code: t.code, httpStatus: httpStatusOf(answer), draftStatus: draftStatusOf(answer), replay: answer.ok ? answer.replay : false },
    error: ok ? undefined : auditCode(t.code)
  });
  alertTransition(t, row.id, "save");

  let readBack: ReadBackView | null = null;
  if (t.code === "outlook_changed") readBack = await changedReadBack(principal, row.id, gates, now);
  const retryAfterSec = !answer.ok && !("noAnswer" in answer) && answer.error.kind === "throttled" && answer.error.retryAfterMs !== null
    ? Math.max(1, Math.ceil(answer.error.retryAfterMs / 1000))
    : undefined;
  const view = await viewAfter(principal, row.id, { gates, ea, sendToken, restricted: false, p3Row: screened.p3Row, now });
  return { status: view.status, code: t.code, readBack, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}), view };
}

// ---------------------------------------------------------------------------
// DELETE /api/exec/drafts/:id (R5: T36-T39, T59)
// ---------------------------------------------------------------------------

export async function discardDraft(principal: ExecPrincipal, id: string, input: { version: number; seenContentHash?: string; confirmRestrictedDelete?: boolean }):
  Promise<{ status: ExecDraftStatus; code: string | null; readBack: ReadBackView | null; view: DraftView }> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  const loaded = await loadRowOrThrow(principal, id);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const restricted = screened.restricted || row.restrictedPurged;
  const opts = transitionOptions(gates);
  let [ea, sendToken] = await Promise.all([peekReadiness(principal), sendTokenVerdict(principal)]);
  const action: DraftAction = restricted ? "delete_restricted" : "discard";
  const linked = hasLink(row);
  // RO19 (C13): a restricted row is deleted only while an Outlook draft exists to delete (saved, linked draft).
  if (restricted && !(linked && (row.status === "saved" || row.status === "draft"))) fail(409, "state_conflict", { status: row.status });

  if (!linked) {
    // T36: DD-only, no clone call.
    requireGuard(action, row, guardContext(row, { principal, gates, ea, sendToken, restricted, now }));
    if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });
    await casOrConflict(principal, row, versionKey(row), terminalPatch(row, "discarded", now, opts));
    await auditEvent(principal, { actor: "owner", action: "draft.discard", target: `exec_drafts:${row.id}`, input: { draftId: row.id, version: row.version, outcome: "discarded" } });
    const view = await viewAfter(principal, id, { gates, ea, sendToken, restricted, p3Row: screened.p3Row, now });
    return { status: view.status, code: null, readBack: null, view };
  }

  // T37 / T59: a linked row: readiness (G8), the guard, the explicit confirm for a restricted one.
  ea = await requireReadiness(principal);
  requireGuard(action, row, guardContext(row, { principal, gates, ea, sendToken, restricted, now }));
  if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });
  if (restricted && input.confirmRestrictedDelete !== true) fail(422, "invalid", { problems: ["confirm_required"] });
  requireUsableAccount(gates, row.accountId);
  const graphId = row.outlookGraphId as string;
  const key = deleteKey(row.id, graphId, newKeyNonce());
  const ifContentHash = restricted ? null : input.seenContentHash ?? row.contentHash;

  const auditId = await auditStart(principal, {
    actor: "owner",
    action: "draft.discard",
    target: `exec_drafts:${row.id}`,
    input: { draftId: row.id, version: row.version, graphIdFp: graphIdFp(graphId) }
  });
  const casAt = new Date(); // data-5: the attempt's clock starts at the CAS
  const discardingPatch: Record<string, unknown> = {
    status: "discarding",
    prior_status: row.status as PriorStatus,
    discard_attempt_key: key,
    discard_started_at: casAt.toISOString(),
    ...REVIEW_CLEARED_PATCH,
    next_check_at: iso(casAt.getTime() + DRAFT_LIMITS.discardingStaleMs),
    updated_at: casAt.toISOString()
  };
  if (!(await casDraft(principal, row.id, versionKey(row), discardingPatch))) {
    await auditFinish(auditId, { ok: false, error: "state_conflict" });
    const current = await getDraft(principal, row.id);
    return fail(409, "state_conflict", { status: current?.status ?? null });
  }
  const discarding = applied(row, discardingPatch);
  const answer = await deleteCall(principal, discarding, graphId, ifContentHash, key);
  const mapped = mapDeleteResult(discarding, answer, now, opts);
  let code: string | null = null;
  let to: ExecDraftStatus = "discarding";
  if (!("leaveDiscarding" in mapped)) {
    const outcome = await casTransition(principal, discarding, mapped, now, null);
    if (outcome === "missed") console.warn(`[exec-drafts] ${row.id}: the discard outcome lost its CAS (the row moved on)`);
    alertTransition(mapped, row.id, "discard");
    code = mapped.code;
    to = mapped.to;
  }
  await auditFinish(auditId, {
    ok: to === "discarded",
    result: { outcome: to, code, httpStatus: httpStatusOf(answer), draftStatus: draftStatusOf(answer) },
    error: to === "discarded" ? undefined : auditCode(code ?? "outcome_unknown")
  });
  const readBack = code === "outlook_changed" && !restricted ? await changedReadBack(principal, row.id, gates, now) : null;
  const view = await viewAfter(principal, id, { gates, ea, sendToken, restricted, p3Row: screened.p3Row, now });
  return { status: view.status, code, readBack, view };
}

async function deleteCall(principal: ExecPrincipal, row: ExecDraftRow, graphId: string, ifContentHash: string | null, key: string):
  Promise<CloneAnswer<{ graphId: string; status: "deleted" }>> {
  try {
    const r = await deleteOutlookDraft(principal, { accountId: row.accountId, graphId, ifContentHash, idempotencyKey: key });
    return { ok: true, value: r.deleted, replay: r.replay };
  } catch (err) {
    if (err instanceof CloneEaError) return { ok: false, error: err };
    console.warn(`[exec-drafts] ${row.id}: the delete call failed before an answer (${errorName(err)})`);
    return { ok: false, noAnswer: true };
  }
}

// ---------------------------------------------------------------------------
// POST …/review (R8: T27-T29)
// ---------------------------------------------------------------------------

function toDraftAddress(a: { address: string; name: string } | null): DraftAddress | null {
  return a === null ? null : normalizeDraftAddress({ address: a.address, name: a.name });
}
function toDraftAddresses(list: readonly { address: string; name: string }[]): DraftAddress[] {
  const out: DraftAddress[] = [];
  for (const a of list) {
    const d = toDraftAddress(a);
    if (d !== null) out.push(d);
  }
  return out;
}

export async function reviewDraft(principal: ExecPrincipal, id: string, input: { version: number }): Promise<ReviewResult> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  await requireRateLimit(principal, "draft.review", now);
  const ea = await requireReadiness(principal);
  const loaded = await loadRowOrThrow(principal, id);
  requireUsableAccount(gates, loaded.accountId);
  const screened = await screenOrPurge(principal, loaded);
  if (screened.restricted) fail(404, "not_found");
  let row = screened.row;
  const sendToken = await sendTokenVerdict(principal);
  const ctx = guardContext(row, { principal, gates, ea, sendToken, restricted: false, now });
  requireGuard("review", row, ctx);
  if (input.version !== row.version) fail(409, "version_conflict", { status: row.status });
  const opts = transitionOptions(gates);
  const policy = screened.policy;

  // The live thread (15 s) and its screens; the hashes it adds are written with the review (C11).
  let thread: PrincipalMailThread | "unavailable" | null = null;
  let hashes: { hashes: string[]; truncated: boolean } | null = null;
  if (row.kind === "reply" && row.threadId !== null) {
    let read: Awaited<ReturnType<typeof readPrincipalThread>>;
    try {
      read = await readPrincipalThread(principal, row.threadId, { usable: gates.usable, timeoutMs: ROUTE_THREAD_TIMEOUT_MS });
    } catch (err) {
      console.warn(`[exec-drafts] ${row.id}: the review's thread read failed (${errorName(err)})`);
      return fail(503, "unavailable");
    }
    if (read.kind === "ok") {
      const live = read.thread;
      if (screenRestricted({ all: live.all, participants: live.participants }, policy.rules).verdict === "restricted") {
        await purgeRestrictedThread(principal, row);
        fail(404, "not_found");
      }
      thread = live;
      hashes = screenHashesFor({ all: live.all, participants: live.participants });
    } else {
      thread = "unavailable";
    }
  }

  // The Outlook draft (60 s): review proceeds only on a live saved read-back; anything else is mirrored (T28).
  const answer = await cloneGet(principal, row);
  const read = answer.ok ? liveSaved(answer.value) : null;
  if (read === null) {
    const t = mapGetResult(row, answer, now, opts);
    await casTransition(principal, row, t, now, null);
    alertTransition(t, row.id, "review");
    const answered = answer.ok || (!("noAnswer" in answer) && answer.error.draftStatus !== null);
    if (!answered || t.to === "saved") {
      if (!answer.ok && !("noAnswer" in answer) && answer.error.kind === "throttled") {
        fail(429, "rate_limited", { retryAfterSec: Math.max(1, Math.ceil((answer.error.retryAfterMs ?? 30_000) / 1000)) });
      }
      fail(503, "unavailable");
    }
    return { status: t.to, readBack: null, reviewHash: null, reviewExpiresAt: null, blockers: [], errors: [], warnings: [], sendUnavailable: ctx.sendUnavailable };
  }

  const internal = await internalDomainsLive(principal, gates);
  const readBack = readBackViewOf(read, row, internal);
  const recipientsRead: ReviewRecipients = {
    from: toDraftAddress(read.from), sender: toDraftAddress(read.sender), replyTo: toDraftAddresses(read.replyTo),
    to: toDraftAddresses(read.to), cc: toDraftAddresses(read.cc), bcc: toDraftAddresses(read.bcc)
  };
  const expectedFrom = gates.accountEmail(row.accountId);
  const check = checkRecipients(
    { to: read.to, cc: read.cc, bcc: read.bcc, from: read.from, sender: read.sender, replyTo: read.replyTo },
    recipientContext(row.kind, gates, internal, policy.rules, { allowed: null, expectedFrom })
  );
  const errors: string[] = check.ok ? [] : [...new Set(check.errors.map((e) => e.code))];
  const ddText = `${row.bodyText ?? ""}${row.kind === "new" && row.subject !== null ? `\n${row.subject}` : ""}`;
  const ddPlaceholders = findPlaceholders(ddText);
  if (ddPlaceholders.length > 0) errors.push("placeholders");
  if (row.kind === "new" && read.subject.trim() === "") errors.push("subject_required");
  if (readBack === null) errors.push("preview_unavailable");
  const ownPart = cutQuotedText(htmlToText(read.bodyHtml));
  const ownPartPlaceholders = findPlaceholders(`${ownPart}${row.kind === "new" ? `\n${read.subject}` : ""}`);

  let factsOutsideClient = false;
  if (row.factsStatus === "used" && row.clientId !== null) {
    const gate = await factsGateFor(principal, gates, row.clientId);
    factsOutsideClient = factsRecipientsOutside({ to: read.to, cc: read.cc, bcc: read.bcc }, gate).length > 0;
  }
  let siblings: { id: string; status: ExecDraftStatus }[] = [];
  let legacy: ReplyArtifacts | null = null;
  let parentSentAtMs: number | null = null;
  if (row.kind === "reply" && row.threadId !== null && row.parentMessageId !== null) {
    siblings = await listDraftsForParent(principal, row.threadId, row.parentMessageId, row.id);
    legacy = (await listReplyArtifacts(principal, [row.threadId])).get(row.threadId) ?? null;
    if (thread !== null && thread !== "unavailable") {
      const parent = thread.his.find((m) => m.id === row.parentMessageId);
      const ms = parent !== undefined ? Date.parse(parent.sentAt) : NaN;
      parentSentAtMs = Number.isFinite(ms) ? ms : null;
    }
  }
  const generatedAtMs = row.generatedAt !== null ? Date.parse(row.generatedAt) : NaN;
  const blockers = computeReviewBlockers({
    draftCreatedAtMs: Date.parse(row.createdAt),
    generatedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : null,
    parentMessageId: row.parentMessageId,
    replyMode: row.replyMode,
    parentSentAtMs,
    thread: row.kind === "reply" ? thread ?? "unavailable" : null,
    ownAddresses: gates.ownAddresses,
    legacyArtifacts: legacy,
    siblingDrafts: siblings,
    openedInOutlookAt: row.openedInOutlookAt,
    storedContentHash: row.contentHash,
    readBackContentHash: read.contentHash,
    storedSig: row.recipientsSig,
    readBackSig: recipientsSignature({ to: recipientsRead.to, cc: recipientsRead.cc, bcc: recipientsRead.bcc }),
    readBackReplyToCount: read.replyTo.length,
    ownPartPlaceholders,
    ddPlaceholders,
    factsOutsideClient,
    generationFlags: row.generationFlags,
    usesPrivateRefs: row.usesPrivateRefs
  });

  // T27: the content hash is written either way (the read-back is shown, C66); the review only without errors.
  const valid = errors.length === 0;
  const patch: Record<string, unknown> = {
    content_hash: read.contentHash,
    observed_content_hash: read.contentHash,
    clone_flags: knownFlags(read.flags),
    ...(read.internetMessageId !== null ? { internet_message_id: read.internetMessageId } : {}),
    ...(read.webLink !== null ? { web_link: read.webLink } : {}),
    ...(read.conversationId !== null ? { conversation_id: read.conversationId } : {}),
    ...(valid
      ? { review_hash: read.contentHash, review_at: now.toISOString(), review_blockers: blockers, review_recipients: recipientsRead }
      : REVIEW_CLEARED_PATCH),
    ...(hashes !== null
      ? {
          screen_hashes: [...new Set([...row.screenHashes, ...hashes.hashes])].sort().slice(0, 600),
          screen_truncated: row.screenTruncated || hashes.truncated || row.screenHashes.length + hashes.hashes.length > 600,
          screened_policy_hash: policy.hash
        }
      : {}),
    updated_at: now.toISOString()
  };
  await casOrConflict(principal, row, versionKey(row), patch);
  row = applied(row, patch);
  await auditEvent(principal, {
    actor: "owner",
    action: "draft.review",
    target: `exec_drafts:${row.id}`,
    input: {
      draftId: row.id, version: row.version,
      recipientCount: recipientsRead.to.length + recipientsRead.cc.length + recipientsRead.bcc.length,
      externalDomainCount: check.warnings.filter((w) => w.code === "external_domain").length,
      outcome: valid ? "valid" : "errors"
    }
  });
  return {
    status: row.status,
    readBack,
    reviewHash: valid ? read.contentHash : null,
    reviewExpiresAt: valid ? iso(now.getTime() + DRAFT_LIMITS.reviewTtlMs) : null,
    blockers: valid ? blockers : [],
    errors,
    warnings: check.warnings.map((w) => ({ code: w.code, value: w.value })),
    sendUnavailable: ctx.sendUnavailable,
    ...withClientName(factsOutsideClient ? await factsClientName(principal, row, false) : null),
    ...(check.ok ? {} : { errorEntries: check.errors.map((e) => ({ code: e.code, address: e.address })) })
  };
}

// ---------------------------------------------------------------------------
// POST …/outlook-opened (R11: T41)
// ---------------------------------------------------------------------------

export async function markOutlookOpened(principal: ExecPrincipal, id: string): Promise<DraftView> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  const loaded = await loadRowOrThrow(principal, id);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const [ea, sendToken] = await Promise.all([peekReadiness(principal), sendTokenVerdict(principal)]);
  requireGuard("outlook_opened", row, guardContext(row, { principal, gates, ea, sendToken, restricted: screened.restricted, now }));
  const base: Record<string, unknown> = { opened_in_outlook_at: now.toISOString(), ...REVIEW_CLEARED_PATCH, updated_at: now.toISOString() };
  // C69: a saved or linked draft row is checked at +25 s, then +2 and +10 min; unknown / sent_pending keep their schedule.
  if (row.status === "saved" || row.status === "draft") base.next_check_at = nextCheckAt(applied(row, base), now);
  await casOrConflict(principal, row, versionKey(row), base);
  try {
    await enqueueJob(draftReconcileKick(principal, new Date(now.getTime() + KICK_DELAY_MS), `o${row.id}:${Math.floor(now.getTime() / MIN_MS)}`));
  } catch (err) {
    console.warn(`[exec-drafts] ${row.id}: the reconcile kick was not queued (${errorName(err)})`);
  }
  await auditEvent(principal, { actor: "owner", action: "draft.outlook_opened", target: `exec_drafts:${row.id}`, input: { draftId: row.id, version: row.version } });
  return viewAfter(principal, id, { gates, ea, sendToken, restricted: false, p3Row: screened.p3Row, now });
}

// ---------------------------------------------------------------------------
// POST …/resolve (R12: T42-T49)
// ---------------------------------------------------------------------------

type ResolveAnswer = { status: ExecDraftStatus; newDraftId: string | null; code: string | null; readBack: ReadBackView | null; view: DraftView | null };

export async function resolveDraft(principal: ExecPrincipal, id: string, input: { action: ResolveAction; checkedOutlook?: boolean; seenContentHash?: string }):
  Promise<{ status: ExecDraftStatus; newDraftId: string | null; code: string | null; readBack: ReadBackView | null; view: DraftView | null }> {
  const now = new Date();
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal);
  const loaded = await loadRowOrThrow(principal, id);
  requireUsableAccount(gates, loaded.accountId);
  const screened = await screenOrPurge(principal, loaded);
  const row = screened.row;
  const restricted = screened.restricted || row.restrictedPurged;
  const opts = transitionOptions(gates);
  const checkedOutlook = input.checkedOutlook === true;
  const action = `resolve:${input.action}` as DraftAction;
  let [ea, sendToken] = await Promise.all([peekReadiness(principal), sendTokenVerdict(principal)]);
  const g = (): GuardInputs => ({ principal, gates, ea, sendToken, restricted, now });
  const view = (r = restricted) => viewAfter(principal, id, { gates, ea, sendToken, restricted: r, p3Row: screened.p3Row, now });
  const event = (outcome: string, code: string | null) =>
    auditEvent(principal, {
      actor: "owner",
      action: input.action === "check" ? "draft.check" : "draft.resolve",
      target: `exec_drafts:${row.id}`,
      input: { draftId: row.id, action: input.action, checkedOutlook, outcome, code }
    });

  // The guard without the sent-copy answer first: the horizon and the state refuse before any clone read.
  const callsClone = input.action === "not_sent_new_draft" || input.action === "keep_outlook_version" || input.action === "check" ||
    (input.action === "copy_to_new_draft" && hasLink(row));
  if (input.action === "check") await requireRateLimit(principal, "draft.check", now);
  if (callsClone) ea = await requireReadiness(principal);
  const first = guard(action, row, guardContext(row, g(), { checkedOutlook: true }));
  if (!first.ok) requireGuard(action, row, guardContext(row, g(), { checkedOutlook: true }));

  switch (input.action) {
    case "stop_generation": {
      // T48 (C71): G; a regenerate returns to its prior status with its content, a first generation fails as stopped.
      const nowIso = now.toISOString();
      const patch: DraftPatch = row.priorStatus === null
        ? { status: "generation_failed", generation_error: "stopped", prior_status: null, next_check_at: null, updated_at: nowIso }
        : { status: priorStatusOf(row), last_error_code: "generation_stopped", last_error_at: nowIso, prior_status: null, next_check_at: null, updated_at: nowIso };
      await casOrConflict(principal, row, { status: "generating", version: row.version, generationSeq: row.generationSeq }, patch);
      await event("stopped", null);
      const v = await view();
      return { status: v.status, newDraftId: null, code: null, readBack: null, view: v };
    }
    case "check": {
      // T49 (C70): one GET through the sweep's per-status handler, in the request, no claim.
      const r = await checkDraftOnce(principal, row, now, opts);
      await event(r.transition.to, r.transition.code);
      const read = liveSaved(r.read);
      const readBack = !restricted && read !== null && (row.status === "saved" || row.status === "draft") ? readBackViewOf(read, row, ownDomains(gates)) : null;
      const v = await view();
      return { status: v.status, newDraftId: null, code: r.transition.code, readBack, view: v };
    }
    case "mark_sent": {
      // T42 / T46: his explicit confirmation; terminal, unverified.
      requireGuard(action, row, guardContext(row, g(), { checkedOutlook }));
      const patch: DraftPatch = {
        ...terminalPatch(row, "sent", now, opts),
        owner_resolution: "sent",
        unverified: true,
        sent_at: row.sentAt ?? row.sendAcceptedAt ?? now.toISOString()
      };
      await casOrConflict(principal, row, versionKey(row), patch);
      await event("sent", null);
      const v = await view();
      return { status: v.status, newDraftId: null, code: null, readBack: null, view: v };
    }
    case "not_sent_new_draft":
      return resolveNotSent(principal, row, { gates, ea, sendToken, restricted, now, opts, checkedOutlook, seenContentHash: input.seenContentHash, view, event });
    case "copy_to_new_draft":
      return resolveCopy(principal, row, { gates, ea, sendToken, restricted, now, opts, checkedOutlook, view, event });
    case "keep_outlook_version":
      return resolveKeep(principal, row, { gates, now, opts, seenContentHash: input.seenContentHash, view, event });
  }
}

interface ResolveContext {
  gates: DraftGates;
  ea: EaReadiness | null;
  sendToken: Pick<SendTokenState, "ok"> | null;
  restricted: boolean;
  now: Date;
  opts: TransitionOptions;
  checkedOutlook: boolean;
  seenContentHash?: string;
  view: (restricted?: boolean) => Promise<DraftView>;
  event: (outcome: string, code: string | null) => Promise<void>;
}

/** The clone's registry status from a GET answer (a read, or an error's draftStatus); null when there was no answer. */
function cloneStatusOf(answer: CloneAnswer<CloneDraftRead>): string | null {
  if (answer.ok) return answer.value.status;
  if ("noAnswer" in answer) return null;
  return answer.error.draftStatus;
}

/** T43 (C76): GET first; a live Outlook draft is deleted (prior unknown), none is closed directly; the successor only after `discarded`. */
async function resolveNotSent(principal: ExecPrincipal, row: ExecDraftRow, c: ResolveContext): Promise<ResolveAnswer> {
  const action: DraftAction = "resolve:not_sent_new_draft";
  const sentCopy = await sentCopyFor(principal, row);
  const verdict = guard(action, row, guardContext(row, { principal, gates: c.gates, ea: c.ea, sendToken: c.sendToken, restricted: c.restricted, now: c.now }, { checkedOutlook: c.checkedOutlook, sentCopy }));
  if (!verdict.ok && verdict.code === "sent_copy_found") {
    await recordSentCopy(principal, row, c.now, c.opts);
    fail(409, "sent_copy_found");
  }
  requireGuard(action, row, guardContext(row, { principal, gates: c.gates, ea: c.ea, sendToken: c.sendToken, restricted: c.restricted, now: c.now }, { checkedOutlook: c.checkedOutlook, sentCopy }));

  const answer = await cloneGet(principal, row);
  const status = cloneStatusOf(answer);
  if (status === null && !(!answer.ok && !("noAnswer" in answer) && answer.error.kind === "not_found")) {
    // The clone is unreachable: unchanged, try again.
    return fail(503, "unavailable");
  }
  if (status === null || status === "unknown" || status === "sending") {
    // No Outlook draft to delete: V unknown → discarded directly, not_sent.
    const patch: DraftPatch = { ...terminalPatch(row, "discarded", c.now, c.opts), owner_resolution: "not_sent" };
    await casOrConflict(principal, row, versionKey(row), patch);
    const next = await insertSuccessor(principal, row);
    await c.event("discarded", status === null ? "not_in_registry" : null);
    const v = await c.view();
    return { status: v.status, newDraftId: next?.id ?? null, code: next?.existing ? "existing" : null, readBack: null, view: v };
  }
  if (status !== "saved") {
    // The clone knows better (sent, gone, deleted): mirror it and say so.
    const t = mapGetResult(row, answer, c.now, c.opts);
    await casTransition(principal, row, t, c.now, null);
    alertTransition(t, row.id, "resolve");
    if (t.to === "sent" || t.to === "sent_external") fail(409, "sent_copy_found");
    return fail(409, "state_conflict", { status: t.to });
  }

  // A live Outlook draft: audited DELETE (C51), prior unknown (C76).
  const graphId = row.outlookGraphId as string;
  const key = deleteKey(row.id, graphId, newKeyNonce());
  const ifContentHash = c.restricted ? null : c.seenContentHash ?? row.contentHash;
  const auditId = await auditStart(principal, {
    actor: "owner",
    action: "draft.resolve",
    target: `exec_drafts:${row.id}`,
    input: { draftId: row.id, action: "not_sent_new_draft", checkedOutlook: c.checkedOutlook, graphIdFp: graphIdFp(graphId) }
  });
  const casAt = new Date(); // data-5: the attempt's clock starts at the CAS
  const discardingPatch: Record<string, unknown> = {
    status: "discarding",
    prior_status: "unknown",
    discard_attempt_key: key,
    discard_started_at: casAt.toISOString(),
    ...REVIEW_CLEARED_PATCH,
    next_check_at: iso(casAt.getTime() + DRAFT_LIMITS.discardingStaleMs),
    updated_at: casAt.toISOString()
  };
  if (!(await casDraft(principal, row.id, versionKey(row), discardingPatch))) {
    await auditFinish(auditId, { ok: false, error: "state_conflict" });
    const current = await getDraft(principal, row.id);
    return fail(409, "state_conflict", { status: current?.status ?? null });
  }
  const discarding = applied(row, discardingPatch);
  const del = await deleteCall(principal, discarding, graphId, ifContentHash, key);
  const mapped = mapDeleteResult(discarding, del, c.now, c.opts);
  let to: ExecDraftStatus = "discarding";
  let code: string | null = null;
  let landed = false;
  if (!("leaveDiscarding" in mapped)) {
    landed = (await casTransition(principal, discarding, mapped, c.now, null)) === "applied";
    alertTransition(mapped, row.id, "resolve");
    to = mapped.to;
    code = mapped.code;
  }
  await auditFinish(auditId, {
    ok: to === "discarded",
    result: { outcome: to, code, httpStatus: httpStatusOf(del), draftStatus: draftStatusOf(del), checkedOutlook: c.checkedOutlook },
    error: to === "discarded" ? undefined : auditCode(code ?? "outcome_unknown")
  });
  // Only after `discarded` is recorded: the successor (never for a restricted row, C13).
  const next = to === "discarded" && landed ? await insertSuccessor(principal, row) : null;
  const readBack = code === "outlook_changed" && !c.restricted ? await changedReadBack(principal, row.id, c.gates, c.now) : null;
  const v = await c.view();
  return { status: v.status, newDraftId: next?.id ?? null, code: code ?? (next?.existing ? "existing" : null), readBack, view: v };
}

/** T45 (C17, buildability-3): the sent-copy check, one GET of a linked row, the CAS clearing gone_unconfirmed, then the insert. */
async function resolveCopy(principal: ExecPrincipal, row: ExecDraftRow, c: ResolveContext): Promise<ResolveAnswer> {
  const action: DraftAction = "resolve:copy_to_new_draft";
  const sentCopy = await sentCopyFor(principal, row);
  const ctx = guardContext(row, { principal, gates: c.gates, ea: c.ea, sendToken: c.sendToken, restricted: c.restricted, now: c.now }, { checkedOutlook: c.checkedOutlook, sentCopy });
  const verdict = guard(action, row, ctx);
  if (!verdict.ok && verdict.code === "sent_copy_found") {
    await recordSentCopy(principal, row, c.now, c.opts);
    fail(409, "sent_copy_found");
  }
  requireGuard(action, row, ctx);

  if (hasLink(row)) {
    const answer = await cloneGet(principal, row);
    const status = cloneStatusOf(answer);
    if (status === null && !(!answer.ok && !("noAnswer" in answer) && answer.error.kind === "not_found")) return fail(503, "unavailable");
    if (status !== null && status !== "gone" && status !== "deleted") {
      // The draft is back (or was sent): mirror it, no new draft.
      const t = mapGetResult(row, answer, c.now, c.opts);
      await casTransition(principal, row, t, c.now, null);
      alertTransition(t, row.id, "resolve");
      if (t.to === "sent" || t.to === "sent_external") fail(409, "sent_copy_found");
      return fail(409, "state_conflict", { status: t.to });
    }
  }
  // (2) V gone → gone with gone_unconfirmed = false, so the copy can take the thread's one active slot. The version
  // bump fences a concurrent second click (its CAS on V misses: 409), and `copied` stops the offer afterwards, so a
  // new email (no thread, outside the one-active index) never gets two successors (data-7).
  await casOrConflict(principal, row, versionKey(row), {
    version: row.version + 1, gone_unconfirmed: false, next_check_at: null,
    last_error_code: "copied", last_error_at: c.now.toISOString(), updated_at: c.now.toISOString()
  });
  const next = await insertSuccessor(principal, row);
  await c.event("copied", next?.existing ? "existing" : null);
  const v = await c.view();
  return { status: v.status, newDraftId: next?.id ?? null, code: next?.existing ? "existing" : null, readBack: null, view: v };
}

/** T47 (C53): a fresh GET whose contentHash equals the one he was shown; then saved with outlook_edited. */
async function resolveKeep(principal: ExecPrincipal, row: ExecDraftRow,
  c: Pick<ResolveContext, "gates" | "now" | "opts" | "seenContentHash" | "view" | "event">): Promise<ResolveAnswer> {
  const seen = c.seenContentHash;
  if (seen === undefined || !HEX64_RE.test(seen)) return fail(422, "invalid", { problems: ["seenContentHash"] });
  const answer = await cloneGet(principal, row);
  const read = answer.ok ? liveSaved(answer.value) : null;
  if (read === null) {
    const t = mapGetResult(row, answer, c.now, c.opts);
    await casTransition(principal, row, t, c.now, null);
    if (cloneStatusOf(answer) === null) return fail(503, "unavailable");
    return fail(409, "state_conflict", { status: t.to });
  }
  if (read.contentHash !== seen) {
    // Changed again since he looked: record what was seen (observed) and show him this version.
    const t = mapGetResult(row, answer, c.now, c.opts);
    await casTransition(principal, row, t, c.now, null);
    const v = await c.view();
    return { status: v.status, newDraftId: null, code: "outlook_changed", readBack: readBackViewOf(read, row, ownDomains(c.gates)), view: v };
  }
  const base: Record<string, unknown> = {
    status: "saved",
    prior_status: null,
    saved_version: row.version,
    content_hash: seen,
    observed_content_hash: seen,
    outlook_edited: true,
    last_error_code: null,
    last_error_at: null,
    ...(read.internetMessageId !== null ? { internet_message_id: read.internetMessageId } : {}),
    ...(read.webLink !== null ? { web_link: read.webLink } : {}),
    ...(read.conversationId !== null ? { conversation_id: read.conversationId } : {}),
    ...REVIEW_CLEARED_PATCH,
    updated_at: c.now.toISOString()
  };
  await casOrConflict(principal, row, versionKey(row), { ...base, next_check_at: nextCheckAt(applied(row, base), c.now) });
  await c.event("kept", null);
  const v = await c.view();
  return { status: v.status, newDraftId: null, code: null, readBack: null, view: v };
}

// ---------------------------------------------------------------------------
// Helpers for the send route (§3.12.4), which may not live here (B3)
// ---------------------------------------------------------------------------

/** His addresses' domains plus the matcher-free internal set: the send route's warnings and its recipient re-check. */
export function sendRecipientContext(row: ExecDraftRow, gates: DraftGates, rules: readonly RestrictedSenderRule[]): RecipientContext {
  return recipientContext(row.kind, gates, ownDomains(gates), rules, { allowed: null, expectedFrom: gates.accountEmail(row.accountId) });
}

/** The review cleared on a still-saved row (RS06: a recipient that turned restricted after the review). */
export async function clearReview(principal: ExecPrincipal, row: ExecDraftRow, now: Date): Promise<void> {
  await casDraft(principal, row.id, versionKey(row), { ...REVIEW_CLEARED_PATCH, updated_at: now.toISOString() });
}

/** The send route's success / mapped answers, never carrying clone text (RS13). */
export function draftAnswer(status: number, body: Record<string, unknown>): NextResponse {
  return jsonAnswer(status, body);
}

// ---------------------------------------------------------------------------
// P5b (contract §3.23 F1, §3.0.2; Area F): the chat's reply-draft entry point
// ---------------------------------------------------------------------------

/** Every policy outcome of createChatReplyDraft is a value, never an error; restricted, missing and not-his threads are all
 *  unavailable_thread (the reason never leaks); the look-back's hold / sent_copy_found is needs_check; an enqueue failure
 *  is unavailable. */
export type ChatDraftRefusal = "drafts_off" | "email_off" | "no_pin" | "mailbox_problem" | "rate_limited" | "drafts_unavailable"
  | "unavailable_thread" | "needs_check" | "unavailable";
export type ChatDraftResult =
  | { kind: "created" | "existing"; draftId: string; status: ExecDraftStatus }
  | { kind: "refused"; reason: ChatDraftRefusal };

/**
 * F1: server-only, never reachable from a request body (F11: only agent/tools.ts imports it). P4's gates in P4's order
 * (G5, G5b, G6, G7, G8), then R2's reply steps; inserts with origin 'chat', instruction_by 'assistant', usesPrivateRefs
 * and generate; enqueues exec.draft-generate; writes draft.create and draft.generate.request. An existing active draft is
 * returned unchanged. Infrastructure errors throw.
 *
 * The steps (§3.23 F1): G5 the drafts schema, and P5b's pieces of it (instruction_by, the private_refs blocker:
 * chatSchemaReady), else drafts_unavailable; G5b drafts_off, then email_off; G6 no_pin, then mailbox_problem; G7 the
 * generation count P4's routes use (C38: draft.generate.request rows in the last 10 min, 20 at most); G8 EA readiness
 * (drafts_unavailable). Then R2's reply steps: the live read and both screens (restricted, missing and not-his are
 * all unavailable_thread), the derivation (no anchor: unavailable_thread; the parent's account not usable:
 * mailbox_problem); T03's active-draft check (existing, nothing written) before C63's look-back (P4's order: the
 * look-back is for inactive drafts; hold / sent_copy_found are needs_check); then the insert, both audit events and
 * the job (a failed enqueue is T06 `stale` and unavailable). The signal reaches the reads only: from the insert on
 * the row, its audit events and its job are written together, so an abort can't leave a generating row with no job.
 * A malformed input (the tool validates first) throws NonRetryableError; a read that throws (DB, clone, rules) throws.
 */
export async function createChatReplyDraft(
  principal: ExecPrincipal,
  input: { threadId: string; instruction: string; usesPrivateRefs: boolean; chatMessageId?: string | null },
  opts: { signal?: AbortSignal } = {}
): Promise<ChatDraftResult> {
  if (typeof input !== "object" || input === null || typeof input.threadId !== "string" || typeof input.instruction !== "string" ||
    typeof input.usesPrivateRefs !== "boolean") {
    throw new NonRetryableError("createChatReplyDraft: the input is malformed");
  }
  // security-2: the answer that asked for it (an ecm_ id), stored on the row so the chat purge by id finds it.
  const chatMessageId = input.chatMessageId ?? null;
  if (chatMessageId !== null && (typeof chatMessageId !== "string" || !CHAT_MESSAGE_ID.test(chatMessageId))) {
    throw new NonRetryableError("createChatReplyDraft: the chat message id is malformed");
  }
  const text = input.instruction.trim();
  if (text.length > DRAFT_LIMITS.instructionChars) throw new NonRetryableError("createChatReplyDraft: the instruction is too long");
  try {
    return await chatReplyDraft(principal, input.threadId, text === "" ? null : text, input.usesPrivateRefs, chatMessageId, opts.signal);
  } catch (err) {
    // Every policy outcome is a value (F1): a P4 helper that answers with a route error (the look-back's sent-copy
    // check, 503) becomes one too, so a DraftRouteError never reaches chat.
    if (err instanceof DraftRouteError) return chatRefusal(CHAT_REFUSAL_OF_ROUTE_CODE[err.code] ?? "unavailable");
    throw err;
  }
}

const chatRefusal = (reason: ChatDraftRefusal): ChatDraftResult => ({ kind: "refused", reason });
/** exec_messages ids (the chat_message_id CHECK). */
const CHAT_MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;

/** The route codes a P4 helper could answer with inside createChatReplyDraft, as chat refusals (never the reason). */
const CHAT_REFUSAL_OF_ROUTE_CODE: Readonly<Partial<Record<DraftErrorCode, ChatDraftRefusal>>> = Object.freeze({
  drafts_off: "drafts_off",
  mailbox_problem: "mailbox_problem",
  rate_limited: "rate_limited",
  drafts_unavailable: "drafts_unavailable",
  not_found: "unavailable_thread",
  thread_unavailable: "unavailable_thread",
  hold: "needs_check",
  sent_copy_found: "needs_check"
});

async function chatReplyDraft(principal: ExecPrincipal, threadId: string, instruction: string | null, usesPrivateRefs: boolean,
  chatMessageId: string | null, signal: AbortSignal | undefined): Promise<ChatDraftResult> {
  const now = new Date();
  const readOpts = signal !== undefined ? { signal } : {};
  const gates = await loadDraftGates(principal);
  const s = gates.settings;
  // G5: P4's schema, and P5b's columns on it: an assistant-written row can't be stored before P5b's migration.
  if (!s.draftsSchemaReady || !s.chatSchemaReady) return chatRefusal("drafts_unavailable");
  // G5b
  if (!s.draftsEnabled) return chatRefusal("drafts_off");
  if (!s.emailSchemaReady || !s.emailEnabled) return chatRefusal("email_off");
  // G6
  if (pinnedAccounts(principal).length === 0) return chatRefusal("no_pin");
  if (gates.usable.length === 0) return chatRefusal("mailbox_problem");
  // G7 (C38, C40): the same count the web generations use, so chat and web share one limit.
  signal?.throwIfAborted();
  const recent = await countRecentAudit(principal, "draft.generate.request", iso(now.getTime() - RATE_WINDOW_MS), readOpts);
  if (recent >= DRAFT_RATE_LIMITS["draft.generate.request"]) return chatRefusal("rate_limited");
  // G8 (C24)
  const ea = await getEaReadiness(principal);
  if (!ea.ok) return chatRefusal("drafts_unavailable");
  signal?.throwIfAborted();

  // R2's reply steps (C26, C11, L8): the reason a thread isn't available never leaks.
  const prep = await prepareReply(principal, gates, threadId, false, { rethrow: true, ...readOpts });
  if (!prep.ok) {
    if (prep.code === "mailbox_problem") return chatRefusal("mailbox_problem");
    if (prep.code === "unavailable") return chatRefusal("unavailable");
    return chatRefusal("unavailable_thread");
  }
  // T03 first: an active draft is answered as it is; the chat's instruction is not applied and nothing is written.
  const active = await getActiveDraftForThread(principal, threadId, readOpts);
  if (active !== null) return { kind: "existing", draftId: active.id, status: active.status };
  const look = await lookBack(principal, gates, threadId, prep.derived.parent.id, prep.thread, false, now);
  if (!look.ok) return chatRefusal("needs_check");
  signal?.throwIfAborted();

  // T01 with generate: origin 'chat', the instruction the assistant wrote (F7: 'assistant'), the private-refs flag.
  const row: NewDraftRow = {
    ...replyRow(principal, prep, threadId, true, instruction, now),
    origin: "chat",
    instructionBy: "assistant",
    usesPrivateRefs,
    chatMessageId
  };
  const inserted = await insertDraft(principal, row);
  if (!inserted.inserted) {
    const existing = await getDraft(principal, inserted.existingId);
    return { kind: "existing", draftId: inserted.existingId, status: existing?.status ?? "draft" };
  }
  const created = inserted.row;
  // P4's draft.create, and the draft.generate.request P4's C38 limit counts (C40). Keys within AUDIT_INPUT_KEYS.
  for (const action of ["draft.create", "draft.generate.request"] as const) {
    await auditEvent(principal, {
      actor: "owner",
      action,
      target: `exec_drafts:${created.id}`,
      input: { draftId: created.id, threadId, accountId: created.accountId, kind: "reply", origin: "chat" }
    });
  }
  try {
    await enqueueGeneration(principal, created);
  } catch (err) {
    // T06: enqueueGeneration has already closed the attempt (generation_failed, stale).
    if (err instanceof DraftRouteError) return chatRefusal("unavailable");
    throw err;
  }
  return { kind: "created", draftId: created.id, status: created.status };
}
