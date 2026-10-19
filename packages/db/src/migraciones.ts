/**
 * Armado de las migraciones a partir de los .sql ya cargados en memoria.
 *
 * Este módulo es el punto donde los dos caminos se encuentran:
 *
 *   Node      → `archivos.ts` lee los .sql del disco y llama aquí
 *   navegador → `apps/web` los importa como texto (Vite) y llama aquí
 *
 * Por eso vive aparte y no toca ni `node:fs` ni Vite: es una función pura sobre
 * texto. Si los dos caminos no produjeran exactamente las mismas `Migracion` (mismos
 * nombres, mismo orden, mismos hashes), el esquema del PC y el del celular podrían
 * divergir sin que nada lo avise. Hay una prueba que compara ambos caminos.
 */

import { hashDe } from './hash';
import type { Migracion } from './runner';

/**
 * El nombre de una migración es su identificador en `schema_migrations` y, además,
 * el criterio de orden: el runner no ordena, aplica en el orden recibido. Por eso el
 * nombre se valida en vez de aceptarse tal cual: `0004-cosas.sql` (con guion) o
 * `4_cosas.sql` ordenarían mal, y un error de orden en migraciones es de los que se
 * pagan caro y tarde.
 */
const NOMBRE_VALIDO = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function armarMigraciones(
  archivos: Readonly<Record<string, string>>,
): Promise<Migracion[]> {
  // Se ordena por nombre de forma explícita: `0001`, `0002`… es la secuencia real y
  // el orden de un objeto no está garantizado.
  const entradas = Object.entries(archivos).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const migraciones: Migracion[] = [];
  for (const [nombre, sql] of entradas) {
    if (!NOMBRE_VALIDO.test(nombre)) {
      throw new Error(
        `Nombre de migración inválido: "${nombre}".\n` +
          `Se espera NNNN_nombre_en_snake_case.sql (por ejemplo 0004_precios.sql).\n` +
          `El nombre es también el criterio de orden, así que no es un detalle estético.`,
      );
    }
    migraciones.push({ nombre, sql, hash: await hashDe(sql) });
  }
  return migraciones;
}
