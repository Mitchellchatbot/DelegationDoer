import "server-only";

// Calendly v2 API client — powers /outbound-dashboard/calendly.
//
// Auth: Personal Access Token (PAT) from Calendly UI →
//   Account → Integrations & Apps → API & Webhooks → Personal Access Token.
// The PAT is bearer-style: `Authorization: Bearer <token>`.
//
// Env: CALENDLY_API_TOKEN (server-only). Without it the page renders
// the same kind of soft empty/error panel as the FB integration.
//
// We pull:
//   1. /users/me              — to discover the user_uri (needed for
//                               listing the user's events)
//   2. /scheduled_events      — both active + canceled buckets in the
//                               given date window, paginated
//
// Aggregates: total booked, active, canceled, cancellation rate,
// upcoming vs past, avg per day, top event type. The page also renders
// a recent-bookings table.

const API_BASE = "https://api.calendly.com";

export interface CalendlyEvent {
  uri: string;
  uuid: string;
  name: string;            // event type name, e.g. "Discovery Call"
  status: "active" | "canceled";
  startTime: string;       // ISO
  endTime: string;         // ISO
  eventTypeUri: string | null;
  inviteesCount: number;
  location: string | null;
  createdAt: string;       // ISO — when the booking was made
}

export interface CalendlySummary {
  // Window applied to the underlying API queries.
  windowDays: number;
  rangeStart: string;     // ISO
  rangeEnd: string;       // ISO

  // Counts within the window.
  totalBooked: number;    // active + canceled
  active: number;
  canceled: number;
  cancellationRate: number | null; // canceled / totalBooked, percent
  upcoming: number;       // active AND startTime in future
  past: number;           // active AND startTime in past (i.e. happened)
  avgPerDay: number;

  // Event-type leaderboard — most popular type by booking count.
  topEventType: { name: string; count: number } | null;
  byEventType: Array<{ name: string; count: number }>;

  // Recent bookings for the table — already sorted by createdAt desc.
  recent: CalendlyEvent[];

  fetchedAt: string;      // ISO of the underlying fetch
  ownerName: string;      // /users/me name (just for the header chip)
  ownerEmail: string;
}

export type CalendlyResult =
  | { ok: true; data: CalendlySummary }
  | { ok: false; error: string };

function getToken(): string | null {
  const t = process.env.CALENDLY_API_TOKEN;
  return t && t.trim().length > 0 ? t.trim() : null;
}

// Single Calendly fetch — adds the bearer header, parses JSON, and
// unwraps Calendly's typed error shape. Caches per-URL for 60s on the
// fetch layer so a fast re-render doesn't burn quota.
async function cFetch<T>(path: string, query?: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const token = getToken();
  if (!token) return { ok: false, error: "Missing CALENDLY_API_TOKEN" };

  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      next: { revalidate: 60 }
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `Non-JSON response (HTTP ${res.status})` };
  }

  if (!res.ok) {
    const e = json as { title?: string; message?: string; details?: unknown };
    const msg = e?.message ?? e?.title ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data: json as T };
}

interface MeResponse {
  resource: {
    uri: string;
    name: string;
    email: string;
    current_organization: string;
  };
}

interface EventsResponse {
  collection: Array<{
    uri: string;
    name: string;
    status: "active" | "canceled";
    start_time: string;
    end_time: string;
    event_type: string;
    invitees_counter: { total: number; active: number; limit: number };
    location?: { type?: string; location?: string; join_url?: string };
    created_at: string;
  }>;
  pagination: { count: number; next_page?: string | null; next_page_token?: string | null };
}

function uuidFromUri(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

function normalize(evt: EventsResponse["collection"][number]): CalendlyEvent {
  return {
    uri: evt.uri,
    uuid: uuidFromUri(evt.uri),
    name: evt.name,
    status: evt.status,
    startTime: evt.start_time,
    endTime: evt.end_time,
    eventTypeUri: evt.event_type ?? null,
    inviteesCount: evt.invitees_counter?.total ?? 0,
    location: evt.location?.location ?? evt.location?.join_url ?? evt.location?.type ?? null,
    createdAt: evt.created_at
  };
}

// Fetch every event in a date window for a given user, handling
// pagination. Status filter is applied client-side because the v2 API
// only accepts a single status per request — calling it twice (once
// for active, once for canceled) is cleaner than fanning out per page.
async function listAllEvents(
  userUri: string,
  minStart: string,
  maxStart: string,
  status: "active" | "canceled"
): Promise<{ ok: true; data: CalendlyEvent[] } | { ok: false; error: string }> {
  const all: CalendlyEvent[] = [];
  let pageToken: string | null = null;
  // Hard cap to avoid runaway loops on a misbehaving API. 10 pages × 100
  // = 1000 events is way more than any sane 30-day window.
  for (let page = 0; page < 10; page++) {
    const query: Record<string, string> = {
      user: userUri,
      min_start_time: minStart,
      max_start_time: maxStart,
      status,
      count: "100",
      sort: "start_time:desc"
    };
    if (pageToken) query.page_token = pageToken;
    const r = await cFetch<EventsResponse>("/scheduled_events", query);
    if (!r.ok) return r;
    for (const e of r.data.collection ?? []) all.push(normalize(e));
    pageToken = r.data.pagination?.next_page_token ?? null;
    if (!pageToken) break;
  }
  return { ok: true, data: all };
}

// Public entry — one-shot summary for the dashboard. Defaults to the
// last 30 days. Bump `days` if the team wants a wider lookback.
export async function getCalendlySummary({ days = 30 }: { days?: number } = {}): Promise<CalendlyResult> {
  // Discover the token-holder's user URI first; everything else hangs
  // off it. We could let callers pass it in to skip this round-trip, but
  // the page renders the owner name in the sync chip so we need /me
  // anyway.
  const meRes = await cFetch<MeResponse>("/users/me");
  if (!meRes.ok) return meRes;
  const me = meRes.data.resource;

  const now = new Date();
  const rangeEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // +90d so "upcoming" counts include future bookings
  const rangeStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const [active, canceled] = await Promise.all([
    listAllEvents(me.uri, rangeStart.toISOString(), rangeEnd.toISOString(), "active"),
    listAllEvents(me.uri, rangeStart.toISOString(), rangeEnd.toISOString(), "canceled")
  ]);
  if (!active.ok) return active;
  if (!canceled.ok) return canceled;

  const events = [...active.data, ...canceled.data];
  const total = events.length;
  const activeCount = active.data.length;
  const cancelCount = canceled.data.length;
  const cancellationRate = total > 0 ? (cancelCount / total) * 100 : null;

  // Upcoming vs past — only meaningful for active events. Canceled ones
  // don't really sit on either side of the line.
  const nowMs = now.getTime();
  let upcoming = 0;
  let past = 0;
  for (const e of active.data) {
    if (new Date(e.startTime).getTime() >= nowMs) upcoming++;
    else past++;
  }

  // Avg per day across the window — uses totalBooked / days so it
  // includes canceled bookings (they still represent intent). Switch
  // to active.data.length / days if you'd rather it reflect kept bookings.
  const avgPerDay = days > 0 ? total / days : 0;

  // Event-type leaderboard — group by event name (the human-readable
  // label) rather than URI since the UI shows the name.
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const byEventType = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const topEventType = byEventType[0] ?? null;

  const recent = events
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  return {
    ok: true,
    data: {
      windowDays: days,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      totalBooked: total,
      active: activeCount,
      canceled: cancelCount,
      cancellationRate,
      upcoming,
      past,
      avgPerDay,
      topEventType,
      byEventType,
      recent,
      fetchedAt: new Date().toISOString(),
      ownerName: me.name,
      ownerEmail: me.email
    }
  };
}

// ---- formatters (re-exported for the page/component) ----

export function fmtCalNumber(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString();
  return String(Math.round(n));
}
export function fmtCalPct(n: number | null, digits: number = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}
export function fmtCalDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}
