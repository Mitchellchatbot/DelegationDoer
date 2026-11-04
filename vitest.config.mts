import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the Executive AI Assistant layer (src/lib/exec/**).
//
// - "@/…" mirrors tsconfig's path alias.
// - "server-only" is a Next build-time marker package that isn't installed
//   (Next resolves it internally); tests stub it so server modules import.
// - Test files are excluded from the Next tsconfig (so `next build` never
//   type-checks them); `npm run typecheck:tests` covers them instead.
const src = fileURLToPath(new URL("./src/", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./src/lib/exec/__tests__/server-only-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: src },
      { find: /^server-only$/, replacement: serverOnlyStub }
    ]
  },
  test: {
    environment: "node",
    include: ["src/lib/exec/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20_000
  }
});
