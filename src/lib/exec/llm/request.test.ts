import { describe, expect, it } from "vitest";

import {
  ExecRequestShapeError,
  THINKING_BINDING_BETA,
  assertExecRequestShape,
  buildExecRequest,
  contentProblems,
  requiredBetas,
  type ExecMessageParam,
  type ExecToolDef
} from "@/lib/exec/llm/request";

const tool: ExecToolDef = {
  name: "get_local_time",
  description: "Current local time in an IANA zone.",
  input_schema: {
    type: "object",
    properties: { timezone: { type: "string" } },
    required: ["timezone"],
    additionalProperties: false
  },
  strict: true
};

const userTurn: ExecMessageParam = { role: "user", content: "What time is it in Tokyo?" };

function valid(): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" }
  };
}

function problemsOf(params: unknown): string[] {
  try {
    assertExecRequestShape(params);
  } catch (err) {
    expect(err).toBeInstanceOf(ExecRequestShapeError);
    return (err as ExecRequestShapeError).problems;
  }
  return [];
}

describe("buildExecRequest", () => {
  it("fills model, effort, output cap and adaptive thinking from the feature", () => {
    const req = buildExecRequest({ feature: "triage", system: "Classify.", messages: [userTurn] });
    expect(req).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 4000,
      system: [{ type: "text", text: "Classify." }],
      messages: [userTurn],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" }
    });
  });

  it.each([
    ["chat", "claude-opus-5-5", "medium", 16000],
    ["draft", "claude-opus-5-5", "medium", 16000],
    ["brief", "claude-opus-5-5", "high", 32000],
    ["voice", "claude-opus-5-5", "medium", 8000],
    ["spike", "claude-opus-5-5", "low", 4000],
    ["triage", "claude-haiku-5-5", "low", 4000],
    ["digest", "claude-haiku-5-5", "low", 4000]
  ] as const)("%s → %s at %s effort, %i max tokens", (feature, model, effort, maxTokens) => {
    const req = buildExecRequest({ feature, system: "s", messages: [userTurn] });
    expect(req.model).toBe(model);
    expect(req.output_config.effort).toBe(effort);
    expect(req.max_tokens).toBe(maxTokens);
  });

  it("caches the system prompt by default for chat, draft, brief and voice", () => {
    for (const feature of ["chat", "draft", "brief", "voice"] as const) {
      const req = buildExecRequest({ feature, system: "Static system prompt.", messages: [userTurn] });
      expect(req.system).toEqual([{ type: "text", text: "Static system prompt.", cache_control: { type: "ephemeral" } }]);
    }
  });

  it("does not cache by default for triage, digest and spike", () => {
    for (const feature of ["triage", "digest", "spike"] as const) {
      const req = buildExecRequest({ feature, system: "s", messages: [userTurn] });
      expect(req.system?.[0]).not.toHaveProperty("cache_control");
    }
  });

  it("honours an explicit cacheSystem either way", () => {
    expect(buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], cacheSystem: false }).system).toEqual([
      { type: "text", text: "s" }
    ]);
    expect(buildExecRequest({ feature: "triage", system: "s", messages: [userTurn], cacheSystem: true }).system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } }
    ]);
  });

  it("puts cache_control on the LAST system block only, without mutating the input", () => {
    const system = [
      { type: "text" as const, text: "Rules." },
      { type: "text" as const, text: "" },
      { type: "text" as const, text: "Tool guide." }
    ];
    const snapshot = JSON.stringify(system);
    const req = buildExecRequest({ feature: "chat", system, messages: [userTurn] });
    expect(req.system).toEqual([
      { type: "text", text: "Rules." },
      { type: "text", text: "Tool guide.", cache_control: { type: "ephemeral" } }
    ]);
    expect(JSON.stringify(system)).toBe(snapshot);
  });

  it("drops extra fields callers put on system blocks", () => {
    const sneaky = [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] as unknown as {
      type: "text";
      text: string;
    }[];
    expect(buildExecRequest({ feature: "triage", system: sneaky, messages: [userTurn] }).system).toEqual([
      { type: "text", text: "x" }
    ]);
  });

  it("omits system entirely when it is empty", () => {
    expect(buildExecRequest({ feature: "chat", system: "", messages: [userTurn] })).not.toHaveProperty("system");
    expect(buildExecRequest({ feature: "chat", system: [], messages: [userTurn] })).not.toHaveProperty("system");
  });

  it("drops whitespace-only system blocks, so the cache marker moves to the last real one", () => {
    const req = buildExecRequest({
      feature: "chat",
      system: [
        { type: "text", text: "  Rules.\n" },
        { type: "text", text: "\n" },
        { type: "text", text: " \t " }
      ],
      messages: [userTurn]
    });
    // Real text is kept byte-for-byte (it is the cached prefix); only blank blocks go.
    expect(req.system).toEqual([{ type: "text", text: "  Rules.\n", cache_control: { type: "ephemeral" } }]);
    expect(buildExecRequest({ feature: "chat", system: " \n\t", messages: [userTurn] })).not.toHaveProperty("system");
  });

  it("leaves a system block whose text isn't a string for the guard to name, rather than dropping it", () => {
    const broken = [{ type: "text", text: "Rules." }, { type: "text" }] as unknown as { type: "text"; text: string }[];
    expect(() => buildExecRequest({ feature: "chat", system: broken, messages: [userTurn] })).toThrow(
      /system\[1\] must be a text block with non-whitespace text/
    );
  });

  it("refuses to build a user turn with no text in it (an email with an empty body, say)", () => {
    expect(() => buildExecRequest({ feature: "triage", system: "s", messages: [{ role: "user", content: " \n\t" }] })).toThrow(
      /messages\[0\]\.content is only whitespace/
    );
  });

  it("adds tools with tool_choice auto, and nothing when there are none", () => {
    const withTools = buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], tools: [tool] });
    expect(withTools.tools).toEqual([tool]);
    expect(withTools.tool_choice).toEqual({ type: "auto" });
    const without = buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], tools: [] });
    expect(without).not.toHaveProperty("tools");
    expect(without).not.toHaveProperty("tool_choice");
  });

  it("puts a structured-output schema under output_config.format", () => {
    const schema = {
      type: "object",
      properties: { urgency: { type: "string", enum: ["low", "high"] } },
      required: ["urgency"],
      additionalProperties: false
    };
    const req = buildExecRequest({ feature: "triage", system: "s", messages: [userTurn], outputSchema: schema });
    expect(req.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema } });
  });

  it("sets thinking.block_binding when asked, and the binding beta follows", () => {
    const req = buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], thinkingBinding: "error" });
    expect(req.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } });
    expect(requiredBetas(req)).toEqual([THINKING_BINDING_BETA]);
    expect(THINKING_BINDING_BETA).toBe("thinking-binding-controls-2026-08-01");
    const drop = buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], thinkingBinding: "drop_block" });
    expect(drop.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
    expect(requiredBetas(buildExecRequest({ feature: "chat", system: "s", messages: [userTurn] }))).toEqual([]);
  });

  it("takes maxTokens and effort overrides", () => {
    const req = buildExecRequest({ feature: "spike", system: "s", messages: [userTurn], maxTokens: 4096, effort: "high" });
    expect(req.max_tokens).toBe(4096);
    expect(req.output_config.effort).toBe("high");
  });

  it("copies the messages array so later pushes to the caller's history don't leak in", () => {
    const history: ExecMessageParam[] = [userTurn];
    const req = buildExecRequest({ feature: "chat", system: "s", messages: history });
    history.push({ role: "assistant", content: "later" });
    expect(req.messages).toHaveLength(1);
  });

  it("refuses to build a prefill (last message from the assistant)", () => {
    expect(() =>
      buildExecRequest({
        feature: "chat",
        system: "s",
        messages: [userTurn, { role: "assistant", content: "The time is" }]
      })
    ).toThrow(ExecRequestShapeError);
  });

  it("refuses a non-strict tool even at build time", () => {
    const loose = { ...tool, strict: false } as unknown as ExecToolDef;
    expect(() => buildExecRequest({ feature: "chat", system: "s", messages: [userTurn], tools: [loose] })).toThrow(
      /strict: true/
    );
  });
});

describe("assertExecRequestShape", () => {
  it("passes a minimal valid request", () => {
    expect(problemsOf(valid())).toEqual([]);
  });

  it("passes a full tool-loop request with thinking, tool_use and tool_result replayed", () => {
    const params = {
      ...valid(),
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [tool],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
      messages: [
        userTurn,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3h" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "tool_use", id: "toolu_1", name: "get_local_time", input: { timezone: "Asia/Tokyo" } },
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "09:00" }] }
      ]
    };
    expect(problemsOf(params)).toEqual([]);
  });

  it("passes structured output and nested strict schemas", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }
        },
        choice: { anyOf: [{ type: "string" }, { type: "object", properties: {}, additionalProperties: false }] }
      },
      $defs: { thing: { type: "object", properties: {}, additionalProperties: false } },
      required: ["items"],
      additionalProperties: false
    };
    expect(problemsOf({ ...valid(), output_config: { effort: "low", format: { type: "json_schema", schema } } })).toEqual([]);
  });

  it("throws a fatal, named error listing every problem", () => {
    let caught: unknown;
    try {
      assertExecRequestShape({ ...valid(), temperature: 0.2, top_k: 5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecRequestShapeError);
    const e = caught as ExecRequestShapeError;
    expect(e.name).toBe("ExecRequestShapeError");
    expect(e.errorClass).toBe("fatal");
    expect(e.problems).toHaveLength(2);
    expect(e.message).toContain("temperature");
    expect(e.message).toContain("top_k");
  });

  it("rejects a non-object request", () => {
    expect(problemsOf(null)).toEqual(["request must be an object"]);
    expect(problemsOf([])).toEqual(["request must be an object"]);
    expect(problemsOf("model")).toEqual(["request must be an object"]);
  });

  const forbidden: [string, (p: Record<string, unknown>) => void, RegExp][] = [
    ["temperature", (p) => (p.temperature = 0), /temperature/],
    ["top_p", (p) => (p.top_p = 0.9), /top_p/],
    ["top_k", (p) => (p.top_k = 40), /top_k/],
    ["top-level budget_tokens", (p) => (p.budget_tokens = 1024), /budget_tokens/],
    ["budget_tokens inside thinking", (p) => (p.thinking = { type: "adaptive", budget_tokens: 2048 }), /thinking\.budget_tokens/],
    ["temperature inside thinking", (p) => (p.thinking = { type: "adaptive", temperature: 1 }), /thinking\.temperature/],
    ["thinking disabled", (p) => (p.thinking = { type: "disabled" }), /thinking\.type must be "adaptive"/],
    ["thinking enabled + budget", (p) => (p.thinking = { type: "enabled", budget_tokens: 4000 }), /thinking\.type/],
    ["thinking null", (p) => (p.thinking = null), /thinking must be an object/],
    ["bad block_binding", (p) => (p.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "ignore" } }), /block_binding/],
    ["tool_choice any", (p) => (p.tool_choice = { type: "any" }), /tool_choice/],
    ["tool_choice tool", (p) => (p.tool_choice = { type: "tool", name: "get_local_time" }), /tool_choice/],
    ["tool_choice none", (p) => (p.tool_choice = { type: "none" }), /tool_choice/],
    ["tool_choice null", (p) => (p.tool_choice = null), /tool_choice/],
    ["messages empty", (p) => (p.messages = []), /non-empty array/],
    ["messages missing", (p) => delete p.messages, /non-empty array/],
    ["assistant prefill", (p) => (p.messages = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), /last message must be from the user/],
    ["assistant first", (p) => (p.messages = [{ role: "assistant", content: "a" }, { role: "user", content: "b" }]), /first message/],
    ["system role in messages", (p) => (p.messages = [{ role: "user", content: "a" }, { role: "system", content: "b" }]), /role must be/],
    ["empty string content", (p) => (p.messages = [{ role: "user", content: "" }]), /content is empty/],
    ["empty block content", (p) => (p.messages = [{ role: "user", content: "a" }, { role: "assistant", content: [] }, { role: "user", content: "b" }]), /content is empty/],
    ["content of the wrong type", (p) => (p.messages = [{ role: "user", content: 42 }]), /content must be a string/],
    ["thinking block without signature", (p) => (p.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "" }, { type: "text", text: "b" }] },
      { role: "user", content: "c" }
    ]), /without a signature/],
    ["tool without strict", (p) => (p.tools = [{ ...tool, strict: undefined }]), /strict: true/],
    ["tool with strict false", (p) => (p.tools = [{ ...tool, strict: false }]), /strict: true/],
    ["tool without additionalProperties:false", (p) => (p.tools = [{ ...tool, input_schema: { type: "object", properties: {} } }]), /input_schema must set additionalProperties: false/],
    ["tool with additionalProperties:true", (p) => (p.tools = [{ ...tool, input_schema: { ...tool.input_schema, additionalProperties: true } }]), /additionalProperties: false/],
    ["tool with an open nested object", (p) => (p.tools = [{
      ...tool,
      input_schema: { type: "object", properties: { where: { type: "object", properties: { tz: { type: "string" } } } }, additionalProperties: false }
    }]), /input_schema\.properties\.where must set additionalProperties: false/],
    ["tool schema not an object schema", (p) => (p.tools = [{ ...tool, input_schema: { type: "string" } }]), /must be an object schema/],
    ["tools not an array", (p) => (p.tools = tool), /tools must be an array/],
    ["tool entry not an object", (p) => (p.tools = ["get_local_time"]), /tools\[0\] must be an object/],
    ["server tool (no schema)", (p) => (p.tools = [{ type: "web_search_20260209", name: "web_search" }]), /strict: true/],
    ["model outside the exec map", (p) => (p.model = "claude-opus-5"), /not an exec model/],
    ["model missing", (p) => delete p.model, /not an exec model/],
    ["max_tokens zero", (p) => (p.max_tokens = 0), /max_tokens/],
    ["max_tokens fractional", (p) => (p.max_tokens = 10.5), /max_tokens/],
    ["max_tokens over the model cap", (p) => (p.max_tokens = 128_001), /max_tokens/],
    ["unknown effort", (p) => (p.output_config = { effort: "extreme" }), /effort/],
    ["output_config not an object", (p) => (p.output_config = "high"), /output_config must be an object/],
    ["format not json_schema", (p) => (p.output_config = { effort: "low", format: { type: "json_object" } }), /json_schema/],
    ["open object in the output schema", (p) => (p.output_config = { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: {} } } }), /output_config\.format\.schema must set additionalProperties: false/],
    ["open nullable object (type array)", (p) => (p.output_config = { effort: "low", format: { type: "json_schema", schema: {
      type: "object", additionalProperties: false, properties: { maybe: { type: ["object", "null"], properties: {} } }
    } } }), /properties\.maybe must set additionalProperties: false/],
    ["open object with properties but no type", (p) => (p.output_config = { effort: "low", format: { type: "json_schema", schema: {
      type: "object", additionalProperties: false, $defs: { thing: { properties: { a: { type: "string" } } } }
    } } }), /\$defs\.thing must set additionalProperties: false/],
    ["thinking block with no signature at all", (p) => (p.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "b" }] },
      { role: "user", content: "c" }
    ]), /content\[0\] is a thinking block without a signature/],
    ["redacted_thinking without its data", (p) => (p.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "redacted_thinking" }, { type: "text", text: "b" }] },
      { role: "user", content: "c" }
    ]), /messages\[1\]\.content\[0\] is a redacted_thinking block without its data/],
    // Text the API refuses: "text content blocks must be non-empty" / "must contain non-whitespace text".
    ["whitespace-only user string", (p) => (p.messages = [{ role: "user", content: "  \n\t" }]), /messages\[0\]\.content is only whitespace/],
    ["whitespace-only assistant string", (p) => (p.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: " " },
      { role: "user", content: "b" }
    ]), /messages\[1\]\.content is only whitespace/],
    ["empty user text block", (p) => (p.messages = [{ role: "user", content: [{ type: "text", text: "" }] }]), /messages\[0\]\.content\[0\] is a text block without text/],
    ["whitespace-only user text block", (p) => (p.messages = [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "09:00" },
      { type: "text", text: "\n " }
    ] }]), /messages\[0\]\.content\[1\] is a text block with only whitespace/],
    ["text block whose text isn't a string", (p) => (p.messages = [{ role: "user", content: [{ type: "text", text: 7 }] }]), /content\[0\] is a text block without text/],
    ["empty assistant text block", (p) => (p.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "b" }] },
      { role: "user", content: "c" }
    ]), /messages\[1\]\.content\[0\] is a text block without text/],
    ["a block with no type", (p) => (p.messages = [{ role: "user", content: [{ text: "hi" }] }]), /messages\[0\]\.content\[0\] is not a content block/],
    ["a block that isn't an object", (p) => (p.messages = [{ role: "user", content: ["hi"] }]), /messages\[0\]\.content\[0\] is not a content block/],
    // A hand-built request: the builder drops blank system blocks itself.
    ["whitespace-only system block", (p) => (p.system = [
      { type: "text", text: "Rules." },
      { type: "text", text: " \n", cache_control: { type: "ephemeral" } }
    ]), /system\[1\] must be a text block with non-whitespace text/],
    ["empty system block", (p) => (p.system = [{ type: "text", text: "" }]), /system\[0\] must be a text block/],
    ["system block of another type", (p) => (p.system = [{ type: "image", source: {} }]), /system\[0\] must be a text block/],
    ["whitespace-only system string", (p) => (p.system = "  "), /system has no non-whitespace text/],
    ["system of the wrong type", (p) => (p.system = 42), /system must be a string or an array of text blocks/]
  ];

  it.each(forbidden)("rejects %s", (_label, mutate, expected) => {
    const params = valid();
    mutate(params);
    const problems = problemsOf(params);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(expected);
  });

  it("lets whitespace-only text through in a replayed assistant turn (the API's own output goes back verbatim)", () => {
    const params = {
      ...valid(),
      messages: [
        { role: "user", content: "a" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "\n\n" },
            { type: "tool_use", id: "toolu_1", name: "get_local_time", input: { timezone: "UTC" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "09:00" }] }
      ]
    };
    expect(problemsOf(params)).toEqual([]);
  });

  it("accepts a non-blank system string, and finds nothing to flag in an empty system array", () => {
    expect(problemsOf({ ...valid(), system: "Rules." })).toEqual([]);
    expect(problemsOf({ ...valid(), system: [] })).toEqual([]);
  });

  it("ignores sampling keys that are explicitly undefined (JSON drops them)", () => {
    expect(problemsOf({ ...valid(), temperature: undefined })).toEqual([]);
  });

  it("accepts thinking omitted (adaptive is the default on both 5.5 models)", () => {
    const params = valid();
    delete params.thinking;
    expect(problemsOf(params)).toEqual([]);
  });

  it("accepts output_config omitted, or a format without an explicit effort", () => {
    const params = valid();
    delete params.output_config;
    expect(problemsOf(params)).toEqual([]);
    const schema = { type: "object", properties: {}, additionalProperties: false };
    expect(problemsOf({ ...valid(), output_config: { format: { type: "json_schema", schema } } })).toEqual([]);
  });

  it("contentProblems reports paths relative to the turn, holding only user turns to the whitespace rule", () => {
    const blocks = [
      { type: "text", text: " \n" },
      { type: "thinking", thinking: "", signature: "EqQBCgIYAhIM" },
      { type: "tool_use", id: "toolu_1", name: "get_local_time", input: { timezone: "UTC" } }
    ];
    expect(contentProblems(blocks, "assistant")).toEqual([]);
    expect(contentProblems(blocks, "user")).toEqual(["content[0] is a text block with only whitespace"]);
    expect(contentProblems([{ type: "text", text: "" }, { type: "thinking", thinking: "x", signature: "" }], "assistant")).toEqual([
      "content[0] is a text block without text",
      "content[1] is a thinking block without a signature"
    ]);
    expect(contentProblems("Hi", "user")).toEqual([]);
    expect(contentProblems("", "assistant")).toEqual(["content is empty"]);
    expect(contentProblems(null, "user")).toEqual(["content must be a string or an array of blocks"]);
  });

  it("stops walking absurdly deep schemas instead of recursing forever", () => {
    let node: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };
    const root = node;
    for (let i = 0; i < 200; i++) {
      const child: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };
      (node.properties as Record<string, unknown>).next = child;
      node = child;
    }
    expect(problemsOf({ ...valid(), output_config: { effort: "low", format: { type: "json_schema", schema: root } } })).toEqual([]);
  });
});
