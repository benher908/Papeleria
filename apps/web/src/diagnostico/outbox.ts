/**
 * Sección 4 del panel: ¿el estado y su evento entran juntos, o no entra ninguno?
 *
 * Es la pregunta central de la fase 0.5, y se contesta de la única forma que vale:
 * provocando el fallo. El botón «Vender y fallar a mitad» escribe la venta completa
 * —folio, venta, línea, movimiento de stock— y DESPUÉS revienta a propósito. Si el
 * mecanismo es correcto, la foto de la base queda idéntica a la de antes: ni venta, ni
 * evento en la cola, ni número de folio gastado.
 *
 * Los datos de enganche (dueña, terminal, turno, producto) se crean aquí y se marcan
 * con ids literales, para que se vea en la base que son de prueba y no del negocio.
 */

import { uuidV7 } from '@papeleria/core';
import {
  emitirEvento,
  siguienteFolioLocal,
  type EventoEmitido,
} from '@papeleria/db';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';

// Ids literales y con prefijos distintos (los 8 primeros caracteres son lo que el HLC
// usa para desempatar). No son datos del negocio: son el andamio de la prueba.
const ID_USUARIO = '0a000001-0000-7000-8000-000000000001';
const ID_TERMINAL = '0d000001-0000-7000-8000-000000000001';
const ID_TURNO = '0c000001-0000-7000-8000-000000000001';
const ID_PRODUCTO = '0b000001-0000-7000-8000-000000000001';

/** Unidad 'pieza', sembrada por 0003_seed_catalogos.sql. */
const ID_UNIDAD_PIEZA = '01900000-0000-7000-8002-000000000001';

const PREFIJO_TERMINAL = 'C1';
const TOTAL_MINOR = 4500;

export interface PayloadVentaPanel {
  venta_id: string;
  folio_local: string;
  total_minor: number;
}

/** Todo lo que la prueba mira: si algo se movió, se ve aquí. */
export interface Foto {
  ventas: number;
  lineas: number;
  movimientos: number;
  enCola: number;
  auditoria: number;
  ultimoSeq: number;
  ultimoFolio: number;
  ultimoFolioLocal: string | null;
}

export interface ResultadoEmision {
  evento: EventoEmitido<'sale.created', PayloadVentaPanel> | null;
  error: string | null;
  antes: Foto;
  despues: Foto;
}

/** Crea (si no están) las filas mínimas para poder vender. */
export async function prepararDatosDePrueba(base: BaseLocal): Promise<void> {
  await base.ejecutar(
    `INSERT INTO users (id, username, nombre) VALUES ($1, 'duena', 'Dueña')
     ON CONFLICT (id) DO NOTHING`,
    [ID_USUARIO],
  );
  await base.ejecutar(
    `INSERT INTO devices (id, user_id, nombre, tipo, codigo)
     VALUES ($1, $2, 'PC caja 1 (prueba)', 'terminal', $3)
     ON CONFLICT (id) DO NOTHING`,
    [ID_TERMINAL, ID_USUARIO, PREFIJO_TERMINAL],
  );
  await base.ejecutar(
    `INSERT INTO cash_sessions (id, terminal_id, user_id, abierta_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO NOTHING`,
    [ID_TURNO, ID_TERMINAL, ID_USUARIO],
  );
  await base.ejecutar(
    `INSERT INTO products (id, nombre, unit_id, precio_minor, costo_minor)
     VALUES ($1, 'Cuaderno Scribe 100 hojas (prueba)', $2, $3, 2800)
     ON CONFLICT (id) DO NOTHING`,
    [ID_PRODUCTO, ID_UNIDAD_PIEZA, TOTAL_MINOR],
  );
}

/**
 * Emite una venta de prueba. Con `fallar = true`, revienta justo después de escribir el
 * estado, que es el peor momento posible: es cuando un `try/catch` mal puesto dejaría la
 * venta guardada y el evento sin encolar.
 */
export async function emitirVentaDePrueba(base: BaseLocal, fallar: boolean): Promise<ResultadoEmision> {
  await prepararDatosDePrueba(base);

  const antes = await fotoDeLaBase(base);
  const cliente = comoClienteTransaccional(base);

  try {
    const evento = await emitirEvento<'sale.created', PayloadVentaPanel>(cliente, {
      tipo: 'sale.created',
      dispositivoId: ID_TERMINAL,
      usuarioId: ID_USUARIO,

      // El evaluador de políticas llega en la tarea 0.6. Aquí se permite todo a
      // propósito y con el motivo escrito: esto es un banco de pruebas, no el POS.
      autorizar: async () => ({
        permitido: true,
        motivo: 'panel de diagnóstico: el evaluador de políticas es la tarea 0.6',
        obligaciones: [],
      }),

      // El folio se asigna aquí dentro, no antes: así un fallo no quema un número.
      payload: async (tx, datos) => ({
        venta_id: uuidV7(),
        folio_local: await siguienteFolioLocal(tx, datos.device_id),
        total_minor: TOTAL_MINOR,
      }),

      aplicarEstado: async (tx, e) => {
        const { venta_id, folio_local, total_minor } = e.payload;

        await tx.query(
          `INSERT INTO sales
             (id, folio_local, cash_session_id, terminal_id, user_id,
              subtotal_minor, total_minor, estado, idempotency_key,
              device_id, evento_id, ocurrido_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 'completada', $7, $8, $9, $10)`,
          [
            venta_id,
            folio_local,
            ID_TURNO,
            ID_TERMINAL,
            ID_USUARIO,
            total_minor,
            uuidV7(),
            e.device_id,
            e.event_id,
            e.occurred_at,
          ],
        );

        await tx.query(
          `INSERT INTO sale_lines
             (id, sale_id, linea_no, product_id, descripcion, qty, qty_base,
              precio_unitario_minor, total_linea_minor)
           VALUES ($1, $2, 1, $3, 'Cuaderno Scribe 100 hojas (prueba)', 1, 1, $4, $4)`,
          [uuidV7(), venta_id, ID_PRODUCTO, total_minor],
        );

        await tx.query(
          `INSERT INTO stock_movements
             (id, product_id, qty, qty_base, motivo, ref_type, ref_id,
              user_id, device_id, ocurrido_at)
           VALUES ($1, $2, -1, -1, 'venta', 'sale', $3, $4, $5, $6)`,
          [uuidV7(), ID_PRODUCTO, venta_id, ID_USUARIO, ID_TERMINAL, e.occurred_at],
        );

        if (fallar) {
          throw new Error('fallo provocado por el panel: justo después de escribir el estado');
        }
      },
    });

    // El evento ya está en disco lógico; esto lo manda de verdad a IndexedDB. Es la
    // llamada que el POS hará al cerrar una venta (ver `relaxedDurability`).
    await base.sincronizar();

    return { evento, error: null, antes, despues: await fotoDeLaBase(base) };
  } catch (causa) {
    return {
      evento: null,
      error: causa instanceof Error ? causa.message : String(causa),
      antes,
      despues: await fotoDeLaBase(base),
    };
  }
}

/**
 * Borra todo lo que creó la demostración, en orden de dependencias.
 *
 * Es lo que hace que el botón se pueda pulsar cien veces: el folio vuelve a empezar
 * en C1-000001 y la base queda como recién migrada. Sólo toca las filas de estos ids
 * literales; no hay forma de que alcance un dato real.
 */
export async function borrarDatosDePrueba(base: BaseLocal): Promise<void> {
  await base.enTransaccion(async (tx) => {
    // Los movimientos y las líneas primero: son los que apuntan a la venta y al producto.
    await tx.ejecutar(`DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE device_id = $1)`, [ID_TERMINAL]);
    await tx.ejecutar(`DELETE FROM payments   WHERE sale_id IN (SELECT id FROM sales WHERE device_id = $1)`, [ID_TERMINAL]);
    await tx.ejecutar(`DELETE FROM stock_movements WHERE device_id = $1 OR product_id = $2`, [ID_TERMINAL, ID_PRODUCTO]);
    await tx.ejecutar(`DELETE FROM sales WHERE device_id = $1`, [ID_TERMINAL]);

    // El outbox no tiene columna de dispositivo: el dueño está en el payload.
    await tx.ejecutar(`DELETE FROM outbox WHERE payload->>'device_id' = $1`, [ID_TERMINAL]);
    await tx.ejecutar(`DELETE FROM audit_log WHERE device_id = $1`, [ID_TERMINAL]);

    // Los contadores: al borrarlos, el folio y el device_seq vuelven a 1.
    await tx.ejecutar(`DELETE FROM device_counters WHERE device_id = $1`, [ID_TERMINAL]);
    await tx.ejecutar(`DELETE FROM folio_counters  WHERE device_id = $1`, [ID_TERMINAL]);

    // Y el andamio.
    await tx.ejecutar(`DELETE FROM stock_levels WHERE product_id = $1`, [ID_PRODUCTO]);
    await tx.ejecutar(`DELETE FROM products WHERE id = $1`, [ID_PRODUCTO]);
    await tx.ejecutar(`DELETE FROM cash_sessions WHERE id = $1`, [ID_TURNO]);
    await tx.ejecutar(`DELETE FROM devices WHERE id = $1`, [ID_TERMINAL]);
    await tx.ejecutar(`DELETE FROM users WHERE id = $1`, [ID_USUARIO]);
  });

  await base.sincronizar();
}

export async function fotoDeLaBase(base: BaseLocal): Promise<Foto> {  const fila = await base.consultarUno<{
    ventas: number;
    lineas: number;
    movimientos: number;
    en_cola: number;
    auditoria: number;
    ultimo_seq: string;
    ultimo_folio: string;
    ultimo_folio_local: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM sales)::int            AS ventas,
       (SELECT count(*) FROM sale_lines)::int       AS lineas,
       (SELECT count(*) FROM stock_movements)::int  AS movimientos,
       (SELECT count(*) FROM outbox)::int           AS en_cola,
       (SELECT count(*) FROM audit_log)::int        AS auditoria,
       coalesce((SELECT ultimo_seq FROM device_counters WHERE device_id = $1), 0)::text   AS ultimo_seq,
       coalesce((SELECT ultimo_folio FROM folio_counters WHERE device_id = $1), 0)::text AS ultimo_folio,
       (SELECT folio_local FROM sales ORDER BY folio_local DESC LIMIT 1)                  AS ultimo_folio_local`,
    [ID_TERMINAL],
  );

  if (fila === undefined) throw new Error('No se pudo leer la foto de la base');

  return {
    ventas: fila.ventas,
    lineas: fila.lineas,
    movimientos: fila.movimientos,
    enCola: fila.en_cola,
    auditoria: fila.auditoria,
    ultimoSeq: Number(fila.ultimo_seq),
    ultimoFolio: Number(fila.ultimo_folio),
    ultimoFolioLocal: fila.ultimo_folio_local,
  };
}

/** `true` si la foto no cambió ni un poco: lo que debe pasar cuando el fallo es limpio. */
export function sinCambios(a: Foto, b: Foto): boolean {
  return (
    a.ventas === b.ventas &&
    a.lineas === b.lineas &&
    a.movimientos === b.movimientos &&
    a.enCola === b.enCola &&
    a.auditoria === b.auditoria &&
    a.ultimoSeq === b.ultimoSeq &&
    a.ultimoFolio === b.ultimoFolio
  );
}
