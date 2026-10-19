import { fileURLToPath } from 'node:url';
import { cargarMigraciones } from '@papeleria/db/node';
import { describe, expect, test } from 'vitest';
import { migracionesDeFabrica } from './migraciones';

const DIRECCION = fileURLToPath(new URL('../../../../packages/db/migrations/', import.meta.url));

describe('migraciones en el navegador', () => {
  /**
   * El punto de esta prueba: el navegador no lee archivos, recibe los .sql incrustados
   * en el bundle por Vite (`import.meta.glob`). Si esa lista quedara desfasada respecto
   * al disco, el navegador aplicaría un esquema distinto al del servidor y nada lo
   * avisaría. Aquí se comparan los dos caminos, completos: nombres, orden y hashes.
   */
  test('el bundle ve exactamente las mismas migraciones que el disco', async () => {
    const desdeBundle = await migracionesDeFabrica();
    const desdeDisco = await cargarMigraciones(DIRECCION);

    expect(desdeBundle).toEqual(desdeDisco);
  });

  test('el bundle no ve archivos de más ni de menos', async () => {
    const desdeBundle = await migracionesDeFabrica();

    // Esta lista va escrita a mano a propósito: es lo único que distingue «el bundle
    // ve las migraciones correctas» de «el bundle no ve ninguna y la comparación de
    // arriba pasa por vacío». Si se agrega una migración, aquí se nota.
    expect(desdeBundle.map((m) => m.nombre)).toEqual([
      '0001_init.sql',
      '0002_rbac_abac.sql',
      '0003_seed_catalogos.sql',
      '0004_eventos.sql',
      '0005_politicas.sql',
    ]);
  });
});
