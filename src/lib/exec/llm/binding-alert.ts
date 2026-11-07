import "server-only";

import { notifyOps } from "@/lib/exec/ops";

// The chat loop's one ops alert (P5b contract §3.14, coherence-15; Area C):
// thinking blocks the API dropped under block_binding "drop_block". It lives
// outside the chat file class (agent/**, chat/**), whose files never call
// notifyOps, and carries ids and counts only: the turn id and how many blocks
// were transformed. notifyOps rate-limits by key (ops.ts), so a bad prefix
// that repeats every turn alerts once per window.

const TURN_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/** Logs once and alerts ops: "[exec-llm] binding transformations turn=<turnId> count=<n>". Never throws. */
export async function reportBindingTransformations(turnId: string, count: number): Promise<void> {
  const turn = typeof turnId === "string" && TURN_ID_SAFE.test(turnId) ? turnId : "unknown";
  const n = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return;
  console.warn(`[exec-llm] binding transformations turn=${turn} count=${n}`);
  try {
    await notifyOps({ key: "exec-chat-binding", title: "Chat dropped thinking blocks", detail: `turn ${turn}: ${n}` });
  } catch {
    // notifyOps never rejects today; a change there must not fail a chat turn.
  }
}
