import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { departments } from "@/lib/mock-data";

const SYSTEM_PROMPT = `You classify support / project tickets into ONE of these departments at a digital agency:

${departments.map((d) =>
  `- ${d.name} (id: "${d.id}"): ${d.description}\n  Owns: ${d.taskTypes.join(", ")}`
).join("\n")}

Return STRICT JSON in exactly this shape — no preamble, no code fences:
{"departmentId": "<one of the ids above>", "reason": "<one sentence, plain English>"}

If the title is genuinely ambiguous, pick the closest fit and say so in the reason.`;

export async function POST(req: NextRequest) {
  try {
    const { title, description } = await req.json();

    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Title: ${title ?? ""}\nDescription: ${description ?? ""}`
      }]
    });

    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");

    // Robust parse: extract first {...} block in case Claude added stray prose.
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: { departmentId?: string; reason?: string } = {};
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
    }

    const valid = departments.some((d) => d.id === parsed.departmentId);
    if (!valid) {
      return NextResponse.json({
        departmentId: departments[0].id,
        reason: parsed.reason || "Couldn't classify confidently — defaulted to first department."
      });
    }

    return NextResponse.json({
      departmentId: parsed.departmentId,
      reason: parsed.reason || "Classified by AI."
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
