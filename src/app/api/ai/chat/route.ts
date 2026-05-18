import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDepartments } from "@/lib/server-data";
import { AI_TOOLS, runTool } from "@/lib/ai-tools";

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

    const departments = await getDepartments();
    const deptLabels = actor.departmentIds
      .map((id) => departments.find((d) => d.id === id)?.name)
      .filter(Boolean)
      .join(", ") || "—";

    // Small system prompt + a directory of tools. The model decides
    // which to call based on the user's question; everything else
    // (filtering, access scoping) happens server-side inside each
    // tool handler.
    const systemPrompt = `You are an AI assistant inside DelegationDoer, an internal task-management tool for a digital agency (scaledai.org). The departments are SEO, Website, Software, and Marketing.

Caller:
- Name: ${actor.name}
- Role: ${actor.role}
- Department(s): ${deptLabels}
- Today: ${new Date().toLocaleString()}

You have access to tools that read live data from the workspace's database. Use them whenever a question depends on real data (tasks, people, projects, clients, calendar, kudos, incidents, EOD notes, recommendations, SOPs). Don't invent task titles, project names, or people.

Guidelines:
- Be concise. Default to a one or two-sentence answer; expand only when asked to.
- Use the smallest set of tool calls needed. Reach for who_am_i / find_user_by_name when you need ids or to resolve "me" / "Henry" / etc.
- Workers see only tasks not owned/created by leaders (this is enforced server-side, you can't bypass it — if a tool returns nothing for a worker, that's by design).
- Reference task titles, person names, project names — not raw ids.
- When suggesting an assignee for new work, rank by capacity + role/department fit and explain the top pick in one line.
- For "how do I…" / procedural / new-hire questions, call search_sops and base the answer on the matched chunks. ALWAYS cite the SOP title. If any matching chunk carries an imageUrl (a captioned screenshot or diagram), embed it inline in your reply using markdown image syntax: ![brief caption](imageUrl) on its own line, BEFORE the related step. Show the actual picture rather than just describing it — users learn faster from screenshots than prose. If multiple chunks have images, include each one near the step it illustrates. If search_sops returns no relevant chunks (or all distances are high — anything above ~0.6 is loose), say so directly rather than guessing.`;

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

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await client.messages.create({
        model: MODELS.chat,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: systemPrompt,
            // System prompt is stable across turns; caching saves cost.
            // cache_control is supported at runtime in SDK 0.32.x but
            // not always in its types — cast through any.
            cache_control: { type: "ephemeral" }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any
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
        const output = await runTool(block.name, block.input ?? {}, { actor });
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
      toolCalls: tracedToolCalls
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
