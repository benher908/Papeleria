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
 */

import type { PGlite } from '@electric-sql/pglite';
import type { Client as ClientePg } from 'pg';
import type { ClienteSql } from './runner';

/** Envuelve un cliente de `pg` (Node, el servidor). */
export function adaptarPg(cliente: ClientePg): ClienteSql {
  return {
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
  };
}

/** Envuelve una instancia de PGlite (navegador, y también los tests en Node). */
export function adaptarPglite(db: PGlite): ClienteSql {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
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
