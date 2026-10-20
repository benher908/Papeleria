import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { migrar, type ClienteSql } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

// Identificadores de las semillas (0002 y 0003). Se usan tal cual: si la semilla
// cambiara de uuid, estas pruebas fallan, que es exactamente lo que se quiere.
const ID_UNIDAD_PIEZA = '01900000-0000-7000-8002-000000000001';

// Fixtures propios de la prueba (familia 9000 para no pisar las semillas).
const ID_USUARIO = '01900000-0000-7000-9000-000000000001';
const ID_DISPOSITIVO = '01900000-0000-7000-9000-000000000002';
const ID_TURNO = '01900000-0000-7000-9000-000000000003';

let db: PGlite;
let cliente: ClienteSql;

async function contar(sql: string, params?: unknown[]): Promise<number> {
  const { rows } = await cliente.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? -1;
}

async function crearProducto(id: string, nombre: string): Promise<void> {
  await cliente.query(
    `INSERT INTO products (id, nombre, unit_id, precio_minor) VALUES ($1, $2, $3, 0)`,
    [id, nombre, ID_UNIDAD_PIEZA],
  );
}

async function crearMovimiento(
  id: string,
  producto: string,
  qty: number,
  motivo: string,
  notas?: string,
): Promise<void> {
  await cliente.query(
    `INSERT INTO stock_movements
       (id, product_id, qty, qty_base, motivo, notas, user_id, device_id, ocurrido_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now())`,
    [id, producto, qty, motivo, notas ?? null, ID_USUARIO, ID_DISPOSITIVO],
  );
}

let siguienteFolioLocal = 0;

async function crearVenta(
  id: string,
  estado: string,
  extras: { cancelada_at?: string; cancelada_por?: string; motivo_cancelacion?: string } = {},
): Promise<void> {
  siguienteFolioLocal += 1;
  await cliente.query(
    `INSERT INTO sales
       (id, folio_local, cash_session_id, terminal_id, user_id,
        subtotal_minor, total_minor, estado, idempotency_key, device_id, evento_id,
        ocurrido_at, cancelada_at, cancelada_por, motivo_cancelacion)
     VALUES ($1, $2, $3, $4, $5, 1000, 1000, $6, $7, $4, $8, now(), $9, $10, $11)`,
    [
      id,
      `C1-${String(siguienteFolioLocal).padStart(6, '0')}`,
      ID_TURNO,
      ID_DISPOSITIVO,
      ID_USUARIO,
      estado,
      `idem-${id}`,
      `evt-${id}`,
      extras.cancelada_at ?? null,
      extras.cancelada_por ?? null,
      extras.motivo_cancelacion ?? null,
    ],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));

  await cliente.query(
    `INSERT INTO users (id, username, nombre) VALUES ($1, 'duena', 'Dueña')`,
    [ID_USUARIO],
  );
  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo) VALUES ($1, $2, 'PC caja 1', 'terminal')`,
    [ID_DISPOSITIVO, ID_USUARIO],
  );
  // Turno abierto con fondo: el dueño esperaba $1 000 y contó $1 150.
  await cliente.query(
    `INSERT INTO cash_sessions
       (id, terminal_id, user_id, abierta_at, esperado_efectivo_minor, contado_efectivo_minor)
     VALUES ($1, $2, $3, now(), 100000, 115000)`,
    [ID_TURNO, ID_DISPOSITIVO, ID_USUARIO],
  );
});

afterAll(async () => {
  await db.close();
});

// ═══════════════════════════════════════════════════════════════════════
describe('esquema: estructura', () => {
  test('existen todas las tablas y ninguna de más', async () => {
    const { rows } = await cliente.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );

    expect(rows.map((r) => r.tablename)).toEqual([
      'audit_log',
      'barcode_sequences',
      'cash_movements',
      'cash_sessions',
      'categories',
      'device_counters',
      'devices',
      'event_log',
      'folio_counters',
      'inventory_count_lines',
      'inventory_counts',
      'outbox',
      'payments',
      'permissions',
      'policies',
      'policy_bundles',
      'product_barcodes',
      'product_presentations',
      'products',
      'return_lines',
      'returns',
      'role_permissions',
      'roles',
      'sale_lines',
      'sales',
      'schema_migrations',
      'sessions',
      'settings',
      'step_up_grants',
      'stock_levels',
      'stock_movements',
      'suppliers',
      'sync_cursors',
      'tax_rates',
      'units',
      'user_roles',
      'users',
      'webauthn_credentials',
    ]);
  });

  test('el trigger del ledger y la función que lo aplica existen', async () => {
    const { rows } = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'trg_aplicar_movimiento'`,
    );
    expect(rows[0]?.n).toBe(1);

    expect(
      await contar(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'aplicar_movimiento'`),
    ).toBe(1);
  });

  test('el índice de búsqueda es un GIN con la configuración de español', async () => {
    const { rows } = await cliente.query<{ definicion: string }>(
      `SELECT indexdef AS definicion FROM pg_indexes WHERE indexname = 'idx_products_busqueda'`,
    );
    const definicion = rows[0]?.definicion ?? '';
    expect(definicion).toContain('USING gin');
    expect(definicion).toContain("to_tsvector('spanish'");
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('esquema: semillas', () => {
  test('los 4 roles, con su nivel, y solo uno puede tocar las reglas', async () => {
    const { rows } = await cliente.query<{ clave: string; nivel: number }>(
      `SELECT clave, nivel FROM roles ORDER BY nivel DESC`,
    );
    expect(rows).toEqual([
      { clave: 'dueno', nivel: 100 },
      { clave: 'cajero', nivel: 20 },
      { clave: 'bodega', nivel: 20 },
      { clave: 'auditor', nivel: 10 },
    ]);
  });

  test('los 44 permisos y el reparto exacto por rol', async () => {
    expect(await contar('SELECT count(*)::int AS n FROM permissions')).toBe(44);

    // El JOIN del seed descarta en silencio un permiso mal escrito. Estos números
    // son la única forma de detectarlo: 81 = 44 + 14 + 11 + 12.
    expect(await contar('SELECT count(*)::int AS n FROM role_permissions')).toBe(81);

    const { rows } = await cliente.query<{ rol: string; n: number }>(
      `SELECT r.clave AS rol, count(*)::int AS n
       FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
       GROUP BY r.clave ORDER BY r.clave`,
    );
    expect(rows).toEqual([
      { rol: 'auditor', n: 12 },
      { rol: 'bodega', n: 11 },
      { rol: 'cajero', n: 14 },
      { rol: 'dueno', n: 44 },
    ]);
  });

  test('el cajero no ve los costos y el dueño sí', async () => {
    const { rows } = await cliente.query<{ rol: string }>(
      `SELECT r.clave AS rol
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.clave = 'precios:ver_costos' ORDER BY r.clave`,
    );
    // La decisión de privacidad más importante del catálogo: el cajero NO ve
    // lo que costó la mercancía ni el margen.
    expect(rows.map((r) => r.rol)).toEqual(['auditor', 'dueno']);
  });

  test('revocar un dispositivo no pide PIN, pero tampoco lo puede hacer cualquiera', async () => {
    // El doc 06 se contradice aquí y conviene dejarlo escrito.
    //   · §3.3 dice: dueño ✅, cajero emparejar, bodega —, auditor —.
    //   · P22 dice: "permitir siempre… quitar acceso nunca debe requerir permiso".
    // Se resuelve leyendo P22 como lo que argumenta: que revocar NO exige step-up
    // (en una emergencia hay que poder cortar ya, sin buscar al dueño). De ahí
    // `es_sensible = false`. Pero el permiso no se reparte a los cuatro roles: un
    // auditor que puede revocar dispositivos deja de ser auditor, y la separación
    // de funciones es justamente lo que hace que la auditoría sirva (doc 06 §2.3).
    const { rows } = await cliente.query<{ rol: string; es_sensible: boolean }>(
      `SELECT r.clave AS rol, p.es_sensible
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.clave = 'dispositivos:revocar' ORDER BY r.clave`,
    );
    expect(rows).toEqual([
      { rol: 'cajero', es_sensible: false },
      { rol: 'dueno', es_sensible: false },
    ]);
  });

  test('un permiso sensible está marcado como sensible', async () => {
    const { rows } = await cliente.query<{ clave: string; es_sensible: boolean }>(
      `SELECT clave, es_sensible FROM permissions
       WHERE clave IN ('ventas:cancelar', 'precios:ver_costos', 'dispositivos:revocar')
       ORDER BY clave`,
    );
    expect(rows).toEqual([
      { clave: 'dispositivos:revocar', es_sensible: false },
      { clave: 'precios:ver_costos', es_sensible: false },
      { clave: 'ventas:cancelar', es_sensible: true },
    ]);
  });

  test('unidades, tasas, categorías, configuración y reglas', async () => {
    expect(await contar('SELECT count(*)::int AS n FROM units')).toBe(6);
    expect(await contar('SELECT count(*)::int AS n FROM tax_rates')).toBe(3);
    expect(await contar('SELECT count(*)::int AS n FROM categories')).toBe(8);
    expect(await contar('SELECT count(*)::int AS n FROM settings')).toBe(12);

    // Las 30 filas de 0005 (las 31 reglas del doc 06 §5: P20 y P23 son RBAC puro y
    // P21 son dos permisos). Lo que cada regla *hace* se prueba en
    // `autorizacion.test.ts`; aquí sólo se inventaría, para que un archivo que no se
    // aplicó se note aunque nadie evalúe una política.
    expect(await contar('SELECT count(*)::int AS n FROM policies')).toBe(30);

    const { rows } = await cliente.query<{ v: unknown }>(
      `SELECT valor AS v FROM settings WHERE clave = 'precio_incluye_iva'`,
    );
    expect(rows[0]?.v).toBe(true);
  });

  test('la categoría hija apunta a la padre que existe (no hay huérfanas)', async () => {
    const { rows } = await cliente.query<{ path: string; padre: string | null }>(
      `SELECT c.path, p.path AS padre
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       ORDER BY c.path`,
    );
    for (const fila of rows) {
      const esperaPadre = fila.path.includes('/');
      expect(fila.padre !== null).toBe(esperaPadre);
    }
  });

  test('los datos de referencia tienen los MISMOS uuid en un segundo dispositivo', async () => {
    // Esta es la razón de ser de los literales en la migración: si 'pieza' o
    // 'dueno' tuvieran un uuid distinto en cada dispositivo, al sincronizar el
    // servidor vería dos filas irreconciliables y el catálogo se partiría en dos.
    const consulta = `
      SELECT 'rol:' || clave || '=' || id AS v FROM roles
      UNION ALL SELECT 'unidad:' || nombre || '=' || id FROM units
      UNION ALL SELECT 'tasa:' || nombre || '=' || id FROM tax_rates
      UNION ALL SELECT 'categoria:' || path || '=' || id FROM categories
      UNION ALL SELECT 'permiso:' || clave || '=' || id FROM permissions
      UNION ALL SELECT 'config:' || clave || '=' || valor::text FROM settings
      ORDER BY 1`;

    const enEsteDispositivo = (await cliente.query<{ v: string }>(consulta)).rows.map((r) => r.v);

    const otroDispositivo = new PGlite();
    await otroDispositivo.waitReady;
    try {
      const clienteOtro = adaptarPglite(otroDispositivo);
      await migrar(clienteOtro, await cargarMigraciones(DIR_MIGRACIONES));
      const enOtroDispositivo = (await clienteOtro.query<{ v: string }>(consulta)).rows.map((r) => r.v);

      expect(enOtroDispositivo).toEqual(enEsteDispositivo);
      expect(enEsteDispositivo.length).toBeGreaterThan(50);
    } finally {
      await otroDispositivo.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('esquema: el ledger de stock', () => {
  test('un movimiento actualiza el saldo y el acumulado cuadra', async () => {
    await crearProducto('01900000-0000-7000-9000-000000000101', 'Cuaderno profesional');

    await crearMovimiento('01900000-0000-7000-9000-000000000201', '01900000-0000-7000-9000-000000000101', 10, 'compra_recepcion');
    await crearMovimiento('01900000-0000-7000-9000-000000000202', '01900000-0000-7000-9000-000000000101', -3, 'venta');
    await crearMovimiento('01900000-0000-7000-9000-000000000203', '01900000-0000-7000-9000-000000000101', -2, 'venta');

    const { rows } = await cliente.query<{ qty_base: string }>(
      `SELECT qty_base FROM stock_levels WHERE product_id = $1`,
      ['01900000-0000-7000-9000-000000000101'],
    );
    expect(Number(rows[0]?.qty_base)).toBe(5);
  });

  test('la consulta de reconciliación del documento devuelve cero filas', async () => {
    // Es "el test de integridad" del doc 02 §4.2: si esta consulta devuelve algo,
    // hay un bug en el trigger y hay que enterarse hoy, no en el conteo anual.
    const { rows } = await cliente.query(
      `SELECT m.product_id, SUM(m.qty_base) AS calculado, s.qty_base AS cacheado
       FROM stock_movements m JOIN stock_levels s USING (product_id)
       GROUP BY m.product_id, s.qty_base
       HAVING SUM(m.qty_base) <> s.qty_base`,
    );
    expect(rows).toEqual([]);
  });

  test('rechaza un movimiento de cantidad cero', async () => {
    await crearProducto('01900000-0000-7000-9000-000000000102', 'Lápiz del 2');
    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000204', '01900000-0000-7000-9000-000000000102', 0, 'venta'),
    ).rejects.toThrow(/stock_movements.*check constraint/);
  });

  test('rechaza un motivo inventado: el catálogo es cerrado', async () => {
    // 'venta ' con un espacio al final es el caso real: se ve igual en pantalla y
    // parte los reportes en dos.
    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000205', '01900000-0000-7000-9000-000000000102', -1, 'venta '),
    ).rejects.toThrow(/stock_movements.*check constraint/);

    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000206', '01900000-0000-7000-9000-000000000102', -1, 'se_perdio'),
    ).rejects.toThrow(/stock_movements.*check constraint/);
  });

  test('un ajuste manual exige el motivo escrito, con al menos 10 caracteres', async () => {
    const producto = '01900000-0000-7000-9000-000000000102';

    // Sin notas: rechazado. Este es el agujero por donde se va el inventario.
    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000207', producto, -1, 'ajuste_manual'),
    ).rejects.toThrow(/ck_ajuste_exige_motivo/);

    // Con una nota demasiado corta: también.
    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000208', producto, -1, 'ajuste_manual', 'faltan'),
    ).rejects.toThrow(/ck_ajuste_exige_motivo/);

    // Con espacios nada más: tampoco (el btrim cuenta).
    await expect(
      crearMovimiento('01900000-0000-7000-9000-000000000209', producto, -1, 'merma', '          '),
    ).rejects.toThrow(/ck_ajuste_exige_motivo/);

    // Con un motivo de verdad: aceptado.
    await crearMovimiento(
      '01900000-0000-7000-9000-000000000210',
      producto,
      -1,
      'merma',
      'Se rompió al caerse del anaquel',
    );
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM stock_movements WHERE id = '01900000-0000-7000-9000-000000000210'`,
      ),
    ).toBe(1);
  });

  test('rechaza un ref_type que no está en el catálogo', async () => {
    await expect(
      cliente.query(
        `INSERT INTO stock_movements
           (id, product_id, qty, qty_base, motivo, ref_type, user_id, device_id, ocurrido_at)
         VALUES ('01900000-0000-7000-9000-000000000211', '01900000-0000-7000-9000-000000000102',
                 -1, -1, 'venta', 'venta_movil', $1, $2, now())`,
        [ID_USUARIO, ID_DISPOSITIVO],
      ),
    ).rejects.toThrow(/stock_movements.*check constraint/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('esquema: códigos de barras', () => {
  test('un código no puede estar en dos productos (uq_barcode global)', async () => {
    await crearProducto('01900000-0000-7000-9000-000000000301', 'Goma blanca');
    await crearProducto('01900000-0000-7000-9000-000000000302', 'Goma con tinta');

    await cliente.query(
      `INSERT INTO product_barcodes (id, product_id, codigo, simbologia, es_interno)
       VALUES ('01900000-0000-7000-9000-000000000401', '01900000-0000-7000-9000-000000000301',
               '2000000000015', 'ean13', true)`,
    );

    // Es el bug más caro del POS: escanear un código y agregar el producto
    // equivocado. La base lo impide, no la interfaz.
    await expect(
      cliente.query(
        `INSERT INTO product_barcodes (id, product_id, codigo, simbologia)
         VALUES ('01900000-0000-7000-9000-000000000402', '01900000-0000-7000-9000-000000000302',
                 '2000000000015', 'ean13')`,
      ),
    ).rejects.toThrow(/uq_barcode/);
  });

  test('un producto puede tener varios códigos: el de fábrica y el interno', async () => {
    const ID_LAPIZ = '01900000-0000-7000-9000-000000000303';
    await crearProducto(ID_LAPIZ, 'Lápiz del 2');

    // El fabricante imprime uno y nosotros pegamos otro. El mismo producto, dos
    // formas de escanearlo: eso es lo que `uq_barcode` NO impide, porque la
    // restricción es sobre el código, no sobre el producto.
    await cliente.query(
      `INSERT INTO product_barcodes (id, product_id, codigo, simbologia, es_primario)
       VALUES ('01900000-0000-7000-9000-000000000404', $1, '4006381333931', 'ean13', true),
              ('01900000-0000-7000-9000-000000000405', $1, '2000000000022', 'ean13', false)`,
      [ID_LAPIZ],
    );

    const { rows } = await cliente.query<{ codigo: string }>(
      `SELECT codigo FROM product_barcodes
        WHERE product_id = $1 AND deleted_at IS NULL
        ORDER BY codigo`,
      [ID_LAPIZ],
    );

    expect(rows.map((r) => r.codigo)).toEqual(['2000000000022', '4006381333931']);
  });

  test('rechaza una simbología desconocida', async () => {
    await expect(
      cliente.query(
        `INSERT INTO product_barcodes (id, product_id, codigo, simbologia)
         VALUES ('01900000-0000-7000-9000-000000000403', '01900000-0000-7000-9000-000000000301',
                 'ANAQ-A-1-1', 'barras_magicas')`,
      ),
    ).rejects.toThrow(/product_barcodes.*check constraint/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('esquema: ventas, caja y política', () => {
  test('el arqueo se calcula como contado − esperado, nunca contado + esperado', async () => {
    const { rows } = await cliente.query<{ diferencia_minor: string }>(
      `SELECT diferencia_minor FROM cash_sessions WHERE id = $1`,
      [ID_TURNO],
    );
    // Se esperaban 100000 ($1 000) y se contaron 115000 ($1 150) → sobrante $150.
    // El error clásico es sumar y obtener $2 150.
    expect(Number(rows[0]?.diferencia_minor)).toBe(15000);
  });

  test('el folio de venta es un consecutivo que asigna la base', async () => {
    await crearVenta('01900000-0000-7000-9000-000000000501', 'completada');
    await crearVenta('01900000-0000-7000-9000-000000000502', 'completada');

    const { rows } = await cliente.query<{ folio: string }>(
      `SELECT folio FROM sales WHERE id IN ($1, $2) ORDER BY folio`,
      ['01900000-0000-7000-9000-000000000501', '01900000-0000-7000-9000-000000000502'],
    );
    const folios = rows.map((r) => Number(r.folio));
    expect(folios).toHaveLength(2);
    expect(folios[1]).toBe((folios[0] ?? 0) + 1);
  });

  test('una venta no se puede cobrar dos veces por un reintento (idempotency_key)', async () => {
    await crearVenta('01900000-0000-7000-9000-000000000503', 'completada');
    await expect(
      cliente.query(
        `INSERT INTO sales (id, folio_local, cash_session_id, terminal_id, user_id,
           subtotal_minor, total_minor, estado, idempotency_key, device_id, evento_id, ocurrido_at)
         VALUES ('01900000-0000-7000-9000-000000000504', 'C1-000099', $1, $2, $3, 1000, 1000,
                 'completada', 'idem-01900000-0000-7000-9000-000000000503', $2, 'evt-x', now())`,
        [ID_TURNO, ID_DISPOSITIVO, ID_USUARIO],
      ),
    ).rejects.toThrow(/idempotency_key/);
  });

  test('una venta cancelada tiene que decir cuándo, quién y por qué', async () => {
    // Sin motivo: rechazada.
    await expect(
      crearVenta('01900000-0000-7000-9000-000000000505', 'cancelada', {
        cancelada_at: '2026-01-01T00:00:00Z',
        cancelada_por: ID_USUARIO,
      }),
    ).rejects.toThrow(/ck_cancelada_completa/);

    // Con motivo en blanco: rechazada.
    await expect(
      crearVenta('01900000-0000-7000-9000-000000000506', 'cancelada', {
        cancelada_at: '2026-01-01T00:00:00Z',
        cancelada_por: ID_USUARIO,
        motivo_cancelacion: '   ',
      }),
    ).rejects.toThrow(/ck_cancelada_completa/);

    // Completa: aceptada.
    await crearVenta('01900000-0000-7000-9000-000000000507', 'cancelada', {
      cancelada_at: '2026-01-01T00:00:00Z',
      cancelada_por: ID_USUARIO,
      motivo_cancelacion: 'El cliente se arrepintió',
    });
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM sales WHERE estado = 'cancelada'`,
      ),
    ).toBe(1);
  });

  test('una venta no cancelada no necesita motivo', async () => {
    await crearVenta('01900000-0000-7000-9000-000000000508', 'completada');
    expect(
      await contar(`SELECT count(*)::int AS n FROM sales WHERE estado = 'completada'`),
    ).toBe(4);
  });

  test('rechaza un estado de venta que no existe', async () => {
    await expect(
      crearVenta('01900000-0000-7000-9000-000000000509', 'pagada'),
    ).rejects.toThrow(/sales.*check constraint/);
  });

  test('un permiso tiene que llamarse recurso:accion', async () => {
    // 'puedeEditarPrecios' es el error clásico que rompe el mapeo automático a
    // endpoints y pantallas (doc 06 §3.2 y §8).
    await expect(
      cliente.query(
        `INSERT INTO permissions (id, clave, recurso, accion)
         VALUES ('01900000-0000-7000-8001-000000000099', 'puedeEditarPrecios', 'precios', 'editar')`,
      ),
    ).rejects.toThrow(/ck_permiso_formato/);
  });

  test('una política solo admite obligaciones del catálogo', async () => {
    // 'stepup' en vez de 'step_up' no se cumple nunca y la regla deja de proteger
    // en silencio: la base lo rechaza.
    await expect(
      cliente.query(
        `INSERT INTO policies (id, efecto, condicion, obligaciones, motivo)
         VALUES ('P-ejemplo', 'permitir', '{"op":"gt","campo":"recurso.monto_minor","valor":100}'::jsonb,
                 ARRAY['stepup'], 'Ejemplo')`,
      ),
    ).rejects.toThrow(/ck_obligaciones_conocidas/);

    // Una obligación conocida: aceptada.
    await cliente.query(
      `INSERT INTO policies (id, efecto, condicion, obligaciones, motivo)
       VALUES ('P-ejemplo', 'permitir', '{"op":"gt","campo":"recurso.monto_minor","valor":100}'::jsonb,
               ARRAY['step_up'], 'Ejemplo')`,
    );
  });

  test('una política con condición vacía no entra: la condición es un árbol con operador', async () => {
    await expect(
      cliente.query(
        `INSERT INTO policies (id, efecto, condicion, motivo)
         VALUES ('P-vacia', 'denegar', '{}'::jsonb, 'Sin condición')`,
      ),
    ).rejects.toThrow(/policies.*check constraint/);
  });

  test('rechaza un efecto que no sea permitir ni denegar', async () => {
    await expect(
      cliente.query(
        `INSERT INTO policies (id, efecto, condicion, motivo)
         VALUES ('P-raro', 'quizas', '{"op":"gt"}'::jsonb, 'Dudosa')`,
      ),
    ).rejects.toThrow(/policies.*check constraint/);
  });

  test('un dispositivo solo puede ser terminal, scanner o server', async () => {
    await expect(
      cliente.query(
        `INSERT INTO devices (id, nombre, tipo) VALUES
           ('01900000-0000-7000-9000-000000000601', 'Tablet', 'tablet')`,
      ),
    ).rejects.toThrow(/devices.*check constraint/);
  });
});
