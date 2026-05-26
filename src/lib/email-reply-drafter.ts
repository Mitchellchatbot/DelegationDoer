import { getAnthropic, MODELS } from "./anthropic-client";

// Claude-drafted acknowledgement reply for an inbound email. Used by
// the auto-intake pipeline so every email that becomes a task also
// gets a queued reply ready for human review in /approvals.
//
// Tone: polite, professional, brief. Acknowledges receipt, references
// what the sender asked for, sets a realistic expectation. NEVER
// commits to a specific deadline or makes promises beyond "we're on
// it" — the human approver can sharpen those details before sending.

export interface DraftedReply {
  subject: string;
  bodyText: string;
}

export interface DraftReplyInput {
  inboundSubject: string;
  inboundBodyText: string;
  // Best-effort context — improves the reply quality, but the
  // function still works when these are unknown.
  senderName?: string | null;
  senderEmail?: string | null;
  // Who will receive the task; the reply is signed with their name
  // (or a generic team line when we don't have one yet).
  assigneeName?: string | null;
  // Client this email is associated with, if known. Shapes the
  // reply's wording — "we'll get your team a turnaround" etc.
  clientName?: string | null;
}

export async function draftReplyForEmailThread(
  args: DraftReplyInput
): Promise<DraftedReply | null> {
  const {
    inboundSubject, inboundBodyText,
    senderName, assigneeName, clientName
  } = args;

  const signOff = assigneeName ?? "The team";
  // Subject: prefix Re: if not already there.
  const subjectBase = inboundSubject?.trim() || "your email";
  const replySubject = /^re:\s/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`;

  const systemPrompt = `You write polite, professional acknowledgement replies to inbound client emails for a digital agency. The reply will be QUEUED FOR HUMAN APPROVAL — a teammate will review and edit before it sends. Keep it short, warm, and grounded.

Output STRICT JSON with no preamble, no code fences:
{
  "bodyText": "<plain-text email reply>"
}

Tone & rules:
- 3 short paragraphs max. No headers, no bullet lists, no emojis.
- Open with a friendly acknowledgement ("Hi [Name], thanks for the note,").
- Reference 1-2 specific things from the email so it doesn't read like a template.
- Set expectation gently: "We'll take a look and get back to you" or "I'll loop in [team] and circle back". DO NOT promise specific timelines or deliverables.
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, or parentheses instead.
- Sign off "Best," then a newline, then "${signOff}".
- If the inbound is hostile / complaint, the reply should be especially measured and apologetic without admitting fault.`;

  const userParts: string[] = [];
  userParts.push(`Inbound email subject: ${inboundSubject || "(no subject)"}`);
  if (senderName) userParts.push(`From (name): ${senderName}`);
  if (clientName) userParts.push(`Client account: ${clientName}`);
  if (assigneeName) userParts.push(`Will be handled by: ${assigneeName}`);
  userParts.push("");
  userParts.push("Inbound email body:");
  userParts.push("---");
  userParts.push(inboundBodyText.slice(0, 4000));
  userParts.push("---");
  userParts.push("");
  userParts.push("Now draft the reply as JSON per the system prompt.");

  try {
    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.classify, // Haiku — cheap + good enough for short acks
      max_tokens: 600,
      temperature: 0.45,
      system: systemPrompt,
      messages: [{ role: "user", content: userParts.join("\n") }]
    });

    const block = result.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text.trim() : "";

    let parsed: { bodyText?: unknown } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
      }
    }

    const body = typeof parsed.bodyText === "string" ? parsed.bodyText.trim() : "";
    if (!body) return null;

    // Belt-and-suspenders dash scrub. The prompt forbids them but
    // models occasionally slip, and we explicitly don't want them.
    const scrubbed = body
      .replace(/\s+—\s+/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/—/g, ",")
      .replace(/–/g, ",");

    return { subject: replySubject, bodyText: scrubbed };
  } catch {
    return null;
  }
}
