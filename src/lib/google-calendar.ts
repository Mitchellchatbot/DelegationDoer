import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Thin Google Calendar wrapper. Per-user OAuth tokens live on the
// `users` row. We mint fresh access tokens from the stored refresh
// token whenever the cached access token is within 60s of expiring.
//
// Scopes we ask for:
//   calendar.events    — list + create + update + delete events
//   calendar.readonly  — list calendars (we only act on "primary"
//                        for now but reading the list lets future
//                        UI scope work-vs-personal)
//   openid email profile — so the callback can identify the Google
//                        account and store google_email for display

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

interface UserGoogleRow {
  google_access_token: string | null;
  google_refresh_token: string | null;
  google_token_expiry: string | null; // ISO
}

// Look up the user's Google credentials. Returns null if they
// haven't connected (no refresh token).
async function getUserCreds(userId: string): Promise<UserGoogleRow | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("users")
    .select("google_access_token, google_refresh_token, google_token_expiry")
    .eq("id", userId)
    .maybeSingle();
  if (!data?.google_refresh_token) return null;
  return data as UserGoogleRow;
}

// Mint a fresh access token via the refresh_token grant. Persists
// the new value + expiry back to the user row so subsequent calls
// in the same request don't re-mint.
async function refreshAccessToken(
  userId: string,
  refreshToken: string
): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      `google refresh failed: ${data.error_description || data.error || res.status}`
    );
  }
  const expiresIn = Number(data.expires_in ?? 3600);
  const expiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  await getSupabaseAdmin()
    .from("users")
    .update({
      google_access_token: data.access_token,
      google_token_expiry: expiry
    })
    .eq("id", userId);
  return data.access_token as string;
}

// Return a valid access token for the given user, refreshing if
// expired (or within 60s of expiring). Throws if the user hasn't
// connected.
export async function getValidAccessToken(userId: string): Promise<string> {
  const row = await getUserCreds(userId);
  if (!row?.google_refresh_token) {
    throw new Error("google not connected");
  }
  const expMs = row.google_token_expiry
    ? new Date(row.google_token_expiry).getTime()
    : 0;
  const stillFresh = row.google_access_token && expMs - Date.now() > 60_000;
  if (stillFresh) return row.google_access_token!;
  return refreshAccessToken(userId, row.google_refresh_token);
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  htmlLink: string;
  start: { dateTime: string | null; date: string | null; timeZone: string | null };
  end:   { dateTime: string | null; date: string | null; timeZone: string | null };
  attendees: { email: string; displayName?: string; responseStatus?: string }[];
  hangoutLink: string | null;
}

// List events on the user's primary calendar within [timeMin, timeMax].
// Both are ISO strings; defaults: now → 7 days from now.
export async function listUserEvents(args: {
  userId: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken(args.userId);
  const timeMin = args.timeMin ?? new Date().toISOString();
  const timeMax =
    args.timeMax ??
    new Date(Date.now() + 7 * 86_400_000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(args.maxResults ?? 25)
  });
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `google calendar list failed: ${data.error?.message || res.status}`
    );
  }
  return ((data.items ?? []) as RawEvent[]).map(normalizeEvent);
}

// Patch an existing event. Used when a task's due date / title /
// description shifts and we want the calendar block to follow. Pass
// only the fields you want to change.
export async function patchUserEvent(args: {
  userId: string;
  eventId: string;
  summary?: string;
  description?: string;
  startISO?: string;
  endISO?: string;
  timeZone?: string;
}): Promise<void> {
  const token = await getValidAccessToken(args.userId);
  const body: Record<string, unknown> = {};
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.description !== undefined) body.description = args.description;
  if (args.startISO) {
    body.start = { dateTime: args.startISO, timeZone: args.timeZone ?? "UTC" };
  }
  if (args.endISO) {
    body.end = { dateTime: args.endISO, timeZone: args.timeZone ?? "UTC" };
  }
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(args.eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `google calendar patch failed: ${data.error?.message || res.status}`
    );
  }
}

// Delete an event from the user's primary calendar. 404 is treated
// as success — the event was already gone, that's fine.
export async function deleteUserEvent(args: {
  userId: string;
  eventId: string;
}): Promise<void> {
  const token = await getValidAccessToken(args.userId);
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(args.eventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `google calendar delete failed: ${data.error?.message || res.status}`
    );
  }
}

// Create an event on the user's primary calendar. Minimal shape —
// summary + start + end is enough. Pass `addAttendees: true` to
// invite the listed emails (Google will email them an invitation).
export async function createUserEvent(args: {
  userId: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  attendees?: string[];
  addAttendees?: boolean;
  timeZone?: string;
}): Promise<CalendarEvent> {
  const token = await getValidAccessToken(args.userId);
  const body: Record<string, unknown> = {
    summary: args.summary,
    description: args.description ?? "",
    start: {
      dateTime: args.startISO,
      timeZone: args.timeZone ?? "UTC"
    },
    end: {
      dateTime: args.endISO,
      timeZone: args.timeZone ?? "UTC"
    }
  };
  if (args.attendees?.length) {
    body.attendees = args.attendees.map((email) => ({ email }));
  }
  const url = new URL(`${CALENDAR_BASE}/calendars/primary/events`);
  if (args.addAttendees) url.searchParams.set("sendUpdates", "all");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `google calendar create failed: ${data.error?.message || res.status}`
    );
  }
  return normalizeEvent(data as RawEvent);
}

interface RawEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?:   { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  hangoutLink?: string;
}

function normalizeEvent(e: RawEvent): CalendarEvent {
  return {
    id: e.id,
    summary: e.summary ?? "(no title)",
    description: e.description ?? null,
    location: e.location ?? null,
    htmlLink: e.htmlLink,
    start: {
      dateTime: e.start?.dateTime ?? null,
      date: e.start?.date ?? null,
      timeZone: e.start?.timeZone ?? null
    },
    end: {
      dateTime: e.end?.dateTime ?? null,
      date: e.end?.date ?? null,
      timeZone: e.end?.timeZone ?? null
    },
    attendees: e.attendees ?? [],
    hangoutLink: e.hangoutLink ?? null
  };
}
