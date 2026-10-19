/**
 * Azar criptográfico para los identificadores.
 *
 * Tanto el ULID de los eventos como los UUID de las filas llevan una parte
 * aleatoria, y esa parte **no** puede salir de `Math.random()`: no es
 * criptográficamente seguro y, peor para este caso, es predecible. Dos
 * dispositivos podrían generar el mismo `event_id` y el sistema interpretaría el
 * segundo como un reintento del primero — es decir, se perdería una venta.
 *
 * `crypto.getRandomValues` es global en el navegador y en Node desde la 19, así
 * que una sola implementación sirve para los dos lados. Es exactamente la misma
 * razón por la que `hashDe` (en `@papeleria/db`) usa `crypto.subtle` en vez de
 * `node:crypto`.
 */

export class ErrorAzar extends Error {}

/** `n` bytes aleatorios criptográficamente seguros. */
export function bytesAleatorios(n: number): Uint8Array {
  if (!Number.isInteger(n) || n <= 0) {
    throw new ErrorAzar(`Cantidad de bytes inválida: ${n}`);
  }
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}
