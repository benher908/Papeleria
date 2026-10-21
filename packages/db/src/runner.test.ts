import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { hashDe } from './hash';
import { ErrorMigracionDivergente, migrar, type ClienteSql, type Migracion } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

// ─────────────────────────── utilidades ───────────────────────────

const bases: PGlite[] = [];

/** Una base PGlite nueva y vacía; se cierra sola al final del archivo. */
async function baseNueva(): Promise<ClienteSql> {
  const db = new PGlite();
  bases.push(db);
  await db.waitReady;
  return adaptarPglite(db);
}

async function contar(cliente: ClienteSql, sql: string, params?: unknown[]): Promise<number> {
  const { rows } = await cliente.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? -1;
}

afterAll(async () => {
  await Promise.all(bases.map((b) => b.close()));
});

// ────────────────────────────── pruebas ──────────────────────────────

describe('runner de migraciones', () => {
  test('aplica las migraciones sobre una base limpia y las deja registradas', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);

    // Si este número cambia, es porque se agregó una migración: hay que
    // actualizar la lista de tablas esperadas en esquema.test.ts.
    expect(migraciones.map((m) => m.nombre)).toEqual([
      '0001_init.sql',
      '0002_rbac_abac.sql',
      '0003_seed_catalogos.sql',
      '0004_eventos.sql',
      '0005_politicas.sql',
      '0006_secuencias.sql',
      '0007_caja.sql',
      '0008_retiros_sin_step_up_por_defecto.sql',
      '0009_step_up_password.sql',
      '0010_venta_libre.sql',
      '0011_sync_server.sql',
      '0012_sync_transport.sql',
    ]);

    const resultado = await migrar(cliente, migraciones);

    expect(resultado.aplicadas).toEqual(migraciones.map((m) => m.nombre));
    expect(resultado.yaAplicadas).toEqual([]);
    expect(resultado.huerfanas).toEqual([]);
    expect(resultado.estado).toHaveLength(12);
    expect(resultado.estado.every((m) => m.duracion_ms !== null)).toBe(true);
    expect(resultado.estado.map((m) => m.hash)).toEqual(migraciones.map((m) => m.hash));
  });

  test('llamarlo otra vez no aplica nada (es idempotente)', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);

    await migrar(cliente, migraciones);
    const segunda = await migrar(cliente, migraciones);

    expect(segunda.aplicadas).toEqual([]);
    expect(segunda.yaAplicadas).toEqual(migraciones.map((m) => m.nombre));
    expect(await contar(cliente, 'SELECT count(*)::int AS n FROM schema_migrations')).toBe(12);

    // Y las semillas no se duplicaron: los roles siguen siendo cuatro.
    expect(await contar(cliente, 'SELECT count(*)::int AS n FROM roles')).toBe(4);
  });

  test('detecta que un archivo ya aplicado cambió después', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);
    await migrar(cliente, migraciones);

    // Alguien edita 0001_init.sql después de haberlo aplicado.
    const primera = migraciones[0] as Migracion;
    const sqlCambiado = `${primera.sql}\n-- columna agregada a mano\n`;
    const alteradas: Migracion[] = [
      { ...primera, sql: sqlCambiado, hash: await hashDe(sqlCambiado) },
      ...migraciones.slice(1),
    ];

    await expect(migrar(cliente, alteradas)).rejects.toThrow(ErrorMigracionDivergente);
    await expect(migrar(cliente, alteradas)).rejects.toThrow(/0001_init\.sql/);

    // Y no se aplicó nada nuevo: el registro sigue intacto.
    expect(await contar(cliente, 'SELECT count(*)::int AS n FROM schema_migrations')).toBe(12);
  });

  test('reporta migraciones huérfanas: aplicadas en la base, sin archivo en disco', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);
    await migrar(cliente, migraciones);

    const resultado = await migrar(cliente, migraciones.slice(0, 2));

    expect(resultado.huerfanas).toEqual([
      '0003_seed_catalogos.sql',
      '0004_eventos.sql',
      '0005_politicas.sql',
      '0006_secuencias.sql',
      '0007_caja.sql',
      '0008_retiros_sin_step_up_por_defecto.sql',
      '0009_step_up_password.sql',
      '0010_venta_libre.sql',
      '0011_sync_server.sql',
      '0012_sync_transport.sql',
    ]);
    expect(resultado.aplicadas).toEqual([]);
  });

  test('una migración que falla se revierte entera y no deja registro', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);
    await migrar(cliente, migraciones);

    // La primera sentencia es válida, la segunda no compila. Si el runner no
    // envolviera el archivo en una transacción, la tabla `se_crea_antes` quedaría
    // creada a medias sin que la migración conste como aplicada: un esquema
    // fantasma que ninguna migración vuelve a construir.
    const sqlRoto = 'CREATE TABLE se_crea_antes (id int);\nCREATE TABLE esto_no_compila (;';
    const rota: Migracion = { nombre: '0007_rota.sql', sql: sqlRoto, hash: await hashDe(sqlRoto) };

    await expect(migrar(cliente, [...migraciones, rota])).rejects.toThrow(/0007_rota\.sql/);

    const { rows } = await cliente.query<{ existe: boolean }>(
      `SELECT to_regclass('public.se_crea_antes') IS NOT NULL AS existe`,
    );
    expect(rows[0]?.existe).toBe(false);

    expect(
      await contar(cliente, `SELECT count(*)::int AS n FROM schema_migrations WHERE nombre = '0007_rota.sql'`),
    ).toBe(0);
    expect(await contar(cliente, 'SELECT count(*)::int AS n FROM schema_migrations')).toBe(12);
  });

  test('el error de una migración rota dice en qué archivo fue, y qué dijo el motor', async () => {
    const cliente = await baseNueva();
    const migraciones = await cargarMigraciones(DIR_MIGRACIONES);
    await migrar(cliente, migraciones);

    const sqlRoto = 'SELECT esto_no_existe_en_ninguna_parte;';
    const rota: Migracion = { nombre: '0008_mala.sql', sql: sqlRoto, hash: await hashDe(sqlRoto) };

    await expect(migrar(cliente, [...migraciones, rota])).rejects.toThrow(
      /Falló la migración 0008_mala\.sql[\s\S]*esto_no_existe_en_ninguna_parte/,
    );
  });
});
