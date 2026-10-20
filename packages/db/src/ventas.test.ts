import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { abrirTurno, resumenTurno } from './caja';
import { ErrorNoAutorizado } from './eventos';
import { buscarProductoPorCodigo, crearProducto } from './productos';
import { migrar, type ClienteTransaccional } from './runner';
import {
  cancelarVenta,
  ErrorVenta,
  obtenerVenta,
  registrarVenta,
  type VentaRegistrada,
} from './ventas';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

const ID_DUENA = '01900000-0000-7000-9000-000000000001';
const ID_TERMINAL = '01900000-0000-7000-9000-000000000003';
const ID_SESION = '01900000-0000-7000-9000-000000000004';
const ROL_DUENO = '01900000-0000-7000-8000-000000000001';
const UNIDAD_PIEZA = '01900000-0000-7000-8002-000000000001';

let db: PGlite;
let cliente: ClienteTransaccional;

const contexto = { usuarioId: ID_DUENA, dispositivoId: ID_TERMINAL };
const AHORA = Date.UTC(2026, 9, 19, 16, 0, 0);

async function contar(sql: string, params?: unknown[]): Promise<number> {
  const { rows } = await cliente.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));

  await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, 'duena', 'Dueña')`, [ID_DUENA]);
  await cliente.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [ID_DUENA, ROL_DUENO]);
  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo, codigo)
     VALUES ($1, $2, 'PC caja 1', 'terminal', 'C1')`,
    [ID_TERMINAL, ID_DUENA],
  );
});

beforeEach(async () => {
  await cliente.exec(
    `TRUNCATE outbox, audit_log, cash_movements, payments, sale_lines, sales, returns,
              return_lines, stock_levels, stock_movements, cash_sessions, step_up_grants,
              sessions, product_barcodes, product_presentations, products CASCADE;
     DELETE FROM folio_counters;
     DELETE FROM device_counters;
     UPDATE barcode_sequences SET siguiente = 1 WHERE prefijo = '2';`,
  );
});

afterAll(async () => {
  await db.close();
});

async function preparar(): Promise<{ turnoId: string; productoId: string; codigo: string }> {
  const creado = await crearProducto(
    cliente,
    { nombre: 'Cuaderno Scribe 100 hojas', unitId: UNIDAD_PIEZA, precioMinor: 4500n, costoMinor: 2800n },
    { ...contexto, ahora: AHORA },
  );
  const turno = await abrirTurno(cliente, { fondoInicialMinor: 50000n }, { ...contexto, ahora: AHORA });
  return { turnoId: turno.id, productoId: creado.id, codigo: creado.codigos[0] as string };
}

async function unaVentaCobrada(): Promise<VentaRegistrada> {
  const { turnoId, productoId } = await preparar();
  return registrarVenta(
    cliente,
    {
      turnoId,
      lineas: [{ productoId, qty: 1000 }],
      pagos: [{ metodo: 'efectivo', montoMinor: 20000n }],
    },
    { ...contexto, ahora: AHORA },
  );
}

describe('registrar una venta', () => {
  test('una venta de $45 con $200: total, IVA, folio, cambio, stock y evento', async () => {
    const venta = await unaVentaCobrada();

    expect(venta.folioLocal).toBe('C1-000001');
    expect(venta.totalMinor).toBe(4500n);
    // IVA incluido: 4500 / 1.16 = 3879 (base) + 621 (IVA) = 4500.
    expect(venta.subtotalMinor + venta.impuestoMinor).toBe(4500n);
    expect(venta.impuestoMinor).toBe(621n);
    expect(venta.cambioMinor).toBe(15500n);

    expect(venta.pagos).toEqual([
      { metodo: 'efectivo', montoMinor: 20000n, cambioMinor: 15500n, referencia: null },
    ]);
    expect(venta.lineas).toHaveLength(1);
    expect(venta.lineas[0]).toMatchObject({
      lineaNo: 1,
      descripcion: 'Cuaderno Scribe 100 hojas',
      qty: 1000,
      qtyBase: 1000,
      precioUnitarioMinor: 4500n,
      costoUnitarioMinor: 2800n,
    });

    const ventaFila = await cliente.query<{
      total: unknown;
      estado: string;
      cambio: unknown;
      folio: unknown;
    }>(
      `SELECT s.total_minor AS total, s.estado, p.cambio_minor AS cambio, s.folio
         FROM sales s JOIN payments p ON p.sale_id = s.id WHERE s.id = $1`,
      [venta.ventaId],
    );
    expect(String(ventaFila.rows[0]?.total)).toBe('4500');
    expect(ventaFila.rows[0]?.estado).toBe('completada');
    expect(String(ventaFila.rows[0]?.cambio)).toBe('15500');
    expect(Number(ventaFila.rows[0]?.folio)).toBe(1);

    const stock = await cliente.query<{ qty_base: unknown }>(
      `SELECT qty_base FROM stock_levels WHERE product_id = $1`,
      [venta.lineas[0]?.productoId],
    );
    expect(String(stock.rows[0]?.qty_base)).toBe('-1.000');

    const movimientos = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_movements
        WHERE ref_type = 'sale' AND ref_id = $1 AND motivo = 'venta'`,
      [venta.ventaId],
    );
    expect(movimientos.rows[0]?.n).toBe(1);

    const cola = await cliente.query<{ tipo: string; total: string }>(
      `SELECT payload->>'type' AS tipo, payload->'payload'->>'total_minor' AS total
         FROM outbox WHERE payload->>'type' = 'sale.created'`,
    );
    expect(cola.rows).toEqual([{ tipo: 'sale.created', total: '4500' }]);

    expect(await contar(`SELECT count(*)::int AS n FROM audit_log WHERE accion = 'sale.created'`)).toBe(1);
  });

  test('escanear tres veces el mismo producto suma tres piezas', async () => {
    const { turnoId, productoId } = await preparar();

    const venta = await registrarVenta(
      cliente,
      {
        turnoId,
        lineas: [
          { productoId, qty: 1000 },
          { productoId, qty: 1000 },
          { productoId, qty: 1000 },
        ],
        pagos: [{ metodo: 'efectivo', montoMinor: 13500n }],
      },
      contexto,
    );

    expect(venta.lineas).toHaveLength(3);
    expect(venta.totalMinor).toBe(13500n);

    const stock = await cliente.query<{ qty_base: unknown }>(
      `SELECT qty_base FROM stock_levels WHERE product_id = $1`,
      [productoId],
    );
    expect(String(stock.rows[0]?.qty_base)).toBe('-3.000');
  });

  test('pago mixto: $20 efectivo + $25 tarjeta por $45, sin cambio', async () => {
    const { turnoId, productoId } = await preparar();

    const venta = await registrarVenta(
      cliente,
      {
        turnoId,
        lineas: [{ productoId, qty: 1000 }],
        pagos: [
          { metodo: 'efectivo', montoMinor: 2000n },
          { metodo: 'tarjeta_debito', montoMinor: 2500n, referencia: '1234' },
        ],
      },
      contexto,
    );

    expect(venta.cambioMinor).toBe(0n);
    expect(venta.pagos.map((pago) => pago.metodo)).toEqual(['efectivo', 'tarjeta_debito']);

    const filas = await cliente.query<{ metodo: string; monto: unknown; cambio: unknown }>(
      `SELECT metodo, monto_minor AS monto, cambio_minor AS cambio
         FROM payments WHERE sale_id = $1 ORDER BY metodo`,
      [venta.ventaId],
    );
    expect(
      filas.rows.map((fila) => ({
        metodo: fila.metodo,
        monto: String(fila.monto),
        cambio: String(fila.cambio),
      })),
    ).toEqual([
      { metodo: 'efectivo', monto: '2000', cambio: '0' },
      { metodo: 'tarjeta_debito', monto: '2500', cambio: '0' },
    ]);
  });

  test('no se puede cobrar de menos ni dar cambio con tarjeta', async () => {
    const { turnoId, productoId } = await preparar();

    await expect(
      registrarVenta(
        cliente,
        {
          turnoId,
          lineas: [{ productoId, qty: 1000 }],
          pagos: [{ metodo: 'efectivo', montoMinor: 4000n }],
        },
        contexto,
      ),
    ).rejects.toThrow(/Falta cobrar/);

    await expect(
      registrarVenta(
        cliente,
        {
          turnoId,
          lineas: [{ productoId, qty: 1000 }],
          pagos: [{ metodo: 'tarjeta_debito', montoMinor: 5000n }],
        },
        contexto,
      ),
    ).rejects.toThrow(/cambio sólo se puede dar en efectivo/);

    expect(await contar(`SELECT count(*)::int AS n FROM sales`)).toBe(0);
  });

  test('sin turno abierto no se vende', async () => {
    const creado = await crearProducto(
      cliente,
      { nombre: 'Lápiz', unitId: UNIDAD_PIEZA, precioMinor: 700n, costoMinor: 400n },
      contexto,
    );

    await expect(
      registrarVenta(
        cliente,
        {
          lineas: [{ productoId: creado.id, qty: 1000 }],
          pagos: [{ metodo: 'efectivo', montoMinor: 700n }],
        },
        contexto,
      ),
    ).rejects.toThrow(/No hay turno de caja abierto/);
  });

  test('un descuento del 20 % exige step-up y no quema folio ni stock', async () => {
    const { turnoId, productoId } = await preparar();

    await expect(
      registrarVenta(
        cliente,
        {
          turnoId,
          lineas: [{ productoId, qty: 1000, descuentoMinor: 900n }],
          pagos: [{ metodo: 'efectivo', montoMinor: 3600n }],
        },
        contexto,
      ),
    ).rejects.toBeInstanceOf(ErrorNoAutorizado);

    expect(await contar(`SELECT count(*)::int AS n FROM sales`)).toBe(0);
    expect(await contar(`SELECT count(*)::int AS n FROM stock_movements`)).toBe(0);
    expect(await contar(`SELECT count(*)::int AS n FROM folio_counters`)).toBe(0);
    expect(await contar(`SELECT count(*)::int AS n FROM outbox WHERE payload->>'type' = 'sale.created'`)).toBe(0);
  });

  test('clave de idempotencia repetida no crea dos ventas', async () => {
    const { turnoId, productoId } = await preparar();
    const datos = {
      turnoId,
      lineas: [{ productoId, qty: 1000 }],
      pagos: [{ metodo: 'efectivo' as const, montoMinor: 4500n }],
      claveIdempotencia: 'cobro-0001',
    };

    await registrarVenta(cliente, datos, contexto);
    await expect(registrarVenta(cliente, datos, contexto)).rejects.toThrow(/duplicate key|idempotency/i);

    expect(await contar(`SELECT count(*)::int AS n FROM sales`)).toBe(1);
  });
});

describe('leer una venta', () => {
  test('obtenerVenta devuelve líneas, pagos y cambio', async () => {
    const venta = await unaVentaCobrada();
    const detalle = await obtenerVenta(cliente, venta.ventaId);

    expect(detalle.folioLocal).toBe('C1-000001');
    expect(detalle.estado).toBe('completada');
    expect(detalle.totalMinor).toBe(4500n);
    expect(detalle.cambioMinor).toBe(15500n);
    expect(detalle.lineas).toHaveLength(1);
    expect(detalle.lineas[0]?.qty).toBe(1000);
    expect(detalle.pagos[0]?.metodo).toBe('efectivo');
  });

  test('buscarProductoPorCodigo encuentra el código interno y su precio', async () => {
    const { codigo } = await preparar();
    const encontrado = await buscarProductoPorCodigo(cliente, codigo);

    expect(encontrado).toMatchObject({
      nombre: 'Cuaderno Scribe 100 hojas',
      precioMinor: '4500',
      factor: '1.0000',
    });

    expect(await buscarProductoPorCodigo(cliente, '2000000000017')).toBeNull();
  });
});

describe('cancelar una venta', () => {
  async function darStepUp(ventaId: string): Promise<void> {
    await cliente.query(
      `INSERT INTO sessions
         (id, user_id, device_id, refresh_token_hash, familia_id,
          idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 'hash-de-prueba', $1, now() + interval '1 hour', now() + interval '2 hours')`,
      [ID_SESION, ID_DUENA, ID_TERMINAL],
    );
    await cliente.query(
      `INSERT INTO step_up_grants
         (id, user_id, session_id, metodo, motivo, entidad_id, expira_at)
       VALUES ('01900000-0000-7000-9000-000000000005', $1, $2, 'pin',
               'ventas:cancelar', $3, now() + interval '5 minutes')`,
      [ID_DUENA, ID_SESION, ventaId],
    );
  }

  test('sin step-up no se cancela', async () => {
    const venta = await unaVentaCobrada();

    await expect(
      cancelarVenta(cliente, { ventaId: venta.ventaId, motivo: 'Error de captura' }, contexto),
    ).rejects.toThrow(/autorización del dueño/);

    const estado = await cliente.query<{ estado: string }>(`SELECT estado FROM sales WHERE id = $1`, [
      venta.ventaId,
    ]);
    expect(estado.rows[0]?.estado).toBe('completada');
  });

  test('con step-up: se cancela, vuelve el stock y sale del arqueo', async () => {
    const venta = await unaVentaCobrada();
    await darStepUp(venta.ventaId);

    await cancelarVenta(
      cliente,
      { ventaId: venta.ventaId, motivo: 'Se cobró dos veces el mismo cuaderno' },
      { ...contexto, ahora: AHORA + 60_000 },
    );

    const fila = await cliente.query<{
      estado: string;
      motivo: string;
      cancelada_por: string;
    }>(`SELECT estado, motivo_cancelacion AS motivo, cancelada_por FROM sales WHERE id = $1`, [
      venta.ventaId,
    ]);
    expect(fila.rows[0]).toMatchObject({
      estado: 'cancelada',
      motivo: 'Se cobró dos veces el mismo cuaderno',
      cancelada_por: ID_DUENA,
    });

    const producto = await cliente.query<{ qty_base: unknown }>(
      `SELECT qty_base FROM stock_levels WHERE product_id = $1`,
      [venta.lineas[0]?.productoId],
    );
    expect(String(producto.rows[0]?.qty_base)).toBe('0.000');

    const movimientos = await cliente.query<{ motivo: string }>(
      `SELECT motivo FROM stock_movements WHERE ref_id = $1 ORDER BY ocurrido_at`,
      [venta.ventaId],
    );
    expect(movimientos.rows.map((m) => m.motivo)).toEqual(['venta', 'error_captura']);

    // Los pagos no se borran: son historia. El arqueo sí ignora la venta.
    expect(await contar(`SELECT count(*)::int AS n FROM payments WHERE sale_id = $1`, [venta.ventaId])).toBe(1);
    const resumen = await resumenTurno(cliente, venta.turnoId);
    expect(resumen.tickets).toBe(0);
    expect(resumen.ventasEfectivoMinor).toBe(0n);
    expect(resumen.esperadoEfectivoMinor).toBe(50000n);
  });

  test('una cancelación sin motivo no llega a la base', async () => {
    const venta = await unaVentaCobrada();
    await darStepUp(venta.ventaId);

    await expect(
      cancelarVenta(cliente, { ventaId: venta.ventaId, motivo: '   ' }, contexto),
    ).rejects.toBeInstanceOf(ErrorVenta);
  });
});
