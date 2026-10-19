import { describe, expect, test } from 'vitest';
import {
  ErrorDinero,
  aMilesimas,
  agregarIva,
  desglosarIvaIncluido,
  formatear,
  formatearNumero,
  parsear,
  porCantidad,
  redondearAMultiplo,
  redondearMitadArriba,
} from './dinero';

describe('redondeo', () => {
  test('mitad hacia arriba, simétrico en negativos', () => {
    expect(redondearMitadArriba(2.4)).toBe(2);
    expect(redondearMitadArriba(2.5)).toBe(3);
    expect(redondearMitadArriba(2.6)).toBe(3);
    expect(redondearMitadArriba(-2.5)).toBe(-3);
    expect(redondearMitadArriba(0)).toBe(0);
  });

  test('rechaza valores no finitos', () => {
    expect(() => redondearMitadArriba(Number.NaN)).toThrow(ErrorDinero);
    expect(() => redondearMitadArriba(Number.POSITIVE_INFINITY)).toThrow(ErrorDinero);
  });

  test('redondea a múltiplos comerciales', () => {
    expect(redondearAMultiplo(16240n, 50n, 'arriba')).toBe(16250n); // $162.40 → $162.50
    expect(redondearAMultiplo(16250n, 50n, 'arriba')).toBe(16250n); // ya es múltiplo
    expect(redondearAMultiplo(16201n, 100n, 'arriba')).toBe(16300n); // $162.01 → $163.00
    expect(redondearAMultiplo(16201n, 100n, 'cercano')).toBe(16200n);
    expect(redondearAMultiplo(0n, 50n)).toBe(0n);
  });

  test('rechaza pasos inválidos y valores negativos', () => {
    expect(() => redondearAMultiplo(100n, 0n)).toThrow(ErrorDinero);
    expect(() => redondearAMultiplo(-100n, 50n)).toThrow(ErrorDinero);
  });
});

describe('cantidades', () => {
  test('convierte a milésimas', () => {
    expect(aMilesimas(1)).toBe(1000);
    expect(aMilesimas(1.5)).toBe(1500);
    expect(aMilesimas(0.25)).toBe(250);
  });

  test('rechaza cantidades inválidas', () => {
    expect(() => aMilesimas(0)).toThrow(ErrorDinero);
    expect(() => aMilesimas(-1)).toThrow(ErrorDinero);
  });

  test('precio × cantidad es exacto (el caso que rompe los floats)', () => {
    // 12.30 × 3: con floats da 36.899999999999995
    expect(porCantidad(1230n, 3000)).toBe(3690n);
    expect(porCantidad(600n, 2000)).toBe(1200n);
    // Venta fraccionaria: media caja (0.5) de un producto de $100
    expect(porCantidad(10000n, 500)).toBe(5000n);
    // 37 hojas a $2.00 = $74.00
    expect(porCantidad(200n, 37000)).toBe(7400n);
  });

  test('exige cantidad en milésimas enteras', () => {
    expect(() => porCantidad(100n, 1.5)).toThrow(ErrorDinero);
  });
});

describe('IVA', () => {
  test('desglosa hacia atrás cuando el precio ya incluye IVA', () => {
    const { base, iva } = desglosarIvaIncluido(13000n, 0.16);
    expect(base).toBe(11207n);
    expect(iva).toBe(1793n);
    expect(base + iva).toBe(13000n); // ⭐ el invariante que NUNCA debe fallar
  });

  test('⚠️ desglosar el TOTAL no es igual a sumar las líneas (1 centavo)', () => {
    // Este centavo es la razón por la que el sistema redondea POR LÍNEA y luego
    // suma, en lugar de calcular el IVA del total. Si redondeas el total y
    // imprimes el desglose por línea, el ticket no cuadra.
    const delTotal = desglosarIvaIncluido(13000n, 0.16); // 11207 + 1793
    const porLineas = [1034n + 3276n + 517n + 6379n, 166n + 524n + 83n + 1021n];

    expect(delTotal.base).toBe(11207n);
    expect(porLineas[0]).toBe(11206n);
    expect(delTotal.base - (porLineas[0] ?? 0n)).toBe(1n); // 1 centavo de diferencia
    // Ambos suman el mismo total: lo importante es elegir UNA y ser consistente.
    expect(delTotal.base + delTotal.iva).toBe(13000n);
    expect((porLineas[0] ?? 0n) + (porLineas[1] ?? 0n)).toBe(13000n);
  });

  test('la suma base + iva siempre reconstruye el total', () => {
    let semilla = 1;
    const azarLineal = () => {
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      return semilla / 2147483648;
    };
    for (let i = 0; i < 5000; i++) {
      const total = BigInt(Math.floor(azarLineal() * 5_000_00));
      const { base, iva } = desglosarIvaIncluido(total, 0.16);
      expect(base + iva).toBe(total);
    }
  });

  test('tasa 0 % no altera nada', () => {
    expect(desglosarIvaIncluido(5000n, 0)).toEqual({ base: 5000n, iva: 0n });
  });

  test('agrega IVA a un importe neto', () => {
    const { total, iva } = agregarIva(14000n, 0.16);
    expect(iva).toBe(2240n);
    expect(total).toBe(16240n);
  });

  test('rechaza tasas y montos inválidos', () => {
    expect(() => desglosarIvaIncluido(-100n, 0.16)).toThrow(ErrorDinero);
    expect(() => desglosarIvaIncluido(100n, -0.16)).toThrow(ErrorDinero);
  });
});

describe('formato', () => {
  test('formatea como moneda mexicana', () => {
    expect(formatear(16240n)).toContain('162.40');
    expect(formatearNumero(11206n)).toBe('112.06');
    expect(formatearNumero(50n)).toBe('0.50');
  });
});

describe('parsear lo que teclea el humano', () => {
  test('acepta las dos costumbres de separadores', () => {
    expect(parsear('12.50')).toBe(1250n);
    expect(parsear('12,50')).toBe(1250n);
    expect(parsear('$1,234.50')).toBe(123450n);
    expect(parsear('1.234,50')).toBe(123450n);
  });

  test('enteros y símbolos de moneda', () => {
    expect(parsear('1250')).toBe(125000n);
    expect(parsear('$ 6')).toBe(600n);
    expect(parsear('  $0.50  ')).toBe(50n);
    expect(parsear('MXN 1,000')).toBe(100000n);
  });

  test('miles con separador de miles', () => {
    expect(parsear('1,234')).toBe(123400n);
    expect(parsear('1,234,567')).toBe(123456700n);
    expect(parsear('1.234.567')).toBe(123456700n);
  });

  test('⚠️ NO adivina cuando el texto es ambiguo', () => {
    // "1.234" podría ser $1,234 o $1.234 (tres decimales). No se adivina.
    expect(() => parsear('1.234')).toThrow(ErrorDinero);
    // "12.505" parece un error de tecleo, no $12,505.
    expect(() => parsear('12.505')).toThrow(ErrorDinero);
    expect(() => parsear('')).toThrow(ErrorDinero);
    expect(() => parsear('abc')).toThrow(ErrorDinero);
  });

  test('negativos (devoluciones, ajustes)', () => {
    expect(parsear('-12.50')).toBe(-1250n);
  });

  test('ida y vuelta: formatear → parsear conserva el valor', () => {
    for (const monto of [0n, 1n, 50n, 600n, 1250n, 16240n, 123456700n]) {
      expect(parsear(formatearNumero(monto))).toBe(monto);
    }
  });
});
