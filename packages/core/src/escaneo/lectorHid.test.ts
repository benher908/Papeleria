import { describe, expect, it } from 'vitest';

import { LectorHid, type Lectura } from './lectorHid';

/**
 * Alimenta un código a una velocidad dada y devuelve todas las lecturas.
 *
 * No se espera de verdad: la máquina recibe el instante, así que una ráfaga de 13
 * caracteres "tarda" lo que diga el contador, no lo que tarde el test.
 */
function escanear(
  lector: LectorHid,
  codigo: string,
  msPorCaracter = 10,
  inicio = 1000,
): Lectura[] {
  const lecturas: Lectura[] = [];
  let ahora = inicio;

  for (const tecla of codigo) {
    lecturas.push(lector.alimentar(tecla, ahora));
    ahora += msPorCaracter;
  }
  lecturas.push(lector.alimentar('Enter', ahora));

  return lecturas;
}

/** El código emitido por la última lectura, si lo hubo. */
function emitido(lecturas: readonly Lectura[]): string | undefined {
  return lecturas.at(-1)?.codigo;
}

describe('LectorHid', () => {
  it('emite un EAN-13 tecleado a velocidad de máquina', () => {
    const lector = new LectorHid();
    const lecturas = escanear(lector, '7501234567890', 10);
    const cierre = lecturas.at(-1);

    expect(cierre?.codigo).toBe('7501234567890');
    expect(cierre?.consumir).toBe(true);
    // 13 caracteres a 10 ms, más el Enter en el mismo instante: 130 ms / 13 = 10.
    expect(cierre?.msPorCaracter).toBe(10);
  });

  it('no dispara con una persona tecleando a 200 ms por tecla', () => {
    const lector = new LectorHid();
    const lecturas = escanear(lector, '7501', 200);

    expect(emitido(lecturas)).toBeUndefined();
    expect(lecturas.every((lectura) => !lectura.consumir)).toBe(true);
    expect(lecturas.at(-1)?.descartado).toBe('corto');
  });

  it('sólo empieza a consumir cuando el buffer llega al mínimo', () => {
    const lector = new LectorHid({ largoMinimo: 4 });
    const lecturas = escanear(lector, 'ABCD', 10).slice(0, 4);

    expect(lecturas.map((lectura) => lectura.consumir)).toEqual([false, false, false, true]);
  });

  it('descarta un código más corto que el mínimo y deja pasar ese Enter', () => {
    const lector = new LectorHid({ largoMinimo: 4 });
    const cierre = escanear(lector, '123', 10).at(-1);

    expect(cierre?.codigo).toBeUndefined();
    expect(cierre?.consumir).toBe(false);
    expect(cierre?.descartado).toBe('corto');
  });

  it('acepta el mínimo exacto', () => {
    const lector = new LectorHid({ largoMinimo: 3 });
    expect(emitido(escanear(lector, '123', 10))).toBe('123');
  });

  it('con soloDigitos rechaza una etiqueta alfanumérica, y sin esa opción la acepta', () => {
    const estricto = new LectorHid({ soloDigitos: true });
    const rechazo = escanear(estricto, 'ANAQ-A-3-12', 10).at(-1);
    expect(rechazo?.codigo).toBeUndefined();
    expect(rechazo?.descartado).toBe('no_digito');

    const libre = new LectorHid();
    expect(emitido(escanear(libre, 'ANAQ-A-3-12', 10))).toBe('ANAQ-A-3-12');
  });

  it('descarta una ráfaga que pasa del largo máximo y se recupera después', () => {
    const lector = new LectorHid({ largoMaximo: 8 });
    const lecturas = escanear(lector, '1234567890', 10);

    expect(emitido(lecturas)).toBeUndefined();
    expect(lecturas.some((lectura) => lectura.descartado === 'largo')).toBe(true);
    expect(lector.enCurso).toBe('');

    // El lector vuelve a funcionar: un descarte no lo deja roto.
    expect(emitido(escanear(lector, '1234', 10, 5000))).toBe('1234');
  });

  it('una pausa larga corta la ráfaga: sólo cuenta lo que vino después', () => {
    const lector = new LectorHid();
    let ahora = 1000;

    for (const tecla of '750') {
      lector.alimentar(tecla, ahora);
      ahora += 10;
    }

    ahora += 500; // el cajero se distrae
    const lecturas: Lectura[] = [];
    for (const tecla of '1234') {
      lecturas.push(lector.alimentar(tecla, ahora));
      ahora += 10;
    }
    lecturas.push(lector.alimentar('Enter', ahora));

    expect(emitido(lecturas)).toBe('1234');
  });

  it('un modificador en medio no corta la ráfaga', () => {
    const lector = new LectorHid();
    let ahora = 1000;

    lector.alimentar('A', ahora);
    ahora += 10;
    // Shift no es un carácter: ni entra al código ni cuenta como pausa.
    expect(lector.alimentar('Shift', ahora)).toEqual({ consumir: false });
    ahora += 10;

    for (const tecla of 'BC1') {
      lector.alimentar(tecla, ahora);
      ahora += 10;
    }
    const cierre = lector.alimentar('Enter', ahora);

    expect(cierre.codigo).toBe('ABC1');
  });

  it('una tecla que no es carácter (una flecha) tampoco corta la ráfaga', () => {
    const lector = new LectorHid();
    let ahora = 1000;
    const teclas = ['7', '5', '0', 'ArrowLeft', '1', '2', '3', '4'];

    let ultima: Lectura = { consumir: false };
    for (const tecla of teclas) {
      ultima = lector.alimentar(tecla, ahora);
      ahora += 10;
    }
    ultima = lector.alimentar('Enter', ahora);

    expect(ultima.codigo).toBe('7501234');
    expect(lector.enCurso).toBe('');
  });

  it('no descarta el mismo código dos veces: escanear dos veces son dos piezas', () => {
    const lector = new LectorHid();

    expect(emitido(escanear(lector, '7501234567890', 10))).toBe('7501234567890');
    expect(emitido(escanear(lector, '7501234567890', 10, 5000))).toBe('7501234567890');
  });

  it('un Enter sin código no se consume: el de un formulario tiene que funcionar', () => {
    const lector = new LectorHid();
    const cierre = lector.alimentar('Enter', 1000);

    expect(cierre.consumir).toBe(false);
    expect(cierre.descartado).toBe('corto');
  });

  it('teclear lento y pulsar Enter no se confunde con un escaneo', () => {
    const lector = new LectorHid();
    const cierre = escanear(lector, 'hola', 250).at(-1);

    expect(cierre?.codigo).toBeUndefined();
    expect(cierre?.consumir).toBe(false);
  });

  it('el cierre vacía el buffer aunque no emita, para no mezclar el siguiente escaneo', () => {
    const lector = new LectorHid();
    escanear(lector, '12', 10);

    expect(lector.enCurso).toBe('');
  });

  it('reiniciar() olvida lo tecleado a medias', () => {
    const lector = new LectorHid();
    lector.alimentar('7', 1000);
    lector.alimentar('5', 1010);

    expect(lector.enCurso).toBe('75');
    lector.reiniciar();
    expect(lector.enCurso).toBe('');

    // Y no deja un código a medias que se complete con lo siguiente.
    const cierre = escanear(lector, '1234', 10, 2000).at(-1);
    expect(cierre?.codigo).toBe('1234');
  });

  it('mide la velocidad real de la ráfaga', () => {
    const lector = new LectorHid();
    expect(escanear(lector, '1234', 25).at(-1)?.msPorCaracter).toBe(25);
  });

  it('rechaza opciones imposibles en vez de comportarse raro', () => {
    expect(() => new LectorHid({ largoMinimo: 0 })).toThrow(RangeError);
    expect(() => new LectorHid({ largoMinimo: 1.5 })).toThrow(RangeError);
    expect(() => new LectorHid({ largoMinimo: 10, largoMaximo: 4 })).toThrow(RangeError);
    expect(() => new LectorHid({ intervaloMaximoMs: 0 })).toThrow(RangeError);
  });
});
