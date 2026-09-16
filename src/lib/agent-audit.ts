import "server-only";

import crypto from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The audit trail for every EDIT an outside agent makes through /api/mcp:
// which key, which tool, with what input, and what came back. One row per
// write, in agent_actions (migration 20260917090000_agent_connector.sql).
//
// Writes fail CLOSED on it: startAgentAction runs before the edit and throws if
// the row can't be written, and the MCP tool then changes nothing. An agent
// that can move money (Meta budgets) or rewrite the brain's instructions must
// never do so unrecorded — a missing migration is a refused edit, not a silent
// one.

// Anything that looks like a credential is kept out of the log, however the
// agent chose to name it.
const SECRET_KEY = /secret|token|password|authorization|api[-_]?key|bearer/i;
const MAX_STRING = 4_000;
const MAX_JSON = 20_000;

// Cut on a UTF-16 boundary: a lone half of a surrogate pair (an emoji split in
// two) is invalid in Postgres jsonb, and the insert would then fail — refusing an
// edit over a truncation.
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${cut(value, MAX_STRING)}…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value ?? null;
}

// A regenerated brief or a long instructions text shouldn't bloat the table;
// keep a bounded copy that still shows what happened.
function bounded(value: unknown): unknown {
  const safe = redact(value);
  const json = JSON.stringify(safe ?? null);
  return json.length <= MAX_JSON ? safe : { truncated: true, preview: cut(json, MAX_JSON) };
}

/** Record an edit BEFORE it runs. Throws when the row can't be written. */
export async function startAgentAction(keyName: string, tool: string, input: unknown): Promise<string> {
  const id = `aa_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const { error } = await getSupabaseAdmin()
    .from("agent_actions")
    .insert({ id, key_name: keyName, tool, input: bounded(input ?? {}) });
  if (error) throw new Error(`audit log unavailable: ${error.message}`);
  return id;
}

/** Record how the edit ended. Never throws — the edit already happened. */
export async function finishAgentAction(id: string, outcome: { ok: boolean; result?: unknown; error?: string }): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("agent_actions")
      .update({
        ok: outcome.ok,
        result: outcome.result === undefined ? null : bounded(outcome.result),
        error: outcome.error ?? null,
        finished_at: new Date().toISOString()
      })
      .eq("id", id);
    if (error) console.warn(`[agent-audit] could not finish ${id}: ${error.message}`);
  } catch (e) {
    console.warn(`[agent-audit] could not finish ${id}:`, e instanceof Error ? e.message : e);
  }
}
