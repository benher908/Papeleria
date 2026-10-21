/**
 * Lector de CSV para la carga inicial del catálogo (F1.10).
 *
 * El archivo que exporta Excel no es RFC 4180: cambia de comas a punto y coma según
 * la configuración regional, mete comas dentro de comillas, y arrastra un BOM. Aquí
 * se aceptan las tres cosas, porque pedirle al dueño que «exporte bien» es pedirle
 * que pelee con Excel antes de pelear con la papelería.
 *
 * Este módulo es puro: recibe texto y devuelve filas o problemas. No toca la base ni
 * el DOM, así que se puede probar sin navegador. La base decide después si un código
 * está repetido; aquí sólo se detectan los errores que se pueden ver en el archivo.
 */

import {
  normalizarCodigo,
  validaCode128,
  validaEAN13,
} from '@papeleria/core';

export interface FilaCsv {
  /** Línea física del archivo, para que el mensaje diga dónde corregir. */
  readonly linea: number;
  readonly nombre: string;
  readonly precioMinor: bigint;
  readonly costoMinor: bigint;
  readonly codigo: string | null;
  readonly categoria: string | null;
  readonly unidad: string | null;
  readonly sku: string | null;
  readonly stockMinimo: number;
  readonly ubicacion: string | null;
}

export interface ProblemaCsv {
  readonly linea: number;
  readonly mensaje: string;
}

export interface AnalisisCsv {
  readonly filas: readonly FilaCsv[];
  readonly problemas: readonly ProblemaCsv[];
}

interface FilaCruda {
  readonly linea: number;
  readonly celdas: readonly string[];
}

const ALIAS: Readonly<Record<string, string>> = {
  nombre: 'nombre',
  producto: 'nombre',
  descripcion: 'nombre',
  descripcion_producto: 'nombre',
  name: 'nombre',

  precio: 'precio',
  precio_venta: 'precio',
  precio_publico: 'precio',
  pvp: 'precio',
  price: 'precio',

  costo: 'costo',
  costo_compra: 'costo',
  costo_unitario: 'costo',
  cost: 'costo',

  codigo: 'codigo',
  codigo_barras: 'codigo',
  codigo_de_barras: 'codigo',
  barcode: 'codigo',
  ean: 'codigo',
  ean13: 'codigo',
  upc: 'codigo',

  categoria: 'categoria',
  category: 'categoria',

  unidad: 'unidad',
  unidad_medida: 'unidad',
  medida: 'unidad',
  unit: 'unidad',

  sku: 'sku',
  clave: 'sku',
  clave_producto: 'sku',

  stock_minimo: 'stock_minimo',
  minimo: 'stock_minimo',
  punto_reposicion: 'stock_minimo',
  reposicion: 'stock_minimo',
  min_stock: 'stock_minimo',

  ubicacion: 'ubicacion',
  anaquel: 'ubicacion',
  localizacion: 'ubicacion',
  location: 'ubicacion',
};

const CABECERAS_OBLIGATORIAS = ['nombre', 'precio'] as const;

/** Lee un CSV y devuelve las filas limpias y los problemas que encontró. */
export function analizarCsv(texto: string): AnalisisCsv {
  const crudas = parsearCsv(texto);
  if (crudas.length === 0) {
    return { filas: [], problemas: [{ linea: 1, mensaje: 'El archivo está vacío.' }] };
  }

  const cabecera = crudas[0];
  if (cabecera === undefined) {
    return { filas: [], problemas: [{ linea: 1, mensaje: 'El archivo está vacío.' }] };
  }

  const indices = new Map<string, number>();
  cabecera.celdas.forEach((celda, indice) => {
    const clave = ALIAS[normalizarCabecera(celda)];
    if (clave !== undefined && !indices.has(clave)) indices.set(clave, indice);
  });

  const faltantes = CABECERAS_OBLIGATORIAS.filter((nombre) => !indices.has(nombre));
  if (faltantes.length > 0) {
    return {
      filas: [],
      problemas: [
        {
          linea: cabecera.linea,
          mensaje: `Faltan columnas obligatorias: ${faltantes.join(', ')}. La primera fila debe tener encabezados.`,
        },
      ],
    };
  }

  const filas: FilaCsv[] = [];
  const problemas: ProblemaCsv[] = [];
  const codigosVistos = new Map<string, number>();
  const skusVistos = new Map<string, number>();

  for (const cruda of crudas.slice(1)) {
    const valor = (clave: string): string => {
      const indice = indices.get(clave);
      return indice === undefined ? '' : (cruda.celdas[indice] ?? '').trim();
    };

    // Una fila de puras comas es común al final de los archivos de Excel.
    if (cruda.celdas.every((celda) => celda.trim() === '')) continue;

    const nombre = valor('nombre');
    const precioTexto = valor('precio');
    const costoTexto = valor('costo');
    const codigoCrudo = valor('codigo');
    const categoria = valor('categoria') === '' ? null : valor('categoria');
    const unidad = valor('unidad') === '' ? null : valor('unidad');
    const skuCrudo = valor('sku');
    const stockMinimoTexto = valor('stock_minimo');
    const ubicacion = valor('ubicacion') === '' ? null : valor('ubicacion');

    let sirve = true;

    if (nombre === '') {
      problemas.push({ linea: cruda.linea, mensaje: 'Falta el nombre del producto.' });
      sirve = false;
    }

    const precioMinor = importeAMinor(precioTexto);
    if (precioMinor === null || precioMinor <= 0n) {
      problemas.push({
        linea: cruda.linea,
        mensaje: `El precio «${precioTexto || '(vacío)'}» no es un número mayor que cero.`,
      });
      sirve = false;
    }

    const costoMinor = costoTexto === '' ? 0n : importeAMinor(costoTexto);
    if (costoMinor === null || costoMinor < 0n) {
      problemas.push({
        linea: cruda.linea,
        mensaje: `El costo «${costoTexto}» no es un número válido.`,
      });
      sirve = false;
    }

    const stockMinimo = stockMinimoTexto === '' ? 0 : cantidad(stockMinimoTexto);
    if (stockMinimo === null || stockMinimo < 0) {
      problemas.push({
        linea: cruda.linea,
        mensaje: `El stock mínimo «${stockMinimoTexto}» no es un número válido.`,
      });
      sirve = false;
    }

    const codigo = codigoCrudo === '' ? null : normalizarCodigo(codigoCrudo);
    if (codigo !== null) {
      if (/^\d{13}$/.test(codigo) && !validaEAN13(codigo)) {
        problemas.push({
          linea: cruda.linea,
          mensaje: `El código ${codigo} parece EAN-13 pero el dígito verificador no cuadra.`,
        });
        sirve = false;
      } else if (!/^\d{13}$/.test(codigo) && !validaCode128(codigo)) {
        problemas.push({
          linea: cruda.linea,
          mensaje: `El código ${codigo} no es legible: usa mayúsculas, números y guiones.`,
        });
        sirve = false;
      }

      const anterior = codigosVistos.get(codigo);
      if (anterior !== undefined) {
        problemas.push({
          linea: cruda.linea,
          mensaje: `El código ${codigo} ya aparece en la línea ${anterior}.`,
        });
        sirve = false;
      } else {
        codigosVistos.set(codigo, cruda.linea);
      }
    }

    const sku = skuCrudo === '' ? null : skuCrudo.toUpperCase();
    if (sku !== null) {
      const anterior = skusVistos.get(sku);
      if (anterior !== undefined) {
        problemas.push({
          linea: cruda.linea,
          mensaje: `El SKU ${sku} ya aparece en la línea ${anterior}.`,
        });
        sirve = false;
      } else {
        skusVistos.set(sku, cruda.linea);
      }
    }

    if (!sirve) continue;

    filas.push({
      linea: cruda.linea,
      nombre,
      precioMinor: precioMinor as bigint,
      costoMinor: costoMinor as bigint,
      codigo,
      categoria,
      unidad,
      sku,
      stockMinimo: stockMinimo as number,
      ubicacion,
    });
  }

  if (filas.length === 0 && problemas.length === 0) {
    problemas.push({ linea: cabecera.linea, mensaje: 'No hay productos en el archivo.' });
  }

  return { filas, problemas };
}

/** Parsea un CSV con comillas, comas o punto y coma, y saltos dentro de comillas. */
export function parsearCsv(texto: string): FilaCruda[] {
  const limpio = texto.replace(/^\uFEFF/, '');
  const delimitador = detectarDelimitador(limpio);
  const filas: FilaCruda[] = [];

  let celdas: string[] = [];
  let campo = '';
  let enComillas = false;
  let linea = 1;
  let lineaInicio = 1;

  const cerrarFila = (): void => {
    celdas.push(campo);
    campo = '';
    if (celdas.some((celda) => celda.trim() !== '')) {
      filas.push({ linea: lineaInicio, celdas });
    }
    celdas = [];
    lineaInicio = linea + 1;
  };

  for (let i = 0; i < limpio.length; i++) {
    const caracter = limpio[i] as string;

    if (caracter === '"') {
      if (enComillas && limpio[i + 1] === '"') {
        campo += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
      continue;
    }

    if (caracter === delimitador && !enComillas) {
      celdas.push(campo);
      campo = '';
      continue;
    }

    if ((caracter === '\n' || caracter === '\r') && !enComillas) {
      if (caracter === '\r' && limpio[i + 1] === '\n') i++;
      cerrarFila();
      linea++;
      lineaInicio = linea;
      continue;
    }

    if (caracter === '\n') linea++;
    campo += caracter;
  }

  if (campo !== '' || celdas.length > 0) cerrarFila();

  return filas;
}

/** `"$1,234.50"` → `123450n`; `"12,50"` → `1250n`; `""` → `null`. */
export function importeAMinor(texto: string): bigint | null {
  let limpio = texto.trim().replace(/[^\d.,-]/g, '');
  if (limpio === '' || limpio.startsWith('-')) return null;

  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');

  if (ultimaComa !== -1 && ultimoPunto !== -1) {
    if (ultimaComa > ultimoPunto) {
      limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else {
      limpio = limpio.replace(/,/g, '');
    }
  } else if (ultimaComa !== -1) {
    const decimales = limpio.length - ultimaComa - 1;
    limpio = decimales <= 2 ? limpio.replace(',', '.') : limpio.replace(/,/g, '');
  } else if (ultimoPunto !== -1) {
    const partes = limpio.split('.');
    const decimales = limpio.length - ultimoPunto - 1;
    if (partes.length > 2 && decimales > 2) limpio = limpio.replace(/\./g, '');
  }

  const [enteroCrudo = '', decimalCrudo = ''] = limpio.split('.');
  const entero = enteroCrudo === '' ? '0' : enteroCrudo;
  if (!/^\d+$/.test(entero)) return null;

  const decimales = decimalCrudo.replace(/\D/g, '');
  let centavos = BigInt(entero) * 100n + BigInt(decimales.slice(0, 2).padEnd(2, '0'));

  // Tercer decimal: se redondea hacia arriba, igual que el resto del sistema.
  if (decimales.length > 2 && Number(decimales[2]) >= 5) centavos += 1n;

  return centavos;
}

function cantidad(texto: string): number | null {
  const numero = Number(texto.replace(',', '.'));
  return Number.isFinite(numero) && numero >= 0 ? numero : null;
}

function normalizarCabecera(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Mira la primera línea y elige el separador que más aparece fuera de comillas.
 * Excel en español exporta `;`, en inglés `,`. El tabulador viene de «copiar y pegar».
 */
function detectarDelimitador(texto: string): string {
  const conteo: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let enComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const caracter = texto[i] as string;
    if (caracter === '"') {
      if (enComillas && texto[i + 1] === '"') i++;
      else enComillas = !enComillas;
      continue;
    }
    if (!enComillas && (caracter === '\n' || caracter === '\r')) break;
    if (!enComillas && caracter in conteo) {
      conteo[caracter] = (conteo[caracter] ?? 0) + 1;
    }
  }

  const elegido = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0];
  return elegido === undefined || elegido[1] === 0 ? ',' : elegido[0];
}
