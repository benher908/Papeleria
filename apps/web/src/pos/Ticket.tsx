/**
 * EL TICKET DE 58 mm (F2.5).
 *
 * Se dibuja en pantalla y se manda a la impresora con `window.print()`. No hay
 * librería de reportería ni PDF: el navegador ya sabe imprimir, y una impresora
 * térmica de 58 mm aparece como una impresora más del sistema.
 *
 * ─── POR QUÉ TODO VA EN `mm` Y `monospace` ──────────────────────────────────
 *
 * El papel térmico no perdona: 32 caracteres por línea, sin márgenes. Si se usa
 * una fuente proporcional, las columnas de importes se desalinean y el ticket se
 * ve sucio. La hoja de impresión oculta el resto de la aplicación y deja sólo este
 * bloque, con ancho físico de 58 mm para que el navegador no lo escale.
 *
 * El IVA se muestra desglosado porque el precio de lista ya lo incluye: el cliente
 * ve el total que paga y, debajo, cuánto de eso es impuesto. Es la misma aritmética
 * de `@papeleria/core`, que garantiza `base + iva === total`.
 */

import type { CierreDeTurno, ResumenTurno, VentaRegistrada } from '@papeleria/db';

import { pesos } from '../productos/formato';

export interface DatosNegocio {
  readonly nombre: string;
  readonly rfc: string;
  readonly direccion: string;
  readonly telefono: string;
}

const METODOS: Record<string, string> = {
  efectivo: 'Efectivo',
  tarjeta_debito: 'Tarjeta débito',
  tarjeta_credito: 'Tarjeta crédito',
  transferencia: 'Transferencia',
  vale: 'Vale',
  credito: 'Crédito',
};

export function Ticket({
  venta,
  negocio,
  id,
}: {
  readonly venta: VentaRegistrada;
  readonly negocio: DatosNegocio;
  readonly id?: string;
}) {
  const fecha = new Date(venta.ocurridoAt);
  const cambio = venta.pagos.reduce((suma, pago) => suma + pago.cambioMinor, 0n);
  const recibido = venta.pagos.reduce((suma, pago) => suma + pago.montoMinor, 0n);

  return (
    <div
      id={id}
      className="mx-auto w-[58mm] bg-white px-[3mm] py-[4mm] font-mono text-[10px] leading-[1.35] text-black"
    >
      <div className="text-center">
        <p className="text-[12px] font-bold uppercase">{negocio.nombre || 'Papelería'}</p>
        {negocio.rfc === '' ? null : <p>RFC: {negocio.rfc}</p>}
        {negocio.direccion === '' ? null : <p>{negocio.direccion}</p>}
        {negocio.telefono === '' ? null : <p>Tel. {negocio.telefono}</p>}
      </div>

      <div className="my-[2mm] border-t border-dashed border-black" />

      <p>
        Ticket <strong>{venta.folioLocal}</strong>
      </p>
      <p>{fecha.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</p>

      <div className="my-[2mm] border-t border-dashed border-black" />

      {venta.lineas.map((linea) => (
        <div key={linea.lineaNo} className="mb-[1.5mm]">
          <p className="break-words">{linea.descripcion}</p>
          <div className="flex justify-between">
            <span>
              {cantidad(linea.qty)} × {pesos(linea.precioUnitarioMinor)}
            </span>
            <span>{pesos(linea.totalLineaMinor)}</span>
          </div>
        </div>
      ))}

      <div className="my-[2mm] border-t border-dashed border-black" />

      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{pesos(venta.subtotalMinor)}</span>
      </div>
      <div className="flex justify-between">
        <span>IVA incluido</span>
        <span>{pesos(venta.impuestoMinor)}</span>
      </div>
      {venta.descuentoMinor > 0n ? (
        <div className="flex justify-between">
          <span>Descuento</span>
          <span>−{pesos(venta.descuentoMinor)}</span>
        </div>
      ) : null}
      <div className="mt-[1mm] flex justify-between border-t border-black pt-[1mm] text-[12px] font-bold">
        <span>TOTAL</span>
        <span>{pesos(venta.totalMinor)}</span>
      </div>

      <div className="my-[2mm] border-t border-dashed border-black" />

      {venta.pagos.map((pago, indice) => (
        <div key={`${pago.metodo}-${indice}`} className="flex justify-between">
          <span>{METODOS[pago.metodo] ?? pago.metodo}</span>
          <span>{pesos(pago.montoMinor)}</span>
        </div>
      ))}
      {cambio > 0n ? (
        <>
          <div className="flex justify-between">
            <span>Recibido</span>
            <span>{pesos(recibido)}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>Cambio</span>
            <span>{pesos(cambio)}</span>
          </div>
        </>
      ) : null}

      <div className="my-[2mm] border-t border-dashed border-black" />

      <p className="text-center">Precios con IVA incluido</p>
      <p className="mt-[2mm] text-center">¡Gracias por su compra!</p>
    </div>
  );
}

/**
 * El corte Z: la foto del turno al cerrarlo, en el mismo papel de 58 mm.
 *
 * No es una venta: es el documento que se guarda al final del día. Muestra el
 * esperado, lo contado y la diferencia —incluido el signo—, porque un corte que
 * sólo dice «cuadra» no sirve para encontrar el error de ayer.
 */
export function CorteZ({
  cierre,
  resumen,
  negocio,
  id,
}: {
  readonly cierre: CierreDeTurno;
  readonly resumen: ResumenTurno;
  readonly negocio: DatosNegocio;
  readonly id?: string;
}) {
  const cerrado = new Date(cierre.cerradaAt);

  return (
    <div
      id={id}
      className="mx-auto w-[58mm] bg-white px-[3mm] py-[4mm] font-mono text-[10px] leading-[1.35] text-black"
    >
      <div className="text-center">
        <p className="text-[12px] font-bold uppercase">{negocio.nombre || 'Papelería'}</p>
        {negocio.rfc === '' ? null : <p>RFC: {negocio.rfc}</p>}
        <p className="text-[11px] font-bold">CORTE Z</p>
        <p>{cerrado.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</p>
        <p className="text-[9px]">Turno {cierre.turnoId.slice(0, 8)}</p>
      </div>

      <div className="my-[2mm] border-t border-dashed border-black" />

      <Fila etiqueta="Fondo inicial" valor={resumen.fondoInicialMinor} />
      <Fila etiqueta="Ventas efectivo" valor={resumen.ventasEfectivoMinor} />
      {resumen.devolucionesMinor > 0n ? (
        <Fila etiqueta="Devoluciones" valor={-resumen.devolucionesMinor} />
      ) : null}
      {resumen.retirosMinor > 0n ? <Fila etiqueta="Retiros" valor={-resumen.retirosMinor} /> : null}
      {resumen.gastosMinor > 0n ? <Fila etiqueta="Gastos" valor={-resumen.gastosMinor} /> : null}
      {resumen.ingresosMinor > 0n ? (
        <Fila etiqueta="Ingresos" valor={resumen.ingresosMinor} />
      ) : null}

      <div className="my-[2mm] border-t border-black" />
      <Fila etiqueta="ESPERADO" valor={cierre.esperadoEfectivoMinor} fuerte />
      <Fila etiqueta="CONTADO" valor={cierre.contadoEfectivoMinor} fuerte />
      <Fila etiqueta="DIFERENCIA" valor={cierre.diferenciaMinor} fuerte />

      <div className="my-[2mm] border-t border-dashed border-black" />

      <Fila etiqueta="Tickets" valorTexto={String(resumen.tickets)} />
      <Fila etiqueta="Total vendido" valor={resumen.totalVentasMinor} />
      {resumen.porMetodo.map((fila) => (
        <Fila
          key={fila.metodo}
          etiqueta={METODOS[fila.metodo] ?? fila.metodo}
          valor={fila.montoMinor}
        />
      ))}

      <div className="my-[2mm] border-t border-dashed border-black" />
      <p className="text-center text-[9px]">Firma: ____________________</p>
    </div>
  );
}

function Fila({
  etiqueta,
  valor,
  valorTexto,
  fuerte = false,
}: {
  readonly etiqueta: string;
  readonly valor?: bigint;
  readonly valorTexto?: string;
  readonly fuerte?: boolean;
}) {
  return (
    <div className={fuerte ? 'flex justify-between font-bold' : 'flex justify-between'}>
      <span>{etiqueta}</span>
      <span>{valorTexto ?? (valor === undefined ? '' : pesos(valor))}</span>
    </div>
  );
}

/**
 * La hoja de impresión. Se monta una sola vez y afecta a toda la app: al imprimir,
 * todo lo demás se oculta y sólo queda el ticket o el corte. Sin esto,
 * `window.print()` saca la pantalla de venta completa, con botones y todo.
 */
export function EstilosDeImpresion() {
  return (
    <style>{`
      @media print {
        @page { size: 58mm auto; margin: 0; }
        html, body { background: #fff !important; }
        body * { visibility: hidden !important; }
        #ticket-impresion, #ticket-impresion *,
        #corte-impresion, #corte-impresion * { visibility: visible !important; }
        #ticket-impresion, #corte-impresion {
          position: absolute !important;
          left: 0 !important;
          top: 0 !important;
          width: 58mm !important;
          margin: 0 !important;
          padding: 3mm !important;
        }
      }
    `}</style>
  );
}

function cantidad(milesimas: number): string {
  const entero = Math.trunc(milesimas / 1000);
  const fraccion = milesimas % 1000;
  return fraccion === 0 ? String(entero) : `${entero}.${String(fraccion).padStart(3, '0')}`;
}
