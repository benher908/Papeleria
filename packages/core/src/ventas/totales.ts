/**
 * TOTALES DE UNA VENTA (docs/05 §4).
 *
 * Dos reglas que este módulo hace imposibles de romper:
 *
 *   1. Se redondea POR LÍNEA y el total es la SUMA de las líneas.
 *      Redondear el total (o sumar netos y luego aplicar IVA) produce tickets
 *      que no cuadran con el detalle, y el contador se vuelve loco buscando
 *      el centavo. Con "IVA incluido" el error aparece en la primera factura.
 *
 *   2. `base + iva === total` en cada línea y en el ticket completo.
 *      Es el invariante que se prueba con miles de casos.
 */

import {
  type Centavos,
  type Milesimas,
  ErrorDinero,
  desglosarIvaIncluido,
  porCantidad,
  redondearMitadArriba,
} from '../dinero';

export type LineaEntrada = {
  /** Cantidad en milésimas (1.5 piezas = 1500). */
  qty: Milesimas;
  precioUnitario: Centavos;
  /** Descuento de la línea, en importe (no en porcentaje: el % se recalcula mal). */
  descuento: Centavos;
  /** 0.16 para IVA 16 %, 0 para exento. */
  tasaIva: number;
  /** true = el precio unitario ya trae el impuesto (el caso de la papelería). */
  ivaIncluido: boolean;
};

export type LineaCalculada = {
  /** precio × cantidad, antes de descuento. */
  bruto: Centavos;
  /** bruto − descuento. Lo que paga el cliente por esta línea. */
  neto: Centavos;
  base: Centavos;
  iva: Centavos;
  total: Centavos;
};

export function calcularLinea(linea: LineaEntrada): LineaCalculada {
  if (linea.descuento < 0n) throw new ErrorDinero('El descuento no puede ser negativo');

  const bruto = porCantidad(linea.precioUnitario, linea.qty);
  const neto = bruto - linea.descuento;
  if (neto < 0n) throw new ErrorDinero('El descuento no puede superar el importe de la línea');

  if (linea.ivaIncluido) {
    const { base, iva } = desglosarIvaIncluido(neto, linea.tasaIva);
    return { bruto, neto, base, iva, total: neto };
  }

  const iva = BigInt(redondearMitadArriba(Number(neto) * linea.tasaIva));
  return { bruto, neto, base: neto, iva, total: neto + iva };
}

export type TotalesVenta = {
  /** Importe neto ANTES de descuentos. Es el "SUBTOTAL" del ticket. */
  subtotal: Centavos;
  descuento: Centavos;
  /** Suma de bases (lo que es ingreso tuyo). */
  base: Centavos;
  /** IVA trasladado: no es tuyo. */
  iva: Centavos;
  /** Lo que paga el cliente. */
  total: Centavos;
  lineas: LineaCalculada[];
};

export function totalizarVenta(lineas: readonly LineaEntrada[]): TotalesVenta {
  let descuento = 0n;
  let base = 0n;
  let iva = 0n;
  let total = 0n;
  const calculadas: LineaCalculada[] = [];

  for (const linea of lineas) {
    const c = calcularLinea(linea);
    calculadas.push(c);
    descuento += linea.descuento;
    base += c.base;
    iva += c.iva;
    total += c.total;
  }

  return {
    // SUBTOTAL − DESCUENTO + IVA === TOTAL, tal como se imprime en el ticket.
    subtotal: base + descuento,
    descuento,
    base,
    iva,
    total,
    lineas: calculadas,
  };
}

/**
 * Cambio en efectivo y sugerencia de denominaciones mexicanas (docs/05 §4).
 * Devuelve las denominaciones de MAYOR a menor para que el cajero las saque
 * sin pensar. Ahorra 5–10 segundos por venta y reduce errores de cambio.
 *
 * La denominación mínima es $0.50: no existe moneda de un centavo. Si el importe
 * no es múltiplo de $0.50, la sugerencia entrega lo que sí existe y omite el
 * sobrante (por eso conviene cobrar en efectivo siempre en múltiplos de $0.50).
 */
export const DENOMINACIONES_MXN: readonly Centavos[] = [
  100_000n, // $1,000
  50_000n, //  $500
  20_000n, //  $200
  10_000n, //  $100
  5_000n, //   $50
  2_000n, //   $20
  1_000n, //   $10 (moneda)
  500n, //     $5
  200n, //     $2
  100n, //     $1
  50n, //      $0.50
];

export type Denominacion = { valor: Centavos; cantidad: number };

export function cambioSugerido(monto: Centavos, denominaciones = DENOMINACIONES_MXN): Denominacion[] {
  if (monto < 0n) throw new ErrorDinero('El cambio no puede ser negativo');
  const resultado: Denominacion[] = [];
  let resto = monto;
  for (const valor of denominaciones) {
    if (resto >= valor) {
      const cantidad = Number(resto / valor);
      resto -= BigInt(cantidad) * valor;
      resultado.push({ valor, cantidad });
    }
  }
  return resultado;
}
