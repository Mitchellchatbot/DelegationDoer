import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { listUserEvents, GoogleAuthError } from "@/lib/google-calendar";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  buildClientMatchIndex,
  matchEventToClient,
  type ClientMatchRow
} from "@/lib/calendar-client-match";

export const dynamic = "force-dynamic";

// GET /api/calendar/meetings?days=7
//   The signed-in user's upcoming Google Calendar meetings, matched
//   against DelegationDoer client records and filtered to client-facing
//   ones. Powers the /home "Upcoming meetings" card.
//
//   Matching (most precise first): an attendee email exactly in a client's
//   contact_emails → that client; else an attendee email's domain matches
//   a client's website/contact domain (generic providers like gmail are
//   skipped); else the client's name appears in the event title. The
//   matcher lives in lib/calendar-client-match.ts so the widget
//   meeting-reminder shares the exact same logic.
//
//   "Client-facing only": we drop internal/no-match meetings. But if the
//   user has meetings yet none matched a client, we fall back to showing
//   all of them — an empty card when the calendar isn't empty reads as
//   broken. `clientFacingOnly` tells the client which mode it got.
//
//   Auth/connection errors mirror /api/calendar/events so the card can
//   reuse the same not-connected / reconnect handling.

interface Meeting {
  id: string;
  summary: string;
  startISO: string;
  htmlLink: string;
  hangoutLink: string | null;
  clientId: string | null;
  clientName: string | null;
  guest: string | null;       // first attendee + "+N", for unmatched rows
}

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : "unknown error";
  if (err instanceof GoogleAuthError) {
    return NextResponse.json(
      {
        error: msg,
        connected: false,
        needsReconnect: err.reason === "refresh_failed",
        reconnectNote:
          "Your Google Calendar connection expired — reconnect in Settings."
      },
      { status: 400 }
    );
  }
  return NextResponse.json({ error: msg }, { status: 500 });
}

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

    // Lightweight client pull — only the fields we match on (no select *,
    // no touchpoint round-trip that getClients() does).
    const { data: clientRows } = await getSupabaseAdmin()
      .from("clients")
      .select("id, name, contact_emails, website, websites");
    const index = buildClientMatchIndex((clientRows ?? []) as ClientMatchRow[]);

    // Real meetings only: timed events, minus the 📝 task blocks
    // task-calendar-sync mirrors in.
    const timed = events.filter((e) => !!e.start.dateTime && !e.summary.startsWith("📝"));
    const enriched: Meeting[] = timed.map((e) => {
      const client = matchEventToClient(e, index);
      const at = e.attendees ?? [];
      const guest = at.length
        ? (at[0].displayName || at[0].email) + (at.length > 1 ? ` +${at.length - 1}` : "")
        : null;
      return {
        id: e.id,
        summary: e.summary,
        startISO: e.start.dateTime as string,
        htmlLink: e.htmlLink,
        hangoutLink: e.hangoutLink,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        guest
      };
    });

    const clientFacing = enriched.filter((m) => m.clientId);
    const list = clientFacing.length > 0 ? clientFacing : enriched;
    return NextResponse.json({
      meetings: list.slice(0, 6),
      clientFacingOnly: clientFacing.length > 0
    });
  } catch (err) {
    return errorResponse(err);
  }
}
