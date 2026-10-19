/**
 * Carga de migraciones desde disco. Sólo Node.
 *
 * Está separado de `runner.ts` a propósito: el runner tiene que poder correr en el
 * navegador, y `node:fs` no existe ahí. Este módulo es el que sabe leer archivos; en
 * el navegador, la app importa los mismos .sql como texto y llama a la misma función
 * de armado (`migraciones.ts`), de modo que los dos caminos producen estructuras
 * idénticas. Hay una prueba que lo comprueba.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { armarMigraciones } from './migraciones';
import type { Migracion } from './runner';

/**
 * Lee todos los `*.sql` del directorio, ordenados por nombre.
 *
 * El orden es el del nombre a propósito: `0001…`, `0002…` es la secuencia real y
 * se ve en un `ls`. Se ordena explícitamente porque el orden de `readdir` depende
 * del sistema de archivos y no está garantizado. `armarMigraciones` vuelve a ordenar
 * (y valida el formato del nombre) para que el camino del navegador se comporte igual.
 */
export async function cargarMigraciones(directorio: string): Promise<Migracion[]> {
  const nombres = (await readdir(directorio)).filter((n) => n.endsWith('.sql')).sort();

  const archivos: Record<string, string> = {};
  for (const nombre of nombres) {
    archivos[nombre] = await readFile(join(directorio, nombre), 'utf8');
  }
  return armarMigraciones(archivos);
}
