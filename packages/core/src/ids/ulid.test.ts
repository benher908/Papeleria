import { describe, expect, test } from 'vitest';
import { ALFABETO_ULID, ErrorULID, LARGO_ULID, instanteDeULID, ulid } from './ulid';

const AZAR_CERO = new Uint8Array(10);

describe('ULID', () => {
  test('mide 26 caracteres del alfabeto Crockford', () => {
    for (let i = 0; i < 200; i++) {
      const id = ulid(1_700_000_000_000 + i);
      expect(id).toHaveLength(LARGO_ULID);
      for (const caracter of id) expect(ALFABETO_ULID).toContain(caracter);
    }
  });

  test('el alfabeto excluye I, L, O y U (se confunden al leerlos)', () => {
    expect(ALFABETO_ULID).not.toMatch(/[ILOU]/);
    expect(ALFABETO_ULID).toHaveLength(32);
  });

  test('codifica el tiempo alineado a la derecha en los 10 primeros caracteres', () => {
    // Estos cuatro casos fijan la dirección y el relleno: el último carácter es el
    // dígito menos significativo en base32. Se pueden comprobar a mano.
    expect(ulid(0, AZAR_CERO).slice(0, 10)).toBe('0000000000');
    expect(ulid(1, AZAR_CERO).slice(0, 10)).toBe('0000000001');
    expect(ulid(31, AZAR_CERO).slice(0, 10)).toBe('000000000Z');
    expect(ulid(32, AZAR_CERO).slice(0, 10)).toBe('0000000010');
  });

  test('decodifica de vuelta el instante con el que se creó', () => {
    for (const instante of [0, 1, 1000, 1_700_000_000_000, 2 ** 47]) {
      expect(instanteDeULID(ulid(instante, AZAR_CERO))).toBe(instante);
    }
  });

  test('el orden lexicográfico es el orden temporal', () => {
    const instantes = [0, 1, 2, 999, 1000, 1_000_001, 1_700_000_000_000, 2 ** 47];
    const ids = instantes.map((t) => ulid(t, AZAR_CERO));
    const ordenados = [...ids].sort();
    expect(ordenados).toEqual(ids);
  });

  test('dos ULID del mismo milisegundo se distinguen por el azar', () => {
    const ahora = 1_700_000_000_000;
    const vistos = new Set<string>();
    for (let i = 0; i < 2000; i++) vistos.add(ulid(ahora));
    expect(vistos.size).toBe(2000);
  });

  test('la misma entrada produce el mismo ULID (es determinista con el azar inyectado)', () => {
    const azar = new Uint8Array(10).fill(7);
    expect(ulid(1234, azar)).toBe(ulid(1234, azar));
  });

  test('rechaza azar del tamaño equivocado y tiempos imposibles', () => {
    expect(() => ulid(0, new Uint8Array(9))).toThrow(ErrorULID);
    expect(() => ulid(0, new Uint8Array(11))).toThrow(ErrorULID);
    expect(() => ulid(-1, AZAR_CERO)).toThrow(ErrorULID);
    expect(() => ulid(1.5, AZAR_CERO)).toThrow(ErrorULID);
    expect(() => ulid(2 ** 48, AZAR_CERO)).toThrow(ErrorULID);
  });

  test('instanteDeULID rechaza textos que no son ULID', () => {
    expect(() => instanteDeULID('corto')).toThrow(ErrorULID);
    expect(() => instanteDeULID('0000000000' + 'I'.repeat(16))).toThrow(ErrorULID);
  });
});
