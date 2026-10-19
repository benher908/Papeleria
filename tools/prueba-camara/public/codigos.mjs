/**
 * CÓDIGOS DE BARRAS PARA LA PRUEBA — versión de navegador, sin compilar.
 *
 * ⚠️ Esto es una COPIA MÍNIMA de `packages/core/src/codigos-barras/ean13.ts`.
 *    Está duplicada a propósito: esta página es una herramienta de diagnóstico
 *    autónoma que tiene que correr antes de que exista el empaquetado del front
 *    (`npm run build`), sin Vite y sin TypeScript. La fuente de verdad sigue
 *    siendo `packages/core`, que tiene las pruebas de verdad.
 *
 *    Para que la copia no se desincronice en silencio, `autoprueba()` verifica
 *    los mismos valores conocidos que las pruebas del núcleo. Si alguien toca
 *    una y no la otra, esta página lo dice en la cara.
 */

/** Dígito verificador de un EAN-13. Pesos 1,3,1,3… empezando con 1 en el índice 0. */
export function digitoVerificadorEAN13(primeros12) {
  if (!/^\d{12}$/.test(primeros12)) throw new Error(`Se esperan 12 dígitos: "${primeros12}"`);
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(primeros12[i]);
    suma += i % 2 === 0 ? d : d * 3;
  }
  const resto = suma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

export function ean13Completo(primeros12) {
  return primeros12 + String(digitoVerificadorEAN13(primeros12));
}

/** Código interno del comercio: prefijo 2 (circulación restringida de GS1) + 11 dígitos. */
export function construirEAN13Interno(secuencial, prefijo = '2') {
  const n = BigInt(Math.trunc(Number(secuencial)));
  if (n < 0n || n > 99_999_999_999n) throw new Error(`Secuencial fuera de rango: ${secuencial}`);
  return ean13Completo(String(prefijo) + n.toString().padStart(11, '0'));
}

export const CODIGOS_INTERNOS_EJEMPLO = [
  { n: 1, descripcion: 'Lápiz Mirado #2 (pieza suelta)' },
  { n: 2, descripcion: 'Cuaderno Scribe 100 hojas' },
  { n: 3, descripcion: 'Hoja opalina carta' },
  { n: 4, descripcion: 'Sobre blanco carta' },
  { n: 5, descripcion: 'Clip estándar (paquete 100)' },
];

/** Códigos que se dibujan, se pueden imprimir y se autoverifican. */
export const CODIGOS_DE_PRUEBA = [
  { bcid: 'ean13', texto: '4006381333931', etiqueta: 'EAN-13 de fábrica', nota: 'Producto industrial real: es el caso más común' },
  { bcid: 'ean13', texto: ean13Completo('750123456789'), etiqueta: 'EAN-13 México (750)', nota: 'Código de fabricante mexicano' },
  { bcid: 'ean13', texto: construirEAN13Interno(1), etiqueta: 'Código interno (prefijo 2)', nota: 'El que vas a generar tú para lo que no trae código' },
  { bcid: 'code128', texto: 'ANAQ-A-3-12', etiqueta: 'Code 128 de anaquel', nota: 'La etiqueta que más vas a escanear en una papelería' },
  { bcid: 'qrcode', texto: 'PAPELERIA|PRUEBA|2026', etiqueta: 'QR', nota: 'Solo donde el celular está garantizado' },
];

/**
 * Verifica los valores conocidos. Devuelve la lista de comprobaciones para
 * pintarlas en la página: si esta copia y `packages/core` se separan, se ve aquí.
 */
export function autoprueba() {
  const casos = [
    { nombre: 'EAN-13 de fábrica', obtenido: ean13Completo('400638133393'), esperado: '4006381333931' },
    { nombre: 'EAN-13 México', obtenido: ean13Completo('750123456789'), esperado: '7501234567893' },
    { nombre: 'Código interno 1', obtenido: construirEAN13Interno(1), esperado: '2000000000015' },
    { nombre: 'Código interno 0', obtenido: construirEAN13Interno(0), esperado: '2000000000008' },
  ];
  return casos.map((c) => ({ ...c, ok: c.obtenido === c.esperado }));
}
