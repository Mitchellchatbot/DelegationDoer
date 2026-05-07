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
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
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
  limit?: number;
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

export async function listThreads(opts: ListThreadsOpts = {}): Promise<MissiveThread[]> {
  const params = new URLSearchParams();
  if (opts.folder) params.set("folder", opts.folder);
  if (opts.status) params.set("status", opts.status);
  if (opts.q) params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  const data = await missiveFetch<{ threads: MissiveThread[] }>(`/api/threads${qs}`);
  return (data.threads ?? []).map(normalizeThread);
}

export async function getThread(threadId: string): Promise<MissiveThreadDetail> {
  const data = await missiveFetch<MissiveThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
  return {
    ...data,
    thread: normalizeThread(data.thread),
    messages: (data.messages ?? []).map(normalizeMessage)
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
