import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PLANTILLA_SW = fileURLToPath(new URL('./sw/plantilla.js', import.meta.url));

/** Lo que no sale del bundle pero tiene que estar guardado para abrir sin red. */
const FIJOS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

/**
 * Genera `sw.js` con la lista exacta de archivos del build.
 *
 * Se hace aquí y no con una librería (Workbox) por dos razones: la lista de archivos
 * ya la tiene el bundler en la mano, y el service worker entero son cien líneas que
 * conviene poder leer. Una dependencia de build que genera un archivo opaco sería más
 * código del que hay que entender para confiar en que la caja abre sin internet.
 *
 * La versión es un hash de la plantilla y de la lista de archivos: los nombres de los
 * assets ya llevan el hash de su contenido, así que si cambia algo —el código o el
 * service worker mismo— la versión cambia y el navegador actualiza.
 */
function serviceWorker(): Plugin {
  return {
    name: 'papeleria-sw',
    apply: 'build',

    generateBundle(_opciones, paquete) {
      const archivos = Object.keys(paquete)
        .filter((nombre) => /\.(js|css|wasm|data|png|svg|woff2?)$/.test(nombre))
        .sort();

      const precache = [...new Set([...FIJOS, ...archivos.map((nombre) => `/${nombre}`)])];
      const plantilla = readFileSync(PLANTILLA_SW, 'utf8');

      // La versión cubre también la plantilla: si cambia la lógica del service worker
      // sin que cambie ningún asset, la caché tiene que renovarse igual.
      const version = createHash('sha256')
        .update(`${plantilla}|${precache.join('|')}`)
        .digest('hex')
        .slice(0, 10);

      const codigo = plantilla
        .replaceAll('__VERSION__', version)
        .replaceAll('__SHELL__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: codigo });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  // El worker de PGlite se publica como módulo ES, que es lo que espera
  // `new Worker(new URL(...), { type: 'module' })`. Sin esto, el build lo empaqueta
  // como IIFE y falla al intentar importar PGlite dentro del worker.
  worker: { format: 'es' },
});
