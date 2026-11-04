import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import * as models from "@/lib/exec/llm/models";
import * as request from "@/lib/exec/llm/request";
import * as stream from "@/lib/exec/llm/stream";

// scripts/exec-llm-spike.cjs needs a real API key to do its job, which this
// box doesn't have. What can be proven offline is proven here: its loader and
// self-test (child process, no key in the environment), that it reads no
// other env var, its pure helpers, and its LIVE step code driven through the
// real SDK against canned API responses.

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "exec-llm-spike.cjs");

type Block = Record<string, unknown> & { type: string };
type ToolUse = { id: string; name: string; input: Record<string, unknown> };

interface SpikeModule {
  BINDING_BETA: string;
  LOCAL_TIME_TOOL: request.ExecToolDef;
  validateTriage(value: unknown): string[];
  localTimeIn(tz: string, now?: Date): { timezone: string; local_time: string; weekday: string; utc_offset: string };
  toolResultsFor(uses: ToolUse[], now?: Date): Block[];
  thinkingBlocks(message: { content: Block[] }): Block[];
  signatureProblems(message: { content: Block[] }): string[];
  textOnlyTurn(answer: string, uses: ToolUse[]): string;
  describeUsage(cost: (model: string, usage: unknown) => number, model: string, usage: unknown): string;
  describeError(err: unknown): string;
  runSteps(client: unknown, llm: unknown, print?: (line: string) => void): Promise<boolean[]>;
}

const spike = createRequire(import.meta.url)(SCRIPT) as SpikeModule;

function envWithoutKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

describe("exec-llm-spike.cjs as a program", () => {
  it("passes --self-test with no API key: real TS modules load through the require hook", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--self-test"], {
      cwd: ROOT,
      env: envWithoutKey(),
      encoding: "utf8",
      timeout: 60_000
    });
    expect(out).toContain("SELF-TEST PASS");
  });

  it("without a key prints usage and exits 2, before loading anything or touching the network", () => {
    let status: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, env: envWithoutKey(), encoding: "utf8", stdio: "pipe", timeout: 60_000 });
    } catch (err) {
      status = (err as { status: number | null }).status;
      stderr = String((err as { stderr: unknown }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toContain("Usage: ANTHROPIC_API_KEY=");
  });

  it("reads ANTHROPIC_API_KEY and no other environment variable, and never loads Vault/Supabase code", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const envReads = source.match(/process\.env(?:\.[A-Za-z0-9_]+|\[[^\]]*\])?/g) ?? [];
    expect(new Set(envReads)).toEqual(new Set(["process.env.ANTHROPIC_API_KEY"]));
    expect(source).not.toMatch(/require\([^)]*(anthropic-key|anthropic-client|supabase|dotenv)/);
    expect(source).not.toMatch(/get_secret/);
    // Explicit values keep the SDK from reading ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
    expect(source).toContain('baseURL: "https://api.anthropic.com"');
    expect(source).toContain("authToken: null");
  });
});

describe("spike helpers", () => {
  it("validates triage output against the schema", () => {
    expect(spike.validateTriage({ urgency: "critical", needs_reply: true, summary: "Client site down" })).toEqual([]);
    expect(spike.validateTriage({ urgency: "urgent", needs_reply: true, summary: "x" })).toEqual([
      'urgency "urgent" is not one of low/normal/high/critical'
    ]);
    expect(spike.validateTriage({ urgency: "low", needs_reply: "no", summary: " ", extra: 1 })).toEqual([
      "unexpected key extra",
      "needs_reply is not a boolean",
      "summary is not a non-empty string"
    ]);
    expect(spike.validateTriage([])).toEqual(["not a JSON object"]);
    expect(spike.validateTriage(null)).toEqual(["not a JSON object"]);
  });

  it("answers the tool from Intl, and throws for an unknown zone", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    expect(spike.localTimeIn("Asia/Tokyo", now)).toEqual({
      timezone: "Asia/Tokyo",
      local_time: "2026-11-04 09:00",
      weekday: "Wednesday",
      utc_offset: "GMT+9"
    });
    expect(spike.localTimeIn("America/New_York", now).local_time).toBe("2026-11-03 19:00");
    expect(() => spike.localTimeIn("Mars/Olympus_Mons", now)).toThrow(RangeError);
  });

  it("returns one tool_result per call, in order, with is_error for bad calls", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const results = spike.toolResultsFor(
      [
        { id: "t1", name: "get_local_time", input: { timezone: "Asia/Tokyo" } },
        { id: "t2", name: "get_local_time", input: { timezone: "Nowhere/Land" } },
        { id: "t3", name: "send_email", input: {} }
      ],
      now
    );
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2", "t3"]);
    expect(results[0]).not.toHaveProperty("is_error");
    expect(JSON.parse(String(results[0].content))).toMatchObject({ local_time: "2026-11-04 09:00" });
    expect(results[1]).toMatchObject({ is_error: true });
    expect(String(results[1].content)).toContain("Nowhere/Land");
    expect(results[2]).toMatchObject({ is_error: true, content: "unknown tool send_email" });
  });

  it("finds thinking blocks and flags empty signatures", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "", signature: "abc" },
        { type: "text", text: "x" },
        { type: "thinking", thinking: "y", signature: "" },
        { type: "thinking", thinking: "z" }
      ]
    };
    expect(spike.thinkingBlocks(message)).toHaveLength(3);
    expect(spike.signatureProblems(message)).toEqual([
      "content[2] is a thinking block with an empty signature",
      "content[3] is a thinking block with an empty signature"
    ]);
    expect(spike.signatureProblems({ content: [{ type: "text", text: "x" }] })).toEqual([]);
  });

  it("persists a turn as text plus the tool calls it made", () => {
    const uses = [{ id: "t1", name: "get_local_time", input: { timezone: "Asia/Tokyo" } }];
    expect(spike.textOnlyTurn("  It's 7 PM.  ", uses)).toBe('It\'s 7 PM.\n\n[tools used: get_local_time({"timezone":"Asia/Tokyo"})]');
    expect(spike.textOnlyTurn("Done.", [])).toBe("Done.");
    expect(spike.textOnlyTurn("", [])).toBe("(no text answer)");
  });

  it("describes usage and errors for the console", () => {
    expect(spike.describeUsage(() => 0.0123456789, "m", { input_tokens: 10, output_tokens: 2 })).toBe(
      "in=10 out=2 cache_read=0 cache_write=0 cost=$0.012346"
    );
    expect(spike.describeUsage(() => 0, "m", undefined)).toBe("in=0 out=0 cache_read=0 cache_write=0 cost=$0.000000");
    const apiErr = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "bound to a different conversation" } },
      undefined,
      { "request-id": "req_9" }
    );
    expect(spike.describeError(apiErr)).toBe("HTTP 400 · invalid_request_error · request req_9: bound to a different conversation");
    expect(spike.describeError(new Error("socket hang up"))).toBe("socket hang up");
    expect(spike.describeError("weird")).toBe("weird");
  });
});

// ---------------------------------------------------------------------------
// The live steps, through the real SDK, against canned responses
// ---------------------------------------------------------------------------

const SIG = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+/w==ErUBCkYIBRgCIkBX7xZPjmOnQRZp";

function sse(events: Record<string, unknown>[], requestId: string): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "request-id": requestId } });
}

function json(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": requestId } });
}

function start(model: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message_start",
    message: {
      id: "msg_s",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 700, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...extra
    }
  };
}

function textAnswer(text: string, withThinking = true, transformations: unknown[] = []): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [start("claude-opus-5-5", { input_transformations: transformations })];
  let i = 0;
  if (withThinking) {
    events.push(
      { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: `${SIG}-r${i}` } },
      { type: "content_block_stop", index: i }
    );
    i++;
  }
  events.push(
    { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: i, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: i },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 60 } },
    { type: "message_stop" }
  );
  return events;
}

function roundOne(opts: { thinking?: boolean; signature?: string } = {}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [start("claude-opus-5-5", { input_transformations: [] })];
  let i = 0;
  if (opts.thinking !== false) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Tokyo is 14h ahead." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: opts.signature ?? SIG } },
      { type: "content_block_stop", index: 0 }
    );
    i = 1;
  }
  events.push(
    { type: "content_block_start", index: i, content_block: { type: "tool_use", id: "toolu_live", name: "get_local_time", input: {} } },
    { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: '{"timezone": "Asi' } },
    { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: 'a/Tokyo"}' } },
    { type: "content_block_stop", index: i },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 120 } },
    { type: "message_stop" }
  );
  return events;
}

const haikuMessage = (text: string) => ({
  id: "msg_h",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 180, output_tokens: 30 }
});

type Seen = { body: Record<string, unknown>; headers: Record<string, string> };

function clientServing(responses: (() => Response)[], seen: Seen[]): Anthropic {
  return new Anthropic({
    apiKey: "sk-ant-test-not-a-real-key",
    authToken: null,
    baseURL: "https://api.anthropic.test",
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      const next = responses[seen.length - 1];
      if (!next) throw new Error(`unexpected request #${seen.length}`);
      return next();
    }) as unknown as ClientOptions["fetch"]
  });
}

const llm = { request, stream, models };

describe("spike live steps (canned API)", () => {
  it("passes all three steps and sends exactly what the spike claims to test", async () => {
    const seen: Seen[] = [];
    const client = clientServing(
      [
        () => json(haikuMessage('{"urgency":"critical","needs_reply":true,"summary":"Client site down since 7am"}'), "req_h"),
        () => sse(roundOne(), "req_r1"),
        () => sse(textAnswer("Tokyo is 09:00 tomorrow when it's 19:00 today for you."), "req_r2"),
        () => sse(textAnswer("That's 00:00 in London.", false), "req_r3")
      ],
      seen
    );
    const lines: string[] = [];
    const results = await spike.runSteps(client, llm, (l) => lines.push(l));
    expect(results, lines.join("\n")).toEqual([true, true, true]);
    expect(seen).toHaveLength(4);

    // Step 1: Haiku, json_schema output, not streamed, no beta needed.
    expect(seen[0].body).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low", format: { type: "json_schema" } }
    });
    expect(seen[0].body).not.toHaveProperty("stream");
    expect(seen[0].headers["anthropic-beta"]).toBeUndefined();

    // Steps 2–3: Opus, streamed, strict tool + auto, block_binding "error" under the beta.
    for (const call of seen.slice(1)) {
      expect(call.body).toMatchObject({
        model: "claude-opus-5-5",
        stream: true,
        tool_choice: { type: "auto" },
        tools: [spike.LOCAL_TIME_TOOL],
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
        output_config: { effort: "high" }
      });
      expect(call.headers["anthropic-beta"]).toBe(spike.BINDING_BETA);
      // The prefix the signatures are bound to must not move between rounds.
      expect(call.body.system).toEqual(seen[1].body.system);
      expect(call.body.tools).toEqual(seen[1].body.tools);
    }

    // Round 2 replays round 1's content byte-for-byte, then the tool result.
    const round2 = seen[2].body.messages as { role: string; content: unknown }[];
    expect(round2[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Tokyo is 14h ahead.", signature: SIG },
        { type: "tool_use", id: "toolu_live", name: "get_local_time", input: { timezone: "Asia/Tokyo" } }
      ]
    });
    const result = (round2[2].content as Block[])[0];
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_live" });
    expect(JSON.parse(String(result.content))).toMatchObject({ timezone: "Asia/Tokyo" });

    // Step 3 replays the finished turn as text only.
    const round3 = seen[3].body.messages as { role: string; content: unknown }[];
    expect(typeof round3[1].content).toBe("string");
    expect(String(round3[1].content)).toContain("[tools used: get_local_time");
    expect(JSON.stringify(round3)).not.toContain('"thinking"');
    expect(round3[2]).toEqual({ role: "user", content: "Thanks. And what time will that call be in London?" });

    expect(lines.join("\n")).toMatch(/request req_r1/);
    expect(lines.join("\n")).toMatch(/cost=\$/);
  });

  it("fails step 1 when the structured output breaks the enum", async () => {
    const client = clientServing(
      [
        () => json(haikuMessage('{"urgency":"urgent","needs_reply":true,"summary":"x"}'), "req_h"),
        () => sse(roundOne(), "req_r1"),
        () => sse(textAnswer("ok"), "req_r2"),
        () => sse(textAnswer("ok", false), "req_r3")
      ],
      []
    );
    const lines: string[] = [];
    expect(await spike.runSteps(client, llm, (l) => lines.push(l))).toEqual([false, true, true]);
    expect(lines.join("\n")).toContain('FAIL: urgency "urgent"');
  });

  it("fails step 2 (and skips 3) when round 1 has no thinking to verify", async () => {
    const client = clientServing(
      [() => json(haikuMessage('{"urgency":"low","needs_reply":false,"summary":"fyi"}'), "req_h"), () => sse(roundOne({ thinking: false }), "req_r1")],
      []
    );
    const lines: string[] = [];
    expect(await spike.runSteps(client, llm, (l) => lines.push(l))).toEqual([true, false, false]);
    expect(lines.join("\n")).toContain("no thinking blocks");
    expect(lines.join("\n")).toContain("skipped: step 2 failed");
  });

  it("fails step 2 on an empty signature — the bug the raw accumulator exists to avoid", async () => {
    const client = clientServing(
      [() => json(haikuMessage('{"urgency":"low","needs_reply":false,"summary":"fyi"}'), "req_h"), () => sse(roundOne({ signature: "" }), "req_r1")],
      []
    );
    const lines: string[] = [];
    expect(await spike.runSteps(client, llm, (l) => lines.push(l))).toEqual([true, false, false]);
    expect(lines.join("\n")).toContain("empty signature");
  });

  it("fails step 2 if the API reports it dropped a replayed thinking block", async () => {
    const drop = { type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "messages.1.content.0" };
    const client = clientServing(
      [
        () => json(haikuMessage('{"urgency":"low","needs_reply":false,"summary":"fyi"}'), "req_h"),
        () => sse(roundOne(), "req_r1"),
        () => sse(textAnswer("ok", true, [drop]), "req_r2")
      ],
      []
    );
    const lines: string[] = [];
    expect(await spike.runSteps(client, llm, (l) => lines.push(l))).toEqual([true, false, false]);
    expect(lines.join("\n")).toContain("the API dropped thinking");
  });

  it("reports the API's own error when round 2 is rejected", async () => {
    const client = clientServing(
      [
        () => json(haikuMessage('{"urgency":"low","needs_reply":false,"summary":"fyi"}'), "req_h"),
        () => sse(roundOne(), "req_r1"),
        () =>
          json(
            {
              type: "error",
              error: { type: "invalid_request_error", message: "Invalid `signature` in `thinking` block. The block is bound to a different conversation." }
            },
            "req_r2",
            400
          )
      ],
      []
    );
    const lines: string[] = [];
    expect(await spike.runSteps(client, llm, (l) => lines.push(l))).toEqual([true, false, false]);
    expect(lines.join("\n")).toMatch(/FAIL: HTTP 400 · invalid_request_error · request req_r2: .*different conversation/);
  });
});
