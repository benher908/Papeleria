/**
 * Adaptadores de conexión.
 *
 * `runner.ts` y `esquema.ts` hablan con una interfaz mínima (`ClienteSql`), no con
 * un driver. Eso los hace probables con cualquier motor y evita que este paquete
 * dependa de PGlite o de `pg` en tiempo de ejecución: los dos entran como
 * `import type`, que TypeScript borra al compilar.
 *
 * Resultado: `@papeleria/db` no arrastra ni el Postgres de WASM al servidor ni el
 * driver de red al navegador. Cada aplicación conecta el motor que le toca y le
 * pasa el adaptador al runner.
 *
 * Los dos adaptadores ofrecen además `transaction`, que es lo que necesita
 * `emitirEvento()` para que el estado y su evento entren juntos o no entren.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { Client as ClientePg } from 'pg';
import type { ClienteSql, ClienteTransaccional } from './runner';

/** Lo que tienen en común `PGlite` y el objeto que recibe su callback de transacción. */
interface ConsultablePglite {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

/** Envuelve un cliente de `pg` (Node, el servidor). */
export function adaptarPg(cliente: ClientePg): ClienteTransaccional {
  // `pg.Client` es UNA conexión: dos transacciones simultáneas sobre el mismo
  // cliente se entrelazarían y una podría confirmar el trabajo de la otra. Hoy no
  // pasa porque el servidor aún no escribe; el día que lo haga con concurrencia,
  // esto tiene que ir sobre un `Pool`, no sobre un `Client` compartido.
  let profundidad = 0;

  const adaptador: ClienteTransaccional = {
    async exec(sql: string): Promise<void> {
      // `pg` acepta varias sentencias en una llamada cuando no hay parámetros.
      await cliente.query(sql);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      const resultado = await cliente.query(sql, params);
      return { rows: resultado.rows as T[] };
    },
    async transaction<T>(fn: (tx: ClienteSql) => Promise<T>): Promise<T> {
      // Postgres no tiene transacciones anidadas de verdad: dentro de una, lo único
      // que existe son puntos de guardado. Se usan para que anidar no rompa nada en
      // silencio (un `BEGIN` interno se ignora y su `COMMIT` confirmaría también la
      // transacción externa).
      const nivel = profundidad;
      const punto = `papeleria_sp_${nivel}`;
      await cliente.query(nivel === 0 ? 'BEGIN' : `SAVEPOINT ${punto}`);
      profundidad++;

      try {
        const resultado = await fn(adaptador);
        await cliente.query(nivel === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${punto}`);
        return resultado;
      } catch (causa) {
        try {
          await cliente.query(nivel === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${punto}`);
        } catch {
          // Si el ROLLBACK falla, la conexión ya no sirve y su error taparía el
          // original, que es el que explica qué pasó de verdad.
        }
        throw causa;
      } finally {
        profundidad--;
      }
    },
  };

  return adaptador;
}

/** Envuelve una instancia de PGlite (navegador, y también los tests en Node). */
export function adaptarPglite(db: PGlite): ClienteTransaccional {
  return {
    ...envolver(db),
    transaction<T>(fn: (tx: ClienteSql) => Promise<T>): Promise<T> {
      // PGlite ya sabe hacer esto, incluidos los anidamientos con puntos de guardado.
      // No hay que reimplementarlo: se delega y se envuelve el `tx` que entrega.
      return db.transaction((tx) => fn(envolver(tx)));
    },
  };
}

function envolver(db: ConsultablePglite): ClienteSql {
  return {
    async exec(sql: string): Promise<unknown> {
      return db.exec(sql);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      const resultado = await db.query<T>(sql, params);
      return { rows: resultado.rows };
    },
  };
}
