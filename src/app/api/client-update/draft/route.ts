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
//     to?: string                 // ISO — window end (default: now)
//   }
//
// Drafts a client-facing weekly progress email for a single client over a
// selected date range. Pulls from the SAME completed-work data already shown
// on the client page (the "Knowledge base · completed work" card):
//   - completed tasks for this client (status='done', completed_at in window)
//     -> Completed work + Key outcomes
//   - in-progress tasks (status != 'done')
//     -> Current work in progress + Next steps / upcoming priorities
// It does NOT introduce any new reporting store — it reads the existing tasks.
//
// Mirrors the sibling AI drafters (content-plan/draft, eod/client-update/draft):
// same auth pattern, same robust-JSON-parse + dash-scrub, returns { subject,
// body } for preview/editing. Never persists — the composer submits the edited
// draft to POST /api/email-drafts (kind='client_update') for approval.
//
// Empty-state: if there is NO completed work in the window, returns
// { ok: true, empty: true, message } WITHOUT calling the model, so the UI can
// show a "try a wider range" notice instead of a hollow email.

interface Body {
  clientId?: string;
  clientName?: string;
  from?: string;
  to?: string;
}

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

    const [me, client] = await Promise.all([
      getUserById(userId),
      getClient(clientId)
    ]);
    if (!client) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }

    // Server-side access gate — must match the UI gate on the client page:
    // leaders / admins / department heads / the client's assigned point-person.
    // Never trust the client to have hidden the card.
    const allowed = !!me && (
      isLeader(me) ||
      me.role === "department_head" ||
      client.assignedUserIds.includes(me.id)
    );
    if (!allowed) {
      return NextResponse.json({ error: "not allowed" }, { status: 403 });
    }

    // Resolve the date window. Default = last 7 days. Bad/missing inputs
    // fall back to the default rather than erroring.
    const now = Date.now();
    const toMs = body.to ? Date.parse(body.to) : now;
    const fromMs = body.from ? Date.parse(body.from) : now - WEEK_MS;
    const toIso = new Date(Number.isFinite(toMs) ? toMs : now).toISOString();
    const fromIso = new Date(Number.isFinite(fromMs) ? fromMs : now - WEEK_MS).toISOString();

    const clientName = client.name;
    const contactName = client.contactName ?? null;
    const callerName = me?.name ?? "The team";

    // Completed work + in-progress work for this client. Matched on
    // client_name (the legacy linkage used everywhere on the client page).
    // Completed tasks are filtered by completed_at (the done-transition
    // timestamp) so the window means "finished in this period", not "touched".
    const [doneRes, openRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, description, tags, completed_at")
        .eq("client_name", clientName)
        .eq("status", "done")
        .gte("completed_at", fromIso)
        .lte("completed_at", toIso)
        .order("completed_at", { ascending: false })
        .limit(50),
      supabase
        .from("tasks")
        .select("id, title, description, status, priority")
        .eq("client_name", clientName)
        .neq("status", "done")
        .order("due_date", { ascending: true })
        .limit(20)
    ]);

    const done = (doneRes.data ?? []) as Array<{
      id: string; title: string; description: string | null; tags: string[] | null; completed_at: string | null;
    }>;
    const open = (openRes.data ?? []) as Array<{
      id: string; title: string; description: string | null; status: string; priority: string | null;
    }>;

    // Graceful empty state — no completed work means no quality update.
    // Return WITHOUT hitting the model so the UI can prompt for a wider range.
    if (done.length === 0) {
      return NextResponse.json({
        ok: true,
        empty: true,
        message: `No completed work for ${clientName} in this period. Try a wider date range.`,
        signals: { completedCount: 0, inProgressCount: open.length }
      });
    }

    // Build a structured digest so the model doesn't guess at the shape.
    const clamp = (s: string | null, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const completedLines = done
      .map((t) => {
        const desc = clamp(t.description, 200);
        const tags = t.tags?.length ? ` [${t.tags.slice(0, 3).join(", ")}]` : "";
        return `- ${t.title}${tags}${desc ? `: ${desc}` : ""}`;
      })
      .join("\n");
    const inProgressLines = open.length > 0
      ? open.map((t) => {
          const desc = clamp(t.description, 160);
          return `- ${t.title}${desc ? `: ${desc}` : ""}`;
        }).join("\n")
      : "(none)";

    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const userPrompt = [
      `Client: ${clientName}`,
      contactName ? `Primary contact: ${contactName}` : "",
      `Sender (sign-off): ${callerName}`,
      `Reporting period: ${fmt(fromIso)} to ${fmt(toIso)}`,
      "",
      `Completed work this period (${done.length}):`,
      completedLines,
      "",
      "Work currently in progress / upcoming:",
      inProgressLines,
      "",
      "Draft the client update email body. Output STRICT JSON: { subject, body }."
    ].filter(Boolean).join("\n");

    const systemPrompt = `You write client-facing weekly progress update emails for a digital agency. The sender clicked "Generate Client Update Email"; this draft will be edited and then queued for human approval before sending.

Translate INTERNAL task notes into clear, CLIENT-FRIENDLY language. Focus on outcomes and progress, NOT a raw task list. Group related work into themes. Never expose internal jargon, ticket IDs, tags, or assignee names.

Structure the body as short labeled sections, in this order. Omit a section entirely if it has no real content (do not write "N/A"):
- Completed work: what was delivered this period, phrased as outcomes for the client.
- Key outcomes: the results / impact that matter to the client (only if they can be reasonably stated from the input).
- In progress: what is currently underway (only if there is in-progress work).
- Next steps: upcoming priorities (derive from the in-progress work; only if there is any).

Voice: professional, warm, first-person plural ("we"). Open with a one-line summary of the period. End with a soft prompt ("Let us know if you have any questions.") then sign off "Best," on its own line, then "${callerName}".

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, parentheses, or colons.
- Plain text only. No markdown, no asterisks, no bold. Section labels may be plain words followed by a colon.
- NEVER invent specifics, metrics, or deliverables not present in the input. Summarize only what is given.

Return STRICT JSON, no code fences:
{ "subject": "<=70 chars, e.g. 'Weekly update — Acme'>", "body": "<plain-text body>" }`;

    const anthropic = await getAnthropic();
    const result = await anthropic.messages.create({
      model: MODELS.chat, // Sonnet — client-facing, multi-section prose
      max_tokens: 1800,
      temperature: 0.5,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const block = result.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text.trim() : "";

    let parsed: { subject?: unknown; body?: unknown } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
      }
    }
    const subjectRaw = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const bodyRaw = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!bodyRaw) {
      return NextResponse.json(
        { error: "model returned no body — try again or write manually" },
        { status: 502 }
      );
    }

    // Belt-and-suspenders dash scrub (mirrors the sibling drafters).
    const scrub = (s: string) => s
      .replace(/\s+—\s+/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/—/g, ",")
      .replace(/–/g, ",");

    return NextResponse.json({
      ok: true,
      subject: scrub(subjectRaw || `Weekly update — ${clientName}`).slice(0, 300),
      body: scrub(bodyRaw),
      suggestedTo: client.contactEmails,
      signals: { completedCount: done.length, inProgressCount: open.length }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
