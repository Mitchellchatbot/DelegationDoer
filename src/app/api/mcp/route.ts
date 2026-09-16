import { NextResponse } from "next/server";
import { verifyAgentKey } from "@/lib/agent-keys";
import { getAllUsersLight } from "@/lib/server-data";
import { OWNER_EMAIL } from "@/lib/access";
import { handleMcp, LATEST_PROTOCOL_VERSION } from "@/lib/mcp/protocol";
import { callMcpTool, listMcpTools } from "@/lib/mcp/tools";
import type { User } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// brain_regenerate runs the whole Growth Brain (about a minute). Railway has no
// function timeout; this only matters if the app is ever served serverless.
export const maxDuration = 300;

// The MCP connector for outside AI agents — today Mitchell's own Claude agent,
// so it can read the live pipeline, our Meta ads and exactly what the Scale Room
// brain sees, and correct the brain (memory, instructions), work leads and
// adjust our ads.
//
//   Claude Code:    claude mcp add --transport http scaled-ops https://operations.scaledai.org/api/mcp \
//                     --header "Authorization: Bearer <key>"
//   Claude Desktop: npx -y mcp-remote https://operations.scaledai.org/api/mcp --header "Authorization:${AUTH}"
//                   with AUTH="Bearer <key>" in the server's env.
//
// No Supabase session here (middleware lets /api/mcp through), so the bearer
// key from AGENT_API_KEYS is the ENTIRE gate and it fails closed. Stateless
// Streamable HTTP: every POST gets a JSON answer; there's no SSE stream to GET.

const NO_STORE = { "Cache-Control": "no-store" };

const INSTRUCTIONS = [
  "Scaled Operations (DelegationDoer) — Scaled AI's internal ops app. You act as the owner, Mitchell.",
  "Reads: outbound_pipeline and meta_ads (live, with filters), outbound_leads_for_edit and meta_ad_objects (with the ids edits need), brain_snapshot (exactly what the Scale Room brain reads), brain_latest_brief, brain_memories, brain_instructions.",
  "Edits are audit-logged and refused if the log is unavailable: brain_memory_add/update/forget, brain_instructions_update/rollback, brain_regenerate (slow), outbound_lead_update, meta_set_status, meta_set_daily_budget.",
  "Meta edits only ever touch our own ad account; budgets are capped and may move at most 0.5×–2× per change. Prospects in the outbound pipeline are potential NEW clients, not existing clients.",
  "To improve the brain: read brain_snapshot and brain_latest_brief, adjust memory or instructions, then brain_regenerate and compare."
].join(" ");

// The key proves the caller acts for the owner; tools that reuse the app's own
// owner-gated code need the owner as a User.
async function ownerUser(): Promise<User> {
  const users = await getAllUsersLight();
  const owner = users.find((u) => (u.email ?? "").trim().toLowerCase() === OWNER_EMAIL);
  if (!owner) throw new Error(`Owner account ${OWNER_EMAIL} not found`);
  return owner;
}

export async function POST(req: Request) {
  const agent = verifyAgentKey(req.headers.get("authorization"));
  if (!agent) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized — send Authorization: Bearer <agent key>" } },
      { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": 'Bearer realm="scaled-ops"' } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: NO_STORE });
  }

  let actor: User | null = null;
  const res = await handleMcp(body, {
    serverInfo: { name: "scaled-operations", version: "1.0.0" },
    instructions: INSTRUCTIONS,
    listTools: listMcpTools,
    callTool: async (name, args) => {
      actor ??= await ownerUser();
      const out = await callMcpTool(name, args, { keyName: agent.name, actor });
      // Which agent called which tool and whether it worked — never the args,
      // which can carry lead notes or instruction text.
      if (out) console.info(`[mcp] ${agent.name} ${name} ${out.isError ? "error" : "ok"}`);
      return out;
    }
  });

  const headers = { ...NO_STORE, "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION };
  return res.body === null ? new Response(null, { status: res.status, headers }) : NextResponse.json(res.body, { status: res.status, headers });
}

// Stateless server: no server-to-client stream to open and no session to end.
// 405 is the spec's answer for both.
const notAllowed = () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", ...NO_STORE } });
export const GET = notAllowed;
export const DELETE = notAllowed;
