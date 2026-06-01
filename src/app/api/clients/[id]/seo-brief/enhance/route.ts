import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/clients/[id]/seo-brief/enhance
//   body: { draft: string }
//
// Takes the leader's rough notes and returns a tightened SEO brief
// the team can actually action against. Same edit gate as the PATCH
// route (leader / admin / SEO head). Never persists — the caller drops
// the result back into the textarea for review before saving.

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const isLeader = me.role === "leader";
    const isAdmin = me.isAdmin === true;
    const isSeoHead =
      me.role === "department_head" && (me.departmentIds ?? []).includes("dep_seo");
    if (!isLeader && !isAdmin && !isSeoHead) {
      return NextResponse.json(
        { error: "leader, admin, or SEO head only" },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const draft = typeof body?.draft === "string" ? body.draft.trim() : "";
    if (!draft) {
      return NextResponse.json(
        { error: "write a few notes first — even rough ones" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const { data: client } = await supabase
      .from("clients")
      .select("id, name, website")
      .eq("id", params.id)
      .maybeSingle();
    if (!client) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }

    const userPrompt = [
      `Client: ${client.name}`,
      client.website ? `Website: ${client.website}` : "",
      "",
      "Leader's rough notes / draft brief:",
      draft,
      "",
      "Rewrite this as a tight SEO brief the team can act on."
    ].filter(Boolean).join("\n");

    const systemPrompt = `You sharpen messy leadership notes into actionable SEO briefs for a digital agency. Output PLAIN TEXT only — no markdown headers, no code fences.

Structure the output as three short labeled chunks separated by blank lines:
Target services: <one line or short bulleted list>
This quarter: <2-4 specific priorities, one per line, prefixed with "• ">
Avoid: <one line of what NOT to do, or a short bulleted list>

Rules:
- Keep every priority concrete (a deliverable, a metric, a page type, a service line). No vague "improve SEO".
- Preserve the leader's intent. Do not invent priorities they didn't mention.
- If a section has no signal in the draft, write "—" for that section instead of guessing.
- NEVER use em dashes ("—") or en dashes ("–") in the body of priorities. (The single "—" placeholder above is allowed when a section is empty.)
- Under 300 words total. Plain text.`;

    const anthropic = await getAnthropic();
    const result = await anthropic.messages.create({
      model: MODELS.chat,
      max_tokens: 700,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });
    const block = result.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) {
      return NextResponse.json(
        { error: "model returned nothing — try again" },
        { status: 502 }
      );
    }

    return NextResponse.json({ brief: text.slice(0, 4000) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
