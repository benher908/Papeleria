import { PGlite } from '@electric-sql/pglite';
import { compararHLC, hlcDeserializar, uuidV7 } from '@papeleria/core';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { ErrorContador, siguienteFolioLocal } from './contadores';
import {
  absorberHlc,
  emitirEvento,
  ErrorNoAutorizado,
  type DecisionAutorizacion,
  type EventoEmitido,
} from './eventos';
import { migrar, type ClienteSql, type ClienteTransaccional } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

// ─────────────────────────── datos de enganche ───────────────────────────
// Literales fijos: si falla una prueba, el mensaje dice exactamente qué fila es.

const ID_USUARIO = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_TERMINAL = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID_TURNO = 'cccccccc-0000-4000-8000-000000000003';
const ID_PRODUCTO = 'dddddddd-0000-4000-8000-000000000004';
const ID_ESCANER = 'eeeeeeee-0000-4000-8000-000000000005';
const ID_UNIDAD_PIEZA = '01900000-0000-7000-8002-000000000001';

/** El prefijo con el que se decide que la terminal no puede chocar con otra caja. */
const PREFIJO_TERMINAL = 'C1';

/**
 * Una autorización que permite todo, declarada aquí y no exportada.
 *
 * El evaluador de políticas existe desde la tarea 0.6 (`@papeleria/core`) y la
 * decisión real la pone `autorizar()`. Estos tests **no** la usan a propósito: lo
 * que comprueban es la transacción de `emitirEvento()` (que el estado, el evento y
 * los contadores entren juntos o no entren), y sembrar roles, permisos y políticas
 * para eso ataría cada test de transacción a los datos de autorización. Mezclar las
 * dos cosas haría que un cambio en las reglas rompiera tests que no son de reglas.
 *
 * Quien decide de verdad se prueba donde toca y contra las reglas reales:
 * `autorizacion.test.ts` corre la tabla del doc 06 §9 contra `0002` y `0005`, y el
 * panel del navegador vende una venta de verdad con el rol `dueno`.
 */
const permitirTodo = async (): Promise<DecisionAutorizacion> => ({
  permitido: true,
  motivo: 'prueba: aquí sólo se prueba la transacción, no las reglas',
  obligaciones: [],
});

interface PayloadVenta {
  venta_id: string;
  folio_local: string;
  total_minor: number;
  lineas: { product_id: string; qty: number; total_linea_minor: number }[];
}

const TOTAL_VENTA = 4500; // $45.00

// ─────────────────────────── montaje ───────────────────────────

let db: PGlite;
let cliente: ClienteTransaccional;

async function unaFila<T>(sql: string, params?: unknown[]): Promise<T> {
  const { rows } = await cliente.query<T>(sql, params);
  const fila = rows[0];
  if (fila === undefined) throw new Error(`Se esperaba una fila de: ${sql}`);
  return fila;
}

async function contar(tabla: string): Promise<number> {
  const fila = await unaFila<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`);
  return fila.n;
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));

  await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, 'duena', 'Dueña')`, [
    ID_USUARIO,
  ]);
  // `codigo` es el prefijo del folio: lo que impide que dos cajas coincidan (docs/08 §6).
  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo, codigo)
     VALUES ($1, $2, 'PC caja 1', 'terminal', $3)`,
    [ID_TERMINAL, ID_USUARIO, PREFIJO_TERMINAL],
  );
  // El celular sólo escanea: no vende, no lleva prefijo de folio.
  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo)
     VALUES ($1, $2, 'Celular', 'scanner')`,
    [ID_ESCANER, ID_USUARIO],
  );
  await cliente.query(
    `INSERT INTO cash_sessions (id, terminal_id, user_id, abierta_at) VALUES ($1, $2, $3, now())`,
    [ID_TURNO, ID_TERMINAL, ID_USUARIO],
  );
  await cliente.query(
    `INSERT INTO products (id, nombre, unit_id, precio_minor, costo_minor)
     VALUES ($1, 'Cuaderno Scribe 100 hojas', $2, 4500, 2800)`,
    [ID_PRODUCTO, ID_UNIDAD_PIEZA],
  );
});

beforeEach(async () => {
  // Sólo se limpia lo que cada prueba produce; los datos de enganche se quedan.
  await cliente.exec(
    `TRUNCATE outbox, audit_log, sale_lines, payments, sales,
              stock_movements, stock_levels, device_counters, folio_counters CASCADE`,
  );
});

afterAll(async () => {
  await db.close();
});

// ─────────────────────────── la venta de prueba ───────────────────────────

interface OpcionesVenta {
  autorizar?: (evento: EventoEmitido<'sale.created', PayloadVenta>) => Promise<DecisionAutorizacion>;
  /** Se ejecuta al final de la escritura del estado, para poder forzar un fallo. */
  romper?: (tx: ClienteSql) => Promise<void>;
  ahora?: () => number;
}

/**
 * El flujo real de caja, reducido: folio, venta, líneas y movimiento de stock.
 *
 * Se parece al POS a propósito. Una prueba que escribiera una fila de mentira en una
 * tabla de mentira demostraría que la transacción funciona, no que la venta funciona.
 */
async function vender(opciones: OpcionesVenta = {}) {
  return emitirEvento<'sale.created', PayloadVenta>(cliente, {
    tipo: 'sale.created',
    dispositivoId: ID_TERMINAL,
    usuarioId: ID_USUARIO,
    autorizar: opciones.autorizar ?? permitirTodo,
    ahora: opciones.ahora,

    // El payload se construye AQUÍ dentro, con el `event_id` y el `tx` a la vista:
    // el folio tiene que asignarse en la misma transacción que la venta.
    payload: async (tx, datos) => ({
      venta_id: uuidV7(),
      folio_local: await siguienteFolioLocal(tx, datos.device_id),
      total_minor: TOTAL_VENTA,
      lineas: [{ product_id: ID_PRODUCTO, qty: 1, total_linea_minor: TOTAL_VENTA }],
    }),

    aplicarEstado: async (tx, evento) => {
      const { venta_id, folio_local, total_minor, lineas } = evento.payload;

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
          evento.device_id,
          // ⭐ La columna que ata la venta a su evento. Si no coincidiera, el servidor
          // no podría saber qué venta vino de qué evento al proyectar el outbox.
          evento.event_id,
          evento.occurred_at,
        ],
      );

      let numero = 1;
      for (const linea of lineas) {
        await tx.query(
          `INSERT INTO sale_lines
             (id, sale_id, linea_no, product_id, descripcion, qty, qty_base,
              precio_unitario_minor, total_linea_minor)
           VALUES ($1, $2, $3, $4, 'Cuaderno Scribe 100 hojas', $5, $5, $6, $7)`,
          [
            uuidV7(),
            venta_id,
            numero++,
            linea.product_id,
            linea.qty,
            linea.total_linea_minor,
            linea.total_linea_minor,
          ],
        );

        await tx.query(
          `INSERT INTO stock_movements
             (id, product_id, qty, qty_base, motivo, ref_type, ref_id, user_id, device_id, ocurrido_at)
           VALUES ($1, $2, $3, $3, 'venta', 'sale', $4, $5, $6, $7)`,
          [uuidV7(), linea.product_id, -linea.qty, venta_id, ID_USUARIO, ID_TERMINAL, evento.occurred_at],
        );
      }

      if (opciones.romper !== undefined) await opciones.romper(tx);
    },
  });
}

// ────────────────────────────── pruebas ──────────────────────────────

describe('emitirEvento: estado y evento en una sola transacción', () => {
  test('una venta deja venta, líneas, stock, outbox y auditoría', async () => {
    const evento = await vender();

    const venta = await unaFila<{ id: string; evento_id: string; folio_local: string; total_minor: string }>(
      'SELECT id, evento_id, folio_local, total_minor FROM sales',
    );
    expect(venta.evento_id).toBe(evento.event_id);
    expect(venta.folio_local).toBe('C1-000001');
    expect(Number(venta.total_minor)).toBe(TOTAL_VENTA);

    expect(await contar('sale_lines')).toBe(1);
    expect(await contar('stock_movements')).toBe(1);

    // El saldo es derivado: lo mantiene el disparador del ledger, no el cajero.
    const saldo = await unaFila<{ qty_base: string }>('SELECT qty_base FROM stock_levels');
    expect(Number(saldo.qty_base)).toBe(-1);

    // ⭐ La cola: un solo evento, con el payload completo y el mismo `event_id`.
    const encolado = await unaFila<{ event_id: string; payload: EventoEmitido<'sale.created', PayloadVenta> }>(
      'SELECT event_id, payload FROM outbox',
    );
    expect(encolado.event_id).toBe(evento.event_id);
    expect(encolado.payload.event_id).toBe(evento.event_id);
    expect(encolado.payload.device_seq).toBe(1);
    expect(encolado.payload.payload.folio_local).toBe('C1-000001');
    expect(encolado.payload.schema_version).toBe(1);

    // La auditoría tampoco se puede olvidar: va en el mismo camino.
    const auditoria = await unaFila<{ accion: string; device_id: string }>(
      'SELECT accion, device_id FROM audit_log',
    );
    expect(auditoria.accion).toBe('sale.created');
    expect(auditoria.device_id).toBe(ID_TERMINAL);

    // Contador y folio quedaron avanzados: la transacción sí se confirmó.
    expect(Number((await unaFila<{ ultimo_seq: string }>('SELECT ultimo_seq FROM device_counters')).ultimo_seq)).toBe(1);
    expect(Number((await unaFila<{ ultimo_folio: string }>('SELECT ultimo_folio FROM folio_counters')).ultimo_folio)).toBe(1);

    // `event_log` es del SERVIDOR: el cliente sólo llena su outbox (docs/08 §1).
    expect(await contar('event_log')).toBe(0);
  });

  test('si el estado falla, NO queda nada: ni venta, ni evento, ni número gastado', async () => {
    // Es el caso que da sentido a todo el patrón: la luz se corta a mitad.
    await expect(
      vender({
        romper: async () => {
          throw new Error('se cortó la luz');
        },
      }),
    ).rejects.toThrow('se cortó la luz');

    expect(await contar('sales')).toBe(0);
    expect(await contar('sale_lines')).toBe(0);
    expect(await contar('stock_movements')).toBe(0);
    expect(await contar('outbox')).toBe(0);
    expect(await contar('audit_log')).toBe(0);

    // Estas dos son las que se olvidan. Si el contador no se revierte, el folio «se
    // pierde» (parece una venta borrada) y `device_seq` queda con un hueco que el
    // servidor reclamaría para siempre (docs/08 §3.1).
    //
    // No se comprueba que valgan 0: la fila NI SIQUIERA EXISTE, porque el INSERT que
    // la crea también iba dentro de la transacción que se revirtió. El rollback no
    // deja rastro, que es justo lo que se busca.
    expect(await contar('device_counters')).toBe(0);
    expect(await contar('folio_counters')).toBe(0);
  });

  test('un evento denegado no escribe nada y lo dice con el motivo', async () => {
    const motivo = 'venta mayor al límite sin autorización';

    await expect(
      vender({
        autorizar: async () => ({ permitido: false, motivo, obligaciones: ['marcar_para_revision'] }),
      }),
    ).rejects.toThrow(ErrorNoAutorizado);

    // El motivo tiene que llegar hasta arriba: un "no autorizado" sin explicación es
    // inútil para el dueño que está a media venta.
    await expect(
      vender({ autorizar: async () => ({ permitido: false, motivo, obligaciones: [] }) }),
    ).rejects.toThrow(motivo);

    expect(await contar('sales')).toBe(0);
    expect(await contar('outbox')).toBe(0);
    expect(await contar('device_counters')).toBe(0);
  });

  test('un intento fallido no se salta un device_seq ni un folio', async () => {
    const primera = await vender();
    await expect(vender({ romper: async () => Promise.reject(new Error('falló')) })).rejects.toThrow();
    const tercera = await vender();

    expect(primera.device_seq).toBe(1);
    expect(tercera.device_seq).toBe(2); // no 3

    const folios = await cliente.query<{ folio_local: string }>(
      'SELECT folio_local FROM sales ORDER BY folio_local',
    );
    expect(folios.rows.map((f) => f.folio_local)).toEqual(['C1-000001', 'C1-000002']);
  });

  test('los folios son consecutivos y no se repiten', async () => {
    for (let i = 0; i < 5; i++) await vender();

    const { rows } = await cliente.query<{ folio_local: string }>('SELECT folio_local FROM sales');
    expect(rows.map((r) => r.folio_local).sort()).toEqual([
      'C1-000001',
      'C1-000002',
      'C1-000003',
      'C1-000004',
      'C1-000005',
    ]);
  });

  test('el HLC no retrocede aunque el reloj del PC se vaya a 2010', async () => {
    const en2026 = Date.UTC(2026, 9, 19, 12, 0, 0);
    const en2010 = Date.UTC(2010, 0, 1);

    const a = await vender({ ahora: () => en2026 });
    const b = await vender({ ahora: () => en2010 });
    const c = await vender({ ahora: () => en2010 });

    expect(compararHLC(hlcDeserializar(a.hlc), hlcDeserializar(b.hlc))).toBeLessThan(0);
    expect(compararHLC(hlcDeserializar(b.hlc), hlcDeserializar(c.hlc))).toBeLessThan(0);

    // `occurred_at` sí refleja el reloj (equivocado): se ve y se puede avisar, en vez
    // de mentir con una fecha ordenada. El orden lo lleva el HLC.
    expect(new Date(b.occurred_at).getUTCFullYear()).toBe(2010);
  });

  test('la auditoría se puede precisar; por defecto usa el tipo del evento', async () => {
    await emitirEvento<'precio.cambiado', { product_id: string; antes: number; despues: number }>(
      cliente,
      {
        tipo: 'precio.cambiado',
        dispositivoId: ID_TERMINAL,
        usuarioId: ID_USUARIO,
        autorizar: permitirTodo,
        payload: () => ({ product_id: ID_PRODUCTO, antes: 4500, despues: 5000 }),
        aplicarEstado: async () => undefined,
        auditoria: { entidad: 'products', entidadId: ID_PRODUCTO, antes: 4500, despues: 5000 },
      },
    );

    const fila = await unaFila<{ accion: string; entidad: string; entidad_id: string; antes: unknown; despues: unknown }>(
      'SELECT accion, entidad, entidad_id, antes, despues FROM audit_log',
    );
    expect(fila.accion).toBe('precio.cambiado');
    expect(fila.entidad).toBe('products');
    expect(fila.entidad_id).toBe(ID_PRODUCTO);
    expect(Number(fila.antes)).toBe(4500);
    expect(Number(fila.despues)).toBe(5000);
  });

  test('absorber el HLC remoto deja el siguiente evento por encima de él', async () => {
    // Escenario real: el pull trae eventos de otro PC con el reloj adelantado.
    const remoto = { ts: Date.now() + 3_600_000, contador: 7, device: 'ffffffff' };
    const absorbido = await absorberHlc(cliente, ID_TERMINAL, remoto);

    expect(compararHLC(absorbido, remoto)).toBeGreaterThan(0);

    const propio = await vender();
    expect(compararHLC(hlcDeserializar(propio.hlc), remoto)).toBeGreaterThan(0);

    // Y no se gastó ningún `device_seq` por absorber: eso no es un evento.
    expect(propio.device_seq).toBe(1);
  });
});

describe('siguienteFolioLocal', () => {
  test('exige prefijo y lo dice claro: un escáner no vende', async () => {
    await expect(siguienteFolioLocal(cliente, ID_ESCANER)).rejects.toThrow(ErrorContador);
    await expect(siguienteFolioLocal(cliente, ID_ESCANER)).rejects.toThrow(/prefijo de folio/);
  });

  test('un dispositivo inexistente no puede recibir folio', async () => {
    await expect(siguienteFolioLocal(cliente, uuidV7())).rejects.toThrow();
    expect(await contar('folio_counters')).toBe(0);
  });
});
