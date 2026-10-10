import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git worktrees (e.g. of background agents) contain their own copy of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
