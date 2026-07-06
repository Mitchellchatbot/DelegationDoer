import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canViewEmailApprovals } from "@/lib/email-approvers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { UpdateCadence } from "@/lib/eod-digest";

export const dynamic = "force-dynamic";

// GET /api/eod/digest-recommendations?window=daily|weekly|biweekly|monthly
//
// "Show me who should get a client update in this time window." Returns
// every client with UNREPORTED EOD client-work entries in the window —
// what the team logged they did for that client (worked_on + results) in
// their daily end-of-day form — ordered by how much is sitting there.
// This is the same source the composer drafts from, so a client appears
// here the moment someone logs EOD work for it (and drops off once an
// email reporting that work sends).
//
// IMPORTANT: this surface intentionally does NOT consult the per-client
// update_cadence column. The window is whatever the approver clicked.
//
// Auth: approvers + read-only email-approvals viewers (SEO team leads).
// Read-only endpoint — the compose/discard writes it feeds stay approver-only.

const WINDOWS = ["daily", "weekly", "biweekly", "monthly"] as const;
export type DigestWindow = typeof WINDOWS[number];

const WINDOW_DAYS: Record<DigestWindow, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30
};

// Overlap detection — Signal A ("recently emailed"). Flags a client that
// already received a CLIENT-UPDATE email (kind client_update / eod_digest)
// within the browsing window — i.e. "you've already sent this client an
// update this period; sending again would double up." Window-based, not
// cadence-based, and scoped to client updates so auto-replies / custom /
// content-plan sends don't trip it. The kinds that count as a client update:
const CLIENT_UPDATE_KINDS: string[] = ["client_update", "eod_digest"];

function coerceCadence(raw: string | null | undefined): UpdateCadence {
  if (raw === "biweekly" || raw === "weekly" || raw === "monthly" || raw === "none") return raw;
  return "daily"; // back-compat default for rows predating the cadence column
}

interface ClientRow {
  id: string;
  name: string;
  status: string | null;
  contact_emails: string[] | null;
  update_cadence: string | null;
}

interface WorkRow {
  id: string;
  user_id: string;
  client_name: string;
  note_date: string;
  worked_on: string;
  results: string | null;
}

interface SentEmailRow {
  client_name: string | null;
  sent_at: string | null;
}

export interface DigestEntryDetail {
  id: string;
  workedOn: string;
  results: string | null;
  noteDate: string;
  authorName: string | null;
}

// Signal B ("shared recipient across clients") — one contact address that
// also receives updates for OTHER active clients. When those clients have a
// different cadence, that person gets both the weekly and the monthly email.
export interface SharedRecipient {
  email: string;
  others: Array<{ name: string; cadence: UpdateCadence }>;
}

export interface DigestRecommendation {
  clientId: string;
  clientName: string;
  contactEmails: string[];        // forwarded so the in-place composer modal can pre-fill To
  entryCount: number;
  lastSentAt: string | null;
  entries: DigestEntryDetail[];   // up to 6 most recent
  contributorNames: string[];     // distinct contributors
  hasContact: boolean;
  cadence: UpdateCadence;         // this client's own cadence (for overlap UI)
  // Overlap detection. Both default to no-overlap (null / empty array).
  recentlyEmailed: { daysSince: number; window: DigestWindow } | null;   // Signal A
  sharedRecipients: SharedRecipient[];                                    // Signal B
}

function isDigestWindow(s: string): s is DigestWindow {
  return (WINDOWS as readonly string[]).includes(s);
}

function windowStart(w: DigestWindow): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  if (w === "daily") return d;
  const past = new Date(d.getTime() - WINDOW_DAYS[w] * 86_400_000);
  past.setUTCHours(0, 0, 0, 0);
  return past;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    // Read-only surface: approvers AND read-only SEO viewers may see it.
    // Write actions (compose / discard) stay approver-gated in their routes.
    if (!canViewEmailApprovals({ name: me.name, email: me.email, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const url = new URL(req.url);
    const raw = (url.searchParams.get("window") ?? "daily").toLowerCase();
    const window: DigestWindow = isDigestWindow(raw) ? raw : "daily";
    const start = windowStart(window);
    const startDateStr = start.toISOString().slice(0, 10);

    const supabase = getSupabaseAdmin();

    // 1) Active clients. (Clients with no contact_emails still appear so
    //    the approver can see the work waiting; the row is flagged
    //    no-contact and the composer button is disabled.)
    const { data: clientRows, error: clientErr } = await supabase
      .from("clients")
      .select("id, name, status, contact_emails, update_cadence");
    if (clientErr) {
      return NextResponse.json({ error: clientErr.message }, { status: 500 });
    }
    const clients = ((clientRows ?? []) as ClientRow[])
      .filter((c) => !c.status || c.status === "active");
    if (clients.length === 0) {
      return NextResponse.json({ window, windowDays: WINDOW_DAYS[window], recommendations: [] });
    }

    const clientNames = clients.map((c) => c.name);

    // 2) In parallel (one round-trip): unreported EOD work in the window;
    //    last-sent timestamp per client (ALL kinds — feeds the "last update
    //    X ago" label, unchanged); and CLIENT-UPDATE sends within the window
    //    (Signal A — "recently emailed").
    const [workRes, sentRes, recentUpdatesRes] = await Promise.all([
      supabase
        .from("eod_client_work")
        .select("id, user_id, client_name, note_date, worked_on, results")
        .in("client_name", clientNames)
        .is("reported_to_client_at", null)
        .is("dismissed_at", null)
        .gte("note_date", startDateStr)
        .order("note_date", { ascending: false })
        .limit(2000),
      supabase
        .from("email_drafts")
        .select("client_name, sent_at")
        .in("client_name", clientNames)
        .eq("status", "sent")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(500),
      supabase
        .from("email_drafts")
        .select("client_name, sent_at")
        .in("client_name", clientNames)
        .eq("status", "sent")
        .in("kind", CLIENT_UPDATE_KINDS)
        .gte("sent_at", start.toISOString())
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1000)
    ]);
    const work = (workRes.data ?? []) as WorkRow[];
    const sent = (sentRes.data ?? []) as SentEmailRow[];
    const recentUpdates = (recentUpdatesRes.data ?? []) as SentEmailRow[];

    const workByClient = new Map<string, WorkRow[]>();
    for (const w of work) {
      const list = workByClient.get(w.client_name) ?? [];
      list.push(w);
      workByClient.set(w.client_name, list);
    }
    const lastSentByClient = new Map<string, string>();
    for (const r of sent) {
      if (!r.client_name || !r.sent_at) continue;
      if (!lastSentByClient.has(r.client_name)) lastSentByClient.set(r.client_name, r.sent_at);
    }
    // Most recent CLIENT-UPDATE send within the window, per client (Signal A).
    // Rows are ordered sent_at desc, so the first seen per client is newest.
    const lastUpdateInWindowByClient = new Map<string, string>();
    for (const r of recentUpdates) {
      if (!r.client_name || !r.sent_at) continue;
      if (!lastUpdateInWindowByClient.has(r.client_name)) {
        lastUpdateInWindowByClient.set(r.client_name, r.sent_at);
      }
    }

    // 3) Resolve contributor names.
    const userIds = Array.from(new Set(work.map((w) => w.user_id)));
    const userById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, name").in("id", userIds);
      for (const u of ((users ?? []) as { id: string; name: string }[])) userById.set(u.id, u.name);
    }

    // Index every ACTIVE client's contact emails (Signal B). An address that
    // maps to more than one client means that inbox receives an update for
    // each of them — and if their cadences differ, both a weekly and a
    // monthly send. Includes non-recommended clients so the overlap still
    // surfaces. Normalize the same way buildClientSignals does.
    const clientsByEmail = new Map<string, Array<{ id: string; name: string; cadence: UpdateCadence }>>();
    for (const c of clients) {
      const cadence = coerceCadence(c.update_cadence);
      for (const raw of c.contact_emails ?? []) {
        const email = raw.trim().toLowerCase();
        if (!email) continue;
        const list = clientsByEmail.get(email) ?? [];
        list.push({ id: c.id, name: c.name, cadence });
        clientsByEmail.set(email, list);
      }
    }

    const recommendations: DigestRecommendation[] = [];
    for (const c of clients) {
      const clientWork = workByClient.get(c.name) ?? [];
      if (clientWork.length === 0) continue;

      const entries: DigestEntryDetail[] = clientWork.slice(0, 6).map((w) => ({
        id: w.id,
        workedOn: w.worked_on,
        results: w.results,
        noteDate: w.note_date,
        authorName: userById.get(w.user_id) ?? null
      }));

      const contributorNames = Array.from(new Set(
        clientWork.map((w) => userById.get(w.user_id)).filter((n): n is string => !!n)
      ));

      const cadence = coerceCadence(c.update_cadence);
      const lastSent = lastSentByClient.get(c.name) ?? null;

      // Signal A: a client-update email already went out within this window.
      const inWindow = lastUpdateInWindowByClient.get(c.name) ?? null;
      const recentlyEmailed: { daysSince: number; window: DigestWindow } | null = inWindow
        ? {
            daysSince: Math.floor((Date.now() - new Date(inWindow).getTime()) / 86_400_000),
            window
          }
        : null;

      // Signal B: a contact email also belongs to another active client.
      const sharedRecipients: SharedRecipient[] = [];
      for (const raw of c.contact_emails ?? []) {
        const email = raw.trim().toLowerCase();
        if (!email) continue;
        const others = (clientsByEmail.get(email) ?? [])
          .filter((o) => o.id !== c.id)
          .map((o) => ({ name: o.name, cadence: o.cadence }));
        if (others.length > 0) sharedRecipients.push({ email, others });
      }

      recommendations.push({
        clientId: c.id,
        clientName: c.name,
        contactEmails: c.contact_emails ?? [],
        entryCount: clientWork.length,
        lastSentAt: lastSent,
        entries,
        contributorNames,
        hasContact: (c.contact_emails?.length ?? 0) > 0,
        cadence,
        recentlyEmailed,
        sharedRecipients
      });
    }

    // Most work first, then oldest last-update (those have waited longest).
    recommendations.sort((a, b) => {
      if (a.entryCount !== b.entryCount) return b.entryCount - a.entryCount;
      return (a.lastSentAt ?? "").localeCompare(b.lastSentAt ?? "");
    });

    return NextResponse.json({
      window,
      windowDays: WINDOW_DAYS[window],
      recommendations
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
