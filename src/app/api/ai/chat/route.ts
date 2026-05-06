import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { CURRENT_USER_ID } from "@/lib/session";
import {
  getAllTickets, getDepartmentById, getUserById
} from "@/lib/server-data";
import type { Ticket } from "@/lib/types";

interface ChatMessage { role: "user" | "assistant"; content: string }

function summarise(t: Ticket, assigneeName: string): string {
  const due = t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "no date";
  return `- [${t.priority}] "${t.title}" — ${t.status}, est ${t.estimatedHours}h, due ${due}, assignee ${assigneeName}${t.inactiveFlag ? " (STALLED)" : ""}`;
}

async function buildSystemPrompt(): Promise<string> {
  const currentUser = await getUserById(CURRENT_USER_ID);
  if (!currentUser) {
    throw new Error(`Current user ${CURRENT_USER_ID} not found in DB`);
  }

  const allTickets = await getAllTickets();

  // Resolve every assignee name in one batch so summarise() can run sync.
  const assigneeIds = Array.from(new Set(allTickets.map((t) => t.assigneeId).filter(Boolean) as string[]));
  const assignees = await Promise.all(assigneeIds.map((id) => getUserById(id)));
  const nameById = new Map<string, string>();
  for (const u of assignees) if (u) nameById.set(u.id, u.name);
  const named = (t: Ticket) => summarise(t, t.assigneeId ? (nameById.get(t.assigneeId) ?? "unassigned") : "unassigned");

  const myTickets = allTickets.filter((t) => t.assigneeId === currentUser.id && t.status !== "done");
  const urgent = allTickets.filter((t) => t.status === "urgent" || t.priority === "critical");
  const stalled = allTickets.filter((t) => t.inactiveFlag);

  const myDeptNames = (
    await Promise.all(currentUser.departmentIds.map((id) => getDepartmentById(id)))
  )
    .map((d) => d?.name)
    .filter(Boolean)
    .join(", ") || "—";

  return `You are an AI assistant inside DelegationDoer, an internal task-management tool for a digital agency with departments SEO, Website, Software, and Marketing.

Current user: ${currentUser.name} (${currentUser.email})
Role: ${currentUser.role}
Department(s): ${myDeptNames}

Open tickets assigned to ${currentUser.name}:
${myTickets.length ? myTickets.map(named).join("\n") : "(none)"}

Urgent / critical tickets across the whole org:
${urgent.length ? urgent.map(named).join("\n") : "(none)"}

Stalled tickets (no activity in 48h+):
${stalled.length ? stalled.map(named).join("\n") : "(none)"}

Guidelines:
- Be concise. Default to short answers; expand only when asked.
- Reference specific ticket titles or assignee names when answering.
- Do NOT invent ticket titles, projects, or people that aren't in the lists above.
- When asked "what should I focus on", combine priority, due date, and stalled state — surface 1–3 items, not all of them.
- When asked who to assign something to, name the person and a one-line reason (skill/department fit, current load).`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json({ reply: "(say something)" });
    }

    const systemPrompt = await buildSystemPrompt();
    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.chat,
      max_tokens: 800,
      system: [
        {
          type: "text",
          text: systemPrompt,
          // System prompt is stable across turns; caching cuts repeated input cost.
          // cache_control is supported at runtime in SDK 0.32.x but not yet in its types.
          cache_control: { type: "ephemeral" }
        } as any
      ],
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    });

    const reply = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim() || "(no reply)";

    return NextResponse.json({ reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}