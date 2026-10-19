/**
 * SHA-256 del contenido de una migración, sin depender de Node.
 *
 * Se usa WebCrypto (`crypto.subtle`) en vez de `node:crypto` por una razón concreta:
 * el hash de una migración tiene que ser EXACTAMENTE el mismo en el servidor (Node) y
 * en el navegador (PGlite). Los dos lo guardan en `schema_migrations`, y el runner lo
 * usa para detectar que un archivo ya aplicado cambió. Si cada lado calculase su hash
 * con una implementación distinta, dos dispositivos con el mismo archivo registrarían
 * cadenas distintas y el detector de divergencias empezaría a dar falsos positivos —
 * o, peor, dejaría de detectar los reales.
 *
 * `globalThis.crypto` existe en Node desde la 19, así que una sola implementación
 * sirve para los dos lados. Es `async` porque `crypto.subtle` lo es; el resto del
 * camino (armarMigraciones) ya lo era.
 *
 * Nota: en el navegador `crypto.subtle` sólo existe en contexto seguro (HTTPS o
 * localhost). Es la misma condición que ya exige la elección de líder de PGlite, que
 * se apoya en Web Locks y también es sólo de contexto seguro. No agrega un requisito
 * nuevo: la app va por `https://` de todas formas (lo exige la cámara).
 */

/** SHA-256 en hexadecimal minúscula del texto dado. */
export async function hashDe(contenido: string): Promise<string> {
  const bytes = new TextEncoder().encode(contenido);
  const resumen = await crypto.subtle.digest('SHA-256', bytes);
  return aHexadecimal(new Uint8Array(resumen));
}

function aHexadecimal(bytes: Uint8Array): string {
  let salida = '';
  for (const byte of bytes) {
    salida += byte.toString(16).padStart(2, '0');
  }
  return salida;
}
