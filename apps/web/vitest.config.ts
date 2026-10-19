import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Migrar sobre PGlite arranca un Postgres en WASM; la primera vez tarda.
    testTimeout: 60_000,
  },
});
