import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDepartments } from "@/lib/server-data";
import { AI_TOOLS, runTool, type ProposedAction } from "@/lib/ai-tools";

interface ChatMessage { role: "user" | "assistant"; content: string }

// Maximum number of tool-use rounds per turn. Each round = one
// model response that requests tools + one batch of tool_results
// fed back. Most questions resolve in 1–3 rounds; cap at 8 so a
// runaway loop can't burn tokens forever.
const MAX_ROUNDS = 8;

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const actor = await getUserById(userId);
    if (!actor) {
      return NextResponse.json({ error: "user not found" }, { status: 401 });
    }

    const body = await req.json();
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json({ reply: "(say something)" });
    }

    // Optional per-client context — sent by the per-client Ask AI entry
    // point on a client's detail page. Validated defensively: only a
    // well-formed { id, name } string pair is honored. When present the
    // assistant defaults its answers + tool calls to this client (the
    // server-side access scoping inside each tool is unchanged — this
    // only nudges which clientId the model passes, it can't widen
    // visibility).
    const rawClient = body?.clientContext;
    const clientContext =
      rawClient && typeof rawClient.id === "string" && typeof rawClient.name === "string"
        ? { id: rawClient.id, name: rawClient.name }
        : null;

    const departments = await getDepartments();
    const deptLabels = actor.departmentIds
      .map((id) => departments.find((d) => d.id === id)?.name)
      .filter(Boolean)
      .join(", ") || "—";

    // System prompt is split into two text blocks. The first (long,
    // static) carries the role + guidelines and is identical across
    // every caller/turn, so it's marked cache_control: ephemeral and
    // hits the prompt cache. The second is the per-call dynamic context
    // (caller identity, today's date, optional client scoping) and is
    // left uncached — it changes per user/client so caching it would
    // never hit anyway.
    const staticSystemPrompt = `You are an AI assistant inside Scaled Operations, an internal task-management tool for a digital agency (scaledai.org). The departments are SEO, Website, Software, and Marketing.

You have access to tools that read live data from the workspace's database. Use them whenever a question depends on real data (tasks, people, projects, clients, client meetings/briefs, calendar, kudos, incidents, EOD notes, recommendations, SOPs). Don't invent task titles, project names, or people.

Guidelines:
- Be concise. Default to a one or two-sentence answer; expand only when asked to.
- Use the smallest set of tool calls needed. Reach for who_am_i / find_user_by_name when you need ids or to resolve "me" / "Henry" / etc.
- Task visibility is enforced server-side and you can't bypass it: leaders/admins see all tasks; workers and dept heads see only their own work plus tasks in their own department(s), and never leader-owned tasks. This applies to every task path (search_tasks, get_task, client task lists, project tasks). So any count, "what's overdue", or summary you produce for a non-leader is already scoped to their team — present it that way, never as an org-wide figure. If a tool returns nothing for a non-leader, that's by design, not an error.
- INBOX PERMISSIONS: email tools (e.g. list_client_recent_emails) are scoped server-side to the inboxes this caller is allowed to see — the same inboxes they'd see in the UI. You cannot read, summarize, or infer anything about emails in inboxes outside their access. If a tool returns accessDenied or an empty set for a client, tell the user you don't have access to those inboxes; never guess at the contents or imply the emails exist.
- Reference task titles, person names, project names — not raw ids.
- When suggesting an assignee for new work, rank by capacity + role/department fit and explain the top pick in one line.
- ACTION CARDS: whenever a tool result reveals a clear action item (an email asking for follow-up, a "next step" the user just discussed, an obvious task the user hinted at), call \`propose_task\` to stage a "Create task" button under your reply. The tool returns the top-ranked assignees — your text answer should call out the top pick by name with a one-line rationale. Do NOT fabricate a task when the user is just asking for information; only stage one when there's a real action to commit to.
- CLIENT MEETINGS: when a question, an email you're drafting, or a brief/task you're proposing concerns a specific client, call list_client_meetings to ground it in what was actually said and decided in their tl;dv meetings (summaries, key decisions, client requests, risks, next steps). Prefer this over guessing about prior conversations; cite the meeting date when you lean on it.
- For "how do I…" / procedural / new-hire questions, call search_sops and base the answer on the matched chunks. ALWAYS cite the SOP title. If any matching chunk carries an imageUrl (a captioned screenshot or diagram), embed it inline in your reply using markdown image syntax: ![brief caption](imageUrl) on its own line, BEFORE the related step. Show the actual picture rather than just describing it — users learn faster from screenshots than prose. If multiple chunks have images, include each one near the step it illustrates. If search_sops returns no relevant chunks (or all distances are high — anything above ~0.6 is loose), say so directly rather than guessing.`;

    const clientScoping = clientContext
      ? `\n\nThe user is viewing client ${clientContext.name} (clientId "${clientContext.id}"). Unless they clearly ask about something else, scope every answer to this client — pass clientId: "${clientContext.id}" to client tools (get_client, list_client_completed_tasks, list_client_recent_emails, list_client_eod_updates, list_client_meetings) and frame summaries around this client.`
      : "";

    const dynamicSystemPrompt = `Caller:
- Name: ${actor.name}
- Role: ${actor.role}
- Department(s): ${deptLabels}
- Today: ${new Date().toLocaleString()}${clientScoping}`;

    // Build the message list we'll feed Anthropic. We mutate this as
    // tool rounds progress (appending each assistant tool_use + the
    // tool_result we computed).
    type AnyContent =
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
    type AnyMessage = { role: "user" | "assistant"; content: string | AnyContent[] };

    const convo: AnyMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }));

    const client = await getAnthropic();
    let finalText = "";
    const tracedToolCalls: { name: string; input: Record<string, unknown> }[] = [];
    // Tools push onto this when they want the UI to render an inline
    // action card under the assistant turn (e.g. "Create task" with
    // ranker-picked assignees). Returned to the client at the end.
    const proposals: ProposedAction[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await client.messages.create({
        model: MODELS.chat,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: staticSystemPrompt,
            // Static across turns + callers; caching saves cost.
            // cache_control is supported at runtime in SDK 0.32.x but
            // not always in its types — cast through any.
            cache_control: { type: "ephemeral" }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          // Per-call dynamic context (caller + optional client scope).
          // Left uncached — it varies per user/client so it would never
          // hit the cache anyway.
          { type: "text", text: dynamicSystemPrompt }
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: AI_TOOLS as any,
        messages: convo
      });

      const blocks = (result.content ?? []) as AnyContent[];
      const stopReason = result.stop_reason as string | undefined;

      if (stopReason !== "tool_use") {
        // Final text response — accumulate every text block.
        finalText = blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      // Append the assistant turn (carrying the tool_use blocks) to
      // the convo, then run each tool and append its result as a
      // single user-role message with one content block per result.
      convo.push({ role: "assistant", content: blocks });
      const toolResults: AnyContent[] = [];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        tracedToolCalls.push({ name: block.name, input: block.input });
        const output = await runTool(block.name, block.input ?? {}, { actor, proposals });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
          is_error:
            typeof output === "object" && output !== null && "error" in (output as Record<string, unknown>)
        });
      }
      convo.push({ role: "user", content: toolResults });
    }

    if (!finalText) {
      finalText = "(I got stuck reasoning through that. Try rephrasing?)";
    }

    return NextResponse.json({
      reply: finalText,
      // Surface what tools were called so the UI can show a small
      // "looked at X, Y, Z" hint if it wants to.
      toolCalls: tracedToolCalls,
      // Inline action cards staged by tools like propose_task. The
      // drawer renders these under the assistant message; clicking
      // "Create task" POSTs to /api/tasks with the pre-filled fields.
      actions: proposals
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
