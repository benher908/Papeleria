import { defineConfig } from 'vite';

export default defineConfig({
  // El worker de PGlite se publica como módulo ES, que es lo que espera
  // `new Worker(new URL(...), { type: 'module' })`. Sin esto, el build lo empaqueta
  // como IIFE y falla al intentar importar PGlite dentro del worker.
  worker: { format: 'es' },
});
