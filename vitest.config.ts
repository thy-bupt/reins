import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // macOS tar creates AppleDouble "._*" companions that must never be
    // collected as test files (they break the parser on Windows)
    exclude: ["**/._*", "**/node_modules/**"],
    environment: "node",
  },
});
