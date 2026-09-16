import "server-only";

import crypto from "crypto";

// Personal API keys for AI agents that work Scaled Operations from outside the
// app — today Mitchell's own Claude agent, through the MCP connector at
// /api/mcp.
//
// AGENT_API_KEYS = "name:key,name2:key2". Every key acts as the OWNER: the
// connector exposes owner-only data (the brain's snapshot, finances inside it)
// and owner-only edits (brain memory and instructions, pipeline leads, our Meta
// ads). One key per agent, so a leaked key is revoked by deleting its pair in
// Railway without touching any other agent or anything else in the app. The
// name is what the audit log (agent_actions.key_name) records.
//
// Fails closed: no variable, a malformed pair, or a key shorter than 32
// characters matches nothing — a placeholder like "changeme" must never become
// a credential.

const MIN_KEY_LENGTH = 32;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

type AgentKey = { name: string; digest: Buffer };

const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

function agentKeys(): AgentKey[] {
  const raw = process.env.AGENT_API_KEYS ?? "";
  const keys: AgentKey[] = [];
  for (const pair of raw.split(",")) {
    const at = pair.indexOf(":");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const key = pair.slice(at + 1).trim();
    if (!NAME.test(name) || key.length < MIN_KEY_LENGTH) continue;
    keys.push({ name, digest: digest(key) });
  }
  return keys;
}

/**
 * The agent an Authorization header belongs to, or null.
 *
 * "Bearer <key>" only — never a query string, which would land in access logs.
 * Both sides are hashed before the constant-time compare so the lengths always
 * agree (timingSafeEqual throws otherwise, and checking length first would leak
 * it), and every configured key is compared, so the time taken doesn't say
 * which key — or whether any — matched.
 */
export function verifyAgentKey(authorization: string | null): { name: string } | null {
  const keys = agentKeys();
  if (!keys.length || !authorization) return null;
  const m = /^Bearer ([^\s]+)$/.exec(authorization.trim());
  if (!m) return null;
  const presented = digest(m[1]);
  let match: { name: string } | null = null;
  for (const k of keys) {
    if (crypto.timingSafeEqual(presented, k.digest) && !match) match = { name: k.name };
  }
  return match;
}
