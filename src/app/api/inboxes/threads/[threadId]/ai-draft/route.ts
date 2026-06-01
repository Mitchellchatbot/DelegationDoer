import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getThread, listAccounts } from "@/lib/missive-client";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/inboxes/threads/[threadId]/ai-draft
//
// Returns a single suggested reply body (plain text) that the
// ReplyComposer drops into its textarea. Pulls the full thread from
// missiveclone, hands the last ~6 messages plus an optional user
// instruction to Claude, and asks for a reply written from the
// perspective of whoever owns the inbox.
//
// Body: { instruction?: string, tone?: "friendly" | "formal" | "concise" }
// Response: { bodyText: string }
//
// Permissions: caller must have visibility into the inbox the thread
// belongs to. Otherwise we'd be drafting against a thread the user
// can't even see.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      instruction?: string;
      tone?: string;
    };
    const instruction = (body.instruction ?? "").trim().slice(0, 800);
    const tone = body.tone === "formal" || body.tone === "concise"
      ? body.tone
      : "friendly";

    // Resolve the thread + verify visibility against the caller's accounts.
    const [thread, accounts, visibleIds] = await Promise.all([
      getThread(params.threadId),
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);
    if (!thread || !thread.messages) {
      return NextResponse.json({ error: "thread not found" }, { status: 404 });
    }
    const threadAccountIds = new Set(thread.messages.map((m) => m.account_id).filter(Boolean));
    if (visibleIds !== null) {
      const hasAccess = Array.from(threadAccountIds).some((id) => visibleIds.has(id));
      if (!hasAccess) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Last ~6 messages; oldest first so Claude reads the conversation in
    // order. Cap each body to keep the context window bounded.
    const recent = thread.messages.slice(-6);
    const whoIAm = (() => {
      // Best-guess: the user's own connected account email if any
      // message on the thread routed through one of their inboxes.
      // Falls back to "me" if not found.
      for (const m of recent) {
        const a = accounts.find((x) => x.id === m.account_id);
        if (a && visibleIds && visibleIds.has(a.id)) return a.email;
      }
      return null;
    })();

    const transcript = recent.map((m, idx) => {
      const direction = m.direction === "outbound" ? "SENT" : "RECEIVED";
      const from = m.from_addr || "(unknown)";
      const subject = m.subject || "(no subject)";
      // Prefer plain-text body; collapse runaway whitespace; cap at 2000 chars.
      const raw = (m.body_text || stripHtml(m.body_html || "")).replace(/\s+\n/g, "\n").trim();
      const capped = raw.length > 2000 ? raw.slice(0, 2000) + " […truncated…]" : raw;
      return `[#${idx + 1} ${direction}] From: ${from}\nSubject: ${subject}\n\n${capped}`;
    }).join("\n\n---\n\n");

    const toneHint = {
      friendly: "Warm, conversational, professional. Match the tone the other party is using if they're casual; lean slightly warmer than the original if they're cold.",
      formal: "Formal, professional. No contractions. Address the recipient with their honorific if visible in the thread.",
      concise: "Short and direct. 2–4 sentences. No filler, no preamble."
    }[tone];

    const meInstruction = instruction
      ? `\n\nThe user asked for this reply to specifically:\n"""${instruction}"""\n\nFollow that instruction. If it contradicts other guidance, the user's instruction wins.`
      : "";

    const system = [
      "You are drafting a reply email on behalf of the user.",
      whoIAm ? `The user's email address on this thread is ${whoIAm}.` : "",
      `Tone guidance: ${toneHint}`,
      "Output rules:",
      "- Plain text only — no Markdown, no HTML, no preamble like 'Sure! Here is your reply:'.",
      "- Start with the greeting line. End with a sign-off if it fits the tone (skip if the conversation is mid-thread informal).",
      "- Don't include the subject line, To:, From:, or any email-header text.",
      "- Don't invent details that aren't in the thread. If something needs to be confirmed by the user, leave a clear placeholder in [square brackets] for them to fill in.",
      "- Don't apologize for being an AI or mention that you're an assistant."
    ].filter(Boolean).join("\n");

    const userMessage = [
      "Here's the recent thread, oldest first:",
      "",
      transcript,
      "",
      "Draft a reply from the user (the SENT side) responding to the most recent received message." + meInstruction
    ].join("\n");

    const client = await getAnthropic();
    const res = await client.messages.create({
      model: MODELS.classify, // Haiku — fast + cheap, plenty good for short drafts
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: userMessage }]
    });

    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      return NextResponse.json({ error: "empty draft from model" }, { status: 502 });
    }

    return NextResponse.json({ bodyText: text });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// Crude HTML → text for message bodies that only have body_html. Good
// enough for an AI prompt — we don't need fidelity, just legibility.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
