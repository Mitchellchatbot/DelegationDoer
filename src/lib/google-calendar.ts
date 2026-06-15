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

// Raised when we can't get a usable access token for the user, either
// because they never connected ("not_connected") or because the stored
// refresh token is dead — revoked / expired / app in Testing mode
// ("refresh_failed", which Google reports as invalid_grant). Callers
// use this to tell the user to reconnect instead of dumping a raw
// Google error string. Mirrors SlackResolveError's reason discriminator.
export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public reason: "not_connected" | "refresh_failed",
    public googleError?: string
  ) {
    super(message);
  }
}

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
    // Log the full Google response so the real cause (usually
    // invalid_grant) is visible in Railway logs — the user-facing
    // message only gets the short version.
    console.error("[google-calendar] token refresh failed", {
      userId,
      status: res.status,
      error: data.error,
      error_description: data.error_description
    });
    const detail =
      [data.error, data.error_description].filter(Boolean).join(" — ") ||
      String(res.status);
    throw new GoogleAuthError(
      `google refresh failed: ${detail}`,
      "refresh_failed",
      data.error
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
    throw new GoogleAuthError("google not connected", "not_connected");
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

// Create an all-day recurring event. Used for birthday mirroring:
// once a year on MM-DD, forever. `monthDay` is "MM-DD"; we pick a
// historical "anchor year" (1970) so the event has a fixed start
// date Google will accept, then the YEARLY RRULE handles the rest.
export async function createAllDayYearlyEvent(args: {
  userId: string;
  summary: string;
  description?: string;
  monthDay: string;       // "MM-DD"
}): Promise<{ id: string }> {
  const token = await getValidAccessToken(args.userId);
  const [m, d] = args.monthDay.split("-");
  const startDate = `1970-${m}-${d}`;
  // For all-day events Google expects the end.date to be the day
  // AFTER the start (exclusive). One-day duration → next day.
  const endDate = nextDayString(1970, Number(m), Number(d));
  const body = {
    summary: args.summary,
    description: args.description ?? "",
    start: { date: startDate },
    end: { date: endDate },
    recurrence: ["RRULE:FREQ=YEARLY"],
    transparency: "transparent"  // doesn't block availability
  };
  const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events`, {
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
      `google calendar yearly-event create failed: ${data.error?.message || res.status}`
    );
  }
  return { id: data.id as string };
}

// Update an existing all-day yearly event's date (used when a user
// changes their birthday).
export async function patchAllDayYearlyEvent(args: {
  userId: string;
  eventId: string;
  monthDay: string;
  summary?: string;
}): Promise<void> {
  const token = await getValidAccessToken(args.userId);
  const [m, d] = args.monthDay.split("-");
  const startDate = `1970-${m}-${d}`;
  const endDate = nextDayString(1970, Number(m), Number(d));
  const body: Record<string, unknown> = {
    start: { date: startDate },
    end: { date: endDate },
    recurrence: ["RRULE:FREQ=YEARLY"]
  };
  if (args.summary) body.summary = args.summary;
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
      `google calendar yearly-event patch failed: ${data.error?.message || res.status}`
    );
  }
}

// "YYYY-MM-DD" → the next calendar day, handling month/year rollover.
function nextDayString(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
