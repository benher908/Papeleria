import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { cargarMigraciones } from './archivos';
import { hashDe } from './hash';
import { armarMigraciones } from './migraciones';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

describe('armarMigraciones', () => {
  test('ordena por nombre aunque lleguen desordenadas', async () => {
    const migraciones = await armarMigraciones({
      '0003_c.sql': 'SELECT 3;',
      '0001_a.sql': 'SELECT 1;',
      '0002_b.sql': 'SELECT 2;',
    });

    expect(migraciones.map((m) => m.nombre)).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  });

  test('calcula el hash del SQL, no del nombre', async () => {
    const migraciones = await armarMigraciones({ '0001_a.sql': 'SELECT 1;' });

    expect(migraciones[0]?.hash).toBe(await hashDe('SELECT 1;'));
  });

  test('un directorio vacío da una lista vacía, sin fallar', async () => {
    expect(await armarMigraciones({})).toEqual([]);
  });

  // El nombre es el criterio de orden, así que un nombre fuera de formato es un error
  // que hay que ver en el momento, no un esquema desordenado que se descubre tarde.
  test('rechaza nombres fuera de formato, diciendo cuál', async () => {
    for (const nombre of ['4_cosas.sql', '0004-cosas.sql', '0004_Cosas.sql', '0004.sql', 'notas.sql']) {
      await expect(armarMigraciones({ [nombre]: 'SELECT 1;' })).rejects.toThrow(
        new RegExp(nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });
});

describe('los dos caminos producen lo mismo', () => {
  // Una migración se aplica desde el disco (servidor, tests) o desde el bundle
  // (navegador). Los dos caminos desembocan en `armarMigraciones`, y esta prueba fija
  // que el resultado sea idéntico: mismos nombres, mismo orden y mismos hashes. Si
  // divergieran, el PC y el celular registrarían historias distintas del mismo archivo.
  test('disco y memoria dan las mismas migraciones', async () => {
    const desdeDisco = await cargarMigraciones(DIR_MIGRACIONES);

    // Se arma el mismo diccionario a mano, como haría el navegador con sus imports.
    const enMemoria: Record<string, string> = {};
    for (const migracion of desdeDisco) {
      enMemoria[migracion.nombre] = migracion.sql;
    }
    const desdeMemoria = await armarMigraciones(enMemoria);

    expect(desdeMemoria).toEqual(desdeDisco);
  });

  test('las ocho migraciones actuales, con su hash', async () => {
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);

    expect(migraciones.map((m) => m.nombre)).toEqual([
      '0001_init.sql',
      '0002_rbac_abac.sql',
      '0003_seed_catalogos.sql',
      '0004_eventos.sql',
      '0005_politicas.sql',
      '0006_secuencias.sql',
      '0007_caja.sql',
      '0008_retiros_sin_step_up_por_defecto.sql',
    ]);
    for (const migracion of migraciones) {
      expect(migracion.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(migracion.sql.length).toBeGreaterThan(0);
    }
  });
});
