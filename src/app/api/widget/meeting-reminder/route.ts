import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listUserEvents, GoogleAuthError, type CalendarEvent } from "@/lib/google-calendar";
import {
  buildClientMatchIndex,
  matchEventToClient,
  type ClientMatchIndex,
  type ClientMatchRow
} from "@/lib/calendar-client-match";

export const dynamic = "force-dynamic";

// GET /api/widget/meeting-reminder
//   The Electron widget polls this every ~15s (alongside its other widget
//   reads). Returns client meetings on the signed-in user's Google Calendar
//   that START WITHIN THE NEXT 30 MIN and haven't been notified yet, so the
//   widget can fire a single native "client meeting in ~30 min" notification
//   that deep-links to /schedule (where the prep panel auto-generates the
//   brief).
//
//   Dedup is server-side and atomic: each surfaced meeting is recorded in
//   meeting_reminders (PK user_id+event_id) via an ignore-duplicates upsert,
//   and only the rows THIS call inserted are returned — so the 15s re-poll,
//   a racing poll, or a widget restart mid-window can't double-fire.
//
//   Client-matched only, by the same matcher as /api/calendar/meetings.

const WINDOW_MIN = 30;

// listUserEvents hits the Google Calendar API; cache per-user so the 15s
// widget poll doesn't hammer Google. Module-level state lives for the
// Node process (Railway long-running), like getSupabaseAdmin / the crons.
const EVENTS_TTL_MS = 120_000;
const eventsCache = new Map<string, { at: number; events: CalendarEvent[] }>();

// The client index is small and shared across users; refresh every 5 min.
const CLIENTS_TTL_MS = 300_000;
let clientIndexCache: { at: number; index: ClientMatchIndex } | null = null;

async function getUpcomingEvents(userId: string): Promise<CalendarEvent[]> {
  const cached = eventsCache.get(userId);
  if (cached && Date.now() - cached.at < EVENTS_TTL_MS) return cached.events;
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + (WINDOW_MIN + 5) * 60_000).toISOString();
  const events = await listUserEvents({ userId, timeMin, timeMax, maxResults: 20 });
  eventsCache.set(userId, { at: Date.now(), events });
  return events;
}

async function getClientIndex(): Promise<ClientMatchIndex> {
  if (clientIndexCache && Date.now() - clientIndexCache.at < CLIENTS_TTL_MS) {
    return clientIndexCache.index;
  }
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("id, name, contact_emails, website, websites");
  const index = buildClientMatchIndex((data ?? []) as ClientMatchRow[]);
  clientIndexCache = { at: Date.now(), index };
  return index;
}

export async function GET() {
  try {
    const userId = await requireCurrentUserId();

    let events: CalendarEvent[];
    try {
      events = await getUpcomingEvents(userId);
    } catch (err) {
      // Not connected / token revoked → stay silent. The Schedule page owns
      // the reconnect prompt; the widget must never nag about calendar auth.
      if (err instanceof GoogleAuthError) return NextResponse.json({ meetings: [] });
      throw err;
    }

    const index = await getClientIndex();
    const now = Date.now();
    const maxMs = WINDOW_MIN * 60_000;

    // Client-matched, real (timed, non-task) meetings starting within the
    // next 30 min. ISO math only — start times are absolute, so no work
    // timezone is needed.
    const due = events
      .filter((e) => !!e.start.dateTime && !e.summary.startsWith("📝"))
      .map((e) => ({ e, startMs: new Date(e.start.dateTime as string).getTime(), client: matchEventToClient(e, index) }))
      .filter(({ startMs, client }) => {
        if (!client) return false;
        const delta = startMs - now;
        return delta > 0 && delta <= maxMs;
      });

    if (due.length === 0) return NextResponse.json({ meetings: [] });

    // Atomically claim each due meeting. With ignoreDuplicates, .select()
    // returns ONLY the rows this call inserted (meetings not previously
    // notified) — so re-polls and restarts never re-fire. A missing table
    // (migration not applied) degrades to "no reminders" rather than
    // spamming undeduped.
    const supabase = getSupabaseAdmin();
    const { data: claimed, error } = await supabase
      .from("meeting_reminders")
      .upsert(
        due.map((d) => ({ user_id: userId, event_id: d.e.id, client_id: d.client?.id ?? null })),
        { onConflict: "user_id,event_id", ignoreDuplicates: true }
      )
      .select("event_id");
    if (error) return NextResponse.json({ meetings: [] });

    const claimedIds = new Set(((claimed ?? []) as { event_id: string }[]).map((r) => r.event_id));
    const fresh = due.filter((d) => claimedIds.has(d.e.id));

    return NextResponse.json({
      meetings: fresh.map((d) => ({
        id: d.e.id,
        clientId: d.client?.id ?? null,
        clientName: d.client?.name ?? null,
        summary: d.e.summary,
        startISO: d.e.start.dateTime as string
      }))
    });
  } catch (err) {
    // Never surface a hard error to the widget poller — just no meetings.
    return NextResponse.json(
      { meetings: [], error: err instanceof Error ? err.message : "unknown error" },
      { status: 200 }
    );
  }
}
