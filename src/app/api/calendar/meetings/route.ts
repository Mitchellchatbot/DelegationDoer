import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import {
  listUserEvents,
  GoogleAuthError,
  type CalendarEvent
} from "@/lib/google-calendar";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/calendar/meetings?days=7
//   The signed-in user's upcoming Google Calendar meetings, matched
//   against DelegationDoer client records and filtered to client-facing
//   ones. Powers the /home "Upcoming meetings" card.
//
//   Matching (most precise first): an attendee email exactly in a client's
//   contact_emails → that client; else an attendee email's domain matches
//   a client's website/contact domain (generic providers like gmail are
//   skipped); else the client's name appears in the event title.
//
//   "Client-facing only": we drop internal/no-match meetings. But if the
//   user has meetings yet none matched a client, we fall back to showing
//   all of them — an empty card when the calendar isn't empty reads as
//   broken. `clientFacingOnly` tells the client which mode it got.
//
//   Auth/connection errors mirror /api/calendar/events so the card can
//   reuse the same not-connected / reconnect handling.

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "aol.com", "msn.com",
  "proton.me", "protonmail.com"
]);

interface ClientLite { id: string; name: string }

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

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : null;
}

// URL or bare host → registrable host, lowercased, www stripped.
function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = raw.includes("://") ? raw : `https://${raw}`;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
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
    const clients = (clientRows ?? []) as Array<{
      id: string; name: string | null;
      contact_emails: string[] | null;
      website: string | null; websites: string[] | null;
    }>;

    // Build match indices once.
    const emailToClient = new Map<string, ClientLite>();
    const domainToClient = new Map<string, ClientLite>();
    const named: Array<{ name: string; client: ClientLite }> = [];
    for (const c of clients) {
      if (!c.name) continue;
      const lite: ClientLite = { id: c.id, name: c.name };
      for (const raw of c.contact_emails ?? []) {
        const e = raw.trim().toLowerCase();
        if (!e) continue;
        if (!emailToClient.has(e)) emailToClient.set(e, lite);
        const d = emailDomain(e);
        if (d && !GENERIC_EMAIL_DOMAINS.has(d) && !domainToClient.has(d)) {
          domainToClient.set(d, lite);
        }
      }
      for (const w of [c.website, ...(c.websites ?? [])]) {
        const d = hostOf(w);
        if (d && !GENERIC_EMAIL_DOMAINS.has(d) && !domainToClient.has(d)) {
          domainToClient.set(d, lite);
        }
      }
      // Names shorter than 4 chars are too collision-prone for substring
      // matching against free-text event titles.
      if (c.name.trim().length >= 4) named.push({ name: c.name.toLowerCase(), client: lite });
    }

    function matchClient(ev: CalendarEvent): ClientLite | null {
      const emails = (ev.attendees ?? []).map((a) => a.email.toLowerCase());
      for (const e of emails) {
        const hit = emailToClient.get(e);
        if (hit) return hit;
      }
      for (const e of emails) {
        const d = emailDomain(e);
        if (d) {
          const hit = domainToClient.get(d);
          if (hit) return hit;
        }
      }
      const summary = (ev.summary ?? "").toLowerCase();
      for (const n of named) {
        if (summary.includes(n.name)) return n.client;
      }
      return null;
    }

    // Real meetings only: timed events, minus the 📝 task blocks
    // task-calendar-sync mirrors in.
    const timed = events.filter((e) => !!e.start.dateTime && !e.summary.startsWith("📝"));
    const enriched: Meeting[] = timed.map((e) => {
      const client = matchClient(e);
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
