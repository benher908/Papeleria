import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { aplicarEventoRemoto, type EventoRemoto } from './sync';
import { migrar, type ClienteSql } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));
const DEVICE = '01900000-0000-7000-9000-000000000101';
const USER = '01900000-0000-7000-9000-000000000102';
const PRODUCT = '01900000-0000-7000-9000-000000000103';
const PRESENTATION = '01900000-0000-7000-9000-000000000104';
let db: PGlite;
let cliente: ClienteSql;

function evento(type: string, payload: Record<string, unknown>, eventId: string): EventoRemoto {
  return { event_id: eventId, device_id: DEVICE, device_seq: 1, user_id: USER, type, payload,
    occurred_at: '2026-10-20T12:00:00.000Z', schema_version: 1, hlc: 'test' };
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));
});

afterAll(async () => { await db.close(); });

describe('proyección de sincronización', () => {
  test('replica un producto y su presentación/código de forma idempotente', async () => {
    const e = evento('product.created', {
      producto: { id: PRODUCT, nombre: 'Lápiz remoto', sku: null, descripcion: null,
        category_id: null, supplier_id: null, unit_id: '01900000-0000-7000-8002-000000000001',
        tax_rate_id: null, precio_minor: '500', costo_minor: '200', tracks_stock: true,
        stock_minimo: '0.000', stock_maximo: null, ubicacion: null,
        permite_venta_fraccion: false, is_activo: true, notas: null },
      presentacion: { id: PRESENTATION, unit_id: '01900000-0000-7000-8002-000000000001',
        nombre: 'pieza', factor: '1', precio_minor: '500', is_base: true },
      codigos: [],
    }, '01JTESTPRODUCT00000000000001');

    await aplicarEventoRemoto(cliente, e);
    await aplicarEventoRemoto(cliente, e);
    const resultado = await cliente.query<{ productos: number; presentaciones: number }>(
      `SELECT (SELECT count(*)::int FROM products WHERE id=$1) productos,
              (SELECT count(*)::int FROM product_presentations WHERE id=$2) presentaciones`,
      [PRODUCT, PRESENTATION],
    );
    expect(resultado.rows[0]).toEqual({ productos: 1, presentaciones: 1 });
  });

  test('un ajuste remoto actualiza el ledger y el saldo derivado', async () => {
    await aplicarEventoRemoto(cliente, evento('stock.adjusted', {
      productoId: PRODUCT, cantidad: 3, motivo: 'ajuste_manual',
      notas: 'Ajuste recibido en la caja', ocurrido_at: '2026-10-20T12:00:00.000Z',
    }, '01JTESTSTOCK000000000000001'));
    const resultado = await cliente.query<{ qty: string }>(
      'SELECT qty_base::text AS qty FROM stock_levels WHERE product_id=$1', [PRODUCT],
    );
    expect(resultado.rows[0]?.qty).toBe('3.000');
  });

  test('rechaza eventos cuyo proyector aún no existe', async () => {
    await expect(aplicarEventoRemoto(cliente, evento('unsupported', {}, '01JTESTUNKNOWN00000000001')))
      .rejects.toThrow(/no soportado/);
  });
});
