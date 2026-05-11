import { getAnthropic, MODELS } from "./anthropic-client";

// What the email-intake pipeline gets back from Claude after reading a
// thread. Drives the task title/description/priority + which routing
// signals to feed into the matcher.
export interface ClassifiedEmail {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  // Free-form skill/topic tags Claude pulls out of the email body —
  // matched against routing rules + user_skills tags.
  tags: string[];
  // Optional dept hint; falls back to the dept-routing endpoint if the
  // matcher + ranker both come up empty.
  departmentHint: string | null;
}

interface DepartmentLite { id: string; name: string; description: string; taskTypes: string[]; }

// Read an inbound email thread, extract everything we'd otherwise have
// the user type into the new-task popdown. Robust JSON parse — falls
// back to a sensible shape on AI errors.
export async function classifyEmailThread(args: {
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  departments: DepartmentLite[];
}): Promise<ClassifiedEmail> {
  const { subject, bodyText, fromEmail, departments } = args;

  const deptList = departments.map((d) =>
    `- ${d.name} (id: "${d.id}"): ${d.description}; covers ${d.taskTypes.join(", ")}`
  ).join("\n");

  const systemPrompt = `You convert inbound emails into structured task drafts at a digital agency.

Departments:
${deptList || "(none configured)"}

Return STRICT JSON in exactly this shape — no preamble, no code fences:
{
  "title": "<short, action-y task title; <70 chars>",
  "description": "<2-4 sentence summary of what the requester needs>",
  "priority": "<low | medium | high | critical>",
  "tags": ["<short topic/skill keywords>"],
  "departmentHint": "<one of the dept ids above, or null if unclear>"
}

Priority rubric:
- "critical" = explicit emergency (site down, broken billing, legal threat)
- "high" = same-day need or paying client blocked
- "medium" = normal client work
- "low" = FYI / nice-to-have

Tags are 1-4 short lowercase words (e.g. "wordpress", "billing", "design"). They feed our auto-delegation engine.`;

  let parsed: Partial<ClassifiedEmail> = {};
  try {
    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          fromEmail ? `From: ${fromEmail}` : "",
          `Subject: ${subject}`,
          "",
          // Truncate to a generous but bounded slice so a 200-msg
          // thread doesn't blow the context window.
          bodyText.slice(0, 6000)
        ].filter(Boolean).join("\n")
      }]
    });
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch {
    /* fall through to defaults */
  }

  // Validate + coerce. Anything Claude returns that's not in-shape gets
  // replaced with a sane default so downstream code doesn't have to
  // null-check every field.
  const validPriorities = new Set(["low", "medium", "high", "critical"] as const);
  const priority: ClassifiedEmail["priority"] =
    typeof parsed.priority === "string" && validPriorities.has(parsed.priority as never)
      ? (parsed.priority as ClassifiedEmail["priority"])
      : "medium";

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter((t) => t.length > 0 && t.length <= 32)
        .slice(0, 6)
    : [];

  const departmentHint =
    typeof parsed.departmentHint === "string" &&
    departments.some((d) => d.id === parsed.departmentHint)
      ? parsed.departmentHint
      : null;

  return {
    title:
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 120)
        : subject.slice(0, 120) || "Email task",
    description:
      typeof parsed.description === "string"
        ? parsed.description.trim().slice(0, 1200)
        : `From: ${fromEmail ?? "unknown"}\n\n${bodyText.slice(0, 800)}`,
    priority,
    tags,
    departmentHint
  };
}
