import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Renderer tests run in happy-dom (a lightweight DOM) via `pnpm vitest run`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    // The git worktree (.worktrees/) holds a second copy of the repo; never
    // run its tests when running from the main checkout.
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/dist/**"],
    // RTL requires React's development build (React.act); vitest inherits
    // NODE_ENV from the shell, which may be "production" on Windows.
    env: { NODE_ENV: "development" },
  },
});
