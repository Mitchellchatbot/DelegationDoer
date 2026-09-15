import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";
import { deriveReply, transcriptFor, clientContextForEmail } from "@/lib/owner-inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

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

// POST /api/brain/inbox/draft — draft a reply to one of Mitchell's threads,
// grounded in his standing priorities/decisions (brain memory). Owner only.
// Body: { threadId, instruction? }
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => null);
  const threadId = typeof body?.threadId === "string" ? body.threadId : "";
  if (!threadId) return NextResponse.json({ error: "threadId required" }, { status: 400 });
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim().slice(0, 800) : "";

  const routing = await deriveReply(threadId);
  if (!routing) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const [memories, clientContext] = await Promise.all([
    listMemories().catch(() => []),
    clientContextForEmail(routing.to[0] ?? "").catch(() => "")
  ]);
  const memoryBlock = formatMemoriesBlock(memories);
  const transcript = transcriptFor(routing.messages);

  const system = [
    "You are drafting an email reply on behalf of Mitchell, founder of Scaled AI (a digital agency for addiction-treatment / behavioral-health clients).",
    "Write in his voice: warm, direct, human, no corporate stiffness, no em-dashes.",
    memoryBlock ? `What you know about the company / his standing priorities & decisions (let these inform the reply where relevant):\n${memoryBlock}` : "",
    clientContext ? `Who this client is and your recent history with them (use it — reference real decisions, next steps, and what they pay/care about where natural; do NOT restate it verbatim):\n${clientContext}` : "",
    "Output rules:",
    "- Plain text only. Start with the greeting line, end with a natural sign-off.",
    "- No subject/To/From headers, no 'Here is your reply' preamble.",
    "- Don't invent facts, prices, or commitments not supported by the thread or the priorities above. If something needs Mitchell to confirm, leave a [bracketed placeholder].",
    "- Never mention being an AI."
  ].filter(Boolean).join("\n");

  const userMsg = [
    "Recent thread, oldest first:",
    "",
    transcript,
    "",
    "Draft Mitchell's reply to the most recent received message." +
      (instruction ? `\n\nMitchell's instruction for this reply (follow it, it wins over other guidance):\n"""${instruction}"""` : "")
  ].join("\n");

  try {
    const client = await getAnthropic();
    const res = await client.messages.create({
      model: MODELS.chat,
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: userMsg }]
    });
    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text).join("\n").trim();
    if (!text) return NextResponse.json({ error: "empty draft" }, { status: 502 });
    return NextResponse.json({ bodyText: text, to: routing.to, subject: routing.subject });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "draft failed" }, { status: 500 });
  }
}
