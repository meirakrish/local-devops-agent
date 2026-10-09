import { defineConfig } from "vitest/config";

// End-to-end tests against the kind demo cluster (`pnpm demo:up` first).
// Kept out of `pnpm test`, whose default pattern (*.test.ts) does not match *.e2e.ts.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
  },
});
