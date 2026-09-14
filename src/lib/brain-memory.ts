import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Persistent memory for the AI brain — durable facts, priorities, decisions,
// and preferences it should carry across every chat and the daily brief, so it
// builds on what it's been told instead of restarting each conversation.
//
// Owner-scoped: this is Mitchell's operating memory (strategy, priorities,
// standing decisions). Only injected into / writable from the owner's context.

export type MemoryCategory = "priority" | "decision" | "fact" | "preference";

export interface BrainMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: string;
}

const CATEGORIES: MemoryCategory[] = ["priority", "decision", "fact", "preference"];
function coerceCategory(c: unknown): MemoryCategory {
  return CATEGORIES.includes(c as MemoryCategory) ? (c as MemoryCategory) : "fact";
}

export async function listMemories(): Promise<BrainMemory[]> {
  const { data } = await getSupabaseAdmin()
    .from("brain_memories")
    .select("id, content, category, created_at")
    .eq("active", true)
    .order("category", { ascending: true })
    .order("created_at", { ascending: true });
  return ((data ?? []) as { id: string; content: string; category: string; created_at: string }[]).map((r) => ({
    id: r.id,
    content: r.content,
    category: coerceCategory(r.category),
    createdAt: r.created_at
  }));
}

export async function addMemory(content: string, category: unknown, createdBy: string): Promise<BrainMemory> {
  const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const row = { id, content: content.trim(), category: coerceCategory(category), created_by: createdBy, active: true };
  await getSupabaseAdmin().from("brain_memories").insert(row);
  return { id, content: row.content, category: row.category, createdAt: new Date().toISOString() };
}

export async function updateMemory(id: string, fields: { content?: string; category?: unknown }): Promise<boolean> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof fields.content === "string") patch.content = fields.content.trim();
  if (fields.category !== undefined) patch.category = coerceCategory(fields.category);
  const { error } = await getSupabaseAdmin().from("brain_memories").update(patch).eq("id", id);
  return !error;
}

export async function forgetMemory(id: string): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from("brain_memories")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  return !error;
}

// Render active memories as a prompt block, grouped by category. Empty string
// when there are none (so callers can skip the section cleanly).
export function formatMemoriesBlock(memories: BrainMemory[]): string {
  if (!memories.length) return "";
  const labels: Record<MemoryCategory, string> = {
    priority: "Standing priorities",
    decision: "Decisions made",
    fact: "Company facts",
    preference: "Preferences"
  };
  const lines: string[] = [];
  for (const cat of CATEGORIES) {
    const items = memories.filter((m) => m.category === cat);
    if (!items.length) continue;
    lines.push(`${labels[cat]}:`);
    for (const m of items) lines.push(`- [${m.id}] ${m.content}`);
  }
  return lines.join("\n");
}
