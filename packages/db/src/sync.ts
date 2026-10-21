import { uuidV7 } from '@papeleria/core';
import type { ClienteSql } from './runner';

export interface EventoRemoto {
  readonly event_id: string;
  readonly device_id: string;
  readonly device_seq: number;
  readonly user_id?: string;
  readonly type: string;
  readonly payload: Record<string, any>;
  readonly occurred_at?: string;
  readonly hlc?: string;
  readonly schema_version?: number;
}

/** Aplica un hecho remoto a la réplica local. Se llama dentro de una transacción. */
export async function aplicarEventoRemoto(tx: ClienteSql, evento: EventoRemoto): Promise<void> {
  await asegurarIdentidadesRemotas(tx, evento);
  const p = evento.payload;
  switch (evento.type) {
    case 'category.created':
      await tx.query(
        `INSERT INTO categories (id,parent_id,nombre,path) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`, [p.id,p.parent_id,p.nombre,p.path],
      );
      return;
    case 'supplier.created':
      await tx.query(
        `INSERT INTO suppliers (id,nombre,telefono,notas) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`, [p.id,p.nombre,p.telefono,p.notas],
      );
      return;
    case 'supplier.updated':
      await tx.query('UPDATE suppliers SET nombre=$2,telefono=$3,notas=$4 WHERE id=$1',
        [p.id,p.despues.nombre,p.despues.telefono,p.despues.notas]);
      return;
    case 'unit.created':
      await tx.query(
        `INSERT INTO units (id,nombre,abreviatura) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO NOTHING`, [p.id,p.nombre,p.abreviatura],
      );
      return;
    case 'unit.updated':
      await tx.query('UPDATE units SET nombre=$2,abreviatura=$3 WHERE id=$1',
        [p.id,p.despues.nombre,p.despues.abreviatura]);
      return;
    case 'product.created': {
      const producto = p.producto;
      const supplierId = await referenciaExiste(tx, 'suppliers', producto.supplier_id)
        ? producto.supplier_id : null;
      const categoryId = await referenciaExiste(tx, 'categories', producto.category_id)
        ? producto.category_id : null;
      const unitId = await referenciaExiste(tx, 'units', producto.unit_id)
        ? producto.unit_id : '01900000-0000-7000-8002-000000000001';
      await tx.query(
        `INSERT INTO products (id, sku, nombre, descripcion, category_id, supplier_id, unit_id,
          tax_rate_id, precio_minor, costo_minor, tracks_stock, stock_minimo, stock_maximo,
          ubicacion, permite_venta_fraccion, is_activo, notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [producto.id, producto.sku, producto.nombre, producto.descripcion, categoryId,
          supplierId, unitId, producto.tax_rate_id,
          producto.precio_minor, producto.costo_minor, producto.tracks_stock, producto.stock_minimo,
          producto.stock_maximo, producto.ubicacion, producto.permite_venta_fraccion,
          producto.is_activo, producto.notas],
      );
      await tx.query(
        `INSERT INTO product_presentations (id,product_id,unit_id,nombre,factor,precio_minor,is_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [p.presentacion.id, producto.id, unitId, p.presentacion.nombre,
          p.presentacion.factor, p.presentacion.precio_minor, p.presentacion.is_base],
      );
      for (const c of p.codigos ?? []) {
        await tx.query(
          `INSERT INTO product_barcodes (id,product_id,presentacion_id,codigo,simbologia,es_primario,es_interno)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [c.id, producto.id, c.presentacion_id, c.codigo, c.simbologia, c.es_primario, c.es_interno],
        );
      }
      return;
    }
    case 'product.updated': {
      const categoryId = await referenciaExiste(tx, 'categories', p.despues.category_id)
        ? p.despues.category_id : null;
      const supplierId = await referenciaExiste(tx, 'suppliers', p.despues.supplier_id)
        ? p.despues.supplier_id : null;
      await tx.query(
        `UPDATE products SET nombre=$2, precio_minor=$3, costo_minor=$4, category_id=$5,
          supplier_id=$6, stock_minimo=$7, stock_maximo=$8, ubicacion=$9, is_activo=$10,
          notas=$11, actualizado_at=now() WHERE id=$1`,
        [p.id, p.despues.nombre, p.despues.precio_minor, p.despues.costo_minor,
          categoryId, supplierId, p.despues.stock_minimo,
          p.despues.stock_maximo, p.despues.ubicacion, p.despues.is_activo, p.despues.notas],
      );
      return;
    }
    case 'cash_session.opened':
      await tx.query(
        `INSERT INTO cash_sessions (id,terminal_id,user_id,abierta_at,fondo_inicial_minor)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [p.turno_id,p.terminal_id,p.user_id,p.abierta_at,p.fondo_inicial_minor],
      );
      return;
    case 'cash_session.closed':
      await tx.query(
        `UPDATE cash_sessions SET cerrada_at=$2, esperado_efectivo_minor=$3,
          contado_efectivo_minor=$4, notas_cierre=$5 WHERE id=$1 AND cerrada_at IS NULL`,
        [p.turno_id,p.cerrada_at,p.esperado_efectivo_minor,p.contado_efectivo_minor,p.notas_cierre],
      );
      return;
    case 'cash_movement.created':
      await tx.query(
        `INSERT INTO cash_movements (id,cash_session_id,tipo,monto_minor,concepto,user_id,ocurrido_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [p.movimiento_id,p.turno_id,p.tipo,p.monto_minor,p.concepto,p.user_id,p.ocurrido_at],
      );
      return;
    case 'stock.received':
      for (const linea of p.lineas) {
        const previo = await tx.query<{ qty: string; costo: string }>(
          `SELECT COALESCE(s.qty_base,0)::text qty, p.costo_promedio_minor::text costo
             FROM products p LEFT JOIN stock_levels s ON s.product_id=p.id WHERE p.id=$1`,
          [linea.productoId],
        );
        if (!previo.rows[0]) throw new Error('No se encontró un producto de la recepción sincronizada.');
        const qty = Number(previo.rows[0].qty), recibida = Number(linea.cantidad);
        const costo = Math.round((Number(previo.rows[0].costo) * Math.max(qty, 0) +
          Number(linea.costoUnitarioMinor) * recibida) / (Math.max(qty, 0) + recibida));
        await tx.query(
          `INSERT INTO stock_movements (id,product_id,qty,qty_base,motivo,ref_type,ref_id,
            costo_unitario_minor,notas,user_id,device_id,ocurrido_at)
           VALUES ($1,$2,$3,$3,'compra_recepcion','purchase',$4,$5,$6,$7,$8,$9)`,
          [uuidV7(),linea.productoId,String(recibida),uuidV7(),String(linea.costoUnitarioMinor),
            linea.notas ?? null,evento.user_id,evento.device_id,p.ocurrido_at],
        );
        await tx.query('UPDATE products SET costo_minor=$2,costo_promedio_minor=$2 WHERE id=$1',
          [linea.productoId,String(costo)]);
      }
      return;
    case 'stock.adjusted':
      await insertarMovimiento(tx, evento, p.productoId, Number(p.cantidad), p.motivo, p.notas);
      return;
    case 'stock.counted':
      if (Number(p.diferencia) !== 0) await insertarMovimiento(tx, evento, p.productoId,
        Number(p.diferencia), 'conteo_fisico', p.notas ?? null);
      return;
    case 'sale.created': {
      const venta = p;
      await tx.query(
        `INSERT INTO sales (id,folio_local,cash_session_id,terminal_id,user_id,cliente_nombre,
          subtotal_minor,descuento_minor,impuesto_minor,total_minor,estado,idempotency_key,
          device_id,evento_id,ocurrido_at,notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completada',$11,$4,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [venta.venta_id,venta.folio_local,venta.turno_id,venta.terminal_id,venta.user_id,
          venta.cliente_nombre,venta.subtotal_minor,venta.descuento_minor,venta.impuesto_minor,
          venta.total_minor,evento.event_id,evento.event_id,venta.ocurrido_at,venta.notas],
      );
      for (const l of venta.lineas) {
        await tx.query(
          `INSERT INTO sale_lines (id,sale_id,linea_no,product_id,presentacion_id,descripcion,qty,
            qty_base,precio_unitario_minor,descuento_minor,impuesto_minor,total_linea_minor,
            costo_unitario_minor,tax_rate_id,es_venta_libre)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (sale_id,linea_no) DO NOTHING`,
          [uuidV7(),venta.venta_id,l.linea_no,l.producto_id,l.presentacion_id,l.descripcion,l.qty,
            l.qty_base,l.precio_unitario_minor,l.descuento_minor,l.impuesto_minor,l.total_linea_minor,
            l.costo_unitario_minor,l.tax_rate_id,l.es_venta_libre],
        );
        if (l.tracks_stock && !l.es_venta_libre) await insertarMovimiento(tx, evento,
          l.producto_id,-Number(l.qty_base),'venta',`Venta ${venta.folio_local}`,venta.venta_id,
          l.presentacion_id,l.costo_unitario_minor);
      }
      for (const pago of venta.pagos) await tx.query(
        `INSERT INTO payments (id,sale_id,metodo,monto_minor,cambio_minor,referencia,ocurrido_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidV7(),venta.venta_id,pago.metodo,pago.monto_minor,pago.cambio_minor,pago.referencia,venta.ocurrido_at],
      );
      return;
    }
    case 'sale.cancelled': {
      const filas = await tx.query<{ product_id: string; presentacion_id: string | null;
        qty: string; qty_base: string; costo_unitario_minor: string }>(
        'SELECT product_id,presentacion_id,qty,qty_base,costo_unitario_minor FROM sale_lines WHERE sale_id=$1',
        [p.venta_id],
      );
      await tx.query(`UPDATE sales SET estado='cancelada',cancelada_at=$2,cancelada_por=$3,
        motivo_cancelacion=$4 WHERE id=$1 AND estado='completada'`,
        [p.venta_id,p.cancelada_at,evento.user_id,p.motivo]);
      for (const l of filas.rows) await insertarMovimiento(tx, evento, l.product_id,
        Number(l.qty_base),'error_captura',`Cancelación de la venta ${p.folio_local}`,
        p.venta_id,l.presentacion_id,l.costo_unitario_minor);
      return;
    }
    default:
      throw new Error(`Tipo de evento remoto no soportado: ${evento.type}`);
  }
}

async function asegurarIdentidadesRemotas(tx: ClienteSql, e: EventoRemoto): Promise<void> {
  if (e.user_id) await tx.query(
    `INSERT INTO users (id,username,nombre,is_activo) VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`,
    [e.user_id,`remoto_${e.user_id.replaceAll('-','')}`,`Usuario de ${e.device_id.slice(0,8)}`],
  );
  await tx.query(
    `INSERT INTO devices (id,nombre,tipo,is_trusted) VALUES ($1,$2,'terminal',false) ON CONFLICT (id) DO NOTHING`,
    [e.device_id,`Dispositivo sincronizado ${e.device_id.slice(0,8)}`],
  );
}

async function referenciaExiste(
  tx: ClienteSql, tabla: 'categories' | 'suppliers' | 'units', id: string | null,
): Promise<boolean> {
  if (!id) return false;
  const filas = await tx.query(`SELECT id FROM ${tabla} WHERE id=$1`, [id]);
  return filas.rows.length > 0;
}

async function insertarMovimiento(
  tx: ClienteSql, e: EventoRemoto, productId: string, qty: number, motivo: string,
  notas: string | null, refId = uuidV7(), presentacionId: string | null = null, costo = '0',
): Promise<void> {
  if (!qty) return;
  const costoFila = costo === '0' ? (await tx.query<{ costo: string }>(
    'SELECT costo_promedio_minor::text costo FROM products WHERE id=$1',[productId],
  )).rows[0]?.costo ?? '0' : String(costo);
  await tx.query(
    `INSERT INTO stock_movements (id,product_id,presentacion_id,qty,qty_base,motivo,ref_type,
      ref_id,costo_unitario_minor,notas,user_id,device_id,ocurrido_at)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [uuidV7(),productId,presentacionId,String(qty),motivo,
      motivo === 'venta' || motivo === 'error_captura' ? 'sale' : motivo === 'compra_recepcion' ? 'purchase' : 'loss',
      refId,costoFila,notas,e.user_id,e.device_id,e.payload.ocurrido_at ?? e.occurred_at ?? new Date().toISOString()],
  );
}
