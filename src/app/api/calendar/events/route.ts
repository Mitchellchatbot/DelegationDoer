import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { listUserEvents, createUserEvent } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

// GET /api/calendar/events?days=7
//   Returns the auth'd user's upcoming events from now → +days.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const days = Math.max(
      1,
      Math.min(30, Number(req.nextUrl.searchParams.get("days") || 7))
    );
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
    const events = await listUserEvents({ userId, timeMin, timeMax, maxResults: 50 });
    return NextResponse.json({ events });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg.includes("not connected")) {
      return NextResponse.json({ error: msg, connected: false }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/calendar/events
//   { summary, description?, startISO, endISO, attendees?, addAttendees?, timeZone? }
//   Creates an event on the user's primary calendar.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    const startISO = typeof body.startISO === "string" ? body.startISO : "";
    const endISO   = typeof body.endISO   === "string" ? body.endISO   : "";
    if (!summary || !startISO || !endISO) {
      return NextResponse.json(
        { error: "summary, startISO, endISO are all required" },
        { status: 400 }
      );
    }
    const attendees: string[] = Array.isArray(body.attendees)
      ? body.attendees.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const event = await createUserEvent({
      userId,
      summary,
      description: typeof body.description === "string" ? body.description : undefined,
      startISO,
      endISO,
      attendees,
      addAttendees: !!body.addAttendees,
      timeZone: typeof body.timeZone === "string" ? body.timeZone : undefined
    });
    return NextResponse.json({ ok: true, event });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg.includes("not connected")) {
      return NextResponse.json({ error: msg, connected: false }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
