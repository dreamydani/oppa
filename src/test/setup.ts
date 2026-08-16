import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// RTL only auto-cleans between tests when vitest globals are enabled (they
// are not — tests import from "vitest" explicitly). Without this, mounted
// trees leak across tests: components from earlier tests keep re-running
// effects when the shared store is reset, corrupting mock/instance counts.
afterEach(() => {
  cleanup();
});
