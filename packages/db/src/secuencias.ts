/**
 * El generador de códigos internos: EAN-13 con el prefijo 2.
 *
 * Un producto puede llegar sin código de barras (la libreta, el cuaderno suelto) y
 * necesita uno para venderse como los demás. Ese código lo inventa el sistema, y desde
 * ese momento es tan real como el de fábrica: va impreso en la etiqueta, se escanea en
 * la caja y no puede repetirse.
 *
 * El número **se reserva en la base**, no en el navegador. La operación es un
 * `UPDATE ... RETURNING` atómico sobre `barcode_sequences`: la fila se bloquea, se
 * entrega un número y se avanza el contador, todo en una sentencia. Dos llamadas
 * simultáneas no pueden recibir el mismo número aunque corran en dos procesos, porque
 * la segunda espera el cerrojo de la fila. Eso es lo que un contador en JavaScript no
 * puede dar.
 *
 * **Llama a esto dentro de la misma transacción que crea el producto.** No es una
 * recomendación de estilo: si el producto no llega a entrar (un `UNIQUE` que choca, un
 * fallo a mitad), la transacción se revierte y el número vuelve a estar libre. Fuera de
 * una transacción, cada reserva se confirma sola y un fallo posterior deja un hueco.
 *
 * Un hueco, por cierto, **no rompe nada** aquí: los códigos internos no exigen ser
 * consecutivos, sólo únicos. Es distinto de `device_seq` (docs/08 §3.1), donde un hueco
 * significa que falta un evento y el servidor lo va a pedir para siempre. Por eso este
 * contador puede permitirse un reintento; aquél no.
 *
 * El prefijo 2 es el que GS1 reserva para uso interno de la tienda (docs/03 §2). El
 * `UNIQUE` de `product_barcodes.codigo` sigue siendo la red de seguridad final: si
 * alguna vez se sembrara mal la secuencia, el `INSERT` del código falla y no entra un
 * dato malo.
 */

import { PREFIJO_INTERNO, construirEAN13Interno } from '@papeleria/core';

import type { ClienteSql } from './runner';

/** La secuencia no existe, o el prefijo no sirve para un EAN-13. */
export class ErrorSecuencia extends Error {}

export interface CodigoReservado {
  /** El EAN-13 completo, con su dígito verificador. */
  readonly codigo: string;
  /** El número reservado, sin el prefijo ni el verificador. */
  readonly secuencial: bigint;
}

/**
 * Reserva el siguiente código interno y lo devuelve ya formado.
 *
 * Devuelve también el secuencial porque es lo que se enseña en la pantalla del producto
 * («código interno nº 1 042»), y porque en una prueba es más fácil de mirar que el EAN.
 */
export async function reservarCodigoInterno(
  cliente: ClienteSql,
  prefijo: string = PREFIJO_INTERNO,
): Promise<CodigoReservado> {
  // Se valida antes de tocar la secuencia: un prefijo inválido no debe gastar un número
  // ni dejar la fila avanzada.
  if (!/^\d$/.test(prefijo)) {
    throw new ErrorSecuencia(
      `El prefijo "${prefijo}" no cabe en un EAN-13: tiene que ser un solo dígito (0-9).`,
    );
  }

  // `RETURNING` ve la fila YA actualizada, así que `siguiente - 1` es el número que se
  // acaba de reservar. La fila queda bloqueada hasta el COMMIT: dos llamadas a la vez
  // se serializan aquí. `longitud_total` no se lee: la restricción de la tabla ya
  // garantiza que es 13, que es el único formato que esta versión genera.
  const { rows } = await cliente.query<{ reservado: unknown }>(
    `UPDATE barcode_sequences
        SET siguiente = siguiente + 1,
            checkpoint_at = now()
      WHERE prefijo = $1
      RETURNING siguiente - 1 AS reservado`,
    [prefijo],
  );

  const fila = rows[0];
  if (fila === undefined) {
    throw new ErrorSecuencia(
      `No hay secuencia para el prefijo "${prefijo}". ` +
        `La siembra del prefijo '2' viene en la migración 0006_secuencias.sql; ` +
        `si esto falla en la app, es que las migraciones no corrieron.`,
    );
  }

  // `bigint` llega como string desde `pg` y como número o bigint desde PGlite.
  // `String()` cubre los tres sin perder precisión; `Number()` no.
  const secuencial = BigInt(String(fila.reservado));

  return {
    codigo: construirEAN13Interno(secuencial, prefijo),
    secuencial,
  };
}

/** Lo mismo, cuando sólo hace falta el código. Es lo que usa el alta de productos. */
export async function generarCodigoInterno(
  cliente: ClienteSql,
  prefijo: string = PREFIJO_INTERNO,
): Promise<string> {
  const { codigo } = await reservarCodigoInterno(cliente, prefijo);
  return codigo;
}
