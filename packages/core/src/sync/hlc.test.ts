import { describe, expect, test } from 'vitest';
import {
  ErrorHLC,
  compararHLC,
  deviceCorto,
  hlcAhora,
  hlcDeserializar,
  hlcRecibir,
  hlcSerializar,
  type HLC,
} from './hlc';

const DEV = 'a1b2c3d4-1111-2222-3333-444444444444';
const OTRO = 'ffffffff-1111-2222-3333-444444444444';

describe('identificador corto del dispositivo', () => {
  test('son los primeros 8 caracteres', () => {
    expect(deviceCorto(DEV)).toBe('a1b2c3d4');
    expect(deviceCorto('abc')).toBe('abc');
  });
});

describe('monotonía del HLC', () => {
  test('el primero usa el reloj de pared y contador 0', () => {
    expect(hlcAhora(null, DEV, 1000)).toEqual({ ts: 1000, contador: 0, device: 'a1b2c3d4' });
  });

  test('el mismo milisegundo incrementa el contador', () => {
    const a = hlcAhora(null, DEV, 1000);
    const b = hlcAhora(a, DEV, 1000);
    const c = hlcAhora(b, DEV, 1000);
    expect([a.contador, b.contador, c.contador]).toEqual([0, 1, 2]);
    expect([a.ts, b.ts, c.ts]).toEqual([1000, 1000, 1000]);
  });

  test('si el reloj avanza, el contador vuelve a cero', () => {
    const a = hlcAhora(null, DEV, 1000);
    expect(hlcAhora(a, DEV, 1001)).toEqual({ ts: 1001, contador: 0, device: 'a1b2c3d4' });
  });

  test('un reloj atrasado (el PC al que se le murió la pila) NO hace retroceder el HLC', () => {
    const antes = hlcAhora(null, DEV, 1_700_000_000_000);
    // El reloj salta a 2010: es el escenario real de docs/08 §5.
    const despues = hlcAhora(antes, DEV, Date.UTC(2010, 0, 1));
    expect(despues.ts).toBe(antes.ts);
    expect(despues.contador).toBe(antes.contador + 1);
    expect(compararHLC(antes, despues)).toBeLessThan(0);
  });

  test('una secuencia con el reloj dando tumbos nunca retrocede', () => {
    const relojes = [1000, 1000, 999, 2000, 1999, 1999, 1, 5000, 0, 5000];
    let anterior: HLC | null = null;
    for (const ahora of relojes) {
      const siguiente = hlcAhora(anterior, DEV, ahora);
      if (anterior !== null) {
        expect(compararHLC(anterior, siguiente)).toBeLessThan(0);
      }
      anterior = siguiente;
    }
  });

  test('al agotar el contador avanza 1 ms en vez de fallar', () => {
    // Preferimos desviarnos del reloj de pared a bloquear una venta.
    const alLimite: HLC = { ts: 1000, contador: 36 ** 4 - 1, device: 'a1b2c3d4' };
    const siguiente = hlcAhora(alLimite, DEV, 1000);
    expect(siguiente).toEqual({ ts: 1001, contador: 0, device: 'a1b2c3d4' });
    expect(compararHLC(alLimite, siguiente)).toBeLessThan(0);
  });
});

describe('serialización del HLC', () => {
  test('forma canónica con relleno de ancho fijo', () => {
    expect(hlcSerializar({ ts: 0, contador: 0, device: DEV })).toBe('000000000000-0000-a1b2c3d4');
    expect(hlcSerializar({ ts: 35, contador: 35, device: DEV })).toBe('00000000000z-000z-a1b2c3d4');
  });

  test('ida y vuelta exacta', () => {
    const h = hlcAhora(null, DEV, 1_700_000_000_000);
    const texto = hlcSerializar(h);
    const vuelta = hlcDeserializar(texto);
    expect(vuelta).toEqual(h);
    expect(hlcSerializar(vuelta)).toBe(texto);
  });

  test('comparar el texto ordena igual que compararHLC', () => {
    // Si estas dos formas de ordenar discreparan, el ORDER BY de la base y el
    // orden que cree la aplicación estarían en desacuerdo.
    const muestras: HLC[] = [
      { ts: 0, contador: 0, device: '00000000' },
      { ts: 0, contador: 1, device: '00000000' },
      { ts: 1, contador: 0, device: '00000000' },
      { ts: 35, contador: 35, device: 'zzzzzzzz' },
      { ts: 36, contador: 0, device: '00000000' },
      { ts: 1000, contador: 0, device: 'a1b2c3d4' },
      { ts: 1000, contador: 1, device: 'a1b2c3d4' },
      { ts: 1000, contador: 0, device: 'ffffffff' },
    ];

    for (const a of muestras) {
      for (const b of muestras) {
        const ta = hlcSerializar(a);
        const tb = hlcSerializar(b);
        const esperado = ta < tb ? -1 : ta > tb ? 1 : 0;
        expect(Math.sign(compararHLC(a, b))).toBe(esperado);
      }
    }
  });

  test('rechaza formatos inválidos al deserializar', () => {
    expect(() => hlcDeserializar('')).toThrow(ErrorHLC);
    expect(() => hlcDeserializar('000000000000-0000')).toThrow(ErrorHLC);
    expect(() => hlcDeserializar('000000000000-0000-a1b2c3d4-extra')).toThrow(ErrorHLC);
    expect(() => hlcDeserializar('00000000000Z-0000-a1b2c3d4')).toThrow(ErrorHLC); // mayúscula
    expect(() => hlcDeserializar('00000000000-0000-a1b2c3d4')).toThrow(ErrorHLC); // 11 caracteres
  });

  test('rechaza valores que romperían el ancho fijo', () => {
    expect(() => hlcSerializar({ ts: 36 ** 12, contador: 0, device: DEV })).toThrow(ErrorHLC);
    expect(() => hlcSerializar({ ts: 1, contador: 36 ** 4, device: DEV })).toThrow(ErrorHLC);
    expect(() => hlcSerializar({ ts: -1, contador: 0, device: DEV })).toThrow(ErrorHLC);
    expect(() => hlcSerializar({ ts: 1.5, contador: 0, device: DEV })).toThrow(ErrorHLC);
    expect(() => hlcSerializar({ ts: 1, contador: 0, device: '' })).toThrow(ErrorHLC);
  });
});

describe('absorción del HLC remoto', () => {
  test('con local nulo, el primero propio queda por encima del remoto', () => {
    const remoto: HLC = { ts: 2000, contador: 0, device: 'bbbbbbb2' };
    // No basta con copiarlo: si nuestro próximo HLC valiera lo mismo que el remoto,
    // los eventos de los dos dispositivos podrían empatar.
    expect(hlcRecibir(null, remoto, DEV, 1500)).toEqual({
      ts: 2000,
      contador: 1,
      device: 'a1b2c3d4',
    });
  });

  test('el resultado queda por encima del local y del remoto', () => {
    const local: HLC = { ts: 1000, contador: 0, device: 'aaaaaaa1' };
    const remoto: HLC = { ts: 2000, contador: 0, device: 'bbbbbbb2' };
    const recibido = hlcRecibir(local, remoto, DEV, 1500);
    expect(compararHLC(recibido, local)).toBeGreaterThan(0);
    expect(compararHLC(recibido, remoto)).toBeGreaterThan(0);
  });

  test('absorbe un remoto adelantado aunque el reloj local se quede atrás', () => {
    const local = hlcAhora(null, DEV, 1000);
    const recibido = hlcRecibir(local, { ts: 5000, contador: 3, device: 'bbbbbbb2' }, DEV, 1000);
    expect(recibido.ts).toBe(5000);
    expect(recibido.contador).toBe(4);
  });

  test('si el reloj de pared va por delante de ambos, manda el de pared', () => {
    const local = hlcAhora(null, DEV, 1000);
    const recibido = hlcRecibir(local, { ts: 500, contador: 0, device: 'bbbbbbb2' }, DEV, 9000);
    expect(recibido.ts).toBe(9000);
    expect(recibido.contador).toBe(0);
  });

  test('con el mismo instante, desempata por el contador mayor', () => {
    const local: HLC = { ts: 1000, contador: 7, device: 'aaaaaaa1' };
    const remoto: HLC = { ts: 1000, contador: 2, device: 'bbbbbbb2' };
    const recibido = hlcRecibir(local, remoto, DEV, 1000);
    expect(recibido).toEqual({ ts: 1000, contador: 8, device: 'a1b2c3d4' });
  });

  test('tras absorber, la secuencia propia sigue siendo monótona', () => {
    let h = hlcAhora(null, DEV, 1000);
    h = hlcRecibir(h, { ts: 1000, contador: 5, device: 'bbbbbbb2' }, DEV, 1000);
    const siguiente = hlcAhora(h, DEV, 1000);
    expect(compararHLC(h, siguiente)).toBeLessThan(0);
  });

  test('el dispositivo se normaliza a 8 caracteres también al absorber', () => {
    const recibido = hlcRecibir(null, { ts: 1, contador: 0, device: OTRO }, DEV, 1);
    expect(recibido.device).toBe('a1b2c3d4');
  });
});
