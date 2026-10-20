/**
 * LA CAJA: abrir turno, cerrar con arqueo y mover efectivo (F2.1 y F2.11).
 *
 * Una venta no existe fuera de un turno (docs/05 §2). Ese vínculo es lo que hace
 * posible el arqueo: al cerrar, el sistema sabe exactamente qué ventas en efectivo,
 * qué devoluciones y qué retiros pertenecen a la sesión que se está contando.
 *
 * ─── TRES DECISIONES QUE NO SON OBVIAS ───────────────────────────────────────
 *
 * **El esperado se calcula con `monto − cambio`, no con `monto + cambio`.**
 * Si el cliente paga $200 por una venta de $130, al cajón entran $130 netos; los
 * $70 se fueron de vuelta. Sumar el cambio es el error clásico de un POS casero y
 * desajusta todos los cierres (docs/05 §6). Aquí se resta en una sola consulta.
 *
 * **Un turno abierto por terminal, garantizado por la base.** Además de la
 * comprobación amable en `abrirTurno()` hay un índice único parcial
 * (`uq_cash_abierta_por_terminal`). La comprobación da el mensaje bonito; el índice
 * cierra la carrera entre dos pestañas.
 *
 * **Las obligaciones de la política se cumplen o se rechaza la operación.** El
 * evaluador devuelve `step_up` y `motivo_obligatorio`, pero no puede aplicarlas:
 * son cosas de la pantalla. Aquí se exigen antes de escribir. Hoy no hay pantalla
 * de PIN, así que un cierre con diferencia de más de $50 pide la nota y un retiro
 * sensible se rechaza con un mensaje que dice exactamente qué falta.
 */

import { uuidV7 } from '@papeleria/core';

import { autorizar } from './autorizacion';
import { emitirEvento } from './eventos';
import { exigirObligaciones } from './obligaciones';
import type { ClienteSql, ClienteTransaccional } from './runner';

// ───────────────────────────── tipos ─────────────────────────────

export interface ContextoCaja {
  readonly usuarioId: string;
  readonly dispositivoId: string;
  /** Reloj inyectable para las pruebas. */
  readonly ahora?: number;
}

export type TipoMovimientoCaja = 'retiro' | 'ingreso' | 'gasto';

export interface Turno {
  readonly id: string;
  readonly terminalId: string;
  readonly usuarioId: string;
  readonly abiertaAt: string;
  readonly fondoInicialMinor: bigint;
}

export interface CierreDeTurno {
  readonly turnoId: string;
  readonly cerradaAt: string;
  readonly esperadoEfectivoMinor: bigint;
  readonly contadoEfectivoMinor: bigint;
  readonly diferenciaMinor: bigint;
}

export interface MovimientoDeCaja {
  readonly id: string;
  readonly turnoId: string;
  readonly tipo: TipoMovimientoCaja;
  readonly montoMinor: bigint;
  readonly concepto: string;
  readonly ocurridoAt: string;
}

export interface ResumenTurno {
  readonly turnoId: string;
  readonly abiertaAt: string;
  readonly cerradaAt: string | null;
  readonly fondoInicialMinor: bigint;
  readonly tickets: number;
  readonly totalVentasMinor: bigint;
  /** Efectivo neto: lo cobrado menos el cambio devuelto. */
  readonly ventasEfectivoMinor: bigint;
  readonly devolucionesMinor: bigint;
  readonly retirosMinor: bigint;
  readonly gastosMinor: bigint;
  readonly ingresosMinor: bigint;
  readonly esperadoEfectivoMinor: bigint;
  readonly contadoEfectivoMinor: bigint | null;
  /** `null` mientras el turno está abierto: todavía no hay nada que comparar. */
  readonly diferenciaMinor: bigint | null;
  readonly porMetodo: ReadonlyArray<{
    readonly metodo: string;
    readonly montoMinor: bigint;
    readonly tickets: number;
  }>;
}

/** Algo de la caja no se puede hacer, y el mensaje es para la persona que la usa. */
export class ErrorCaja extends Error {}

interface PayloadTurnoAbierto {
  readonly turno_id: string;
  readonly terminal_id: string;
  readonly user_id: string;
  readonly fondo_inicial_minor: string;
  readonly abierta_at: string;
}

interface PayloadTurnoCerrado {
  readonly turno_id: string;
  readonly cerrada_at: string;
  readonly esperado_efectivo_minor: string;
  readonly contado_efectivo_minor: string;
  readonly diferencia_minor: string;
  readonly notas_cierre: string | null;
  readonly tickets: number;
  readonly total_ventas_minor: string;
}

interface PayloadMovimientoCaja {
  readonly movimiento_id: string;
  readonly turno_id: string;
  readonly tipo: TipoMovimientoCaja;
  readonly monto_minor: string;
  readonly concepto: string;
  readonly user_id: string;
  readonly ocurrido_at: string;
}

// ───────────────────────────── lectura ─────────────────────────────

/** El turno abierto de esta terminal, o `null` si no hay ninguno. */
export async function turnoAbierto(
  cliente: ClienteSql,
  dispositivoId: string,
): Promise<Turno | null> {
  const { rows } = await cliente.query<{
    id: string;
    terminal_id: string;
    user_id: string;
    abierta_at: unknown;
    fondo_inicial_minor: unknown;
  }>(
    `SELECT id, terminal_id, user_id, abierta_at, fondo_inicial_minor
       FROM cash_sessions
      WHERE terminal_id = $1 AND cerrada_at IS NULL
      ORDER BY abierta_at DESC
      LIMIT 1`,
    [dispositivoId],
  );

  const fila = rows[0];
  if (fila === undefined) return null;

  return {
    id: fila.id,
    terminalId: fila.terminal_id,
    usuarioId: fila.user_id,
    abiertaAt: aFecha(fila.abierta_at),
    fondoInicialMinor: aBigInt(fila.fondo_inicial_minor, 'fondo_inicial_minor'),
  };
}

/**
 * Todo lo que el arqueo necesita, en una sola foto.
 *
 * `esperado` se calcula con la fórmula de docs/05 §6, corregida: los pagos en
 * efectivo entran por `monto − cambio`. Las ventas canceladas no cuentan (su
 * efectivo se devolvió), y por eso la subconsulta filtra por `estado = 'completada'`.
 */
export async function resumenTurno(cliente: ClienteSql, turnoId: string): Promise<ResumenTurno> {
  const { rows } = await cliente.query<{
    id: string;
    abierta_at: unknown;
    cerrada_at: unknown;
    fondo_inicial_minor: unknown;
    esperado_efectivo_minor: unknown;
    contado_efectivo_minor: unknown;
    diferencia_minor: unknown;
    tickets: number;
    total_ventas: unknown;
    ventas_efectivo: unknown;
    devoluciones: unknown;
    retiros: unknown;
    gastos: unknown;
    ingresos: unknown;
  }>(
    `SELECT cs.id, cs.abierta_at, cs.cerrada_at, cs.fondo_inicial_minor,
            cs.esperado_efectivo_minor, cs.contado_efectivo_minor, cs.diferencia_minor,

            COALESCE((SELECT count(*) FROM sales s
                       WHERE s.cash_session_id = cs.id AND s.estado = 'completada'), 0)::int
              AS tickets,
            COALESCE((SELECT sum(s.total_minor) FROM sales s
                       WHERE s.cash_session_id = cs.id AND s.estado = 'completada'), 0)
              AS total_ventas,

            COALESCE((SELECT sum(p.monto_minor - p.cambio_minor)
                        FROM payments p JOIN sales s ON s.id = p.sale_id
                       WHERE s.cash_session_id = cs.id AND s.estado = 'completada'
                         AND p.metodo = 'efectivo'), 0)
              AS ventas_efectivo,

            COALESCE((SELECT sum(r.total_devuelto_minor)
                        FROM returns r JOIN sales s ON s.id = r.sale_id
                       WHERE s.cash_session_id = cs.id), 0)
              AS devoluciones,

            COALESCE((SELECT sum(cm.monto_minor) FROM cash_movements cm
                       WHERE cm.cash_session_id = cs.id AND cm.tipo = 'retiro'), 0)
              AS retiros,
            COALESCE((SELECT sum(cm.monto_minor) FROM cash_movements cm
                       WHERE cm.cash_session_id = cs.id AND cm.tipo = 'gasto'), 0)
              AS gastos,
            COALESCE((SELECT sum(cm.monto_minor) FROM cash_movements cm
                       WHERE cm.cash_session_id = cs.id AND cm.tipo = 'ingreso'), 0)
              AS ingresos

       FROM cash_sessions cs
      WHERE cs.id = $1`,
    [turnoId],
  );

  const fila = rows[0];
  if (fila === undefined) throw new ErrorCaja('El turno no existe.');

  const fondo = aBigInt(fila.fondo_inicial_minor, 'fondo_inicial_minor');
  const ventasEfectivo = aBigInt(fila.ventas_efectivo, 'ventas_efectivo');
  const devoluciones = aBigInt(fila.devoluciones, 'devoluciones');
  const retiros = aBigInt(fila.retiros, 'retiros');
  const gastos = aBigInt(fila.gastos, 'gastos');
  const ingresos = aBigInt(fila.ingresos, 'ingresos');

  // La misma aritmética que aplica el cierre. Tenerla en un solo lugar evita que
  // la pantalla muestre un esperado y el cierre guarde otro.
  const esperado = fondo + ventasEfectivo - devoluciones - retiros - gastos + ingresos;

  const porMetodo = await cliente.query<{
    metodo: string;
    monto: unknown;
    tickets: number;
  }>(
    `SELECT p.metodo,
            COALESCE(sum(p.monto_minor - p.cambio_minor), 0) AS monto,
            count(DISTINCT p.sale_id)::int                    AS tickets
       FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.cash_session_id = $1 AND s.estado = 'completada'
      GROUP BY p.metodo
      ORDER BY p.metodo`,
    [turnoId],
  );

  const cerradaAt = fila.cerrada_at === null ? null : aFecha(fila.cerrada_at);
  const contado =
    fila.contado_efectivo_minor === null || fila.contado_efectivo_minor === undefined
      ? null
      : aBigInt(fila.contado_efectivo_minor, 'contado_efectivo_minor');

  return {
    turnoId: fila.id,
    abiertaAt: aFecha(fila.abierta_at),
    cerradaAt,
    fondoInicialMinor: fondo,
    tickets: fila.tickets,
    totalVentasMinor: aBigInt(fila.total_ventas, 'total_ventas'),
    ventasEfectivoMinor: ventasEfectivo,
    devolucionesMinor: devoluciones,
    retirosMinor: retiros,
    gastosMinor: gastos,
    ingresosMinor: ingresos,
    esperadoEfectivoMinor: esperado,
    contadoEfectivoMinor: contado,
    diferenciaMinor: cerradaAt === null ? null : contado === null ? null : contado - esperado,
    porMetodo: porMetodo.rows.map((filaMetodo) => ({
      metodo: filaMetodo.metodo,
      montoMinor: aBigInt(filaMetodo.monto, 'monto'),
      tickets: filaMetodo.tickets,
    })),
  };
}

/** Los movimientos de un turno, del más reciente al más viejo. */
export async function movimientosDelTurno(
  cliente: ClienteSql,
  turnoId: string,
): Promise<MovimientoDeCaja[]> {
  const { rows } = await cliente.query<{
    id: string;
    cash_session_id: string;
    tipo: TipoMovimientoCaja;
    monto_minor: unknown;
    concepto: string;
    ocurrido_at: unknown;
  }>(
    `SELECT id, cash_session_id, tipo, monto_minor, concepto, ocurrido_at
       FROM cash_movements
      WHERE cash_session_id = $1
      ORDER BY ocurrido_at DESC`,
    [turnoId],
  );

  return rows.map((fila) => ({
    id: fila.id,
    turnoId: fila.cash_session_id,
    tipo: fila.tipo,
    montoMinor: aBigInt(fila.monto_minor, 'monto_minor'),
    concepto: fila.concepto,
    ocurridoAt: aFecha(fila.ocurrido_at),
  }));
}

// ───────────────────────────── apertura ─────────────────────────────

/**
 * Abre el turno con el cambio que ya había en el cajón.
 *
 * El fondo no es una venta ni un ingreso: es la declaración de lo que estaba ahí
 * antes de empezar. Por eso no genera un `payment` ni un `cash_movement`; vive en
 * `cash_sessions.fondo_inicial_minor` (docs/05 §6).
 */
export async function abrirTurno(
  cliente: ClienteTransaccional,
  datos: { readonly fondoInicialMinor: bigint },
  contexto: ContextoCaja,
): Promise<Turno> {
  if (datos.fondoInicialMinor < 0n) {
    throw new ErrorCaja('El fondo inicial no puede ser negativo.');
  }

  const id = uuidV7();
  const ahora = contexto.ahora;

  const evento = await emitirEvento<'cash_session.opened', PayloadTurnoAbierto>(cliente, {
    tipo: 'cash_session.opened',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    autorizar: (_evento, tx) =>
      autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'turnos:abrir',
        recurso: { tipo: 'turno', id },
        ...(ahora === undefined ? {} : { ahora }),
      }),

    payload: async (tx, datosEvento) => {
      // La comprobación va aquí dentro, con el cerrojo de la transacción. Fuera
      // habría una ventana entre mirar y escribir, y dos pestañas podrían abrir
      // dos turnos; el índice único lo impediría igual, pero con un error de
      // Postgres en vez de un mensaje que se entienda.
      const abierto = await tx.query<{ id: string }>(
        `SELECT id FROM cash_sessions
          WHERE terminal_id = $1 AND cerrada_at IS NULL LIMIT 1`,
        [contexto.dispositivoId],
      );
      if (abierto.rows[0] !== undefined) {
        throw new ErrorCaja('Ya hay un turno de caja abierto en esta terminal. Ciérralo antes de abrir otro.');
      }

      return {
        turno_id: id,
        terminal_id: contexto.dispositivoId,
        user_id: contexto.usuarioId,
        fondo_inicial_minor: datos.fondoInicialMinor.toString(),
        abierta_at: datosEvento.occurred_at,
      };
    },

    aplicarEstado: async (tx, completo) => {
      const p = completo.payload;
      await tx.query(
        `INSERT INTO cash_sessions (id, terminal_id, user_id, abierta_at, fondo_inicial_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.turno_id, p.terminal_id, p.user_id, p.abierta_at, p.fondo_inicial_minor],
      );
    },

    auditoria: { accion: 'cash_session.opened', entidad: 'cash_sessions', entidadId: id },
  });

  return {
    id: evento.payload.turno_id,
    terminalId: evento.payload.terminal_id,
    usuarioId: evento.payload.user_id,
    abiertaAt: evento.payload.abierta_at,
    fondoInicialMinor: datos.fondoInicialMinor,
  };
}

// ───────────────────────────── cierre y arqueo ─────────────────────────────

/**
 * Cierra el turno con lo que se contó a mano y devuelve la diferencia.
 *
 * El esperado **no lo manda la pantalla**: se calcula aquí dentro, con la misma
 * consulta que usa `resumenTurno()`. Si la pantalla pudiera mandarlo, un error de
 * captura se convertiría en un arqueo que "cuadra" y nunca se sabría.
 */
export async function cerrarTurno(
  cliente: ClienteTransaccional,
  datos: {
    readonly turnoId: string;
    readonly contadoEfectivoMinor: bigint;
    readonly notas?: string | null;
  },
  contexto: ContextoCaja,
): Promise<CierreDeTurno> {
  if (datos.contadoEfectivoMinor < 0n) {
    throw new ErrorCaja('Lo contado no puede ser negativo.');
  }

  const notas = datos.notas?.trim() || null;
  const ahora = contexto.ahora;

  const evento = await emitirEvento<'cash_session.closed', PayloadTurnoCerrado>(cliente, {
    tipo: 'cash_session.closed',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    autorizar: async (eventoParcial, tx) => {
      const p = eventoParcial.payload;
      const decision = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'turnos:cerrar',
        recurso: {
          tipo: 'turno',
          id: datos.turnoId,
          diferencia_minor: Number(p.diferencia_minor),
        },
        ...(ahora === undefined ? {} : { ahora }),
      });

      return exigirObligaciones(decision, {
        motivo: notas,
        queFalta: 'Para cerrar con una diferencia de más de $50 escribe una nota que explique qué pasó.',
      });
    },

    payload: async (tx, datosEvento) => {
      const sesion = await tx.query<{ id: string; cerrada_at: unknown }>(
        `SELECT id, cerrada_at FROM cash_sessions
          WHERE id = $1 AND terminal_id = $2`,
        [datos.turnoId, contexto.dispositivoId],
      );
      const fila = sesion.rows[0];
      if (fila === undefined) {
        throw new ErrorCaja('El turno no existe o es de otra terminal.');
      }
      if (fila.cerrada_at !== null) {
        throw new ErrorCaja('Ese turno ya está cerrado.');
      }

      const resumen = await resumenTurno(tx, datos.turnoId);
      const diferencia = datos.contadoEfectivoMinor - resumen.esperadoEfectivoMinor;

      return {
        turno_id: datos.turnoId,
        cerrada_at: datosEvento.occurred_at,
        esperado_efectivo_minor: resumen.esperadoEfectivoMinor.toString(),
        contado_efectivo_minor: datos.contadoEfectivoMinor.toString(),
        diferencia_minor: diferencia.toString(),
        notas_cierre: notas,
        tickets: resumen.tickets,
        total_ventas_minor: resumen.totalVentasMinor.toString(),
      };
    },

    aplicarEstado: async (tx, completo) => {
      const p = completo.payload;
      await tx.query(
        `UPDATE cash_sessions
            SET cerrada_at = $2,
                esperado_efectivo_minor = $3,
                contado_efectivo_minor = $4,
                notas_cierre = $5
          WHERE id = $1`,
        [
          p.turno_id,
          p.cerrada_at,
          p.esperado_efectivo_minor,
          p.contado_efectivo_minor,
          p.notas_cierre,
        ],
      );
    },

    auditoria: { accion: 'cash_session.closed', entidad: 'cash_sessions', entidadId: datos.turnoId },
  });

  return {
    turnoId: evento.payload.turno_id,
    cerradaAt: evento.payload.cerrada_at,
    esperadoEfectivoMinor: BigInt(evento.payload.esperado_efectivo_minor),
    contadoEfectivoMinor: BigInt(evento.payload.contado_efectivo_minor),
    diferenciaMinor: BigInt(evento.payload.diferencia_minor),
  };
}

// ───────────────────────────── movimientos ─────────────────────────────

/**
 * Saca o mete efectivo del cajón, con un concepto obligatorio.
 *
 * `retiros_en_turno` cuenta retiros y gastos —no ingresos— porque lo que vigila
 * P15 es el patrón de vaciado: sacar poco muchas veces. Se cuenta dentro de la
 * transacción para que dos retiros simultáneos no se vean los dos como "el primero".
 */
export async function registrarMovimientoCaja(
  cliente: ClienteTransaccional,
  datos: {
    readonly turnoId: string;
    readonly tipo: TipoMovimientoCaja;
    readonly montoMinor: bigint;
    readonly concepto: string;
  },
  contexto: ContextoCaja,
): Promise<MovimientoDeCaja> {
  const concepto = datos.concepto.trim();
  if (datos.montoMinor <= 0n) {
    throw new ErrorCaja('El monto tiene que ser mayor que cero.');
  }
  if (concepto === '') {
    throw new ErrorCaja('Escribe para qué salió o entró el dinero.');
  }
  if (!['retiro', 'ingreso', 'gasto'].includes(datos.tipo)) {
    throw new ErrorCaja('Tipo de movimiento de caja desconocido.');
  }

  const id = uuidV7();
  const ahora = contexto.ahora;

  const evento = await emitirEvento<'cash_movement.created', PayloadMovimientoCaja>(cliente, {
    tipo: 'cash_movement.created',
    dispositivoId: contexto.dispositivoId,
    usuarioId: contexto.usuarioId,
    ...(ahora === undefined ? {} : { ahora: () => ahora }),

    autorizar: async (eventoParcial, tx) => {
      const p = eventoParcial.payload;
      const decision = await autorizar(tx, {
        usuarioId: contexto.usuarioId,
        dispositivoId: contexto.dispositivoId,
        permiso: 'turnos:retiros',
        recurso: {
          tipo: 'turno',
          id: datos.turnoId,
          monto_minor: Number(p.monto_minor),
          retiros_en_turno: Number(
            (
              await tx.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM cash_movements
                  WHERE cash_session_id = $1 AND tipo IN ('retiro', 'gasto')`,
                [datos.turnoId],
              )
            ).rows[0]?.n ?? 0,
          ),
        },
        ...(ahora === undefined ? {} : { ahora }),
      });

      return exigirObligaciones(decision, {
        motivo: concepto,
        queFalta: 'Este movimiento necesita autorización del dueño.',
      });
    },

    payload: async (tx, datosEvento) => {
      const sesion = await tx.query<{ cerrada_at: unknown }>(
        `SELECT cerrada_at FROM cash_sessions WHERE id = $1 AND terminal_id = $2`,
        [datos.turnoId, contexto.dispositivoId],
      );
      const fila = sesion.rows[0];
      if (fila === undefined) throw new ErrorCaja('El turno no existe o es de otra terminal.');
      if (fila.cerrada_at !== null) throw new ErrorCaja('No se puede mover dinero de un turno cerrado.');

      return {
        movimiento_id: id,
        turno_id: datos.turnoId,
        tipo: datos.tipo,
        monto_minor: datos.montoMinor.toString(),
        concepto,
        user_id: contexto.usuarioId,
        ocurrido_at: datosEvento.occurred_at,
      };
    },

    aplicarEstado: async (tx, completo) => {
      const p = completo.payload;
      await tx.query(
        `INSERT INTO cash_movements
           (id, cash_session_id, tipo, monto_minor, concepto, user_id, ocurrido_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.movimiento_id, p.turno_id, p.tipo, p.monto_minor, p.concepto, p.user_id, p.ocurrido_at],
      );
    },

    auditoria: { accion: 'cash_movement.created', entidad: 'cash_movements', entidadId: id },
  });

  return {
    id: evento.payload.movimiento_id,
    turnoId: evento.payload.turno_id,
    tipo: evento.payload.tipo,
    montoMinor: BigInt(evento.payload.monto_minor),
    concepto: evento.payload.concepto,
    ocurridoAt: evento.payload.ocurrido_at,
  };
}

// ───────────────────────────── piezas ─────────────────────────────

function aBigInt(valor: unknown, campo: string): bigint {
  try {
    return BigInt(String(valor));
  } catch {
    throw new ErrorCaja(`Valor inesperado en ${campo}: ${String(valor)}`);
  }
}

function aFecha(valor: unknown): string {
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'string') {
    const fecha = new Date(valor);
    if (!Number.isNaN(fecha.getTime())) return fecha.toISOString();
  }
  throw new ErrorCaja(`Fecha inesperada: ${String(valor)}`);
}
