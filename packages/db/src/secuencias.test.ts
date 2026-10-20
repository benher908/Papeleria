import { PGlite } from '@electric-sql/pglite';
import { esPrefijoInterno, validaEAN13 } from '@papeleria/core';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import { migrar, type ClienteTransaccional } from './runner';
import { ErrorSecuencia, generarCodigoInterno, reservarCodigoInterno } from './secuencias';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

let db: PGlite;
let cliente: ClienteTransaccional;

/** El valor de la secuencia '2', como texto (bigint llega distinto según el motor). */
async function siguiente(): Promise<string> {
  const { rows } = await cliente.query<{ siguiente: unknown }>(
    `SELECT siguiente FROM barcode_sequences WHERE prefijo = '2'`,
  );
  return String(rows[0]?.siguiente);
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // Cada prueba empieza en el primer número: así el valor dorado de abajo es estable.
  await cliente.exec(`UPDATE barcode_sequences SET siguiente = 1 WHERE prefijo = '2'`);
});

describe('códigos internos', () => {
  test('el primero es el EAN-13 que sale de la cuenta, no el que uno recuerda', () => {
    // Este número se calculó corriendo la función, no a mano: la primera versión de
    // docs/03 lo tenía mal y por eso el verificador vive en una función con pruebas.
    return expect(generarCodigoInterno(cliente)).resolves.toBe('2000000000015');
  });

  test('el código es un EAN-13 válido, de 13 dígitos y del rango interno', async () => {
    const codigo = await generarCodigoInterno(cliente);

    expect(codigo).toHaveLength(13);
    expect(codigo).toMatch(/^\d{13}$/);
    expect(validaEAN13(codigo)).toBe(true);
    expect(esPrefijoInterno(codigo)).toBe(true);
  });

  test('cada llamada avanza la secuencia y devuelve un código distinto', async () => {
    const primero = await reservarCodigoInterno(cliente);
    const segundo = await reservarCodigoInterno(cliente);

    expect(primero.secuencial).toBe(1n);
    expect(segundo.secuencial).toBe(2n);
    expect(primero.codigo).not.toBe(segundo.codigo);
    expect(await siguiente()).toBe('3');
  });

  test('1 000 códigos seguidos: ni uno repetido y todos con el verificador bien', async () => {
    const codigos = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      codigos.add(await generarCodigoInterno(cliente));
    }

    expect(codigos.size).toBe(1000);
    for (const codigo of codigos) {
      expect(validaEAN13(codigo)).toBe(true);
      expect(esPrefijoInterno(codigo)).toBe(true);
    }
    expect(await siguiente()).toBe('1001');
  });

  test('un prefijo sembrado distinto del 2 también funciona', async () => {
    await cliente.exec(`INSERT INTO barcode_sequences (prefijo) VALUES ('9')`);

    const codigo = await generarCodigoInterno(cliente, '9');

    expect(codigo.startsWith('9')).toBe(true);
    expect(validaEAN13(codigo)).toBe(true);
  });

  test('un prefijo sin fila falla diciendo cuál es y de dónde sale', async () => {
    const fallo = generarCodigoInterno(cliente, '7');

    await expect(fallo).rejects.toBeInstanceOf(ErrorSecuencia);
    await expect(fallo).rejects.toThrow(/prefijo "7"/);
    await expect(fallo).rejects.toThrow(/0006_secuencias\.sql/);
  });

  test('un prefijo que no cabe en un EAN-13 falla SIN gastar un número', async () => {
    await expect(generarCodigoInterno(cliente, '2A')).rejects.toBeInstanceOf(ErrorSecuencia);
    expect(await siguiente()).toBe('1');
  });

  test('si la transacción se revierte, el número no se gasta', async () => {
    await expect(
      cliente.transaction(async (tx) => {
        await generarCodigoInterno(tx);
        throw new Error('el producto no entró');
      }),
    ).rejects.toThrow('el producto no entró');

    expect(await siguiente()).toBe('1');
    expect(await generarCodigoInterno(cliente)).toBe('2000000000015');
  });
});
