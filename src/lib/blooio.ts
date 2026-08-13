import "server-only";

// Blooio API client — powers /outbound-dashboard/messaging.
//
// Auth: `Authorization: Bearer <token>` (BLOOIO_API_TOKEN).
// Base URL: https://backend.blooio.com/v2/api
//
// Real endpoints (probed live against the API — there's no global
// /messages endpoint, so we walk chats and aggregate per-chat counts):
//   - GET /me                         — token verify + org metadata
//   - GET /chats                      — list every chat (each row has
//                                        inbound_count/outbound_count
//                                        already pre-aggregated)
//   - GET /chats/{chatId}/messages    — per-chat message history (used
//                                        for the recent feed + per-day
//                                        bar chart only; totals come
//                                        from the chats endpoint directly)
//
// Timestamps in Blooio responses are epoch milliseconds — we normalize
// to ISO strings at the boundary so the rest of the app stays in ISO.

const API_BASE = "https://backend.blooio.com/v2/api";

export interface BlooioMessage {
  id: string;                  // message_id
  text: string;
  direction: "outbound" | "inbound";
  status: string;              // "delivered" / "failed" / etc.
  chatId: string;              // owning chat (phone number form)
  externalId: string | null;   // the contact's number (the other party)
  internalId: string | null;   // OUR line number — counted for "Active Lines"
  protocol: string | null;     // "imessage" / "sms"
  createdAt: string;           // ISO (from epoch ms `time_sent`)
}

export interface BlooioChat {
  id: string;                  // phone number form, e.g. "+12039459496"
  contactName: string | null;
  contactNumber: string;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  lastMessageTime: string | null;     // ISO — newest message in EITHER direction
  lastInboundTime: string | null;     // ISO — newest INBOUND message (for the support poller watermark)
  lastMessagePreview: string | null;  // text of the most recent message
  lastDirection: "outbound" | "inbound" | null;
}

export interface BlooioSummary {
  windowDays: number;
  rangeStart: string;
  rangeEnd: string;

  // Headline metrics — labels match the operator's own Blooio dashboard
  // ("Total Sent" / "Total Received" / "Active Lines" / "Outbound
  // Convos") so the page reads as a 1:1 mirror.
  totalSent: number;        // sum of outbound_count across all chats
  totalReceived: number;    // sum of inbound_count across all chats
  totalMessages: number;    // sent + received
  activeLines: number;      // distinct internal_id (our sending numbers)
  outboundConvos: number;   // chats with outbound_count > 0
  replyRate: number | null; // received / sent, percent
  avgPerDay: number;        // total / windowDays
  avgPerLinePerDay: number; // outbound / activeLines / windowDays

  // Per-day buckets for the daily chart. Pre-zeroed so empty days don't
  // skip on the X axis.
  byDay: Array<{ date: string; outbound: number; inbound: number }>;

  // Recent message feed + top chats — pulled from message-level fetches.
  recent: BlooioMessage[];
  topChats: BlooioChat[];

  // Org metadata for the header chip.
  orgName: string | null;
  ownerLabel: string | null;
  fetchedAt: string;
}

export type BlooioResult =
  | { ok: true; data: BlooioSummary }
  | { ok: false; error: string };

function getToken(): string | null {
  const t = process.env.BLOOIO_API_TOKEN;
  return t && t.trim().length > 0 ? t.trim() : null;
}

// Generalized fetch — GET by default (cached 60s for dashboard read flows),
// or POST/PATCH/DELETE when `method` is provided (no caching, body sent).
//
// The cache opt-out for non-GET calls is critical: SMS sends must never
// be served from Next's data cache, and Blooio's POST response (the
// freshly created message_id) would be stale within a second anyway.
async function bFetch<T>(
  path: string,
  opts?: {
    query?: Record<string, string>;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  }
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const token = getToken();
  if (!token) return { ok: false, error: "Missing BLOOIO_API_TOKEN" };
  const url = new URL(`${API_BASE}${path}`);
  if (opts?.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  const method = opts?.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts?.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // Only cache GETs. POSTs (sends) and mutations must hit the API
      // every time.
      ...(method === "GET" ? { next: { revalidate: 60 } } : { cache: "no-store" })
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
  // Read the body as text first so we can fall back to the raw response
  // when it isn't JSON or when JSON only contains a generic error class
  // name (Blooio returns {"error":"ApiError"} for half its failures).
  const rawBody = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(rawBody); }
  catch { /* non-JSON — handled below via rawBody */ }

  if (!res.ok) {
    // Extract the most-informative string we can find from the response.
    // Order of preference: detail/message → string error → stringified
    // object error → raw body text. Always include HTTP status so the
    // operator can distinguish 4xx (request bad) from 5xx (Blooio down)
    // even when the body itself is opaque ("ApiError" et al.).
    const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const candidates: Array<unknown> = [
      obj.detail, obj.description, obj.message,
      typeof obj.error === "string" ? obj.error : null,
      typeof obj.error === "object" && obj.error ? JSON.stringify(obj.error) : null
    ];
    const inner = candidates.find((c) => typeof c === "string" && (c as string).length > 0) as string | undefined;
    const reason = inner ?? (rawBody.length > 0 ? rawBody.slice(0, 400) : `HTTP ${res.status}`);
    // Aggressive server-side log when Blooio rejects. Captures method +
    // path + status + raw response body so Railway logs show the full
    // picture even when the DB-persisted `error` is "ApiError (HTTP
    // 400)" with nothing else useful.
    // eslint-disable-next-line no-console
    console.error("[blooio] request failed", {
      method,
      path,
      status: res.status,
      requestBody: opts?.body !== undefined ? JSON.stringify(opts.body).slice(0, 400) : undefined,
      responseBody: rawBody.slice(0, 1000)
    });
    return { ok: false, error: `${reason} (HTTP ${res.status})` };
  }
  // For success responses, json should be parsed. If not (unexpected
  // empty body on a 200), fall back to an empty object so callers don't
  // crash on undefined.
  return { ok: true, data: (json ?? {}) as T };
}

// Epoch milliseconds → ISO. Returns "" for missing/zero values so the
// callsites can use `.localeCompare` without crashing.
function msToIso(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

interface RawMeResponse {
  valid: boolean;
  auth_type: string;
  organization?: { name?: string; organization_id?: string };
  metadata?: { name?: string };
}

interface RawChat {
  id: string;
  type: string;
  is_group: boolean;
  contact?: { contact_id: string; name: string | null; identifier: string };
  message_count: number;
  inbound_count: number;
  outbound_count: number;
  last_message_time: number | null;
  last_inbound_time: number | null;
  last_outbound_time: number | null;
  last_message?: { message_id: string; text: string; direction: "inbound" | "outbound"; time_sent: number };
}

interface RawChatsResponse {
  chats: RawChat[];
  pagination?: { limit: number; next_page_token?: string | null };
}

interface RawMessage {
  message_id: string;
  direction: "outbound" | "inbound";
  external_id: string;
  internal_id: string;
  text: string;
  sender: string;
  time_sent: number;
  time_delivered: number | null;
  status: string;
  protocol: string;
  error: string | null;
}

interface RawChatMessagesResponse {
  chat_id: string;
  messages: RawMessage[];
  pagination?: { limit: number; next_page_token?: string | null };
}

function normalizeChat(c: RawChat): BlooioChat {
  return {
    id: c.id,
    contactName: c.contact?.name ?? null,
    contactNumber: c.contact?.identifier ?? c.id,
    messageCount: c.message_count ?? 0,
    inboundCount: c.inbound_count ?? 0,
    outboundCount: c.outbound_count ?? 0,
    lastMessageTime: msToIso(c.last_message_time) || null,
    lastInboundTime: msToIso(c.last_inbound_time) || null,
    lastMessagePreview: c.last_message?.text ?? null,
    lastDirection: c.last_message?.direction ?? null
  };
}

function normalizeMessage(m: RawMessage, chatId: string): BlooioMessage {
  return {
    id: m.message_id,
    text: m.text ?? "",
    direction: m.direction,
    status: m.status ?? "unknown",
    chatId,
    externalId: m.external_id ?? null,
    internalId: m.internal_id ?? null,
    protocol: m.protocol ?? null,
    createdAt: msToIso(m.time_sent)
  };
}

async function listAllChats(): Promise<{ ok: true; data: RawChat[] } | { ok: false; error: string }> {
  const all: RawChat[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { limit: "100" };
    if (pageToken) query.page_token = pageToken;
    const r = await bFetch<RawChatsResponse>("/chats", { query });
    if (!r.ok) return r;
    for (const c of r.data.chats ?? []) all.push(c);
    pageToken = r.data.pagination?.next_page_token ?? null;
    if (!pageToken) break;
  }
  return { ok: true, data: all };
}

async function listChatMessages(
  chatId: string,
  maxPages = 10
): Promise<{ ok: true; data: RawMessage[] } | { ok: false; error: string }> {
  const all: RawMessage[] = [];
  let pageToken: string | null = null;
  // Encode the +1... chat id for the URL — Blooio accepts both raw and
  // percent-encoded, but URL-encoding is the safer choice for arbitrary
  // identifiers.
  const encoded = encodeURIComponent(chatId);
  let page = 0;
  for (; page < maxPages; page++) {
    const query: Record<string, string> = { limit: "100" };
    if (pageToken) query.page_token = pageToken;
    const r = await bFetch<RawChatMessagesResponse>(`/chats/${encoded}/messages`, { query });
    if (!r.ok) return r;
    for (const m of r.data.messages ?? []) all.push(m);
    pageToken = r.data.pagination?.next_page_token ?? null;
    if (!pageToken) break;
  }
  // Make truncation observable: a still-set token at the cap means we did NOT
  // fetch the whole history. The dashboard sample tolerates this; the support
  // poller must know if a chat's newest messages could be beyond the cap.
  if (pageToken) {
    console.warn("[blooio] listChatMessages hit page cap with more pages pending", {
      chatId, fetched: all.length, maxPages
    });
  }
  return { ok: true, data: all };
}

// Public entry. Defaults to a 30-day window.
export async function getBlooioSummary({ days = 30 }: { days?: number } = {}): Promise<BlooioResult> {
  const now = new Date();
  const rangeStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // /me to verify the token early — its errors are cleaner than the
  // ones we get from /chats when auth is bad.
  const meRes = await bFetch<RawMeResponse>("/me");
  if (!meRes.ok) return meRes;

  const chatsRes = await listAllChats();
  if (!chatsRes.ok) return chatsRes;
  const rawChats = chatsRes.data;

  // Pre-aggregated headline counts straight from /chats. Saves us from
  // having to fetch every message just to count.
  const totalSent = rawChats.reduce((s, c) => s + (c.outbound_count ?? 0), 0);
  const totalReceived = rawChats.reduce((s, c) => s + (c.inbound_count ?? 0), 0);
  const totalMessages = totalSent + totalReceived;
  const outboundConvos = rawChats.filter((c) => (c.outbound_count ?? 0) > 0).length;
  const replyRate = totalSent > 0 ? (totalReceived / totalSent) * 100 : null;

  // Fetch per-chat messages for the top N chats by total activity so we
  // can populate the per-day chart, recent feed, and Active Lines count.
  // Capped at 25 to keep the request fan-out bounded; the headline KPIs
  // above don't depend on this.
  const TOP_FOR_MESSAGES = 25;
  const sortedForFetch = rawChats
    .slice()
    .sort((a, b) => (b.message_count ?? 0) - (a.message_count ?? 0))
    .slice(0, TOP_FOR_MESSAGES);
  const messagesPerChat = await Promise.all(
    sortedForFetch.map((c) => listChatMessages(c.id))
  );
  const allMessages: BlooioMessage[] = [];
  for (let i = 0; i < sortedForFetch.length; i++) {
    const r = messagesPerChat[i];
    if (!r.ok) continue; // silently skip — headline counts still rendered
    for (const m of r.data) allMessages.push(normalizeMessage(m, sortedForFetch[i].id));
  }

  // Active lines — distinct internal_id values across the messages we
  // pulled. This is a sample-based estimate when the account has more
  // chats than TOP_FOR_MESSAGES, but for normal operator volumes it's
  // a true count.
  const lineSet = new Set<string>();
  for (const m of allMessages) if (m.internalId) lineSet.add(m.internalId);
  const activeLines = lineSet.size;

  const avgPerDay = days > 0 ? totalMessages / days : 0;
  const avgPerLinePerDay =
    days > 0 && activeLines > 0 ? totalSent / activeLines / days : 0;

  // Per-day buckets — only count messages whose time_sent falls inside
  // the window. The pre-aggregated /chats totals are lifetime-of-chat,
  // not windowed, but the chart deliberately uses windowed data.
  const dayMap = new Map<string, { date: string; outbound: number; inbound: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(rangeStart.getTime() + i * 24 * 60 * 60 * 1000);
    const k = d.toISOString().slice(0, 10);
    dayMap.set(k, { date: k, outbound: 0, inbound: 0 });
  }
  for (const m of allMessages) {
    const k = (m.createdAt ?? "").slice(0, 10);
    const bucket = dayMap.get(k);
    if (bucket) bucket[m.direction]++;
  }
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Recent message feed — newest first, capped at 20.
  const recent = allMessages
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  // Top chats by total messages — used for the side panel. Re-derived
  // from normalized chats so the UI never sees the raw shape.
  const topChats = rawChats
    .slice()
    .sort((a, b) => (b.message_count ?? 0) - (a.message_count ?? 0))
    .slice(0, 10)
    .map(normalizeChat);

  const me = meRes.data;
  const orgName = me.organization?.name ?? null;
  const ownerLabel = me.metadata?.name ?? null;

  return {
    ok: true,
    data: {
      windowDays: days,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: now.toISOString(),
      totalSent,
      totalReceived,
      totalMessages,
      activeLines,
      outboundConvos,
      replyRate,
      avgPerDay,
      avgPerLinePerDay,
      byDay,
      recent,
      topChats,
      orgName,
      ownerLabel,
      fetchedAt: new Date().toISOString()
    }
  };
}

// ---- SEND ----
//
// POST /v2/api/chats/{chatId}/messages with { "text": "..." } — the
// chatId is the contact's phone in E.164 form (e.g. "+15125550100").
// Blooio normalizes the path so percent-encoded and raw + both work;
// we URL-encode for safety.
//
// Returns the new message_id on success. Used by the outbound funnel
// cron runner — see lib/outbound-sequence-runner.ts.

interface SendMessageResponse {
  message_id?: string;
  status?: string;
  chat_id?: string;
  // Some Blooio responses nest the new message under `message`. Tolerant
  // shape lets us forward whatever id we find without guessing.
  message?: { message_id?: string; status?: string };
}

export async function sendBlooioMessage(
  chatId: string,
  text: string
): Promise<{ ok: true; messageId: string | null; status: string | null } | { ok: false; error: string }> {
  if (!chatId) return { ok: false, error: "sendBlooioMessage: chatId is empty" };
  if (!text) return { ok: false, error: "sendBlooioMessage: text is empty" };
  const encoded = encodeURIComponent(chatId);
  const r = await bFetch<SendMessageResponse>(
    `/chats/${encoded}/messages`,
    { method: "POST", body: { text } }
  );
  if (!r.ok) return r;
  const messageId = r.data.message_id ?? r.data.message?.message_id ?? null;
  const status = r.data.status ?? r.data.message?.status ?? null;
  return { ok: true, messageId, status };
}

// Resolve the operator's sending line — used by the outbound runner to
// derive chat ids and stamp the line on event records. Defaults to the
// known-good number we probed earlier so the runner works even if the
// env var isn't set in local dev.
export function getBlooioSendingLine(): string {
  return (process.env.BLOOIO_LINE_NUMBER ?? "+15126672513").trim();
}

// Master switch for inbound SMS capture — OFF unless explicitly enabled.
//
// DD shares a Blooio ORGANIZATION (and its single number) with the New Life
// CRM, which runs out of a separate codebase + Supabase project and owns its
// own `blooio-inbound` edge function. Blooio scopes webhooks to the org, not to
// the API key that sent the outbound, and GET /chats likewise returns every
// chat on the account — so both of our inbound paths (the realtime webhook and
// the polling backstop) see the CRM's conversations as well as ours. There is
// no Blooio-side setting that separates them and, with one number in the org,
// nothing to filter on either.
//
// So inbound is disabled wholesale rather than filtered. Default-off is
// deliberate: it holds with no env configured and survives a service being
// recreated, which a Railway variable would not.
//
// To re-enable: give DD its own Blooio line, then gate ingest on
// BlooioMessage.internalId (already parsed, currently discarded by both ingest
// paths) instead of switching this back on unconditionally.
//
// OUTBOUND is unaffected — sendBlooioMessage, the sequence runner, the outbound
// dashboard and operator replies from the CS tab all keep working.
export function isBlooioInboundEnabled(): boolean {
  return process.env.BLOOIO_INBOUND_ENABLED === "true";
}

// ---- READ HELPERS (for the customer-support inbox + poller) ----
//
// getBlooioSummary() above keeps its read paths private because it caps the
// per-chat fan-out at 25 for the dashboard. The customer-support inbox needs
// the full, normalized lists instead, so we expose thin wrappers over the
// same private fetchers. Both stay server-only via the file-level import.

// Every chat on the account, newest activity first, normalized to BlooioChat.
export async function listBlooioChats(): Promise<BlooioChat[]> {
  const r = await listAllChats();
  if (!r.ok) {
    console.error("[blooio] listBlooioChats failed", { error: r.error });
    return [];
  }
  return r.data
    .map(normalizeChat)
    .sort((a, b) => (b.lastMessageTime ?? "").localeCompare(a.lastMessageTime ?? ""));
}

// Full message history for one chat, oldest first (chat-render order),
// normalized to BlooioMessage. Returns [] on a read error so callers render
// an empty thread rather than crash.
export async function getBlooioChatMessages(chatId: string): Promise<BlooioMessage[]> {
  if (!chatId) return [];
  // The support inbox wants the full thread (and the poller must reach a chat's
  // newest inbound), so allow many more pages than the dashboard's sample path.
  const r = await listChatMessages(chatId, 100);
  if (!r.ok) {
    console.error("[blooio] getBlooioChatMessages failed", { chatId, error: r.error });
    return [];
  }
  return r.data
    .map((m) => normalizeMessage(m, chatId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// A single message by id — GET /chats/{chatId}/messages/{messageId}. The inbound
// webhook uses this to fetch the AUTHORITATIVE message a delivery refers to
// (from the payload's top-level chat_id + message_id) instead of trusting the
// webhook body's `data` blob. Returns null on error or if the message isn't
// available yet (propagation lag) — the poller backstops anything dropped.
export async function getBlooioMessage(
  chatId: string,
  messageId: string
): Promise<BlooioMessage | null> {
  if (!chatId || !messageId) return null;
  const encChat = encodeURIComponent(chatId);
  const encMsg = encodeURIComponent(messageId);
  const r = await bFetch<Record<string, unknown>>(`/chats/${encChat}/messages/${encMsg}`);
  if (!r.ok) {
    console.error("[blooio] getBlooioMessage failed", { chatId, messageId, error: r.error });
    return null;
  }
  // Tolerate the message being returned bare or wrapped in {message}/{data}.
  const d = r.data as { message?: RawMessage; data?: RawMessage } & Partial<RawMessage>;
  const raw = (d.message ?? d.data ?? d) as RawMessage;
  if (!raw || !raw.message_id) return null;
  return normalizeMessage(raw, chatId);
}

// ---- formatters ----
export function fmtBlooNumber(n: number | null): string {
  if (n == null) return "—";
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return n.toLocaleString();
  return String(Math.round(n));
}
export function fmtBlooPct(n: number | null, digits: number = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}
export function fmtBlooDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
