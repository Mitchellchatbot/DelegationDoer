// Server-side typed wrapper around the missive-clone API.
// All calls go through `missiveFetch` which adds the bearer token and
// surfaces non-2xx responses with a useful error string.
//
// Required env vars:
//   MISSIVE_API_URL    — e.g. https://missiveclone-production.up.railway.app
//   MISSIVE_API_TOKEN  — long-lived JWT issued by the clone for our service
//                        account. Pull from missive UI's localStorage for now.

import { cache } from "@/lib/safe-cache";
import { MAX_ATTACHMENTS_PER_EMAIL, tooManyAttachmentsMessage } from "@/lib/email-attachments";
import { unstable_cache } from "next/cache";

export interface MissiveAccount {
  id: string;
  email: string;
  display_name: string | null;
  workspace_id: string;
  // The Missive user who connected this account. We use this to seed
  // pre-existing connections in the assignment graph.
  user_id: string | null;
  last_synced_at: string | null;
  provider: string | null;
  // The clone's last sync failure for this mailbox (an AADSTS / invalid_grant
  // text for a revoked grant), and when it happened as ISO (the clone sends a
  // BIGINT epoch-ms string; fetchAccounts converts it). Null once a sync
  // succeeds; undefined from a clone that doesn't send them.
  last_sync_error?: string | null;
  last_sync_error_at?: string | null;
}

export interface MissiveTeamMember {
  id: string;
  email: string;
  name: string | null;
}

export interface MissiveThread {
  id: string;
  subject: string;
  participants: string[];
  status: "open" | "pending" | "closed";
  assignee_id: string | null;
  last_message_at: string;
  starred: boolean;
  snoozed_until: string | null;
  message_count?: number;
  // Connected-account fan-out. The clone aggregates the email addresses
  // of every account whose messages appear in this thread, so we can
  // tell which inboxes a thread "belongs to" without joining per-message.
  account_emails?: { email: string; name: string | null }[];
  // Newest-message preview for the conversation list: who sent the most
  // recent message and a short plaintext snippet of its body. Optional —
  // ThreadRow falls back to the original sender + no snippet if absent.
  last_from?: string | null;
  last_snippet?: string | null;
  // True when this thread's latest OUTBOUND message was sent as an
  // automated/templated blast (Scaled Operations's bulk-email tool). The clone
  // derives it from the newest outbound message's is_automated flag;
  // touchpoint-sync skips these so a mass send doesn't reset "last contacted".
  automated?: boolean;
  // ISO timestamp of this thread's newest OUTBOUND message — i.e. when WE last
  // actually sent, distinct from last_message_at (which advances on inbound
  // client replies too). Only present from an upgraded clone; undefined/null on
  // older builds, so consumers fall back to last_message_at.
  last_outbound_at?: string | null;
  // ISO timestamp of the newest inbound, non-junk message ever ingested into
  // the thread (CL1). Thread-wide across every account, and a high-water mark
  // the clone never lowers. Undefined from a pre-CL1 clone.
  last_inbound_at?: string | null;
}

// Per-message attachment metadata as returned by the clone's
// GET /api/threads/:id (each message carries an `attachments` array). The
// bytes are NOT inlined — download them through the DD proxy at
// /api/inboxes/attachments/[id], which streams from the clone's
// GET /api/attachments/:id using the service token.
export interface MissiveMessageAttachment {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  // The MIME part's Content-ID, stored without angle brackets. NOT an inline
  // signal on its own: the clone keeps it on nearly every part (Outlook stamps
  // one on ordinary PDFs and invites too). An attachment is inline only when
  // its message's body references `cid:<content_id>` — see
  // referencedInlineIds / chipAttachments in inline-cid.ts.
  content_id: string | null;
}

export interface MissiveMessage {
  id: string;
  thread_id: string;
  account_id: string;
  direction: "inbound" | "outbound";
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  subject: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  body_text: string | null;
  body_html: string | null;
  sent_at: string;
  has_attachments: boolean;
  // Only populated by getThread; the thread-list endpoints omit it.
  attachments?: MissiveMessageAttachment[];
  // Set only on getThread(..., { deferBodies: true }) responses from an
  // upgraded clone. `snippet` is a server-computed one-line preview for the
  // collapsed stub; `body_deferred` marks a message whose body_html/body_text
  // were withheld (null) and must be fetched on demand via fetchMessageBody.
  snippet?: string | null;
  body_deferred?: boolean;
  // Passed through raw by normalizeMessage's spread (typed here, never
  // converted): created_at is the clone's ingest time as a BIGINT epoch-ms
  // digit string, is_automated its INTEGER 0/1 bulk-send flag (a boolean from
  // some builds), account_email / account_name the owning mailbox.
  created_at?: string | number | null;
  is_automated?: number | boolean | null;
  account_email?: string | null;
  account_name?: string | null;
}

export interface MissiveThreadDetail {
  thread: MissiveThread;
  messages: MissiveMessage[];
}

// A missing endpoint or token is a configuration fault: retrying can't fix it.
// The message is unchanged; errorClass "auth" makes the exec job runner (which
// reads errorClass first) dead-letter the job and raise its credentials alert
// instead of retrying it for hours.
function configError(message: string): Error {
  return Object.assign(new Error(message), { errorClass: "auth" as const });
}

function baseUrl(): string {
  const url = process.env.MISSIVE_API_URL;
  if (!url) throw configError("MISSIVE_API_URL not set");
  return url.replace(/\/$/, "");
}

function token(): string {
  const t = process.env.MISSIVE_API_TOKEN;
  if (!t) throw configError("MISSIVE_API_TOKEN not set");
  return t;
}

/**
 * A non-2xx answer from the clone. The message is exactly the text
 * missiveFetch always threw ("missive <path> → <status> <body…>"), so callers
 * that show or match it see no change. `status` is what callers that classify
 * failures read: the exec job runner turns 401/403 into "auth", 429/5xx into
 * "retryable" and any other 4xx into "fatal".
 */
export class MissiveHttpError extends Error {
  readonly status: number;
  /** The request path, query string included. */
  readonly path: string;
  /** From a Retry-After header (429/503), in ms. */
  readonly retryAfterMs?: number;
  /**
   * The error body was JSON: the clone's own `{ error }` answers. A non-JSON
   * 404 is Express's default "Cannot GET" page, i.e. this clone build has no
   * such route (how listMessagesFeed detects a pre-CL1 clone).
   */
  readonly jsonBody: boolean;
  constructor(message: string, init: { status: number; path: string; retryAfterMs?: number; jsonBody: boolean }) {
    super(message);
    this.name = "MissiveHttpError";
    this.status = init.status;
    this.path = init.path;
    this.jsonBody = init.jsonBody;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

// Retry-After is either delta-seconds or an HTTP date.
function retryAfterMsOf(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

async function missiveFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // FormData bodies set their own Content-Type with a boundary param —
  // forcing application/json would corrupt the multipart parse on the
  // clone side. Detect FormData and skip the default.
  const isMultipart =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token()}`
  };
  if (!isMultipart) baseHeaders["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...baseHeaders, ...(init.headers ?? {}) },
    cache: "no-store"
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MissiveHttpError(`missive ${path} → ${res.status} ${body.slice(0, 200)}`, {
      status: res.status,
      path,
      retryAfterMs: retryAfterMsOf(res.headers.get("retry-after")),
      jsonBody: /\bjson\b/i.test(res.headers.get("content-type") ?? "")
    });
  }
  return (await res.json()) as T;
}

// Request-scoped memoization: the account list is stable within a single server
// request, so the copies fetched by visibleAccountIdsFor and loadThreadDetail
// (and any other caller in the same request) collapse to ONE clone round-trip.
// React's cache() is keyed by args; listAccounts takes none, so one call/request.
// The raw clone round-trip. Kept as a plain function so BOTH the request-scoped
// listAccounts (React cache) and the cross-request listAccountsCached
// (unstable_cache) can wrap it directly — nesting React's cache() inside
// unstable_cache's callback is unsafe, since revalidation can run outside a
// request scope where cache() isn't valid.
async function fetchAccounts(): Promise<MissiveAccount[]> {
  return fetchAccountsWith({});
}

async function fetchAccountsWith(init: RequestInit): Promise<MissiveAccount[]> {
  // The clone returns { accounts: [...] }. If you've extended it, adjust here.
  const data = await missiveFetch<{ accounts: MissiveAccount[] }>("/api/accounts", init);
  return (data.accounts ?? []).map((a) => ({
    ...a,
    last_synced_at: a.last_synced_at ? toIsoString(a.last_synced_at) : null,
    // BIGINT epoch-ms from pg, like last_synced_at. An unparseable value
    // becomes null rather than "", so "is there an error time" stays a null check.
    last_sync_error_at: a.last_sync_error_at ? toIsoString(a.last_sync_error_at) || null : null
  }));
}

/**
 * listAccounts without any caching, for background jobs: one fresh clone
 * round trip per call, cancellable through `signal` (React's cache() is a
 * pass-through outside a request anyway, and unstable_cache doesn't belong in
 * the instrumentation layer).
 */
export async function listAccountsFresh(opts: { signal?: AbortSignal } = {}): Promise<MissiveAccount[]> {
  return fetchAccountsWith(opts.signal ? { signal: opts.signal } : {});
}

// `cache` here is the runtime-safe wrapper (see safe-cache): the real React
// cache() in an RSC render, a pass-through when this module is loaded from the
// instrumentation/cron runtime where cache() doesn't exist.
export const listAccounts = cache(fetchAccounts);

// Cross-request cached variant of listAccounts for the hot READ paths (the
// inbox list/detail pages). The connected-account list changes only when an
// inbox is connected or disconnected, so a short TTL removes the ~1s
// /api/accounts round-trip from most page loads (React's cache() only
// de-dupes within a single request). Access checks and the manage/mutation
// paths keep calling listAccounts() so they stay request-fresh. To reflect a
// connect/disconnect immediately instead of waiting out the TTL, call
// revalidateTag("missive-accounts") from that mutation.
export const listAccountsCached = unstable_cache(
  fetchAccounts,
  ["missive-accounts-v1"],
  { revalidate: 60, tags: ["missive-accounts"] }
);

// Page 1 of the numbered-pages list is SSR'd. This MUST equal the client's
// PAGE_SIZE (InboxThreadsClient) so page offsets line up — page 2 starts at
// offset PAGE_SIZE. The clone's /api/threads cost scales ~linearly with the row
// count (it computes a snippet + account_emails per thread), so this is also the
// per-page fetch cost; 50 fills the reading-pane list in one round-trip.
export const INBOX_SSR_PAGE = 50;

export async function listTeamMembers(): Promise<MissiveTeamMember[]> {
  const data = await missiveFetch<{ members: MissiveTeamMember[] }>("/api/auth/team");
  return data.members ?? [];
}

export interface MissiveLabel {
  id: string;
  name: string;
  color: string;
}

// Workspace labels. Used by the client detail page to look up the
// per-client label (one label per client, name = client.name) so the
// email history can be queried by label_id instead of post-filtering
// participants. Cheap call (~100 rows), but cached inside one request
// at the caller level if needed.
export async function listLabels(): Promise<MissiveLabel[]> {
  const data = await missiveFetch<{ labels: MissiveLabel[] }>("/api/labels");
  return data.labels ?? [];
}

export async function createLabel(name: string, color = "#0a4099"): Promise<string> {
  const data = await missiveFetch<{ id: string }>("/api/labels", {
    method: "POST",
    body: JSON.stringify({ name, color })
  });
  return data.id;
}

// Apply an existing label to a thread. Idempotent — missiveclone's
// thread_labels primary key (thread_id, label_id) plus the route's
// ON CONFLICT DO NOTHING make repeat calls safe.
export async function applyLabel(threadId: string, labelId: string): Promise<void> {
  await missiveFetch("/api/labels/apply", {
    method: "POST",
    body: JSON.stringify({ thread_id: threadId, label_id: labelId })
  });
}

export interface ListThreadsOpts {
  // Provider folder/label the thread list is scoped to. INBOX + SENT are
  // backed by message folder/direction; SPAM matches the provider's
  // junk/spam folder (see the missiveclone threads route). These are the
  // only Gmail-style mailbox views the UI exposes.
  folder?: "INBOX" | "SENT" | "SPAM";
  status?: "open" | "pending" | "closed";
  q?: string;
  // Capped at 200 server-side. Default page size on the backend is 50.
  limit?: number;
  // Number of rows to skip before the page starts — supports infinite
  // scroll. Backend orders by last_message_at DESC so offset:50 means
  // "the next 50 older threads."
  offset?: number;
  // Server-side scope to one connected account (by id). Required for
  // any per-inbox view — listThreads otherwise returns every thread
  // in the workspace.
  mailboxId?: string;
  // Server-side scope to a SET of connected accounts (by id). Used by the
  // combined "all inboxes" view so pagination stays exact: the backend
  // returns only threads in these inboxes, so offset/hasMore are accurate
  // (vs. fetching the whole workspace and filtering client-side, which
  // made the cursor drift and the list never finish loading). Ignored
  // when `mailboxId` is also set.
  mailboxIds?: string[];
  // Smart-filter bucket. Matches missiveclone's CATEGORY_CLAUSES:
  //   "codes"        — verification / OTP / sign-in codes
  //   "newsletters"  — no-reply / marketing senders
  //   "receipts"     — orders / payment confirmations
  //   "calendar"     — .ics invites / calendar updates
  //   "people"       — conversations *not* from automated senders
  //   "bounces"      — delivery failures
  category?: "codes" | "newsletters" | "receipts" | "calendar" | "people" | "bounces";
  // Scope to a team-space (group of mailboxes leaders curate on
  // /inboxes/manage). Backend joins on threads.team_space_id.
  teamSpaceId?: string;
  // Scope to threads carrying a specific label. Used by the client
  // detail page to pull the full email history attached to that
  // client (one label per client, backfilled by the labels backfill
  // job and auto-applied by the webhook on new mail).
  labelId?: string;
  // The clone hides currently-snoozed threads from every list unless asked;
  // snoozed: true asks for ONLY the snoozed ones (snoozed=true).
  snoozed?: boolean;
  // Cancels the request (a job's timeout, a page's deadline).
  signal?: AbortSignal;
}

export type InboxCategory = NonNullable<ListThreadsOpts["category"]>;

export interface ListThreadsResult {
  threads: MissiveThread[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// Missive stores list-y fields as TEXT (joined with "; " for thread
// participants, ", " for message to_addrs / cc_addrs). UI is much happier
// with string[]; we normalize at the lib boundary so callers don't care.

// Exported so readers of other clone payloads (the CL1 messages feed, whose
// address fields are raw TEXT) split them exactly the way getThread's are.
export function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") return raw.split(/[;,]\s*/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// Missive stores timestamps as Postgres bigint (epoch ms). The `pg` driver
// returns bigints as strings (safe for 64-bit ints), so we get values like
// "1778000000000" — which `new Date()` treats as invalid. Convert to ISO
// strings so the UI can format them consistently.
function toIsoString(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return new Date(raw).toISOString();
  if (typeof raw === "string") {
    // Bigint-as-string from pg
    if (/^\d+$/.test(raw)) return new Date(Number(raw)).toISOString();
    // Already an ISO date — pass through if Date can parse it
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

function normalizeThread<
  T extends { participants: unknown; last_message_at?: unknown; snoozed_until?: unknown; automated?: unknown; last_outbound_at?: unknown; last_inbound_at?: unknown }
>(
  t: T
): T & {
  participants: string[];
  last_message_at: string;
  snoozed_until: string | null;
  automated: boolean;
  last_outbound_at: string | null;
  last_inbound_at?: string | null;
} {
  // CL1's thread-wide inbound high-water mark (BIGINT epoch-ms) → ISO. Only
  // set when the clone sent the field, so `"last_inbound_at" in thread` still
  // tells a CL1 clone from an older one.
  const lastInbound =
    t.last_inbound_at === undefined ? undefined : t.last_inbound_at ? toIsoString(t.last_inbound_at) || null : null;
  return {
    ...t,
    ...(lastInbound === undefined ? {} : { last_inbound_at: lastInbound }),
    participants: toStringArray(t.participants),
    last_message_at: toIsoString(t.last_message_at),
    snoozed_until: t.snoozed_until ? toIsoString(t.snoozed_until) : null,
    // Clone returns is_automated as 0/1 (or omits it on an older build) →
    // coerce to a real boolean; undefined safely becomes false.
    automated: !!t.automated,
    // Newest outbound message's sent_at (bigint epoch-ms from pg). Null when the
    // clone doesn't send it (older build) or the thread has no outbound message.
    last_outbound_at: t.last_outbound_at ? toIsoString(t.last_outbound_at) : null
  };
}

function normalizeMessage<T extends { to_addrs: unknown; cc_addrs: unknown; sent_at?: unknown }>(
  m: T
): T & { to_addrs: string[]; cc_addrs: string[]; sent_at: string } {
  return {
    ...m,
    to_addrs: toStringArray(m.to_addrs),
    cc_addrs: toStringArray(m.cc_addrs),
    sent_at: toIsoString(m.sent_at)
  };
}

// Legacy signature kept for existing call sites that only want the
// threads array. New code should prefer listThreadsPaged() which
// surfaces the pagination cursor and the hasMore flag.
export async function listThreads(opts: ListThreadsOpts = {}): Promise<MissiveThread[]> {
  const { threads } = await listThreadsPaged(opts);
  return threads;
}

export async function listThreadsPaged(opts: ListThreadsOpts = {}): Promise<ListThreadsResult> {
  const params = new URLSearchParams();
  if (opts.folder) params.set("folder", opts.folder);
  if (opts.status) params.set("status", opts.status);
  if (opts.q) params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.mailboxId) params.set("mailbox_id", opts.mailboxId);
  else if (opts.mailboxIds && opts.mailboxIds.length > 0) {
    params.set("mailbox_ids", opts.mailboxIds.join(","));
  }
  if (opts.category) params.set("category", opts.category);
  if (opts.teamSpaceId) params.set("team_space_id", opts.teamSpaceId);
  if (opts.labelId) params.set("label_id", opts.labelId);
  if (opts.snoozed) params.set("snoozed", "true");
  const qs = params.toString() ? `?${params}` : "";
  const data = await missiveFetch<{
    threads: MissiveThread[];
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  }>(`/api/threads${qs}`, opts.signal ? { signal: opts.signal } : {});
  return {
    threads: (data.threads ?? []).map(normalizeThread),
    limit: data.limit ?? opts.limit ?? 50,
    offset: data.offset ?? opts.offset ?? 0,
    hasMore: data.hasMore ?? false
  };
}

// Fetch a thread + its messages. `deferBodies` opts into the clone's
// ?defer_bodies=1 mode: only the latest message keeps its body inline, the rest
// arrive as metadata + snippet with body_deferred=true (fetch on demand via
// fetchMessageBody). Default is OFF — every existing caller (reply/forward
// quoting, AI draft, classify, scoring) keeps full bodies. Only the reading-pane
// loader (loadThreadDetail) opts in. An old clone ignores the param → full
// bodies, so this stays safe before the clone is deployed.
export async function getThread(
  threadId: string,
  opts: { deferBodies?: boolean; signal?: AbortSignal } = {}
): Promise<MissiveThreadDetail> {
  const qs = opts.deferBodies ? "?defer_bodies=1" : "";
  const data = await missiveFetch<MissiveThreadDetail>(
    `/api/threads/${encodeURIComponent(threadId)}${qs}`,
    opts.signal ? { signal: opts.signal } : {}
  );
  return {
    ...data,
    thread: normalizeThread(data.thread),
    messages: (data.messages ?? []).map(normalizeMessage)
  };
}

// Fetch a single message's body (HTML + text) from the clone, for the
// lazy/deferred-body flow. Mirrors fetchAttachment's service-token auth but
// returns parsed JSON. Caller is responsible for per-user access control before
// invoking — this carries the workspace-wide service token.
export async function fetchMessageBody(
  messageId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<{ body_html: string | null; body_text: string | null }> {
  const data = await missiveFetch<{ body_html: string | null; body_text: string | null }>(
    `/api/messages/${encodeURIComponent(messageId)}/body`,
    opts.signal ? { signal: opts.signal } : {}
  );
  return { body_html: data.body_html ?? null, body_text: data.body_text ?? null };
}

// Stream an attachment's raw bytes from the clone. Returns the upstream
// Response untouched (binary body + Content-Type/Content-Disposition) so a
// proxy route can pipe it straight to the browser. Unlike missiveFetch this
// does NOT parse JSON. Caller is responsible for access control before
// invoking — this carries the service token, which is workspace-wide.
export async function fetchAttachment(attachmentId: string, opts: { signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${baseUrl()}/api/attachments/${encodeURIComponent(attachmentId)}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: "no-store",
    ...(opts.signal ? { signal: opts.signal } : {})
  });
}

// ---------------------------------------------------------------------------
// CL1 messages feed: GET /api/messages
// ---------------------------------------------------------------------------

/** Query for CL1's GET /api/messages (missiveclone backend/src/routes/messages.js). */
export interface MessagesFeedOpts {
  /** Required; the clone answers a JSON 404 when the account isn't in its workspace. */
  accountId: string;
  /** "created" (default): keyset on created_at, new rows only. "changed": keyset on COALESCE(signals_updated_at, created_at). */
  order?: "created" | "changed";
  /** ISO 8601 with Z or an offset; inclusive. Ignored when `cursor` is given (the clone lets a cursor win anyway). */
  since?: string | null;
  /** A previous page's next_cursor (opaque, tagged by order). */
  cursor?: string | null;
  direction?: "inbound" | "outbound";
  /** Clone default: true. */
  includeRemoved?: boolean;
  /** 1..200; the clone defaults to 100 and caps larger values. */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * One feed row exactly as the clone sends it. Metadata only: no bodies, no
 * snippet. Every time is a BIGINT epoch-ms digit string; the address fields
 * are raw TEXT ("Name <a@x>, b@y").
 */
export interface MissiveFeedMessage {
  id: string;
  thread_id: string;
  account_id: string;
  direction: string;
  folder: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  subject: string | null;
  sent_at: string | number | null;
  created_at: string | number | null;
  has_attachments: number | boolean | null;
  graph_id: string | null;
  web_link: string | null;
  is_read: boolean | null;
  importance: string | null;
  flag_status: string | null;
  categories: string[] | null;
  parent_folder_id: string | null;
  inference_classification: string | null;
  change_key: string | null;
  removed_at: string | number | null;
  removed_reason: string | null;
  signals_updated_at: string | number | null;
}

/**
 * `{ supported: false }` when the clone has no feed (pre-CL1). Otherwise CL1's
 * page: next_cursor is never null (page while has_more, then poll again from
 * it later) and settled_through is the settle horizon, epoch ms as a string.
 */
export type MessagesFeedResult =
  | { supported: false }
  | { supported: true; messages: MissiveFeedMessage[]; next_cursor: string; has_more: boolean; settled_through: string };

// How long a "no feed here" answer is believed before asking again: long
// enough not to probe on every reconcile run, short enough that a CL1 deploy
// is picked up without a restart.
const FEED_PROBE_TTL_MS = 10 * 60_000;
let feedUnsupportedUntil = 0;

/** Test seam: forget a cached "this clone has no feed" answer. */
export function __resetMessagesFeedProbeForTests(): void {
  feedUnsupportedUntil = 0;
}

/**
 * One page of CL1's per-account messages feed, as the clone sends it.
 *
 * A pre-CL1 clone has no GET /api/messages route: Express answers its default
 * HTML 404 ("Cannot GET"). That answer is cached for 10 minutes per process
 * and comes back as `{ supported: false }` without a request. Every other
 * failure throws: a JSON 404 (the account isn't the clone's) or any other
 * status as MissiveHttpError, a malformed page as an Error.
 */
export async function listMessagesFeed(opts: MessagesFeedOpts): Promise<MessagesFeedResult> {
  if (Date.now() < feedUnsupportedUntil) return { supported: false };
  const params = new URLSearchParams();
  params.set("account_id", opts.accountId);
  if (opts.order) params.set("order", opts.order);
  if (opts.cursor) params.set("cursor", opts.cursor);
  else if (opts.since) params.set("since", opts.since);
  if (opts.direction) params.set("direction", opts.direction);
  if (opts.includeRemoved !== undefined) params.set("include_removed", opts.includeRemoved ? "true" : "false");
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));

  let data: unknown;
  try {
    data = await missiveFetch<unknown>(`/api/messages?${params}`, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    if (err instanceof MissiveHttpError && err.status === 404 && !err.jsonBody) {
      feedUnsupportedUntil = Date.now() + FEED_PROBE_TTL_MS;
      return { supported: false };
    }
    throw err;
  }
  feedUnsupportedUntil = 0;

  const page = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const settled = page.settled_through;
  const settledThrough =
    typeof settled === "string" && /^\d{1,16}$/.test(settled)
      ? settled
      : typeof settled === "number" && Number.isSafeInteger(settled) && settled >= 0
        ? String(settled)
        : null;
  const bad =
    !Array.isArray(page.messages) || page.messages.some((m) => typeof m !== "object" || m === null)
      ? "messages"
      : typeof page.next_cursor !== "string" || page.next_cursor.length === 0
        ? "next_cursor"
        : typeof page.has_more !== "boolean"
          ? "has_more"
          : settledThrough === null
            ? "settled_through"
            : null;
  if (bad) throw new Error(`missive /api/messages: malformed feed page (${bad})`);
  return {
    supported: true,
    messages: page.messages as MissiveFeedMessage[],
    next_cursor: page.next_cursor as string,
    has_more: page.has_more as boolean,
    settled_through: settledThrough as string
  };
}

// Create a new inbox connection on the Missive clone. Body shape mirrors
// the clone's `POST /api/accounts` endpoint as best we know it. The clone
// is the source of truth for which fields are required — anything missing
// will surface as a clone-side error here, which we propagate to the UI.
// Clone validator requires snake_case `imap_pass` / `smtp_pass`
// (NOT `_password`). Wire payload below matches what the clone parses;
// our DD route maps camelCase user input into this shape.
export interface CreateAccountArgs {
  email: string;
  display_name?: string;
  provider?: string;     // informational only — clone doesn't validate.
  imap_host?: string;
  imap_port?: number;
  imap_secure?: boolean; // 993 = true (implicit TLS).
  imap_user?: string;
  imap_pass?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean; // 465 = true (implicit TLS); 587 = false (STARTTLS).
  smtp_user?: string;
  smtp_pass?: string;
}

export async function createAccount(args: CreateAccountArgs): Promise<MissiveAccount> {
  // Drop the `provider` field — the clone ignores it. Keeping the
  // wire payload to exactly the validator fields makes "missing
  // fields" debugging easier next time.
  const { provider: _provider, ...wire } = args;
  void _provider;
  // Clone returns just `{ id }` on success, not the full account row.
  // Fetch the full row right after so callers get a real MissiveAccount.
  const created = await missiveFetch<{ id: string }>(
    "/api/accounts",
    {
      method: "POST",
      body: JSON.stringify(wire)
    }
  );
  const list = await missiveFetch<{ accounts: MissiveAccount[] }>("/api/accounts");
  const row = list.accounts.find((a) => a.id === created.id);
  if (!row) {
    // Fall back to a synthetic account so the caller still has
    // something usable (auto-assignment etc.).
    return {
      id: created.id,
      email: args.email,
      display_name: args.display_name ?? args.email,
      workspace_id: "",
      user_id: null,
      last_synced_at: null,
      provider: args.provider ?? null
    };
  }
  return {
    ...row,
    last_synced_at: row.last_synced_at
      ? toIsoString(row.last_synced_at)
      : null
  };
}

// Send a reply on an existing thread. The clone's reply endpoint expects
// a JSON payload with the message body + recipient list; we read those
// off the most recent message in the thread when the caller doesn't pass
// them explicitly. Returns the created message so the caller can append
// it optimistically.
export interface ReplyArgs {
  threadId: string;
  bodyText: string;
  bodyHtml?: string;
  // The Missive account the reply is sent FROM. The clone routes the
  // SMTP send through this account's provider config.
  fromAccountId: string;
  to: string[];
  cc?: string[];
  subject?: string;        // Defaults to "Re: <original subject>" on the clone side.
  inReplyTo?: string;      // Message-id to thread on.
  // Optional file attachments to forward as `files[]` multipart fields.
  // Capped at MAX_ATTACHMENTS_PER_EMAIL, enforced in sendReply below.
  attachments?: MissiveAttachment[];
}

export interface MissiveAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

// Disconnect a mailbox from the missiveclone backend. Removes the mailbox
// and its stored OAuth tokens; its sync state and scheduled sends go with
// it. Its messages and threads stay in the clone, detached from any
// mailbox (messages.account_id becomes NULL). The caller still has to
// clean up DD's own inbox_assignments row.
export async function deleteAccount(accountId: string): Promise<void> {
  await missiveFetch<{ ok: true }>(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE"
  });
}

// Workspace-wide rescan: clears every Microsoft account's Graph delta
// cursor and fires off a full re-walk of inbox + sent in the background.
// Returns immediately with the count of accounts scheduled — the actual
// sync runs out-of-band. Caller can poll listAccounts() for
// last_synced_at to know when each finishes.
export async function rescanAllAccounts(): Promise<{ ok: true; accounts: number }> {
  return missiveFetch<{ ok: true; accounts: number }>(
    "/api/accounts/rescan-all",
    { method: "POST" }
  );
}

export async function sendReply(args: ReplyArgs): Promise<{ messageId: string }> {
  // The clone's reply endpoint is multipart/form-data: a `payload` JSON
  // string + optional `files[]`. Plain JSON makes req.body.payload
  // undefined on the server, which silently parses to {} and surfaces as
  // "account_id invalid" downstream. We send multipart even without
  // attachments so the contract matches.
  //
  // The clone returns `{ ok, message_id }` (not a full message object) —
  // callers refresh the thread afterward, so the id is all we need.
  // The real gate on attachment count. Every send path — the inbox composers,
  // the approvals queue, the scheduled runner, bulk email, the brain — funnels
  // through sendReply/composeNewThread, and this is the last point that still
  // knows the RESOLVED count: callers hand us URLs, and fetchMediaAsAttachments
  // drops the ones it can't read, so an item list is not the number of parts
  // that go on the wire. Refusing here throws inside whatever try the caller
  // already has, so /api/email-drafts/[id]/approve records status='failed' with
  // a readable send_error instead of stranding the row half-approved.
  if ((args.attachments?.length ?? 0) > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new Error(tooManyAttachmentsMessage(args.attachments!.length));
  }

  const payload = {
    account_id: args.fromAccountId,
    body_text: args.bodyText,
    body_html: args.bodyHtml ?? null,
    to: args.to.join(", "),
    cc: (args.cc ?? []).join(", "),
    subject: args.subject ?? null,
    // RFC Message-ID of the message being replied to. The clone threads the
    // reply under it (Graph createReply / SMTP In-Reply-To); null ⇒ the clone
    // falls back to the thread's latest message.
    in_reply_to: args.inReplyTo ?? null
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const att of args.attachments ?? []) {
    // Convert Buffer → Uint8Array so TS picks the ArrayBuffer-backed
    // BlobPart overload (Buffer has a SharedArrayBuffer-compatible
    // backing type that the lib types reject).
    form.append(
      "files",
      new Blob([new Uint8Array(att.content)], { type: att.contentType }),
      att.filename
    );
  }
  const data = await missiveFetch<{ message_id: string }>(
    `/api/threads/${encodeURIComponent(args.threadId)}/reply`,
    { method: "POST", body: form }
  );
  return { messageId: data.message_id };
}

// Compose a brand-new outbound thread. Hits the clone's "new message"
// endpoint, which creates a thread + sends via the from-account's SMTP.
export interface ComposeArgs {
  fromAccountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  // Optional scheduled send (epoch milliseconds). When set and >30s in
  // the future, the clone stores the message in scheduled_messages with
  // status='pending' instead of sending immediately.
  sendAtMs?: number;
  // Optional file attachments. Forwarded as multipart files[] for both
  // immediate and scheduled sends — the clone stashes them in
  // scheduled_attachments and replays them when the message comes due.
  attachments?: MissiveAttachment[];
  // Marks this send as an automated/templated blast (the bulk-email tool).
  // The clone stores it on the message; touchpoint-sync then excludes it so
  // a mass send doesn't reset every client's "last contacted" status.
  automated?: boolean;
  // Marks this send as a weekly SEO update. The clone stores it and echoes
  // it back in the message:new webhook with the recipients, so DD clears the
  // client from the "Who needs an email" card. Distinct from `automated`:
  // a weekly update is a real touchpoint, just one that also reports EOD work.
  weeklyUpdate?: boolean;
}

export async function composeNewThread(args: ComposeArgs): Promise<{
  threadId: string;
  messageId: string;
}> {
  // Mounted at /api/compose (NOT /api/messages). Multipart with a single
  // `payload` JSON string; the clone expects `to`/`cc`/`bcc` as scalar
  // strings (joined), not arrays.
  // The real gate on attachment count. Every send path — the inbox composers,
  // the approvals queue, the scheduled runner, bulk email, the brain — funnels
  // through sendReply/composeNewThread, and this is the last point that still
  // knows the RESOLVED count: callers hand us URLs, and fetchMediaAsAttachments
  // drops the ones it can't read, so an item list is not the number of parts
  // that go on the wire. Refusing here throws inside whatever try the caller
  // already has, so /api/email-drafts/[id]/approve records status='failed' with
  // a readable send_error instead of stranding the row half-approved.
  if ((args.attachments?.length ?? 0) > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new Error(tooManyAttachmentsMessage(args.attachments!.length));
  }

  const payload: Record<string, unknown> = {
    account_id: args.fromAccountId,
    to: args.to.join(", "),
    cc: (args.cc ?? []).join(", "),
    bcc: (args.bcc ?? []).join(", "),
    subject: args.subject,
    body_text: args.bodyText,
    body_html: args.bodyHtml ?? null
  };
  if (args.sendAtMs) payload.send_at = args.sendAtMs;
  if (args.automated) payload.automated = true;
  if (args.weeklyUpdate) payload.weekly_update = true;
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  // Attachments are forwarded for both immediate and scheduled sends; the
  // clone stores them against the scheduled message and sends them when due.
  for (const att of args.attachments ?? []) {
    form.append(
      "files",
      new Blob([new Uint8Array(att.content)], { type: att.contentType }),
      att.filename
    );
  }
  // Scheduled sends return { ok: true, scheduled_id } instead of a
  // thread/message id — handle both shapes.
  const data = await missiveFetch<{
    thread_id?: string;
    message_id?: string;
    scheduled_id?: string;
  }>("/api/compose", { method: "POST", body: form });
  return {
    threadId: data.thread_id ?? "",
    messageId: data.message_id ?? data.scheduled_id ?? ""
  };
}

// Filter threads by account. The clone's API doesn't expose a per-account
// filter on the threads list, so we do it client-side. Fine for our scale;
// revisit if a single workspace has tens of thousands of threads.
export function filterThreadsByAccount(
  threads: MissiveThread[],
  _accountId: string
): MissiveThread[] {
  // Threads in the clone aren't directly tagged with account_id (messages
  // are). When we fetch a single thread we get the messages and can scope
  // there. For listing-by-inbox we'll need to either query the messages
  // table directly or extend the clone API. Returning all for now;
  // /api/inboxes/[id] page will scope by re-fetching message detail.
  return threads;
}
