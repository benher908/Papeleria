/**
 * Cumplir (o rechazar) las obligaciones que devuelve `evaluar()`.
 *
 * El evaluador de políticas decide `permitido` y, cuando una regla lo pide,
 * devuelve una lista de obligaciones: `step_up`, `motivo_obligatorio`,
 * `notificar_dueno`, `marcar_para_revision`. `emitirEvento()` sólo puede hacer
 * cumplir la primera parte —permitir o denegar—, porque las obligaciones son
 * acciones de la pantalla o del flujo, no del SQL.
 *
 * Si se ignoraran, una venta con 40 % de descuento pasaría sin PIN y una
 * cancelación sin motivo, que es exactamente el agujero que las políticas quieren
 * cerrar. Por eso este archivo existe: una sola traducción de "obligación" a
 * "esto no se puede guardar todavía", usada por ventas y caja.
 *
 * ─── POR QUÉ HOY SE RECHAZA EN VEZ DE PEDIR ─────────────────────────────────
 *
 * No hay pantalla de PIN ni de passkey todavía (F6). Fingir que se cumple sería
 * peor que rechazar: dejaría pasar la operación sin la autorización que la regla
 * exige y nadie se enteraría. Se rechaza con un mensaje que dice qué falta y la
 * operación se podrá hacer cuando exista el step-up, sin tocar estas líneas.
 */

export interface DecisionConObligaciones {
  readonly permitido: boolean;
  readonly motivo: string;
  readonly obligaciones: readonly string[];
}

export interface OpcionesObligaciones {
  /** El texto que el usuario ya escribió, si la operación lo pide. */
  readonly motivo: string | null;
  /** Qué explicar cuando falte el step-up o el motivo. */
  readonly queFalta: string;
}

export function exigirObligaciones(
  decision: DecisionConObligaciones,
  opciones: OpcionesObligaciones,
): DecisionConObligaciones {
  if (!decision.permitido) return decision;

  if (decision.obligaciones.includes('step_up')) {
    return {
      permitido: false,
      motivo: `${decision.motivo} ${opciones.queFalta}`.trim(),
      obligaciones: decision.obligaciones,
    };
  }

  if (decision.obligaciones.includes('motivo_obligatorio') && (opciones.motivo ?? '') === '') {
    return {
      permitido: false,
      motivo: `${decision.motivo} ${opciones.queFalta}`.trim(),
      obligaciones: decision.obligaciones,
    };
  }

  return decision;
}
