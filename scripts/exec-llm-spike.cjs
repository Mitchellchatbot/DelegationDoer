#!/usr/bin/env node
"use strict";

// Exec assistant LLM spike. The team runs it ONCE, locally, with an API key:
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/exec-llm-spike.cjs
//
// It checks, against the live API, what the P2a LLM layer is built on:
//   1. Haiku 5.5 structured output (output_config.format json_schema with an
//      enum) comes back as JSON that parses and validates.
//   2. An Opus 5.5 STREAMED two-round tool loop, read through our own raw-event
//      accumulator: round 1 returns tool_use and every thinking block has a
//      non-empty signature; round 2 (assistant content replayed verbatim plus
//      the tool_result) returns 200 with
//      thinking.block_binding.prefix_mismatch_behavior "error" under the
//      thinking-binding-controls-2026-08-01 beta.
//   3. A follow-up turn that replays the earlier turn as TEXT ONLY (no thinking
//      blocks, how exec persists conversations) also returns 200.
// Each step prints PASS or FAIL with usage and cost; any FAIL exits 1.
//
// It loads the REAL src/lib/exec/llm/{request,stream,models}.ts, transpiled on
// the fly, so it tests the code that ships rather than a copy.
//
// Safety:
// - It reads ANTHROPIC_API_KEY and nothing else from the environment: no
//   Vault, no Supabase, no .env file. Base URL and auth token are passed
//   explicitly so the SDK doesn't pick up ANTHROPIC_BASE_URL or
//   ANTHROPIC_AUTH_TOKEN either.
// - Don't run it with DEBUG=true: SDK 0.32.1 then logs request headers, the
//   key included.
// - Cost: three Opus calls (high effort) and one Haiku call; typically around
//   ten cents, and bounded by max_tokens at about a dollar.
//
// Offline check (no key, no network): node scripts/exec-llm-spike.cjs --self-test

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

// ---------------------------------------------------------------------------
// Loading the real TypeScript modules
// ---------------------------------------------------------------------------

let hookInstalled = false;

/**
 * Teach require() to load src/**.ts: transpile with typescript.transpileModule
 * (CommonJS, ES2022), resolve "@/x" to src/x, and stub the "server-only"
 * marker (Next resolves it at build time; it isn't an installed package).
 */
function installTsHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  const ts = require("typescript");

  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    const mapped = typeof request === "string" && request.startsWith("@/") ? path.join(SRC, request.slice(2)) : request;
    return originalResolve.call(this, mapped, parent, isMain, options);
  };

  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "server-only") return {};
    return originalLoad.apply(this, arguments);
  };

  Module._extensions[".ts"] = function (module, filename) {
    const rel = path.relative(SRC, filename);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`exec-llm-spike: refusing to transpile ${filename} (only src/ is loaded this way)`);
    }
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        isolatedModules: true
      }
    });
    module._compile(outputText, filename);
  };
}

function loadLlm() {
  installTsHook();
  return {
    request: require(path.join(SRC, "lib/exec/llm/request.ts")),
    stream: require(path.join(SRC, "lib/exec/llm/stream.ts")),
    models: require(path.join(SRC, "lib/exec/llm/models.ts"))
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    urgency: { type: "string", enum: ["low", "normal", "high", "critical"] },
    needs_reply: { type: "boolean" },
    summary: { type: "string" }
  },
  required: ["urgency", "needs_reply", "summary"],
  additionalProperties: false
};

/** Problems with a parsed triage result against TRIAGE_SCHEMA; [] when valid. */
function validateTriage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not a JSON object"];
  const problems = [];
  const allowed = Object.keys(TRIAGE_SCHEMA.properties);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`unexpected key ${key}`);
  if (!TRIAGE_SCHEMA.properties.urgency.enum.includes(value.urgency)) {
    problems.push(`urgency ${JSON.stringify(value.urgency)} is not one of ${TRIAGE_SCHEMA.properties.urgency.enum.join("/")}`);
  }
  if (typeof value.needs_reply !== "boolean") problems.push("needs_reply is not a boolean");
  if (typeof value.summary !== "string" || value.summary.trim() === "") problems.push("summary is not a non-empty string");
  return problems;
}

const LOCAL_TIME_TOOL = {
  name: "get_local_time",
  description: "Returns the current local date, time and UTC offset in an IANA time zone, e.g. Asia/Tokyo.",
  input_schema: {
    type: "object",
    properties: { timezone: { type: "string", description: "IANA time zone name, e.g. America/New_York" } },
    required: ["timezone"],
    additionalProperties: false
  },
  strict: true
};

/** The tool's answer. Throws RangeError for a zone Intl doesn't know. */
function localTimeIn(timezone, now = new Date()) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    timeZoneName: "shortOffset"
  });
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return {
    timezone,
    local_time: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
    utc_offset: parts.timeZoneName
  };
}

/** One tool_result per tool call, in order; a bad call gets an is_error result rather than being dropped. */
function toolResultsFor(uses, now = new Date()) {
  return uses.map((use) => {
    if (use.name !== LOCAL_TIME_TOOL.name) {
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `unknown tool ${use.name}` };
    }
    try {
      return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(localTimeIn(String(use.input.timezone), now)) };
    } catch (err) {
      return {
        type: "tool_result",
        tool_use_id: use.id,
        is_error: true,
        content: `invalid timezone ${JSON.stringify(use.input.timezone)}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  });
}

function thinkingBlocks(message) {
  return message.content.filter((b) => b.type === "thinking");
}

/** Thinking blocks whose signature is missing or empty — the failure SDK 0.32.1's MessageStream causes. */
function signatureProblems(message) {
  const out = [];
  message.content.forEach((b, i) => {
    if (b.type === "thinking" && (typeof b.signature !== "string" || b.signature.length === 0)) {
      out.push(`content[${i}] is a thinking block with an empty signature`);
    }
  });
  return out;
}

/** How exec persists a finished turn: the answer as text plus the tool calls it made (no thinking, no results). */
function textOnlyTurn(answerText, uses) {
  const text = answerText.trim() || "(no text answer)";
  const calls = uses.map((u) => `${u.name}(${JSON.stringify(u.input)})`).join(", ");
  return calls ? `${text}\n\n[tools used: ${calls}]` : text;
}

function describeUsage(costUsd, model, usage) {
  const u = usage || {};
  return (
    `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
    `cost=$${costUsd(model, u).toFixed(6)}`
  );
}

// The SDK's message for an HTTP error is the whole JSON body; print the API's
// own sentence (error.error.message) instead when there is one.
function describeError(err) {
  if (!err || typeof err !== "object") return String(err);
  const body = err.error && typeof err.error === "object" ? err.error.error : null;
  const type = body && typeof body.type === "string" ? body.type : null;
  const detail = (body && typeof body.message === "string" && body.message) || err.message || String(err);
  const bits = [err.status ? `HTTP ${err.status}` : null, type, err.request_id ? `request ${err.request_id}` : null].filter(Boolean);
  return `${bits.join(" · ")}${bits.length ? ": " : ""}${detail}`;
}

// ---------------------------------------------------------------------------
// The conversation the steps use (shared with --self-test)
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM = "You triage email for a busy founder. Answer only with the JSON the schema asks for.";
const TRIAGE_EMAIL =
  "From: ops@client-example.com\nSubject: Site is down\n\n" +
  "Hi Mitchell, our website has been down since 7am and we're losing orders. Can someone call me right away?";

const LOOP_SYSTEM =
  "You are a test assistant. Whenever the current time somewhere matters, call get_local_time; never guess the time.";
const LOOP_QUESTION =
  "I'm in New York. I need to call a colleague in Tokyo at 9:00 tomorrow morning, their time. " +
  "Use the tool to get Tokyo's current local time, then work out what my local time will be for that call.";
const FOLLOW_UP = "Thanks. And what time will that call be in London?";

function triageRequest(llm) {
  return llm.request.buildExecRequest({
    feature: "triage",
    system: TRIAGE_SYSTEM,
    messages: [{ role: "user", content: TRIAGE_EMAIL }],
    outputSchema: TRIAGE_SCHEMA
  });
}

// Spike's default effort is "low"; the loop asks for "high" so the model
// reliably thinks and there are signatures to check. Thinking counts toward
// max_tokens, so the cap is generous (only tokens generated are billed).
function loopRequest(llm, messages) {
  return llm.request.buildExecRequest({
    feature: "spike",
    system: LOOP_SYSTEM,
    tools: [LOCAL_TIME_TOOL],
    thinkingBinding: "error",
    effort: "high",
    maxTokens: 16_000,
    messages
  });
}

// ---------------------------------------------------------------------------
// Live steps
// ---------------------------------------------------------------------------

async function streamed(client, llm, request) {
  const betas = llm.request.requiredBetas(request);
  const options = betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : undefined;
  const { data, response } = await client.messages.create({ ...request, stream: true }, options).withResponse();
  const message = await llm.stream.accumulateStream(data);
  return { message, requestId: response.headers.get("request-id"), betas };
}

async function stepStructuredOutput(client, llm, log) {
  const request = triageRequest(llm);
  const { data, response } = await client.messages.create(request).withResponse();
  const message = llm.stream.messageFromResponse(data);
  log(`request ${response.headers.get("request-id")} · ${describeUsage(llm.models.costUsd, request.model, message.usage)}`);
  if (message.stop_reason !== "end_turn") return { pass: false, why: `stop_reason ${message.stop_reason}` };
  const text = llm.stream.messageText(message);
  log(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { pass: false, why: `output is not JSON: ${err.message}` };
  }
  const problems = validateTriage(parsed);
  return problems.length ? { pass: false, why: problems.join("; ") } : { pass: true };
}

async function stepToolLoop(client, llm, log) {
  const question = { role: "user", content: LOOP_QUESTION };

  const r1 = loopRequest(llm, [question]);
  const one = await streamed(client, llm, r1);
  const m1 = one.message;
  const uses = llm.stream.toolUses(m1);
  log(`round 1: request ${one.requestId} · betas ${one.betas.join(",")} · ${describeUsage(llm.models.costUsd, r1.model, m1.usage)}`);
  log(`round 1: stop_reason ${m1.stop_reason}, ${thinkingBlocks(m1).length} thinking block(s), ${uses.length} tool call(s)`);
  if (!one.betas.includes(BINDING_BETA)) return { pass: false, why: "the binding beta was not sent" };
  if (m1.stop_reason !== "tool_use" || uses.length === 0) return { pass: false, why: "round 1 did not return tool_use" };
  if (thinkingBlocks(m1).length === 0) {
    return { pass: false, why: "round 1 returned no thinking blocks, so signatures couldn't be checked; rerun" };
  }
  const sig1 = signatureProblems(m1);
  if (sig1.length) return { pass: false, why: `round 1: ${sig1.join("; ")}` };
  if (!llm.stream.isReplayable(m1)) {
    return { pass: false, why: `round 1 is not replayable (unknownDeltas ${m1.unknownDeltas}, toolInputErrors ${m1.toolInputErrors})` };
  }

  // Round 2: the assistant content goes back EXACTLY as streamed.
  const r2 = loopRequest(llm, [question, { role: "assistant", content: m1.content }, { role: "user", content: toolResultsFor(uses) }]);
  const two = await streamed(client, llm, r2);
  const m2 = two.message;
  log(`round 2: request ${two.requestId} · ${describeUsage(llm.models.costUsd, r2.model, m2.usage)}`);
  log(`round 2: stop_reason ${m2.stop_reason}; input_transformations ${JSON.stringify(m2.input_transformations ?? null)}`);
  log(`round 2: ${llm.stream.messageText(m2).slice(0, 300)}`);
  const sig2 = signatureProblems(m2);
  if (sig2.length) return { pass: false, why: `round 2: ${sig2.join("; ")}` };
  if (m2.stop_reason === null || m2.stop_reason === "refusal") return { pass: false, why: `round 2 stop_reason ${m2.stop_reason}` };
  // With "error" a changed prefix is a 400, never a silent drop; a drop here
  // means the replay was altered somewhere.
  const drops = (m2.input_transformations || []).filter((t) => t && t.type === "thinking_dropped");
  if (drops.length) return { pass: false, why: `round 2: the API dropped thinking: ${JSON.stringify(drops)}` };
  return { pass: true, transcript: { question, answer: textOnlyTurn(llm.stream.messageText(m2), uses) } };
}

async function stepTextReplay(client, llm, log, transcript) {
  const messages = [transcript.question, { role: "assistant", content: transcript.answer }, { role: "user", content: FOLLOW_UP }];
  if (JSON.stringify(messages).includes('"thinking"')) return { pass: false, why: "the text-only replay contains a thinking block" };
  const r3 = loopRequest(llm, messages);
  const three = await streamed(client, llm, r3);
  const m3 = three.message;
  log(`request ${three.requestId} · ${describeUsage(llm.models.costUsd, r3.model, m3.usage)}`);
  log(`stop_reason ${m3.stop_reason}: ${llm.stream.messageText(m3).slice(0, 300)}`);
  if (m3.stop_reason === null || m3.stop_reason === "refusal") return { pass: false, why: `stop_reason ${m3.stop_reason}` };
  return { pass: true };
}

/** Run the three steps with any SDK client; returns one pass/fail per step. */
async function runSteps(client, llm, print = console.log) {
  const results = [];
  async function run(label, fn) {
    print(`\n${label}`);
    const log = (line) => print(`    ${line}`);
    let outcome;
    try {
      outcome = await fn(log);
    } catch (err) {
      outcome = { pass: false, why: describeError(err) };
    }
    print(outcome.pass ? "  PASS" : `  FAIL: ${outcome.why}`);
    results.push(outcome.pass);
    return outcome;
  }

  await run("[1/3] Haiku 5.5 structured output (json_schema with an enum)", (log) => stepStructuredOutput(client, llm, log));
  const loop = await run("[2/3] Opus 5.5 streamed two-round tool loop, signatures kept, block_binding error", (log) =>
    stepToolLoop(client, llm, log)
  );
  await run("[3/3] Follow-up turn with the earlier turn replayed as text only", (log) =>
    loop.pass ? stepTextReplay(client, llm, log, loop.transcript) : { pass: false, why: "skipped: step 2 failed" }
  );
  return results;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error("Usage: ANTHROPIC_API_KEY=sk-ant-... node scripts/exec-llm-spike.cjs   (or --self-test, offline)");
    return 2;
  }
  const llm = loadLlm();
  const sdk = require("@anthropic-ai/sdk");
  const Anthropic = sdk.default || sdk;
  const client = new Anthropic({
    apiKey: apiKey.trim(),
    authToken: null,
    baseURL: "https://api.anthropic.com",
    fetch: globalThis.fetch,
    maxRetries: 2,
    timeout: 180_000
  });

  const results = await runSteps(client, llm);
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} step(s) FAILED` : "\nAll steps PASSED");
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// --self-test: the same requests and checks on canned data, no key or network
// ---------------------------------------------------------------------------

const CANNED_SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+/w==";

function cannedRoundOne() {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_canned",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 600, output_tokens: 1 },
        input_transformations: []
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: CANNED_SIGNATURE } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_canned", name: "get_local_time", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"timezone"' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ': "Asia/Tokyo"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 90 } },
    { type: "message_stop" }
  ];
}

async function selfTest() {
  const check = (ok, what) => {
    if (!ok) throw new Error(what);
  };
  const llm = loadLlm();
  check(llm.models.EXEC_MODELS.spike === "claude-opus-5-5", "spike is not mapped to claude-opus-5-5");
  check(llm.models.EXEC_MODELS.triage === "claude-haiku-5-5", "triage is not mapped to claude-haiku-5-5");

  const t = triageRequest(llm);
  check(t.model === "claude-haiku-5-5" && t.output_config.format && t.output_config.format.type === "json_schema", "triage request shape");
  check(validateTriage({ urgency: "high", needs_reply: true, summary: "Site down" }).length === 0, "valid triage rejected");
  check(validateTriage({ urgency: "urgent", needs_reply: "yes", extra: 1 }).length === 4, "invalid triage accepted");

  const question = { role: "user", content: LOOP_QUESTION };
  const r1 = loopRequest(llm, [question]);
  check(llm.request.requiredBetas(r1).includes(BINDING_BETA), "round 1 would not send the binding beta");
  check(r1.thinking.block_binding.prefix_mismatch_behavior === "error", "round 1 block_binding is not error");

  async function* events() {
    for (const e of cannedRoundOne()) yield e;
  }
  const m1 = await llm.stream.accumulateStream(events());
  const uses = llm.stream.toolUses(m1);
  check(thinkingBlocks(m1).length === 1 && signatureProblems(m1).length === 0, "the canned signature did not survive");
  check(m1.content[0].signature === CANNED_SIGNATURE, "the canned signature changed");
  check(uses.length === 1 && uses[0].input.timezone === "Asia/Tokyo", "the canned tool input did not parse");
  check(llm.stream.isReplayable(m1), "the canned round 1 is not replayable");

  const results = toolResultsFor(uses, new Date("2026-11-04T00:00:00Z"));
  check(results[0].tool_use_id === "toolu_canned" && !results[0].is_error, "tool result for Asia/Tokyo");
  check(JSON.parse(results[0].content).local_time === "2026-11-04 09:00", "Asia/Tokyo local time");
  check(toolResultsFor([{ ...uses[0], input: { timezone: "Mars/Olympus" } }])[0].is_error === true, "bad zone not flagged");

  // Both of these go through assertExecRequestShape inside buildExecRequest.
  loopRequest(llm, [question, { role: "assistant", content: m1.content }, { role: "user", content: results }]);
  const replay = [question, { role: "assistant", content: textOnlyTurn("It will be 7:00 PM tonight.", uses) }, { role: "user", content: FOLLOW_UP }];
  check(!JSON.stringify(replay).includes('"thinking"'), "text-only replay carries thinking");
  loopRequest(llm, replay);

  check(llm.models.costUsd("claude-opus-5-5", m1.usage) > 0, "canned usage priced at zero");
  console.log(`SELF-TEST PASS (round-1 usage: ${describeUsage(llm.models.costUsd, "claude-opus-5-5", m1.usage)})`);
  return 0;
}

module.exports = {
  BINDING_BETA,
  LOCAL_TIME_TOOL,
  TRIAGE_SCHEMA,
  describeError,
  describeUsage,
  installTsHook,
  loadLlm,
  localTimeIn,
  main,
  runSteps,
  selfTest,
  signatureProblems,
  textOnlyTurn,
  thinkingBlocks,
  toolResultsFor,
  validateTriage
};

if (require.main === module) {
  const run = process.argv.includes("--self-test") ? selfTest : main;
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(process.argv.includes("--self-test") ? `SELF-TEST FAIL: ${err && err.message}` : describeError(err));
      process.exit(1);
    }
  );
}
