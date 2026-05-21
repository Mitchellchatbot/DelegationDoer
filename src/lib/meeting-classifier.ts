import { getAnthropic, MODELS } from "./anthropic-client";
import type { TldvTranscriptSegment } from "./tldv-client";

// One action item extracted from a meeting transcript. Same shape as
// ClassifiedEmail in email-classifier.ts, so the routing pipeline
// treats each one identically to an inbound email.
export interface MeetingActionItem {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
  departmentHint: string | null;
}

// Top-level classifier result. `summary` is the one-paragraph meeting
// summary we stamp on each spawned task so the assignee has context
// without having to read the full transcript. `actionItems` is the
// fan-out list — one task per item.
export interface ClassifiedMeeting {
  summary: string;
  actionItems: MeetingActionItem[];
}

interface DepartmentLite { id: string; name: string; description: string; taskTypes: string[]; }

// Read a tl;dv transcript, extract a meeting summary plus a list of
// concrete action items. Robust JSON parse — falls back to empty
// actionItems on AI errors (intake pipeline treats that as "nothing
// to do" rather than crashing).
export async function classifyMeetingTranscript(args: {
  transcript: string;
  segments: TldvTranscriptSegment[];
  departments: DepartmentLite[];
}): Promise<ClassifiedMeeting> {
  const { transcript, segments, departments } = args;

  const deptList = departments.map((d) =>
    `- ${d.name} (id: "${d.id}"): ${d.description}; covers ${d.taskTypes.join(", ")}`
  ).join("\n");

  // Prefer the segment-joined text when present — it's the cleanest
  // form. Include speaker attribution when available so the classifier
  // can tell "Sarah asked Tom to do X" apart from "Tom will do X".
  // Fall back to the flat `transcript` string if segments are empty.
  const fullText = segments.length > 0
    ? segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n")
    : transcript;

  const systemPrompt = `You convert meeting transcripts into ACTIONABLE task drafts at a digital agency. The team uses these tasks to delegate work that came out of the meeting. The person assigned should be able to read a task and know exactly what to do without watching the recording.

Departments:
${deptList || "(none configured)"}

Return STRICT JSON in exactly this shape — no preamble, no code fences:
{
  "summary": "<2-4 sentence summary of what the meeting was about + key decisions>",
  "actionItems": [
    {
      "title": "<short, action-y task title; starts with a verb; <70 chars>",
      "description": "<Markdown-formatted description, see rubric below>",
      "priority": "<low | medium | high | critical>",
      "tags": ["<short topic/skill keywords>"],
      "departmentHint": "<one of the dept ids above, or null if unclear>"
    }
  ]
}

ACTION ITEM EXTRACTION RULES:
- Only emit an action item if the meeting clearly commits someone (or "we") to a concrete deliverable. "We should probably look at X someday" is NOT an action item.
- Don't invent action items just to have a list. An empty array is a valid answer if nothing concrete was decided.
- Cap at 10 items per meeting — pick the most material ones if there are more.
- Combine duplicates. If the same action appears in multiple parts of the transcript, emit ONE task.
- Attendee names ARE useful as context in the description (e.g. "Sarah flagged this in standup", "Per Tom's note about the staging server…"). Keep them when they help the eventual assignee understand background or pick up nuance.
- Routing is automatic — DON'T phrase titles as assignment instructions ("Sarah: update the staging server"). Keep titles in imperative third-person ("Update the staging server config"). Whoever was named in the meeting can still appear in the description as background.

Title rubric:
- Starts with a verb: "Fix", "Build", "Send", "Review", "Update", "Draft".
- NOT "Discussion about X" — that's a description of the meeting, not the task.

Description rubric (this is the part that matters most):
Write Markdown with EXACTLY these sections, in order. Skip sections that have no real content; never invent content.

**Do:** <one-sentence imperative of the concrete deliverable.>

**Context:**
- <3-6 bullets pulled from the meeting: relevant background, constraints, deadlines mentioned, prior decisions, links/file names that came up>
- <attribute when it adds context: "Sarah noted the API rate limit is 100/min" beats "the API rate limit is 100/min" if it helps the assignee know who to ask follow-ups>
- <quote short phrases (≤8 words) when wording matters; don't quote whole paragraphs>

**Mentioned deadline:** <if the transcript explicitly states one, quote it; "no deadline mentioned" otherwise>

Rules:
- NEVER paste raw transcript chunks. Summarize.
- NEVER write "In the meeting they discussed …" as filler. Just describe the work.
- If URLs or file names were mentioned, list them as a "Links:" bullet under Context.

Priority rubric:
- "critical" = explicit emergency (site down, broken billing, legal threat).
- "high" = same-day need or paying client blocked.
- "medium" = normal client work.
- "low" = FYI / nice-to-have.

Tags are 1-4 short lowercase words (e.g. "wordpress", "billing", "design"). They feed our auto-delegation engine.`;

  let parsed: Partial<ClassifiedMeeting> = {};
  try {
    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: fullText.slice(0, 30000)  // generous bound for a long meeting
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

  const validPriorities = new Set(["low", "medium", "high", "critical"] as const);

  const actionItems: MeetingActionItem[] = Array.isArray(parsed.actionItems)
    ? parsed.actionItems
        .map((raw): MeetingActionItem | null => {
          if (!raw || typeof raw !== "object") return null;
          const item = raw as Partial<MeetingActionItem>;
          const title = typeof item.title === "string" ? item.title.trim().slice(0, 120) : "";
          if (!title) return null;
          const description = typeof item.description === "string"
            ? item.description.trim().slice(0, 4000)
            : "";
          const priority: MeetingActionItem["priority"] =
            typeof item.priority === "string" && validPriorities.has(item.priority as never)
              ? (item.priority as MeetingActionItem["priority"])
              : "medium";
          const tags = Array.isArray(item.tags)
            ? item.tags
                .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
                .filter((t) => t.length > 0 && t.length <= 32)
                .slice(0, 6)
            : [];
          const departmentHint =
            typeof item.departmentHint === "string" &&
            departments.some((d) => d.id === item.departmentHint)
              ? item.departmentHint
              : null;
          return { title, description, priority, tags, departmentHint };
        })
        .filter((x): x is MeetingActionItem => x !== null)
        .slice(0, 10)
    : [];

  const summary = typeof parsed.summary === "string"
    ? parsed.summary.trim().slice(0, 1000)
    : "";

  return { summary, actionItems };
}
