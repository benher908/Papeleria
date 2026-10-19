import { describe, expect, test } from 'vitest';
import { ErrorPrecio, analizarPrecio, calcularPrecio, costoNetoDe } from './calcularPrecio';

const IVA16 = 0.16;

describe('costo neto (el IVA del proveedor no es un costo tuyo)', () => {
  test('normaliza el costo capturado con IVA a neto', () => {
    expect(costoNetoDe(11600n, { baseMargen: 'costo', margenPct: 40, tasaIva: IVA16, costoIncluyeIva: true }))
      .toBe(10000n);
    expect(costoNetoDe(10000n, { baseMargen: 'costo', margenPct: 40, tasaIva: IVA16, costoIncluyeIva: false }))
      .toBe(10000n);
  });

  test('rechaza costos negativos', () => {
    expect(() =>
      costoNetoDe(-1n, { baseMargen: 'costo', margenPct: 40, tasaIva: IVA16, costoIncluyeIva: false }),
    ).toThrow(ErrorPrecio);
  });
});

describe('markup: "le gano 40 %" (sobre el costo)', () => {
  test('costo $100 sin IVA → lista $162.40, ganancia $40.00', () => {
    const r = calcularPrecio(10000n, {
      baseMargen: 'costo',
      margenPct: 40,
      margenMinimoPct: 25,
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });

    expect(r.costoNeto).toBe(10000n); // $100.00
    expect(r.precioNeto).toBe(14000n); // $140.00 netos
    expect(r.lista).toBe(16240n); // $162.40 lo que paga el cliente
    expect(r.iva).toBe(2240n); // $22.40 que no son tuyos
    expect(r.ganancia).toBe(4000n); // $40.00
    expect(r.markupPct).toBeCloseTo(40, 1);
    expect(r.margenVentaPct).toBeCloseTo(28.57, 1); // ⭐ NO es 40 %
    expect(r.estado).toBe('ok');
  });

  test('costo de factura con IVA ($116.00) da el MISMO resultado', () => {
    const r = calcularPrecio(11600n, {
      baseMargen: 'costo',
      margenPct: 40,
      tasaIva: IVA16,
      costoIncluyeIva: true,
    });
    expect(r.costoNeto).toBe(10000n);
    expect(r.lista).toBe(16240n);
    expect(r.ganancia).toBe(4000n);
  });
});

describe('margen sobre venta: "mi margen es 40 %"', () => {
  test('costo $100 → lista $193.34, ganancia $66.67', () => {
    const r = calcularPrecio(10000n, {
      baseMargen: 'venta',
      margenPct: 40,
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });

    expect(r.precioNeto).toBe(16667n); // $166.67 netos
    expect(r.lista).toBe(19334n); // $193.34 con IVA
    expect(r.iva).toBe(2667n);
    expect(r.ganancia).toBe(6667n);
    expect(r.margenVentaPct).toBeCloseTo(40, 1);
    expect(r.markupPct).toBeCloseTo(66.67, 1);
  });

  test('⚠️ la diferencia entre las dos interpretaciones es enorme', () => {
    const reglaBase = { margenPct: 40, tasaIva: IVA16, costoIncluyeIva: false } as const;
    const sobreCosto = calcularPrecio(10000n, { ...reglaBase, baseMargen: 'costo' });
    const sobreVenta = calcularPrecio(10000n, { ...reglaBase, baseMargen: 'venta' });

    // 19 % más caro y 67 % más ganancia, con la misma frase de "40 %".
    expect(sobreVenta.lista).toBeGreaterThan(sobreCosto.lista);
    expect(Number(sobreVenta.lista) / Number(sobreCosto.lista)).toBeCloseTo(1.19, 2);
    expect(Number(sobreVenta.ganancia) / Number(sobreCosto.ganancia)).toBeCloseTo(1.67, 2);
  });

  test('rechaza margen sobre venta >= 100 %', () => {
    expect(() =>
      calcularPrecio(10000n, { baseMargen: 'venta', margenPct: 100, tasaIva: IVA16, costoIncluyeIva: false }),
    ).toThrow(ErrorPrecio);
  });
});

describe('redondeo comercial', () => {
  test('redondea a $0.50 hacia arriba y GANA margen (nunca lo regala)', () => {
    const sinRedondeo = calcularPrecio(10000n, {
      baseMargen: 'costo',
      margenPct: 40,
      redondeoAMinor: 1n,
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });
    const redondeado = calcularPrecio(10000n, {
      baseMargen: 'costo',
      margenPct: 40,
      redondeoAMinor: 50n,
      redondeoModo: 'arriba',
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });

    expect(sinRedondeo.lista).toBe(16240n);
    expect(redondeado.lista).toBe(16250n); // $162.50
    expect(redondeado.ganancia).toBeGreaterThanOrEqual(sinRedondeo.ganancia);
    expect(redondeado.lista % 50n).toBe(0n); // es múltiplo de $0.50
  });

  test('redondeo a $1 sobre un precio chico', () => {
    // Costo real de un lápiz: $3.45 sin IVA, markup 45 %
    const r = calcularPrecio(345n, {
      baseMargen: 'costo',
      margenPct: 45,
      redondeoAMinor: 50n,
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });
    // 3.45 × 1.45 = 5.0025 → 5.00 neto → 5.80 con IVA → redondea a 6.00
    expect(r.lista).toBe(600n);
    expect(r.lista % 50n).toBe(0n);
    expect(r.estado).not.toBe('bajo_costo');
  });
});

describe('análisis de un precio escrito a mano (el indicador en vivo)', () => {
  const regla = {
    baseMargen: 'costo' as const,
    margenPct: 40,
    margenMinimoPct: 25,
    tasaIva: IVA16,
    costoIncluyeIva: false,
  };

  test('rojo: por debajo del costo (política P1 los prohíbe de todos modos)', () => {
    const r = analizarPrecio(10000n, 1000n, regla);
    expect(r.ganancia).toBeLessThan(0n);
    expect(r.estado).toBe('bajo_costo');
  });

  test('ámbar: rentable pero por debajo del mínimo de la categoría', () => {
    // markup 30 % ⇒ margen 23.1 %, por debajo del mínimo de 25 %
    const r = analizarPrecio(10000n, 15080n, regla);
    expect(r.margenVentaPct).toBeCloseTo(23.08, 1);
    expect(r.estado).toBe('bajo_minimo');
    expect(r.ganancia).toBeGreaterThan(0n); // ⭐ gana dinero, solo gana poco
  });

  test('verde: cumple el mínimo', () => {
    const r = analizarPrecio(10000n, 16240n, regla);
    expect(r.estado).toBe('ok');
  });

  test('el caso del ERROR DE UN CERO: $6.00 en lugar de $600.00', () => {
    // Costo $300.00, el dueño escribe $6.00 en lugar de $600.00.
    const r = analizarPrecio(30000n, 600n, regla);
    expect(r.estado).toBe('bajo_costo');
    expect(r.ganancia).toBe(-29483n); // pierde $294.83 en una sola pieza
  });
});

describe('invariantes', () => {
  test('precioNeto + iva === lista, siempre', () => {
    for (const costo of [1n, 50n, 345n, 8621n, 10000n, 99999n, 1_000_000n]) {
      for (const margen of [15, 25, 30, 40, 55, 80]) {
        for (const baseMargen of ['costo', 'venta'] as const) {
          const r = calcularPrecio(costo, {
            baseMargen,
            margenPct: margen,
            tasaIva: IVA16,
            costoIncluyeIva: true,
            redondeoAMinor: 50n,
          });
          expect(r.precioNeto + r.iva).toBe(r.lista);
        }
      }
    }
  });

  test('un costo de cero no revienta (producto de cortesía)', () => {
    const r = calcularPrecio(0n, {
      baseMargen: 'costo',
      margenPct: 40,
      tasaIva: IVA16,
      costoIncluyeIva: false,
    });
    expect(r.lista).toBe(0n);
    expect(r.markupPct).toBe(0);
    expect(r.margenVentaPct).toBe(0);
  });

  test('tasa 0 % (exento) no separa IVA', () => {
    const r = calcularPrecio(10000n, {
      baseMargen: 'costo',
      margenPct: 40,
      tasaIva: 0,
      costoIncluyeIva: false,
    });
    expect(r.lista).toBe(14000n);
    expect(r.iva).toBe(0n);
    expect(r.ganancia).toBe(4000n);
  });
});
