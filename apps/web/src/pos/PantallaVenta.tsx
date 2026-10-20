/**
 * LA PANTALLA DE VENTA (F2.2 – F2.8).
 *
 * Tres cosas viven aquí y conviene no mezclarlas:
 *
 *   1. **El turno.** Sin turno no se vende. Si no hay uno abierto, la pantalla no
 *      muestra el carrito: muestra la apertura. Es la regla de docs/05 §2 puesta
 *      donde se ve, no en un comentario.
 *   2. **El carrito.** Se llena escaneando (lector HID por la cola de escaneo),
 *      buscando por nombre o código, o con el botón de un resultado. Escanear dos
 *      veces el mismo código suma dos piezas; no crea dos líneas.
 *   3. **El cobro.** Efectivo con cambio sugerido, o tarjeta/transferencia por el
 *      importe exacto. Al confirmar se llama a `registrarVenta()`, que escribe la
 *      venta, el stock y el evento en una sola transacción.
 *
 * ─── LO QUE NO HACE TODAVÍA (y por qué no lo finge) ─────────────────────────
 *
 * · Descuentos: el carrito no los ofrece. Las políticas P10/P11 piden step-up a
 *   partir del 10 %, y no hay pantalla de PIN hasta F6. Un campo que siempre
 *   falla al guardar es peor que un campo que no está.
 * · Pago mixto: la capa de datos lo soporta y está probado; la pantalla cobra con
 *   un solo método. Agregar la segunda fila es F2.3 y no cambia el modelo.
 * · Devoluciones y cancelaciones: F2.10. El dato ya existe; falta la pantalla.
 * · La venta libre (fotocopias) choca con `sale_lines.product_id NOT NULL`; se
 *   resuelve en F2.9 con un producto de servicios, no con un `if` en la caja.
 *
 * ─── EL FOCO ES PARTE DEL DISEÑO ────────────────────────────────────────────
 *
 * Al abrir la pantalla, el cursor está en el buscador. Después de cobrar, vuelve
 * al buscador. `F2` lo enfoca desde cualquier lugar y `F1` abre el cobro. El caso
 * normal —escanear, cobrar, escanear— no debería exigir tocar el ratón.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  abrirTurno,
  buscarProductoPorCodigo,
  cerrarTurno,
  ErrorCaja,
  ErrorNoAutorizado,
  ErrorProducto,
  ErrorVenta,
  listarProductos,
  movimientosDelTurno,
  registrarMovimientoCaja,
  registrarVenta,
  resumenTurno,
  turnoAbierto,
  type FilaProducto,
  type MetodoPago,
  type MovimientoDeCaja,
  type ResumenTurno,
  type TipoMovimientoCaja,
  type Turno,
  type VentaRegistrada,
  type CierreDeTurno,
} from '@papeleria/db';
import { cambioSugerido, ErrorDinero, porCantidad } from '@papeleria/core';

import type { SesionIniciada } from '../auth/pantalla';
import { Aviso, Boton, Entrada, Seleccion, Tarjeta, cx } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import type { ColaEscaneo } from '../escaneo/cola';
import { intentarCentavos, pesos, pesosParaEditar } from '../productos/formato';
import { EstilosDeImpresion, CorteZ, Ticket, type DatosNegocio } from './Ticket';

export interface PropsPOS {
  readonly base: BaseLocal;
  readonly sesion: SesionIniciada;
  readonly cola: ColaEscaneo;
}

interface LineaCarrito {
  readonly clave: string;
  readonly productoId: string;
  readonly presentacionId: string | null;
  readonly nombre: string;
  readonly precioMinor: bigint;
  /** Milésimas: 1 pieza = 1000. */
  readonly qty: number;
  readonly stock: string;
}

type Vista = 'venta' | 'cobro' | 'ticket';

const METODOS: ReadonlyArray<{ valor: MetodoPago; texto: string }> = [
  { valor: 'efectivo', texto: 'Efectivo' },
  { valor: 'tarjeta_debito', texto: 'Tarjeta débito' },
  { valor: 'tarjeta_credito', texto: 'Tarjeta crédito' },
  { valor: 'transferencia', texto: 'Transferencia' },
  { valor: 'vale', texto: 'Vale' },
];

const DENOMINACIONES = [2000n, 5000n, 10000n, 20000n, 50000n, 100000n];

export function PantallaVenta({ base, sesion, cola }: PropsPOS) {
  const [turno, setTurno] = useState<Turno | null | undefined>(undefined);
  const [errorTurno, setErrorTurno] = useState<string | null>(null);
  const [fondo, setFondo] = useState('500.00');
  const [abriendo, setAbriendo] = useState(false);

  const [lineas, setLineas] = useState<readonly LineaCarrito[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState<readonly FilaProducto[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const [vista, setVista] = useState<Vista>('venta');
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo');
  const [recibido, setRecibido] = useState('');
  const [cerrando, setCerrando] = useState(false);
  const [registrandoMov, setRegistrandoMov] = useState(false);
  const [cobrando, setCobrando] = useState(false);
  const [errorCobro, setErrorCobro] = useState<string | null>(null);
  const [venta, setVenta] = useState<VentaRegistrada | null>(null);

  const [cierre, setCierre] = useState(false);
  const [resumen, setResumen] = useState<ResumenTurno | null>(null);
  const [movimientos, setMovimientos] = useState<readonly MovimientoDeCaja[]>([]);
  const [contado, setContado] = useState('');
  const [notasCierre, setNotasCierre] = useState('');
  const [errorCierre, setErrorCierre] = useState<string | null>(null);
  const [resultadoCierre, setResultadoCierre] = useState<string | null>(null);
  const [corte, setCorte] = useState<{
    readonly cierre: CierreDeTurno;
    readonly resumen: ResumenTurno;
  } | null>(null);

  const [movTipo, setMovTipo] = useState<TipoMovimientoCaja>('retiro');
  const [movMonto, setMovMonto] = useState('');
  const [movConcepto, setMovConcepto] = useState('');
  const [errorMov, setErrorMov] = useState<string | null>(null);

  const [negocio, setNegocio] = useState<DatosNegocio>({
    nombre: 'Papelería',
    direccion: '',
    telefono: '',
  });

  const buscador = useRef<HTMLInputElement>(null);
  const recibidoRef = useRef<HTMLInputElement>(null);

  const contexto = useMemo(
    () => ({ usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id }),
    [sesion.usuario.id, sesion.dispositivo.id],
  );

  const total = useMemo(
    () => lineas.reduce((suma, linea) => suma + porCantidad(linea.precioMinor, linea.qty), 0n),
    [lineas],
  );

  const recibidoMinor = intentarCentavos(recibido === '' ? '0' : recibido) ?? 0n;
  const cambio = recibidoMinor > total ? recibidoMinor - total : 0n;

  // ── turno y configuración ─────────────────────────────────────────────────
  const cargarTurno = useCallback(async () => {
    try {
      const abierto = await turnoAbierto(comoClienteTransaccional(base), sesion.dispositivo.id);
      setTurno(abierto);
      setErrorTurno(null);
    } catch (causa) {
      setErrorTurno(mensajeDe(causa));
    }
  }, [base, sesion.dispositivo.id]);

  useEffect(() => {
    void cargarTurno();
  }, [cargarTurno]);

  useEffect(() => {
    void (async () => {
      try {
        const filas = await base.consultar<{ clave: string; valor: unknown }>(
          `SELECT clave, valor FROM settings
            WHERE clave IN ('nombre_negocio', 'direccion', 'telefono')`,
        );
        const valor = (clave: string): string => {
          const fila = filas.find((f) => f.clave === clave);
          return fila === undefined || fila.valor === null ? '' : String(fila.valor);
        };
        setNegocio({
          nombre: valor('nombre_negocio') || 'Papelería',
          direccion: valor('direccion'),
          telefono: valor('telefono'),
        });
      } catch {
        // La configuración es cosmética para el ticket: si falla, se usa el nombre
        // genérico y la venta sigue. No vale la pena bloquear la caja por esto.
      }
    })();
  }, [base]);

  // ── búsqueda ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let vigente = true;
    const texto = busqueda.trim();

    if (texto === '') {
      setResultados([]);
      setBuscando(false);
      return;
    }

    const temporizador = window.setTimeout(() => {
      void (async () => {
        setBuscando(true);
        try {
          const filas = await listarProductos(comoClienteTransaccional(base), texto);
          if (vigente) setResultados(filas.slice(0, 8));
        } catch (causa) {
          if (vigente) setAviso(mensajeDe(causa));
        } finally {
          if (vigente) setBuscando(false);
        }
      })();
    }, 140);

    return () => {
      vigente = false;
      window.clearTimeout(temporizador);
    };
  }, [base, busqueda]);

  // ── escaneo HID ───────────────────────────────────────────────────────────
  const alEscanear = useRef<(codigo: string) => void>(() => {});
  alEscanear.current = (codigo) => {
    if (vista === 'cobro') return;
    if (turno === null || turno === undefined) {
      setAviso('Abre el turno de caja antes de empezar a vender.');
      return;
    }
    // Escanear sobre el ticket de la venta anterior arranca la siguiente sin
    // obligar a tocar «Nueva venta». Es el gesto normal de una caja: pitazo,
    // cobrar, pitazo.
    if (vista === 'ticket') {
      setVenta(null);
      setVista('venta');
    }
    void agregarPorCodigo(codigo);
  };

  useEffect(() => cola.alEscanear((evento) => alEscanear.current(evento.codigo)), [cola]);

  // ── atajos ────────────────────────────────────────────────────────────────
  useEffect(() => {
    function alTeclear(evento: KeyboardEvent): void {
      if (evento.key === 'F2') {
        evento.preventDefault();
        buscador.current?.focus();
        return;
      }
      if (evento.key === 'F1' && vista === 'venta' && lineas.length > 0) {
        evento.preventDefault();
        abrirCobro();
        return;
      }
      if (evento.key === 'Escape' && vista === 'cobro') {
        evento.preventDefault();
        setVista('venta');
        setErrorCobro(null);
      }
    }

    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  });

  // ── carrito ───────────────────────────────────────────────────────────────
  function agregarProducto(producto: {
    id: string;
    nombre: string;
    precioMinor: bigint;
    presentacionId: string | null;
    stock: string;
  }): void {
    const clave = `${producto.id}|${producto.presentacionId ?? ''}|${producto.precioMinor}`;
    setLineas((actuales) => {
      const existente = actuales.find((linea) => linea.clave === clave);
      if (existente !== undefined) {
        return actuales.map((linea) =>
          linea.clave === clave ? { ...linea, qty: linea.qty + 1000 } : linea,
        );
      }
      return [
        ...actuales,
        {
          clave,
          productoId: producto.id,
          presentacionId: producto.presentacionId,
          nombre: producto.nombre,
          precioMinor: producto.precioMinor,
          qty: 1000,
          stock: producto.stock,
        },
      ];
    });
    setAviso(null);
  }

  async function agregarPorCodigo(codigo: string): Promise<void> {
    const limpio = codigo.trim();
    if (limpio === '') return;

    try {
      const encontrado = await buscarProductoPorCodigo(comoClienteTransaccional(base), limpio);
      if (encontrado === null) {
        setAviso(`El código ${limpio} no está dado de alta. Búscalo por nombre o regístralo en Productos.`);
        return;
      }
      agregarProducto({
        id: encontrado.id,
        nombre: encontrado.nombre,
        precioMinor: BigInt(encontrado.precioMinor),
        presentacionId: encontrado.presentacionId,
        stock: encontrado.stock,
      });
    } catch (causa) {
      setAviso(mensajeDe(causa));
    }
  }

  function agregarFila(fila: FilaProducto): void {
    agregarProducto({
      id: fila.id,
      nombre: fila.nombre,
      precioMinor: BigInt(fila.precioMinor),
      presentacionId: null,
      stock: fila.stock,
    });
    setBusqueda('');
    setResultados([]);
    buscador.current?.focus();
  }

  function cambiarCantidad(clave: string, qty: number): void {
    if (qty <= 0) {
      setLineas((actuales) => actuales.filter((linea) => linea.clave !== clave));
      return;
    }
    setLineas((actuales) =>
      actuales.map((linea) => (linea.clave === clave ? { ...linea, qty } : linea)),
    );
  }

  function quitar(clave: string): void {
    setLineas((actuales) => actuales.filter((linea) => linea.clave !== clave));
  }

  async function alBuscar(evento: React.FormEvent): Promise<void> {
    evento.preventDefault();
    const texto = busqueda.trim();
    if (texto === '') return;

    try {
      const exacto = await buscarProductoPorCodigo(comoClienteTransaccional(base), texto);
      if (exacto !== null) {
        agregarProducto({
          id: exacto.id,
          nombre: exacto.nombre,
          precioMinor: BigInt(exacto.precioMinor),
          presentacionId: exacto.presentacionId,
          stock: exacto.stock,
        });
        setBusqueda('');
        setResultados([]);
        return;
      }

      if (resultados.length === 1) {
        agregarFila(resultados[0] as FilaProducto);
        return;
      }

      if (resultados.length === 0) {
        setAviso(`No hay ningún producto que coincida con «${texto}».`);
      } else {
        setAviso(`Hay ${resultados.length} coincidencias: elige una de la lista.`);
      }
    } catch (causa) {
      setAviso(mensajeDe(causa));
    }
  }

  // ── apertura de turno ─────────────────────────────────────────────────────
  async function abrir(): Promise<void> {
    const monto = intentarCentavos(fondo);
    if (monto === null) {
      setErrorTurno('Escribe el fondo inicial como un importe, por ejemplo 500.00.');
      return;
    }

    setAbriendo(true);
    setErrorTurno(null);
    try {
      const nuevo = await abrirTurno(
        comoClienteTransaccional(base),
        { fondoInicialMinor: monto },
        contexto,
      );
      await base.sincronizar();
      setTurno(nuevo);
      setResultadoCierre(null);
      setCorte(null);
      setVista('venta');
      buscador.current?.focus();
    } catch (causa) {
      setErrorTurno(mensajeDe(causa));
    } finally {
      setAbriendo(false);
    }
  }

  // ── cobro ─────────────────────────────────────────────────────────────────
  function abrirCobro(): void {
    setErrorCobro(null);
    setMetodo('efectivo');
    setRecibido('');
    setVista('cobro');
    window.setTimeout(() => recibidoRef.current?.focus(), 50);
  }

  async function cobrar(imprimir: boolean): Promise<void> {
    if (turno === null || turno === undefined) return;
    if (lineas.length === 0) return;

    setCobrando(true);
    setErrorCobro(null);

    const pagos =
      metodo === 'efectivo'
        ? [{ metodo, montoMinor: recibidoMinor === 0n ? total : recibidoMinor }]
        : [{ metodo, montoMinor: total }];

    try {
      const registrada = await registrarVenta(
        comoClienteTransaccional(base),
        {
          turnoId: turno.id,
          lineas: lineas.map((linea) => ({
            productoId: linea.productoId,
            presentacionId: linea.presentacionId,
            qty: linea.qty,
          })),
          pagos,
        },
        contexto,
      );

      // La venta ya está confirmada en la base lógica; esto la manda a IndexedDB.
      // Es el único lugar de la caja donde se espera el volcado: el ticket no debe
      // existir en pantalla si el disco todavía no lo tiene.
      await base.sincronizar();

      setVenta(registrada);
      setVista('ticket');
      setLineas([]);
      setRecibido('');
      setMetodo('efectivo');
      setBusqueda('');
      setResultados([]);
      setAviso(null);

      if (imprimir) {
        window.setTimeout(() => window.print(), 200);
      }
    } catch (causa) {
      setErrorCobro(mensajeDe(causa));
    } finally {
      setCobrando(false);
    }
  }

  function nuevaVenta(): void {
    setVenta(null);
    setVista('venta');
    setResultadoCierre(null);
    window.setTimeout(() => buscador.current?.focus(), 50);
  }

  // ── cierre de turno y movimientos ─────────────────────────────────────────
  async function abrirCierre(): Promise<void> {
    if (turno === null || turno === undefined) return;

    setCierre(true);
    setErrorCierre(null);
    setErrorMov(null);
    setResumen(null);
    setMovimientos([]);
    try {
      const cliente = comoClienteTransaccional(base);
      const [foto, movs] = await Promise.all([
        resumenTurno(cliente, turno.id),
        movimientosDelTurno(cliente, turno.id),
      ]);
      setResumen(foto);
      setMovimientos(movs);
      setContado(pesosParaEditar(foto.esperadoEfectivoMinor));
      setNotasCierre('');
      setMovMonto('');
      setMovConcepto('');
    } catch (causa) {
      setErrorCierre(mensajeDe(causa));
    }
  }

  async function registrarMovimiento(): Promise<void> {
    if (turno === null || turno === undefined || registrandoMov) return;

    const monto = intentarCentavos(movMonto);
    if (monto === null || monto <= 0n) {
      setErrorMov('Escribe el monto del movimiento.');
      return;
    }
    if (movConcepto.trim() === '') {
      setErrorMov('Escribe para qué salió o entró el dinero.');
      return;
    }

    setErrorMov(null);
    setRegistrandoMov(true);
    try {
      const cliente = comoClienteTransaccional(base);
      await registrarMovimientoCaja(
        cliente,
        { turnoId: turno.id, tipo: movTipo, montoMinor: monto, concepto: movConcepto },
        contexto,
      );
      await base.sincronizar();

      const [foto, movs] = await Promise.all([
        resumenTurno(cliente, turno.id),
        movimientosDelTurno(cliente, turno.id),
      ]);
      setResumen(foto);
      setMovimientos(movs);
      setContado(pesosParaEditar(foto.esperadoEfectivoMinor));
      setMovMonto('');
      setMovConcepto('');
    } catch (causa) {
      setErrorMov(mensajeDe(causa));
    } finally {
      setRegistrandoMov(false);
    }
  }

  async function cerrar(): Promise<void> {
    if (turno === null || turno === undefined || cerrando) return;

    const monto = intentarCentavos(contado);
    if (monto === null) {
      setErrorCierre('Escribe lo que contaste, por ejemplo 2702.50.');
      return;
    }

    setErrorCierre(null);
    setCerrando(true);
    try {
      const cierreFinal = await cerrarTurno(
        comoClienteTransaccional(base),
        { turnoId: turno.id, contadoEfectivoMinor: monto, notas: notasCierre },
        contexto,
      );
      await base.sincronizar();

      const texto =
        cierreFinal.diferenciaMinor === 0n
          ? 'Turno cerrado. El arqueo cuadra al centavo.'
          : `Turno cerrado. Diferencia: ${pesos(cierreFinal.diferenciaMinor)}.`;

      if (resumen !== null) {
        setCorte({ cierre: cierreFinal, resumen });
      }

      setCierre(false);
      setTurno(null);
      setResumen(null);
      setMovimientos([]);
      setVenta(null);
      setResultadoCierre(texto);
      setVista('venta');
    } catch (causa) {
      setErrorCierre(mensajeDe(causa));
    } finally {
      setCerrando(false);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <EstilosDeImpresion />

      <Encabezado
        turno={turno}
        onCerrar={() => void abrirCierre()}
      />

      {errorTurno === null ? null : (
        <Aviso tono="mal">{errorTurno}</Aviso>
      )}
      {resultadoCierre === null ? null : <Aviso tono="ok">{resultadoCierre}</Aviso>}
      {aviso === null ? null : <Aviso tono="aviso">{aviso}</Aviso>}

      {turno === undefined ? (
        <Tarjeta className="p-6 text-sm text-[var(--suave)]">Leyendo el turno de caja…</Tarjeta>
      ) : turno === null ? (
        <div className="flex flex-col gap-4">
          <AbrirTurno
            fondo={fondo}
            onFondo={setFondo}
            abriendo={abriendo}
            abrir={() => void abrir()}
          />
          {corte === null ? null : (
            <div className="flex flex-col items-center gap-3">
              <div className="overflow-hidden rounded-xl border border-[var(--linea)] shadow-sm">
                <CorteZ
                  cierre={corte.cierre}
                  resumen={corte.resumen}
                  negocio={negocio}
                  id="corte-impresion"
                />
              </div>
              <Boton onClick={() => window.print()}>Imprimir corte Z</Boton>
            </div>
          )}
        </div>
      ) : vista === 'ticket' && venta !== null ? (
        <div className="flex flex-col items-center gap-4">
          <div className="overflow-hidden rounded-xl border border-[var(--linea)] shadow-sm">
            <Ticket venta={venta} negocio={negocio} id="ticket-impresion" />
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Boton onClick={() => window.print()}>Imprimir ticket</Boton>
            <Boton variante="secundario" onClick={nuevaVenta}>
              Nueva venta (F2)
            </Boton>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Buscador
            busqueda={busqueda}
            onBusqueda={setBusqueda}
            onBuscar={(evento) => void alBuscar(evento)}
            resultados={resultados}
            buscando={buscando}
            buscador={buscador}
            onAgregar={agregarFila}
          />

          <Carrito
            lineas={lineas}
            total={total}
            onCantidad={cambiarCantidad}
            onQuitar={quitar}
            onCobrar={abrirCobro}
          />
        </div>
      )}

      {vista === 'cobro' && turno !== null && turno !== undefined ? (
        <div className="fixed inset-0 z-30 overflow-auto bg-black/40 p-4">
          <div className="mx-auto mt-6 max-w-lg">
            <Tarjeta className="p-5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Cobrar</h2>
                  <p className="text-sm text-[var(--suave)]">
                    {lineas.length} línea{lineas.length === 1 ? '' : 's'} · total{' '}
                    <strong className="text-[var(--texto)]">{pesos(total)}</strong>
                  </p>
                </div>
                <Boton variante="secundario" onClick={() => setVista('venta')} disabled={cobrando}>
                  Volver (Esc)
                </Boton>
              </div>

              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                  Método de pago
                  <Seleccion
                    value={metodo}
                    onChange={(evento) => setMetodo(evento.target.value as MetodoPago)}
                    disabled={cobrando}
                  >
                    {METODOS.map((opcion) => (
                      <option key={opcion.valor} value={opcion.valor}>
                        {opcion.texto}
                      </option>
                    ))}
                  </Seleccion>
                </label>

                {metodo === 'efectivo' ? (
                  <>
                    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                      Recibido
                      <Entrada
                        ref={recibidoRef}
                        value={recibido}
                        onChange={(evento) => setRecibido(evento.target.value)}
                        placeholder={pesosParaEditar(total)}
                        inputMode="decimal"
                        disabled={cobrando}
                        onKeyDown={(evento) => {
                          if (evento.key === 'Enter') {
                            evento.preventDefault();
                            void cobrar(true);
                          }
                        }}
                      />
                    </label>

                    <div className="flex flex-wrap gap-1.5">
                      <Boton
                        variante="secundario"
                        className="px-2.5 py-1.5 text-xs"
                        onClick={() => setRecibido(pesosParaEditar(total))}
                        disabled={cobrando}
                      >
                        Exacto
                      </Boton>
                      {DENOMINACIONES.map((valor) => (
                        <Boton
                          key={String(valor)}
                          variante="secundario"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => setRecibido(pesosParaEditar(valor))}
                          disabled={cobrando}
                        >
                          {pesos(valor)}
                        </Boton>
                      ))}
                    </div>

                    <div className="rounded-md border border-[var(--linea)] bg-[var(--fondo)] p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm text-[var(--suave)]">Cambio</span>
                        <strong className="text-xl">{pesos(cambio)}</strong>
                      </div>
                      {cambio > 0n ? (
                        <p className="mt-1 text-xs text-[var(--suave)]">
                          {sugerenciaDeCambio(cambio)}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-[var(--suave)]">
                          Teclea lo que entregó el cliente o pulsa una denominación.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <Aviso tono="info">
                    Se cobrarán {pesos(total)} con {textoMetodo(metodo)}. El cobro en la terminal
                    bancaria se hace aparte; aquí sólo se registra el método.
                  </Aviso>
                )}

                {errorCobro === null ? null : <Aviso tono="mal">{errorCobro}</Aviso>}

                <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                  <Boton
                    className="flex-1"
                    onClick={() => void cobrar(true)}
                    disabled={cobrando || lineas.length === 0}
                  >
                    {cobrando ? 'Cobrando…' : 'Cobrar e imprimir (F1)'}
                  </Boton>
                  <Boton
                    variante="secundario"
                    className="flex-1"
                    onClick={() => void cobrar(false)}
                    disabled={cobrando || lineas.length === 0}
                  >
                    Cobrar sin ticket
                  </Boton>
                </div>
              </div>
            </Tarjeta>
          </div>
        </div>
      ) : null}

      {cierre && turno !== null && turno !== undefined ? (
        <div className="fixed inset-0 z-30 overflow-auto bg-black/40 p-4">
          <div className="mx-auto mt-4 max-w-2xl">
            <Tarjeta className="p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Cierre de turno y arqueo</h2>
                  <p className="text-sm text-[var(--suave)]">
                    Turno abierto a las{' '}
                    {new Date(turno.abiertaAt).toLocaleTimeString('es-MX', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <Boton variante="secundario" onClick={() => setCierre(false)} disabled={cerrando}>
                  Volver a vender
                </Boton>
              </div>

              {resumen === null ? (
                errorCierre === null ? (
                  <p className="text-sm text-[var(--suave)]">Calculando el esperado…</p>
                ) : (
                  <Aviso tono="mal">{errorCierre}</Aviso>
                )
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-md border border-[var(--linea)] bg-[var(--fondo)] p-3 text-sm">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--suave)]">
                      Esperado en el cajón
                    </p>
                    <FilaResumen etiqueta="Fondo inicial" valor={resumen.fondoInicialMinor} />
                    <FilaResumen etiqueta="Ventas en efectivo" valor={resumen.ventasEfectivoMinor} />
                    <FilaResumen etiqueta="Devoluciones" valor={-resumen.devolucionesMinor} />
                    <FilaResumen etiqueta="Retiros" valor={-resumen.retirosMinor} />
                    <FilaResumen etiqueta="Gastos" valor={-resumen.gastosMinor} />
                    <FilaResumen etiqueta="Ingresos" valor={resumen.ingresosMinor} />
                    <div className="mt-2 flex justify-between border-t border-[var(--linea)] pt-2 font-semibold">
                      <span>Esperado</span>
                      <span>{pesos(resumen.esperadoEfectivoMinor)}</span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--suave)]">
                      {resumen.tickets} ticket{resumen.tickets === 1 ? '' : 's'} ·{' '}
                      {pesos(resumen.totalVentasMinor)} vendidos en total.
                    </p>
                    {resumen.porMetodo.length > 0 ? (
                      <ul className="mt-2 space-y-0.5 text-xs text-[var(--suave)]">
                        {resumen.porMetodo.map((fila) => (
                          <li key={fila.metodo} className="flex justify-between">
                            <span>{textoMetodo(fila.metodo as MetodoPago)}</span>
                            <span>{pesos(fila.montoMinor)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                      Contado (lo que hay físicamente)
                      <Entrada
                        value={contado}
                        onChange={(evento) => setContado(evento.target.value)}
                        inputMode="decimal"
                      />
                    </label>
                    <p className="text-xs text-[var(--suave)]">
                      Diferencia:{' '}
                      <strong
                        className={cx(
                          'font-mono',
                          (intentarCentavos(contado) ?? 0n) - resumen.esperadoEfectivoMinor === 0n
                            ? 'text-[var(--ok)]'
                            : 'text-[var(--mal)]',
                        )}
                      >
                        {pesos((intentarCentavos(contado) ?? 0n) - resumen.esperadoEfectivoMinor)}
                      </strong>
                    </p>
                    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                      Nota (obligatoria si la diferencia pasa de $50)
                      <Entrada
                        value={notasCierre}
                        onChange={(evento) => setNotasCierre(evento.target.value)}
                        placeholder="Ej. faltan $1.50, probablemente redondeo"
                      />
                    </label>

                    {errorCierre === null ? null : <Aviso tono="mal">{errorCierre}</Aviso>}

                    <Boton className="mt-1" onClick={() => void cerrar()} disabled={cerrando}>
                      {cerrando ? 'Cerrando…' : 'Cerrar turno y arquear'}
                    </Boton>
                  </div>
                </div>
              )}

              <div className="mt-5 border-t border-[var(--linea)] pt-4">
                <h3 className="text-sm font-semibold">Movimientos de cajón</h3>
                <p className="mb-2 text-xs text-[var(--suave)]">
                  Retiros, gastos e ingresos que no son ventas. Sin ellos, el arqueo siempre da
                  diferencia y nadie sabe por qué.
                </p>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="flex w-full flex-col gap-1 text-xs font-medium text-[var(--suave)] sm:w-36">
                    Tipo
                    <Seleccion
                      value={movTipo}
                      onChange={(evento) => setMovTipo(evento.target.value as TipoMovimientoCaja)}
                    >
                      <option value="retiro">Retiro</option>
                      <option value="gasto">Gasto</option>
                      <option value="ingreso">Ingreso</option>
                    </Seleccion>
                  </label>
                  <label className="flex w-full flex-col gap-1 text-xs font-medium text-[var(--suave)] sm:w-32">
                    Monto
                    <Entrada
                      value={movMonto}
                      onChange={(evento) => setMovMonto(evento.target.value)}
                      inputMode="decimal"
                      placeholder="200.00"
                    />
                  </label>
                  <label className="flex w-full flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                    Concepto
                    <Entrada
                      value={movConcepto}
                      onChange={(evento) => setMovConcepto(evento.target.value)}
                      placeholder="Compra de bolsas"
                    />
                  </label>
                  <Boton
                    variante="secundario"
                    onClick={() => void registrarMovimiento()}
                    disabled={registrandoMov}
                  >
                    {registrandoMov ? 'Registrando…' : 'Registrar'}
                  </Boton>
                </div>

                {errorMov === null ? null : <Aviso tono="mal" className="mt-2">{errorMov}</Aviso>}

                {movimientos.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--suave)]">
                    No hay movimientos en este turno.
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-[var(--linea)] text-sm">
                    {movimientos.map((movimiento) => (
                      <li key={movimiento.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span>
                          <span className="font-medium">{textoTipoMovimiento(movimiento.tipo)}</span>{' '}
                          <span className="text-[var(--suave)]">{movimiento.concepto}</span>
                        </span>
                        <span className="font-mono">{pesos(movimiento.montoMinor)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Tarjeta>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── subcomponentes ─────────────────────────────

function Encabezado({
  turno,
  onCerrar,
}: {
  readonly turno: Turno | null | undefined;
  readonly onCerrar: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--linea)] bg-[var(--tarjeta)] px-4 py-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Vender</h1>
        {turno === null || turno === undefined ? (
          <p className="text-sm text-[var(--suave)]">Sin turno abierto</p>
        ) : (
          <p className="text-sm text-[var(--suave)]">
            Turno desde las{' '}
            {new Date(turno.abiertaAt).toLocaleTimeString('es-MX', {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · fondo {pesos(turno.fondoInicialMinor)}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {turno === null || turno === undefined ? null : (
          <Boton variante="secundario" onClick={onCerrar}>
            Cierre y arqueo
          </Boton>
        )}
      </div>
    </header>
  );
}

function AbrirTurno({
  fondo,
  onFondo,
  abriendo,
  abrir,
}: {
  readonly fondo: string;
  readonly onFondo: (valor: string) => void;
  readonly abriendo: boolean;
  readonly abrir: () => void;
}) {
  return (
    <Tarjeta className="p-5">
      <h2 className="text-base font-semibold">Abrir turno de caja</h2>
      <p className="mt-1 max-w-xl text-sm text-[var(--suave)]">
        Sin turno no se puede vender ni arquear. Escribe el cambio con el que abre el cajón: es
        dinero que ya estaba ahí, no una venta.
      </p>
      <div className="mt-4 flex max-w-sm flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
          Fondo inicial
          <Entrada
            value={fondo}
            onChange={(evento) => onFondo(evento.target.value)}
            inputMode="decimal"
            onKeyDown={(evento) => {
              if (evento.key === 'Enter') {
                evento.preventDefault();
                abrir();
              }
            }}
          />
        </label>
        <Boton onClick={abrir} disabled={abriendo}>
          {abriendo ? 'Abriendo…' : 'Abrir turno'}
        </Boton>
      </div>
    </Tarjeta>
  );
}

function Buscador({
  busqueda,
  onBusqueda,
  onBuscar,
  resultados,
  buscando,
  buscador,
  onAgregar,
}: {
  readonly busqueda: string;
  readonly onBusqueda: (valor: string) => void;
  readonly onBuscar: (evento: React.FormEvent) => void;
  readonly resultados: readonly FilaProducto[];
  readonly buscando: boolean;
  readonly buscador: React.RefObject<HTMLInputElement | null>;
  readonly onAgregar: (fila: FilaProducto) => void;
}) {
  return (
    <Tarjeta className="p-4">
      <form onSubmit={onBuscar} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
          Escanear o buscar (F2)
          <Entrada
            ref={buscador}
            value={busqueda}
            onChange={(evento) => onBusqueda(evento.target.value)}
            placeholder="Escanea un código o escribe el nombre…"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="text-xs text-[var(--suave)]">
          Escanear dos veces el mismo código suma dos piezas. Enter agrega el primer resultado.
        </p>
      </form>

      {buscando ? (
        <p className="mt-3 text-xs text-[var(--suave)]">Buscando…</p>
      ) : resultados.length === 0 ? (
        busqueda.trim() === '' ? (
          <div className="mt-4 rounded-md border border-dashed border-[var(--linea)] p-8 text-center text-sm text-[var(--suave)]">
            El carrito está listo. Escanea el primer producto o búscalo por nombre.
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--suave)]">Sin coincidencias.</p>
        )
      ) : (
        <ul className="mt-3 divide-y divide-[var(--linea)]">
          {resultados.map((fila) => (
            <li key={fila.id}>
              <button
                type="button"
                onClick={() => onAgregar(fila)}
                className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-[var(--fondo)]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{fila.nombre}</span>
                  <span className="block text-xs text-[var(--suave)]">
                    {fila.codigo ?? 'sin código'} · {fila.unidadAbreviatura}
                  </span>
                </span>
                <span className="shrink-0 font-mono">{pesos(fila.precioMinor)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}

function Carrito({
  lineas,
  total,
  onCantidad,
  onQuitar,
  onCobrar,
}: {
  readonly lineas: readonly LineaCarrito[];
  readonly total: bigint;
  readonly onCantidad: (clave: string, qty: number) => void;
  readonly onQuitar: (clave: string) => void;
  readonly onCobrar: () => void;
}) {
  return (
    <Tarjeta className="p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Carrito</h2>
        <span className="text-xs text-[var(--suave)]">
          {lineas.length} línea{lineas.length === 1 ? '' : 's'}
        </span>
      </div>

      {lineas.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--suave)]">
          Todavía no hay nada. Escanea o busca un producto.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--linea)]">
          {lineas.map((linea) => (
            <li key={linea.clave} className="py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 break-words text-sm font-medium">{linea.nombre}</p>
                <button
                  type="button"
                  onClick={() => onQuitar(linea.clave)}
                  className="text-xs text-[var(--mal)] hover:underline"
                  aria-label={`Quitar ${linea.nombre}`}
                >
                  Quitar
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Boton
                    variante="secundario"
                    className="h-7 w-7 px-0 py-0"
                    onClick={() => onCantidad(linea.clave, linea.qty - 1000)}
                    aria-label="Quitar una pieza"
                  >
                    −
                  </Boton>
                  <input
                    className="w-14 rounded border border-[var(--linea)] bg-[var(--fondo)] px-1 py-0.5 text-center text-sm"
                    value={cantidad(linea.qty)}
                    inputMode="numeric"
                    onChange={(evento) => {
                      const n = Number.parseInt(evento.target.value, 10);
                      if (Number.isFinite(n)) onCantidad(linea.clave, Math.max(0, n) * 1000);
                    }}
                    aria-label={`Cantidad de ${linea.nombre}`}
                  />
                  <Boton
                    variante="secundario"
                    className="h-7 w-7 px-0 py-0"
                    onClick={() => onCantidad(linea.clave, linea.qty + 1000)}
                    aria-label="Agregar una pieza"
                  >
                    +
                  </Boton>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm">
                    {pesos(porCantidad(linea.precioMinor, linea.qty))}
                  </p>
                  <p className="text-[10px] text-[var(--suave)]">
                    {pesos(linea.precioMinor)} c/u
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 border-t border-[var(--linea)] pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-[var(--suave)]">Total</span>
          <strong className="text-2xl">{pesos(total)}</strong>
        </div>
        <Boton className="mt-3 w-full" onClick={onCobrar} disabled={lineas.length === 0}>
          Cobrar (F1)
        </Boton>
      </div>
    </Tarjeta>
  );
}

function FilaResumen({ etiqueta, valor }: { readonly etiqueta: string; readonly valor: bigint }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-[var(--suave)]">{etiqueta}</span>
      <span className="font-mono">{pesos(valor)}</span>
    </div>
  );
}

// ───────────────────────────── piezas ─────────────────────────────

function cantidad(milesimas: number): string {
  const entero = Math.trunc(milesimas / 1000);
  const fraccion = milesimas % 1000;
  return fraccion === 0 ? String(entero) : `${entero}.${String(fraccion).padStart(3, '0')}`;
}

function sugerenciaDeCambio(monto: bigint): string {
  const piezas = cambioSugerido(monto)
    .map((denominacion) => `${denominacion.cantidad}×${pesos(denominacion.valor)}`)
    .join(' + ');
  return `Sugerencia: ${piezas}`;
}

function textoMetodo(metodo: string): string {
  return METODOS.find((opcion) => opcion.valor === metodo)?.texto ?? metodo;
}

function textoTipoMovimiento(tipo: TipoMovimientoCaja): string {
  return tipo === 'retiro' ? 'Retiro' : tipo === 'gasto' ? 'Gasto' : 'Ingreso';
}

function mensajeDe(causa: unknown): string {
  if (
    causa instanceof ErrorVenta ||
    causa instanceof ErrorCaja ||
    causa instanceof ErrorNoAutorizado ||
    causa instanceof ErrorProducto ||
    causa instanceof ErrorDinero
  ) {
    return causa.message;
  }
  return `No se pudo completar (${causa instanceof Error ? causa.message : String(causa)}).`;
}
