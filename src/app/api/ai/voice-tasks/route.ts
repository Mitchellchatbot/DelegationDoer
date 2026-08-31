import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight, getAllTasks, getDepartments } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { userCapacity } from "@/lib/capacity";
import { rankCandidates, buildLoadSignals } from "@/lib/skill-rank";
import { getAnthropic, resetAnthropic, MODELS } from "@/lib/anthropic-client";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/ai/voice-tasks
//   Body: { transcript: string }
//   Turns a spoken brain-dump into structured, delegatable task drafts. For
//   each task Claude produces a breakdown outline, a recommended time estimate
//   and priority, and — crucially — routes it:
//     * If the founder NAMED a person or department in the recording, that
//       task is delegated to exactly that person/department (honored, not
//       guessed).
//     * Otherwise the skill/capacity ranker (rankCandidates, the same engine
//       the new-task form uses) supplies ranked recommendations.
//   Every task also carries the top-3 ranker recommendations so the founder
//   can switch the owner in the review UI.
//
//   NOTHING is created here. The client renders the drafts for the founder to
//   edit/approve, then POSTs the approved ones to /api/tasks (the audited
//   write path). This route is read-only + Claude.

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
                "1–3 sentence summary of the task: what to do and what 'done' looks like. Never just repeat the title."
            },
            outline: {
              type: "array",
              items: { type: "string" },
              description:
                "The breakdown: 2–6 short, concrete steps to complete this task, in order. Each step a terse imperative phrase (e.g. 'Audit current hero copy'). This is how the founder sees the work broken up."
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
              description: "Infer from urgency cues in speech ('asap', 'urgent', 'whenever'). Default 'medium'."
            },
            estimatedHours: {
              type: "number",
              description:
                "Recommended time to complete, in hours. A realistic estimate for one person (e.g. 0.5, 2, 4, 8). Default 2 when unclear."
            },
            assigneeName: {
              type: "string",
              description:
                "If the founder named or clearly referred to a specific person to do this, put that person's EXACT name from the TEAM ROSTER in the system prompt. Empty string if no person was named."
            },
            departmentName: {
              type: "string",
              description:
                "If the founder named or clearly referred to a department/team for this work, put that department's EXACT name from the DEPARTMENTS list in the system prompt. Empty string if none named."
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
          required: ["title", "description", "outline", "priority", "estimatedHours", "tags"]
        }
      }
    },
    required: ["tasks"]
  }
};

interface RawTask {
  title?: unknown;
  description?: unknown;
  outline?: unknown;
  priority?: unknown;
  estimatedHours?: unknown;
  assigneeName?: unknown;
  departmentName?: unknown;
  clientName?: unknown;
  dueDate?: unknown;
  tags?: unknown;
}

function cleanStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function cleanList(v: unknown, max: number, lower = false): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === "string")
    .map((t) => (lower ? t.trim().toLowerCase() : t.trim()))
    .filter(Boolean)
    .slice(0, max);
}
// Accept only a clean YYYY-MM-DD; drop anything else.
function cleanDueDate(v: unknown): string | null {
  const s = cleanStr(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function cleanHours(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 2;
  return Math.min(Math.round(n * 2) / 2, 80); // half-hour granularity, sane cap
}

// Match a spoken name to a roster user. Claude is asked for the exact roster
// name, but be forgiving: exact (case-insensitive) first, then a unique
// first-name / substring match so "vishwa" resolves to "Vishwa Patel".
function resolvePerson(name: string, users: User[]): User | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = users.find((u) => u.name.toLowerCase() === q);
  if (exact) return exact;
  const starts = users.filter((u) => u.name.toLowerCase().startsWith(q) || u.name.toLowerCase().split(/\s+/)[0] === q);
  if (starts.length === 1) return starts[0];
  const contains = users.filter((u) => u.name.toLowerCase().includes(q));
  return contains.length === 1 ? contains[0] : null;
}
function resolveDept(name: string, depts: { id: string; name: string }[]): { id: string; name: string } | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = depts.find((d) => d.name.toLowerCase() === q);
  if (exact) return exact;
  const contains = depts.filter((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase()));
  return contains.length === 1 ? contains[0] : null;
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

    // Gather roster + departments + tasks + skills up front — the roster feeds
    // BOTH Claude's name/department routing and the ranker recommendations.
    const supabase = getSupabaseAdmin();
    const [users, allTasks, skillRowsRes, departments] = await Promise.all([
      getAllUsersLight(),
      getAllTasks(),
      supabase.from("user_skills").select("user_id, tag, manual_level, auto_score"),
      getDepartments()
    ]);
    const deptList = departments.map((d) => ({ id: d.id, name: d.name }));
    const deptNameById = new Map(deptList.map((d) => [d.id, d.name]));

    // Roster block Claude uses to resolve spoken names → exact names.
    const deptNamesForUser = (u: User) =>
      u.departmentIds.map((id) => deptNameById.get(id)).filter(Boolean).join(", ");
    const rosterBlock = users
      .map((u) => `- ${u.name} (${u.role}${deptNamesForUser(u) ? `, ${deptNamesForUser(u)}` : ""})`)
      .join("\n") || "(no teammates)";
    const deptBlock = deptList.map((d) => `- ${d.name}`).join("\n") || "(no departments)";

    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const dow = today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

    const system =
      "You convert a founder's spoken brain-dump into clean, delegatable tasks for a digital agency's task board.\n" +
      `Today is ${dow}, ${isoToday} (UTC). Resolve any relative dates against it.\n\n` +
      "TEAM ROSTER (use these EXACT names when the founder names a person):\n" +
      rosterBlock +
      "\n\nDEPARTMENTS (use these EXACT names when the founder names a department):\n" +
      deptBlock +
      "\n\nRules:\n" +
      "- Split distinct pieces of work into separate tasks; keep one genuine job as one task.\n" +
      "- For each task, write a short outline: 2–6 concrete steps that break the work up.\n" +
      "- Give a realistic time estimate (hours) and a priority.\n" +
      "- ROUTING: if the founder names or clearly refers to a person, set assigneeName to that person's EXACT roster name. If they name a department/team, set departmentName to its EXACT name. If they name neither, leave both empty and the system will recommend an owner.\n" +
      "- Never invent clients, deadlines, or people that weren't spoken. Leave fields empty when unsure.\n" +
      "Always respond by calling the emit_tasks tool.";

    type AnyContent = { type: string; name?: string; input?: Record<string, unknown> };
    async function callClaude(): Promise<{ content?: AnyContent[] }> {
      const client = await getAnthropic();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return client.messages.create({
        model: MODELS.chat,
        max_tokens: 3000,
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
          outline: cleanList(t.outline, 8),
          priority,
          estimatedHours: cleanHours(t.estimatedHours),
          assigneeName: cleanStr(t.assigneeName),
          departmentName: cleanStr(t.departmentName),
          clientName: cleanStr(t.clientName) || null,
          dueDate: cleanDueDate(t.dueDate),
          tags: cleanList(t.tags, 5, true)
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .slice(0, 12);

    if (parsed.length === 0) {
      return NextResponse.json({
        drafts: [],
        people: [],
        departments: deptList,
        note: "No actionable tasks were found in that recording."
      });
    }

    // Ranker inputs (skills + capacity), shared across drafts.
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
      // Honor spoken routing first.
      const namedUser = t.assigneeName ? resolvePerson(t.assigneeName, users) : null;
      const namedDept = t.departmentName ? resolveDept(t.departmentName, deptList) : null;
      // If a person was named, their home department is the natural department
      // unless a different one was explicitly named.
      const routedDeptId = namedDept?.id ?? namedUser?.departmentIds?.[0] ?? null;

      const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(allTasks, t.clientName);
      const ranked = rankCandidates({
        task: { title: t.title, description: t.description, departmentId: routedDeptId, tags: t.tags },
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
        title: t.title,
        description: t.description,
        outline: t.outline,
        priority: t.priority,
        estimatedHours: t.estimatedHours,
        clientName: t.clientName,
        dueDate: t.dueDate,
        tags: t.tags,
        // Explicit routing the founder spoke (null when nothing was named).
        namedAssignee: namedUser ? { userId: namedUser.id, name: namedUser.name } : null,
        namedDepartment: namedDept
          ? { id: namedDept.id, name: namedDept.name }
          : (routedDeptId ? { id: routedDeptId, name: deptNameById.get(routedDeptId) ?? "" } : null),
        // Ranker recommendations (always present so the founder can switch).
        suggestedAssignees
      };
    });

    const people = users.map((u) => ({
      id: u.id,
      name: u.name,
      departmentIds: u.departmentIds
    }));

    return NextResponse.json({ drafts, people, departments: deptList });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
