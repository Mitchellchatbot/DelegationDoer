import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight, getAllTasks, getDepartments } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { userCapacity } from "@/lib/capacity";
import { rankCandidates, buildLoadSignals } from "@/lib/skill-rank";
import { getAnthropic, resetAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/ai/voice-tasks
//   Body: { transcript: string }
//   Turns a spoken brain-dump (already transcribed by /api/transcribe, or
//   typed) into one or more structured, delegatable task drafts. Each draft
//   is enriched with the top-3 suggested assignees from the same skill/
//   capacity ranker used by the new-task form and the AI `propose_task`
//   tool — so "who should own this" is answered the same way everywhere.
//
//   NOTHING is created here. The client renders the drafts for the founder
//   to edit/approve, then POSTs the approved ones to /api/tasks. This route
//   is read-only + Claude; the write path stays the audited /api/tasks one.

const PRIORITIES = ["low", "medium", "high", "critical"] as const;
type Priority = (typeof PRIORITIES)[number];

// Anthropic tool the model is forced to call. The schema IS the contract —
// every field the review UI needs comes back typed.
const EMIT_TASKS_TOOL = {
  name: "emit_tasks",
  description:
    "Return the structured, delegatable tasks extracted from the spoken brief. " +
    "Split distinct pieces of work into separate tasks; keep genuinely one job as one task.",
  input_schema: {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        description: "One entry per distinct task. Empty array if the brief contains no actionable work.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Imperative, specific title (≤ 100 chars). e.g. 'Redesign the ACME pricing page hero'."
            },
            description: {
              type: "string",
              description:
                "1–4 sentences expanding the terse spoken instruction into clear, actionable detail: what to do and what 'done' looks like. Never just repeat the title."
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
              description: "Infer from urgency cues in speech ('asap', 'urgent', 'whenever'). Default 'medium'."
            },
            clientName: {
              type: "string",
              description: "The client/account this is for, if named. Empty string if none mentioned."
            },
            dueDate: {
              type: "string",
              description:
                "ISO date (YYYY-MM-DD) if a deadline or timeframe is stated or clearly implied. Resolve relative dates ('by Friday', 'end of week', 'tomorrow') against the current date given in the system prompt. Empty string if no deadline."
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "1–5 short lowercase skill/topic tags to aid routing, e.g. 'design', 'seo', 'copywriting', 'dev'."
            }
          },
          required: ["title", "description", "priority", "tags"]
        }
      }
    },
    required: ["tasks"]
  }
};

interface RawTask {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  clientName?: unknown;
  dueDate?: unknown;
  tags?: unknown;
}

function cleanStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(
    new Set(
      v
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    )
  ).slice(0, 5);
}
// Accept only a clean YYYY-MM-DD; drop anything else (the model is told to
// emit ISO or "", but be defensive so a stray phrase never reaches the DB).
function cleanDueDate(v: unknown): string | null {
  const s = cleanStr(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const actor = await getUserById(userId);
    if (!actor) {
      return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const transcript = cleanStr(body?.transcript);
    if (!transcript) {
      return NextResponse.json({ error: "transcript required" }, { status: 400 });
    }
    if (transcript.length > 8000) {
      return NextResponse.json({ error: "transcript too long" }, { status: 400 });
    }

    // Ask Claude to decompose the brief into structured tasks. Forced tool
    // call → we always get the typed shape back, no prose parsing.
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const dow = today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

    const system =
      "You convert a founder's spoken brain-dump into clean, delegatable tasks for a digital agency's task board.\n" +
      `Today is ${dow}, ${isoToday} (UTC). Resolve any relative dates against it.\n` +
      "Rules:\n" +
      "- Split distinct pieces of work into separate tasks; keep one genuine job as one task. Most short briefs are a single task.\n" +
      "- Expand terse speech into clear, actionable descriptions — a teammate should be able to act on it without asking follow-ups.\n" +
      "- Never invent clients, deadlines, or people that weren't spoken. Leave clientName/dueDate empty when unsure.\n" +
      "- Do not assign anyone — assignment is handled separately.\n" +
      "Always respond by calling the emit_tasks tool.";

    type AnyContent = { type: string; name?: string; input?: Record<string, unknown> };
    async function callClaude(): Promise<{ content?: AnyContent[] }> {
      const client = await getAnthropic();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return client.messages.create({
        model: MODELS.chat,
        max_tokens: 2000,
        system,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [EMIT_TASKS_TOOL] as any,
        tool_choice: { type: "tool", name: "emit_tasks" },
        messages: [{ role: "user", content: transcript }]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    }

    let message: { content?: AnyContent[] };
    try {
      message = await callClaude();
    } catch (err) {
      // Heal a stale/rotated key once (mirrors other AI surfaces), then retry.
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        resetAnthropic();
        message = await callClaude();
      } else {
        throw err;
      }
    }

    const toolUse = (message.content ?? []).find(
      (b) => b.type === "tool_use" && b.name === "emit_tasks"
    );
    const rawTasks: RawTask[] = Array.isArray((toolUse?.input as { tasks?: unknown })?.tasks)
      ? ((toolUse!.input as { tasks: RawTask[] }).tasks)
      : [];

    const parsed = rawTasks
      .map((t) => {
        const title = cleanStr(t.title);
        if (!title) return null;
        const p = cleanStr(t.priority).toLowerCase();
        const priority: Priority = (PRIORITIES as readonly string[]).includes(p)
          ? (p as Priority)
          : "medium";
        return {
          title: title.slice(0, 140),
          description: cleanStr(t.description),
          priority,
          clientName: cleanStr(t.clientName) || null,
          dueDate: cleanDueDate(t.dueDate),
          tags: cleanTags(t.tags)
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .slice(0, 12);

    if (parsed.length === 0) {
      return NextResponse.json({
        drafts: [],
        people: [],
        departments: [],
        note: "No actionable tasks were found in that recording."
      });
    }

    // ---- Enrich each draft with ranked assignee suggestions ----------
    // Same data-gathering as the propose_task tool: users + tasks + skills
    // in parallel, then rank per draft (client-history factor differs per
    // draft, so load signals are rebuilt per client).
    const supabase = getSupabaseAdmin();
    const [users, allTasks, skillRowsRes, departments] = await Promise.all([
      getAllUsersLight(),
      getAllTasks(),
      supabase.from("user_skills").select("user_id, tag, manual_level, auto_score"),
      getDepartments()
    ]);

    type SkillRow = { user_id: string; tag: string; manual_level: number | string; auto_score: number | string };
    const skillsByUser = new Map<string, { userId: string; tag: string; combinedScore: number }[]>();
    for (const r of (skillRowsRes.data ?? []) as SkillRow[]) {
      const arr = skillsByUser.get(r.user_id) ?? [];
      arr.push({
        userId: r.user_id,
        tag: r.tag,
        combinedScore: Number(r.manual_level) * 6 + Number(r.auto_score)
      });
      skillsByUser.set(r.user_id, arr);
    }

    const capacityByUser = new Map<string, number>();
    for (const u of users) capacityByUser.set(u.id, userCapacity(u, allTasks).pct);

    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const drafts = parsed.map((t, i) => {
      const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(allTasks, t.clientName);
      const ranked = rankCandidates({
        task: { title: t.title, description: t.description, departmentId: null, tags: t.tags },
        candidates: users,
        skillsByUser,
        capacityByUser,
        activeTasksByUser,
        clientHistoryByUser
      });
      const suggestedAssignees = ranked.slice(0, 3).map((r) => ({
        userId: r.userId,
        name: nameById.get(r.userId) ?? r.userId,
        score: Math.round(r.score),
        reason: r.reason,
        capacityPct: Math.round(r.capacityPct * 100)
      }));
      return {
        id: `vd_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        ...t,
        suggestedAssignees
      };
    });

    // Lightweight rosters so the review UI can reassign to anyone / set a
    // department. departmentIds lets the client default the task's dept to
    // the chosen assignee's home department.
    const people = users.map((u) => ({
      id: u.id,
      name: u.name,
      departmentIds: u.departmentIds
    }));
    const deptList = departments.map((d) => ({ id: d.id, name: d.name }));

    return NextResponse.json({ drafts, people, departments: deptList });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
