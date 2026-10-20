/**
 * VENDER: el carrito se convierte en una venta, y la venta en hechos auditables.
 *
 * Esta es la pieza que docs/05 llama el camino caliente. Una venta escribe, en una
 * sola transacción: la venta, sus líneas, los pagos, los movimientos del ledger de
 * stock y el evento del outbox. Si algo falla, no queda nada a medias — ni una venta
 * sin stock descontado, ni un movimiento sin venta que lo explique.
 *
 * ─── DECISIONES QUE NO SON OBVIAS ─────────────────────────────────────────────
 *
 * **El precio se congela en la línea.** `sale_lines` guarda descripción, precio,
 * costo e impuesto del momento. Si mañana cambia el precio del cuaderno, el ticket
 * de ayer y el margen de ayer no cambian. Es la diferencia entre un histórico y una
 * vista que se reescribe sola.
 *
 * **Los importes viajan como texto en el payload.** `bigint` no sobrevive a JSON:
 * un `JSON.stringify(10n)` lanza. La base y el cable hablan el mismo idioma, y el
 * idioma de un entero grande es una cadena de dígitos.
 *
 * **El cambio se guarda en el pago en efectivo, no en la venta.** El arqueo suma
 * `monto − cambio` para saber qué entró al cajón. Guardar el cambio aparte, o peor,
 * sumarlo, es el error que descuadra todos los cierres (docs/05 §6).
 *
 * **El folio se asigna dentro de la transacción.** Si se asignara antes y la venta
 * fallara, quedaría un hueco en la numeración; un hueco en los folios parece una
 * venta borrada, y es la primera pregunta de cualquier auditoría.
 *
 * ─── LO QUE TODAVÍA NO HACE ──────────────────────────────────────────────────
 *
 * · La venta libre (fotocopias) necesita un producto de servicios o un cambio de
 *   esquema: `sale_lines.product_id` es NOT NULL. Se resuelve en F2.9.
 * · El step-up (PIN) no existe; un descuento de más del 10 % se rechaza con un
 *   mensaje claro en vez de pasar sin autorización (ver `obligaciones.ts`).
 */

import {
  totalizarVenta,
  uuidV7,
  type Centavos,
  type Milesimas,
} from '@papeleria/core';

import { autorizar } from './autorizacion';
import { siguienteFolioLocal } from './contadores';
import { emitirEvento } from './eventos';
import { exigirObligaciones } from './obligaciones';
import type { ClienteSql, ClienteTransaccional } from './runner';

// ───────────────────────────── tipos ─────────────────────────────

export type MetodoPago =
  | 'efectivo'
  | 'tarjeta_debito'
  | 'tarjeta_credito'
  | 'transferencia'
  | 'vale'
  | 'credito';

export const METODOS_PAGO: readonly MetodoPago[] = [
  'efectivo',
  'tarjeta_debito',
  'tarjeta_credito',
  'transferencia',
  'vale',
  'credito',
];

/** 16 % es la tasa por defecto de la papelería cuando el producto no tiene una. */
const TASA_IVA_POR_DEFECTO = 0.16;

export interface ContextoVenta {
  readonly usuarioId: string;
  readonly dispositivoId: string;
  /** Reloj inyectable para las pruebas. */
  readonly ahora?: number;
}

export interface LineaParaVender {
  readonly productoId: string;
  /** Si se omite, se usa la presentación base del producto. */
  readonly presentacionId?: string | null;
  /** Cantidad en milésimas: 1 pieza = 1000, 1.5 = 1500. */
  readonly qty: Milesimas;
  /** Si se omite, se usa el precio del catálogo. */
  readonly precioUnitarioMinor?: Centavos;
  readonly descuentoMinor?: Centavos;
  /** Si se omite, se usa el nombre del producto. */
  readonly descripcion?: string;
  /** Marca el renglón como servicio libre (fotocopias). No cambia el stock. */
  readonly esVentaLibre?: boolean;
}

export interface PagoParaVender {
  readonly metodo: MetodoPago;
  /**
   * Lo que entregó el cliente. En efectivo puede ser mayor que el total (hay
   * cambio); en los demás métodos se espera el importe exacto.
   */
  readonly montoMinor: Centavos;
  readonly referencia?: string | null;
}

export interface DatosVenta {
  /** Si se omite, se usa el turno abierto de la terminal. */
  readonly turnoId?: string;
  readonly lineas: readonly LineaParaVender[];
  readonly pagos: readonly PagoParaVender[];
  readonly clienteNombre?: string | null;
  readonly notas?: string | null;
  /** Clave para que un reintento no cobre dos veces. Se genera si no viene. */
  readonly claveIdempotencia?: string;
  /** Texto exigido por las políticas de descuento, cuando aplica. */
  readonly motivo?: string | null;
}

export interface LineaRegistrada {
  readonly lineaNo: number;
  readonly productoId: string;
  readonly presentacionId: string | null;
  readonly descripcion: string;
  readonly qty: Milesimas;
  readonly qtyBase: Milesimas;
  readonly precioUnitarioMinor: Centavos;
  readonly descuentoMinor: Centavos;
  readonly impuestoMinor: Centavos;
  readonly totalLineaMinor: Centavos;
  readonly costoUnitarioMinor: Centavos;
}

export interface PagoRegistrado {
  readonly metodo: MetodoPago;
  readonly montoMinor: Centavos;
  readonly cambioMinor: Centavos;
  readonly referencia: string | null;
}

export interface VentaRegistrada {
  readonly ventaId: string;
  readonly folioLocal: string;
  readonly turnoId: string;
  readonly subtotalMinor: Centavos;
  readonly descuentoMinor: Centavos;
  readonly impuestoMinor: Centavos;
  readonly totalMinor: Centavos;
  readonly cambioMinor: Centavos;
  readonly ocurridoAt: string;
  readonly lineas: readonly LineaRegistrada[];
  readonly pagos: readonly PagoRegistrado[];
}

export interface VentaDetalle extends VentaRegistrada {
  readonly estado: string;
  readonly clienteNombre: string | null;
  readonly notas: string | null;
}

/** Algo de la venta no se puede hacer; el mensaje es para la cajera. */
export class ErrorVenta extends Error {}

interface LineaCalculadaParaPayload {
  readonly linea_no: number;
  readonly producto_id: string;
  readonly presentacion_id: string | null;
  readonly descripcion: string;
  readonly qty: string;
  readonly qty_base: string;
  readonly precio_unitario_minor: string;
  readonly descuento_minor: string;
  readonly impuesto_minor: string;
  readonly total_linea_minor: string;
  readonly costo_unitario_minor: string;
  readonly tax_rate_id: string | null;
  readonly tracks_stock: boolean;
  readonly es_venta_libre: boolean;
}

interface PagoParaPayload {
  readonly metodo: MetodoPago;
  readonly monto_minor: string;
  readonly cambio_minor: string;
  readonly referencia: string | null;
}

interface PayloadVenta {
  readonly venta_id: string;
  readonly folio_local: string;
  readonly turno_id: string;
  readonly terminal_id: string;
  readonly user_id: string;
  readonly subtotal_minor: string;
  readonly descuento_minor: string;
  readonly impuesto_minor: string;
  readonly total_minor: string;
  readonly cambio_minor: string;
  readonly ocurrido_at: string;
  readonly cliente_nombre: string | null;
  readonly notas: string | null;
  readonly lineas: readonly LineaCalculadaParaPayload[];
  readonly pagos: readonly PagoParaPayload[];
}

interface PayloadCancelacion {
  readonly venta_id: string;
  readonly folio_local: string;
  readonly motivo: string;
  readonly cancelada_at: string;
}

// ───────────────────────────── vender ─────────────────────────────

/**
 * Registra una venta completa.
 *
 * Todo el cálculo ocurre dentro de la transacción del evento, con el precio y el
 * costo que hay en ese instante. La autorización también: las políticas que
 * deciden son las que verá el COMMIT.
 */
export async function registrarVenta(
  cliente: ClienteTransaccional,
  datos: DatosVenta,
  contexto: ContextoVenta,
): Promise<VentaRegistrada> {
  validarEntrada(datos);

  const ventaId = uuidV7();
  const turnoId = datos.turnoId ?? (await turnoAbiertoDeLaTerminal(cliente, contexto.dispositivoId));
  if (turnoId === null) {
    throw new ErrorVenta(
      'No hay turno de caja abierto. Ábrelo antes de vender: sin turno no hay arqueo.',
    );
  }

  const ahora = contexto.ahora;

  const evento = await emitirEvento<'sale.created', PayloadVenta>(cliente, {
    tipo: 'sale.created',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    payload: async (tx, datosEvento) => {
      await comprobarTurnoAbierto(tx, turnoId, contexto.dispositivoId);

      const lineas: LineaCalculadaParaPayload[] = [];
      const entradas: Array<Parameters<typeof totalizarVenta>[0][number]> = [];

      for (const [indice, linea] of datos.lineas.entries()) {
        const resuelta = await resolverLinea(tx, linea);
        lineas.push({ ...resuelta.linea, linea_no: indice + 1 });
        entradas.push(resuelta.entrada);
      }

      const totales = totalizarVenta(entradas);
      if (totales.total <= 0n) {
        throw new ErrorVenta('El total de la venta tiene que ser mayor que cero.');
      }

      // El cálculo por línea se completa aquí: `resolverLinea` sólo conoce precio y
      // cantidad, y es `calcularLinea` (con el IVA despejado hacia atrás) quien
      // decide cuánto de cada línea es impuesto. La suma tiene que cuadrar con el
      // total del ticket, y por eso los dos salen de la misma llamada.
      for (const [indice, calculada] of totales.lineas.entries()) {
        const linea = lineas[indice];
        if (linea === undefined) continue;
        lineas[indice] = {
          ...linea,
          impuesto_minor: calculada.iva.toString(),
          total_linea_minor: calculada.total.toString(),
        };
      }

      const pagos = repartirCambio(datos.pagos, totales.total);
      const cambio = pagos.reduce((suma, pago) => suma + pago.cambioMinor, 0n);

      return {
        venta_id: ventaId,
        folio_local: await siguienteFolioLocal(tx, datosEvento.device_id),
        turno_id: turnoId,
        terminal_id: datosEvento.device_id,
        user_id: datosEvento.user_id,
        subtotal_minor: totales.subtotal.toString(),
        descuento_minor: totales.descuento.toString(),
        impuesto_minor: totales.iva.toString(),
        total_minor: totales.total.toString(),
        cambio_minor: cambio.toString(),
        ocurrido_at: datosEvento.occurred_at,
        cliente_nombre: datos.clienteNombre?.trim() || null,
        notas: datos.notas?.trim() || null,
        lineas,
        pagos: pagos.map((pago) => ({
          metodo: pago.metodo,
          monto_minor: pago.montoMinor.toString(),
          cambio_minor: pago.cambioMinor.toString(),
          referencia: pago.referencia?.trim() || null,
        })),
      };
    },

    autorizar: async (eventoParcial, tx) => {
      const p = eventoParcial.payload;
      const decision = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'ventas:crear',
        recurso: {
          tipo: 'venta',
          id: ventaId,
          monto_minor: Number(p.total_minor),
          descuento_minor: Number(p.descuento_minor),
          descuento_pct: porcentajeDeDescuento(p.total_minor, p.descuento_minor),
        },
        // Todavía no existe sincronización, así que el dispositivo no puede estar
        // "sin red" en un sentido útil: no hay remoto del que desconectarse. Cuando
        // exista `apps/api` (F4), este valor sale del sincronizador y activa P25–P30.
        entorno: { es_offline: false },
        ...(ahora === undefined ? {} : { ahora }),
      });

      return exigirObligaciones(decision, {
        motivo: datos.motivo ?? null,
        queFalta:
          'Esta venta necesita autorización del dueño.',
      });
    },

    aplicarEstado: async (tx, completo) => {
      const p = completo.payload;

      await tx.query(
        `INSERT INTO sales
           (id, folio_local, cash_session_id, terminal_id, user_id, cliente_nombre,
            subtotal_minor, descuento_minor, impuesto_minor, total_minor, estado,
            idempotency_key, device_id, evento_id, ocurrido_at, notas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completada',
                 $11, $12, $13, $14, $15)`,
        [
          p.venta_id,
          p.folio_local,
          p.turno_id,
          p.terminal_id,
          p.user_id,
          p.cliente_nombre,
          p.subtotal_minor,
          p.descuento_minor,
          p.impuesto_minor,
          p.total_minor,
          datos.claveIdempotencia ?? uuidV7(),
          p.terminal_id,
          completo.event_id,
          p.ocurrido_at,
          p.notas,
        ],
      );

      for (const linea of p.lineas) {
        await tx.query(
          `INSERT INTO sale_lines
             (id, sale_id, linea_no, product_id, presentacion_id, descripcion, qty,
              qty_base, precio_unitario_minor, descuento_minor, impuesto_minor,
              total_linea_minor, costo_unitario_minor, tax_rate_id, es_venta_libre)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            uuidV7(),
            p.venta_id,
            linea.linea_no,
            linea.producto_id,
            linea.presentacion_id,
            linea.descripcion,
            linea.qty,
            linea.qty_base,
            linea.precio_unitario_minor,
            linea.descuento_minor,
            linea.impuesto_minor,
            linea.total_linea_minor,
            linea.costo_unitario_minor,
            linea.tax_rate_id,
            linea.es_venta_libre,
          ],
        );

        // El ledger es la verdad del stock; `stock_levels` lo actualiza el trigger.
        // Vender no toca la caché a mano: si se pudiera, habría dos formas de
        // cambiar el inventario y una de ellas se olvidaría.
        if (linea.tracks_stock && !linea.es_venta_libre) {
          await tx.query(
            `INSERT INTO stock_movements
               (id, product_id, presentacion_id, qty, qty_base, motivo, ref_type,
                ref_id, costo_unitario_minor, user_id, device_id, ocurrido_at)
             VALUES ($1, $2, $3, $4, $5, 'venta', 'sale', $6, $7, $8, $9, $10)`,
            [
              uuidV7(),
              linea.producto_id,
              linea.presentacion_id,
              negar(linea.qty),
              negar(linea.qty_base),
              p.venta_id,
              linea.costo_unitario_minor,
              p.user_id,
              p.terminal_id,
              p.ocurrido_at,
            ],
          );
        }
      }

      for (const pago of p.pagos) {
        await tx.query(
          `INSERT INTO payments
             (id, sale_id, metodo, monto_minor, cambio_minor, referencia, ocurrido_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidV7(),
            p.venta_id,
            pago.metodo,
            pago.monto_minor,
            pago.cambio_minor,
            pago.referencia,
            p.ocurrido_at,
          ],
        );
      }
    },

    auditoria: { accion: 'sale.created', entidad: 'sales', entidadId: ventaId },
  });

  return aVentaRegistrada(evento.payload);
}

// ───────────────────────────── leer ─────────────────────────────

/** Una venta con sus líneas y pagos, para reimprimir el ticket o revisarla. */
export async function obtenerVenta(cliente: ClienteSql, ventaId: string): Promise<VentaDetalle> {
  const cabecera = await cliente.query<{
    id: string;
    folio_local: string;
    cash_session_id: string;
    subtotal_minor: unknown;
    descuento_minor: unknown;
    impuesto_minor: unknown;
    total_minor: unknown;
    estado: string;
    cliente_nombre: string | null;
    notas: string | null;
    ocurrido_at: unknown;
  }>(
    `SELECT id, folio_local, cash_session_id, subtotal_minor, descuento_minor, impuesto_minor,
            total_minor, estado, cliente_nombre, notas, ocurrido_at
       FROM sales WHERE id = $1`,
    [ventaId],
  );

  const venta = cabecera.rows[0];
  if (venta === undefined) throw new ErrorVenta('La venta no existe.');

  const lineas = await cliente.query<{
    linea_no: number;
    product_id: string;
    presentacion_id: string | null;
    descripcion: string;
    qty: unknown;
    qty_base: unknown;
    precio_unitario_minor: unknown;
    descuento_minor: unknown;
    impuesto_minor: unknown;
    total_linea_minor: unknown;
    costo_unitario_minor: unknown;
  }>(
    `SELECT linea_no, product_id, presentacion_id, descripcion, qty, qty_base,
            precio_unitario_minor, descuento_minor, impuesto_minor, total_linea_minor,
            costo_unitario_minor
       FROM sale_lines WHERE sale_id = $1 ORDER BY linea_no`,
    [ventaId],
  );

  const pagos = await cliente.query<{
    metodo: MetodoPago;
    monto_minor: unknown;
    cambio_minor: unknown;
    referencia: string | null;
  }>(
    `SELECT metodo, monto_minor, cambio_minor, referencia
       FROM payments WHERE sale_id = $1 ORDER BY ocurrido_at, metodo`,
    [ventaId],
  );

  const cambio = pagos.rows.reduce((suma, pago) => suma + aBigInt(pago.cambio_minor), 0n);

  return {
    ventaId: venta.id,
    folioLocal: venta.folio_local,
    turnoId: venta.cash_session_id,
    subtotalMinor: aBigInt(venta.subtotal_minor),
    descuentoMinor: aBigInt(venta.descuento_minor),
    impuestoMinor: aBigInt(venta.impuesto_minor),
    totalMinor: aBigInt(venta.total_minor),
    cambioMinor: cambio,
    ocurridoAt: aFecha(venta.ocurrido_at),
    estado: venta.estado,
    clienteNombre: venta.cliente_nombre,
    notas: venta.notas,
    lineas: lineas.rows.map((linea) => ({
      lineaNo: linea.linea_no,
      productoId: linea.product_id,
      presentacionId: linea.presentacion_id,
      descripcion: linea.descripcion,
      qty: textoAMilesimas(linea.qty),
      qtyBase: textoAMilesimas(linea.qty_base),
      precioUnitarioMinor: aBigInt(linea.precio_unitario_minor),
      descuentoMinor: aBigInt(linea.descuento_minor),
      impuestoMinor: aBigInt(linea.impuesto_minor),
      totalLineaMinor: aBigInt(linea.total_linea_minor),
      costoUnitarioMinor: aBigInt(linea.costo_unitario_minor),
    })),
    pagos: pagos.rows.map((pago) => ({
      metodo: pago.metodo,
      montoMinor: aBigInt(pago.monto_minor),
      cambioMinor: aBigInt(pago.cambio_minor),
      referencia: pago.referencia,
    })),
  };
}

/** Las ventas de un turno, de la más reciente a la más vieja. */
export async function ventasDelTurno(
  cliente: ClienteSql,
  turnoId: string,
  limite = 50,
): Promise<
  ReadonlyArray<{
    readonly ventaId: string;
    readonly folioLocal: string;
    readonly totalMinor: Centavos;
    readonly estado: string;
    readonly ocurridoAt: string;
  }>
> {
  const { rows } = await cliente.query<{
    id: string;
    folio_local: string;
    total_minor: unknown;
    estado: string;
    ocurrido_at: unknown;
  }>(
    `SELECT id, folio_local, total_minor, estado, ocurrido_at
       FROM sales
      WHERE cash_session_id = $1
      ORDER BY ocurrido_at DESC
      LIMIT $2`,
    [turnoId, limite],
  );

  return rows.map((fila) => ({
    ventaId: fila.id,
    folioLocal: fila.folio_local,
    totalMinor: aBigInt(fila.total_minor),
    estado: fila.estado,
    ocurridoAt: aFecha(fila.ocurrido_at),
  }));
}

// ───────────────────────────── cancelar ─────────────────────────────

/**
 * Cancela una venta cobrada: no la borra.
 *
 * La venta queda con `estado = 'cancelada'`, con quién, cuándo y por qué. El stock
 * vuelve por un movimiento inverso, con `motivo = 'error_captura'`, y los pagos se
 * quedan como estaban: son historia. El arqueo excluye las ventas canceladas, que es
 * exactamente lo que debe hacer si el efectivo se devolvió.
 *
 * Exige `ventas:cancelar`, que es sensible: sin step-up se rechaza. Es la regla P8,
 * y es la protección contra el fraude número uno en caja.
 */
export async function cancelarVenta(
  cliente: ClienteTransaccional,
  datos: { readonly ventaId: string; readonly motivo: string },
  contexto: ContextoVenta,
): Promise<void> {
  const motivo = datos.motivo.trim();
  if (motivo === '') {
    throw new ErrorVenta('Una cancelación necesita un motivo escrito. No se borra nada sin explicar por qué.');
  }

  const ahora = contexto.ahora;

  await emitirEvento<'sale.cancelled', PayloadCancelacion>(cliente, {
    tipo: 'sale.cancelled',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    payload: async (tx, datosEvento) => {
      const venta = await tx.query<{ folio_local: string; total_minor: unknown; estado: string }>(
        `SELECT folio_local, total_minor, estado FROM sales WHERE id = $1`,
        [datos.ventaId],
      );
      const fila = venta.rows[0];
      if (fila === undefined) throw new ErrorVenta('La venta no existe.');
      if (fila.estado !== 'completada') {
        throw new ErrorVenta('Sólo se puede cancelar una venta completada.');
      }

      return {
        venta_id: datos.ventaId,
        folio_local: fila.folio_local,
        motivo,
        cancelada_at: datosEvento.occurred_at,
      };
    },

    autorizar: async (_eventoParcial, tx) => {
      const venta = await tx.query<{ total_minor: unknown }>(
        `SELECT total_minor FROM sales WHERE id = $1`,
        [datos.ventaId],
      );
      const decision = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'ventas:cancelar',
        recurso: {
          tipo: 'venta',
          id: datos.ventaId,
          monto_minor: Number(aBigInt(venta.rows[0]?.total_minor)),
          es_venta_ya_cerrada: true,
        },
        // Acotado a ESTA venta: autorizar la cancelación de un ticket no debe
        // autorizar la del siguiente durante los cinco minutos de vigencia.
        entidadId: datos.ventaId,
        ...(ahora === undefined ? {} : { ahora }),
      });

      return exigirObligaciones(decision, {
        motivo,
        queFalta: 'Cancelar una venta cobrada necesita autorización del dueño.',
      });
    },

    aplicarEstado: async (tx, completo) => {
      const p = completo.payload;

      await tx.query(
        `UPDATE sales
            SET estado = 'cancelada',
                cancelada_at = $2,
                cancelada_por = $3,
                motivo_cancelacion = $4
          WHERE id = $1`,
        [p.venta_id, p.cancelada_at, contexto.usuarioId, p.motivo],
      );

      const lineas = await tx.query<{
        product_id: string;
        presentacion_id: string | null;
        qty: unknown;
        qty_base: unknown;
        costo_unitario_minor: unknown;
      }>(
        `SELECT product_id, presentacion_id, qty, qty_base, costo_unitario_minor
           FROM sale_lines WHERE sale_id = $1 ORDER BY linea_no`,
        [p.venta_id],
      );

      for (const linea of lineas.rows) {
        await tx.query(
          `INSERT INTO stock_movements
             (id, product_id, presentacion_id, qty, qty_base, motivo, ref_type, ref_id,
              costo_unitario_minor, notas, user_id, device_id, ocurrido_at)
           VALUES ($1, $2, $3, $4, $5, 'error_captura', 'sale', $6, $7, $8, $9, $10, $11)`,
          [
            uuidV7(),
            linea.product_id,
            linea.presentacion_id,
            String(linea.qty),
            String(linea.qty_base),
            p.venta_id,
            aBigInt(linea.costo_unitario_minor).toString(),
            `Cancelación de la venta ${p.folio_local}`,
            contexto.usuarioId,
            contexto.dispositivoId,
            p.cancelada_at,
          ],
        );
      }
    },

    auditoria: { accion: 'sale.cancelled', entidad: 'sales', entidadId: datos.ventaId },
  });
}

// ───────────────────────────── piezas ─────────────────────────────

interface LineaResuelta {
  readonly linea: Omit<LineaCalculadaParaPayload, 'linea_no'>;
  readonly entrada: Parameters<typeof totalizarVenta>[0][number];
}

async function resolverLinea(tx: ClienteSql, linea: LineaParaVender): Promise<LineaResuelta> {
  if (!Number.isInteger(linea.qty) || linea.qty <= 0) {
    throw new ErrorVenta('La cantidad tiene que ser mayor que cero (en milésimas).');
  }

  const producto = await tx.query<{
    id: string;
    nombre: string;
    precio_minor: unknown;
    costo_minor: unknown;
    tracks_stock: boolean;
    tax_rate_id: string | null;
    tasa: unknown;
  }>(
    `SELECT p.id, p.nombre, p.precio_minor, p.costo_minor, p.tracks_stock, p.tax_rate_id,
            t.tasa
       FROM products p
       LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
      WHERE p.id = $1 AND p.deleted_at IS NULL AND p.is_activo`,
    [linea.productoId],
  );

  const p = producto.rows[0];
  if (p === undefined) {
    throw new ErrorVenta('El producto no existe, está dado de baja o no está activo.');
  }

  let presentacion: {
    id: string | null;
    nombre: string;
    factor: unknown;
    precio_minor: unknown;
    is_base: boolean;
  } = {
    id: null,
    nombre: p.nombre,
    factor: 1,
    precio_minor: p.precio_minor,
    is_base: true,
  };

  if (linea.presentacionId !== undefined && linea.presentacionId !== null) {
    const elegida = await tx.query<{
      id: string;
      nombre: string;
      factor: unknown;
      precio_minor: unknown;
      is_base: boolean;
    }>(
      `SELECT id, nombre, factor, precio_minor, is_base
         FROM product_presentations
        WHERE id = $1 AND product_id = $2 AND is_activo`,
      [linea.presentacionId, linea.productoId],
    );
    const fila = elegida.rows[0];
    if (fila === undefined) {
      throw new ErrorVenta('La presentación elegida no pertenece a ese producto.');
    }
    presentacion = fila;
  } else {
    const base = await tx.query<{
      id: string;
      nombre: string;
      factor: unknown;
      precio_minor: unknown;
      is_base: boolean;
    }>(
      `SELECT id, nombre, factor, precio_minor, is_base
         FROM product_presentations
        WHERE product_id = $1 AND is_base AND is_activo
        LIMIT 1`,
      [linea.productoId],
    );
    const fila = base.rows[0];
    if (fila !== undefined) {
      // El precio de la presentación base puede estar viejo: `actualizarProducto`
      // cambia `products.precio_minor` y no toca las presentaciones (son F1.5).
      // Para la base, el precio vigente es el del producto.
      presentacion = { ...fila, precio_minor: p.precio_minor };
    }
  }

  const factor = Number(presentacion.factor);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new ErrorVenta('La presentación tiene un factor inválido.');
  }

  const qtyBase = Math.round(linea.qty * factor);
  const precioUnitario = linea.precioUnitarioMinor ?? aBigInt(presentacion.precio_minor);
  const descuento = linea.descuentoMinor ?? 0n;
  const tasaIva = p.tasa === null || p.tasa === undefined ? TASA_IVA_POR_DEFECTO : Number(p.tasa);

  if (precioUnitario < 0n) throw new ErrorVenta('El precio unitario no puede ser negativo.');
  if (descuento < 0n) throw new ErrorVenta('El descuento no puede ser negativo.');

  // La descripción de una presentación no base aclara qué se vendió: «Cuaderno
  // (paquete 12)» en el ticket no deja duda de si fueron 12 o 1. La presentación
  // base se llama como su unidad («pieza»), y añadirla sólo ensucia el ticket.
  const descripcion =
    linea.descripcion?.trim() ||
    (presentacion.is_base || presentacion.id === null
      ? p.nombre
      : `${p.nombre} (${presentacion.nombre})`);

  return {
    linea: {
      producto_id: p.id,
      presentacion_id: presentacion.id,
      descripcion,
      qty: milesimasATexto(linea.qty),
      qty_base: milesimasATexto(qtyBase),
      precio_unitario_minor: precioUnitario.toString(),
      descuento_minor: descuento.toString(),
      impuesto_minor: '0', // se completa abajo con el total calculado
      total_linea_minor: '0',
      costo_unitario_minor: aBigInt(p.costo_minor).toString(),
      tax_rate_id: p.tax_rate_id,
      tracks_stock: p.tracks_stock,
      es_venta_libre: linea.esVentaLibre ?? false,
    },
    entrada: {
      qty: linea.qty,
      precioUnitario,
      descuento,
      tasaIva,
      ivaIncluido: true,
    },
  };
}

/**
 * Reparte el cambio entre los pagos y comprueba que la cuenta cierre.
 *
 * El cambio sólo puede salir de efectivo: una tarjeta no devuelve billetes. Si el
 * cliente entrega $200 en efectivo y $50 con tarjeta por una venta de $130, el
 * cambio son $120 y se restan del pago en efectivo (que queda aportando $80).
 */
function repartirCambio(
  pagos: readonly PagoParaVender[],
  total: Centavos,
): Array<PagoParaVender & { cambioMinor: Centavos }> {
  const preparados = pagos.map((pago) => ({ ...pago, cambioMinor: 0n }));

  let recibido = 0n;
  for (const pago of preparados) {
    if (!METODOS_PAGO.includes(pago.metodo)) {
      throw new ErrorVenta(`Método de pago desconocido: ${pago.metodo}`);
    }
    if (pago.montoMinor <= 0n) {
      throw new ErrorVenta('Cada pago tiene que ser mayor que cero.');
    }
    recibido += pago.montoMinor;
  }

  const cambio = recibido - total;
  if (cambio < 0n) {
    throw new ErrorVenta(`Falta cobrar ${formatearPesos(-cambio)}.`);
  }
  if (cambio === 0n) return preparados;

  const indiceEfectivo = preparados.reduce(
    (ultimo, pago, indice) => (pago.metodo === 'efectivo' ? indice : ultimo),
    -1,
  );
  if (indiceEfectivo === -1) {
    throw new ErrorVenta('El cambio sólo se puede dar en efectivo.');
  }

  const efectivo = preparados[indiceEfectivo];
  if (efectivo === undefined) throw new ErrorVenta('No se encontró el pago en efectivo.');
  if (efectivo.montoMinor < cambio) {
    throw new ErrorVenta('El efectivo recibido no alcanza para dar el cambio.');
  }

  efectivo.cambioMinor = cambio;
  return preparados;
}

function validarEntrada(datos: DatosVenta): void {
  if (datos.lineas.length === 0) throw new ErrorVenta('La venta está vacía.');
  if (datos.pagos.length === 0) throw new ErrorVenta('Falta registrar cómo se pagó.');
  if (datos.claveIdempotencia !== undefined && datos.claveIdempotencia.trim() === '') {
    throw new ErrorVenta('La clave de idempotencia no puede estar vacía.');
  }
}

async function comprobarTurnoAbierto(
  tx: ClienteSql,
  turnoId: string,
  dispositivoId: string,
): Promise<void> {
  const { rows } = await tx.query<{ cerrada_at: unknown }>(
    `SELECT cerrada_at FROM cash_sessions WHERE id = $1 AND terminal_id = $2`,
    [turnoId, dispositivoId],
  );
  const fila = rows[0];
  if (fila === undefined) throw new ErrorVenta('El turno no existe o es de otra terminal.');
  if (fila.cerrada_at !== null) {
    throw new ErrorVenta('El turno ya está cerrado: abre uno nuevo antes de vender.');
  }
}

async function turnoAbiertoDeLaTerminal(
  cliente: ClienteSql,
  dispositivoId: string,
): Promise<string | null> {
  const { rows } = await cliente.query<{ id: string }>(
    `SELECT id FROM cash_sessions
      WHERE terminal_id = $1 AND cerrada_at IS NULL
      ORDER BY abierta_at DESC LIMIT 1`,
    [dispositivoId],
  );
  return rows[0]?.id ?? null;
}

function aVentaRegistrada(p: PayloadVenta): VentaRegistrada {
  return {
    ventaId: p.venta_id,
    folioLocal: p.folio_local,
    turnoId: p.turno_id,
    subtotalMinor: BigInt(p.subtotal_minor),
    descuentoMinor: BigInt(p.descuento_minor),
    impuestoMinor: BigInt(p.impuesto_minor),
    totalMinor: BigInt(p.total_minor),
    cambioMinor: BigInt(p.cambio_minor),
    ocurridoAt: p.ocurrido_at,
    lineas: p.lineas.map((linea) => ({
      lineaNo: linea.linea_no,
      productoId: linea.producto_id,
      presentacionId: linea.presentacion_id,
      descripcion: linea.descripcion,
      qty: textoAMilesimas(linea.qty),
      qtyBase: textoAMilesimas(linea.qty_base),
      precioUnitarioMinor: BigInt(linea.precio_unitario_minor),
      descuentoMinor: BigInt(linea.descuento_minor),
      impuestoMinor: BigInt(linea.impuesto_minor),
      totalLineaMinor: BigInt(linea.total_linea_minor),
      costoUnitarioMinor: BigInt(linea.costo_unitario_minor),
    })),
    pagos: p.pagos.map((pago) => ({
      metodo: pago.metodo,
      montoMinor: BigInt(pago.monto_minor),
      cambioMinor: BigInt(pago.cambio_minor),
      referencia: pago.referencia,
    })),
  };
}

function porcentajeDeDescuento(total: string, descuento: string): number {
  // El descuento se compara con el importe ANTES de descontar, que es
  // `total + descuento` (el total ya lo trae restado). Con IVA incluido esta es la
  // base que ve el cliente en el ticket, y es la que hace que un 20 % se lea 20 %
  // y no 22.48 % por despejar el impuesto.
  const t = BigInt(total);
  const d = BigInt(descuento);
  const antes = t + d;
  if (antes <= 0n) return 0;
  // Dos decimales, en aritmética entera: 12.5 % es 1250 / 100.
  return Number((d * 10_000n) / antes) / 100;
}

export function milesimasATexto(milesimas: number): string {
  const signo = milesimas < 0 ? '-' : '';
  const absoluto = Math.abs(milesimas);
  return `${signo}${Math.trunc(absoluto / 1000)}.${String(absoluto % 1000).padStart(3, '0')}`;
}

/** Convierte `'1.500'` (numeric de Postgres) a 1500 milésimas, sin `Number()` suelto. */
function textoAMilesimas(valor: unknown): number {
  if (typeof valor === 'number') return Math.round(valor * 1000);
  const texto = String(valor).trim();
  const [entero = '0', decimales = ''] = texto.split('.');
  const signo = entero.startsWith('-') ? -1 : 1;
  const enteroAbs = Math.abs(Number(entero));
  const fraccion = Number((decimales + '000').slice(0, 3));
  return signo * (enteroAbs * 1000 + fraccion);
}

function negar(texto: string): string {
  return texto.startsWith('-') ? texto.slice(1) : `-${texto}`;
}

function aBigInt(valor: unknown): bigint {
  if (valor === null || valor === undefined) return 0n;
  return BigInt(String(valor));
}

function aFecha(valor: unknown): string {
  if (valor instanceof Date) return valor.toISOString();
  const fecha = new Date(String(valor));
  if (Number.isNaN(fecha.getTime())) throw new ErrorVenta(`Fecha inesperada: ${String(valor)}`);
  return fecha.toISOString();
}

function formatearPesos(minor: Centavos): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(
    Number(minor) / 100,
  );
}
