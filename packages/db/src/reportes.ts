import type { ClienteSql } from './runner';

export interface ResumenVentas { readonly tickets: number; readonly ventasMinor: bigint; readonly descuentosMinor: bigint; readonly utilidadMinor: bigint; }
export interface VentaHistorial { readonly id: string; readonly folio: string; readonly totalMinor: bigint; readonly estado: string; readonly ocurridoAt: string; }

export async function resumenVentas(cliente: ClienteSql, desde: string, hasta: string): Promise<ResumenVentas> {
  const { rows } = await cliente.query<{ tickets: unknown; ventas: unknown; descuentos: unknown; utilidad: unknown }>(
    `SELECT (SELECT count(*) FROM sales s WHERE s.estado='completada' AND s.ocurrido_at >= $1::timestamptz AND s.ocurrido_at < $2::timestamptz) tickets,
            (SELECT COALESCE(sum(total_minor),0) FROM sales s WHERE s.estado='completada' AND s.ocurrido_at >= $1::timestamptz AND s.ocurrido_at < $2::timestamptz) ventas,
            (SELECT COALESCE(sum(descuento_minor),0) FROM sales s WHERE s.estado='completada' AND s.ocurrido_at >= $1::timestamptz AND s.ocurrido_at < $2::timestamptz) descuentos,
            (SELECT COALESCE(sum(l.total_linea_minor - (l.costo_unitario_minor * l.qty_base)::bigint),0)::bigint FROM sale_lines l JOIN sales s ON s.id=l.sale_id WHERE s.estado='completada' AND s.ocurrido_at >= $1::timestamptz AND s.ocurrido_at < $2::timestamptz) utilidad`, [desde, hasta]);
  const r = rows[0] ?? { tickets: 0, ventas: 0, descuentos: 0, utilidad: 0 };
  return { tickets: Number(r.tickets), ventasMinor: BigInt(String(r.ventas)), descuentosMinor: BigInt(String(r.descuentos)), utilidadMinor: BigInt(String(r.utilidad)) };
}

export async function historialVentas(cliente: ClienteSql, desde: string, hasta: string): Promise<VentaHistorial[]> {
  const { rows } = await cliente.query<{ id: string; folio_local: string; total_minor: unknown; estado: string; ocurrido_at: unknown }>(
    `SELECT id, folio_local, total_minor, estado, ocurrido_at FROM sales
      WHERE ocurrido_at >= $1::timestamptz AND ocurrido_at < $2::timestamptz
      ORDER BY ocurrido_at DESC LIMIT 200`, [desde, hasta]);
  return rows.map((r) => ({ id: r.id, folio: r.folio_local, totalMinor: BigInt(String(r.total_minor)), estado: r.estado, ocurridoAt: new Date(String(r.ocurrido_at)).toISOString() }));
}
