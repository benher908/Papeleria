/**
 * El registro del service worker y el aviso de versión nueva.
 *
 * Sólo en producción. En desarrollo el service worker se comería el HMR: serviría
 * módulos cacheados y los cambios no aparecerían hasta cerrar la pestaña. El precio
 * es que el «funciona sin red» se prueba con `vite build` + `vite preview`, que es
 * exactamente como lo va a recibir la dueña.
 *
 * El aviso de versión es deliberadamente manual: un POS que se recarga solo a media
 * venta es un POS que pierde lo que estaban capturando. Se avisa y decide la persona.
 */

function mostrarBarraDeActualizacion(alRecargar: () => void): void {
  if (document.getElementById('aviso-version') !== null) return;

  const barra = document.createElement('div');
  barra.id = 'aviso-version';
  barra.className =
    'fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg ' +
    'border border-[var(--linea)] bg-[var(--tarjeta)] px-4 py-3 text-sm shadow-lg';

  const texto = document.createElement('span');
  texto.textContent = 'Hay una versión nueva de la app.';

  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className =
    'rounded-md border border-[var(--acento)] bg-[var(--acento)] px-3 py-1.5 ' +
    'text-sm font-medium text-white';
  boton.textContent = 'Recargar';
  boton.addEventListener('click', alRecargar);

  barra.append(texto, boton);
  document.body.append(barra);
}

export function registrarServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // Si la página ya estaba controlada, un `controllerchange` significa que entró una
  // versión nueva. Si no, es la primera instalación y no hay nada que avisar.
  const yaControlada = navigator.serviceWorker.controller !== null;
  let recargando = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!yaControlada || recargando) return;
    mostrarBarraDeActualizacion(() => {
      recargando = true;
      window.location.reload();
    });
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((causa: unknown) => {
      // Que falle el PWA no puede impedir trabajar: la app sigue siendo una web.
      console.warn('[pwa] no se pudo registrar el service worker', causa);
    });
  });
}
