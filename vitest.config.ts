import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    include: ["tests/**/*.test.ts"],

    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      // Report all source files, not just the ones imported during tests
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/",
        "dist/",
        "out/",
        "**/*.d.ts",
        "tests/",
        "vitest.config.ts"
      ],
    },
  },
});
