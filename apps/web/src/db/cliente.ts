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

/**
 * Una transacción que además **pide** el volcado a disco antes de seguir.
 *
 * La base arranca con `relaxedDurability` (ver `pglite.worker.ts`): las consultas vuelven
 * sin esperar al disco, y por eso va mucho más rápido. Lo que descubrió la verificación en
 * navegador es que, en ese modo, `syncToFs()` **no espera**: lanza el volcado y vuelve, y
 * además lo descarta si ya había uno en marcha (`if (this.#syncing) return`). Es decir:
 * esto reduce la ventana en la que un `COMMIT` confirmado todavía no está en IndexedDB,
 * pero **no la cierra**.
 *
 * Aun así se usa, porque reduce la ventana y porque el camino correcto —volcar y esperar—
 * es exactamente lo que esta función hará el día que se apague `relaxedDurability`. Lo que
 * NO se hace es prometer lo que no cumple: el riesgo está anotado en `apps/web/README.md`
 * como deuda con su remedio, y afecta igual a las ventas, así que se decide una vez y para
 * todo el sistema, no sólo para la autenticación.
 *
 * Se usa en las escrituras de sesión porque son las que crean o destruyen acceso: una
 * cuenta que se crea y no llega a disco deja al dueño fuera de su propio sistema.
 */
export async function enTransaccionDuradera<T>(
  base: BaseLocal,
  cuerpo: (tx: ClienteSql) => Promise<T>,
): Promise<T> {
  const resultado = await base.enTransaccion((tx) => cuerpo(envolver(tx)));
  await base.sincronizar();
  return resultado;
}

function envolver(consultas: Consultas): ClienteSql {
  return {
    exec: (sql) => consultas.lote(sql),
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: await consultas.consultar<T>(sql, params),
    }),
  };
}
