import { describe, expect, test } from 'vitest';
import { ErrorDinero, aMilesimas } from '../dinero';
import { type LineaEntrada, cambioSugerido, totalizarVenta } from './totales';

const IVA16 = 0.16;
const linea = (p: Partial<LineaEntrada> = {}): LineaEntrada => ({
  qty: 1000,
  precioUnitario: 1000n,
  descuento: 0n,
  tasaIva: IVA16,
  ivaIncluido: true,
  ...p,
});

describe('totalizar una venta real (el ticket de docs/05 §5)', () => {
  // El ejemplo exacto del documento: si estos números no coinciden con el
  // ticket impreso, uno de los dos está mal.
  const venta: LineaEntrada[] = [
    linea({ qty: aMilesimas(2), precioUnitario: 600n }), //  2 Lápiz Mirado #2      $12.00
    linea({ qty: 1000, precioUnitario: 3800n }), //          1 Cuaderno Scribe 100h $38.00
    linea({ qty: aMilesimas(3), precioUnitario: 200n }), //  3 Hoja opalina carta    $6.00
    linea({ qty: aMilesimas(37), precioUnitario: 200n }), // 1 Impresión 37 hojas   $74.00
  ];

  test('el total es $130.00', () => {
    const t = totalizarVenta(venta);
    expect(t.total).toBe(13000n);
    expect(t.lineas[0]?.total).toBe(1200n);
    expect(t.lineas[1]?.total).toBe(3800n);
    expect(t.lineas[2]?.total).toBe(600n);
    expect(t.lineas[3]?.total).toBe(7400n);
  });

  test('subtotal, IVA incluido y total cuadran al centavo', () => {
    const t = totalizarVenta(venta);
    expect(t.base).toBe(11206n); // $112.06  (el doc decía 112.07: era un error)
    expect(t.iva).toBe(1794n); //  $17.94   (el doc decía 17.93)
    expect(t.subtotal).toBe(11206n);
    expect(t.descuento).toBe(0n);

    // La aritmética que verifica cualquier cliente con una calculadora:
    expect(t.base + t.iva).toBe(t.total);
    expect(t.subtotal - t.descuento + t.iva).toBe(t.total);
  });

  test('la venta se cobra con $200 y el cambio es $70', () => {
    const t = totalizarVenta(venta);
    const cambio = 20000n - t.total;
    expect(cambio).toBe(7000n);
  });
});

describe('descuentos y venta libre', () => {
  test('descuento de línea: se refleja en el subtotal y en la base', () => {
    const t = totalizarVenta([linea({ precioUnitario: 1000n, qty: 3000, descuento: 300n })]);
    expect(t.lineas[0]?.bruto).toBe(3000n);
    expect(t.lineas[0]?.neto).toBe(2700n);
    expect(t.lineas[0]?.total).toBe(2700n);
    expect(t.base).toBe(2328n);
    expect(t.iva).toBe(372n);
    expect(t.descuento).toBe(300n);
    expect(t.subtotal).toBe(2628n); // antes del descuento
    expect(t.subtotal - t.descuento + t.iva).toBe(t.total);
  });

  test('venta libre: 37 hojas a $2.00', () => {
    const t = totalizarVenta([linea({ qty: aMilesimas(37), precioUnitario: 200n })]);
    expect(t.total).toBe(7400n);
    expect(t.base + t.iva).toBe(7400n);
  });

  test('venta de 2.5 piezas (fraccionario) es exacta', () => {
    const t = totalizarVenta([linea({ qty: aMilesimas(2.5), precioUnitario: 333n })]);
    expect(t.lineas[0]?.bruto).toBe(833n); // 333 × 2.5 = 832.5 → 833
    expect(t.base + t.iva).toBe(t.total);
  });

  test('rechaza descuentos imposibles', () => {
    expect(() => totalizarVenta([linea({ precioUnitario: 100n, descuento: 200n })])).toThrow(ErrorDinero);
    expect(() => totalizarVenta([linea({ descuento: -1n })])).toThrow(ErrorDinero);
  });
});

describe('productos exentos (tasa 0 %)', () => {
  test('no separan IVA', () => {
    const t = totalizarVenta([linea({ tasaIva: 0, precioUnitario: 5000n, qty: 2000 })]);
    expect(t.total).toBe(10000n);
    expect(t.base).toBe(10000n);
    expect(t.iva).toBe(0n);
  });

  test('se pueden mezclar con gravados en el mismo ticket', () => {
    const t = totalizarVenta([
      linea({ precioUnitario: 1000n, qty: 1000, tasaIva: IVA16 }),
      linea({ precioUnitario: 5000n, qty: 1000, tasaIva: 0 }),
    ]);
    expect(t.total).toBe(6000n);
    expect(t.iva).toBe(138n); // solo el de la primera línea
    expect(t.base + t.iva).toBe(t.total);
  });
});

describe('invariantes (el test que corre siempre)', () => {
  test('base + iva === total en 20 000 ventas generadas', () => {
    let semilla = 987654321;
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      return semilla / 2147483648;
    };

    for (let i = 0; i < 20_000; i++) {
      const cantidadLineas = 1 + Math.floor(azar() * 8);
      const lineas: LineaEntrada[] = [];
      for (let j = 0; j < cantidadLineas; j++) {
        const precio = BigInt(1 + Math.floor(azar() * 50_000)); // hasta $500
        const bruto = precio * BigInt(1000 + Math.floor(azar() * 5000)) / 1000n;
        const descuento = azar() < 0.3 ? BigInt(Math.floor(Number(bruto) * 0.1 * azar())) : 0n;
        lineas.push(
          linea({
            precioUnitario: precio,
            qty: 1000 + Math.floor(azar() * 5000),
            descuento,
            tasaIva: azar() < 0.15 ? 0 : IVA16,
            ivaIncluido: true,
          }),
        );
      }
      const t = totalizarVenta(lineas);
      if (t.base + t.iva !== t.total) {
        throw new Error(`Descuadre en la venta ${i}: ${t.base} + ${t.iva} !== ${t.total}`);
      }
      if (t.subtotal - t.descuento + t.iva !== t.total) {
        throw new Error(`Descuadre de subtotal en la venta ${i}`);
      }
    }
  });

  test('una venta sin líneas da cero (no NaN, no undefined)', () => {
    const t = totalizarVenta([]);
    expect(t.total).toBe(0n);
    expect(t.base).toBe(0n);
    expect(t.iva).toBe(0n);
  });
});

describe('cambio en efectivo', () => {
  test('sugiere denominaciones de mayor a menor', () => {
    const c = cambioSugerido(7000n); // $70.00
    expect(c).toEqual([
      { valor: 5000n, cantidad: 1 }, // $50
      { valor: 2000n, cantidad: 1 }, // $20
    ]);
  });

  test('$1,846.50 da la combinación esperada', () => {
    const c = cambioSugerido(184650n);
    expect(c).toEqual([
      { valor: 100_000n, cantidad: 1 }, // $1,000
      { valor: 50_000n, cantidad: 1 }, //  $500
      { valor: 20_000n, cantidad: 1 }, //  $200
      { valor: 10_000n, cantidad: 1 }, //  $100
      { valor: 2_000n, cantidad: 2 }, //   $20 × 2
      { valor: 500n, cantidad: 1 }, //     $5
      { valor: 100n, cantidad: 1 }, //     $1
      { valor: 50n, cantidad: 1 }, //      $0.50
    ]);
  });

  test('⭐ la sugerencia siempre reconstruye el importe exacto', () => {
    // El invariante que importa: si el cajero sigue la sugerencia, cuadra.
    // Solo aplica a múltiplos de la denominación mínima ($0.50): no existe
    // moneda de un centavo, así que un cambio de $12.37 es imposible de entregar.
    let semilla = 4242;
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      return semilla / 2147483648;
    };
    for (let i = 0; i < 3000; i++) {
      const monto = BigInt(Math.floor(azar() * 2_000)) * 50n; // múltiplo de $0.50
      const suma = cambioSugerido(monto).reduce(
        (acc, d) => acc + BigInt(d.cantidad) * d.valor,
        0n,
      );
      expect(suma).toBe(monto);
    }
  });

  test('cambio cero y rechazo de negativos', () => {
    expect(cambioSugerido(0n)).toEqual([]);
    expect(() => cambioSugerido(-1n)).toThrow(ErrorDinero);
  });

  test('un importe con centavos imposibles deja un sobrante (no hay moneda de 1¢)', () => {
    const c = cambioSugerido(1237n); // $12.37
    const suma = c.reduce((acc, d) => acc + BigInt(d.cantidad) * d.valor, 0n);
    expect(suma).toBe(1200n); // $12.00 sí se pueden entregar
    expect(1237n - suma).toBe(37n); // 37¢ que no existen en efectivo
  });
});
