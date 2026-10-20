import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import {
  abrirTurno,
  cerrarTurno,
  registrarMovimientoCaja,
  resumenTurno,
  turnoAbierto,
} from './caja';
import { ErrorNoAutorizado } from './eventos';
import { crearProducto } from './productos';
import { migrar, type ClienteTransaccional } from './runner';
import { registrarVenta } from './ventas';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

const ID_DUENA = '01900000-0000-7000-9000-000000000001';
const ID_TERMINAL = '01900000-0000-7000-9000-000000000003';
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

async function unProducto(): Promise<string> {
  const creado = await crearProducto(
    cliente,
    { nombre: 'Cuaderno Scribe 100 hojas', unitId: UNIDAD_PIEZA, precioMinor: 4500n, costoMinor: 2800n },
    { ...contexto, ahora: AHORA },
  );
  return creado.id;
}

describe('turno de caja', () => {
  test('abrir guarda el fondo y el evento; no se puede abrir otro encima', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 50000n }, { ...contexto, ahora: AHORA });

    expect(turno.fondoInicialMinor).toBe(50000n);
    expect(await turnoAbierto(cliente, ID_TERMINAL)).toMatchObject({
      id: turno.id,
      fondoInicialMinor: 50000n,
    });

    const guardado = await cliente.query<{ fondo: unknown }>(
      `SELECT fondo_inicial_minor AS fondo FROM cash_sessions WHERE id = $1`,
      [turno.id],
    );
    expect(String(guardado.rows[0]?.fondo)).toBe('50000');

    expect(await contar(`SELECT count(*)::int AS n FROM outbox WHERE payload->>'type' = 'cash_session.opened'`)).toBe(1);
    expect(await contar(`SELECT count(*)::int AS n FROM audit_log WHERE accion = 'cash_session.opened'`)).toBe(1);

    await expect(
      abrirTurno(cliente, { fondoInicialMinor: 10000n }, contexto),
    ).rejects.toThrow(/Ya hay un turno de caja abierto/);
  });

  test('el índice único impide dos turnos abiertos aunque se salte la comprobación', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 0n }, contexto);

    await expect(
      cliente.query(
        `INSERT INTO cash_sessions (id, terminal_id, user_id, abierta_at)
         VALUES ('01900000-0000-7000-9000-000000000099', $1, $2, now())`,
        [ID_TERMINAL, ID_DUENA],
      ),
    ).rejects.toThrow(/uq_cash_abierta_por_terminal|duplicate key/);

    // El turno legítimo sigue siendo el único.
    expect(await contar(`SELECT count(*)::int AS n FROM cash_sessions WHERE cerrada_at IS NULL`)).toBe(1);
    expect(turno.id).not.toBe('');
  });
});

describe('movimientos de cajón', () => {
  test('un retiro baja el esperado y queda explicado', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 50000n }, contexto);

    await registrarMovimientoCaja(
      cliente,
      { turnoId: turno.id, tipo: 'retiro', montoMinor: 20000n, concepto: 'Compra de bolsas' },
      contexto,
    );

    const resumen = await resumenTurno(cliente, turno.id);
    expect(resumen.retirosMinor).toBe(20000n);
    expect(resumen.esperadoEfectivoMinor).toBe(30000n);

    const movimiento = await cliente.query<{ tipo: string; concepto: string }>(
      `SELECT tipo, concepto FROM cash_movements WHERE cash_session_id = $1`,
      [turno.id],
    );
    expect(movimiento.rows).toEqual([{ tipo: 'retiro', concepto: 'Compra de bolsas' }]);
  });

  test('un retiro de más de $500 exige step-up y no se guarda', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 100000n }, contexto);

    await expect(
      registrarMovimientoCaja(
        cliente,
        { turnoId: turno.id, tipo: 'retiro', montoMinor: 60000n, concepto: 'Retiro de utilidad' },
        contexto,
      ),
    ).rejects.toThrow(/autorización del dueño/);

    expect(await contar(`SELECT count(*)::int AS n FROM cash_movements`)).toBe(0);
  });

  test('no se puede mover dinero de un turno cerrado', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 0n }, contexto);
    await cerrarTurno(cliente, { turnoId: turno.id, contadoEfectivoMinor: 0n }, contexto);

    await expect(
      registrarMovimientoCaja(
        cliente,
        { turnoId: turno.id, tipo: 'ingreso', montoMinor: 1000n, concepto: 'Reposición' },
        contexto,
      ),
    ).rejects.toThrow(/turno cerrado/);
  });
});

describe('cierre y arqueo', () => {
  test('el esperado usa monto − cambio y el cierre guarda la diferencia', async () => {
    const productoId = await unProducto();
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 50000n }, contexto);

    // Venta de $45 con $200 en efectivo: al cajón entran $45, no $200.
    await registrarVenta(
      cliente,
      {
        turnoId: turno.id,
        lineas: [{ productoId, qty: 1000 }],
        pagos: [{ metodo: 'efectivo', montoMinor: 20000n }],
      },
      contexto,
    );

    await registrarMovimientoCaja(
      cliente,
      { turnoId: turno.id, tipo: 'retiro', montoMinor: 20000n, concepto: 'Compra de bolsas' },
      contexto,
    );

    // 500 (fondo) + 45 (venta neta) − 200 (retiro) = 345.
    const antes = await resumenTurno(cliente, turno.id);
    expect(antes.ventasEfectivoMinor).toBe(4500n);
    expect(antes.esperadoEfectivoMinor).toBe(34500n);
    expect(antes.tickets).toBe(1);
    expect(antes.diferenciaMinor).toBeNull();

    const cierre = await cerrarTurno(cliente, { turnoId: turno.id, contadoEfectivoMinor: 34500n }, contexto);
    expect(cierre.esperadoEfectivoMinor).toBe(34500n);
    expect(cierre.contadoEfectivoMinor).toBe(34500n);
    expect(cierre.diferenciaMinor).toBe(0n);

    const guardado = await cliente.query<{
      esperado: unknown;
      contado: unknown;
      diferencia: unknown;
      notas: string | null;
    }>(
      `SELECT esperado_efectivo_minor AS esperado, contado_efectivo_minor AS contado,
              diferencia_minor AS diferencia, notas_cierre AS notas
         FROM cash_sessions WHERE id = $1`,
      [turno.id],
    );
    expect(String(guardado.rows[0]?.esperado)).toBe('34500');
    expect(String(guardado.rows[0]?.contado)).toBe('34500');
    expect(String(guardado.rows[0]?.diferencia)).toBe('0');

    expect(await turnoAbierto(cliente, ID_TERMINAL)).toBeNull();
  });

  test('una diferencia de más de $50 exige nota y, con nota, se cierra', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 50000n }, contexto);

    await expect(
      cerrarTurno(cliente, { turnoId: turno.id, contadoEfectivoMinor: 40000n }, contexto),
    ).rejects.toThrow(/escribe una nota/);

    // Sigue abierto: el rechazo de la obligación revirtió el evento completo.
    expect(await turnoAbierto(cliente, ID_TERMINAL)).not.toBeNull();

    const cierre = await cerrarTurno(
      cliente,
      {
        turnoId: turno.id,
        contadoEfectivoMinor: 40000n,
        notas: 'Faltan $100: se usaron para bolsas y no se registró el retiro.',
      },
      contexto,
    );
    expect(cierre.diferenciaMinor).toBe(-10000n);
  });

  test('no se puede cerrar dos veces el mismo turno', async () => {
    const turno = await abrirTurno(cliente, { fondoInicialMinor: 0n }, contexto);
    await cerrarTurno(cliente, { turnoId: turno.id, contadoEfectivoMinor: 0n }, contexto);

    await expect(
      cerrarTurno(cliente, { turnoId: turno.id, contadoEfectivoMinor: 0n }, contexto),
    ).rejects.toThrow(/ya está cerrado/);
  });
});

describe('la venta y la caja se rechazan sin permiso', () => {
  test('un usuario sin rol no puede abrir turno', async () => {
    await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, 'sinrol', 'Sin rol')`, [
      '01900000-0000-7000-9000-000000000077',
    ]);

    await expect(
      abrirTurno(
        cliente,
        { fondoInicialMinor: 0n },
        { usuarioId: '01900000-0000-7000-9000-000000000077', dispositivoId: ID_TERMINAL },
      ),
    ).rejects.toBeInstanceOf(ErrorNoAutorizado);
  });
});
