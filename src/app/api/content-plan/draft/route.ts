import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/content-plan/draft
//   body: {
//     clientId?: string,
//     clientName: string,
//     to: string[],                    // recipients (defaults to client's contact_emails if empty)
//     topics: string,                  // raw bullet points from the SEO worker
//     targetAudience?: string,         // optional context to feed the model
//     angle?: string,                  // optional positioning angle
//     submit?: boolean                 // if true, route the drafted email
//                                      // straight into the approval queue;
//                                      // otherwise return the body for
//                                      // preview/editing first
//   }
//
//   Uses gpt-4o-mini to draft the email in Bella's template (per spec
//   Section 3B). On submit=true, creates an email_drafts row of
//   kind='content_plan' and triggers the 6-person approver Slack ping
//   via the existing /api/email-drafts route's internal logic — we
//   call POST /api/email-drafts so we don't duplicate that fan-out.

const BELLA_TEMPLATE_GUIDANCE = `
You are drafting a monthly content-plan email for an SEO agency client.
Tone: direct, confident, no fluff. Explain the WHY upfront. Use bullets
for clusters. End with a soft confirmation ask.

Structure (match exactly):
1. Greeting — "Hi Team,"
2. Intro paragraph: "I wanted to share the content plan for this month
   and briefly explain the strategy behind it."
3. Strategy paragraph: identify the target audience, the angle, why it
   matters (search intent, untapped segment, conversion alignment),
   and how it supports the client's core conversion goals.
4. "We've structured the content across [X] clusters, covering [Y]
   blogs in total:"
5. For EACH cluster, a bullet with:
   • Cluster name (bold-style with leading "*")
   • A 2-3 sentence description of what's covered, who it targets, and
     what searcher questions it answers
6. Closing paragraph: "All content is internally linked back to your
   core service pages and homepage to strengthen rankings on your main
   keywords. Every piece is written specifically for [target audience],
   with search intent mapped to where they are in the decision-making
   journey, from initial research through to active job search."
7. Soft ask: "Let me know if this direction looks good and we'll move
   forward."
8. Sign-off: "Best,\\n[SEO team member name]"

Return ONLY the email body as plain text. No markdown, no preamble,
no "Here is your email" wrapper. Use blank lines between paragraphs
and a leading "• " for cluster bullets.
`.trim();

interface OpenAIChatResp {
  choices: Array<{ message: { content: string } }>;
  error?: { message?: string };
}

async function draftEmailBody(args: {
  clientName: string;
  topics: string;
  targetAudience: string | null;
  angle: string | null;
  authorName: string;
}): Promise<{ subject: string; body: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  // Compose a tight system + user prompt. We pin the model to a JSON
  // response so subject + body come back separately — easier to slot
  // into the email_drafts row without parsing prose.
  const messages = [
    { role: "system", content: BELLA_TEMPLATE_GUIDANCE },
    {
      role: "user",
      content: [
        `Client: ${args.clientName}`,
        args.targetAudience ? `Target audience: ${args.targetAudience}` : "",
        args.angle ? `Angle / positioning: ${args.angle}` : "",
        `SEO team member name (sign-off): ${args.authorName}`,
        "",
        "Topics / cluster strategy (raw bullets — flesh out into clusters):",
        args.topics
      ].filter(Boolean).join("\n")
    },
    {
      role: "user",
      content: `Respond as JSON with exactly two keys:
{
  "subject": "Subject line for this email (≤ 80 chars, no quotes, mention the client by name only if natural)",
  "body": "Full email body matching the structure above. Plain text."
}`
    }
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.55,
      messages
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as OpenAIChatResp;
  if (data.error) throw new Error(data.error.message ?? "openai error");
  const content = data.choices?.[0]?.message?.content ?? "";
  let parsed: { subject?: string; body?: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("model returned non-JSON response");
  }
  if (!parsed.subject || !parsed.body) {
    throw new Error("model JSON missing subject or body");
  }
  return { subject: parsed.subject.slice(0, 300), body: parsed.body };
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const body = await req.json().catch(() => ({}));

    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    const topics = typeof body.topics === "string" ? body.topics.trim() : "";
    const targetAudience = typeof body.targetAudience === "string" && body.targetAudience.trim()
      ? body.targetAudience.trim()
      : null;
    const angle = typeof body.angle === "string" && body.angle.trim()
      ? body.angle.trim()
      : null;
    const submit = body.submit === true;
    const toEmails: string[] = Array.isArray(body.to)
      ? body.to.filter((e: unknown) => typeof e === "string" && /.+@.+\..+/.test(e)).map((s: string) => s.trim())
      : [];

    if (!clientName) return NextResponse.json({ error: "clientName required" }, { status: 400 });
    if (!topics) return NextResponse.json({ error: "topics required" }, { status: 400 });

    // Look up the author name for the sign-off + the client's contact
    // emails as a recipient fallback when submit=true.
    const [{ data: authorRow }, { data: clientRow }] = await Promise.all([
      supabase.from("users").select("name").eq("id", userId).maybeSingle(),
      clientId
        ? supabase.from("clients").select("contact_emails").eq("id", clientId).maybeSingle()
        : Promise.resolve({ data: null })
    ]);
    const authorName = (authorRow?.name as string | undefined) ?? "SEO Team";
    const fallbackTo = (clientRow?.contact_emails as string[] | null) ?? [];
    const finalTo = toEmails.length > 0 ? toEmails : fallbackTo;

    const drafted = await draftEmailBody({
      clientName,
      topics,
      targetAudience,
      angle,
      authorName
    });

    // Preview-only: return the drafted text so the SEO worker can
    // tweak before submitting to the approval queue.
    if (!submit) {
      return NextResponse.json({
        ok: true,
        subject: drafted.subject,
        body: drafted.body,
        suggestedTo: fallbackTo
      });
    }

    if (finalTo.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "no recipient — add at least one To email or set contact_emails on the client",
        subject: drafted.subject,
        body: drafted.body
      }, { status: 422 });
    }

    // Submit: forward to the email-drafts endpoint so the Slack fan-out
    // + queue creation path stays single-source-of-truth.
    const cookie = req.headers.get("cookie") ?? "";
    const origin = req.nextUrl.origin;
    const submitRes = await fetch(`${origin}/api/email-drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        clientId,
        clientName,
        to: finalTo,
        subject: drafted.subject,
        bodyText: drafted.body,
        kind: "content_plan"
      })
    });
    const submitData = await submitRes.json().catch(() => ({}));
    if (!submitRes.ok) {
      return NextResponse.json({
        ok: false,
        error: submitData?.error ?? `submit failed (${submitRes.status})`,
        subject: drafted.subject,
        body: drafted.body
      }, { status: submitRes.status });
    }
    return NextResponse.json({
      ok: true,
      submitted: true,
      draftId: submitData.id,
      subject: drafted.subject,
      body: drafted.body,
      slackDeliveries: submitData.slackDeliveries ?? []
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
