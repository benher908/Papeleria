/**
 * El catálogo: dar de alta, listar y editar productos.
 *
 * Todo pasa por `emitirEvento()`, como manda docs/08 §2.1: el producto y su evento
 * entran juntos o no entra ninguno. No es ceremonia —una sincronización sin el evento
 * es un producto que existe en este aparato y que el servidor no conocerá nunca— y por
 * eso aquí no hay ni un `INSERT` fuera de `aplicarEstado`.
 *
 * ─── TRES COSAS QUE NO SON OBVIAS ───────────────────────────────────────────
 *
 * **El código interno se pide dentro de la transacción.** `generarCodigoInterno()`
 * reserva un número en `barcode_sequences`; si la validación falla después, la
 * transacción se revierte y el número vuelve a estar libre. Pedirlo antes de abrir la
 * transacción gastaría números en cada intento fallido.
 *
 * **Un código pertenece a un solo producto, y eso se comprueba ANTES de insertar.**
 * El `UNIQUE` de la base lo impide igual, pero el error de Postgres dice
 * «duplicate key value violates unique constraint uq_barcode» y el dueño necesita leer
 * «ese código ya es de «Goma blanca»». Se consulta dentro de la transacción para que
 * no haya carrera entre comprobar e insertar.
 *
 * **Dar de alta un producto con precio por debajo del costo se autoriza como cambio de
 * precio.** El permiso `productos:crear` no dice nada de precios, y P1 (precio < costo)
 * se dispara con `precios:editar`. Si sólo se pidiera `productos:crear`, el alta sería
 * la puerta de atrás de la regla que más protege al dueño. Así que cuando el precio
 * queda por debajo del costo se piden los dos permisos y P1 decide.
 *
 * Lo que NO se hace todavía: el `step_up` de P3 (precio igual al costo) y la edición de
 * códigos de un producto existente. Se ven en la interfaz y se anotan aquí para que no
 * parezcan terminados.
 */

import { normalizarCodigo, uuidV7, validaCode128, validaEAN13 } from '@papeleria/core';

import { autorizar } from './autorizacion';
import { emitirEvento } from './eventos';
import type { ClienteSql, ClienteTransaccional } from './runner';
import { generarCodigoInterno } from './secuencias';

// ───────────────────────────── tipos ─────────────────────────────

export interface ContextoCatalogo {
  readonly usuarioId: string;
  readonly dispositivoId: string;
  /** Reloj inyectable para las pruebas. */
  readonly ahora?: number;
}

export interface DatosProducto {
  readonly nombre: string;
  readonly unitId: string;
  /** Precio de venta en centavos, IVA incluido. Tiene que ser > 0. */
  readonly precioMinor: bigint;
  readonly costoMinor?: bigint;
  readonly sku?: string | null;
  readonly descripcion?: string | null;
  readonly categoryId?: string | null;
  readonly supplierId?: string | null;
  readonly taxRateId?: string | null;
  readonly tracksStock?: boolean;
  readonly stockMinimo?: number;
  readonly stockMaximo?: number | null;
  readonly ubicacion?: string | null;
  readonly permiteVentaFraccion?: boolean;
  readonly notas?: string | null;
  /**
   * Códigos a registrar, tal como los teclee el dueño. Se normalizan aquí.
   * Si no se pasa ninguno, se genera uno interno (EAN-13 con prefijo 2).
   */
  readonly codigos?: readonly string[];
}

export interface ProductoCreado {
  readonly id: string;
  /** Todos los códigos del producto, incluido el interno si se generó. */
  readonly codigos: readonly string[];
}

export interface CambiosProducto {
  readonly nombre?: string;
  readonly precioMinor?: bigint;
  readonly costoMinor?: bigint;
  readonly categoryId?: string | null;
  readonly supplierId?: string | null;
  readonly stockMinimo?: number;
  readonly stockMaximo?: number | null;
  readonly ubicacion?: string | null;
  readonly isActivo?: boolean;
  readonly notas?: string | null;
}

export interface FilaProducto {
  readonly id: string;
  readonly nombre: string;
  readonly sku: string | null;
  readonly precioMinor: string;
  readonly costoMinor: string;
  readonly categoria: string | null;
  readonly unidad: string;
  readonly unidadAbreviatura: string;
  readonly stock: string;
  /**
   * El punto de reposición: no es el stock que hay, es el aviso de «ya casi no queda».
   *
   * Va en la fila porque el formulario lo edita: si no viniera, al editar cualquier otra
   * cosa el formulario mandaría 0 y **borraría en silencio** lo que el dueño había
   * puesto. Se descubrió usando la pantalla, no las pruebas — que miraban la lista, no
   * el ida y vuelta.
   */
  readonly stockMinimo: string;
  readonly codigo: string | null;
  readonly ubicacion: string | null;
  readonly isActivo: boolean;
}

interface PayloadProducto {
  readonly producto: {
    readonly id: string;
    readonly nombre: string;
    readonly sku: string | null;
    readonly descripcion: string | null;
    readonly category_id: string | null;
    readonly supplier_id: string | null;
    readonly unit_id: string;
    readonly tax_rate_id: string | null;
    readonly precio_minor: string;
    readonly costo_minor: string;
    readonly tracks_stock: boolean;
    readonly stock_minimo: string;
    readonly stock_maximo: string | null;
    readonly ubicacion: string | null;
    readonly permite_venta_fraccion: boolean;
    readonly notas: string | null;
    readonly is_activo: boolean;
  };
  readonly presentacion: {
    readonly id: string;
    readonly unit_id: string;
    readonly nombre: string;
    readonly factor: string;
    readonly precio_minor: string;
    readonly is_base: boolean;
  };
  readonly codigos: ReadonlyArray<{
    readonly id: string;
    readonly codigo: string;
    readonly simbologia: 'ean13' | 'code128';
    readonly es_primario: boolean;
    readonly es_interno: boolean;
    readonly presentacion_id: string;
  }>;
}

interface FilaProductoActual {
  readonly nombre: string;
  readonly precio_minor: string | number | bigint;
  readonly costo_minor: string | number | bigint;
  readonly category_id: string | null;
  readonly supplier_id: string | null;
  readonly stock_minimo: string | number;
  readonly stock_maximo: string | number | null;
  readonly ubicacion: string | null;
  readonly is_activo: boolean;
  readonly notas: string | null;
}

interface PayloadProductoActualizado {
  readonly id: string;
  readonly antes: FilaProductoActual;
  readonly despues: {
    readonly nombre: string;
    readonly precio_minor: string;
    readonly costo_minor: string;
    readonly category_id: string | null;
    readonly supplier_id: string | null;
    readonly stock_minimo: string;
    readonly stock_maximo: string | null;
    readonly ubicacion: string | null;
    readonly is_activo: boolean;
    readonly notas: string | null;
  };
}

/** Algo del producto no sirve. El mensaje es para el dueño, no para el registro. */
export class ErrorProducto extends Error {}

/** Un código no es un EAN-13 válido ni un Code 128 legible. */
export class ErrorCodigoInvalido extends ErrorProducto {}

/** Ese código ya está en otro producto. */
export class ErrorCodigoDuplicado extends ErrorProducto {
  readonly codigo: string;
  readonly producto: string;

  constructor(codigo: string, producto: string) {
    super(`El código ${codigo} ya es del producto «${producto}».`);
    this.name = 'ErrorCodigoDuplicado';
    this.codigo = codigo;
    this.producto = producto;
  }
}

// ───────────────────────────── alta ─────────────────────────────

export async function crearProducto(
  cliente: ClienteTransaccional,
  datos: DatosProducto,
  contexto: ContextoCatalogo,
): Promise<ProductoCreado> {
  const nombre = datos.nombre.trim();
  if (nombre === '') {
    throw new ErrorProducto('El producto necesita un nombre.');
  }
  if (datos.precioMinor <= 0n) {
    throw new ErrorProducto('El precio de venta tiene que ser mayor que cero.');
  }
  if (datos.costoMinor !== undefined && datos.costoMinor < 0n) {
    throw new ErrorProducto('El costo no puede ser negativo.');
  }

  const costo = datos.costoMinor ?? 0n;
  const id = uuidV7();
  const presentacionId = uuidV7();
  const ahora = contexto.ahora;

  const evento = await emitirEvento<'product.created', PayloadProducto>(cliente, {
    tipo: 'product.created',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    autorizar: async (_evento, tx) => {
      const alta = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'productos:crear',
        recurso: { tipo: 'producto', id },
        ...(ahora === undefined ? {} : { ahora }),
      });
      if (!alta.permitido) return alta;

      // Precio por debajo del costo: es un cambio de precio, y P1 lo prohíbe.
      if (costo > 0n && datos.precioMinor < costo) {
        return autorizar(tx, {
          usuarioId: contexto.usuarioId,
          dispositivoId: contexto.dispositivoId,
          permiso: 'precios:editar',
          recurso: {
            tipo: 'precio',
            precio_nuevo_minor: Number(datos.precioMinor),
            costo_minor: Number(costo),
          },
          ...(ahora === undefined ? {} : { ahora }),
        });
      }
      return alta;
    },

    // El payload se construye dentro de la transacción porque ahí se reserva el código
    // interno y ahí se comprueban los duplicados con el cerrojo puesto.
    payload: async (tx) => {
      const codigos = await resolverCodigos(tx, datos.codigos);
      const unidad = await nombreDeUnidad(tx, datos.unitId);

      return {
        producto: {
          id,
          nombre,
          sku: datos.sku?.trim() || null,
          descripcion: datos.descripcion?.trim() || null,
          category_id: datos.categoryId ?? null,
          supplier_id: datos.supplierId ?? null,
          unit_id: datos.unitId,
          tax_rate_id: datos.taxRateId ?? null,
          precio_minor: datos.precioMinor.toString(),
          costo_minor: costo.toString(),
          tracks_stock: datos.tracksStock ?? true,
          stock_minimo: (datos.stockMinimo ?? 0).toFixed(3),
          stock_maximo: datos.stockMaximo === undefined || datos.stockMaximo === null
            ? null
            : datos.stockMaximo.toFixed(3),
          ubicacion: datos.ubicacion?.trim() || null,
          permite_venta_fraccion: datos.permiteVentaFraccion ?? false,
          notas: datos.notas?.trim() || null,
          is_activo: true,
        },
        presentacion: {
          id: presentacionId,
          unit_id: datos.unitId,
          nombre: unidad,
          factor: '1',
          precio_minor: datos.precioMinor.toString(),
          is_base: true,
        },
        codigos: codigos.map((codigo) => ({
          id: uuidV7(),
          codigo: codigo.codigo,
          simbologia: codigo.simbologia,
          es_primario: codigo.esPrimario,
          es_interno: codigo.esInterno,
          presentacion_id: presentacionId,
        })),
      };
    },

    aplicarEstado: async (tx, completo) => {
      const { producto, presentacion, codigos } = completo.payload;

      await tx.query(
        `INSERT INTO products
           (id, sku, nombre, descripcion, category_id, supplier_id, unit_id, tax_rate_id,
            precio_minor, costo_minor, tracks_stock, stock_minimo, stock_maximo,
            ubicacion, permite_venta_fraccion, is_activo, notas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, $16)`,
        [
          producto.id, producto.sku, producto.nombre, producto.descripcion,
          producto.category_id, producto.supplier_id, producto.unit_id, producto.tax_rate_id,
          producto.precio_minor, producto.costo_minor, producto.tracks_stock,
          producto.stock_minimo, producto.stock_maximo, producto.ubicacion,
          producto.permite_venta_fraccion, producto.notas,
        ],
      );

      await tx.query(
        `INSERT INTO product_presentations
           (id, product_id, unit_id, nombre, factor, precio_minor, is_base)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          presentacion.id, producto.id, presentacion.unit_id, presentacion.nombre,
          presentacion.factor, presentacion.precio_minor,
        ],
      );

      for (const codigo of codigos) {
        await tx.query(
          `INSERT INTO product_barcodes
             (id, product_id, presentacion_id, codigo, simbologia, es_primario, es_interno)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            codigo.id, producto.id, codigo.presentacion_id, codigo.codigo,
            codigo.simbologia, codigo.es_primario, codigo.es_interno,
          ],
        );
      }
    },

    auditoria: { accion: 'product.created', entidad: 'products', entidadId: id },
  });

  return {
    id,
    codigos: evento.payload.codigos.map((codigo) => codigo.codigo),
  };
}

// ───────────────────────────── lectura ─────────────────────────────

/**
 * Los productos vivos, con lo que la lista necesita para no hacer N+1 consultas.
 *
 * `filtro` busca por nombre, SKU y código. Se usa `ILIKE` y no el índice GIN de
 * texto completo a propósito: para 20 productos el `ILIKE` es instantáneo, y el
 * full-text se probará cuando haya miles (F1.6). Así la búsqueda de hoy encuentra
 * «lap» dentro de «Lápiz» sin que la normalización de acentos se coma la coincidencia.
 */
export async function listarProductos(
  cliente: ClienteSql,
  filtro = '',
): Promise<FilaProducto[]> {
  const texto = `%${filtro.trim()}%`;

  const { rows } = await cliente.query<{
    id: string;
    nombre: string;
    sku: string | null;
    precio_minor: unknown;
    costo_minor: unknown;
    categoria: string | null;
    unidad: string;
    abreviatura: string;
    stock: unknown;
    codigo: string | null;
    ubicacion: string | null;
    is_activo: boolean;
    stock_minimo: unknown;
  }>(
    `SELECT p.id, p.nombre, p.sku, p.precio_minor, p.costo_minor,
            c.nombre AS categoria, u.nombre AS unidad, u.abreviatura,
            COALESCE(sl.qty_base, 0) AS stock,
            (SELECT b.codigo FROM product_barcodes b
              WHERE b.product_id = p.id AND b.deleted_at IS NULL
              ORDER BY b.es_primario DESC, b.creado_at ASC LIMIT 1) AS codigo,
            p.ubicacion, p.is_activo, p.stock_minimo
       FROM products p
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
      WHERE p.deleted_at IS NULL
        AND ($1 = '%%' OR p.nombre ILIKE $1 OR COALESCE(p.sku, '') ILIKE $1
             OR EXISTS (SELECT 1 FROM product_barcodes b
                         WHERE b.product_id = p.id AND b.deleted_at IS NULL AND b.codigo ILIKE $1))
      ORDER BY p.nombre`,
    [texto],
  );

  return rows.map((fila) => ({
    id: fila.id,
    nombre: fila.nombre,
    sku: fila.sku,
    precioMinor: String(fila.precio_minor),
    costoMinor: String(fila.costo_minor),
    categoria: fila.categoria,
    unidad: fila.unidad,
    unidadAbreviatura: fila.abreviatura,
    stock: String(fila.stock),
    stockMinimo: String(fila.stock_minimo),
    codigo: fila.codigo,
    ubicacion: fila.ubicacion,
    isActivo: fila.is_activo,
  }));
}

export async function listarCategorias(
  cliente: ClienteSql,
): Promise<Array<{ id: string; nombre: string }>> {
  const { rows } = await cliente.query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM categories WHERE deleted_at IS NULL ORDER BY nombre`,
  );
  return rows;
}

export async function listarUnidades(
  cliente: ClienteSql,
): Promise<Array<{ id: string; nombre: string; abreviatura: string }>> {
  const { rows } = await cliente.query<{ id: string; nombre: string; abreviatura: string }>(
    `SELECT id, nombre, abreviatura FROM units ORDER BY nombre`,
  );
  return rows;
}

// ───────────────────────────── edición ─────────────────────────────

export async function actualizarProducto(
  cliente: ClienteTransaccional,
  id: string,
  cambios: CambiosProducto,
  contexto: ContextoCatalogo,
): Promise<void> {
  const ahora = contexto.ahora;

  await emitirEvento<'product.updated', PayloadProductoActualizado>(cliente, {
    tipo: 'product.updated',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    autorizar: async (_evento, tx) => {
      const edicion = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'productos:editar',
        recurso: { tipo: 'producto', id },
        ...(ahora === undefined ? {} : { ahora }),
      });
      if (!edicion.permitido) return edicion;

      // Cambiar el precio (o el costo, que lo deja debajo) es un cambio de precio: P1 y
      // P2 tienen que decidir. Se leen los dos valores de la base porque un cambio
      // parcial —sólo el costo, por ejemplo— necesita el precio que ya estaba.
      if (cambios.precioMinor !== undefined || cambios.costoMinor !== undefined) {
        const actual = await tx.query<{ precio_minor: string | number | bigint; costo_minor: string | number | bigint }>(
          `SELECT precio_minor, costo_minor FROM products WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const fila = actual.rows[0];
        if (fila !== undefined) {
          const precio = cambios.precioMinor ?? BigInt(String(fila.precio_minor));
          const costo = cambios.costoMinor ?? BigInt(String(fila.costo_minor));
          if (precio <= 0n || (costo > 0n && precio < costo)) {
            return autorizar(tx, {
              usuarioId: contexto.usuarioId,
              dispositivoId: contexto.dispositivoId,
              permiso: 'precios:editar',
              recurso: {
                tipo: 'precio',
                precio_nuevo_minor: Number(precio),
                costo_minor: Number(costo),
              },
              ...(ahora === undefined ? {} : { ahora }),
            });
          }
        }
      }
      return edicion;
    },

    payload: async (tx) => {
      const actual = await tx.query<FilaProductoActual>(
        `SELECT nombre, precio_minor, costo_minor, category_id, supplier_id,
                stock_minimo, stock_maximo, ubicacion, is_activo, notas
           FROM products WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      const antes = actual.rows[0];
      if (antes === undefined) {
        throw new ErrorProducto('El producto no existe o está dado de baja.');
      }

      const despues = {
        nombre: cambios.nombre?.trim() ?? String(antes.nombre),
        precio_minor: (cambios.precioMinor ?? BigInt(String(antes.precio_minor))).toString(),
        costo_minor: (cambios.costoMinor ?? BigInt(String(antes.costo_minor))).toString(),
        category_id: cambios.categoryId === undefined ? antes.category_id : cambios.categoryId,
        supplier_id: cambios.supplierId === undefined ? antes.supplier_id : cambios.supplierId,
        stock_minimo: (cambios.stockMinimo ?? Number(antes.stock_minimo)).toFixed(3),
        stock_maximo:
          cambios.stockMaximo === undefined
            ? (antes.stock_maximo === null ? null : String(antes.stock_maximo))
            : (cambios.stockMaximo === null ? null : cambios.stockMaximo.toFixed(3)),
        ubicacion: cambios.ubicacion === undefined ? antes.ubicacion : cambios.ubicacion,
        is_activo: cambios.isActivo ?? Boolean(antes.is_activo),
        notas: cambios.notas === undefined ? antes.notas : cambios.notas,
      };

      if (despues.nombre === '') {
        throw new ErrorProducto('El producto necesita un nombre.');
      }

      return { id, antes, despues };
    },

    aplicarEstado: async (tx, completo) => {
      const { despues } = completo.payload;
      await tx.query(
        `UPDATE products
            SET nombre = $2, precio_minor = $3, costo_minor = $4, category_id = $5,
                supplier_id = $6, stock_minimo = $7, stock_maximo = $8, ubicacion = $9,
                is_activo = $10, notas = $11, actualizado_at = now()
          WHERE id = $1`,
        [
          completo.payload.id, despues.nombre, despues.precio_minor, despues.costo_minor,
          despues.category_id, despues.supplier_id, despues.stock_minimo,
          despues.stock_maximo, despues.ubicacion, despues.is_activo, despues.notas,
        ],
      );
    },

    auditoria: { accion: 'product.updated', entidad: 'products', entidadId: id },
  });
}

// ───────────────────────────── piezas ─────────────────────────────

interface CodigoResuelto {
  readonly codigo: string;
  readonly simbologia: 'ean13' | 'code128';
  readonly esPrimario: boolean;
  readonly esInterno: boolean;
}

/**
 * Normaliza, valida y comprueba los códigos. Si no hay ninguno, genera el interno.
 *
 * Corre dentro de la transacción: la consulta de duplicados y la reserva del número
 * tienen que ver el mismo estado que el `INSERT`.
 */
async function resolverCodigos(
  tx: ClienteSql,
  crudos: readonly string[] | undefined,
): Promise<CodigoResuelto[]> {
  if (crudos === undefined || crudos.length === 0) {
    return [
      {
        codigo: await generarCodigoInterno(tx),
        simbologia: 'ean13',
        esPrimario: true,
        esInterno: true,
      },
    ];
  }

  const normalizados = crudos
    .map((codigo) => normalizarCodigo(codigo))
    .filter((codigo) => codigo !== '');

  if (normalizados.length === 0) {
    // Todos vacíos: es lo mismo que no haber puesto ninguno.
    return resolverCodigos(tx, undefined);
  }

  const vistos = new Set<string>();
  const resueltos: CodigoResuelto[] = [];

  for (const [indice, codigo] of normalizados.entries()) {
    if (vistos.has(codigo)) {
      throw new ErrorCodigoInvalido(`El código ${codigo} está repetido en el mismo producto.`);
    }
    vistos.add(codigo);

    const simbologia = validarCodigo(codigo);

    const dueno = await tx.query<{ nombre: string }>(
      `SELECT p.nombre
         FROM product_barcodes b
         JOIN products p ON p.id = b.product_id
        WHERE b.codigo = $1 AND b.deleted_at IS NULL
        LIMIT 1`,
      [codigo],
    );
    const nombre = dueno.rows[0]?.nombre;
    if (nombre !== undefined) {
      throw new ErrorCodigoDuplicado(codigo, nombre);
    }

    resueltos.push({
      codigo,
      simbologia,
      esPrimario: indice === 0,
      esInterno: false,
    });
  }

  return resueltos;
}

/**
 * ¿Es un EAN-13 o un Code 128?
 *
 * Trece dígitos es un EAN-13 y se le exige el verificador: un dígito mal tecleado
 * crearía un producto que ningún lector encontraría. Cualquier otra cosa se juzga como
 * Code 128 legible (`ANAQ-A-3-12`, `PAP-LAP-2`).
 */
function validarCodigo(codigo: string): 'ean13' | 'code128' {
  if (/^\d{13}$/.test(codigo)) {
    if (!validaEAN13(codigo)) {
      throw new ErrorCodigoInvalido(
        `El código ${codigo} parece un EAN-13 pero el dígito verificador no cuadra: revisa los números.`,
      );
    }
    return 'ean13';
  }

  if (!validaCode128(codigo)) {
    throw new ErrorCodigoInvalido(
      `El código ${codigo} no es legible: usa mayúsculas, números y guiones (por ejemplo ANAQ-A-3-12).`,
    );
  }
  return 'code128';
}

async function nombreDeUnidad(tx: ClienteSql, unitId: string): Promise<string> {
  const { rows } = await tx.query<{ nombre: string }>(
    `SELECT nombre FROM units WHERE id = $1`,
    [unitId],
  );
  const nombre = rows[0]?.nombre;
  if (nombre === undefined) {
    throw new ErrorProducto('La unidad de medida no existe.');
  }
  return nombre;
}
