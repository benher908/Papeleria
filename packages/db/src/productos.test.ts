import { PGlite } from '@electric-sql/pglite';
import { validaEAN13 } from '@papeleria/core';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { ErrorNoAutorizado } from './eventos';
import {
  actualizarProducto,
  crearProducto,
  ErrorCodigoDuplicado,
  ErrorCodigoInvalido,
  ErrorProducto,
  listarCategorias,
  listarProductos,
  listarUnidades,
} from './productos';
import { migrar, type ClienteTransaccional } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

const ID_DUENA = '01900000-0000-7000-9000-000000000001';
const ID_AUDITOR = '01900000-0000-7000-9000-000000000002';
const ID_TERMINAL = '01900000-0000-7000-9000-000000000003';

const ROL_DUENO = '01900000-0000-7000-8000-000000000001';
const ROL_AUDITOR = '01900000-0000-7000-8000-000000000004';

const UNIDAD_PIEZA = '01900000-0000-7000-8002-000000000001';
const CATEGORIA_ESCOLAR = '01900000-0000-7000-8004-000000000002';

let db: PGlite;
let cliente: ClienteTransaccional;

async function unaFila<T>(sql: string, params?: unknown[]): Promise<T> {
  const { rows } = await cliente.query<T>(sql, params);
  const fila = rows[0];
  if (fila === undefined) throw new Error(`Se esperaba una fila de: ${sql}`);
  return fila;
}

async function contar(sql: string): Promise<number> {
  const fila = await unaFila<{ n: number }>(sql);
  return fila.n;
}

async function siguienteCodigo(): Promise<string> {
  return String(
    (await unaFila<{ siguiente: unknown }>(
      `SELECT siguiente FROM barcode_sequences WHERE prefijo = '2'`,
    )).siguiente,
  );
}

const contextoDueno = { usuarioId: ID_DUENA, dispositivoId: ID_TERMINAL };
const contextoAuditor = { usuarioId: ID_AUDITOR, dispositivoId: ID_TERMINAL };

/** Un producto mínimo válido, que cada prueba ajusta. */
function producto(extra: Partial<Parameters<typeof crearProducto>[1]> = {}) {
  return {
    nombre: 'Lápiz Mirado 2',
    unitId: UNIDAD_PIEZA,
    precioMinor: 700n,
    costoMinor: 400n,
    ...extra,
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));

  await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, 'duena', 'Dueña')`, [
    ID_DUENA,
  ]);
  await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, 'auditor', 'Auditor')`, [
    ID_AUDITOR,
  ]);
  await cliente.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
    ID_DUENA,
    ROL_DUENO,
  ]);
  // El auditor no tiene `productos:crear`: sirve para probar la puerta cerrada.
  await cliente.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
    ID_AUDITOR,
    ROL_AUDITOR,
  ]);
  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo, codigo)
     VALUES ($1, $2, 'PC caja 1', 'terminal', 'C1')`,
    [ID_TERMINAL, ID_DUENA],
  );
});

beforeEach(async () => {
  await cliente.exec(
    `TRUNCATE outbox, audit_log, product_barcodes, product_presentations, stock_levels,
              stock_movements, products CASCADE`,
  );
  await cliente.exec(`UPDATE barcode_sequences SET siguiente = 1 WHERE prefijo = '2'`);
});

afterAll(async () => {
  await db.close();
});

describe('alta de producto', () => {
  test('entra el producto, su presentación base, el código interno y el evento', async () => {
    const creado = await crearProducto(cliente, producto(), contextoDueno);

    expect(creado.codigos).toHaveLength(1);
    const codigo = creado.codigos[0] as string;
    expect(validaEAN13(codigo)).toBe(true);
    expect(codigo.startsWith('2')).toBe(true);

    const fila = await unaFila<{ nombre: string; precio_minor: string; costo_minor: string }>(
      `SELECT nombre, precio_minor, costo_minor FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(fila.nombre).toBe('Lápiz Mirado 2');
    expect(String(fila.precio_minor)).toBe('700');
    expect(String(fila.costo_minor)).toBe('400');

    // La presentación base es la que después usará la venta: factor 1, precio del producto.
    const presentacion = await unaFila<{ factor: string; precio_minor: string; is_base: boolean }>(
      `SELECT factor, precio_minor, is_base FROM product_presentations WHERE product_id = $1`,
      [creado.id],
    );
    expect(Number(presentacion.factor)).toBe(1);
    expect(String(presentacion.precio_minor)).toBe('700');
    expect(presentacion.is_base).toBe(true);

    const barcode = await unaFila<{ codigo: string; es_primario: boolean; es_interno: boolean }>(
      `SELECT codigo, es_primario, es_interno FROM product_barcodes WHERE product_id = $1`,
      [creado.id],
    );
    expect(barcode.codigo).toBe(codigo);
    expect(barcode.es_primario).toBe(true);
    expect(barcode.es_interno).toBe(true);

    // `outbox.payload` es el evento entero; el payload del producto va dentro.
    const evento = await unaFila<{ type: string; cuerpo: { codigos: unknown[] } }>(
      `SELECT payload->>'type' AS type, payload->'payload' AS cuerpo FROM outbox`,
    );
    expect(evento.type).toBe('product.created');
    expect(evento.cuerpo.codigos).toHaveLength(1);

    expect(await contar(`SELECT count(*)::int AS n FROM audit_log WHERE accion = 'product.created'`)).toBe(1);
  });

  test('dos altas seguidas gastan dos números distintos', async () => {
    const uno = await crearProducto(cliente, producto({ nombre: 'Uno' }), contextoDueno);
    const dos = await crearProducto(cliente, producto({ nombre: 'Dos' }), contextoDueno);

    expect(uno.codigos[0]).not.toBe(dos.codigos[0]);
    expect(await siguienteCodigo()).toBe('3');
  });

  test('un código dictado se normaliza y no se genera el interno', async () => {
    const creado = await crearProducto(
      cliente,
      producto({ codigos: [' ana-3-12 '] }),
      contextoDueno,
    );

    expect(creado.codigos).toEqual(['ANA-3-12']);
    const barcode = await unaFila<{ simbologia: string; es_interno: boolean }>(
      `SELECT simbologia, es_interno FROM product_barcodes WHERE codigo = 'ANA-3-12'`,
    );
    expect(barcode.simbologia).toBe('code128');
    expect(barcode.es_interno).toBe(false);
    // No se tocó la secuencia.
    expect(await siguienteCodigo()).toBe('1');
  });

  test('un EAN-13 con el verificador mal no entra ni gasta número', async () => {
    // 2000000000017 tiene el verificador mal a propósito (docs/03 §2).
    await expect(
      crearProducto(cliente, producto({ codigos: ['2000000000017'] }), contextoDueno),
    ).rejects.toBeInstanceOf(ErrorCodigoInvalido);

    expect(await contar(`SELECT count(*)::int AS n FROM products`)).toBe(0);
    expect(await contar(`SELECT count(*)::int AS n FROM outbox`)).toBe(0);
    expect(await siguienteCodigo()).toBe('1');
  });

  test('un código ya usado dice de qué producto es', async () => {
    await crearProducto(cliente, producto({ nombre: 'Goma blanca', codigos: ['0001234567895'] }), contextoDueno);

    const fallo = crearProducto(cliente, producto({ nombre: 'Otro', codigos: ['0001234567895'] }), contextoDueno);

    await expect(fallo).rejects.toBeInstanceOf(ErrorCodigoDuplicado);
    await expect(fallo).rejects.toThrow(/«Goma blanca»/);
    expect(await contar(`SELECT count(*)::int AS n FROM products`)).toBe(1);
  });

  test('el mismo código dos veces en el mismo producto se rechaza', async () => {
    await expect(
      crearProducto(cliente, producto({ codigos: ['ANA-1', 'ana-1'] }), contextoDueno),
    ).rejects.toBeInstanceOf(ErrorCodigoInvalido);
  });

  test('un precio de cero no es un producto', async () => {
    await expect(
      crearProducto(cliente, producto({ precioMinor: 0n, costoMinor: 0n }), contextoDueno),
    ).rejects.toBeInstanceOf(ErrorProducto);
  });

  test('precio por debajo del costo: P1 lo niega y no queda nada escrito', async () => {
    const fallo = crearProducto(
      cliente,
      producto({ precioMinor: 300n, costoMinor: 400n }),
      contextoDueno,
    );

    await expect(fallo).rejects.toBeInstanceOf(ErrorNoAutorizado);
    await expect(fallo).rejects.toThrow(/debajo del costo/);
    expect(await contar(`SELECT count(*)::int AS n FROM products`)).toBe(0);
    expect(await siguienteCodigo()).toBe('1');
  });

  test('sin el permiso productos:crear no se escribe nada', async () => {
    const fallo = crearProducto(cliente, producto(), contextoAuditor);

    await expect(fallo).rejects.toBeInstanceOf(ErrorNoAutorizado);
    expect(await contar(`SELECT count(*)::int AS n FROM products`)).toBe(0);
  });

  test('si la unidad no existe, se revierte todo y el número no se gasta', async () => {
    const fallo = crearProducto(
      cliente,
      producto({ unitId: '01900000-0000-7000-9999-000000000000' }),
      contextoDueno,
    );

    await expect(fallo).rejects.toBeInstanceOf(ErrorProducto);
    expect(await contar(`SELECT count(*)::int AS n FROM products`)).toBe(0);
    expect(await siguienteCodigo()).toBe('1');
  });
});

describe('listado', () => {
  test('la lista trae categoría, unidad y stock, y busca por nombre y por código', async () => {
    const lapiz = await crearProducto(
      cliente,
      producto({
        nombre: 'Lápiz del 2',
        categoryId: CATEGORIA_ESCOLAR,
        codigos: ['LAP-2'],
        stockMinimo: 12.5,
      }),
      contextoDueno,
    );
    await crearProducto(cliente, producto({ nombre: 'Cuaderno profesional' }), contextoDueno);

    const todos = await listarProductos(cliente);
    expect(todos).toHaveLength(2);
    expect(todos[0]?.nombre).toBe('Cuaderno profesional');
    expect(todos[1]?.categoria).toBe('Escolar');
    expect(todos[1]?.unidadAbreviatura).toBe('pza');
    expect(todos[1]?.stock).toBe('0');
    // El punto de reposición viaja en la fila: sin él, el formulario de edición lo
    // pondría en 0 y lo borraría al guardar cualquier otra cosa.
    expect(todos[1]?.stockMinimo).toBe('12.500');

    const porNombre = await listarProductos(cliente, 'lápiz');
    expect(porNombre.map((fila) => fila.id)).toEqual([lapiz.id]);

    const porCodigo = await listarProductos(cliente, 'LAP-2');
    expect(porCodigo.map((fila) => fila.id)).toEqual([lapiz.id]);
  });

  test('las categorías y las unidades vienen del catálogo sembrado', async () => {
    const categorias = await listarCategorias(cliente);
    const unidades = await listarUnidades(cliente);

    expect(categorias.map((fila) => fila.nombre)).toContain('Escolar');
    expect(unidades.map((fila) => fila.abreviatura)).toContain('pza');
  });
});

describe('edición', () => {
  test('cambiar nombre y precio deja un product.updated con el antes y el después', async () => {
    const creado = await crearProducto(cliente, producto(), contextoDueno);
    await cliente.exec(`DELETE FROM outbox`);

    await actualizarProducto(
      cliente,
      creado.id,
      { nombre: 'Lápiz Mirado 2B', precioMinor: 900n },
      contextoDueno,
    );

    const fila = await unaFila<{ nombre: string; precio_minor: string }>(
      `SELECT nombre, precio_minor FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(fila.nombre).toBe('Lápiz Mirado 2B');
    expect(String(fila.precio_minor)).toBe('900');

    const evento = await unaFila<{ type: string; cuerpo: { antes: { nombre: string }; despues: { nombre: string } } }>(
      `SELECT payload->>'type' AS type, payload->'payload' AS cuerpo FROM outbox`,
    );
    expect(evento.type).toBe('product.updated');
    expect(evento.cuerpo.antes.nombre).toBe('Lápiz Mirado 2');
    expect(evento.cuerpo.despues.nombre).toBe('Lápiz Mirado 2B');
  });

  test('bajar el precio por debajo del costo tampoco se puede al editar', async () => {
    const creado = await crearProducto(cliente, producto(), contextoDueno);

    // La edición pide `productos:editar`, pero cuando el precio queda debajo del costo
    // se pide además `precios:editar` y P1 niega. Si no, editar sería la puerta de atrás.
    const fallo = actualizarProducto(cliente, creado.id, { precioMinor: 100n }, contextoDueno);

    await expect(fallo).rejects.toBeInstanceOf(ErrorNoAutorizado);
    await expect(fallo).rejects.toThrow(/debajo del costo/);

    const fila = await unaFila<{ precio_minor: string }>(
      `SELECT precio_minor FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(String(fila.precio_minor)).toBe('700');
  });

  test('subir el costo por arriba del precio tampoco', async () => {
    const creado = await crearProducto(cliente, producto(), contextoDueno);

    await expect(
      actualizarProducto(cliente, creado.id, { costoMinor: 900n }, contextoDueno),
    ).rejects.toBeInstanceOf(ErrorNoAutorizado);

    const fila = await unaFila<{ costo_minor: string }>(
      `SELECT costo_minor FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(String(fila.costo_minor)).toBe('400');
  });

  test('el punto de reposición sobrevive a una edición que no lo toca', async () => {
    // El recorrido real de la pantalla: `listarProductos()` llena el formulario y el
    // formulario manda de vuelta lo que tiene. Cuando el stock mínimo no venía en la
    // fila, el campo arrancaba en 0 y editar el nombre de un producto **borraba** el
    // punto de reposición. Lo destapó la pantalla, no una prueba.
    const creado = await crearProducto(cliente, producto({ stockMinimo: 12.5 }), contextoDueno);

    const [fila] = await listarProductos(cliente, 'Lápiz');
    expect(fila?.stockMinimo).toBe('12.500');

    await actualizarProducto(cliente, creado.id, { nombre: 'Lápiz Mirado 3' }, contextoDueno);

    const despues = await unaFila<{ stock_minimo: unknown }>(
      `SELECT stock_minimo FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(Number(despues.stock_minimo)).toBe(12.5);
  });

  test('el punto de reposición se puede cambiar', async () => {
    const creado = await crearProducto(cliente, producto({ stockMinimo: 3 }), contextoDueno);

    await actualizarProducto(cliente, creado.id, { stockMinimo: 8.25 }, contextoDueno);

    const despues = await unaFila<{ stock_minimo: unknown }>(
      `SELECT stock_minimo FROM products WHERE id = $1`,
      [creado.id],
    );
    expect(Number(despues.stock_minimo)).toBe(8.25);
  });

  test('editar un producto de otra persona sin permiso no lo toca', async () => {
    const creado = await crearProducto(cliente, producto(), contextoDueno);

    await expect(
      actualizarProducto(cliente, creado.id, { nombre: 'Otro' }, contextoAuditor),
    ).rejects.toBeInstanceOf(ErrorNoAutorizado);
  });
});
