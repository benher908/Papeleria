/**
 * La pantalla de la app (F1.1 y F2).
 *
 * Monta React dentro de la sesión que ya existía: la barra y el formulario de entrada
 * siguen en DOM a mano porque están verificados y no hacen falta aquí. Este árbol es
 * el que crece: el POS primero, después el catálogo, y más adelante los conteos y las
 * etiquetas.
 *
 * ── Decisiones que se ven en el código ────────────────────────────────────────
 *
 * **No hay caché de consultas.** La «red» es PGlite en el mismo hilo: leer 200 filas
 * cuesta menos que coordinar una caché, y una caché que se desincroniza con la base
 * local daría justo el problema que este sistema evita (dos verdades). Cuando exista
 * el servidor y la sincronización, la caché se pone donde tiene sentido: sobre la
 * consulta remota, no sobre la local.
 *
 * **La búsqueda espera 120 ms.** No es por la base: es para no lanzar una consulta por
 * cada tecla mientras alguien escribe «cuaderno». `listarProductos` ya resuelve nombre,
 * SKU y código.
 *
 * **El diagnóstico no se desmonta al cambiar de pestaña.** El panel escucha la cola de
 * escaneos y lleva la cuenta de la sesión; desmontarlo y volver a montarlo perdería esa
 * cuenta y duplicaría suscripciones. Se esconde con `hidden`.
 */

import { useEffect, useRef, useState } from 'react';

import {
  actualizarProducto,
  crearProducto,
  ErrorNoAutorizado,
  ErrorProducto,
  listarCategorias,
  listarProductos,
  listarUnidades,
  type FilaProducto,
} from '@papeleria/db';
import { ErrorDinero } from '@papeleria/core';

import type { SesionIniciada } from '../auth/pantalla';
import { Aviso, Boton, cx } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import { montarPanel } from '../diagnostico/panel';
import type { ColaEscaneo } from '../escaneo/cola';
import { PantallaVenta } from '../pos/PantallaVenta';
import { Formulario, type OpcionCatalogo, type ValoresFormulario } from './Formulario';
import { pesos } from './formato';
import { Lista } from './Lista';

export interface PropsApp {
  readonly base: BaseLocal;
  readonly sesion: SesionIniciada;
  readonly cola: ColaEscaneo;
}

type Vista = { readonly tipo: 'lista' } | { readonly tipo: 'nuevo' } | { readonly tipo: 'editar'; readonly fila: FilaProducto };
type Pestana = 'vender' | 'productos' | 'diagnostico';

interface Exito {
  readonly texto: string;
  readonly codigo: string | null;
}

function mensajeDe(causa: unknown): string {
  if (
    causa instanceof ErrorProducto ||
    causa instanceof ErrorNoAutorizado ||
    causa instanceof ErrorDinero
  ) {
    return causa.message;
  }
  return `No se pudo guardar (${causa instanceof Error ? causa.message : String(causa)}).`;
}

export function AppProductos({ base, sesion, cola }: PropsApp) {
  const [pestana, setPestana] = useState<Pestana>('vender');
  const [vista, setVista] = useState<Vista>({ tipo: 'lista' });

  const [filtro, setFiltro] = useState('');
  const [filas, setFilas] = useState<readonly FilaProducto[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [categorias, setCategorias] = useState<readonly OpcionCatalogo[]>([]);
  const [unidades, setUnidades] = useState<readonly OpcionCatalogo[]>([]);
  const [errorCatalogo, setErrorCatalogo] = useState<string | null>(null);

  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [exito, setExito] = useState<Exito | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // ── catálogo de apoyo (categorías y unidades) ──────────────────────────────
  useEffect(() => {
    let vigente = true;

    void (async () => {
      try {
        const cliente = comoClienteTransaccional(base);
        const [cs, us] = await Promise.all([listarCategorias(cliente), listarUnidades(cliente)]);
        if (!vigente) return;
        setCategorias(cs);
        setUnidades(us);
      } catch (causa) {
        if (vigente) setErrorCatalogo(mensajeDe(causa));
      }
    })();

    return () => {
      vigente = false;
    };
  }, [base]);

  // ── lista, con una pausa corta para no consultar por cada tecla ───────────
  useEffect(() => {
    let vigente = true;
    const temporizador = window.setTimeout(() => {
      void (async () => {
        try {
          const resultado = await listarProductos(comoClienteTransaccional(base), filtro);
          if (!vigente) return;
          setFilas(resultado);
          setErrorLista(null);
        } catch (causa) {
          if (!vigente) return;
          setFilas([]);
          setErrorLista(mensajeDe(causa));
        }
      })();
    }, 120);

    return () => {
      vigente = false;
      window.clearTimeout(temporizador);
    };
  }, [base, filtro, version]);

  // ── el panel de diagnóstico, montado una sola vez ──────────────────────────
  useEffect(() => {
    const nodo = panelRef.current;
    if (nodo === null) return;
    void montarPanel(nodo, cola);
  }, [cola]);

  // Al volver a Productos se relee la lista: una venta en el POS cambió el stock y la
  // lista se quedó montada mientras tanto. No hay caché que invalidar; se vuelve a
  // preguntar a la base, que es barata.
  useEffect(() => {
    if (pestana === 'productos') setVersion((n) => n + 1);
  }, [pestana]);

  async function guardar(valores: ValoresFormulario): Promise<void> {
    setGuardando(true);
    setErrorForm(null);

    const contexto = {
      usuarioId: sesion.usuario.id,
      dispositivoId: sesion.dispositivo.id,
    };

    try {
      const cliente = comoClienteTransaccional(base);

      if (vista.tipo === 'editar') {
        await actualizarProducto(
          cliente,
          vista.fila.id,
          {
            nombre: valores.nombre,
            precioMinor: valores.precioMinor,
            costoMinor: valores.costoMinor,
            categoryId: valores.categoryId,
            stockMinimo: valores.stockMinimo,
            ubicacion: valores.ubicacion,
          },
          contexto,
        );
        await base.sincronizar();
        setExito({ texto: `«${valores.nombre}» actualizado.`, codigo: null });
      } else {
        const creado = await crearProducto(
          cliente,
          {
            nombre: valores.nombre,
            unitId: valores.unitId,
            precioMinor: valores.precioMinor,
            costoMinor: valores.costoMinor,
            categoryId: valores.categoryId,
            sku: valores.sku === '' ? null : valores.sku,
            stockMinimo: valores.stockMinimo,
            ubicacion: valores.ubicacion,
            codigos: valores.codigos,
          },
          contexto,
        );
        await base.sincronizar();
        setExito({
          texto: `«${valores.nombre}» guardado.`,
          codigo: creado.codigos[0] ?? null,
        });
      }

      setVista({ tipo: 'lista' });
      setVersion((n) => n + 1);
    } catch (causa) {
      setErrorForm(mensajeDe(causa));
    } finally {
      setGuardando(false);
    }
  }

  function abrirNuevo(): void {
    setErrorForm(null);
    setExito(null);
    setVista({ tipo: 'nuevo' });
  }

  function abrirEditar(fila: FilaProducto): void {
    setErrorForm(null);
    setExito(null);
    setVista({ tipo: 'editar', fila });
  }

  function volver(): void {
    setErrorForm(null);
    setVista({ tipo: 'lista' });
  }

  const titulo =
    vista.tipo === 'nuevo'
      ? 'Nuevo producto'
      : vista.tipo === 'editar'
        ? 'Editar producto'
        : null;

  return (
    <>
      <div className="mx-auto max-w-6xl px-5 pt-4">
        <nav className="flex gap-1 border-b border-[var(--linea)]" aria-label="Secciones">
          {(
            [
              ['vender', 'Vender'],
              ['productos', 'Productos'],
              ['diagnostico', 'Diagnóstico'],
            ] as const
          ).map(([clave, texto]) => (
            <button
              key={clave}
              type="button"
              onClick={() => setPestana(clave)}
              className={cx(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
                pestana === clave
                  ? 'border-[var(--acento)] text-[var(--texto)]'
                  : 'border-transparent text-[var(--suave)] hover:text-[var(--texto)]',
              )}
            >
              {texto}
            </button>
          ))}
        </nav>
      </div>

      {/* El panel se queda montado: sólo se esconde. */}
      <div hidden={pestana !== 'diagnostico'}>
        <div ref={panelRef} />
      </div>

      {/* El POS también se queda montado: cambiar de pestaña no puede vaciar un
          carrito a medio armar ni perder el turno que se acaba de abrir. */}
      <div hidden={pestana !== 'vender'} className="mx-auto max-w-6xl px-5 py-6">
        <PantallaVenta base={base} sesion={sesion} cola={cola} />
      </div>

      <div hidden={pestana !== 'productos'} className="mx-auto max-w-5xl px-5 py-6">
        {errorCatalogo === null ? null : (
          <Aviso tono="mal" className="mb-4">
            No se pudieron leer las categorías ni las unidades: {errorCatalogo}
          </Aviso>
        )}

        {exito === null ? null : (
          <Aviso tono="ok" className="mb-4">
            {exito.texto}
            {exito.codigo === null ? null : (
              <>
                {' '}
                Código interno: <strong className="font-mono">{exito.codigo}</strong>
              </>
            )}
          </Aviso>
        )}

        {vista.tipo === 'lista' ? (
          <Lista
            filas={filas}
            filtro={filtro}
            onFiltro={setFiltro}
            onNuevo={abrirNuevo}
            onEditar={abrirEditar}
            onRecargar={() => setVersion((n) => n + 1)}
            error={errorLista}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{titulo}</h2>
                <p className="text-sm text-[var(--suave)]">
                  {vista.tipo === 'nuevo'
                    ? 'Lo mínimo es el nombre y el precio. La unidad ya viene en pieza.'
                    : `Costo actual: ${pesos(vista.fila.costoMinor)} · código ${
                        vista.fila.codigo ?? '—'
                      }`}
                </p>
              </div>
              <Boton variante="secundario" onClick={volver} disabled={guardando}>
                Volver a la lista
              </Boton>
            </div>

            <section className="rounded-xl border border-[var(--linea)] bg-[var(--tarjeta)] p-4 sm:p-6">
              <Formulario
                categorias={categorias}
                unidades={unidades}
                {...(vista.tipo === 'editar' ? { inicial: vista.fila } : {})}
                guardando={guardando}
                error={errorForm}
                onGuardar={(valores) => void guardar(valores)}
                onCancelar={volver}
              />
            </section>
          </div>
        )}
      </div>
    </>
  );
}
