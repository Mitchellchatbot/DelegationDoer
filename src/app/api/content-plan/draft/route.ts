import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

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
You draft monthly content-plan emails for an SEO agency. The body MUST
follow the template below LITERALLY, filling in the bracketed slots
from the inputs. Do not paraphrase the boilerplate sentences.

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–") anywhere in the body
  or the subject. Use commas, periods, parentheses, or a colon instead.
- Tone: direct, confident, no fluff. No marketing-speak. No emojis.
  No exclamation points.
- Plain text only. No markdown headers, no bold/italic, no asterisks
  around cluster names. Use "•" (U+2022) for cluster bullets.
- Replace "active job search" in the closing paragraph with whatever
  natural end-state of the decision-making journey fits the audience
  (e.g. "active treatment search", "active vendor selection",
  "an admissions inquiry"). Keep the rest of that sentence verbatim.

EXACT TEMPLATE — fill in [bracketed] slots only, leave the rest as-is:

Hi Team,

I wanted to share the content plan for this month and briefly explain the strategy behind it.

This month, we're focusing on [target audience] as a [new target | continued focus], building a dedicated cluster of content around [specific angle]. This is [why it matters in one clause: search intent, untapped segment, or conversion alignment], and the content directly supports your core conversion goals.

We've structured the content across [X] clusters, covering [Y] blogs in total:

• [Cluster 1 name]
[2-3 sentence description: what's covered, who it targets, what searcher questions it answers.]

• [Cluster 2 name]
[Same format.]

• [Cluster 3 name]
[Same format.]

[Continue for every cluster.]

All content is internally linked back to your core service pages and homepage to strengthen rankings on your main keywords. Every piece is written specifically for [target audience], with search intent mapped to where they are in the decision-making journey, from initial research through to [end-state of the journey for this audience].

Let me know if this direction looks good and we'll move forward.

Best,
[SEO team member name]

CLUSTER RULES:
- 3 to 5 clusters total. Group the input topics thematically.
- Cluster names: 3 to 6 words, descriptive, no jargon.
- Inside each cluster description: state who it targets and what
  searcher questions it answers. Do not bullet the individual blogs.
- The "[Y] blogs in total" count must equal the count of input topics.
`.trim();

async function draftEmailBody(args: {
  clientName: string;
  topics: string;
  targetAudience: string | null;
  angle: string | null;
  authorName: string;
}): Promise<{ subject: string; body: string }> {
  // Anthropic key comes from Supabase Vault via getAnthropicKey, with
  // ANTHROPIC_API_KEY env as an escape hatch — see src/lib/anthropic-key.ts.
  const userPrompt = [
    `Client: ${args.clientName}`,
    args.targetAudience ? `Target audience: ${args.targetAudience}` : "",
    args.angle ? `Angle / positioning: ${args.angle}` : "",
    `SEO team member name (sign-off): ${args.authorName}`,
    "",
    "Topics / cluster strategy (raw bullets — flesh out into clusters):",
    args.topics,
    "",
    `Respond as STRICT JSON — no preamble, no code fences — with exactly two keys:
{
  "subject": "Subject line for this email (≤ 80 chars, no quotes, mention the client by name only if natural)",
  "body": "Full email body matching the structure above. Plain text."
}`
  ].filter(Boolean).join("\n");

  const client = await getAnthropic();
  const result = await client.messages.create({
    model: MODELS.chat,
    max_tokens: 1800,
    temperature: 0.55,
    system: BELLA_TEMPLATE_GUIDANCE,
    messages: [{ role: "user", content: userPrompt }]
  });

  const block = result.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text.trim() : "";

  let parsed: { subject?: string; body?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some completions wrap the JSON in prose — extract the first
    // {...} block as a fallback before giving up.
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
    }
  }
  if (!parsed.subject || !parsed.body) {
    throw new Error("model JSON missing subject or body");
  }
  // Belt-and-suspenders dash scrub. The system prompt forbids them
  // but the model occasionally slips, and the user explicitly asked
  // for none. " — " → ", " (most natural); a bare "—" or "–" → ",".
  const scrub = (s: string) => s
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/—/g, ",")
    .replace(/–/g, ",");
  return {
    subject: scrub(parsed.subject).slice(0, 300),
    body: scrub(parsed.body)
  };
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
