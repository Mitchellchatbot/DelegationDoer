// Server-side typed wrapper around the missive-clone API.
// All calls go through `missiveFetch` which adds the bearer token and
// surfaces non-2xx responses with a useful error string.
//
// Required env vars:
//   MISSIVE_API_URL    — e.g. https://missiveclone-production.up.railway.app
//   MISSIVE_API_TOKEN  — long-lived JWT issued by the clone for our service
//                        account. Pull from missive UI's localStorage for now.

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
}

export interface MissiveThreadDetail {
  thread: MissiveThread;
  messages: MissiveMessage[];
}

function baseUrl(): string {
  const url = process.env.MISSIVE_API_URL;
  if (!url) throw new Error("MISSIVE_API_URL not set");
  return url.replace(/\/$/, "");
}

function token(): string {
  const t = process.env.MISSIVE_API_TOKEN;
  if (!t) throw new Error("MISSIVE_API_TOKEN not set");
  return t;
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
    throw new Error(`missive ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listAccounts(): Promise<MissiveAccount[]> {
  // The clone returns { accounts: [...] }. If you've extended it, adjust here.
  const data = await missiveFetch<{ accounts: MissiveAccount[] }>("/api/accounts");
  return (data.accounts ?? []).map((a) => ({
    ...a,
    last_synced_at: a.last_synced_at ? toIsoString(a.last_synced_at) : null
  }));
}

export async function listTeamMembers(): Promise<MissiveTeamMember[]> {
  const data = await missiveFetch<{ members: MissiveTeamMember[] }>("/api/auth/team");
  return data.members ?? [];
}

export interface ListThreadsOpts {
  folder?: "INBOX" | "SENT";
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
}

export interface ListThreadsResult {
  threads: MissiveThread[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// Missive stores list-y fields as TEXT (joined with "; " for thread
// participants, ", " for message to_addrs / cc_addrs). UI is much happier
// with string[]; we normalize at the lib boundary so callers don't care.

function toStringArray(raw: unknown): string[] {
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

function normalizeThread<T extends { participants: unknown; last_message_at?: unknown; snoozed_until?: unknown }>(
  t: T
): T & { participants: string[]; last_message_at: string; snoozed_until: string | null } {
  return {
    ...t,
    participants: toStringArray(t.participants),
    last_message_at: toIsoString(t.last_message_at),
    snoozed_until: t.snoozed_until ? toIsoString(t.snoozed_until) : null
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
  const qs = params.toString() ? `?${params}` : "";
  const data = await missiveFetch<{
    threads: MissiveThread[];
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  }>(`/api/threads${qs}`);
  return {
    threads: (data.threads ?? []).map(normalizeThread),
    limit: data.limit ?? opts.limit ?? 50,
    offset: data.offset ?? opts.offset ?? 0,
    hasMore: data.hasMore ?? false
  };
}

export async function getThread(threadId: string): Promise<MissiveThreadDetail> {
  const data = await missiveFetch<MissiveThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
  return {
    ...data,
    thread: normalizeThread(data.thread),
    messages: (data.messages ?? []).map(normalizeMessage)
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
  const payload = {
    account_id: args.fromAccountId,
    body_text: args.bodyText,
    body_html: args.bodyHtml ?? null,
    to: args.to.join(", "),
    cc: (args.cc ?? []).join(", "),
    subject: args.subject ?? null
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
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
}

export async function composeNewThread(args: ComposeArgs): Promise<{
  threadId: string;
  messageId: string;
}> {
  // Mounted at /api/compose (NOT /api/messages). Multipart with a single
  // `payload` JSON string; the clone expects `to`/`cc`/`bcc` as scalar
  // strings (joined), not arrays.
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
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
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
