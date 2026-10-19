/**
 * Puente entre el cliente de la app y el contrato de `@papeleria/db`.
 *
 * Son dos interfaces casi iguales con nombres distintos, y eso es a propósito:
 *
 *   `Consultas`   (apps/web)      → `consultar`, `ejecutar`, `lote`. Nombres en español,
 *                                   para todo el código de pantalla.
 *   `ClienteSql`  (@papeleria/db) → `query`, `exec`. Lo mínimo que necesita el paquete
 *                                   de esquema, que también corre en Node.
 *
 * En vez de unificar las dos (y arrastrar el vocabulario de una a la otra), se traduce
 * en un solo lugar. Si mañana la app cambia de motor, sólo cambia este archivo.
 */

import type { ClienteSql, ClienteTransaccional } from '@papeleria/db';
import type { BaseLocal, Consultas } from './baseLocal';

/** La base local, vista como el cliente con transacciones que espera `emitirEvento()`. */
export function comoClienteTransaccional(base: BaseLocal): ClienteTransaccional {
  return {
    exec: (sql) => base.lote(sql),

    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: await base.consultar<T>(sql, params),
    }),

    transaction: <T>(fn: (tx: ClienteSql) => Promise<T>) =>
      // `enTransaccion` ya toma el cerrojo del líder: ninguna otra pestaña puede
      // colarse entre el BEGIN y el COMMIT de esta llamada.
      base.enTransaccion((tx) => fn(envolver(tx))),
  };
}

function envolver(consultas: Consultas): ClienteSql {
  return {
    exec: (sql) => consultas.lote(sql),
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: await consultas.consultar<T>(sql, params),
    }),
  };
}
