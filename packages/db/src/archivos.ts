/**
 * Carga de migraciones desde disco. Sólo Node.
 *
 * Está separado de `runner.ts` a propósito: el runner tiene que poder correr en el
 * navegador, y `node:fs` no existe ahí. Este módulo es el que sabe leer archivos;
 * en el navegador, la app leerá los mismos .sql desde el bundle (Vite los importa
 * como texto) y armará las mismas estructuras `Migracion` a mano.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Migracion } from './runner';

/** SHA-256 en hexadecimal del contenido de una migración. */
export function hashDe(contenido: string): string {
  return createHash('sha256').update(contenido, 'utf8').digest('hex');
}

/**
 * Lee todos los `*.sql` del directorio, ordenados por nombre.
 *
 * El orden es el del nombre a propósito: `0001…`, `0002…` es la secuencia real y
 * se ve en un `ls`. Se ordena explícitamente porque el orden de `readdir` depende
 * del sistema de archivos y no está garantizado.
 */
export async function cargarMigraciones(directorio: string): Promise<Migracion[]> {
  const nombres = (await readdir(directorio)).filter((n) => n.endsWith('.sql')).sort();

  const migraciones: Migracion[] = [];
  for (const nombre of nombres) {
    const sql = await readFile(join(directorio, nombre), 'utf8');
    migraciones.push({ nombre, sql, hash: hashDe(sql) });
  }
  return migraciones;
}
