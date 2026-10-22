import { describe, expect, test } from 'vitest';

import { LARGO_MINIMO_CONTRASENA, revisarContrasena, retrasoTrasFallos } from './contrasena';

describe('revisarContrasena', () => {
  test('acepta la contraseña larga sin símbolos raros', () => {
    // El punto entero del módulo: esto es mejor contraseña que 'Papeleria1!' y sin
    // embargo no cumple las reglas de composición que todo el mundo cree necesarias.
    expect(revisarContrasena('soy la duena de la papeleria')).toEqual([]);
  });

  test('rechaza la corta y dice cuánto le falta', () => {
    const problemas = revisarContrasena('Papeleria1!');
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('10 caracteres');
    expect(problemas[0]).toContain('tiene 11');
  });

  test('exactamente 10 caracteres ya pasa', () => {
    const doce = 'a'.repeat(LARGO_MINIMO_CONTRASENA - 1) + 'b';
    expect(revisarContrasena(doce, [])).toEqual([]);
  });

  test('rechaza el mismo carácter repetido', () => {
    expect(revisarContrasena('aaaaaaaaaaaa')).toContain('Es el mismo carácter repetido.');
  });

  test('rechaza las escaleras, en los dos sentidos y dando la vuelta', () => {
    for (const escalera of [
      'abcdefghijkl',
      'zyxwvutsrqpo',
      // La que importa: al llegar a 9 vuelve a 0, así que NO es una escalera de códigos
      // de carácter. Es la contraseña más común del mundo y tiene que caer aquí.
      '123456789012',
      '987654321098',
    ]) {
      const problemas = revisarContrasena(escalera);
      expect(problemas.some((p) => p.startsWith('Es una escalera'))).toBe(true);
    }
  });

  test('rechaza los paseos por el teclado, pero sólo la fila entera', () => {
    expect(revisarContrasena('qwertyuiop-2026')).toContain(
      'Es un paseo por el teclado (qwerty…). Se adivina al primer intento.',
    );
    expect(revisarContrasena('asdfghjkl000')).toContain(
      'Es un paseo por el teclado (qwerty…). Se adivina al primer intento.',
    );
    // Tres o cuatro letras seguidas de teclado aparecen en contraseñas legítimas;
    // rechazarlas empujaría a la gente a contraseñas peores para cumplir la regla.
    expect(revisarContrasena('asdf-no-es-mi-clave')).toEqual([]);
  });

  test('una palabra con números sueltos no es una escalera ni un paseo', () => {
    expect(revisarContrasena('papeleria-2026-caja')).toEqual([]);
    expect(revisarContrasena('cuaderno-scribe-100')).toEqual([]);
  });

  test('prohíbe que la contraseña SEA el nombre de usuario, no que lo contenga', () => {
    expect(revisarContrasena('duena', ['duena'])).toContain('No puede ser «duena» y nada más.');
    // Contenerla está bien, y es lo que evita que la gente escriba cosas peores para
    // cumplir la regla.
    expect(revisarContrasena('papeleria-de-duena-2026', ['duena'])).toEqual([]);
  });

  test('las palabras prohibidas se comparan ignorando mayúsculas y espacios', () => {
    expect(revisarContrasena('  DUENA  ', ['duena'])).toContain('No puede ser «duena» y nada más.');
  });

  test('sin palabras prohibidas no se queja de nada más', () => {
    expect(revisarContrasena('cuaderno-scribe-100')).toEqual([]);
  });
});

describe('retrasoTrasFallos', () => {
  test('los dos primeros fallos no cuestan nada: uno se equivoca', () => {
    expect(retrasoTrasFallos(1)).toBe(0);
    expect(retrasoTrasFallos(2)).toBe(0);
  });

  test('a partir del tercero crece al doble', () => {
    expect(retrasoTrasFallos(3)).toBe(2000);
    expect(retrasoTrasFallos(4)).toBe(4000);
    expect(retrasoTrasFallos(5)).toBe(8000);
    expect(retrasoTrasFallos(6)).toBe(16_000);
  });

  test('y se queda en 30 segundos, no crece sin fin', () => {
    expect(retrasoTrasFallos(7)).toBe(30_000);
    expect(retrasoTrasFallos(20)).toBe(30_000);
  });
});
