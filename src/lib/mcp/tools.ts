import "server-only";

import { z } from "zod";
import type { User } from "@/lib/types";
import { getOutboundPipelineTool, getMetaAdsTool } from "@/lib/ai-tools";
import { listAgentProspects, updateAgentProspect, listAgentMetaObjects, updateAgentMetaObject } from "@/lib/outbound-agent";
import { AGENT_PROSPECT_PATCH_FIELDS, type AgentResult } from "@/lib/outbound-agent-types";
import { getGrowthSnapshot, getLatestGrowthBrief, startGrowthBriefGeneration } from "@/lib/growth-brain";
import { listMemories, addMemory, updateMemory, forgetMemory } from "@/lib/brain-memory";
import {
  DEFAULT_BRAIN_RULES,
  getBrainInstructions,
  listBrainInstructionVersions,
  setBrainInstructions,
  rollbackBrainInstructions
} from "@/lib/brain-instructions";
import { getScaleSources } from "@/lib/scale-sources";
import { startAgentAction, finishAgentAction } from "@/lib/agent-audit";
import type { ToolCallResult, ToolDescriptor } from "./protocol";

// The tools Mitchell's Claude agent gets through /api/mcp. Every one acts as the
// owner (the key already proved that), and every figure comes from the same
// code the app itself uses — the Ask AI tools, the Scale Room brain, the ads
// dashboard's own endpoints — so the agent can't see a different pipeline or a
// different brain than the app does.
//
// Reads run straight. EDITS are audit-logged BEFORE they run (agent-audit.ts)
// and refuse to run when the log can't be written. What an edit may change is
// enforced where the data lives: the ads dashboard owns the lead whitelist and
// the Meta guardrails (our ad account only, daily budget ≤ its cap, 0.5×–2× per
// change); brain-instructions.ts owns the instruction limits; the brief's JSON
// output contract and the source rules stay in code, out of the agent's reach.

export type McpCallContext = { keyName: string; actor: User };

type ToolDef = ToolDescriptor & {
  write: boolean;
  args: z.ZodTypeAny;
  run: (args: any, ctx: McpCallContext) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const STAGES = ["new", "contacted", "no_response", "booked", "proposal", "won", "lost"] as const;
const CATEGORIES = ["priority", "decision", "fact", "preference"] as const;

class ToolError extends Error {}

// The Scale Room's Outbound switch governs every read of the ads dashboard —
// the page, the brain and Ask AI honour it, so the agent does too.
async function requireOutbound(): Promise<void> {
  const s = await getScaleSources();
  if (s.readError) throw new ToolError(`Couldn't read the Scale Room's Outbound switch (${s.readError}) — nothing was fetched.`);
  if (!s.outbound) throw new ToolError("The Outbound source is switched off in the Scale Room (/scale), so the ads dashboard isn't read. Switch it on first.");
}

// Supabase reports no error when an update matches no row, so a mistyped or
// already-forgotten id would otherwise come back "ok" — and the agent would tell
// Mitchell a memory is gone while the brain keeps weighing it.
async function requireActiveMemory(id: string): Promise<void> {
  const memories = await listMemories();
  if (!memories.some((m) => m.id === id)) throw new ToolError(`No active memory with id ${id} — list them with brain_memories.`);
}

function unwrap<T>(r: AgentResult<T>): T {
  if (!r.ok) throw new ToolError(r.status ? `${r.error} (HTTP ${r.status})` : r.error);
  return r.data;
}

// ai-tools return { error } objects for refusals; surface them as tool errors.
function toolResult(out: unknown): unknown {
  if (out && typeof out === "object" && "error" in out && typeof (out as { error: unknown }).error === "string") {
    throw new ToolError((out as { error: string }).error);
  }
  return out;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const RISKY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const TOOLS: ToolDef[] = [
  // ─── reads ────────────────────────────────────────────────────────────────
  {
    name: "outbound_pipeline",
    title: "Outbound pipeline (live)",
    description:
      "LIVE outbound sales pipeline — the treatment centers we are prospecting as NEW clients (not existing clients), from the Meta ads dashboard's Outbound board the reps work. Stage counts, booked vs not, reps' texting queues vs daily caps and backlog, how stale un-reached leads are, leads → bookings by source, new-lead velocity, monthly spend / prospects / booked / cost per lead / cost per booked, and matching leads. Filter with stage / source / owner / followUp / search.",
    inputSchema: obj({
      stage: { type: "string", enum: [...STAGES, "booked_or_beyond", "not_booked"] },
      source: { type: "string", description: "Leads whose source contains this text." },
      owner: { type: "string", description: "Leads dealt to this rep today." },
      followUp: { type: "string", enum: ["needs", "longterm"] },
      search: { type: "string", description: "Matches facility, contact, location or next action." },
      limit: { type: "number", description: "Max leads (default 25, max 100)." }
    }),
    annotations: READ,
    write: false,
    args: z
      .object({
        stage: z.enum([...STAGES, "booked_or_beyond", "not_booked"]).optional(),
        source: z.string().max(200).optional(),
        owner: z.string().max(100).optional(),
        followUp: z.enum(["needs", "longterm"]).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().optional()
      })
      .strict(),
    run: async (args, ctx) => toolResult(await getOutboundPipelineTool(args, { actor: ctx.actor, proposals: [] }))
  },
  {
    name: "meta_ads",
    title: "Our Meta ads (live)",
    description:
      "LIVE performance of OUR OWN Meta ad account (not clients'), read from Meta: last N full days (ending yesterday) vs the N before — spend, impressions, clicks, leads, reach, frequency, CTR, CPC, CPM, CPL; every campaign, ad set and ad; ad-form prospects and bookings with cost per booking. Pass includeDaily for the day-by-day series. Names only — use meta_ad_objects for the ids an edit needs.",
    inputSchema: obj({
      days: { type: "number", enum: [7, 14, 30, 90], description: "Window length (default 7)." },
      includeDaily: { type: "boolean", description: "Also return the day-by-day series." }
    }),
    annotations: READ,
    write: false,
    args: z.object({ days: z.number().optional(), includeDaily: z.boolean().optional() }).strict(),
    run: async (args, ctx) => toolResult(await getMetaAdsTool(args, { actor: ctx.actor, proposals: [] }))
  },
  {
    name: "outbound_leads_for_edit",
    title: "Pipeline leads with ids",
    description:
      "Every prospect on the outbound board WITH its id and editable fields (stage, owner, followUp, nextAction, nextActionAt, lastContactedAt, notes, value) — use the id with outbound_lead_update. No email or phone. Filter with stage (a stage key) or search (facility, contact, location, owner, next action, notes).",
    inputSchema: obj({
      stage: { type: "string", enum: [...STAGES] },
      search: { type: "string" },
      limit: { type: "number", description: "Default 50, max 400." }
    }),
    annotations: READ,
    write: false,
    args: z.object({ stage: z.enum(STAGES).optional(), search: z.string().max(200).optional(), limit: z.number().optional() }).strict(),
    run: async (args: { stage?: string; search?: string; limit?: number }) => {
      await requireOutbound();
      const all = unwrap(await listAgentProspects());
      const needle = args.search?.trim().toLowerCase();
      const matches = all.filter(
        (p) =>
          (!args.stage || p.stage === args.stage) &&
          (!needle || [p.facility, p.name, p.location, p.owner, p.nextAction, p.notes].some((f) => (f ?? "").toLowerCase().includes(needle)))
      );
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 50), 1), 400);
      return { total: all.length, matching: matches.length, truncated: matches.length > limit, leads: matches.slice(0, limit) };
    }
  },
  {
    name: "meta_ad_objects",
    title: "Our Meta campaigns, ad sets and ads with ids",
    description:
      "Live campaigns, ad sets and ads in OUR ad account with ids, configured and effective status, and daily/lifetime budgets (dollars), plus maxDailyBudget — the cap any budget edit must respect. Use the ids with meta_set_status / meta_set_daily_budget.",
    inputSchema: obj({}),
    annotations: READ,
    write: false,
    args: z.object({}).strict(),
    run: async () => {
      await requireOutbound();
      return unwrap(await listAgentMetaObjects());
    }
  },
  {
    name: "brain_snapshot",
    title: "What the Scale Room brain reads",
    description:
      "The exact snapshot text the Scale Room brain (Growth Brain) reasons over right now — MRR, finance, clients, team load, recent calls, wins, the live outbound pipeline and Meta ads, and Mitchell's standing priorities — plus which outside sources were on. Owner-only data. Use it to see WHY the brain says what it says.",
    inputSchema: obj({}),
    annotations: READ,
    write: false,
    args: z.object({}).strict(),
    run: async () => getGrowthSnapshot()
  },
  {
    name: "brain_latest_brief",
    title: "Latest Scale Room brief",
    description: "The most recent Growth Brief the Scale Room shows: the #1 constraint, PROTECT and GROW items, when it was generated and from which sources.",
    inputSchema: obj({}),
    annotations: READ,
    write: false,
    args: z.object({}).strict(),
    run: async () => ({ brief: await getLatestGrowthBrief() })
  },
  {
    name: "brain_memories",
    title: "Brain memory",
    description: "The brain's active memory — standing priorities, decisions, company facts and preferences it weighs in every brief and chat — with ids for brain_memory_update / brain_memory_forget.",
    inputSchema: obj({}),
    annotations: READ,
    write: false,
    args: z.object({}).strict(),
    run: async () => ({ memories: await listMemories() })
  },
  {
    name: "brain_instructions",
    title: "Brain instructions",
    description:
      "The Scale Room brain's current core instructions (its mandate and rules), whether they're the built-in default, and optionally the version history (ids for brain_instructions_rollback). The JSON output format and the per-source rules are fixed in code and not part of this text.",
    inputSchema: obj({ includeHistory: { type: "boolean", description: "Also list the last 20 versions." } }),
    annotations: READ,
    write: false,
    args: z.object({ includeHistory: z.boolean().optional() }).strict(),
    run: async (args: { includeHistory?: boolean }) => {
      const current = await getBrainInstructions();
      return {
        ...current,
        defaultRulesLength: DEFAULT_BRAIN_RULES.length,
        ...(args.includeHistory ? { history: await listBrainInstructionVersions(20) } : {})
      };
    }
  },

  // ─── edits (audit-logged) ─────────────────────────────────────────────────
  {
    name: "brain_memory_add",
    title: "Add a brain memory",
    description: "Save a durable priority, decision, company fact or preference the brain should weigh from now on. Audit-logged.",
    inputSchema: obj({ content: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] } }, ["content", "category"]),
    annotations: EDIT,
    write: true,
    args: z.object({ content: z.string().trim().min(1).max(2000), category: z.enum(CATEGORIES) }).strict(),
    run: async (args: { content: string; category: string }, ctx) => ({ memory: await addMemory(args.content, args.category, `agent:${ctx.keyName}`) })
  },
  {
    name: "brain_memory_update",
    title: "Update a brain memory",
    description: "Change the text and/or category of an existing memory (id from brain_memories). Audit-logged.",
    inputSchema: obj(
      { id: { type: "string" }, content: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] } },
      ["id"]
    ),
    annotations: EDIT,
    write: true,
    args: z
      .object({ id: z.string().min(1).max(200), content: z.string().trim().min(1).max(2000).optional(), category: z.enum(CATEGORIES).optional() })
      .strict()
      .refine((a) => a.content !== undefined || a.category !== undefined, "Pass content and/or category"),
    run: async (args: { id: string; content?: string; category?: string }) => {
      await requireActiveMemory(args.id);
      if (!(await updateMemory(args.id, { content: args.content, category: args.category }))) throw new ToolError("Memory update failed.");
      return { ok: true, id: args.id };
    }
  },
  {
    name: "brain_memory_forget",
    title: "Forget a brain memory",
    description: "Deactivate a memory that's no longer true (id from brain_memories). Audit-logged.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    annotations: EDIT,
    write: true,
    args: z.object({ id: z.string().min(1).max(200) }).strict(),
    run: async (args: { id: string }) => {
      await requireActiveMemory(args.id);
      if (!(await forgetMemory(args.id))) throw new ToolError("Forget failed.");
      return { ok: true, id: args.id };
    }
  },
  {
    name: "brain_regenerate",
    title: "Regenerate the Scale Room brief",
    description:
      "Kick off a Scale Room brain regeneration in the background with the current snapshot, memory and instructions; it saves the new brief (what /scale shows) when done. Returns immediately (generation takes 1-3 min, longer than a request can block). Use after changing memory or instructions, then read brain_latest_brief a minute or two later to see the effect. Audit-logged.",
    inputSchema: obj({}),
    annotations: EDIT,
    write: true,
    args: z.object({}).strict(),
    run: async () => {
      const { started, alreadyRunning } = startGrowthBriefGeneration();
      return {
        started,
        alreadyRunning,
        note: alreadyRunning
          ? "A regeneration is already running — read brain_latest_brief shortly."
          : "Regeneration started in the background — read brain_latest_brief in ~1-2 minutes for the new brief.",
        previous: await getLatestGrowthBrief()
      };
    }
  },
  {
    name: "brain_instructions_update",
    title: "Replace the brain's instructions",
    description:
      "Replace the Scale Room brain's WHOLE core instructions text with `rules` (read brain_instructions first and edit that text). Saved as a new version, so it can be rolled back. The JSON output format and the per-source rules stay in code and are appended automatically — don't include them. Audit-logged.",
    inputSchema: obj(
      { rules: { type: "string", description: "The full new core instructions (max 20,000 chars)." }, note: { type: "string", description: "Why — shown in the history." } },
      ["rules"]
    ),
    annotations: EDIT,
    write: true,
    args: z.object({ rules: z.string().min(1).max(20_000), note: z.string().max(500).optional() }).strict(),
    run: async (args: { rules: string; note?: string }, ctx) => ({
      version: await setBrainInstructions(args.rules, args.note ?? null, `agent:${ctx.keyName}`)
    })
  },
  {
    name: "brain_instructions_rollback",
    title: "Roll back the brain's instructions",
    description: "Restore an earlier version of the brain's instructions (versionId from brain_instructions with includeHistory), or \"default\" for the built-in rules. Saved as a new version. Audit-logged.",
    inputSchema: obj({ versionId: { type: "string" } }, ["versionId"]),
    annotations: EDIT,
    write: true,
    args: z.object({ versionId: z.string().min(1).max(200) }).strict(),
    run: async (args: { versionId: string }, ctx) => ({ version: await rollbackBrainInstructions(args.versionId, `agent:${ctx.keyName}`) })
  },
  {
    name: "outbound_lead_update",
    title: "Update a pipeline lead",
    description:
      `Change one prospect on the outbound board (id from outbound_leads_for_edit). \`changes\` is any subset of ${AGENT_PROSPECT_PATCH_FIELDS.join(", ")}: stage is a stage key (${STAGES.join(", ")}); followUp "needs" | "longterm" | null; dates "YYYY-MM-DD" | null; value a number | null. Same effect as editing it on the board. Audit-logged.`,
    inputSchema: obj(
      {
        id: { type: "string" },
        changes: {
          type: "object",
          properties: {
            stage: { type: "string", enum: [...STAGES] },
            owner: { type: ["string", "null"] },
            followUp: { type: ["string", "null"], enum: ["needs", "longterm", null] },
            nextAction: { type: ["string", "null"] },
            nextActionAt: { type: ["string", "null"], description: "YYYY-MM-DD" },
            lastContactedAt: { type: ["string", "null"], description: "YYYY-MM-DD" },
            notes: { type: ["string", "null"] },
            value: { type: ["number", "null"] }
          },
          additionalProperties: false
        }
      },
      ["id", "changes"]
    ),
    annotations: EDIT,
    write: true,
    args: z.object({ id: z.string().min(1).max(200), changes: z.record(z.unknown()) }).strict(),
    run: async (args: { id: string; changes: Record<string, unknown> }) => {
      await requireOutbound();
      return { prospect: unwrap(await updateAgentProspect(args.id, args.changes)) };
    }
  },
  {
    name: "meta_set_status",
    title: "Pause or resume a Meta campaign, ad set or ad",
    description:
      "Set a campaign, ad set or ad in OUR ad account to ACTIVE or PAUSED (id from meta_ad_objects). ACTIVE starts spending real money. Refused for anything outside our ad account. Returns before/after. Audit-logged.",
    inputSchema: obj({ id: { type: "string" }, status: { type: "string", enum: ["ACTIVE", "PAUSED"] } }, ["id", "status"]),
    annotations: RISKY,
    write: true,
    args: z.object({ id: z.string().min(1).max(40), status: z.enum(["ACTIVE", "PAUSED"]) }).strict(),
    run: async (args: { id: string; status: "ACTIVE" | "PAUSED" }) => {
      await requireOutbound();
      return unwrap(await updateAgentMetaObject(args.id, { status: args.status }));
    }
  },
  {
    name: "meta_set_daily_budget",
    title: "Change a Meta daily budget",
    description:
      "Set the daily budget (dollars) of a campaign or ad set in OUR ad account that already has a daily budget (id from meta_ad_objects). Guardrails enforced by the ads dashboard: our account only; campaigns/ad sets with a daily budget only; at most maxDailyBudget; within 0.5×–2× of the current budget per change. Real money. Returns before/after. Audit-logged.",
    inputSchema: obj({ id: { type: "string" }, dailyBudget: { type: "number", description: "Dollars per day." } }, ["id", "dailyBudget"]),
    annotations: RISKY,
    write: true,
    args: z.object({ id: z.string().min(1).max(40), dailyBudget: z.number().positive().finite() }).strict(),
    run: async (args: { id: string; dailyBudget: number }) => {
      await requireOutbound();
      return unwrap(await updateAgentMetaObject(args.id, { dailyBudget: args.dailyBudget }));
    }
  }
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function listMcpTools(): ToolDescriptor[] {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const fail = (message: string): ToolCallResult => ({ content: [{ type: "text", text: message }], isError: true });

/** null → no such tool. Every failure after that is an isError result. */
export async function callMcpTool(name: string, rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<ToolCallResult | null> {
  const tool = BY_NAME.get(name);
  if (!tool) return null;

  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  }

  let auditId: string | null = null;
  if (tool.write) {
    try {
      auditId = await startAgentAction(ctx.keyName, name, parsed.data);
    } catch (e) {
      console.warn(`[mcp] audit unavailable, refused ${name}:`, e instanceof Error ? e.message : e);
      return fail("Audit log unavailable — nothing was changed. If this persists, check that the agent_connector migration has been applied.");
    }
  }

  try {
    const out = await tool.run(parsed.data, ctx);
    if (auditId) await finishAgentAction(auditId, { ok: true, result: out });
    return { content: [{ type: "text", text: text(out) }], isError: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (auditId) await finishAgentAction(auditId, { ok: false, error: message });
    if (!(e instanceof ToolError)) console.warn(`[mcp] ${name} failed:`, message);
    return fail(message);
  }
}
