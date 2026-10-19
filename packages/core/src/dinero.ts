/**
 * DINERO EN CENTAVOS. Nunca `number` con decimales.
 *
 * Regla del proyecto (docs/02 §2):
 *   · Todo importe es un entero de centavos (`bigint`), con sufijo `Minor`/`Centavos`.
 *   · Se redondea SIEMPRE con `redondearMitadArriba`, nunca con `Math.round`
 *     (Math.round usa "mitad al par" en algunos casos y te descuadra la caja).
 *   · Las cantidades usan 3 decimales (`Milesimas`), igual que `numeric(12,3)` en la base.
 *
 * ¿Por qué `bigint` y no `number`?
 *   12.30 * 3 === 36.899999999999995  →  y ese error se arrastra al ticket,
 *   al arqueo y a los reportes, y aparece 3 meses después como un descuadre
 *   de un centavo por venta que nadie sabe explicar.
 */

export type Centavos = bigint;

/** Cantidades con 3 decimales: 1.5 piezas = 1500 milésimas. */
export type Milesimas = number;

/** Milésimas por unidad (cantidades con 3 decimales). */
export const MIL = 1000;
export const CIEN = 100n;
/** La misma constante pero en `bigint`, para aritmética de dinero.
 *  ⚠️ Mezclar bigint con number lanza TypeError: `100n / 1000` explota. */
const MIL_BIG = BigInt(MIL);

export class ErrorDinero extends Error {}

// ───────────────────────── REDONDEO ─────────────────────────

/**
 * Redondeo "mitad hacia arriba" y simétrico para negativos.
 * `redondearMitadArriba(2.5) === 3`, `redondearMitadArriba(-2.5) === -3`.
 */
export function redondearMitadArriba(n: number): number {
  if (!Number.isFinite(n)) throw new ErrorDinero(`Número no finito: ${n}`);
  return Math.sign(n) * Math.floor(Math.abs(n) + 0.5);
}

/**
 * Redondea un importe al múltiplo de `paso` indicado.
 * ⚠️ Solo para importes no negativos (precios). El redondeo comercial de precios
 * SIEMPRE va hacia arriba: redondear hacia abajo regala margen en cada venta.
 */
export function redondearAMultiplo(
  valor: Centavos,
  paso: Centavos,
  modo: 'arriba' | 'cercano' = 'arriba',
): Centavos {
  if (valor < 0n) throw new ErrorDinero('El redondeo de precios solo aplica a importes positivos');
  if (paso <= 0n) throw new ErrorDinero('El paso de redondeo debe ser positivo');
  return modo === 'arriba'
    ? ((valor + paso - 1n) / paso) * paso
    : ((valor + paso / 2n) / paso) * paso;
}

// ───────────────────────── CANTIDADES ─────────────────────────

/** Convierte 1.5 a 1500 milésimas, validando el rango. */
export function aMilesimas(n: number): Milesimas {
  if (!Number.isFinite(n) || n <= 0) {
    throw new ErrorDinero(`La cantidad debe ser mayor que cero (recibido: ${n})`);
  }
  const m = redondearMitadArriba(n * MIL);
  if (m <= 0) throw new ErrorDinero('La cantidad es demasiado pequeña');
  return m;
}

/** precio unitario × cantidad. Aritmética entera: sin error de punto flotante. */
export function porCantidad(precioUnitario: Centavos, cantidad: Milesimas): Centavos {
  if (!Number.isInteger(cantidad)) {
    throw new ErrorDinero(`La cantidad debe venir en milésimas (entero): ${cantidad}`);
  }
  const bruto = precioUnitario * BigInt(cantidad);
  const negativo = bruto < 0n;
  const abs = negativo ? -bruto : bruto;
  const redondeado = (abs + MIL_BIG / 2n) / MIL_BIG; // mitad hacia arriba, exacto en bigint
  return negativo ? -redondeado : redondeado;
}

// ───────────────────────── IVA ─────────────────────────

/**
 * Despeja base e IVA de un total que YA incluye el IVA (el caso de la papelería:
 * el precio de lista es el precio final).
 *
 *   desglosarIvaIncluido(13000n, 0.16)
 *     → base 11206, iva 1794   (11206 + 1794 === 13000)
 */
export function desglosarIvaIncluido(
  totalConIva: Centavos,
  tasaIva: number,
): { base: Centavos; iva: Centavos } {
  if (totalConIva < 0n) throw new ErrorDinero('El importe no puede ser negativo');
  if (!(tasaIva >= 0)) throw new ErrorDinero('La tasa de IVA no puede ser negativa');
  if (tasaIva === 0) return { base: totalConIva, iva: 0n };

  const base = BigInt(redondearMitadArriba(Number(totalConIva) / (1 + tasaIva)));
  return { base, iva: totalConIva - base };
}

/** Agrega el IVA a un importe neto (cuando el precio NO incluye impuesto). */
export function agregarIva(neto: Centavos, tasaIva: number): { total: Centavos; iva: Centavos } {
  if (neto < 0n) throw new ErrorDinero('El importe no puede ser negativo');
  const iva = BigInt(redondearMitadArriba(Number(neto) * tasaIva));
  return { total: neto + iva, iva };
}

// ───────────────────────── FORMATO ─────────────────────────

export function formatear(monto: Centavos, moneda = 'MXN', locale = 'es-MX'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: moneda }).format(
    Number(monto) / 100,
  );
}

/** Sin símbolo de moneda: "112.06". Útil para inputs y para CSV. */
export function formatearNumero(monto: Centavos, locale = 'es-MX'): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(Number(monto) / 100);
}

/**
 * Convierte lo que teclea el humano a centavos. Acepta las dos costumbres:
 *   "12.50"      → 1250     (formato mexicano)
 *   "12,50"      → 1250     (costumbre europea)
 *   "$1,234.50"  → 123450
 *   "1.234,50"   → 123450
 *   "1250"       → 125000
 *   "1,234"      → 123400   (coma + grupos de 3 ⇒ separador de miles)
 *   "1.234"      → ERROR    (ambiguo: no se adivina)
 *   "12.505"     → ERROR    (más de dos decimales: es un error de tecleo)
 *
 * ⚠️ La regla dura es NO ADIVINAR: cuando el texto es ambiguo, se lanza un error
 *    en lugar de crear un precio 100 veces más grande en silencio.
 */
export function parsear(texto: string): Centavos {
  if (typeof texto !== 'string') throw new ErrorDinero('Se esperaba texto');
  const limpio = texto.replace(/[^\d.,+-]/g, '');
  if (limpio === '' || !/\d/.test(limpio)) {
    throw new ErrorDinero(`No se pudo interpretar "${texto}" como un importe`);
  }

  const negativo = limpio.trimStart().startsWith('-');
  const soloNum = limpio.replace(/[+-]/g, '');

  const comas = (soloNum.match(/,/g) ?? []).length;
  const puntos = (soloNum.match(/\./g) ?? []).length;
  let posDecimal = -1;

  if (comas > 0 && puntos > 0) {
    // Hay de los dos: el último es el decimal, el otro es de miles.
    posDecimal = Math.max(soloNum.lastIndexOf(','), soloNum.lastIndexOf('.'));
  } else if (comas > 0) {
    posDecimal = esGrupoDeMiles(soloNum, ',') ? -1 : soloNum.lastIndexOf(',');
  } else if (puntos > 0) {
    const ultimo = soloNum.lastIndexOf('.');
    const decimales = soloNum.length - ultimo - 1;
    if (decimales <= 2) posDecimal = ultimo;
    else if (puntos >= 2 && esGrupoDeMiles(soloNum, '.')) posDecimal = -1;
    else throw new ErrorDinero(`"${texto}" tiene más de dos decimales`);
  }

  const enteroTxt = (posDecimal === -1 ? soloNum : soloNum.slice(0, posDecimal)).replace(/\D/g, '');
  const decimalTxt = posDecimal === -1 ? '' : soloNum.slice(posDecimal + 1);

  if (!/^\d*$/.test(decimalTxt) || decimalTxt.length > 2) {
    throw new ErrorDinero(`"${texto}" tiene más de dos decimales`);
  }

  const enteros = enteroTxt === '' ? 0n : BigInt(enteroTxt);
  const centavos = BigInt((decimalTxt + '00').slice(0, 2));
  const total = enteros * CIEN + centavos;
  return negativo ? -total : total;
}

/** ¿Todos los grupos separados por `sep` son de 3 dígitos? "1,234" sí; "12,50" no. */
function esGrupoDeMiles(s: string, sep: string): boolean {
  const partes = s.split(sep);
  const primera = partes[0] ?? '';
  if (primera === '' || primera.length > 3) return false;
  return partes.slice(1).every((p) => p.length === 3);
}
