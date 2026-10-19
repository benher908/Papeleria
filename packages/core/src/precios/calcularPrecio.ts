/**
 * MOTOR DE PRECIOS (docs/12).
 *
 * El problema que resuelve: "quiero ganarle 40 %" significa DOS cosas distintas.
 *
 *   costo $100, 40 % SOBRE EL COSTO  → precio $140     · ganancia $40
 *   costo $100, 40 % SOBRE LA VENTA  → precio $166.67  · ganancia $66.67
 *
 * Es una diferencia del 19 % en el precio y del 67 % en la ganancia, y por eso
 * `baseMargen` es un campo OBLIGATORIO: nunca un `0.4` ambiguo.
 *
 * Y el IVA engaña: el costo que define la ganancia es el NETO (el IVA del
 * proveedor es acreditable, no es tuyo), mientras que el precio de lista del
 * cliente SÍ incluye IVA. Mezclarlos hace creer que ganas más de lo que ganas.
 */

import {
  type Centavos,
  desglosarIvaIncluido,
  redondearAMultiplo,
  redondearMitadArriba,
} from '../dinero';

export type BaseMargen = 'costo' | 'venta';

export type ReglaPrecio = {
  /** 'costo' = markup ("le gano 40 %"). 'venta' = margen sobre el precio de venta. */
  baseMargen: BaseMargen;
  /** 40 = 40 %. */
  margenPct: number;
  /** Si el margen resultante baja de aquí, `estado` lo marca. */
  margenMinimoPct?: number;
  /** Paso de redondeo comercial en centavos: 50n = $0.50. Por defecto 1 centavo. */
  redondeoAMinor?: Centavos;
  /** Por defecto 'arriba': redondear hacia abajo regala margen en cada venta. */
  redondeoModo?: 'arriba' | 'cercano';
  /** Tasa de IVA: 0.16. */
  tasaIva: number;
  /** ¿El costo que capturaste trae IVA (como viene en la factura)? */
  costoIncluyeIva: boolean;
};

export type EstadoPrecio =
  /** El precio cubre el costo y supera el margen mínimo. */
  | 'ok'
  /** Se vende por debajo del costo. Prohibido por la política P1 (docs/06). */
  | 'bajo_costo'
  /** Es rentable, pero por debajo del margen mínimo de la categoría. */
  | 'bajo_minimo';

export type ResultadoPrecio = {
  /** Costo sin IVA: la base real de la ganancia. */
  costoNeto: Centavos;
  /** Lo que te queda después de separar el IVA. */
  precioNeto: Centavos;
  /** IVA trasladado: no es tuyo. */
  iva: Centavos;
  /** El precio que va en la etiqueta y que paga el cliente. */
  lista: Centavos;
  /** precioNeto − costoNeto. */
  ganancia: Centavos;
  /** ganancia / costo. "Le gano 40 %". */
  markupPct: number;
  /** ganancia / precioNeto. El número que de verdad importa. */
  margenVentaPct: number;
  estado: EstadoPrecio;
};

export class ErrorPrecio extends Error {}

/**
 * Costo neto (sin IVA) a partir de lo capturado.
 * En México el IVA de tus compras es acreditable: no es un costo tuyo.
 */
export function costoNetoDe(costoCapturado: Centavos, regla: ReglaPrecio): Centavos {
  if (costoCapturado < 0n) throw new ErrorPrecio('El costo no puede ser negativo');
  if (!regla.costoIncluyeIva) return costoCapturado;
  if (regla.tasaIva === 0) return costoCapturado;
  return BigInt(redondearMitadArriba(Number(costoCapturado) / (1 + regla.tasaIva)));
}

/** Calcula el precio de venta sugerido a partir del costo y la regla. */
export function calcularPrecio(costoCapturado: Centavos, regla: ReglaPrecio): ResultadoPrecio {
  validarRegla(regla);
  const costoNeto = costoNetoDe(costoCapturado, regla);

  const precioNeto = redondearMitadArriba(
    regla.baseMargen === 'costo'
      ? Number(costoNeto) * (1 + regla.margenPct / 100)
      : Number(costoNeto) / (1 - regla.margenPct / 100),
  );

  const listaExacta = BigInt(redondearMitadArriba(precioNeto * (1 + regla.tasaIva)));
  const lista = redondearAMultiplo(
    listaExacta,
    regla.redondeoAMinor ?? 1n,
    regla.redondeoModo ?? 'arriba',
  );

  return analizarPrecio(costoCapturado, lista, regla);
}

/**
 * Analiza un precio YA decidido (el sugerido, o el que el dueño escribió a mano).
 * Es lo que alimenta el indicador de margen en vivo de la pantalla de producto:
 * verde / ámbar / rojo contra el margen mínimo de la categoría.
 */
export function analizarPrecio(
  costoCapturado: Centavos,
  lista: Centavos,
  regla: ReglaPrecio,
): ResultadoPrecio {
  validarRegla(regla);
  if (lista < 0n) throw new ErrorPrecio('El precio no puede ser negativo');

  const costoNeto = costoNetoDe(costoCapturado, regla);
  const { base, iva } = desglosarIvaIncluido(lista, regla.tasaIva);
  const ganancia = base - costoNeto;

  const margenMinimo = regla.margenMinimoPct ?? 0;
  const estado: EstadoPrecio =
    base < costoNeto ? 'bajo_costo' : margenVentaPctDe(ganancia, base) < margenMinimo ? 'bajo_minimo' : 'ok';

  return {
    costoNeto,
    precioNeto: base,
    iva,
    lista,
    ganancia,
    markupPct: porcentaje(ganancia, costoNeto),
    margenVentaPct: margenVentaPctDe(ganancia, base),
    estado,
  };
}

/** Redondea un markup a un precio de lista (sin despejar nada: el markup ya es sobre el costo). */
export function margenVentaPctDe(ganancia: Centavos, precioNeto: Centavos): number {
  return porcentaje(ganancia, precioNeto);
}

function porcentaje(parte: Centavos, total: Centavos): number {
  if (total <= 0n) return 0;
  return (Number(parte) / Number(total)) * 100;
}

function validarRegla(regla: ReglaPrecio): void {
  if (!Number.isFinite(regla.margenPct) || regla.margenPct < 0) {
    throw new ErrorPrecio(`El margen debe ser un número >= 0 (recibido: ${regla.margenPct})`);
  }
  if (regla.baseMargen === 'venta' && regla.margenPct >= 100) {
    throw new ErrorPrecio(
      'Con "margen sobre venta" el margen debe ser menor a 100 % (no existe vender con margen infinito)',
    );
  }
  if (!Number.isFinite(regla.tasaIva) || regla.tasaIva < 0) {
    throw new ErrorPrecio(`La tasa de IVA no puede ser negativa (recibida: ${regla.tasaIva})`);
  }
  if (regla.margenMinimoPct !== undefined && regla.margenMinimoPct < 0) {
    throw new ErrorPrecio('El margen mínimo no puede ser negativo');
  }
}
