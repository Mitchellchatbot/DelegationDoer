// The Model Context Protocol, just the part Scaled Operations serves: a
// stateless Streamable HTTP server that answers every POST with plain JSON (no
// SSE stream, no sessions). That is what Claude Code's `--transport http` and
// Claude Desktop's mcp-remote bridge expect from a tools-only server.
//
// Pure: no Next, no database, no auth — the route does those and hands this
// the parsed body plus the tool registry, so the dispatch can be tested alone.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type ToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

export type ToolCallResult = { content: { type: "text"; text: string }[]; isError: boolean };

export type McpDeps = {
  serverInfo: { name: string; version: string };
  instructions: string;
  listTools: () => ToolDescriptor[];
  /** null → the tool doesn't exist (a JSON-RPC error, per the spec). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult | null>;
};

type Id = string | number | null;
type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleOne(msg: unknown, deps: McpDeps): Promise<RpcResponse | null> {
  if (!isObj(msg) || msg.jsonrpc !== "2.0") return err(null, RPC.invalidRequest, "Invalid JSON-RPC message");
  const hasId = "id" in msg;
  const id = (typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null) as Id;

  // A client's reply to a server request, or any notification: nothing to say.
  if (typeof msg.method !== "string") return hasId && ("result" in msg || "error" in msg) ? null : err(id, RPC.invalidRequest, "Missing method");
  if (!hasId) return null;

  const params = isObj(msg.params) ? msg.params : {};
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: deps.serverInfo,
            instructions: deps.instructions
          }
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: deps.listTools() } };
      case "tools/call": {
        if (typeof params.name !== "string") return err(id, RPC.invalidParams, "tools/call needs params.name");
        if (params.arguments !== undefined && !isObj(params.arguments)) return err(id, RPC.invalidParams, "params.arguments must be an object");
        const out = await deps.callTool(params.name, (params.arguments as Record<string, unknown>) ?? {});
        if (!out) return err(id, RPC.invalidParams, `Unknown tool: ${params.name}`);
        return { jsonrpc: "2.0", id, result: out };
      }
      default:
        return err(id, RPC.methodNotFound, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    // Tool failures are already isError results; this is an unexpected throw.
    return err(id, RPC.internal, e instanceof Error ? e.message : "Internal error");
  }
}

/**
 * One POST body → the HTTP answer. A single message or a batch array; when
 * nothing in it expects a reply (notifications only), 202 with no body.
 */
export async function handleMcp(body: unknown, deps: McpDeps): Promise<{ status: number; body: unknown | null }> {
  if (Array.isArray(body)) {
    if (!body.length) return { status: 400, body: err(null, RPC.invalidRequest, "Empty batch") };
    const replies: RpcResponse[] = [];
    for (const m of body) {
      const r = await handleOne(m, deps);
      if (r) replies.push(r);
    }
    return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
  }
  const r = await handleOne(body, deps);
  return r ? { status: 200, body: r } : { status: 202, body: null };
}
