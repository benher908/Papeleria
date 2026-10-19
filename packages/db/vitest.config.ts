import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // El runner de migraciones sobre PGlite arranca un Postgres en WASM; con el
    // valor por defecto de 5 s, la primera migración de un archivo puede pasarse.
    testTimeout: 60_000,
    // Y el `beforeAll` de los archivos de esquema todavía más: levanta PGlite, le aplica
    // las cuatro migraciones y luego hace lo mismo contra el PostgreSQL real. Se vio
    // fallar a los 10,5 s —el valor por defecto de `hookTimeout`— cuando `pnpm -r test`
    // corre este paquete a la vez que los demás y no queda CPU. El fallo salía como
    // «40 pruebas saltadas y 2 suites fallidas», que no se parece en nada a su causa.
    hookTimeout: 60_000,
  },
});
