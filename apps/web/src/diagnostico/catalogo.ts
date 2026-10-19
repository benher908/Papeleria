/**
 * Comprobaciones del esquema y de las semillas.
 *
 * Son las mismas que fija `packages/db/src/esquema.test.ts`. Se repiten aquí a
 * propósito, pero conviene entender qué significa la repetición: los tests comprueban
 * lo que producen las migraciones en Node; esto comprueba lo que **llegó al navegador**.
 * Si los números se separan, es que el bundle y el disco dejaron de coincidir — que es
 * justo lo que hay que detectar. Si cambian las semillas, hay que actualizar los dos.
 */

import type { BaseLocal } from '../db/baseLocal';

export interface Comprobacion {
  que: string;
  esperado: number;
  sql: string;
}

export const COMPROBACIONES: readonly Comprobacion[] = [
  {
    que: 'tablas en public',
    esperado: 34,
    sql: `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
  },
  { que: 'roles', esperado: 4, sql: 'SELECT count(*)::int AS n FROM roles' },
  { que: 'permisos', esperado: 44, sql: 'SELECT count(*)::int AS n FROM permissions' },
  {
    que: 'reparto rol↔permiso',
    esperado: 81,
    sql: 'SELECT count(*)::int AS n FROM role_permissions',
  },
  { que: 'unidades', esperado: 6, sql: 'SELECT count(*)::int AS n FROM units' },
  { que: 'tasas de impuesto', esperado: 3, sql: 'SELECT count(*)::int AS n FROM tax_rates' },
  { que: 'categorías', esperado: 8, sql: 'SELECT count(*)::int AS n FROM categories' },
  { que: 'ajustes', esperado: 12, sql: 'SELECT count(*)::int AS n FROM settings' },
];

export interface ResultadoComprobacion extends Comprobacion {
  encontrado: number;
}

export async function comprobarCatalogo(base: BaseLocal): Promise<ResultadoComprobacion[]> {
  const resultados: ResultadoComprobacion[] = [];
  for (const comprobacion of COMPROBACIONES) {
    const fila = await base.consultarUno<{ n: number }>(comprobacion.sql);
    resultados.push({ ...comprobacion, encontrado: fila?.n ?? -1 });
  }
  return resultados;
}
