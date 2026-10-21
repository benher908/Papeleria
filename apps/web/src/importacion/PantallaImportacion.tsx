/**
 * Importación del catálogo desde CSV (F1.10).
 *
 * El archivo se lee y se revisa **antes** de tocar la base: si una fila tiene un
 * precio malo o un código repetido, no se importa nada. La importación real usa
 * `crearProductosLote()`, que abre una sola transacción para todos los productos.
 *
 * Las categorías y unidades no se inventan aquí: se buscan por nombre o abreviatura
 * entre las que ya existen. Si el CSV trae una categoría nueva, la fila se marca para
 * corregirla; crear categorías desde la importación es una decisión de F1.1 que
 * todavía no está tomada.
 */

import { useMemo, useState } from 'react';

import {
  crearProductosLote,
  ErrorNoAutorizado,
  ErrorProducto,
  type DatosProducto,
} from '@papeleria/db';
import { ErrorDinero } from '@papeleria/core';

import { Aviso, Boton, Tarjeta } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import { pesos } from '../productos/formato';
import type { OpcionCatalogo } from '../productos/Formulario';
import { analizarCsv, type FilaCsv, type ProblemaCsv } from './csv';

export interface PropsImportacion {
  readonly base: BaseLocal;
  readonly usuarioId: string;
  readonly dispositivoId: string;
  readonly categorias: readonly OpcionCatalogo[];
  readonly unidades: readonly OpcionCatalogo[];
  readonly onCancelar: () => void;
  readonly onImportados: (cantidad: number) => void;
}

interface Preparado {
  readonly datos: readonly DatosProducto[];
  readonly problemas: readonly ProblemaCsv[];
}

export function PantallaImportacion({
  base,
  usuarioId,
  dispositivoId,
  categorias,
  unidades,
  onCancelar,
  onImportados,
}: PropsImportacion) {
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [filas, setFilas] = useState<readonly FilaCsv[] | null>(null);
  const [problemasArchivo, setProblemasArchivo] = useState<readonly ProblemaCsv[]>([]);
  const [importando, setImportando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preparado = useMemo<Preparado>(
    () => preparar(filas ?? [], categorias, unidades),
    [filas, categorias, unidades],
  );

  const problemas = [...problemasArchivo, ...preparado.problemas];
  const puedeImportar =
    filas !== null && preparado.datos.length > 0 && problemas.length === 0 && !importando;

  async function leerArchivo(archivo: File | undefined): Promise<void> {
    setError(null);
    setFilas(null);
    setProblemasArchivo([]);
    setNombreArchivo(null);

    if (archivo === undefined) return;
    if (archivo.size > 5 * 1024 * 1024) {
      setError('El archivo pasa de 5 MB. Divide el catálogo en dos o tres archivos.');
      return;
    }

    setNombreArchivo(archivo.name);
    try {
      const texto = await archivo.text();
      const analisis = analizarCsv(texto);
      setFilas(analisis.filas);
      setProblemasArchivo(analisis.problemas);
    } catch (causa) {
      setError(`No se pudo leer el archivo: ${causa instanceof Error ? causa.message : String(causa)}`);
    }
  }

  async function importar(): Promise<void> {
    setImportando(true);
    setError(null);

    try {
      const creados = await crearProductosLote(
        comoClienteTransaccional(base),
        preparado.datos,
        { usuarioId, dispositivoId },
      );
      await base.sincronizar();
      onImportados(creados.length);
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Importar desde CSV</h2>
          <p className="max-w-2xl text-sm text-[var(--suave)]">
            Excel puede guardar como CSV. Revisa la lista antes de importar: si una fila
            falla, no entra ninguna. Los productos sin código reciben uno interno.
          </p>
        </div>
        <Boton variante="secundario" onClick={descargarPlantilla}>
          Descargar plantilla
        </Boton>
      </div>

      <Tarjeta className="p-5">
        <label className="flex flex-col gap-2 text-sm font-medium">
          Archivo CSV
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(evento) => {
              const archivo = evento.target.files?.[0];
              evento.target.value = '';
              void leerArchivo(archivo);
            }}
            className="block w-full cursor-pointer rounded-md border border-[var(--linea)] bg-[var(--fondo)] px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--acento)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
          />
        </label>

        {nombreArchivo === null ? null : (
          <p className="mt-2 text-xs text-[var(--suave)]">Archivo: {nombreArchivo}</p>
        )}

        <p className="mt-3 text-xs leading-relaxed text-[var(--suave)]">
          Columnas: <strong>nombre</strong> y <strong>precio</strong> son obligatorias.
          Opcionales: costo, codigo, categoria, unidad, sku, stock_minimo, ubicacion. La
          coma o el punto y coma se detectan solos.
        </p>
      </Tarjeta>

      {error === null ? null : <Aviso tono="mal">{error}</Aviso>}

      {filas === null ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Resumen etiqueta="Filas listas" valor={String(preparado.datos.length)} />
            <Resumen etiqueta="Errores" valor={String(problemas.length)} mal={problemas.length > 0} />
            <Resumen
              etiqueta="Total a importar"
              valor={pesos(
                preparado.datos.reduce((suma, fila) => suma + fila.precioMinor, 0n),
              )}
            />
          </div>

          {problemas.length === 0 ? null : (
            <Tarjeta className="border-[var(--mal)] p-4">
              <h3 className="text-sm font-semibold text-[var(--mal)]">
                Corrige el archivo antes de importar
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-[var(--mal)]">
                {problemas.slice(0, 20).map((problema, indice) => (
                  <li key={`${problema.linea}-${indice}`}>
                    Línea {problema.linea}: {problema.mensaje}
                  </li>
                ))}
              </ul>
              {problemas.length > 20 ? (
                <p className="mt-2 text-xs text-[var(--mal)]">
                  Y {problemas.length - 20} error(es) más.
                </p>
              ) : null}
            </Tarjeta>
          )}

          {preparado.datos.length === 0 ? null : (
            <Tarjeta className="overflow-hidden">
              <div className="border-b border-[var(--linea)] px-4 py-3">
                <h3 className="text-sm font-semibold">Vista previa</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--linea)] text-left text-xs text-[var(--suave)]">
                      <th className="px-3 py-2 font-medium">Producto</th>
                      <th className="px-3 py-2 font-medium">Categoría</th>
                      <th className="px-3 py-2 text-right font-medium">Precio</th>
                      <th className="px-3 py-2 text-right font-medium">Costo</th>
                      <th className="hidden px-3 py-2 font-medium sm:table-cell">Código</th>
                      <th className="hidden px-3 py-2 font-medium md:table-cell">Unidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preparado.datos.slice(0, 12).map((fila, indice) => (
                      <tr
                        key={`${fila.nombre}-${indice}`}
                        className="border-b border-[var(--linea)] last:border-b-0"
                      >
                        <td className="px-3 py-2">
                          {fila.nombre}
                          {fila.sku === null ? null : (
                            <span className="ml-2 font-mono text-xs text-[var(--suave)]">
                              {fila.sku}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[var(--suave)]">
                          {categorias.find((categoria) => categoria.id === fila.categoryId)?.nombre ??
                            '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {pesos(fila.precioMinor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--suave)]">
                          {pesos(fila.costoMinor ?? 0n)}
                        </td>
                        <td className="hidden px-3 py-2 font-mono text-xs text-[var(--suave)] sm:table-cell">
                          {fila.codigos?.[0] ?? 'interno'}
                        </td>
                        <td className="hidden px-3 py-2 text-[var(--suave)] md:table-cell">
                          {unidades.find((unidad) => unidad.id === fila.unitId)?.nombre ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preparado.datos.length > 12 ? (
                <p className="border-t border-[var(--linea)] px-3 py-2 text-xs text-[var(--suave)]">
                  Y {preparado.datos.length - 12} producto(s) más.
                </p>
              ) : null}
            </Tarjeta>
          )}
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Boton variante="secundario" onClick={onCancelar} disabled={importando}>
          Volver al catálogo
        </Boton>
        <Boton onClick={() => void importar()} disabled={!puedeImportar}>
          {importando ? 'Importando…' : `Importar ${preparado.datos.length} producto(s)`}
        </Boton>
      </div>
    </div>
  );
}

function preparar(
  filas: readonly FilaCsv[],
  categorias: readonly OpcionCatalogo[],
  unidades: readonly OpcionCatalogo[],
): Preparado {
  const problemas: ProblemaCsv[] = [];
  const datos: DatosProducto[] = [];

  const unidadPorNombre = new Map<string, OpcionCatalogo>();
  for (const unidad of unidades) {
    unidadPorNombre.set(normalizar(unidad.nombre), unidad);
    if (unidad.abreviatura !== undefined) {
      unidadPorNombre.set(normalizar(unidad.abreviatura), unidad);
    }
  }
  const unidadPorDefecto =
    unidadPorNombre.get('pieza') ?? unidades.find((unidad) => unidad.nombre === 'pieza') ?? unidades[0];

  const categoriaPorNombre = new Map<string, OpcionCatalogo>();
  for (const categoria of categorias) {
    categoriaPorNombre.set(normalizar(categoria.nombre), categoria);
  }

  if (unidadPorDefecto === undefined) {
    return {
      datos: [],
      problemas: [{ linea: 1, mensaje: 'No hay unidades en el catálogo; no se puede importar.' }],
    };
  }

  for (const fila of filas) {
    let sirve = true;
    let unitId = unidadPorDefecto.id;

    if (fila.unidad !== null) {
      const unidad = unidadPorNombre.get(normalizar(fila.unidad));
      if (unidad === undefined) {
        problemas.push({
          linea: fila.linea,
          mensaje: `La unidad «${fila.unidad}» no existe. Usa pieza, paquete, caja, hoja, metro u hora.`,
        });
        sirve = false;
      } else {
        unitId = unidad.id;
      }
    }

    let categoryId: string | null = null;
    if (fila.categoria !== null) {
      const categoria = categoriaPorNombre.get(normalizar(fila.categoria));
      if (categoria === undefined) {
        problemas.push({
          linea: fila.linea,
          mensaje: `La categoría «${fila.categoria}» no existe en el catálogo.`,
        });
        sirve = false;
      } else {
        categoryId = categoria.id;
      }
    }

    if (!sirve) continue;

    datos.push({
      nombre: fila.nombre,
      unitId,
      precioMinor: fila.precioMinor,
      costoMinor: fila.costoMinor,
      ...(categoryId === null ? {} : { categoryId }),
      ...(fila.sku === null ? {} : { sku: fila.sku }),
      ...(fila.ubicacion === null ? {} : { ubicacion: fila.ubicacion }),
      stockMinimo: fila.stockMinimo,
      ...(fila.codigo === null ? {} : { codigos: [fila.codigo] }),
    });
  }

  return { datos, problemas };
}

function Resumen({
  etiqueta,
  valor,
  mal = false,
}: {
  readonly etiqueta: string;
  readonly valor: string;
  readonly mal?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--linea)] bg-[var(--tarjeta)] px-4 py-3">
      <p className="text-xs text-[var(--suave)]">{etiqueta}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${mal ? 'text-[var(--mal)]' : ''}`}>
        {valor}
      </p>
    </div>
  );
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function mensajeDe(causa: unknown): string {
  if (
    causa instanceof ErrorProducto ||
    causa instanceof ErrorNoAutorizado ||
    causa instanceof ErrorDinero
  ) {
    return causa.message;
  }
  return `No se pudo importar (${causa instanceof Error ? causa.message : String(causa)}).`;
}

function descargarPlantilla(): void {
  const contenido = [
    '\uFEFFnombre,precio,costo,codigo,categoria,unidad,sku,stock_minimo,ubicacion',
    'Cuaderno profesional,25.50,15.00,,Escolar,pieza,CUA-PROF,5,A-3-12',
    'Lápiz Mirado 2,7.00,4.00,,Escritura,pieza,LAP-MIR-2,12,A-2-01',
    'Goma blanca,5.00,2.50,,Escolar,pieza,GOMA-BLA,6,A-2-02',
  ].join('\r\n');

  const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = 'plantilla-productos.csv';
  enlace.click();
  URL.revokeObjectURL(url);
}
