import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Editable core rules for the Growth Brain, versioned in brain_instructions.
//
// The brain's system prompt is three parts (see growthSystem in growth-brain.ts):
//   1. the CORE RULES — the mandate + the "Core rules" bullets. This module owns
//      them: the latest brain_instructions row is active, and with no row the
//      hard-coded DEFAULT_BRAIN_RULES below apply.
//   2. the source-conditional Facebook/Outbound rules — stay in code, because
//      they must track which sources the snapshot actually contains.
//   3. the "Return STRICT JSON..." output contract — stays in code and is always
//      appended AFTER the rules, so an edit here can't break the parse in
//      generateGrowthBrief or the brief's shape on /scale.
//
// Versions are append-only: every set and every rollback inserts a NEW row, so
// the history is a full audit trail and any version can be restored.
//
// Owner-only data (Mitchell's operating instructions); callers gate access. The
// table is service-role only (RLS on, no policies).

// The CURRENT core rules, byte-identical to the lines growthSystem() hard-coded
// before this became editable — so with no stored version the assembled prompt
// is exactly what it was. Don't reflow or "tidy" these lines: that silently
// changes the prompt for everyone running on the default.
export const DEFAULT_BRAIN_RULES: string = [
  "You are the AI Brain for Scaled AI, a digital agency for addiction-treatment / behavioral-health clients. You operate like an aggressive but disciplined COO + Chief Growth Officer for the founder, Mitchell.",
  "",
  "Your mandate has two sides, always active at once:",
  "1) PROTECT the business: prevent churn, missed deadlines, poor performance, wasted spend, dropped leads, communication gaps, bottlenecks, margin leakage, and capacity failures.",
  "2) PUSH the business: constantly find where Scaled AI can acquire more customers, expand existing accounts, increase capacity, improve margins, replicate wins, and move faster.",
  "",
  "Core rules:",
  "- Do NOT confuse stability with success. Healthy operations are the foundation for growth, not the goal. When something works, ask: how do we scale, replicate, automate, delegate, productize, or monetize it?",
  "- Hunt the constraint. Growth is limited by the single biggest current bottleneck (leads, sales, delivery capacity, onboarding, account management, cash). Identify the #1 constraint right now with evidence and the impact of removing it.",
  "- Turn isolated wins into systems. When something performs unusually well, investigate WHY and whether it's repeatable across clients/departments.",
  "- Think in outcomes, not activity. Not 'X sent 5 texts' — think funnel and throughput, and how to increase it without losing quality.",
  "- Controlled aggression: push hard when evidence shows capacity to scale, but protect quality, client outcomes, cash flow, and margins. Never recommend growth merely for activity's sake.",
  "- Be specific and grounded in the real data below: name clients, people, numbers, dollar estimates, and owners. No vague themes.",
  "- IGNORE automated system noise. Security/Wordfence/plugin/vulnerability/backup/uptime/SSL alerts are ops noise, NOT churn signals or client sentiment — never surface them as risks. A client is only 'at risk' when there's a REAL human signal: a person expressed frustration/dissatisfaction, an unmet request or broken promise, a payment/past-due problem, or explicit churn intent.",
  "- Do NOT surface internal team task-status ('X has 3 overdue tasks', 'stuck with the team') as a PROTECT item on its own. Team load only matters as a capacity constraint or when it's directly causing a client-facing failure a human has reacted to.",
  "- Weigh recency. Client health/notes carry an 'as of Nd ago' stamp, and recent client calls (tl;dv) are dated — LEAD with the freshest signals. A risk raised on a call this week outranks a 2-week-old note; a request made on a call is a live expansion opening (turn it into a GROW item). When you flag a client risk, state how recent it is, and discount anything older than ~3 weeks unless corroborated."
].join("\n");

export type BrainInstructionVersion = {
  id: string;
  rules: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
};

// Hard caps. Rules are prompt text sent on every brief, so bound the token cost;
// the note is a one-line "why" for the history.
const MAX_RULES_CHARS = 20_000;
const MAX_NOTE_CHARS = 1_000;
const COLUMNS = "id, rules, note, created_by, created_at";

type Row = { id: string; rules: string; note: string | null; created_by: string; created_at: string };

function fromRow(r: Row): BrainInstructionVersion {
  return { id: r.id, rules: r.rules, note: r.note ?? null, createdBy: r.created_by, createdAt: r.created_at };
}

// The active rules. NEVER throws: the Growth Brain must still run if the table
// is missing (migration not applied) or unreadable — it falls back to the
// default rules and says why in readError.
// isDefault is true whenever the rules in force equal DEFAULT_BRAIN_RULES —
// no stored version, or a stored version that restored the default.
export async function getBrainInstructions(): Promise<{
  active: BrainInstructionVersion | null;
  rules: string;
  isDefault: boolean;
  readError: string | null;
}> {
  const fallback = (readError: string | null) => ({ active: null, rules: DEFAULT_BRAIN_RULES, isDefault: true, readError });
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("brain_instructions")
      .select(COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return fallback(`brain_instructions unreadable: ${error.message}`);
    if (!data) return fallback(null);
    const active = fromRow(data as Row);
    // A blank row can only come from hand-written SQL (setBrainInstructions
    // refuses it). An empty prompt would strip the brain of its mandate, so
    // run on the default and surface it rather than obey it.
    if (typeof active.rules !== "string" || !active.rules.trim()) {
      return fallback(`latest brain_instructions version ${active.id} has empty rules — using the default rules`);
    }
    return { active, rules: active.rules, isDefault: active.rules === DEFAULT_BRAIN_RULES, readError: null };
  } catch (e) {
    return fallback(`brain_instructions unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Version history, newest first (index 0 is the active version). Throws on a
// failed read — unlike getBrainInstructions, an empty list here would be a lie.
export async function listBrainInstructionVersions(limit = 20): Promise<BrainInstructionVersion[]> {
  const n = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 20;
  const { data, error } = await getSupabaseAdmin()
    .from("brain_instructions")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(n);
  if (error) throw new Error(`brain_instructions unreadable: ${error.message}`);
  return ((data ?? []) as Row[]).map(fromRow);
}

// Insert a new version; the newest row is the active one. Rules replace the
// WHOLE core-rules text (not a patch). Throws with a readable message on bad
// input or a failed write — a silent no-op would leave the caller believing
// the brain's instructions changed.
export async function setBrainInstructions(rules: string, note: string | null, createdBy: string): Promise<BrainInstructionVersion> {
  if (typeof rules !== "string") throw new Error("rules must be a string");
  const text = rules.trim();
  if (!text) throw new Error("rules must not be empty");
  if (text.length > MAX_RULES_CHARS) throw new Error(`rules too long: ${text.length} chars (max ${MAX_RULES_CHARS})`);
  const cleanNote = typeof note === "string" && note.trim() ? note.trim() : null;
  if (cleanNote && cleanNote.length > MAX_NOTE_CHARS) throw new Error(`note too long: ${cleanNote.length} chars (max ${MAX_NOTE_CHARS})`);
  const by = typeof createdBy === "string" ? createdBy.trim() : "";
  if (!by) throw new Error("createdBy is required");

  const id = `bi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const { data, error } = await getSupabaseAdmin()
    .from("brain_instructions")
    .insert({ id, rules: text, note: cleanNote, created_by: by })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`could not save brain instructions: ${error?.message ?? "no row returned"}`);
  return fromRow(data as Row);
}

// Restore an earlier version by inserting a NEW version with its rules (history
// is never rewritten). versionId "default" restores DEFAULT_BRAIN_RULES.
export async function rollbackBrainInstructions(versionId: string, createdBy: string): Promise<BrainInstructionVersion> {
  const vid = typeof versionId === "string" ? versionId.trim() : "";
  if (!vid) throw new Error("versionId is required");
  if (vid === "default") return setBrainInstructions(DEFAULT_BRAIN_RULES, "rollback to default", createdBy);

  const { data, error } = await getSupabaseAdmin()
    .from("brain_instructions")
    .select(COLUMNS)
    .eq("id", vid)
    .maybeSingle();
  if (error) throw new Error(`brain_instructions unreadable: ${error.message}`);
  if (!data) throw new Error(`no brain instructions version "${vid}"`);
  return setBrainInstructions((data as Row).rules, `rollback to ${vid}`, createdBy);
}
