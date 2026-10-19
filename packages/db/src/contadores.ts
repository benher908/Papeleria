/**
 * Los contadores que `emitirEvento()` necesita: `device_seq`, el HLC y el folio local.
 *
 * Ninguno se puede asignar "por fuera" de una transacción. Los tres son números que
 * deben ser **monótonos y sin huecos** dentro de un dispositivo, y los tres se leen y
 * se escriben aquí, en la misma transacción que el evento.
 *
 * Un hueco en `device_seq` no es cosmético: docs/08 §3.1 lo detecta al sincronizar y
 * pide reenviar el evento faltante. Si el hueco no tiene evento detrás, lo pedirá para
 * siempre. Por eso el contador también se revierte cuando la transacción se revierte.
 */

import { hlcAhora, hlcDeserializar, hlcSerializar, type HLC } from '@papeleria/core';
import type { ClienteSql } from './runner';

export class ErrorContador extends Error {}

export interface SeqYHlc {
  /** Consecutivo local del dispositivo. Empieza en 1. */
  seq: number;
  /** Reloj lógico ya serializado, listo para `event_log.hlc`. */
  hlc: string;
}

/**
 * Siguiente `device_seq` y siguiente HLC, en una sola operación.
 *
 * Los dos viven en la misma fila de `device_counters` a propósito: se leen y se
 * escriben juntos, así que no hay forma de avanzar uno sin el otro.
 */
export async function siguienteSeqYHlc(
  cliente: ClienteSql,
  dispositivoId: string,
  ahora: number = Date.now(),
): Promise<SeqYHlc> {
  // `DO UPDATE` con el mismo valor no cambia nada, pero TOMA EL CERROJO DE FILA hasta
  // el commit. Es lo que impide que dos emisiones simultáneas lean el mismo contador
  // y calculen el mismo HLC. Hoy PGlite ya serializa todo en una conexión, pero esto
  // tiene que seguir siendo correcto el día que corra contra un servidor de verdad.
  const actual = await cliente.query<{ ultimo_seq: unknown; ultimo_hlc: unknown }>(
    `INSERT INTO device_counters (device_id) VALUES ($1)
     ON CONFLICT (device_id) DO UPDATE SET device_id = device_counters.device_id
     RETURNING ultimo_seq, ultimo_hlc`,
    [dispositivoId],
  );

  const fila = actual.rows[0];
  if (fila === undefined) {
    throw new ErrorContador(`No se pudo leer el contador del dispositivo ${dispositivoId}`);
  }

  const ultimoSeq = aEnteroSeguro(fila.ultimo_seq, 'device_counters.ultimo_seq');
  const anterior = anteriorDesde(fila.ultimo_hlc, dispositivoId);

  const seq = ultimoSeq + 1;
  const hlc = hlcSerializar(hlcAhora(anterior, dispositivoId, ahora));

  await cliente.query(
    `UPDATE device_counters
        SET ultimo_seq = $2, ultimo_hlc = $3, actualizado_at = now()
      WHERE device_id = $1`,
    [dispositivoId, seq, hlc],
  );

  return { seq, hlc };
}

/**
 * Siguiente folio visible de esta terminal: `'C1-000123'`.
 *
 * El prefijo sale de `devices.codigo`, que es único entre dispositivos. Por eso dos
 * cajas no pueden generar el mismo folio aunque estén desconectadas: la coordinación
 * que haría falta la sustituye el prefijo (docs/08 §6).
 *
 * Se cuenta por `device_id` y no por el texto del prefijo: así un dedazo al corregir
 * el código no arranca un contador paralelo desde cero.
 */
export async function siguienteFolioLocal(
  cliente: ClienteSql,
  dispositivoId: string,
): Promise<string> {
  const { rows } = await cliente.query<{ numero: unknown; codigo: string | null }>(
    `WITH contador AS (
       INSERT INTO folio_counters (device_id, ultimo_folio) VALUES ($1, 1)
       ON CONFLICT (device_id) DO UPDATE
         SET ultimo_folio = folio_counters.ultimo_folio + 1, actualizado_at = now()
       RETURNING ultimo_folio
     )
     SELECT contador.ultimo_folio AS numero, devices.codigo
       FROM contador JOIN devices ON devices.id = $1`,
    [dispositivoId],
  );

  const fila = rows[0];
  if (fila === undefined) {
    throw new ErrorContador(
      `El dispositivo ${dispositivoId} no existe: no se le puede asignar un folio`,
    );
  }
  if (fila.codigo === null) {
    throw new ErrorContador(
      `El dispositivo ${dispositivoId} no tiene prefijo de folio (devices.codigo).\n` +
        `Sólo los dispositivos que venden lo necesitan; el escáner no lo lleva.`,
    );
  }

  const numero = aEnteroSeguro(fila.numero, 'folio_counters.ultimo_folio');
  if (numero < 1) throw new ErrorContador(`Folio fuera de rango: ${numero}`);

  return `${fila.codigo}-${String(numero).padStart(6, '0')}`;
}

/**
 * Convierte a número un valor que puede venir de la base en tres formas distintas.
 *
 * No es paranoia: `pg` devuelve `bigint` como **texto** (para no perder precisión) y
 * PGlite puede devolverlo como `bigint` o como número. Si el código asumiera una sola
 * forma, funcionaría en el navegador y fallaría en el servidor — o al revés, que es
 * peor porque se descubre en producción.
 */
function aEnteroSeguro(valor: unknown, campo: string): number {
  let n: number;
  if (typeof valor === 'number') n = valor;
  else if (typeof valor === 'bigint') n = Number(valor);
  else if (typeof valor === 'string') n = Number(valor);
  else throw new ErrorContador(`Valor inesperado en ${campo}: ${String(valor)}`);

  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ErrorContador(`${campo} no es un entero representable: ${String(valor)}`);
  }
  return n;
}

function anteriorDesde(valor: unknown, dispositivoId: string): HLC | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') {
    throw new ErrorContador(`HLC guardado con un tipo inesperado: ${String(valor)}`);
  }
  const hlc = hlcDeserializar(valor);
  // El HLC guardado lleva el dispositivo recortado a 8 caracteres; comprobar que
  // coincide detecta el caso de una fila copiada de otro dispositivo, que haría que
  // el contador local se mezclara con el de otro.
  if (hlc.device !== dispositivoId.slice(0, 8)) {
    throw new ErrorContador(
      `El HLC guardado pertenece a otro dispositivo ("${hlc.device}" ≠ ` +
        `"${dispositivoId.slice(0, 8)}"). La fila de device_counters está mezclada.`,
    );
  }
  return hlc;
}
