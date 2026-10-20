/**
 * AYUDANTES DE PANTALLA — lo mínimo compartido entre el panel y la entrada.
 *
 * Estaban dentro de `diagnostico/panel.ts` y ahora hay dos pantallas. Se extraen a un solo
 * sitio en vez de copiarlos: dos versiones de `crear()` se separan en cuanto alguien
 * arregle un detalle en una sola de las dos, y entonces hay dos maneras de construir el
 * mismo botón.
 *
 * Nada de esto conoce la lógica de la tienda: son nodos, mensajes de error y esperas.
 */

export function crear<K extends keyof HTMLElementTagNameMap>(
  etiqueta: K,
  clase?: string,
  texto?: string,
): HTMLElementTagNameMap[K] {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

/** El mensaje de un error, sin asumir que lo que se lanzó era un `Error`. */
export function mensaje(causa: unknown): string {
  if (causa instanceof Error) return causa.message;
  return String(causa);
}

export function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

export function aviso(
  titulo: string,
  lineas: readonly string[],
  siguientes: readonly string[] = [],
): HTMLElement {
  const caja = crear('div', 'aviso');
  caja.append(crear('strong', undefined, titulo));
  for (const linea of lineas) caja.append(crear('p', undefined, linea));
  if (siguientes.length > 0) {
    const lista = crear('ul');
    for (const siguiente of siguientes) lista.append(crear('li', undefined, siguiente));
    caja.append(lista);
  }
  return caja;
}

/**
 * ¿Qué le falta a este navegador para poder abrir la base?
 *
 * Se comprueba ANTES de intentar abrirla, para que el mensaje diga la causa real y no un
 * «no se pudo abrir» que obliga a leer la consola. Es la capa 0 del proyecto: contexto
 * seguro, Web Locks, worker e IndexedDB.
 */
export function capasQueFaltan(): string[] {
  const faltan: string[] = [];

  if (!window.isSecureContext) {
    faltan.push(
      'Esta página no es un contexto seguro. Web Locks (navigator.locks) y crypto.subtle sólo existen en https:// o en localhost; sin ellos PGlite no puede elegir un líder.',
    );
  }
  if (typeof navigator.locks?.request !== 'function') {
    faltan.push('El navegador no expone la API Web Locks, que es la que garantiza un solo dueño de la base.');
  }
  if (typeof Worker === 'undefined') {
    faltan.push('El navegador no tiene Web Workers, y PGlite tiene que correr en uno.');
  }
  if (typeof indexedDB === 'undefined') {
    faltan.push('El navegador no tiene IndexedDB, que es donde se guarda la base.');
  }

  return faltan;
}
