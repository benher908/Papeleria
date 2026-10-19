import { describe, expect, test } from 'vitest';
import { ErrorUUID, esUUIDv7Valido, instanteDeUUIDv7, uuidV7 } from './uuidv7';

describe('UUID v7', () => {
  test('genera identificadores válidos con versión 7 y variante RFC 4122', () => {
    for (let i = 0; i < 1000; i++) {
      const id = uuidV7();
      expect(esUUIDv7Valido(id)).toBe(true);
      expect(id).toHaveLength(36);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
  });

  test('recupera el instante con el que se creó', () => {
    for (const instante of [0, 1, 1000, 1_700_000_000_000, 2 ** 47]) {
      const id = uuidV7(instante, new Uint8Array(10));
      expect(instanteDeUUIDv7(id)).toBe(instante);
    }
  });

  test('el orden es el del tiempo, aunque el azar sea el mismo', () => {
    const azar = new Uint8Array(10).fill(3);
    const ids = [0, 1, 2, 999, 1000, 1_000_001, 1_700_000_000_000].map((t) => uuidV7(t, azar));
    expect([...ids].sort()).toEqual(ids);
  });

  test('no repite aunque se pida en el mismo milisegundo', () => {
    const ahora = 1_700_000_000_000;
    const vistos = new Set<string>();
    for (let i = 0; i < 5000; i++) vistos.add(uuidV7(ahora));
    expect(vistos.size).toBe(5000);
  });

  test('fija la variante aunque el azar venga con los bits altos encendidos', () => {
    // Sin el enmascarado, estos bytes producirían una variante inválida.
    const azar = new Uint8Array(10).fill(0xff);
    const id = uuidV7(1000, azar);
    expect(esUUIDv7Valido(id)).toBe(true);
    expect('89ab').toContain(id[19]);
  });

  test('rechaza azar del tamaño equivocado y tiempos imposibles', () => {
    expect(() => uuidV7(0, new Uint8Array(9))).toThrow(ErrorUUID);
    expect(() => uuidV7(-1)).toThrow(ErrorUUID);
    expect(() => uuidV7(1.5)).toThrow(ErrorUUID);
    expect(() => uuidV7(2 ** 48)).toThrow(ErrorUUID);
  });

  test('esUUIDv7Valido rechaza v4, versión distinta y texto libre', () => {
    expect(esUUIDv7Valido('00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(esUUIDv7Valido('00000000-0000-7000-7000-000000000000')).toBe(false); // variante
    expect(esUUIDv7Valido('no-es-un-uuid')).toBe(false);
    expect(() => instanteDeUUIDv7('no-es-un-uuid')).toThrow(ErrorUUID);
  });
});
