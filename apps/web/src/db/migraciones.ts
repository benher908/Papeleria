/**
 * Las migraciones tal como las ve el navegador.
 *
 * `import.meta.glob` es de Vite: en tiempo de compilación busca los archivos y los
 * incrusta como texto. Se usa glob y no una lista escrita a mano por una razón
 * concreta: con una lista, algún día alguien agregaría `0004_precios.sql` y olvidaría
 * el import, y el navegador se quedaría con un esquema atrasado sin que nada lo
 * dijera. Con glob, el archivo nuevo entra solo.
 *
 * La ruta sube hasta `packages/db` a propósito: esos .sql son los mismos que aplica
 * el servidor. Copiarlos aquí sería garantizar que algún día difieran.
 */

import { armarMigraciones } from '@papeleria/db';
import type { Migracion } from '@papeleria/db';

const textos = import.meta.glob('../../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Las migraciones de fábrica, ordenadas y con su hash, listas para `migrar()`.
 *
 * El hash se calcula aquí, en el navegador, con la misma función que usa el servidor
 * (`hashDe`, WebCrypto). Así el mismo archivo produce el mismo hash en los dos lados.
 */
export async function migracionesDeFabrica(): Promise<Migracion[]> {
  const migraciones = await armarMigraciones(nombresDeArchivo(textos));

  // Vite no se queja si un glob no encaja con ningún archivo: devuelve una lista
  // vacía. Sin esta comprobación, un error de ruta se convertiría en una app que
  // arranca sin ninguna tabla, y eso se descubre mucho más tarde. Ya pasó una vez.
  if (migraciones.length === 0) {
    throw new Error(
      'El bundle no trae ninguna migración. La app no puede crear su esquema.\n' +
        'Casi siempre es la ruta del glob de import.meta.glob en src/db/migraciones.ts.',
    );
  }

  return migraciones;
}

/** `.../migrations/0001_init.sql` → `0001_init.sql` (el nombre es el identificador). */
function nombresDeArchivo(rutas: Readonly<Record<string, string>>): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const [ruta, sql] of Object.entries(rutas)) {
    salida[ruta.split('/').pop() ?? ruta] = sql;
  }
  return salida;
}
