import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { CHAT_TOOL_DEFS, CHAT_TOOLS, sha256Hex, strictBudget, TOOLS_VERSION } from "@/lib/exec/agent/tool-defs";
import { CHAT_TOOL_NAMES } from "@/lib/exec/agent/types";
import { buildExecRequest, type ExecToolDef } from "@/lib/exec/llm/request";

// P5b contract §3.10 and tests 1-7: the 16 strict tool definitions.

const SOURCE = readFileSync(new URL("./tool-defs.ts", import.meta.url), "utf8");
const ALLOWED = new Set(["type", "enum", "description", "properties", "required", "additionalProperties"]);

type Node = Record<string, unknown>;
function nodes(schema: unknown, path = "input_schema", out: { path: string; node: Node }[] = []): { path: string; node: Node }[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return out;
  const n = schema as Node;
  out.push({ path, node: n });
  for (const [k, v] of Object.entries((n.properties as Record<string, unknown>) ?? {})) nodes(v, `${path}.${k}`, out);
  return out;
}

describe("the strict budget (test 1)", () => {
  it("16 tools, zero optional, zero unions, nothing forbidden; with P7's two tools still inside the API's limits", () => {
    const b = strictBudget(CHAT_TOOL_DEFS);
    // P7b stage 0 (§3.15.1, N16, §1.3 #1): 19 of 20; one slot stays for P8/P9.
    expect(b).toEqual({ tools: 19, optional: 0, unions: 0, forbidden: [] });
    expect(b.tools).toBeLessThanOrEqual(20);
    const p7 = (name: string): ExecToolDef => ({ name, description: "P7", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, strict: true });
    // P7b stage 0: P7's tools are in the registry now; the one slot left (P8/P9) still fits the API's limits.
    const withP7 = strictBudget([...CHAT_TOOL_DEFS, p7("next_phase_tool")]);
    expect(withP7.tools).toBeLessThanOrEqual(20);
    expect(withP7.optional).toBeLessThanOrEqual(24);
    expect(withP7.unions).toBeLessThanOrEqual(16);
  });

  it("counts what it should: optional params, unions and forbidden keywords", () => {
    const bad: ExecToolDef = {
      name: "bad",
      description: "x",
      input_schema: {
        type: "object",
        properties: { a: { type: ["string", "null"] }, b: { anyOf: [{ type: "string" }, { type: "integer" }] }, c: { type: "string", maxLength: 5 }, d: { type: "array", items: { type: "string" }, minItems: 2 } },
        required: ["a"],
        additionalProperties: false
      },
      strict: true
    };
    const b = strictBudget([bad]);
    expect(b.optional).toBe(3);
    expect(b.unions).toBe(2);
    expect(b.forbidden).toEqual(expect.arrayContaining(["bad.properties.a.type[]", "bad.properties.b.anyOf", "bad.properties.c.maxLength", "bad.properties.d.minItems"]));
  });
});

describe("every schema (test 2)", () => {
  it("is a closed object with every property required and only the allowed keywords", () => {
    for (const def of CHAT_TOOL_DEFS) {
      expect(def.strict).toBe(true);
      expect(def.input_schema.type).toBe("object");
      for (const { path, node } of nodes(def.input_schema)) {
        for (const key of Object.keys(node)) expect(`${def.name} ${path}.${key}:${ALLOWED.has(key)}`).toBe(`${def.name} ${path}.${key}:true`);
        if (node.type === "object") {
          expect(node.additionalProperties).toBe(false);
          expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
        }
      }
    }
  });
});

describe("names and order (test 3)", () => {
  it("equal CHAT_TOOL_NAMES; no excluded or acting tool", () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    expect(CHAT_TOOL_DEFS.map((d) => d.name)).toEqual([...CHAT_TOOL_NAMES]);
    for (const excluded of ["search_inbox", "list_client_recent_emails", "propose_email", "create_task", "remember", "forget", "get_my_calendar"]) {
      expect(CHAT_TOOL_NAMES as readonly string[]).not.toContain(excluded);
    }
    for (const name of CHAT_TOOL_NAMES) expect(name).not.toMatch(/^(send|post|update|delete|reassign|create_task|remember|forget)|publish/);
  });
});

describe("static enums, no data (test 4)", () => {
  // Every literal array of strings/numbers written in tool-defs.ts.
  const literalArrays: unknown[][] = [];
  const sf = ts.createSourceFile("tool-defs.ts", SOURCE, ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node): void => {
    if (ts.isArrayLiteralExpression(n) && n.elements.length > 0 && n.elements.every((e) => ts.isStringLiteral(e) || ts.isNumericLiteral(e))) {
      literalArrays.push(n.elements.map((e) => (ts.isStringLiteral(e) ? e.text : Number((e as ts.NumericLiteral).text))));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  it("every enum deep-equals a literal array of the file", () => {
    let enums = 0;
    for (const def of CHAT_TOOL_DEFS) {
      for (const { node } of nodes(def.input_schema)) {
        if (!Array.isArray(node.enum)) continue;
        enums += 1;
        expect(literalArrays.some((a) => JSON.stringify(a) === JSON.stringify(node.enum))).toBe(true);
      }
    }
    expect(enums).toBeGreaterThan(15);
  });

  it("no client, person, project, department or channel name of a 50-name fake DB occurs in the definitions", () => {
    const names = [
      "Acme Dental", "Acme Roofing", "Zenith Law", "Blue Harbor Spa", "Northwind", "Contoso", "Fabrikam", "Globex", "Initech", "Umbrella",
      "Ann Lee", "Bob Stone", "Ana Diaz", "Mujtaba", "Farez", "Sam Patel", "Priya Shah", "Omar Khan", "Lena Ford", "Raj Mehta",
      "Zenith Site Rebuild", "Spring Launch", "Q4 SEO Push", "Website Revamp", "Local Citations", "Ads Audit", "Brand Refresh", "CRM Migration", "Blog Sprint", "Review Drive",
      "SEO", "Website", "Facebook Ads", "Operations", "Finance Team", "Sales Team", "Support Desk", "Design Studio", "Content Team", "Outbound",
      "#dream-team", "#general", "#seo-alerts", "#web-team", "#fb-leads", "#ops", "#finance", "#random", "#clients", "#exec"
    ];
    const text = JSON.stringify(CHAT_TOOL_DEFS);
    for (const n of names) expect(text.includes(`"${n}"`)).toBe(false);
  });
});

describe("pure and data-free (test 5)", () => {
  it("imports types only", () => {
    const sf = ts.createSourceFile("tool-defs.ts", SOURCE, ts.ScriptTarget.Latest, true);
    const imports = sf.statements.filter(ts.isImportDeclaration);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.importClause?.isTypeOnly).toBe(true);
    expect(SOURCE).not.toMatch(/\brequire\(|\bimport\(/);
  });
});

describe("version, labels, descriptions (test 6)", () => {
  it("TOOLS_VERSION is the first 16 hex of sha256(JSON of the defs) and is pinned", () => {
    const json = JSON.stringify(CHAT_TOOL_DEFS);
    expect(TOOLS_VERSION).toBe(createHash("sha256").update(json, "utf8").digest("hex").slice(0, 16));
    // The pin moves only when a definition changes (the cached prefix changes with it).
    // P7b stage 0: tools 17-19 appended (e2f5be0f92be1f15 → 412de02dba59ab78); P7b D3: list_commitments' description.
    expect(TOOLS_VERSION).toBe("00dd2f88e6831f97");   // fixer security-6 / ui-4: the Slack-commitment wording moved it
    for (const s of ["", "abc", "é → ‹", "x".repeat(1000), String.fromCodePoint(0x1f600)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("labels non-empty and unique; descriptions non-empty; timeouts as §3.10; deep-frozen", () => {
    const labels = CHAT_TOOLS.map((t) => t.label);
    expect(new Set(labels).size).toBe(19);
    for (const t of CHAT_TOOLS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.def.description.length).toBeGreaterThan(40);
    }
    const slow = CHAT_TOOLS.filter((t) => t.timeoutMs === 40_000).map((t) => t.name);
    expect(slow).toEqual(["project_health", "client_overview", "search_email", "get_email_thread", "create_draft", "get_source", "search_slack"]);
    // P7b stage 0 (C21): prepare_client_update's own 60 s class.
    expect(CHAT_TOOLS.filter((t) => t.timeoutMs === 60_000).map((t) => t.name)).toEqual(["prepare_client_update"]);
    expect(CHAT_TOOLS.filter((t) => t.usesEmail).map((t) => t.name)).toEqual(["search_email", "get_email_thread", "list_commitments", "create_draft", "prepare_client_update"]);
    expect(CHAT_TOOLS.filter((t) => t.kind === "staged").map((t) => t.name)).toEqual(["propose_task", "create_draft", "prepare_client_update"]);
    expect(Object.isFrozen(CHAT_TOOLS)).toBe(true);
    expect(Object.isFrozen(CHAT_TOOL_DEFS[0].input_schema.properties)).toBe(true);
  });
});

describe("the request guard (test 7)", () => {
  it("a chat request built with CHAT_TOOL_DEFS passes assertExecRequestShape", () => {
    expect(() =>
      buildExecRequest({ feature: "chat", system: "You are the assistant.", messages: [{ role: "user", content: [{ type: "text", text: "Catch me up" }] }], tools: [...CHAT_TOOL_DEFS] })
    ).not.toThrow();
  });
});

// P7b (contract §3.15.1, §3.17.3 D3/D9, §5.6 TL01, TL02, TL04, TL12; Area D).
describe("P7b's three Slack tools (TL01, TL02, TL04, TL12)", () => {
  const CHANNELS = JSON.parse(readFileSync(new URL("../__tests__/fixtures/slack-intel/channels.json", import.meta.url), "utf8")) as { rows: Record<string, { name: string | null; channelId: string }> };

  it("TL01 the registry: 19 tools in order (17-19 after get_source), 55 parameters, no optional, no union, nothing forbidden; no enum holds data", () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    expect(CHAT_TOOLS.map((t) => t.name).slice(15)).toEqual(["get_source", "search_slack", "slack_digest", "prepare_client_update"]);
    expect(strictBudget(CHAT_TOOL_DEFS)).toEqual({ tools: 19, optional: 0, unions: 0, forbidden: [] });
    const params = CHAT_TOOL_DEFS.reduce((n, d) => n + Object.keys(d.input_schema.properties ?? {}).length, 0);
    expect(params).toBe(55);
    const all = JSON.stringify(CHAT_TOOL_DEFS);
    for (const row of Object.values(CHANNELS.rows)) {
      if (row.name) expect(all).not.toContain(row.name);
      expect(all).not.toContain(row.channelId);
    }
    for (const name of ["Acme", "Zenith", "Sentinel"]) expect(all).not.toContain(name);
    const enums = (n: string) => (CHAT_TOOL_DEFS.find((d) => d.name === n)?.input_schema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
    expect(enums("search_slack").kind.enum).toEqual(["any", "request", "question", "decision", "commitment", "action_item", "fyi"]);
    expect(enums("search_slack").since_days.enum).toEqual([1, 7, 30, 90]);
    expect(enums("slack_digest").window.enum).toEqual(["today", "yesterday", "last_7_days", "since_last_brief"]);
  });

  it("TL02 prepare_client_update's schema has exactly thread_id and project_id: no instruction (N17)", () => {
    const def = CHAT_TOOL_DEFS.find((d) => d.name === "prepare_client_update");
    expect(Object.keys(def?.input_schema.properties ?? {})).toEqual(["thread_id", "project_id"]);
    expect(def?.input_schema.required).toEqual(["thread_id", "project_id"]);
    expect(JSON.stringify(def?.input_schema)).not.toMatch(/instruction/);
  });

  it("TL04 TOOLS_VERSION moved from P5b's pin and is stable across two builds of the same definitions", () => {
    expect(TOOLS_VERSION).not.toBe("e2f5be0f92be1f15");
    const again = createHash("sha256").update(JSON.stringify(JSON.parse(JSON.stringify(CHAT_TOOL_DEFS))), "utf8").digest("hex").slice(0, 16);
    expect(again).toBe(TOOLS_VERSION);
    // Integrator (mutant M22): it changed exactly once, to P7b's static registry, which holds the three Slack tools in every
    // state (N16): a registry that added them only when Slack is ok would hash to another value.
    expect(TOOLS_VERSION).toBe("00dd2f88e6831f97");   // fixer security-6 / ui-4: the Slack-commitment wording moved it
    expect(CHAT_TOOL_DEFS.map((d) => d.name).slice(16)).toEqual(["search_slack", "slack_digest", "prepare_client_update"]);
  });

  it("TL12 list_commitments' description points Slack commitments at search_slack (D3, pinned)", () => {
    expect(CHAT_TOOLS.find((t) => t.name === "list_commitments")?.def.description).toBe(
      // Fixer security-6 / ui-4 (fact (f)): only what others promised him in Slack is recorded; his own Slack promises aren't.
      "Commitments found in his email: what he promised others (mitchell_owes) and what others promised him (owed_to_mitchell), with due dates and status. Commitments others made to him in Slack are found with search_slack kind commitment; commitments he makes in Slack aren't recorded."
    );
  });

  it("the labels, kinds and timeouts of tools 17-19 (C21)", () => {
    expect(CHAT_TOOLS.slice(16).map((t) => [t.name, t.label, t.kind, t.usesEmail, t.timeoutMs])).toEqual([
      ["search_slack", "Searching Slack", "read", false, 40_000],
      ["slack_digest", "Reading Slack digests", "read", false, 25_000],
      ["prepare_client_update", "Preparing a client update", "staged", true, 60_000]
    ]);
  });
});
