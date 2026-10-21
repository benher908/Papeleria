/**
 * Gestión de categorías y proveedores (F1.1b).
 *
 * Pantalla simple de alta y lista. No son datos del negocio en sentido estricto
 * (no tienen emitirEvento) — son el catálogo de apoyo que el formulario de
 * producto necesita. Se accede desde la pestaña Productos.
 */

import { useEffect, useState } from 'react';
import {
  crearCategoria,
  crearProveedor,
  actualizarProveedor,
  actualizarUnidad,
  crearUnidad,
  listarCategorias,
  listarProveedores,
  listarUnidades,
  ErrorProducto,
} from '@papeleria/db';
import { Aviso, Boton, Entrada, Tarjeta } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import type { SesionIniciada } from '../auth/pantalla';

export interface PropsGestion {
  readonly base: BaseLocal;
  readonly sesion: SesionIniciada;
  /** Avisa a la app para que recargue categorías/unidades y el formulario las vea. */
  readonly onCambio?: () => void;
}

interface Categoria { id: string; nombre: string; }
interface Proveedor { id: string; nombre: string; telefono: string | null; notas: string | null; }

type Seccion = 'categorias' | 'proveedores' | 'unidades';

function mensajeDe(causa: unknown): string {
  if (causa instanceof ErrorProducto) return causa.message;
  return `Error: ${causa instanceof Error ? causa.message : String(causa)}`;
}

export function PantallaGestion({ base, sesion, onCambio }: PropsGestion) {
  const [seccion, setSeccion] = useState<Seccion>('categorias');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(['categorias', 'proveedores', 'unidades'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSeccion(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              seccion === s
                ? 'bg-[var(--acento)] text-white'
                : 'bg-[var(--fondo)] text-[var(--suave)] hover:text-[var(--texto)]'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {seccion === 'categorias' ? (
        <GestionCategorias base={base} sesion={sesion} onCambio={onCambio} />
      ) : seccion === 'proveedores' ? (
        <GestionProveedores base={base} sesion={sesion} onCambio={onCambio} />
      ) : <GestionUnidades base={base} sesion={sesion} onCambio={onCambio} />}
    </div>
  );
}

function GestionUnidades({ base, sesion, onCambio }: PropsGestion) {
  const [unidades, setUnidades] = useState<Array<{ id: string; nombre: string; abreviatura: string }>>([]);
  const [nombre, setNombre] = useState(''); const [abreviatura, setAbreviatura] = useState('');
  const [editando, setEditando] = useState<{ id: string; nombre: string; abreviatura: string } | null>(null);
  const [error, setError] = useState<string | null>(null); const [guardando, setGuardando] = useState(false);
  const cargar = async () => { try { setUnidades(await listarUnidades(comoClienteTransaccional(base))); } catch (e) { setError(mensajeDe(e)); } };
  useEffect(() => { void cargar(); }, [base]);
  async function guardar(): Promise<void> {
    setError(null); setGuardando(true);
    try { const cliente = comoClienteTransaccional(base); const contexto = { usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id };
      if (editando) await actualizarUnidad(cliente, editando.id, { nombre, abreviatura }, contexto); else await crearUnidad(cliente, { nombre, abreviatura }, contexto);
      await base.sincronizar(); await cargar(); onCambio?.(); setNombre(''); setAbreviatura(''); setEditando(null);
    } catch (e) { setError(mensajeDe(e)); } finally { setGuardando(false); }
  }
  return <div className="grid gap-4 lg:grid-cols-2"><Tarjeta className="p-4"><h2 className="text-base font-semibold">{editando ? 'Editar unidad' : 'Nueva unidad'}</h2><form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void guardar(); }}><Entrada value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Paquete" disabled={guardando}/><Entrada value={abreviatura} onChange={(e) => setAbreviatura(e.target.value)} placeholder="paq" disabled={guardando}/><div className="flex gap-2"><Boton type="submit" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Boton>{editando && <Boton variante="secundario" onClick={() => { setEditando(null); setNombre(''); setAbreviatura(''); }}>Cancelar</Boton>}</div></form>{error && <Aviso tono="mal" className="mt-3">{error}</Aviso>}</Tarjeta><Tarjeta className="p-4"><h2 className="text-base font-semibold">Unidades ({unidades.length})</h2><ul className="mt-2 divide-y divide-[var(--linea)]">{unidades.map((u) => <li key={u.id} className="flex items-center justify-between py-2 text-sm"><span>{u.nombre} <span className="text-[var(--suave)]">({u.abreviatura})</span></span><Boton variante="secundario" className="px-2.5 py-1.5 text-xs" onClick={() => { setEditando(u); setNombre(u.nombre); setAbreviatura(u.abreviatura); }}>Editar</Boton></li>)}</ul></Tarjeta></div>;
}

function GestionCategorias({ base, sesion, onCambio }: PropsGestion) {
  const [categorias, setCategorias] = useState<readonly Categoria[]>([]);
  const [nombre, setNombre] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);

  const contexto = { usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id };

  useEffect(() => {
    void (async () => {
      try {
        const cs = await listarCategorias(comoClienteTransaccional(base));
        setCategorias(cs);
      } catch (causa) {
        setError(mensajeDe(causa));
      }
    })();
  }, [base]);

  async function guardar(): Promise<void> {
    if (nombre.trim() === '') { setError('Escribe el nombre de la categoría.'); return; }
    setGuardando(true); setError(null); setExito(null);
    try {
      await crearCategoria(comoClienteTransaccional(base), { nombre }, contexto);
      await base.sincronizar();
      const cs = await listarCategorias(comoClienteTransaccional(base));
      setCategorias(cs);
      setNombre('');
      setExito(`Categoría «${nombre.trim()}» creada.`);
      onCambio?.();
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Tarjeta className="p-4">
        <h2 className="text-base font-semibold">Nueva categoría</h2>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void guardar(); }}
        >
          <Entrada
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Manualidades"
            autoComplete="off"
            className="flex-1"
            disabled={guardando}
          />
          <Boton type="submit" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Agregar'}
          </Boton>
        </form>
        {error && <Aviso tono="mal" className="mt-3">{error}</Aviso>}
        {exito && <Aviso tono="ok" className="mt-3">{exito}</Aviso>}
      </Tarjeta>

      <Tarjeta className="p-4">
        <h2 className="text-base font-semibold">Categorías ({categorias.length})</h2>
        {categorias.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--suave)]">No hay categorías aún.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--linea)]">
            {categorias.map((cat) => (
              <li key={cat.id} className="py-2 text-sm">{cat.nombre}</li>
            ))}
          </ul>
        )}
      </Tarjeta>
    </div>
  );
}

function GestionProveedores({ base, sesion, onCambio }: PropsGestion) {
  const [proveedores, setProveedores] = useState<readonly Proveedor[]>([]);
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [editando, setEditando] = useState<Proveedor | null>(null);

  const contexto = { usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id };

  const cargar = async () => {
    try {
      const ps = await listarProveedores(comoClienteTransaccional(base));
      setProveedores(ps);
    } catch (causa) {
      setError(mensajeDe(causa));
    }
  };

  useEffect(() => { void cargar(); }, [base]);

  async function guardar(): Promise<void> {
    if (nombre.trim() === '') { setError('Escribe el nombre del proveedor.'); return; }
    setGuardando(true); setError(null); setExito(null);
    try {
      if (editando !== null) {
        await actualizarProveedor(
          comoClienteTransaccional(base), editando.id,
          { nombre, telefono: telefono || null }, contexto
        );
        setExito(`Proveedor «${nombre.trim()}» actualizado.`);
        setEditando(null);
      } else {
        await crearProveedor(
          comoClienteTransaccional(base),
          { nombre, telefono: telefono || null }, contexto
        );
        setExito(`Proveedor «${nombre.trim()}» agregado.`);
      }
      await base.sincronizar();
      await cargar();
      onCambio?.();
      setNombre(''); setTelefono('');
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setGuardando(false);
    }
  }

  function iniciarEdicion(p: Proveedor): void {
    setEditando(p); setNombre(p.nombre); setTelefono(p.telefono ?? ''); setError(null); setExito(null);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Tarjeta className="p-4">
        <h2 className="text-base font-semibold">
          {editando !== null ? `Editando: ${editando.nombre}` : 'Nuevo proveedor'}
        </h2>
        <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
          <Entrada
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Distribuidora Pérez"
            autoComplete="off"
            disabled={guardando}
          />
          <Entrada
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            placeholder="Teléfono (opcional)"
            autoComplete="off"
            disabled={guardando}
          />
          <div className="flex gap-2">
            <Boton type="submit" disabled={guardando} className="flex-1">
              {guardando ? 'Guardando…' : editando !== null ? 'Guardar cambios' : 'Agregar'}
            </Boton>
            {editando !== null && (
              <Boton variante="secundario" onClick={() => { setEditando(null); setNombre(''); setTelefono(''); }} disabled={guardando}>
                Cancelar
              </Boton>
            )}
          </div>
        </form>
        {error && <Aviso tono="mal" className="mt-3">{error}</Aviso>}
        {exito && <Aviso tono="ok" className="mt-3">{exito}</Aviso>}
      </Tarjeta>

      <Tarjeta className="p-4">
        <h2 className="text-base font-semibold">Proveedores ({proveedores.length})</h2>
        {proveedores.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--suave)]">No hay proveedores registrados.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--linea)]">
            {proveedores.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.nombre}</p>
                  {p.telefono && <p className="text-xs text-[var(--suave)]">{p.telefono}</p>}
                </div>
                <Boton variante="secundario" className="px-2.5 py-1.5 text-xs" onClick={() => iniciarEdicion(p)}>
                  Editar
                </Boton>
              </li>
            ))}
          </ul>
        )}
      </Tarjeta>
    </div>
  );
}
