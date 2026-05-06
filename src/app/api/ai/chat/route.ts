import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { tickets, currentUser, userById, deptById } from "@/lib/mock-data";
import type { Ticket } from "@/lib/types";

interface ChatMessage { role: "user" | "assistant"; content: string }

function summarise(t: Ticket): string {
  const assignee = userById(t.assigneeId)?.name ?? "unassigned";
  const due = t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "no date";
  return `- [${t.priority}] "${t.title}" — ${t.status}, est ${t.estimatedHours}h, due ${due}, assignee ${assignee}${t.inactiveFlag ? " (STALLED)" : ""}`;
}

function buildSystemPrompt(): string {
  const myTickets = tickets.filter((t) => t.assigneeId === currentUser.id && t.status !== "done");
  const urgent = tickets.filter((t) => t.status === "urgent" || t.priority === "critical");
  const stalled = tickets.filter((t) => t.inactiveFlag);
  const myDeptNames = currentUser.departmentIds.map((id) => deptById(id)?.name).filter(Boolean).join(", ") || "—";

  return `You are an AI assistant inside DelegationDoer, an internal task-management tool for a digital agency with departments SEO, Website, Software, and Marketing.

Current user: ${currentUser.name} (${currentUser.email})
Role: ${currentUser.role}
Department(s): ${myDeptNames}

Open tickets assigned to ${currentUser.name}:
${myTickets.length ? myTickets.map(summarise).join("\n") : "(none)"}

Urgent / critical tickets across the whole org:
${urgent.length ? urgent.map(summarise).join("\n") : "(none)"}

Stalled tickets (no activity in 48h+):
${stalled.length ? stalled.map(summarise).join("\n") : "(none)"}

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

    const client = await getAnthropic();
    const result = await client.messages.create({
      model: MODELS.chat,
      max_tokens: 800,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          // System prompt is stable across turns; caching cuts repeated input cost.
          cache_control: { type: "ephemeral" }
        }
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
