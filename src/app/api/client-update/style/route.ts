import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { renderBlueEmail, type BrandedSection } from "@/lib/email-template";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/client-update/style
//   body: {
//     mode: 'rephrase' | 'structured' | 'casual' | 'glanceable' | 'fancy' | 'plain' | 'custom',
//     bodyText: string,           // current plain-text body (source of truth)
//     hasHtml?: boolean,          // is the draft currently styled (fancy)?
//     instruction?: string,       // free-text edit, used when mode='custom'
//     clientName?: string,        // brand name for the fancy template header
//     senderName?: string,        // sign-off name (fallback)
//     subject?: string
//   }
//
// AI "editor" for a single client-update draft body. Returns
//   { bodyText, bodyHtml }
// where bodyHtml is a brand-styled (blue) HTML email when the draft is
// (or is being made) "fancy", and null otherwise. The HTML is rendered
// from a fixed, email-safe template (lib/email-template) filled with the
// model's CONTENT — the model never emits raw HTML, which keeps every
// styled email on-brand and well-formed.
//
// Mirrors the sibling AI endpoints: same auth + robust-JSON-parse +
// em-dash scrub. Never persists; the composer holds the result in state.

type Mode = "rephrase" | "structured" | "casual" | "glanceable" | "fancy" | "plain" | "custom";

interface Body {
  mode?: unknown;
  bodyText?: unknown;
  hasHtml?: unknown;
  instruction?: unknown;
  clientName?: unknown; // the client we're writing TO (greeting context)
  senderBrand?: unknown; // the agency/mailbox the email is sent FROM (header + footer brand)
  senderName?: unknown; // the human signing off
  subject?: unknown;
}

interface ModelHtml {
  greeting?: unknown;
  intro?: unknown;
  tagline?: unknown;
  sections?: unknown;
  signoff?: unknown;
}

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  rephrase:
    "Rewrite the body so it reads more clearly and naturally. Keep every fact, section, and detail; only improve the wording.",
  structured:
    "Reorganize the body into clear, labeled sections (for example: Completed work, In progress, Next steps) with a short one-line summary at the top. Use only the sections that have real content.",
  casual:
    "Rewrite the body in a warm, friendly, conversational tone while staying professional and concise. Keep all the facts.",
  glanceable:
    "Make the body skimmable: a single one-line summary, then tight bullet points. Cut filler. Keep all the substance.",
  fancy:
    "Keep the wording essentially as-is, but split it into a greeting, a short intro line, and clearly labeled sections so it can be laid out as a polished email.",
  plain:
    "Rewrite as clean plain text: short paragraphs, no markdown, no symbols or decoration. Keep all the content.",
  custom: "" // filled from instruction
};

// Belt-and-suspenders dash scrub (mirrors the sibling drafters).
const scrub = (s: string) =>
  s
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/—/g, ",")
    .replace(/–/g, ",");

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function POST(req: NextRequest) {
  try {
    await requireCurrentUserId();

    const body = (await req.json().catch(() => ({}))) as Body;
    const mode = (typeof body.mode === "string" ? body.mode : "rephrase") as Mode;
    const validModes: Mode[] = ["rephrase", "structured", "casual", "glanceable", "fancy", "plain", "custom"];
    if (!validModes.includes(mode)) {
      return NextResponse.json({ error: "invalid mode" }, { status: 400 });
    }
    const bodyText = asString(body.bodyText).trim();
    if (!bodyText) {
      return NextResponse.json({ error: "bodyText required" }, { status: 400 });
    }
    const instruction = asString(body.instruction).trim();
    if (mode === "custom" && !instruction) {
      return NextResponse.json({ error: "instruction required for custom mode" }, { status: 400 });
    }
    const clientName = asString(body.clientName).trim() || "your team";
    // The styled email is sent FROM the agency TO the client, so the
    // header band + footer must carry the SENDER's brand, never the
    // client's. Falls back to a neutral agency label if not provided.
    const senderBrand = asString(body.senderBrand).trim() || "Scaled";
    const senderName = asString(body.senderName).trim();

    // Styled HTML is produced when the user asks to "make fancy", or when
    // the draft is ALREADY fancy and they're applying another edit that
    // should preserve the styling (anything except an explicit strip).
    const hasHtml = body.hasHtml === true;
    const needHtml = mode === "fancy" || (mode !== "plain" && hasHtml);

    const instr = mode === "custom" ? instruction : MODE_INSTRUCTIONS[mode];

    const system = `You are an editor for client-facing progress-update emails at a digital agency. You revise an existing draft; you never invent facts, metrics, or deliverables that are not already in the text.

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, parentheses, or colons.
- Keep the meaning and all concrete details of the input. Do not add new claims.
- Professional, first-person plural ("we"). No markdown, no asterisks.
- Keep it client-appropriate: no internal jargon, ticket IDs, tags, or teammate names.`;

    const htmlSchemaNote = needHtml
      ? `\n\nAlso return a "html" object that lays the SAME content out for a styled email:
{
  "greeting": "<e.g. 'Hi Emilie,' — derive from the contact if present, else 'Hi there,'>",
  "intro": "<one short opening line>",
  "sections": [ { "heading": "<short label>", "body": "<paragraph text>", "bullets": ["<optional>", "..."] } ],
  "signoff": "<e.g. 'Best,\\n${senderName || "the team"}'>"
}
The html object must contain the same information as bodyText, just split into parts. Omit a field if there is nothing for it.`
      : "";

    const userPrompt = `Context: this is a client progress update written by ${senderBrand} (a digital agency) and sent to ${clientName}. Address the client warmly; speak as "we".

Task: ${instr}

${needHtml ? "" : "Keep it as plain text. "}Return STRICT JSON, no code fences:
{ "bodyText": "<the revised plain-text body>"${needHtml ? ', "html": { ... }' : ""} }${htmlSchemaNote}

Current email body to revise:
"""
${bodyText.slice(0, 8000)}
"""`;

    const anthropic = await getAnthropic();
    const result = await anthropic.messages.create({
      model: MODELS.chat,
      max_tokens: 2000,
      temperature: 0.4,
      system,
      messages: [{ role: "user", content: userPrompt }]
    });

    const blk = result.content.find((b) => b.type === "text");
    const rawText = blk && blk.type === "text" ? blk.text.trim() : "";
    let parsed: { bodyText?: unknown; html?: ModelHtml } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          /* swallow */
        }
      }
    }

    const newBodyText = scrub(asString(parsed.bodyText).trim() || bodyText);

    let bodyHtml: string | null = null;
    if (needHtml) {
      const h = parsed.html ?? {};
      const rawSections = Array.isArray(h.sections) ? h.sections : [];
      const sections: BrandedSection[] = rawSections
        .map((s): BrandedSection => {
          const sec = (s ?? {}) as { heading?: unknown; body?: unknown; bullets?: unknown };
          return {
            heading: scrub(asString(sec.heading).trim()) || null,
            body: scrub(asString(sec.body).trim()) || null,
            bullets: Array.isArray(sec.bullets)
              ? sec.bullets.map((b) => scrub(asString(b).trim())).filter(Boolean)
              : []
          };
        })
        .filter((s) => s.heading || s.body || (s.bullets && s.bullets.length));

      // If the model didn't give a usable structure, fall back to dropping
      // the whole plain-text body into a single section so "fancy" still
      // produces something on-brand rather than an empty shell.
      const safeSections: BrandedSection[] =
        sections.length > 0 ? sections : [{ body: newBodyText }];

      bodyHtml = renderBlueEmail({
        brandName: senderBrand,
        greeting: scrub(asString(h.greeting).trim()) || null,
        intro: scrub(asString(h.intro).trim()) || null,
        tagline: scrub(asString(h.tagline).trim()) || null,
        sections: safeSections,
        signoff:
          scrub(asString(h.signoff).trim()) ||
          (senderName ? `Best,\n${senderName}` : null)
      });
    }

    return NextResponse.json({ bodyText: newBodyText, bodyHtml });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
