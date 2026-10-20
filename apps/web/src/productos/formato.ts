/**
 * Dinero de la pantalla: centavos adentro, pesos afuera.
 *
 * La regla del proyecto es que **el dominio nunca ve números con decimales flotantes**:
 * los precios son `bigint` de centavos. La interfaz es la única que convierte, y lo
 * hace con las dos funciones que ya tienen pruebas en `@papeleria/core`:
 * `parsear()` para lo que teclea el humano y `formatear()` para lo que lee.
 *
 * `intentarCentavos()` existe para el caso normal de un formulario a medio llenar:
 * mientras alguien escribe "12." el campo no vale, y eso no es un error que haya que
 * enseñar todavía. Devuelve `null` y la vista decide si es un problema.
 */

import { formatear, formatearNumero, parsear } from '@papeleria/core';

export function pesos(minor: string | bigint): string {
  return formatear(typeof minor === 'bigint' ? minor : BigInt(minor));
}

/** Sin símbolo ni separador de miles: lo que va dentro de un `<input>`. */
export function pesosParaEditar(minor: string | bigint): string {
  return formatearNumero(typeof minor === 'bigint' ? minor : BigInt(minor));
}

export function intentarCentavos(texto: string): bigint | null {
  try {
    return parsear(texto);
  } catch {
    return null;
  }
}

/**
 * Margen sobre el precio de venta, en por ciento con dos decimales.
 *
 * Sobre el precio y no sobre el costo porque es lo que el dueño compara cuando ve
 * «$10.00» en el anaquel: de esos diez pesos, cuántos quedan. Se calcula en enteros
 * (multiplicar por 10 000 y dividir) para no meter un flotante en el camino.
 */
export function margenSobreVenta(precio: bigint, costo: bigint): number | null {
  if (precio <= 0n) return null;
  return Number(((precio - costo) * 10_000n) / precio) / 100;
}
