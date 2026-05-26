import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/eod/client-update/draft
//   body: { clientId: string }
//
// Drafts a short, factual "here's what we did today" message for the
// caller to send to a specific client as part of their EOD wrap-up.
// Pulled from two signals:
//   - tasks the user closed today for this client (title + tags)
//   - emails sent by the user to this client today (subject only)
// Tone-matches the existing Bella-style content plan drafter (direct,
// confident, no em dashes). Returns { subject, body }.
//
// Used by the "Fill with AI" button in the per-client EmailDraftCard
// inside the EOD typeform. Never persists — the user reviews + edits
// in the form before hitting Send for approval.

interface Body {
  clientId?: string;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const body = (await req.json().catch(() => ({}))) as Body;
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      return NextResponse.json({ error: "clientId required" }, { status: 400 });
    }

    // 1) Load the client name + caller name. Both feed the prompt so
    //    the model can address the recipient by name and sign off as
    //    the caller.
    const [{ data: client }, { data: me }] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, contact_name")
        .eq("id", clientId)
        .maybeSingle(),
      supabase
        .from("users")
        .select("id, name")
        .eq("id", userId)
        .maybeSingle()
    ]);
    if (!client) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }
    const callerName = (me?.name as string | undefined) ?? "The team";
    const clientName = client.name as string;
    const contactName = (client.contact_name as string | null) ?? null;

    const todayIso = startOfTodayIso();

    // 2) Today's signals for this user × client. Best-effort — empty
    //    arrays still produce a generic "no notable updates today"
    //    fallback rather than failing.
    const [tasksRes, emailsRes] = await Promise.all([
      // Tasks the user closed today for this client. We match on
      // client_name (legacy linkage); the join through client_id
      // isn't always populated for older tasks.
      supabase
        .from("tasks")
        .select("id, title, description, tags")
        .eq("assignee_id", userId)
        .eq("client_name", clientName)
        .eq("status", "done")
        .gte("last_activity_at", todayIso)
        .limit(15),
      // Emails the user authored + sent to this client today.
      supabase
        .from("email_drafts")
        .select("subject, kind")
        .eq("author_id", userId)
        .eq("client_id", clientId)
        .eq("status", "sent")
        .gte("sent_at", todayIso)
        .limit(10)
    ]);

    const tasks = (tasksRes.data ?? []) as Array<{
      id: string; title: string; description: string | null; tags: string[] | null;
    }>;
    const emails = (emailsRes.data ?? []) as Array<{
      subject: string | null; kind: string;
    }>;

    // 3) Compose a tight prompt. Embed the signals as a structured
    //    digest so Claude doesn't have to guess at the data shape.
    const taskLines = tasks.length > 0
      ? tasks.map((t) =>
          `- ${t.title}${t.tags?.length ? ` (${t.tags.slice(0, 3).join(", ")})` : ""}`
        ).join("\n")
      : "(none closed today)";
    const emailLines = emails.length > 0
      ? emails.map((e) => `- ${e.subject ?? "(no subject)"}`).join("\n")
      : "(none sent today)";

    const userPrompt = [
      `Client: ${clientName}`,
      contactName ? `Primary contact: ${contactName}` : "",
      `SEO/Web teammate (sign-off): ${callerName}`,
      "",
      "Tasks closed today for this client:",
      taskLines,
      "",
      "Emails sent today to this client by this teammate:",
      emailLines,
      "",
      "Draft the body of a short EOD-style update email to the client telling them what was done today. Output JSON: { subject, body }."
    ].filter(Boolean).join("\n");

    const systemPrompt = `You write end-of-day client update emails for a digital agency. The user just clicked "Fill with AI" in their EOD form; this draft will be queued for human approval before sending.

Voice: direct, friendly, professional. First-person plural ("we"). 2-4 short paragraphs.
- Open with a one-line summary of what was accomplished today.
- One short paragraph per major theme (e.g. content shipped, fixes deployed, calls handled).
- If nothing notable shipped, say so honestly ("Quiet day on our side — wanted to check in.") instead of making things up.
- End with a soft prompt: "Let us know if you have any questions."
- Sign off "Best," then a newline, then "${callerName}".

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, or parentheses.
- Plain text only. No markdown, no bullets, no headers.
- Never invent specifics not present in the input. If tasks/emails are empty, the body must reflect that.

Return STRICT JSON, no code fences:
{ "subject": "<≤60 chars, e.g. 'EOD update — Acme'>", "body": "<plain-text body>" }`;

    const client_ = await getAnthropic();
    const result = await client_.messages.create({
      model: MODELS.classify, // Haiku — cheap + plenty for a short update
      max_tokens: 800,
      temperature: 0.4,
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

    // Belt-and-suspenders dash scrub.
    const scrub = (s: string) => s
      .replace(/\s+—\s+/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/—/g, ",")
      .replace(/–/g, ",");

    return NextResponse.json({
      subject: scrub(subjectRaw || `EOD update — ${clientName}`).slice(0, 300),
      body: scrub(bodyRaw),
      signals: { tasksCount: tasks.length, emailsCount: emails.length }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
