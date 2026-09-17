import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

// POST /api/brain/linkedin/draft — write (or revise) a LinkedIn post in
// Mitchell's voice from a topic he gives. Owner only. Body:
//   { topic: string, instruction?: string, current?: string }
// instruction+current = "here's the draft, change it like this" (feedback loop).
const SYSTEM = `You ghostwrite LinkedIn posts for Mitchell Price, founder of Scaled AI — a marketing agency (SEO, websites, Meta/Facebook ads) for addiction-treatment and behavioral-health centers in the US.

Write in Mitchell's voice:
- Casual, direct, confident. Like a smart operator talking to peers, not a marketer.
- NO dashes (no em-dash or en-dash). Use periods, commas, or rewrite.
- No hashtags. No emojis unless the topic clearly calls for one. No corporate buzzwords.
- Short punchy paragraphs, mostly 1-2 sentences. Use a numbered list only when it genuinely helps.
- Contractions. Plain words.

Content rules:
- Lead with value or a real insight, not a pitch. Teach something a treatment-center owner or peer actually finds useful.
- One idea per post. Make it concrete, grounded in how treatment-center marketing really works (booked admits, VOBs, families searching at 2am, follow-up discipline, SEO authority, Meta funnels).
- End with a soft, human call to action (e.g. "Message me if you want the breakdown."), never a hard sell.
- 120-220 words. No title line, no "P.S.", no signature. Just the post body ready to paste.

Return ONLY the post text — no preamble, no quotes, no markdown fences.`;

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => null);
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  const current = typeof body?.current === "string" ? body.current.trim() : "";
  if (!topic && !current) return NextResponse.json({ error: "give a topic to write about" }, { status: 400 });

  const userMsg = current && instruction
    ? `Here is the current draft:\n\n"""\n${current}\n"""\n\nRevise it based on this feedback: ${instruction}\nKeep the same topic${topic ? ` (${topic})` : ""}. Return only the revised post.`
    : `Write a LinkedIn post about: ${topic}${instruction ? `\n\nExtra direction: ${instruction}` : ""}`;

  try {
    const client = await getAnthropic();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await client.messages.create({
      model: MODELS.chat,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }]
    });
    const post = (result.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!post) return NextResponse.json({ error: "couldn't draft that — try rephrasing the topic" }, { status: 502 });
    return NextResponse.json({ post });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "draft failed" }, { status: 500 });
  }
}
