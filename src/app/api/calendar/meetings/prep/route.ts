import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import {
  gatherMeetingContext,
  type MeetingPrepBundle,
  type MeetingPrepBrief
} from "@/lib/meeting-prep";

export const dynamic = "force-dynamic";
// The email source can be several missiveclone round-trips and we then make
// a Sonnet synthesis call — give it headroom past the draft routes' 30s.
export const maxDuration = 60;

// POST /api/calendar/meetings/prep
//   body: { clientId: string; meetingId?: string; meetingTitle?: string; meetingStartISO?: string }
//
// Generates a pre-meeting brief for one client by aggregating recent tasks,
// prior meeting briefs, EOD updates, and emails (gatherMeetingContext) and
// synthesizing them into five scannable sections. Never persists — the
// Schedule "Meeting prep" panel calls this on demand so the brief always
// reflects the latest state. Scoping is inherited from the reused Ask-AI
// handlers, so a worker only ever sees what they're allowed to.

interface Body {
  clientId?: string;
  meetingId?: string;
  meetingTitle?: string;
  meetingStartISO?: string;
}

const SYSTEM_PROMPT = `You are a meeting-prep assistant for a digital agency. The user is about to walk into a meeting with a client and wants a brief they can skim in 30 seconds.

You are given five labeled sources for ONE client: recently-completed tasks, currently-open tasks, prior meeting briefs, recent end-of-day client updates filed by the team, and recent email threads. Some sources may be empty or marked unavailable — never invent content to fill a section.

Produce exactly these five arrays of short, plain-text bullet strings:
- "completedSinceLastMeeting": concrete work shipped or closed since the last meeting. Lead with client-visible outcomes, not internal task jargon. (The data is "recently completed" — don't assert exact completion dates.)
- "openItems": work in flight the client will care about. Note anything overdue or blocked.
- "risksAndBlockers": things that could derail the work or the relationship — stalled tasks, items waiting on the client, negative email sentiment, prior-meeting risks not yet resolved.
- "clientRequests": specific things the client asked for (from meeting briefs' client requests, emails, or EOD updates). Each should be actionable.
- "suggestedDiscussionPoints": 3-6 things the user should proactively raise. Synthesize across sources: unresolved prior action items, asks awaiting a reply, natural next steps. This is the one section where you reason rather than extract.

RULES:
- Each bullet is a short plain-text string with no leading "-" or markdown.
- <= 6 bullets per section; merge duplicates across sources.
- Ground every bullet in the provided data. If a section has nothing, return an empty array — do not pad.
- Never use em dashes or en dashes; use commas, periods, or parentheses.
- "headline" is one sentence (<= 120 chars) framing the state of play before this meeting.

Return STRICT JSON, no code fences:
{ "headline": "<string>", "completedSinceLastMeeting": [], "openItems": [], "risksAndBlockers": [], "clientRequests": [], "suggestedDiscussionPoints": [] }`;

// House style: the brief is plain text, no dashes (mirrors the EOD/client
// draft routes).
const scrub = (s: string): string =>
  s
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/—/g, ",")
    .replace(/–/g, ",")
    .trim();

// Serialize the bundle into a labeled, capped digest so a long history can't
// blow the context window. Each source is bounded; the whole prompt is then
// hard-capped as a backstop.
function buildUserPrompt(b: MeetingPrepBundle, meeting?: { title?: string; startISO?: string }): string {
  const lines: string[] = [];
  if (meeting?.title || meeting?.startISO) {
    lines.push(
      `Upcoming meeting: ${meeting.title ?? "(untitled)"}${meeting.startISO ? ` at ${meeting.startISO}` : ""}`
    );
  }
  lines.push(`Client: ${b.clientName}`);
  lines.push(
    b.lastMeetingDate
      ? `Last meeting on record: ${b.lastMeetingDate.slice(0, 10)} (covering roughly the last ${b.sinceDays} days)`
      : `No prior meeting on record (covering roughly the last ${b.sinceDays} days)`
  );
  lines.push("");

  lines.push("## Recently completed tasks");
  if (b.completedTasks.length === 0) lines.push("(none)");
  else
    for (const t of b.completedTasks.slice(0, 25)) {
      const meta = [t.priority, t.completedBy ? `by ${t.completedBy}` : null].filter(Boolean).join(", ");
      const desc = t.description ? ` — ${t.description.slice(0, 120)}` : "";
      lines.push(`- ${t.title}${meta ? ` (${meta})` : ""}${desc}`);
    }
  lines.push("");

  lines.push("## Currently-open tasks");
  if (b.openTasks.length === 0) lines.push("(none)");
  else
    for (const t of b.openTasks.slice(0, 25)) {
      const bits = [
        t.status,
        t.priority,
        t.dueDate ? `due ${t.dueDate.slice(0, 10)}` : "no due date",
        t.blocks > 0 ? `blocks ${t.blocks} task(s)` : null
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`- ${t.title} (${bits})`);
    }
  lines.push("");

  lines.push("## Prior meeting briefs (newest first)");
  if (b.meetings.length === 0) lines.push("(none)");
  else
    for (const m of b.meetings.slice(0, 4)) {
      lines.push(`### ${m.title || "Meeting"} — ${m.meetingDate ? m.meetingDate.slice(0, 10) : ""}`);
      if (m.summary) lines.push(m.summary.slice(0, 300));
      const sec = (label: string, arr: string[]) => {
        if (arr.length) lines.push(`${label}: ${arr.slice(0, 6).join("; ")}`);
      };
      sec("Key decisions", m.brief.keyDecisions);
      sec("Action items", m.brief.actionItems);
      sec("Client requests", m.brief.clientRequests);
      sec("Risks", m.brief.risks);
      sec("Next steps", m.brief.nextSteps);
    }
  lines.push("");

  lines.push("## Recent EOD client updates from the team");
  if (b.eodUpdates.length === 0) lines.push("(none)");
  else
    for (const u of b.eodUpdates.slice(0, 15)) {
      const who = u.filedBy ? `, ${u.filedBy}` : "";
      lines.push(`- (${u.noteDate ? u.noteDate.slice(0, 10) : ""}${who}) ${u.message.slice(0, 200)}`);
    }
  lines.push("");

  lines.push("## Recent email threads");
  if (!b.emails.accessible) {
    lines.push(`Email history: unavailable (${b.emails.note ?? "no access"})`);
  } else if (b.emails.threads.length === 0) {
    lines.push(b.emails.note ? `(none — ${b.emails.note})` : "(none)");
  } else {
    for (const t of b.emails.threads.slice(0, 8)) {
      const sat = t.satisfactionScore != null ? `, sentiment ${t.satisfactionScore}` : "";
      lines.push(`- "${t.subject}" [${t.latestDirection || "?"}${sat}] ${t.latestSnippet.slice(0, 300)}`);
    }
  }
  lines.push("");
  lines.push("Empty or unavailable sources are intentional — do not invent content for them.");

  const out = lines.join("\n");
  return out.length > 24_000 ? out.slice(0, 24_000) + "\n…(truncated)" : out;
}

// Defensive parse + coerce, mirroring coerceMeetingBrief: a malformed model
// reply degrades to empty sections rather than throwing, so the route still
// returns 200 with the source counts intact.
function coerceBrief(raw: string, bundle: MeetingPrepBundle): MeetingPrepBrief {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* swallow — fall through to empty sections */
      }
    }
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string").map(scrub).filter(Boolean).slice(0, 6)
      : [];
  return {
    headline: scrub(typeof parsed.headline === "string" ? parsed.headline : ""),
    completedSinceLastMeeting: arr(parsed.completedSinceLastMeeting),
    openItems: arr(parsed.openItems),
    risksAndBlockers: arr(parsed.risksAndBlockers),
    clientRequests: arr(parsed.clientRequests),
    suggestedDiscussionPoints: arr(parsed.suggestedDiscussionPoints),
    sources: bundle.sourceCounts,
    warnings: bundle.warnings
  };
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const actor = await getUserById(userId);
    if (!actor) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Body;
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });

    const bundle = await gatherMeetingContext({ clientId, actor });
    if (!bundle.clientName) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }

    const sc = bundle.sourceCounts;
    const total =
      sc.completedTasks + sc.openTasks + sc.meetings + sc.eodUpdates + sc.emailThreads;

    // Nothing to synthesize — skip the LLM spend and return a friendly empty
    // brief so the panel can show "nothing notable yet".
    if (total === 0) {
      const empty: MeetingPrepBrief = {
        headline: `Not much history yet for ${bundle.clientName}.`,
        completedSinceLastMeeting: [],
        openItems: [],
        risksAndBlockers: [],
        clientRequests: [],
        suggestedDiscussionPoints: [],
        sources: sc,
        warnings: bundle.warnings
      };
      return NextResponse.json(empty);
    }

    const anthropic = await getAnthropic();
    const result = await anthropic.messages.create({
      model: MODELS.chat, // Sonnet — synthesis across 5 sources, once per click
      max_tokens: 1500,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(bundle, {
            title: body.meetingTitle,
            startISO: body.meetingStartISO
          })
        }
      ]
    });

    const block = result.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text.trim() : "";
    return NextResponse.json(coerceBrief(raw, bundle));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
