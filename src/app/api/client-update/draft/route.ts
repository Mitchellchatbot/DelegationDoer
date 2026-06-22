import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getClient } from "@/lib/clients-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/auth";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/client-update/draft
//   body: {
//     clientId: string,
//     clientName?: string,        // display only; clientId is the source of truth
//     from?: string,              // ISO — window start (default: 7 days ago)
//     to?: string,                // ISO — window end (default: now)
//     entryIds?: string[]         // operator's selected EOD work entries.
//                                 // Omit = every entry in the window.
//   }
//
// Drafts client-facing progress email(s) for a single client over a date
// range, SOURCED FROM THE EOD FORMS (not tasks). Each contributor logs
// "what I did for {client} today" (worked_on + results) in their EOD; this
// pulls those entries for the window, groups them by the CONTRIBUTOR's
// department (SEO vs Website), and drafts one client email per department
// so it routes to that department's head.
//
// Returns { ok: true, drafts: DepartmentDraft[] } — one entry per
// department. Never persists; the composer submits each edited draft to
// POST /api/email-drafts (kind='client_update', departmentId, eodWorkIds)
// for approval. On send the linked entries get reported_to_client_at
// stamped so the same work never goes out twice.
//
// Empty-state: no selected entries in the window -> { ok, empty, message }
// WITHOUT calling the model.

interface Body {
  clientId?: string;
  clientName?: string;
  from?: string;
  to?: string;
  // EOD work entry ids the operator selected in the composer preview.
  // When present, ONLY these feed the draft(s). Omitted = every entry.
  entryIds?: unknown;
}

interface DepartmentDraft {
  departmentId: string | null;
  departmentName: string;
  subject: string;
  body: string;
  suggestedTo: string[];
  eodWorkIds: string[]; // the EOD entries this draft summarized (for reporting)
}

interface WorkRow {
  id: string;
  user_id: string;
  note_date: string;
  worked_on: string;
  results: string | null;
}

const NO_DEPT = "__no_dept__";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const body = (await req.json().catch(() => ({}))) as Body;
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      return NextResponse.json({ error: "clientId required" }, { status: 400 });
    }

    const [me, client] = await Promise.all([getUserById(userId), getClient(clientId)]);
    if (!client) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }

    // Server-side access gate — leaders / admins / department heads / the
    // client's assigned point-person.
    const allowed = !!me && (
      isLeader(me) ||
      me.role === "department_head" ||
      client.assignedUserIds.includes(me.id)
    );
    if (!allowed) {
      return NextResponse.json({ error: "not allowed" }, { status: 403 });
    }

    // Window. Default = last 7 days. Bad/missing inputs fall back.
    const now = Date.now();
    const toMs = body.to ? Date.parse(body.to) : now;
    const fromMs = body.from ? Date.parse(body.from) : now - WEEK_MS;
    const toIso = new Date(Number.isFinite(toMs) ? toMs : now).toISOString();
    const fromIso = new Date(Number.isFinite(fromMs) ? fromMs : now - WEEK_MS).toISOString();
    const fromDateStr = fromIso.slice(0, 10);
    const toDateStr = toIso.slice(0, 10);

    const clientName = client.name;
    const contactName = client.contactName ?? null;
    const callerName = me?.name ?? "The team";

    // Selected-entry gate. null = no entryIds key (legacy) -> every entry
    // in the window. Explicit empty array -> nothing to report.
    const selectedIds: string[] | null = Array.isArray(body.entryIds)
      ? body.entryIds.filter((v): v is string => typeof v === "string" && v.length > 0)
      : null;
    if (selectedIds !== null && selectedIds.length === 0) {
      return NextResponse.json({
        ok: true,
        empty: true,
        message: "No EOD entries selected. Pick at least one to include in the update."
      });
    }

    // EOD work entries for this client in the window, not yet reported.
    let workQuery = supabase
      .from("eod_client_work")
      .select("id, user_id, note_date, worked_on, results")
      .eq("client_name", clientName)
      .is("reported_to_client_at", null)
      .is("dismissed_at", null)
      .gte("note_date", fromDateStr)
      .lte("note_date", toDateStr)
      .order("note_date", { ascending: false })
      .limit(200);
    if (selectedIds !== null) workQuery = workQuery.in("id", selectedIds);
    const { data: workRes } = await workQuery;
    const work = (workRes ?? []) as WorkRow[];

    if (work.length === 0) {
      return NextResponse.json({
        ok: true,
        empty: true,
        message: `No EOD work logged for ${clientName} in this period. Ask the team to log their EOD client work, or widen the date range.`,
        signals: { entryCount: 0 }
      });
    }

    // Resolve each contributor's department (SEO vs Website), preferring
    // the client-facing departments when a user belongs to several.
    const userIds = Array.from(new Set(work.map((w) => w.user_id)));
    const deptByUser = new Map<string, string>();
    const deptNameById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: members } = await supabase
        .from("department_members")
        .select("user_id, department_id")
        .in("user_id", userIds);
      const PREFER = ["dep_seo", "dep_web"];
      const membersByUser = new Map<string, string[]>();
      for (const m of ((members ?? []) as { user_id: string; department_id: string }[])) {
        const arr = membersByUser.get(m.user_id) ?? [];
        arr.push(m.department_id);
        membersByUser.set(m.user_id, arr);
      }
      for (const [uid, depts] of membersByUser) {
        const pick = PREFER.find((p) => depts.includes(p)) ?? depts[0];
        if (pick) deptByUser.set(uid, pick);
      }
      const deptIds = Array.from(new Set([...deptByUser.values()]));
      if (deptIds.length > 0) {
        const { data: deptRows } = await supabase.from("departments").select("id, name").in("id", deptIds);
        for (const d of ((deptRows ?? []) as { id: string; name: string }[])) {
          deptNameById.set(d.id, d.name);
        }
      }
    }

    // Group entries by the contributor's department. No department -> a
    // single "General" draft.
    const byDept = new Map<string, WorkRow[]>();
    for (const w of work) {
      const key = deptByUser.get(w.user_id) ?? NO_DEPT;
      const arr = byDept.get(key) ?? [];
      arr.push(w);
      byDept.set(key, arr);
    }

    const clamp = (s: string | null, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const systemPrompt = `You write client-facing progress update emails for a digital agency. The sender clicked "Generate Client Update Email"; this draft will be edited and then queued for human approval before sending.

You are given the team's INTERNAL end-of-day work logs for this client (what each person did, plus any results they noted). Translate them into clear, CLIENT-FRIENDLY language. Focus on outcomes and progress, NOT a raw activity list. Group related work into themes. Never expose internal jargon, ticket IDs, tags, or teammate names.

Structure the body as short labeled sections, in this order. Omit a section entirely if it has no real content (do not write "N/A"):
- Completed work: what was delivered this period, phrased as outcomes for the client.
- Key outcomes / results: the measurable results that matter to the client (only when the logs actually state them).
- What's next: upcoming priorities, only if the logs imply them.

Voice: professional, warm, first-person plural ("we"). Open with a one-line summary of the period. End with a soft prompt ("Let us know if you have any questions.") then sign off "Best," on its own line, then "${callerName}".

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, parentheses, or colons.
- Plain text only. No markdown, no asterisks, no bold. Section labels may be plain words followed by a colon.
- NEVER invent specifics, metrics, or deliverables not present in the input. Summarize only what is given.

Return STRICT JSON, no code fences:
{ "subject": "<=70 chars, e.g. 'Weekly update — Acme'>", "body": "<plain-text body>" }`;

    const scrub = (s: string) => s
      .replace(/\s+—\s+/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/—/g, ",")
      .replace(/–/g, ",");

    const anthropic = await getAnthropic();

    const deptKeys = Array.from(byDept.keys());
    const draftsRaw = await Promise.all(
      deptKeys.map(async (deptKey): Promise<DepartmentDraft | null> => {
        const departmentId = deptKey === NO_DEPT ? null : deptKey;
        const departmentName = departmentId ? (deptNameById.get(departmentId) ?? "Team") : "General";
        const entries = byDept.get(deptKey) ?? [];

        const workLines = entries
          .map((w) => {
            const did = clamp(w.worked_on, 400);
            const res = clamp(w.results, 300);
            return `- ${did}${res ? ` (results: ${res})` : ""}`;
          })
          .join("\n");

        const userPrompt = [
          `Client: ${clientName}`,
          departmentId ? `Department focus: ${departmentName} (write the update around this team's work only)` : "",
          contactName ? `Primary contact: ${contactName}` : "",
          `Sender (sign-off): ${callerName}`,
          `Reporting period: ${fmt(fromIso)} to ${fmt(toIso)}`,
          "",
          `Team end-of-day work logs for ${clientName} this period (${entries.length}):`,
          workLines,
          "",
          "Draft the client update email body. Output STRICT JSON: { subject, body }."
        ].filter(Boolean).join("\n");

        const result = await anthropic.messages.create({
          model: MODELS.chat,
          max_tokens: 1800,
          temperature: 0.5,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        });

        const blk = result.content.find((b) => b.type === "text");
        const rawText = blk && blk.type === "text" ? blk.text.trim() : "";
        let parsed: { subject?: unknown; body?: unknown } = {};
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const match = rawText.match(/\{[\s\S]*\}/);
          if (match) {
            try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
          }
        }
        const subjectRaw = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
        const bodyRaw = typeof parsed.body === "string" ? parsed.body.trim() : "";
        if (!bodyRaw) return null;

        const subjectFallback = departmentId
          ? `${departmentName} update — ${clientName}`
          : `Weekly update — ${clientName}`;
        return {
          departmentId,
          departmentName,
          subject: scrub(subjectRaw || subjectFallback).slice(0, 300),
          body: scrub(bodyRaw),
          suggestedTo: client.contactEmails,
          eodWorkIds: entries.map((w) => w.id)
        };
      })
    );

    const drafts = draftsRaw.filter((d): d is DepartmentDraft => d !== null);
    if (drafts.length === 0) {
      return NextResponse.json(
        { error: "model returned no usable drafts — try again or write manually" },
        { status: 502 }
      );
    }
    // Stable order: named departments alphabetically, General last.
    drafts.sort((a, b) => {
      if (a.departmentId === null) return 1;
      if (b.departmentId === null) return -1;
      return a.departmentName.localeCompare(b.departmentName);
    });

    return NextResponse.json({
      ok: true,
      drafts,
      signals: { entryCount: work.length, departmentCount: drafts.length }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
