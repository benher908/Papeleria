/**
 * UUID v7 — el identificador de las filas (docs/08 §2).
 *
 * Las columnas `id` del esquema son `uuid`, no `text`, así que los eventos usan
 * ULID (texto, 26 caracteres) pero las filas usan UUID. El diseño pedía
 * concretamente **v7** y no v4, y la razón es práctica: v7 empieza por el
 * instante de creación, así que `ORDER BY id` ordena por tiempo. Sin eso, la
 * tabla `outbox` en la que estás depurando aparece en orden aleatorio.
 *
 * Reparto de los 128 bits (RFC 9562):
 *
 *   · 48 bits  milisegundos
 *   ·  4 bits  versión (7)
 *   · 12 bits  azar
 *   ·  2 bits  variante (10)
 *   · 62 bits  azar
 *
 * Igual que el ULID, el azar entra inyectado para poder probar orden y unicidad.
 * Los dos generadores comparten `azar.ts`: la razón para usar azar criptográfico
 * es la misma y conviene que sea una sola.
 */

import { bytesAleatorios } from './azar';

const MAXIMO_TIEMPO = 2 ** 48 - 1;

export class ErrorUUID extends Error {}

/** Un UUID v7 nuevo a partir del instante (ms) y 10 bytes de azar. */
export function uuidV7(ahora: number = Date.now(), azar: Uint8Array = bytesAleatorios(10)): string {
  if (!Number.isInteger(ahora) || ahora < 0 || ahora > MAXIMO_TIEMPO) {
    throw new ErrorUUID(`Instante fuera de rango para un UUID v7: ${ahora}`);
  }
  if (azar.length !== 10) {
    throw new ErrorUUID(`El azar de un UUID v7 son 10 bytes (recibidos: ${azar.length})`);
  }

  const tiempo = ahora.toString(16).padStart(12, '0');
  // 12 bits de azar salen de los 12 bits bajos de los dos primeros bytes; los 4
  // altos del primero se descartan para que la versión quepa justo detrás.
  const azarA = (((obtener(azar, 0) & 0x0f) << 8) | obtener(azar, 1)).toString(16).padStart(3, '0');

  // Los 8 bytes restantes son los 62 bits bajos, con la variante en los 2 bits altos
  // del primero. `slice` copia: el arreglo del llamador no se toca.
  const resto = azar.slice(2, 10);
  resto[0] = (obtener(azar, 2) & 0x3f) | 0x80;
  const azarB = aHexadecimal(resto);

  return (
    `${tiempo.slice(0, 8)}-${tiempo.slice(8, 12)}-7${azarA}-` +
    `${azarB.slice(0, 4)}-${azarB.slice(4)}`
  );
}

/** Comprueba forma, versión 7 y variante RFC 4122. */
export function esUUIDv7Valido(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

/** El instante que un UUID v7 codifica. */
export function instanteDeUUIDv7(id: string): number {
  if (!esUUIDv7Valido(id)) throw new ErrorUUID(`No es un UUID v7 válido: "${id}"`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

function obtener(bytes: Uint8Array, indice: number): number {
  const valor = bytes[indice];
  if (valor === undefined) throw new ErrorUUID(`Byte fuera de rango: ${indice}`);
  return valor;
}

function aHexadecimal(bytes: Uint8Array): string {
  let salida = '';
  for (const byte of bytes) {
    salida += byte.toString(16).padStart(2, '0');
  }
  return salida;
}
