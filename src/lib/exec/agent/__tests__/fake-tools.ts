// Test support for Area C's loop and turn tests: stand-ins for Area B's modules,
// written from the frozen contract (§3.5, §3.6, §3.10, §3.11.1), so the loop is
// tested against the interface, not against B's code (bindings AM21).
//
//   fakeRefsModule       RefRegistry (prior and context refs citable at once,
//                        new refs citable only after markDelivered, numbering
//                        from refSeq, ≤ 400 new), targetKey, threadOfTarget,
//                        targetFromSourceRef
//   fakeSerializeModule  ConsultedBudget (≤ max, synchronous admit)
//   fakeToolDefsModule   16 strict defs named CHAT_TOOL_NAMES, labels, version
//   fakeExecutor()       an executeToolCall with per-tool behaviours and
//                        instrumentation (concurrency, signals, contexts)
//   fakeMemo()           a TurnMemo that reads nothing
//
// Use as
//   vi.mock("@/lib/exec/agent/refs", async () => (await import("./__tests__/fake-tools")).fakeRefsModule);
// This file imports types only (and vitest), so a factory may load it.

import { vi, type Mock } from "vitest";

import type { ExecChatTool } from "@/lib/exec/agent/tool-defs";
import type { ToolContext, TurnMemo } from "@/lib/exec/agent/tools";
import { CHAT_TOOL_NAMES, type PersistedToolCall, type RefEntry, type RefTarget, type ToolErrorCode, type ToolName } from "@/lib/exec/agent/types";
import type { ExecToolDef, ExecToolResultBlockParam, ExecToolUseBlock } from "@/lib/exec/llm/request";
import type { SourceRef } from "@/lib/exec/types";

// ---------------------------------------------------------------------------
// Refs (§3.5)
// ---------------------------------------------------------------------------

export const FAKE_MAX_NEW_REFS = 400;
const REF_SHAPE = /^r\d{1,5}$/;

export function fakeTargetKey(t: RefTarget): string {
  switch (t.type) {
    case "eod_note":
    case "sod_note":
      return `${t.type}:${t.userId}:${t.date}`;
    case "approval":
      return `approval:${t.mechanism}:${t.id ?? ""}`;
    case "page":
      return `page:${t.path}`;
    case "meeting":
      return `meeting:${t.id}`;
    default:
      return `${t.type}:${t.id}`;
  }
}

export function fakeThreadOfTarget(t: RefTarget): string | null {
  if (t.type === "email_thread") return t.id;
  if (t.type === "attention" || t.type === "commitment") return t.threadId;
  return null;
}

export function fakeTargetFromSourceRef(r: SourceRef): RefTarget {
  if (r.system === "dd" && /^\/?tasks\//.test(r.id)) return { type: "task", id: r.id.replace(/^\/?tasks\//, "") };
  return { type: "page", path: r.id };
}

const strip = (s: SourceRef): SourceRef => ({ system: s.system, id: s.id, url: s.url, label: s.label, class: s.class });

export class FakeRefRegistry {
  private seq: number;
  private readonly byKey = new Map<string, RefEntry>();
  private readonly byRef = new Map<string, RefEntry>();
  private readonly standing = new Set<string>();
  private readonly issued: RefEntry[] = [];
  private readonly delivered = new Set<string>();
  constructor(init: { refSeq: number; prior: readonly RefEntry[]; contexts: readonly RefEntry[] }) {
    this.seq = init.refSeq;
    for (const e of [...init.contexts, ...init.prior]) {
      if (!REF_SHAPE.test(e.ref) || this.byRef.has(e.ref)) continue;
      const entry = { ref: e.ref, target: e.target, source: strip(e.source) };
      this.byRef.set(e.ref, entry);
      this.standing.add(e.ref);
      if (!this.byKey.has(fakeTargetKey(e.target))) this.byKey.set(fakeTargetKey(e.target), entry);
      this.seq = Math.max(this.seq, Number(e.ref.slice(1)));
    }
  }
  issue(target: RefTarget, source: SourceRef): string | null {
    const existing = this.byKey.get(fakeTargetKey(target));
    if (existing) return existing.ref;
    if (this.issued.length >= FAKE_MAX_NEW_REFS) return null;
    this.seq += 1;
    const entry = { ref: `r${this.seq}`, target, source: strip(source) };
    this.byKey.set(fakeTargetKey(target), entry);
    this.byRef.set(entry.ref, entry);
    this.issued.push(entry);
    return entry.ref;
  }
  markDelivered(refs: Iterable<string>): void {
    const mine = new Set(this.issued.map((e) => e.ref));
    for (const r of refs) if (mine.has(r)) this.delivered.add(r);
  }
  isCitable(ref: string): boolean {
    return this.standing.has(ref) || this.delivered.has(ref);
  }
  citable(ref: string): RefEntry | null {
    return this.isCitable(ref) ? (this.byRef.get(ref) ?? null) : null;
  }
  issuedThisTurn(): readonly RefEntry[] {
    return [...this.issued];
  }
  deliveredThisTurn(): readonly RefEntry[] {
    return this.issued.filter((e) => this.delivered.has(e.ref));
  }
  get refSeq(): number {
    return this.seq;
  }
}

export const fakeRefsModule = {
  MAX_NEW_REFS_PER_TURN: FAKE_MAX_NEW_REFS,
  RefRegistry: FakeRefRegistry,
  targetKey: fakeTargetKey,
  targetFromSourceRef: fakeTargetFromSourceRef,
  threadOfTarget: fakeThreadOfTarget
};

// ---------------------------------------------------------------------------
// Serialize (§3.6): the consulted budget
// ---------------------------------------------------------------------------

export class FakeConsultedBudget {
  private readonly ids = new Set<string>();
  constructor(private readonly max: number = 500) {}
  admit(ids: readonly string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (this.ids.has(id)) out.push(id);
      else if (this.ids.size < this.max) {
        this.ids.add(id);
        out.push(id);
      }
    }
    return out;
  }
  get full(): boolean {
    return this.ids.size >= this.max;
  }
  values(): string[] {
    return [...this.ids];
  }
}

export const fakeSerializeModule = {
  RESULT_JSON_CHARS: 16_000,
  ConsultedBudget: FakeConsultedBudget,
  capList: <T>(items: readonly T[], cap: number, total?: number) => ({ items: items.slice(0, cap), total: total ?? items.length, truncated: (total ?? items.length) > Math.min(cap, items.length) }),
  escapeJsonLt: (json: string) => json.split("<").join(`${String.fromCharCode(92)}u003c`)
};

// ---------------------------------------------------------------------------
// Tool defs (§3.10): 16 strict tools with the real names, in order
// ---------------------------------------------------------------------------

export const FAKE_TOOLS_VERSION = "fake-tools-v1";

function fakeDef(name: string): ExecToolDef {
  return {
    name,
    description: `Fake ${name}.`,
    input_schema: { type: "object", properties: { q: { type: "string", description: "Anything." } }, required: ["q"], additionalProperties: false },
    strict: true
  };
}

export const FAKE_CHAT_TOOLS: readonly ExecChatTool[] = Object.freeze(
  CHAT_TOOL_NAMES.map((name) => ({
    name,
    def: fakeDef(name),
    label: `Label ${name}`,
    kind: name === "propose_task" || name === "create_draft" ? ("staged" as const) : ("read" as const),
    usesEmail: false,
    timeoutMs: 25_000
  }))
);

export const fakeToolDefsModule = {
  CHAT_TOOLS: FAKE_CHAT_TOOLS,
  CHAT_TOOL_DEFS: Object.freeze(FAKE_CHAT_TOOLS.map((t) => t.def)),
  TOOLS_VERSION: FAKE_TOOLS_VERSION,
  strictBudget: () => ({ tools: 16, optional: 0, unions: 0, forbidden: [] as string[] })
};

// ---------------------------------------------------------------------------
// The executor and the memo (§3.11.1)
// ---------------------------------------------------------------------------

export function fakeMemo(): TurnMemo {
  const none = async () => [];
  return {
    users: none, departments: none, clients: none, projects: none, openTasks: none, schedules: none,
    email: async () => ({ state: "off" }),
    bucketRows: none,
    intakePolicy: async () => null
  } as unknown as TurnMemo;
}

/** What a fake tool does with one call. */
export type ToolBehaviour = (call: ExecToolUseBlock, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
export type ToolOutcome =
  | { ok: true; json: Record<string, unknown>; blocks?: string[] }
  | { ok: false; code: ToolErrorCode; text: string };

export interface FakeExecutor {
  executeToolCall: Mock<(call: ExecToolUseBlock, ctx: ToolContext) => Promise<{ block: ExecToolResultBlockParam; record: PersistedToolCall }>>;
  /** Highest number of calls in flight at once. */
  readonly maxActive: number;
  /** Every context the executor was handed, in call order. */
  contexts: ToolContext[];
  calls: ExecToolUseBlock[];
}

/** The standard result of a fake read: one item for the target, its ref issued and (because it is in the content) delivered. */
export function itemResult(ctx: ToolContext, target: RefTarget, label = "Item"): ToolOutcome {
  const source: SourceRef = { system: "dd", id: fakeTargetKey(target), url: null, label, class: "internal" };
  const ref = ctx.refs.issue(target, source);
  return { ok: true, json: { items: [{ ref, title: label }], notes: [] } };
}

export function fakeExecutor(opts: { behaviours?: Partial<Record<string, ToolBehaviour>>; delayMs?: number; fallback?: ToolBehaviour } = {}): FakeExecutor {
  let active = 0;
  let maxActive = 0;
  const contexts: ToolContext[] = [];
  const calls: ExecToolUseBlock[] = [];
  const fallback: ToolBehaviour = opts.fallback ?? ((call, ctx) => itemResult(ctx, { type: "task", id: `t_${call.id}` }, `Task ${call.id}`));
  const executeToolCall = vi.fn(async (call: ExecToolUseBlock, ctx: ToolContext) => {
    contexts.push(ctx);
    calls.push(call);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const started = Date.now();
    try {
      if (opts.delayMs) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.delayMs);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
      const behaviour = opts.behaviours?.[call.name] ?? fallback;
      let outcome: ToolOutcome;
      try {
        outcome = await behaviour(call, ctx);
      } catch {
        outcome = { ok: false, code: "internal", text: `Label ${call.name} failed unexpectedly. Say this part couldn't be checked.` };
      }
      const name = (CHAT_TOOL_NAMES as readonly string[]).includes(call.name) ? (call.name as ToolName) : ("get_source" as ToolName);
      if (outcome.ok) {
        const text = JSON.stringify(outcome.json);
        // C39 in miniature: refs that sit in the final content are delivered.
        const refs = [...text.matchAll(/"ref":"(r\d{1,5})"/g)].map((m) => m[1]);
        ctx.refs.markDelivered(refs);
        const content = [{ type: "text" as const, text }, ...(outcome.blocks ?? []).map((b) => ({ type: "text" as const, text: b }))];
        return {
          block: { type: "tool_result" as const, tool_use_id: call.id, content },
          record: { round: ctx.round, name, args: { ...call.input }, ok: true, error: null, ms: Date.now() - started }
        };
      }
      return {
        block: { type: "tool_result" as const, tool_use_id: call.id, content: [{ type: "text" as const, text: outcome.text }], is_error: true },
        record: { round: ctx.round, name, args: { ...call.input }, ok: false, error: outcome.code, ms: Date.now() - started }
      };
    } finally {
      active -= 1;
    }
  });
  return {
    executeToolCall,
    get maxActive() {
      return maxActive;
    },
    contexts,
    calls
  };
}
