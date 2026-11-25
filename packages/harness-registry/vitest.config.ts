import { defineConfig } from "vitest/config";

// `pnpm run check` runs these tests beside its other tasks, where a loaded machine can take a test past Vitest's 5 s
// default: 30 s, as every other package's tests have (SPI-1400).
export default defineConfig({ test: { testTimeout: 30_000 } });
