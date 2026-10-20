/**
 * ETIQUETAS DE PRODUCTO Y DE ANAQUEL (F1.7 – F1.9).
 *
 * El código interno ya se genera al dar de alta el producto; lo que faltaba era
 * sacarlo de la pantalla. Aquí se arma una hoja A4 con las etiquetas y se manda a
 * imprimir en un iframe aislado: así la hoja no hereda el CSS del ticket de 58 mm
 * ni el del POS, que tienen reglas de impresión incompatibles.
 *
 * Decisiones que se ven en el código:
 *
 * · EAN-13 para producto, Code 128 para anaquel. Es lo que dice docs/03 y lo que
 *   lee cualquier lector de $300; no se inventa un QR donde no hace falta.
 * · La calibración vive en `localStorage`, no en la base: es una propiedad de la
 *   impresora y del papel de ESTE equipo, no de la papelería.
 * · La vista previa es el MISMO HTML que se imprime, en un iframe. Si la previa y
 *   el papel se construyeran por caminos distintos, la una mentiría sobre el otro.
 * · Si un producto no tiene código, no se inventa uno aquí: se avisa. El código se
 *   reserva en la base al crearlo, y dos etiquetas con el mismo número serían peor
 *   que ninguna.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toSVG } from 'bwip-js/browser';

import { validaEAN13 } from '@papeleria/core';
import { listarProductos, type FilaProducto } from '@papeleria/db';

import { Aviso, Boton, Entrada, Seleccion, Tarjeta } from '../componentes/ui';
import { comoClienteTransaccional } from '../db/cliente';
import type { BaseLocal } from '../db/baseLocal';
import { pesos } from '../productos/formato';

const CLAVE_CONFIG = 'papeleria.etiquetas.config';

interface Config {
  readonly columnas: number;
  readonly filas: number;
  readonly anchoMm: number;
  readonly altoMm: number;
  readonly margenSupMm: number;
  readonly margenIzqMm: number;
  readonly gapXMm: number;
  readonly gapYMm: number;
}

const CONFIG_INICIAL: Config = {
  columnas: 3,
  filas: 8,
  anchoMm: 63.5,
  altoMm: 33.9,
  margenSupMm: 12.7,
  margenIzqMm: 4.8,
  gapXMm: 2.5,
  gapYMm: 0,
};

const PRESETS: ReadonlyArray<{ nombre: string; config: Config }> = [
  {
    nombre: 'A4 · 3 × 8 (63.5 × 33.9 mm)',
    config: CONFIG_INICIAL,
  },
  {
    nombre: 'A4 · 3 × 7 (70 × 37 mm)',
    config: {
      columnas: 3,
      filas: 7,
      anchoMm: 70,
      altoMm: 37,
      margenSupMm: 8,
      margenIzqMm: 0,
      gapXMm: 0,
      gapYMm: 0,
    },
  },
  {
    nombre: 'A4 · 2 × 5 (99.1 × 38.1 mm)',
    config: {
      columnas: 2,
      filas: 5,
      anchoMm: 99.1,
      altoMm: 38.1,
      margenSupMm: 8,
      margenIzqMm: 4.7,
      gapXMm: 2.5,
      gapYMm: 0,
    },
  },
];

interface Seleccion {
  readonly fila: FilaProducto;
  readonly copias: number;
}

export interface PropsEtiquetas {
  readonly base: BaseLocal;
}

export function PantallaEtiquetas({ base }: PropsEtiquetas) {
  const [config, setConfig] = useState<Config>(leerConfig);
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState<readonly FilaProducto[]>([]);
  const [seleccion, setSeleccion] = useState<readonly Seleccion[]>([]);
  const [ubicacion, setUbicacion] = useState('');
  const [copiasAnaquel, setCopiasAnaquel] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const buscador = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let vigente = true;
    const temporizador = window.setTimeout(() => {
      void (async () => {
        try {
          const filas = await listarProductos(comoClienteTransaccional(base), busqueda);
          if (vigente) setResultados(filas.slice(0, 12));
        } catch (causa) {
          if (vigente) setError(causa instanceof Error ? causa.message : String(causa));
        }
      })();
    }, 140);

    return () => {
      vigente = false;
      window.clearTimeout(temporizador);
    };
  }, [base, busqueda]);

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE_CONFIG, JSON.stringify(config));
    } catch {
      // Sin localStorage la calibración no persiste, pero imprimir sigue funcionando.
    }
  }, [config]);

  const hojaProductos = useMemo(
    () => hojaDeProductos(seleccion, config),
    [seleccion, config],
  );

  const hojaAnaquel = useMemo(() => {
    if (ubicacion.trim() === '') return null;
    const codigo = construirCodigoDeUbicacion(ubicacion);
    return hojaDeAnaquel(codigo, Math.max(1, Number.parseInt(copiasAnaquel, 10) || 1), config);
  }, [ubicacion, copiasAnaquel, config]);

  const totalEtiquetas = seleccion.reduce((suma, item) => suma + item.copias, 0);
  const sinCodigo = seleccion.filter((item) => item.fila.codigo === null);

  function agregar(fila: FilaProducto): void {
    setAviso(null);
    setError(null);
    if (fila.codigo === null) {
      setError(`«${fila.nombre}» no tiene código de barras. Edítalo y genera uno antes de imprimir.`);
      return;
    }
    setSeleccion((actual) => {
      const existente = actual.find((item) => item.fila.id === fila.id);
      if (existente !== undefined) {
        return actual.map((item) =>
          item.fila.id === fila.id ? { ...item, copias: item.copias + 1 } : item,
        );
      }
      return [...actual, { fila, copias: 1 }];
    });
  }

  function cambiarCopias(id: string, delta: number): void {
    setSeleccion((actual) =>
      actual
        .map((item) =>
          item.fila.id === id ? { ...item, copias: Math.max(0, item.copias + delta) } : item,
        )
        .filter((item) => item.copias > 0),
    );
  }

  function imprimirProductos(): void {
    setError(null);
    if (seleccion.length === 0) {
      setError('Agrega al menos un producto a la hoja.');
      return;
    }
    if (sinCodigo.length > 0) {
      setError(
        `Hay ${sinCodigo.length} producto(s) sin código. Quítalos o genera su código antes de imprimir.`,
      );
      return;
    }
    imprimirHTML(hojaProductos);
    setAviso(`Se mandaron ${totalEtiquetas} etiqueta(s) a la impresora.`);
  }

  function imprimirPrueba(): void {
    const primera = seleccion[0];
    if (primera === undefined) {
      setError('Agrega un producto para imprimir la hoja de prueba.');
      return;
    }
    imprimirHTML(hojaDeProductos([{ ...primera, copias: 1 }], config));
    setAviso('Hoja de prueba: una sola etiqueta. Escanéala antes de imprimir el lote.');
  }

  function imprimirAnaquel(): void {
    setError(null);
    if (hojaAnaquel === null) {
      setError('Escribe la ubicación del anaquel, por ejemplo A-3-12.');
      return;
    }
    imprimirHTML(hojaAnaquel);
    setAviso('Se mandó la etiqueta de anaquel a la impresora.');
  }

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta className="p-5">
        <h1 className="text-lg font-semibold tracking-tight">Etiquetas</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--suave)]">
          Hojas A4 con el código interno EAN-13. La calibración se guarda en este equipo;
          ajústala una vez con una hoja de prueba y no la vuelvas a tocar.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
            Tamaño de hoja
            <Seleccion
              value={presetDe(config)}
              onChange={(evento) => {
                const preset = PRESETS[Number(evento.target.value)];
                if (preset !== undefined) setConfig(preset.config);
              }}
            >
              {PRESETS.map((preset, indice) => (
                <option key={preset.nombre} value={indice}>
                  {preset.nombre}
                </option>
              ))}
            </Seleccion>
          </label>
          <NumeroMm
            etiqueta="Ancho"
            valor={config.anchoMm}
            onCambio={(valor) => setConfig({ ...config, anchoMm: valor })}
          />
          <NumeroMm
            etiqueta="Alto"
            valor={config.altoMm}
            onCambio={(valor) => setConfig({ ...config, altoMm: valor })}
          />
          <NumeroMm
            etiqueta="Margen superior"
            valor={config.margenSupMm}
            onCambio={(valor) => setConfig({ ...config, margenSupMm: valor })}
          />
          <NumeroMm
            etiqueta="Margen izquierdo"
            valor={config.margenIzqMm}
            onCambio={(valor) => setConfig({ ...config, margenIzqMm: valor })}
          />
          <NumeroEntero
            etiqueta="Columnas"
            valor={config.columnas}
            onCambio={(valor) => setConfig({ ...config, columnas: valor })}
          />
          <NumeroEntero
            etiqueta="Filas"
            valor={config.filas}
            onCambio={(valor) => setConfig({ ...config, filas: valor })}
          />
          <NumeroMm
            etiqueta="Separación horizontal"
            valor={config.gapXMm}
            onCambio={(valor) => setConfig({ ...config, gapXMm: valor })}
          />
        </div>
      </Tarjeta>

      <div className="grid items-start gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Tarjeta className="p-4">
            <h2 className="text-base font-semibold">Productos</h2>
            <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
              Buscar por nombre o código
              <Entrada
                ref={buscador}
                value={busqueda}
                onChange={(evento) => setBusqueda(evento.target.value)}
                placeholder="Cuaderno, 2000000000015…"
                autoComplete="off"
              />
            </label>

            <ul className="mt-3 divide-y divide-[var(--linea)]">
              {resultados.map((fila) => (
                <li key={fila.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{fila.nombre}</p>
                    <p className="text-xs text-[var(--suave)]">
                      {fila.codigo ?? 'Sin código'} · {pesos(fila.precioMinor)}
                    </p>
                  </div>
                  <Boton
                    variante="secundario"
                    className="px-2.5 py-1.5 text-xs"
                    onClick={() => agregar(fila)}
                    disabled={fila.codigo === null}
                  >
                    Agregar
                  </Boton>
                </li>
              ))}
            </ul>
            {resultados.length === 0 ? (
              <p className="mt-3 text-xs text-[var(--suave)]">
                No hay resultados. Da de alta el producto primero.
              </p>
            ) : null}
          </Tarjeta>

          <Tarjeta className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Hoja ({totalEtiquetas})</h2>
              <Boton
                variante="secundario"
                className="px-2.5 py-1.5 text-xs"
                onClick={() => setSeleccion([])}
                disabled={seleccion.length === 0}
              >
                Vaciar
              </Boton>
            </div>

            {seleccion.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--suave)]">
                Agrega productos de la lista para armar la hoja.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--linea)]">
                {seleccion.map((item) => (
                  <li key={item.fila.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{item.fila.nombre}</p>
                      <p className="text-xs text-[var(--suave)]">{item.fila.codigo}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Boton
                        variante="secundario"
                        className="h-7 w-7 px-0 py-0"
                        onClick={() => cambiarCopias(item.fila.id, -1)}
                        aria-label="Una etiqueta menos"
                      >
                        −
                      </Boton>
                      <span className="w-6 text-center text-sm">{item.copias}</span>
                      <Boton
                        variante="secundario"
                        className="h-7 w-7 px-0 py-0"
                        onClick={() => cambiarCopias(item.fila.id, 1)}
                        aria-label="Una etiqueta más"
                      >
                        +
                      </Boton>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Boton
                variante="secundario"
                onClick={imprimirPrueba}
                disabled={seleccion.length === 0}
              >
                Hoja de prueba (1)
              </Boton>
              <Boton onClick={imprimirProductos} disabled={seleccion.length === 0}>
                Imprimir hoja ({totalEtiquetas})
              </Boton>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-[var(--suave)]">
              Imprime primero una hoja de prueba en la impresora real y escanea la etiqueta
              con el lector. Si no se lee, ajusta el tamaño o el margen antes del lote.
            </p>
          </Tarjeta>

          <Tarjeta className="p-4">
            <h2 className="text-base font-semibold">Anaquel</h2>
            <p className="mt-1 text-xs text-[var(--suave)]">
              Code 128 con la ubicación. Se imprime en la misma hoja A4.
            </p>
            <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
              Ubicación
              <Entrada
                value={ubicacion}
                onChange={(evento) => setUbicacion(evento.target.value)}
                placeholder="A-3-12"
              />
            </label>
            <label className="mt-2 flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
              Copias
              <Entrada
                value={copiasAnaquel}
                onChange={(evento) => setCopiasAnaquel(evento.target.value)}
                inputMode="numeric"
              />
            </label>
            <Boton className="mt-3 w-full" onClick={imprimirAnaquel} disabled={ubicacion.trim() === ''}>
              Imprimir etiqueta de anaquel
            </Boton>
          </Tarjeta>

          {error === null ? null : <Aviso tono="mal">{error}</Aviso>}
          {aviso === null ? null : <Aviso tono="ok">{aviso}</Aviso>}
        </div>

        <Tarjeta className="overflow-hidden p-3">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <h2 className="text-base font-semibold">Vista previa</h2>
            <span className="text-xs text-[var(--suave)]">La misma hoja que se imprime</span>
          </div>
          <div className="h-[175mm] overflow-auto rounded-md border border-[var(--linea)] bg-white">
            <iframe
              title="Vista previa de etiquetas"
              srcDoc={hojaProductos}
              className="origin-top-left"
              style={{
                width: '210mm',
                height: '297mm',
                border: 0,
                transform: 'scale(0.62)',
              }}
            />
          </div>
          {hojaAnaquel === null ? null : (
            <div className="mt-3 border-t border-[var(--linea)] pt-3">
              <p className="mb-2 text-xs font-medium text-[var(--suave)]">Anaquel</p>
              <div className="h-[70mm] overflow-auto rounded-md border border-[var(--linea)] bg-white">
                <iframe
                  title="Vista previa de etiqueta de anaquel"
                  srcDoc={hojaAnaquel}
                  className="origin-top-left"
                  style={{
                    width: '210mm',
                    height: '297mm',
                    border: 0,
                    transform: 'scale(0.62)',
                  }}
                />
              </div>
            </div>
          )}
        </Tarjeta>
      </div>
    </div>
  );
}

function NumeroMm({
  etiqueta,
  valor,
  onCambio,
}: {
  readonly etiqueta: string;
  readonly valor: number;
  readonly onCambio: (valor: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
      {etiqueta} (mm)
      <Entrada
        value={String(valor)}
        onChange={(evento) => {
          const numero = Number.parseFloat(evento.target.value);
          if (Number.isFinite(numero) && numero >= 0) onCambio(numero);
        }}
        inputMode="decimal"
      />
    </label>
  );
}

function NumeroEntero({
  etiqueta,
  valor,
  onCambio,
}: {
  readonly etiqueta: string;
  readonly valor: number;
  readonly onCambio: (valor: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
      {etiqueta}
      <Entrada
        value={String(valor)}
        onChange={(evento) => {
          const numero = Number.parseInt(evento.target.value, 10);
          if (Number.isInteger(numero) && numero > 0) onCambio(numero);
        }}
        inputMode="numeric"
      />
    </label>
  );
}

function presetDe(config: Config): string {
  const indice = PRESETS.findIndex((preset) => mismoTamano(preset.config, config));
  return String(indice === -1 ? 0 : indice);
}

function mismoTamano(a: Config, b: Config): boolean {
  return a.columnas === b.columnas && a.filas === b.filas && a.anchoMm === b.anchoMm;
}

function leerConfig(): Config {
  try {
    const crudo = localStorage.getItem(CLAVE_CONFIG);
    if (crudo === null) return CONFIG_INICIAL;
    const datos = JSON.parse(crudo) as Partial<Config>;
    return {
      columnas: enteroPositivo(datos.columnas, CONFIG_INICIAL.columnas),
      filas: enteroPositivo(datos.filas, CONFIG_INICIAL.filas),
      anchoMm: numeroPositivo(datos.anchoMm, CONFIG_INICIAL.anchoMm),
      altoMm: numeroPositivo(datos.altoMm, CONFIG_INICIAL.altoMm),
      margenSupMm: numeroPositivo(datos.margenSupMm, CONFIG_INICIAL.margenSupMm, 0),
      margenIzqMm: numeroPositivo(datos.margenIzqMm, CONFIG_INICIAL.margenIzqMm, 0),
      gapXMm: numeroPositivo(datos.gapXMm, CONFIG_INICIAL.gapXMm, 0),
      gapYMm: numeroPositivo(datos.gapYMm, CONFIG_INICIAL.gapYMm, 0),
    };
  } catch {
    return CONFIG_INICIAL;
  }
}

function enteroPositivo(valor: unknown, defecto: number): number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor > 0 ? valor : defecto;
}

function numeroPositivo(valor: unknown, defecto: number, minimo = 0.1): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= minimo ? valor : defecto;
}

function construirCodigoDeUbicacion(ubicacion: string): string {
  const limpio = ubicacion
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9\-]/g, '');
  return limpio.startsWith('ANAQ-') ? limpio : `ANAQ-${limpio}`;
}

function hojaDeProductos(seleccion: readonly Seleccion[], config: Config): string {
  const etiquetas: string[] = [];
  for (const item of seleccion) {
    for (let copia = 0; copia < item.copias; copia++) {
      etiquetas.push(etiquetaProducto(item.fila));
    }
  }
  return hoja(etiquetas, config);
}

function etiquetaProducto(fila: FilaProducto): string {
  const codigo = fila.codigo ?? '';
  const svg = barcodeSVG(codigo, validaEAN13(codigo) ? 'ean13' : 'code128');
  return `
    <div class="etiqueta producto">
      <div class="nombre">${escapar(fila.nombre)}</div>
      <div class="precio">${escapar(pesos(fila.precioMinor))}</div>
      <div class="codigo">${svg}</div>
      <div class="pie">
        <span>${escapar(codigo)}</span>
        ${fila.ubicacion === null ? '' : `<span>${escapar(fila.ubicacion)}</span>`}
      </div>
    </div>`;
}

function hojaDeAnaquel(codigo: string, copias: number, config: Config): string {
  const svg = barcodeSVG(codigo, 'code128');
  const etiqueta = `
    <div class="etiqueta anaquel">
      <div class="rotulo">UBICACIÓN</div>
      <div class="codigo">${svg}</div>
      <div class="pie"><span>${escapar(codigo)}</span></div>
    </div>`;
  return hoja(Array.from({ length: copias }, () => etiqueta), config);
}

function hoja(etiquetas: readonly string[], config: Config): string {
  const porPagina = Math.max(1, config.columnas * config.filas);
  const paginas: string[] = [];
  for (let inicio = 0; inicio < etiquetas.length; inicio += porPagina) {
    paginas.push(
      `<div class="hoja">${etiquetas
        .slice(inicio, inicio + porPagina)
        .join('')}</div>`,
    );
  }
  if (paginas.length === 0) paginas.push('<div class="hoja"></div>');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Etiquetas</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .hoja {
    width: 210mm;
    height: 297mm;
    padding: ${config.margenSupMm}mm 0 0 ${config.margenIzqMm}mm;
    display: grid;
    grid-template-columns: repeat(${config.columnas}, ${config.anchoMm}mm);
    grid-auto-rows: ${config.altoMm}mm;
    column-gap: ${config.gapXMm}mm;
    row-gap: ${config.gapYMm}mm;
    align-content: start;
    page-break-after: always;
    overflow: hidden;
  }
  .hoja:last-child { page-break-after: auto; }
  .etiqueta {
    width: ${config.anchoMm}mm;
    height: ${config.altoMm}mm;
    padding: 1.6mm 1.8mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border: 0.2mm dashed #bbb;
  }
  .producto .nombre {
    font-size: 7.4pt;
    font-weight: 650;
    line-height: 1.12;
    max-height: 8.2mm;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .producto .precio {
    font-size: 13pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.2pt;
  }
  .producto .codigo { height: 11.5mm; display: flex; align-items: center; justify-content: center; }
  .producto .codigo svg, .anaquel .codigo svg { width: 100%; height: 100%; }
  .pie {
    display: flex;
    justify-content: space-between;
    gap: 2mm;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 6.4pt;
    line-height: 1;
  }
  .anaquel {
    justify-content: center;
    gap: 1.5mm;
    text-align: center;
  }
  .anaquel .rotulo { font-size: 7pt; letter-spacing: 1.2pt; font-weight: 700; }
  .anaquel .codigo { height: 16mm; }
  .anaquel .pie { justify-content: center; font-size: 8pt; }
  @media screen {
    body { background: #fff; }
  }
</style>
</head>
<body>${paginas.join('')}</body>
</html>`;
}

function barcodeSVG(texto: string, bcid: 'ean13' | 'code128'): string {
  if (texto.trim() === '') return '';
  try {
    return toSVG({
      bcid,
      text: texto,
      scale: 2,
      height: 10,
      includetext: true,
      textxalign: 'center',
      textsize: 7,
      // La zona de silencio no es decorativa: sin ella el láser no encuentra
      // dónde empieza el código. El blanco del SVG cuenta como parte del código.
      paddingwidth: 8,
      paddingheight: 2,
      backgroundcolor: 'FFFFFF',
    });
  } catch {
    return `<div style="font-size:6pt">Código inválido: ${escapar(texto)}</div>`;
  }
}

function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Manda la hoja a imprimir en un iframe propio.
 *
 * No se usa `window.print()` directo porque el POS ya tiene un `@media print`
 * global para el ticket de 58 mm; si las dos reglas conviven, la etiqueta sale
 * recortada o el ticket sale en A4. El iframe tiene su propio documento y su
 * propio `@page`.
 */
function imprimirHTML(html: string): void {
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.append(marco);

  const documento = marco.contentDocument;
  const ventana = marco.contentWindow;
  if (documento === null || ventana === null) {
    marco.remove();
    return;
  }

  documento.open();
  documento.write(html);
  documento.close();

  let lanzado = false;
  const lanzar = (): void => {
    // `load` y el temporizador pueden dispararse los dos; sin esta guarda se
    // abrirían dos diálogos de impresión y el segundo sale con la hoja en blanco.
    if (lanzado) return;
    lanzado = true;
    ventana.focus();
    ventana.print();
  };
  marco.addEventListener('load', lanzar, { once: true });
  // Si el navegador no dispara `load` para un documento escrito a mano, el
  // temporizador evita que el botón no haga nada.
  window.setTimeout(lanzar, 250);
  window.setTimeout(() => marco.remove(), 60_000);
}
