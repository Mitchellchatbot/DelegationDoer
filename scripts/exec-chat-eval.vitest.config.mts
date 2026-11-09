import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The opt-in chat eval's Vitest config (P5b contract §7 item 7). Used only by scripts/exec-chat-eval.mjs, which the
// team runs by hand with a test key; CI and the default config (vitest.config.mts, *.test.ts only) never load it.
//
// - include: the live eval only.
// - envDir: this folder, which holds no .env file, so no .env* of the repo is read.
// - One file, one worker, generous timeouts: each question is a real streamed tool loop.
const root = fileURLToPath(new URL("..", import.meta.url));
const src = fileURLToPath(new URL("../src/", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("../src/lib/exec/__tests__/server-only-stub.ts", import.meta.url));

export default defineConfig({
  root,
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: /^@\//, replacement: src },
      { find: /^server-only$/, replacement: serverOnlyStub }
    ]
  },
  test: {
    environment: "node",
    include: ["src/lib/exec/agent/eval/**/*.live.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000
  }
});
