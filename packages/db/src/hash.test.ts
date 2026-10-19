import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { hashDe } from './hash';

/** Textos difíciles a propósito: acentos, emoji, saltos CRLF y un NUL. */
const MUESTRAS = [
  '',
  'a',
  'abc',
  'CREATE TABLE t (id int);\n',
  '-- acentos: ñ á é í ó ú ü ¿? ¡!\n',
  '-- emoji: 🧾📦\n',
  'linea1\r\nlinea2\r\n',
  'NUL dentro: \u0000 fin',
];

describe('hashDe', () => {
  // Vectores publicados del SHA-256 (FIPS 180-4). Si esto falla, lo que se está
  // calculando no es SHA-256 — y eso rompería el detector de divergencias en
  // silencio, porque un hash cualquiera sigue siendo estable consigo mismo.
  test('reproduce los vectores conocidos de SHA-256', async () => {
    expect(await hashDe('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await hashDe('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  // Esta es la prueba que respalda el cambio: `hashDe` pasó de `node:crypto` a
  // WebCrypto para poder correr también en el navegador. Un hash distinto habría
  // hecho que el mismo archivo contara como modificado en los dispositivos que ya
  // lo habían aplicado. Se compara contra `node:crypto`, que es un árbitro
  // independiente del código que se está probando.
  test('coincide con node:crypto en todos los textos difíciles', async () => {
    for (const texto of MUESTRAS) {
      const esperado = createHash('sha256').update(texto, 'utf8').digest('hex');
      expect(await hashDe(texto), `no coincide para ${JSON.stringify(texto)}`).toBe(esperado);
    }
  });

  test('el resultado es hexadecimal minúscula de 64 caracteres', async () => {
    expect(await hashDe('lo que sea')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('un cambio mínimo cambia el hash', async () => {
    expect(await hashDe('CREATE TABLE t (id int);')).not.toBe(
      await hashDe('CREATE TABLE t (id INT);'),
    );
  });
});
