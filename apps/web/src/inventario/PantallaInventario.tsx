import { useEffect, useState } from 'react';
import {
  ajustarExistencia, aplicarConteo, listarExistencias, recibirMercancia,
  type FilaExistencia, ErrorInventario, ErrorNoAutorizado,
} from '@papeleria/db';
import type { SesionIniciada } from '../auth/pantalla';
import { Aviso, Boton, Entrada, Seleccion, Tarjeta } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import { DialogoStepUp } from '../componentes/StepUp';

function dinero(valor: bigint): string { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(valor) / 100); }
function mensaje(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function PantallaInventario({ base, sesion }: { readonly base: BaseLocal; readonly sesion: SesionIniciada }) {
  const [filas, setFilas] = useState<readonly FilaExistencia[]>([]);
  const [producto, setProducto] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [costo, setCosto] = useState('');
  const [notas, setNotas] = useState('');
  const [modo, setModo] = useState<'recepcion' | 'ajuste' | 'merma' | 'conteo'>('recepcion');
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [stepUp, setStepUp] = useState<{ permiso: string; reintentar: () => Promise<void> } | null>(null);
  const cargar = async () => {
    try { const datos = await listarExistencias(comoClienteTransaccional(base)); setFilas(datos); setProducto((p) => p || datos[0]?.productoId || ''); }
    catch (e) { setError(mensaje(e)); }
  };
  useEffect(() => { void cargar(); }, [base]);

  async function guardar(e?: React.FormEvent): Promise<void> {
    e?.preventDefault(); setError(null); setExito(null);
    const n = Number(cantidad.replace(',', '.'));
    if (!producto || !Number.isFinite(n)) { setError('Elige un producto y escribe una cantidad válida.'); return; }
    setGuardando(true);
    const contexto = { usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id };
    try {
      const cliente = comoClienteTransaccional(base);
      if (modo === 'recepcion') {
        const centavos = Math.round(Number(costo.replace(',', '.')) * 100);
        if (!Number.isInteger(centavos) || centavos < 0) throw new ErrorInventario('Escribe el costo unitario de la mercancía recibida.');
        await recibirMercancia(cliente, [{ productoId: producto, cantidad: n, costoUnitarioMinor: BigInt(centavos), notas }], contexto);
        setExito('Recepción registrada y costo promedio actualizado.');
      } else if (modo === 'conteo') {
        await aplicarConteo(cliente, { productoId: producto, contado: n, notas }, contexto);
        setExito('Conteo aplicado como movimiento de diferencia.');
      } else {
        await ajustarExistencia(cliente, { productoId: producto, cantidad: modo === 'merma' ? -Math.abs(n) : n, motivo: modo === 'merma' ? 'merma' : 'ajuste_manual', notas }, contexto);
        setExito('Movimiento de inventario registrado.');
      }
      await base.sincronizar(); setCantidad(''); setCosto(''); setNotas(''); await cargar();
    } catch (e) {
      if (e instanceof ErrorNoAutorizado && e.obligaciones.includes('step_up')) {
        setStepUp({ permiso: modo === 'conteo' ? 'stock:conteo' : 'stock:ajustar', reintentar: () => guardar() });
      } else setError(mensaje(e));
    } finally { setGuardando(false); }
  }
  const seleccionado = filas.find((f) => f.productoId === producto);
  return <div className="flex flex-col gap-5">
    <div><h1 className="text-xl font-semibold">Inventario</h1><p className="text-sm text-[var(--suave)]">Existencias ordenadas por urgencia. Cada cambio queda en el historial.</p></div>
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <Tarjeta className="overflow-hidden"><div className="border-b border-[var(--linea)] bg-[var(--fondo)] px-4 py-3 text-sm"><strong>Compras sugeridas:</strong> cantidad necesaria para volver al stock máximo configurado.</div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-[var(--linea)] text-left text-[var(--suave)]"><tr><th className="px-4 py-3">Producto</th><th className="px-3 py-3">Existencia</th><th className="px-3 py-3">Mínimo</th><th className="px-3 py-3">Comprar</th><th className="px-4 py-3 text-right">Valor</th></tr></thead><tbody>{filas.map((f) => <tr key={f.productoId} className="border-b border-[var(--linea)] last:border-0"><td className="px-4 py-3 font-medium">{f.urgencia !== 'normal' && <span className="mr-2 text-[var(--mal)]">●</span>}{f.nombre}</td><td className="px-3 py-3">{f.stock} {f.unidad}</td><td className="px-3 py-3 text-[var(--suave)]">{f.minimo}</td><td className={`px-3 py-3 font-semibold ${f.comprar !== '0' ? 'text-[var(--mal)]' : 'text-[var(--suave)]'}`}>{f.comprar} {f.unidad}</td><td className="px-4 py-3 text-right">{dinero(f.valorMinor)}</td></tr>)}</tbody></table></div></Tarjeta>
      <Tarjeta className="p-4"><h2 className="font-semibold">Registrar movimiento</h2><form className="mt-3 flex flex-col gap-3" onSubmit={(e) => void guardar(e)}><Seleccion value={modo} onChange={(e) => setModo(e.target.value as typeof modo)} disabled={guardando}><option value="recepcion">Recibir mercancía</option><option value="conteo">Aplicar conteo físico</option><option value="ajuste">Ajuste manual</option><option value="merma">Merma</option></Seleccion><Seleccion value={producto} onChange={(e) => setProducto(e.target.value)} disabled={guardando}>{filas.map((f) => <option key={f.productoId} value={f.productoId}>{f.nombre}</option>)}</Seleccion>{seleccionado && <p className="text-xs text-[var(--suave)]">Saldo actual: {seleccionado.stock} {seleccionado.unidad}</p>}<Entrada value={cantidad} onChange={(e) => setCantidad(e.target.value)} inputMode="decimal" placeholder={modo === 'conteo' ? 'Cantidad contada' : 'Cantidad'} disabled={guardando}/>{modo === 'recepcion' && <Entrada value={costo} onChange={(e) => setCosto(e.target.value)} inputMode="decimal" placeholder="Costo unitario, ej. 12.50" disabled={guardando}/>}<Entrada value={notas} onChange={(e) => setNotas(e.target.value)} placeholder={modo === 'conteo' ? 'Nota si hay diferencia' : modo === 'recepcion' ? 'Proveedor o factura (opcional)' : 'Motivo detallado, mínimo 10 caracteres'} disabled={guardando}/><Boton type="submit" disabled={guardando || filas.length === 0}>{guardando ? 'Guardando…' : 'Guardar movimiento'}</Boton></form>{error && <Aviso tono="mal" className="mt-3">{error}</Aviso>}{exito && <Aviso tono="ok" className="mt-3">{exito}</Aviso>}</Tarjeta>
    </div>{stepUp && <DialogoStepUp base={base} sesion={sesion} permiso={stepUp.permiso} descripcion="Registrar este movimiento de inventario" entidadId={producto} onCancelar={() => setStepUp(null)} onAutorizado={async () => { const accion = stepUp.reintentar; setStepUp(null); await accion(); }} />}</div>;
}
