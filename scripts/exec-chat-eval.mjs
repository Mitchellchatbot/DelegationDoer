#!/usr/bin/env node
// The opt-in chat eval (P5b contract §7 item 7, B11, B12). THE TEAM RUNS IT, locally, with a TEST key; never CI:
//
//   EXEC_EVAL=1 ANTHROPIC_API_KEY=sk-ant-... node scripts/exec-chat-eval.mjs
//
// It runs src/lib/exec/agent/eval/__tests__/chat-eval.live.ts under scripts/exec-chat-eval.vitest.config.mts: the
// brief's 16 questions through the real loop, model and tool registry, over fixture data (every DD, mail and Supabase
// read is mocked; nothing is written). One line per question; exit 1 when a hard check fails.
//
// Safety:
// - It refuses to run without EXEC_EVAL=1 and ANTHROPIC_API_KEY.
// - It never reads a .env file: the child gets a minimal environment (the key, EXEC_EVAL, EXEC_ENABLED, and what the
//   OS needs to start a process), so no Supabase, Vault or other credential of this shell reaches it.
// - Don't run it with DEBUG=true: SDK 0.32.1 then logs request headers, the key included.
// - Cost: 16 Opus 5.5 turns at effort medium, typically a few dollars in all; each turn is capped by the loop's own
//   limits (12 calls, $1.50).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.EXEC_EVAL !== "1") {
  console.error("exec-chat-eval: refusing to run. Set EXEC_EVAL=1 (and ANTHROPIC_API_KEY to a test key) to run the live eval.");
  process.exit(2);
}
if (typeof process.env.ANTHROPIC_API_KEY !== "string" || process.env.ANTHROPIC_API_KEY.trim() === "") {
  console.error("exec-chat-eval: refusing to run. ANTHROPIC_API_KEY (a test key) is not set.");
  process.exit(2);
}
if (process.env.DEBUG === "true") {
  console.error("exec-chat-eval: refusing to run with DEBUG=true (the SDK would log the key).");
  process.exit(2);
}

// What a Node child needs to start on Windows, macOS and Linux; nothing else from this shell.
const PASS_THROUGH = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec"];
const env = {};
for (const key of PASS_THROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
Object.assign(env, {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  EXEC_EVAL: "1",
  EXEC_ENABLED: "true",
  NODE_ENV: "test"
});

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const config = path.join(root, "scripts", "exec-chat-eval.vitest.config.mts");
const run = spawnSync(process.execPath, [vitest, "run", "--config", config, "--reporter=default"], { cwd: root, env, stdio: "inherit" });
if (run.error) {
  console.error(`exec-chat-eval: could not start vitest (${run.error.code ?? "error"})`);
  process.exit(1);
}
process.exit(run.status === 0 ? 0 : 1);
