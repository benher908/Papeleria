/**
 * La lista del catálogo.
 *
 * Una tabla y no tarjetas: el dueño va a tener cientos de productos y lo que necesita
 * es barrer la columna de precios con el ojo. En el celular se caen las columnas que
 * no caben (categoría, código) y queda nombre, precio y stock; el código se ve al
 * abrir el producto.
 *
 * La fila entera es el botón de editar. Un lápiz al final obliga a apuntar; una fila
 * que se puede tocar, no.
 */

import type { FilaProducto } from '@papeleria/db';

import { Boton, Entrada } from '../componentes/ui';
import { pesos } from './formato';

export interface PropsLista {
  readonly filas: readonly FilaProducto[] | null;
  readonly filtro: string;
  readonly onFiltro: (texto: string) => void;
  readonly onNuevo: () => void;
  readonly onImportar: () => void;
  readonly onEditar: (fila: FilaProducto) => void;
  readonly onDesactivar: (fila: FilaProducto) => void;
  readonly onActivar: (fila: FilaProducto) => void;
  readonly onRecargar: () => void;
  readonly error: string | null;
}

/** `12.000` → `12`; `0.500` → `0.5`. Sin ceros de relleno. */
function cantidad(texto: string): string {
  return Number(texto).toLocaleString('es-MX', { maximumFractionDigits: 3 });
}

export function Lista({
  filas,
  filtro,
  onFiltro,
  onNuevo,
  onImportar,
  onEditar,
  onDesactivar,
  onActivar,
  onRecargar,
  error,
}: PropsLista) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Catálogo</h2>
          <p className="text-sm text-[var(--suave)]">
            {filas === null
              ? 'Leyendo…'
              : `${filas.length} ${filas.length === 1 ? 'producto' : 'productos'}`}
            {filtro.trim() === '' ? '' : ' que coinciden'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Entrada
            value={filtro}
            onChange={(e) => onFiltro(e.target.value)}
            placeholder="Buscar por nombre o código…"
            className="w-64"
            type="search"
          />
          <Boton variante="secundario" onClick={onImportar}>
            Importar CSV
          </Boton>
          <Boton onClick={onNuevo}>Nuevo producto</Boton>
        </div>
      </div>

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-md border border-[var(--mal)] bg-[var(--mal-fondo)] px-3 py-2 text-sm text-[var(--mal)]"
        >
          {error}
        </p>
      )}

      {filas === null ? (
        <p className="py-10 text-center text-sm text-[var(--suave)]">Abriendo el catálogo…</p>
      ) : filas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--linea)] px-6 py-12 text-center">
          {filtro.trim() === '' ? (
            <>
              <p className="text-sm font-medium">Todavía no hay productos.</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-[var(--suave)]">
                Da de alta el primero: nombre, precio de venta y listo. La app le reserva
                un código de barras interno para imprimir la etiqueta.
              </p>
              <Boton className="mt-4" onClick={onNuevo}>
                Dar de alta el primero
              </Boton>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Nada coincide con «{filtro.trim()}».</p>
              <p className="mt-1 text-sm text-[var(--suave)]">
                Se busca por nombre, SKU y código de barras.
              </p>
              <Boton variante="secundario" className="mt-4" onClick={() => onFiltro('')}>
                Limpiar la búsqueda
              </Boton>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--linea)] bg-[var(--tarjeta)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--linea)] text-left text-xs text-[var(--suave)]">
                <th className="px-3 py-2 font-medium">Producto</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Categoría</th>
                <th className="px-3 py-2 text-right font-medium">Precio</th>
                <th className="px-3 py-2 text-right font-medium">Stock</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Código</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filas.map((fila) => (
                <tr
                  key={fila.id}
                  tabIndex={0}
                  onClick={() => onEditar(fila)}
                  onKeyDown={(evento) => {
                    if (evento.key === 'Enter' || evento.key === ' ') {
                      evento.preventDefault();
                      onEditar(fila);
                    }
                  }}
                  className="cursor-pointer border-b border-[var(--linea)] last:border-b-0 hover:bg-[var(--fondo)] focus:bg-[var(--fondo)] focus:outline-none"
                >
                  <td className="px-3 py-2">
                    <span className="font-medium">{fila.nombre}</span>
                    {fila.sku === null ? null : (
                      <span className="ml-2 font-mono text-xs text-[var(--suave)]">{fila.sku}</span>
                    )}
                    {fila.isActivo ? null : (
                      <span className="ml-2 rounded bg-[var(--aviso-fondo)] px-1.5 py-0.5 text-xs text-[var(--aviso)]">
                        dado de baja
                      </span>
                    )}
                  </td>
                  <td className="hidden px-3 py-2 text-[var(--suave)] sm:table-cell">
                    {fila.categoria ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {pesos(fila.precioMinor)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {cantidad(fila.stock)} {fila.unidadAbreviatura}
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs text-[var(--suave)] md:table-cell">
                    {fila.codigo ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {fila.isActivo ? (
                      <Boton variante="secundario" className="px-2 py-1 text-xs" onClick={(e) => { e.stopPropagation(); onDesactivar(fila); }}>
                        Desactivar
                      </Boton>
                    ) : (
                      <Boton variante="secundario" className="px-2 py-1 text-xs" onClick={(e) => { e.stopPropagation(); onActivar(fila); }}>
                        Activar
                      </Boton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-end">
        <Boton variante="secundario" onClick={onRecargar}>
          Recargar
        </Boton>
      </div>
    </div>
  );
}
