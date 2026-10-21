/** Operaciones de inventario. El saldo siempre se deriva de stock_movements. */
import { uuidV7 } from '@papeleria/core';

import { autorizar } from './autorizacion';
import { emitirEvento } from './eventos';
import { exigirObligaciones } from './obligaciones';
import type { ClienteSql, ClienteTransaccional } from './runner';

export class ErrorInventario extends Error {}

export interface ContextoInventario {
  readonly usuarioId: string;
  readonly dispositivoId: string;
  readonly ahora?: number;
}

export interface FilaExistencia {
  readonly productoId: string;
  readonly nombre: string;
  readonly unidad: string;
  readonly stock: string;
  readonly minimo: string;
  readonly costoPromedioMinor: bigint;
  readonly valorMinor: bigint;
  readonly urgencia: 'agotado' | 'bajo' | 'normal';
}

export async function listarExistencias(cliente: ClienteSql): Promise<FilaExistencia[]> {
  const { rows } = await cliente.query<{
    id: string; nombre: string; abreviatura: string; stock: unknown; minimo: unknown;
    costo: unknown;
  }>(`SELECT p.id, p.nombre, u.abreviatura, COALESCE(s.qty_base, 0) AS stock,
              p.stock_minimo AS minimo, p.costo_promedio_minor AS costo
         FROM products p JOIN units u ON u.id = p.unit_id
         LEFT JOIN stock_levels s ON s.product_id = p.id
        WHERE p.deleted_at IS NULL AND p.is_activo AND p.tracks_stock
        ORDER BY CASE WHEN COALESCE(s.qty_base, 0) <= 0 THEN 0
                      WHEN COALESCE(s.qty_base, 0) <= p.stock_minimo THEN 1 ELSE 2 END,
                 p.nombre`);
  return rows.map((r) => {
    const stock = String(r.stock); const minimo = String(r.minimo);
    const cantidad = Number(stock); const minimoNumero = Number(minimo);
    const costo = BigInt(String(r.costo));
    return {
      productoId: r.id, nombre: r.nombre, unidad: r.abreviatura, stock, minimo,
      costoPromedioMinor: costo,
      valorMinor: BigInt(Math.round(cantidad * 1000)) * costo / 1000n,
      urgencia: cantidad <= 0 ? 'agotado' : cantidad <= minimoNumero ? 'bajo' : 'normal',
    };
  });
}

interface MovimientoEntrada { readonly productoId: string; readonly cantidad: number; readonly costoUnitarioMinor: bigint; readonly notas?: string; }

export async function recibirMercancia(
  cliente: ClienteTransaccional, lineas: readonly MovimientoEntrada[], contexto: ContextoInventario,
): Promise<void> {
  if (lineas.length === 0) throw new ErrorInventario('Agrega al menos un producto a la recepción.');
  if (lineas.some((l) => !Number.isFinite(l.cantidad) || l.cantidad <= 0 || l.costoUnitarioMinor < 0n)) {
    throw new ErrorInventario('Cada recepción necesita cantidad positiva y un costo válido.');
  }
  await emitirEvento(cliente, {
    tipo: 'stock.received', dispositivoId: contexto.dispositivoId, usuarioId: contexto.usuarioId,
    ...(contexto.ahora === undefined ? {} : { ahora: () => contexto.ahora! }),
    payload: async (_tx, evento) => ({ lineas: lineas.map((l) => ({ ...l, costoUnitarioMinor: l.costoUnitarioMinor.toString() })), ocurrido_at: evento.occurred_at }),
    autorizar: async (_e, tx) => autorizar(tx, { usuarioId: contexto.usuarioId, dispositivoId: contexto.dispositivoId, permiso: 'stock:ajustar', recurso: { tipo: 'movimiento', valor_stock_afectado_minor: 0 }, ...(contexto.ahora === undefined ? {} : { ahora: contexto.ahora }) }),
    aplicarEstado: async (tx, evento) => {
      for (const linea of lineas) {
        const producto = await tx.query<{ qty: unknown; costo: unknown }>(`SELECT COALESCE(s.qty_base, 0) qty, p.costo_promedio_minor costo FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id WHERE p.id = $1 AND p.tracks_stock`, [linea.productoId]);
        const actual = producto.rows[0]; if (!actual) throw new ErrorInventario('El producto de la recepción no existe o no lleva inventario.');
        const previo = Number(actual.qty); const costoPrevio = BigInt(String(actual.costo));
        const nuevoCosto = Math.round((Number(costoPrevio) * Math.max(previo, 0) + Number(linea.costoUnitarioMinor) * linea.cantidad) / (Math.max(previo, 0) + linea.cantidad));
        await tx.query(`INSERT INTO stock_movements (id, product_id, qty, qty_base, motivo, ref_type, ref_id, costo_unitario_minor, notas, user_id, device_id, ocurrido_at) VALUES ($1,$2,$3,$3,'compra_recepcion','purchase',$4,$5,$6,$7,$8,$9)`, [uuidV7(), linea.productoId, String(linea.cantidad), evento.event_id, linea.costoUnitarioMinor.toString(), linea.notas ?? null, contexto.usuarioId, contexto.dispositivoId, evento.occurred_at]);
        await tx.query('UPDATE products SET costo_promedio_minor = $2, costo_minor = $2, actualizado_at = now() WHERE id = $1', [linea.productoId, String(nuevoCosto)]);
      }
    }, auditoria: { accion: 'stock.received', entidad: 'stock_movements' },
  });
}

export async function ajustarExistencia(
  cliente: ClienteTransaccional, datos: { productoId: string; cantidad: number; motivo: 'ajuste_manual' | 'merma'; notas: string }, contexto: ContextoInventario,
): Promise<void> {
  if (!Number.isFinite(datos.cantidad) || datos.cantidad === 0) throw new ErrorInventario('La diferencia debe ser distinta de cero.');
  if (datos.notas.trim().length < 10) throw new ErrorInventario('Explica el ajuste con al menos 10 caracteres.');
  await emitirEvento(cliente, {
    tipo: 'stock.adjusted', dispositivoId: contexto.dispositivoId, usuarioId: contexto.usuarioId,
    ...(contexto.ahora === undefined ? {} : { ahora: () => contexto.ahora! }),
    payload: async (_tx, e) => ({ ...datos, ocurrido_at: e.occurred_at }),
    autorizar: async (_e, tx) => exigirObligaciones(await autorizar(tx, { usuarioId: contexto.usuarioId, dispositivoId: contexto.dispositivoId, permiso: 'stock:ajustar', recurso: { tipo: 'movimiento', valor_stock_afectado_minor: 0 }, ...(contexto.ahora === undefined ? {} : { ahora: contexto.ahora }) }), { motivo: datos.notas, queFalta: 'El ajuste necesita autorización del dueño.' }),
    aplicarEstado: async (tx, e) => {
      const p = await tx.query<{ costo_promedio_minor: unknown }>('SELECT costo_promedio_minor FROM products WHERE id = $1 AND tracks_stock', [datos.productoId]);
      if (!p.rows[0]) throw new ErrorInventario('El producto no existe o no lleva inventario.');
      await tx.query(`INSERT INTO stock_movements (id,product_id,qty,qty_base,motivo,ref_type,ref_id,costo_unitario_minor,notas,user_id,device_id,ocurrido_at) VALUES ($1,$2,$3,$3,$4,'loss',$5,$6,$7,$8,$9,$10)`, [uuidV7(), datos.productoId, String(datos.cantidad), datos.motivo, e.event_id, String(p.rows[0].costo_promedio_minor), datos.notas.trim(), contexto.usuarioId, contexto.dispositivoId, e.occurred_at]);
    }, auditoria: { accion: 'stock.adjusted', entidad: 'stock_movements', entidadId: datos.productoId },
  });
}

/** Aplica un conteo como diferencia, nunca reemplazando el saldo. */
export async function aplicarConteo(
  cliente: ClienteTransaccional, datos: { productoId: string; contado: number; notas?: string }, contexto: ContextoInventario,
): Promise<void> {
  if (!Number.isFinite(datos.contado) || datos.contado < 0) throw new ErrorInventario('El conteo debe ser cero o mayor.');
  await emitirEvento(cliente, {
    tipo: 'stock.counted', dispositivoId: contexto.dispositivoId, usuarioId: contexto.usuarioId,
    ...(contexto.ahora === undefined ? {} : { ahora: () => contexto.ahora! }),
    payload: async (tx, e) => { const r = await tx.query<{ stock: unknown }>('SELECT COALESCE(qty_base,0) stock FROM stock_levels WHERE product_id=$1', [datos.productoId]); const esperado = Number(r.rows[0]?.stock ?? 0); return { ...datos, esperado, diferencia: datos.contado - esperado, ocurrido_at: e.occurred_at }; },
    autorizar: async (_e, tx) => {
      const saldo = await tx.query<{ stock: unknown }>('SELECT COALESCE(qty_base,0) stock FROM stock_levels WHERE product_id=$1', [datos.productoId]);
      const esperado = Number(saldo.rows[0]?.stock ?? 0);
      const diferenciaPct = esperado === 0 ? (datos.contado === 0 ? 0 : 100) : Math.abs((datos.contado - esperado) / esperado) * 100;
      return exigirObligaciones(await autorizar(tx, { usuarioId: contexto.usuarioId, dispositivoId: contexto.dispositivoId, permiso: 'stock:conteo', recurso: { tipo: 'conteo', diferencia_pct: diferenciaPct, conteo_ya_aplicado: false }, ...(contexto.ahora === undefined ? {} : { ahora: contexto.ahora }) }), { motivo: datos.notas ?? null, queFalta: 'Explica la diferencia encontrada antes de aplicar el conteo.' });
    },
    aplicarEstado: async (tx, e) => { const r = await tx.query<{ costo_promedio_minor: unknown }>('SELECT costo_promedio_minor FROM products WHERE id=$1 AND tracks_stock', [datos.productoId]); if (!r.rows[0]) throw new ErrorInventario('El producto no existe o no lleva inventario.'); const esperado = await tx.query<{ stock: unknown }>('SELECT COALESCE(qty_base,0) stock FROM stock_levels WHERE product_id=$1', [datos.productoId]); const diferencia = datos.contado - Number(esperado.rows[0]?.stock ?? 0); if (diferencia !== 0) await tx.query(`INSERT INTO stock_movements (id,product_id,qty,qty_base,motivo,ref_type,ref_id,costo_unitario_minor,notas,user_id,device_id,ocurrido_at) VALUES ($1,$2,$3,$3,'conteo_fisico','count',$4,$5,$6,$7,$8,$9)`, [uuidV7(), datos.productoId, String(diferencia), e.event_id, String(r.rows[0].costo_promedio_minor), datos.notas ?? null, contexto.usuarioId, contexto.dispositivoId, e.occurred_at]); },
    auditoria: { accion: 'stock.counted', entidad: 'stock_movements', entidadId: datos.productoId },
  });
}
