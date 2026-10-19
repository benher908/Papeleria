import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { adaptarPg, adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { compararEsquemas, instantanea, resumenDeDiferencias } from './esquema';
import { migrar } from './runner';

/**
 * La prueba que sostiene la promesa central del proyecto: el MISMO archivo de
 * migración produce el MISMO esquema en PGlite y en PostgreSQL.
 *
 * Se salta sola si no hay un Postgres disponible, para que `pnpm test` siga
 * funcionando sin Docker. En la integración continua SÍ corre, porque el flujo de
 * trabajo levanta un servicio de Postgres y define la variable.
 *
 * ⚠️ Destruye y recrea el esquema `public` de la base a la que apunte
 *    `DATABASE_URL_PRUEBAS`. Por eso la variable lleva "PRUEBAS" en el nombre:
 *    nunca debe apuntar a una base con datos que importen.
 */

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));
const URL_PRUEBAS = process.env['DATABASE_URL_PRUEBAS'];

describe.skipIf(!URL_PRUEBAS)('compatibilidad PGlite ↔ PostgreSQL', () => {
  test('las mismas migraciones dejan el mismo esquema en los dos motores', async () => {
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);

    // ── Lado A: PGlite, el Postgres de WASM que corre en el navegador ──
    const pglite = new PGlite();
    await pglite.waitReady;
    const clientePglite = adaptarPglite(pglite);
    const enPglite = await migrar(clientePglite, migraciones);
    expect(enPglite.aplicadas).toHaveLength(migraciones.length);
    const instantaneaPglite = await instantanea(clientePglite);
    await pglite.close();

    // ── Lado B: el PostgreSQL real del servidor ──
    const pg = new Client({ connectionString: URL_PRUEBAS });
    await pg.connect();
    let instantaneaPg;
    try {
      const clientePg = adaptarPg(pg);
      await clientePg.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
      const enPg = await migrar(clientePg, migraciones);
      expect(enPg.aplicadas).toHaveLength(migraciones.length);
      instantaneaPg = await instantanea(clientePg);
    } finally {
      await pg.end();
    }

    const diferencias = compararEsquemas(instantaneaPglite, instantaneaPg);
    expect(diferencias, resumenDeDiferencias(diferencias)).toEqual([]);
  });

  test('el servidor Postgres que se está usando es la versión 16 o mayor', async () => {
    const pg = new Client({ connectionString: URL_PRUEBAS });
    await pg.connect();
    try {
      const { rows } = await pg.query<{ v: number }>(
        `SELECT current_setting('server_version_num')::int AS v`,
      );
      const version = rows[0]?.v ?? 0;
      // format_type(), la generación de columnas y las identidades necesitan 12+;
      // el diseño apunta a la 16. Si esto falla, el CI cambió de imagen.
      expect(version).toBeGreaterThanOrEqual(160000);
    } finally {
      await pg.end();
    }
  });
});
