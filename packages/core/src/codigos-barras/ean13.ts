/**
 * CÓDIGOS DE BARRAS (docs/03).
 *
 * Decisiones que implementa este módulo:
 *   · EAN-13 es la simbología por defecto (la lee hasta un láser de $25).
 *   · El prefijo `2` en el EAN-13 está reservado por GS1 para uso interno del
 *     comercio: NUNCA choca con un producto de fabricante (que en México usa `750`).
 *   · Code 128 para etiquetas de anaquel / SKU legibles por humanos.
 *   · Un código se normaliza SIEMPRE antes de compararlo o guardarlo.
 */

export const LONGITUD_EAN13 = 13;
export const LONGITUD_BASE_EAN13 = 12;

/** GS1 reserva 20–29 para circulación restringida (uso interno del comercio). */
export const PREFIJO_INTERNO = '2';

/** Con prefijo de 1 dígito quedan 11 dígitos de secuencia: 99 999 999 999 códigos. */
export const MAXIMO_SECUENCIAL = 99_999_999_999n;

export class ErrorCodigo extends Error {}

// ───────────────────────── EAN-13 ─────────────────────────

/**
 * Dígito verificador de un EAN-13 a partir de sus 12 primeros dígitos.
 *
 * Pesos alternos 1 y 3, empezando con 1 en el primer dígito (índice par):
 *   7 5 0 1 2 3 4 5 6 7 8 9
 *   1 3 1 3 1 3 1 3 1 3 1 3
 *
 * Es el error de memoria más común: invertir los pesos produce códigos que el
 * lector rechaza, y tardas una tarde entera en darte cuenta.
 */
export function digitoVerificadorEAN13(primeros12: string): number {
  if (!/^\d{12}$/.test(primeros12)) {
    throw new ErrorCodigo(`Se esperan exactamente 12 dígitos (recibido: "${primeros12}")`);
  }
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(primeros12[i]);
    suma += i % 2 === 0 ? d : d * 3;
  }
  const resto = suma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

/** Agrega el dígito verificador a los 12 primeros dígitos. */
export function ean13Completo(primeros12: string): string {
  return primeros12 + String(digitoVerificadorEAN13(primeros12));
}

export function validaEAN13(codigo: string): boolean {
  if (!/^\d{13}$/.test(codigo)) return false;
  return digitoVerificadorEAN13(codigo.slice(0, 12)) === Number(codigo[12]);
}

export function esPrefijoInterno(codigo: string): boolean {
  return codigo.startsWith(PREFIJO_INTERNO);
}

/**
 * CONSTRUYE un EAN-13 interno a partir de un secuencial.
 *
 *   1 → '2000000000015'
 *   0 → '2000000000008'
 *
 * El secuencial se asigna desde la tabla `barcode_sequences` (docs/03 §4), con un
 * `UPDATE ... RETURNING` atómico. Esta función es pura: no toca la base.
 */
export function construirEAN13Interno(
  secuencial: number | bigint,
  prefijo: string = PREFIJO_INTERNO,
): string {
  if (!/^\d$/.test(prefijo)) throw new ErrorCodigo(`El prefijo debe ser un solo dígito: "${prefijo}"`);
  const n = typeof secuencial === 'bigint' ? secuencial : BigInt(Math.trunc(secuencial));
  if (n < 0n) throw new ErrorCodigo('El secuencial no puede ser negativo');
  if (n > MAXIMO_SECUENCIAL) {
    throw new ErrorCodigo(`El secuencial ${n} excede el máximo (${MAXIMO_SECUENCIAL})`);
  }
  const base = prefijo + n.toString().padStart(LONGITUD_BASE_EAN13 - 1, '0');
  return ean13Completo(base);
}

// ───────────────────────── CODE 128 ─────────────────────────

/**
 * Patrón de un código propio legible por humanos: 'PAP-LAP-MIR-2', 'ANAQ-A-3-12'.
 * Sin minúsculas ni espacios para que no haya dos formas de escribirlo.
 */
const PATRON_CODE128 = /^[A-Z0-9][A-Z0-9\-._/]{2,24}$/;

/** Normaliza ANTES de guardar o comparar. Un código, una sola forma de escribirlo. */
export function normalizarCodigo(texto: string): string {
  return texto.trim().toUpperCase().replace(/\s+/g, '');
}

export function validaCode128(texto: string): boolean {
  return PATRON_CODE128.test(normalizarCodigo(texto));
}

/**
 * 'A-3-12' → 'ANAQ-A-3-12'. La etiqueta del anaquel no es un producto (docs/03 §2).
 * Los espacios se vuelven guiones: escribir "a 3 12" significa lo mismo que "A-3-12".
 */
export function construirCodigoUbicacion(ubicacion: string, tipo: 'ANAQ' | 'BOD' = 'ANAQ'): string {
  const limpio = ubicacion
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9\-]/g, '');
  if (limpio === '' || limpio === '-') throw new ErrorCodigo('La ubicación no puede estar vacía');
  return `${tipo}-${limpio}`;
}
