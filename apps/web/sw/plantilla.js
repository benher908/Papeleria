/**
 * El service worker — la pieza que convierte la web en app instalable y sin red.
 *
 * Este archivo NO se sirve tal cual: es una plantilla. `vite.config.ts` la copia al
 * `dist` en cada build y le inyecta dos cosas (los marcadores se escriben aquí sin
 * dobles guiones bajos para que este comentario no se confunda con el código):
 *
 *   · VERSION  un hash de la lista de archivos. Cambia cuando cambia el build, y es
 *              lo que hace que el navegador vea un `sw.js` distinto y actualice.
 *   · SHELL    la lista completa de archivos del build, incluidos los .wasm y los
 *              .data de PGlite. Se guardan en la instalación, no al usarlos.
 *
 * ─── POR QUÉ SE PRECACHEA TODO Y NO SE DEJA PARA DESPUÉS ───────────────────
 *
 * La estrategia fácil («cachea lo que se vaya pidiendo») deja un agujero: al primer
 * arranque el service worker todavía no controla la página, así que los archivos que
 * se cargan antes de activarse no se guardan. La dueña instala, cierra, se va sin
 * internet y la app no abre. Precargar en la instalación evita depender de una
 * segunda visita.
 *
 * Son ~20 MB (PGlite trae su Postgres entero en WASM). Es una descarga única, en la
 * primera instalación, y es el precio de que la caja funcione sin red para siempre.
 *
 * ─── ESTRATEGIA ────────────────────────────────────────────────────────────
 *
 *   navegación  → caché primero. Abrir la app no espera a la red: es una caja.
 *   assets      → caché primero, y si falta, red y se guarda.
 *
 * Las URLs llevan hash de contenido, así que un archivo cacheado nunca queda viejo:
 * si cambia, cambia su nombre. El HTML sí es estable, y por eso la actualización se
 * resuelve con una versión nueva del SW que reemplaza la caché entera de una vez.
 */

const CACHE = 'papeleria-__VERSION__';
const PRECACHE = __SHELL__;

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // No esperar a que se cierren las pestañas: la versión nueva entra ya y la
      // página avisa («hay una versión nueva») para recargar cuando el dueño quiera.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    (async () => {
      const claves = await caches.keys();
      await Promise.all(
        claves.filter((clave) => clave !== CACHE).map((clave) => caches.delete(clave)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;

  // Sólo GET y sólo de este origen. Nada de la API ni de terceros pasa por aquí.
  if (peticion.method !== 'GET') return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  // Abrir la app: primero lo guardado. Sin red, sigue abriendo.
  if (peticion.mode === 'navigate') {
    evento.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match('/index.html', { ignoreVary: true })) ??
          (await fetch(peticion).catch(() => Response.error()))
        );
      })(),
    );
    return;
  }

  // Todo lo demás: caché primero, red si falta, y se guarda para la próxima.
  //
  // `ignoreVary` no es un atajo: el servidor manda `Vary: Origin`, y el `<script
  // type="module">` va en modo CORS con cabecera `Origin`, mientras que la descarga
  // de la instalación no la lleva. Sin esto, la caché «tiene» el archivo pero la
  // comparación dice que no, y la app se cae a la red justo cuando no hay red.
  // Es seguro ignorarla porque cada archivo lleva el hash de su contenido en el nombre:
  // no hay dos versiones del mismo URL que dependan de quién pregunta.
  evento.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const guardado = await cache.match(peticion, { ignoreVary: true });
      if (guardado !== undefined) return guardado;

      const respuesta = await fetch(peticion);
      if (respuesta.ok) await cache.put(peticion, respuesta.clone());
      return respuesta;
    })(),
  );
});
