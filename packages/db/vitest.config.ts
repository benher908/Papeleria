import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // El runner de migraciones sobre PGlite arranca un Postgres en WASM; con el
    // valor por defecto de 5 s, la primera migración de un archivo puede pasarse.
    testTimeout: 60_000,
  },
});
