import { defineConfig } from "vitest/config";

// Every test runs in a plain Node environment: the shell's main-process
// modules take their filesystem, command, and Electron access through
// dependency injection, so no Electron binary is ever loaded by a test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
