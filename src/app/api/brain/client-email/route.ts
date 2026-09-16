import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getClient } from "@/lib/clients-data";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { clientContextForEmail } from "@/lib/owner-inbox";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";

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

// POST /api/brain/client-email — draft a warm check-in email to a client who's
// gone quiet, grounded in their recent history + Mitchell's priorities. Draft
// only; sending goes through /api/brain/compose on his click. Owner-only.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => null);
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });

  const client = await getClient(clientId).catch(() => null);
  if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
  const to = client.contactEmails?.[0] ?? "";

  const [ctx, memories] = await Promise.all([
    to ? clientContextForEmail(to).catch(() => "") : Promise.resolve(""),
    listMemories().catch(() => [])
  ]);
  const memBlock = memories.length ? `\n\nMitchell's standing priorities:\n${formatMemoriesBlock(memories)}` : "";

  const system = [
    "You are drafting a short, warm check-in email FROM Mitchell (founder of Scaled AI) TO an existing client who hasn't heard from him in a while.",
    "Goal: reconnect genuinely, remind them he's on top of their account, and open the door to anything they need. Not salesy. In his voice: warm, direct, plain words, contractions, no em-dashes, no corporate filler.",
    "Ground it in the client context if given (reference real recent work/meetings naturally); if there's nothing specific, keep it a genuine human check-in. 2-4 short sentences.",
    'Return STRICT JSON only: { "subject": string, "body": string }. The body is ready to send and signed "Mitchell".'
  ].join("\n");

  const user = `Client: ${client.name}${to ? ` (contact: ${to})` : ""}.\n${ctx ? `Context:\n${ctx}` : "No recent context on file."}${memBlock}\n\nDraft the check-in.`;

  try {
    const anthropic = await getAnthropic();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await anthropic.messages.create({
      model: MODELS.chat,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }]
    });
    const text = (result.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
    const raw = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return NextResponse.json({ to, subject: json.subject ?? `Checking in — ${client.name}`, bodyText: json.body ?? "" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "draft failed" }, { status: 500 });
  }
}
