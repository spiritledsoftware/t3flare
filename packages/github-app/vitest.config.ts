import { defineConfig } from "vitest/config";

// These tests sign with RSA through WebCrypto, on a thread pool `pnpm run check`'s other tasks share, where a loaded
// machine can take a test past Vitest's 5 s default: 30 s, as every other package's tests have (SPI-1400).
export default defineConfig({ test: { testTimeout: 30_000 } });
