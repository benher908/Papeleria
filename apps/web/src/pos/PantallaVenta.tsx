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
 *   3. **El cobro.** Efectivo con cambio sugerido, pago mixto con varias filas
 *      (sólo el efectivo puede dar cambio), descuento por importe y venta libre.
 *      Al confirmar se llama a `registrarVenta()`, que escribe la venta, el stock
 *      y el evento en una sola transacción.
 *
 * ─── LO QUE NO HACE TODAVÍA (y por qué no lo finge) ─────────────────────────
 *
 * · Devolución parcial: hoy se cancela la venta completa (F2.10).
 * · Historial de ventas con reimpresión y reportes: F7.
 * · PIN y passkeys: F6; el step-up de las políticas ya usa la contraseña.
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
  cancelarVenta,
  cerrarTurno,
  ErrorCaja,
  ErrorNoAutorizado,
  ErrorProducto,
  ErrorVenta,
  ID_VENTA_LIBRE,
  listarProductos,
  movimientosDelTurno,
  productosMasVendidos,
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
  ventasDelTurno,
} from '@papeleria/db';
import { cambioSugerido, ErrorDinero, porCantidad } from '@papeleria/core';

import type { SesionIniciada } from '../auth/pantalla';
import { DialogoStepUp } from '../componentes/StepUp';
import { Aviso, Boton, Entrada, Seleccion, Tarjeta, cx } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import type { ColaEscaneo } from '../escaneo/cola';
import { CamaraEscaner } from '../escaneo/CamaraEscaner';
import { ConectorEscanerMovil } from '../escaneo/ConectorEscanerMovil';
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
  /** Venta libre: manda descripción y precio propios y no mueve inventario. */
  readonly esLibre: boolean;
}

type Vista = 'venta' | 'cobro' | 'ticket';

interface SolicitudStepUp {
  readonly permiso: string;
  readonly descripcion: string;
  readonly entidadId?: string;
  readonly accion: () => Promise<void>;
}

interface PagoUI {
  readonly id: number;
  readonly metodo: MetodoPago;
  /** Texto tal como se tecleó, para no pelear con el punto decimal. */
  readonly monto: string;
}

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
  const [favoritos, setFavoritos] = useState<readonly FilaProducto[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const [libre, setLibre] = useState(false);
  const [libreDescripcion, setLibreDescripcion] = useState('');
  const [librePrecio, setLibrePrecio] = useState('');
  const [libreCantidad, setLibreCantidad] = useState('1');
  const [errorLibre, setErrorLibre] = useState<string | null>(null);

  const [vista, setVista] = useState<Vista>('venta');
  /**
   * Cada fila es una forma de pago. En efectivo el monto es «lo que entregó el
   * cliente» (puede pasar del total y genera cambio); en los demás métodos es el
   * importe exacto que se aplicó. El cambio se calcula sumando todas las filas y
   * sólo puede salir de una fila en efectivo, igual que en `repartirCambio()`.
   */
  const [pagosUI, setPagosUI] = useState<readonly PagoUI[]>([]);
  const [descuentoTexto, setDescuentoTexto] = useState('');
  const [motivoDescuento, setMotivoDescuento] = useState('');
  const [cerrando, setCerrando] = useState(false);
  const [registrandoMov, setRegistrandoMov] = useState(false);
  const [cobrando, setCobrando] = useState(false);
  const [errorCobro, setErrorCobro] = useState<string | null>(null);
  const [venta, setVenta] = useState<VentaRegistrada | null>(null);

  const [cierre, setCierre] = useState(false);
  const [resumen, setResumen] = useState<ResumenTurno | null>(null);
  const [movimientos, setMovimientos] = useState<readonly MovimientoDeCaja[]>([]);
  const [ventasTurno, setVentasTurno] = useState<
    ReadonlyArray<{
      readonly ventaId: string;
      readonly folioLocal: string;
      readonly totalMinor: bigint;
      readonly estado: string;
      readonly ocurridoAt: string;
    }>
  >([]);
  const [cancelacion, setCancelacion] = useState<{
    readonly ventaId: string;
    readonly folioLocal: string;
    readonly totalMinor: bigint;
    readonly motivo: string;
  } | null>(null);
  const [errorCancelacion, setErrorCancelacion] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);
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
  const [stepUp, setStepUp] = useState<SolicitudStepUp | null>(null);

  const [negocio, setNegocio] = useState<DatosNegocio>({
    nombre: 'Papelería',
    rfc: '',
    direccion: '',
    telefono: '',
  });

  const buscador = useRef<HTMLInputElement>(null);
  const siguientePago = useRef(1);
  const siguienteLibre = useRef(1);

  const contexto = useMemo(
    () => ({ usuarioId: sesion.usuario.id, dispositivoId: sesion.dispositivo.id }),
    [sesion.usuario.id, sesion.dispositivo.id],
  );

  const subtotal = useMemo(
    () => lineas.reduce((suma, linea) => suma + porCantidad(linea.precioMinor, linea.qty), 0n),
    [lineas],
  );

  /**
   * El descuento se teclea como importe, no como porcentaje: es lo que el dueño
   * negocia en el mostrador («quítale diez pesos»). El porcentaje se muestra
   * calculado y es el que leen las políticas P10 y P11.
   */
  const descuento = useMemo(() => {
    const tecleado = intentarCentavos(descuentoTexto === '' ? '0' : descuentoTexto) ?? 0n;
    if (tecleado <= 0n) return 0n;
    return tecleado > subtotal ? subtotal : tecleado;
  }, [descuentoTexto, subtotal]);
  const total = subtotal - descuento;
  const descuentoPct =
    subtotal <= 0n ? 0 : Number((descuento * 10_000n) / subtotal) / 100;
  const motivoObligatorio = descuento > 0n && (descuentoPct > 30 || descuento > 20_000n);

  const pagosMinor = pagosUI.map((pago) => ({
    ...pago,
    montoMinor: intentarCentavos(pago.monto === '' ? '0' : pago.monto) ?? 0n,
  }));
  const totalPagado = pagosMinor.reduce((suma, pago) => suma + pago.montoMinor, 0n);
  const cambio = totalPagado > total ? totalPagado - total : 0n;
  const falta = total > totalPagado ? total - totalPagado : 0n;
  const efectivoDisponible = pagosMinor
    .filter((pago) => pago.metodo === 'efectivo')
    .reduce((suma, pago) => suma + pago.montoMinor, 0n);
  const pagadoSinEfectivo = pagosMinor
    .filter((pago) => pago.metodo !== 'efectivo')
    .reduce((suma, pago) => suma + pago.montoMinor, 0n);

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

  const cargarFavoritos = useCallback(async () => {
    try {
      // La caja muestra un catálogo amplio desde el inicio para evitar que el
      // dueño tenga que buscar cada artículo. La búsqueda sigue siendo la vía
      // rápida cuando el catálogo crece.
      setFavoritos(await productosMasVendidos(comoClienteTransaccional(base), 24));
    } catch {
      // La tira de favoritos es una ayuda, no un requisito para vender. Si falla,
      // el buscador y el escáner siguen funcionando.
      setFavoritos([]);
    }
  }, [base]);

  useEffect(() => {
    void cargarFavoritos();
  }, [cargarFavoritos]);

  const cargarNegocio = useCallback(async () => {
    try {
      const filas = await base.consultar<{ clave: string; valor: unknown }>(
        `SELECT clave, valor #>> '{}' AS valor FROM settings
          WHERE clave IN ('nombre_negocio', 'rfc', 'direccion', 'telefono')`,
      );
      const valor = (clave: string): string => {
        const fila = filas.find((f) => f.clave === clave);
        return fila === undefined || fila.valor === null ? '' : String(fila.valor);
      };
      setNegocio({
        nombre: valor('nombre_negocio') || 'Papelería',
        rfc: valor('rfc'),
        direccion: valor('direccion'),
        telefono: valor('telefono'),
      });
    } catch {
      // La configuración es cosmética para el ticket: si falla, se usa el nombre
      // genérico y la venta sigue. No vale la pena bloquear la caja por esto.
    }
  }, [base]);

  useEffect(() => {
    void cargarNegocio();
    // Ajustes vive en otra pestaña de la misma app y el POS no se desmonta al
    // cambiar de pestaña. Sin este aviso, el ticket seguiría diciendo el nombre
    // viejo hasta recargar el navegador.
    const alCambiar = (): void => {
      void cargarNegocio();
    };
    window.addEventListener('papeleria:ajustes', alCambiar);
    return () => window.removeEventListener('papeleria:ajustes', alCambiar);
  }, [cargarNegocio]);

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
          if (vigente) setResultados(filas.slice(0, 24));
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
      if (evento.key === 'F4' && vista === 'venta') {
        evento.preventDefault();
        abrirVentaLibre();
        return;
      }
      if (evento.key === 'Escape' && cancelacion !== null) {
        evento.preventDefault();
        setCancelacion(null);
        return;
      }
      if (evento.key === 'Escape' && libre) {
        evento.preventDefault();
        setLibre(false);
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
          esLibre: false,
        },
      ];
    });
    setAviso(null);
  }

  function abrirVentaLibre(): void {
    setErrorLibre(null);
    setLibreDescripcion('');
    setLibrePrecio('');
    setLibreCantidad('1');
    setLibre(true);
  }

  function agregarVentaLibre(): void {
    const descripcion = libreDescripcion.trim();
    const precio = intentarCentavos(librePrecio);
    const cantidad = Number.parseInt(libreCantidad, 10);

    if (descripcion === '') {
      setErrorLibre('Escribe qué se vendió (copias, engargolado, impresión…).');
      return;
    }
    if (precio === null || precio <= 0n) {
      setErrorLibre('Escribe el precio, por ejemplo 2.50.');
      return;
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      setErrorLibre('La cantidad tiene que ser un número entero mayor que cero.');
      return;
    }

    setLineas((actuales) => [
      ...actuales,
      {
        clave: `libre|${siguienteLibre.current++}`,
        productoId: ID_VENTA_LIBRE,
        presentacionId: null,
        nombre: descripcion,
        precioMinor: precio,
        qty: cantidad * 1000,
        stock: '—',
        esLibre: true,
      },
    ]);
    setLibre(false);
    setAviso(null);
    window.setTimeout(() => buscador.current?.focus(), 50);
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
    setLineas((actuales) => {
      const siguientes = actuales.filter((linea) => linea.clave !== clave);
      if (siguientes.length === 0) {
        setDescuentoTexto('');
        setMotivoDescuento('');
      }
      return siguientes;
    });
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

  /**
   * Si la política pidió step-up, guarda la acción para reintentarla después de
   * que la dueña escriba su contraseña. Devuelve `true` para que el `catch` no
   * muestre además el error como si la operación hubiera muerto.
   */
  function pedirAutorizacion(causa: unknown, solicitud: SolicitudStepUp): boolean {
    if (
      causa instanceof ErrorNoAutorizado &&
      causa.obligaciones.includes('step_up')
    ) {
      setStepUp(solicitud);
      return true;
    }
    return false;
  }

  // ── cobro ─────────────────────────────────────────────────────────────────
  function abrirCobro(): void {
    setErrorCobro(null);
    setPagosUI([
      {
        id: siguientePago.current++,
        metodo: 'efectivo',
        monto: pesosParaEditar(total),
      },
    ]);
    setVista('cobro');
  }

  function agregarPago(): void {
    setPagosUI((actual) => [
      ...actual,
      { id: siguientePago.current++, metodo: 'tarjeta_debito', monto: '' },
    ]);
  }

  function cambiarPago(id: number, cambios: Partial<Omit<PagoUI, 'id'>>): void {
    setPagosUI((actual) =>
      actual.map((pago) => (pago.id === id ? { ...pago, ...cambios } : pago)),
    );
  }

  function quitarPago(id: number): void {
    setPagosUI((actual) =>
      actual.length <= 1 ? actual : actual.filter((pago) => pago.id !== id),
    );
  }

  function indiceUltimoEfectivo(pagos: readonly PagoUI[]): number {
    for (let indice = pagos.length - 1; indice >= 0; indice--) {
      if (pagos[indice]?.metodo === 'efectivo') return indice;
    }
    return -1;
  }

  function fijarEfectivo(monto: bigint): void {
    setPagosUI((actual) => {
      const indice = indiceUltimoEfectivo(actual);
      if (indice < 0) return actual;
      return actual.map((pago, i) =>
        i === indice ? { ...pago, monto: pesosParaEditar(monto) } : pago,
      );
    });
  }

  /**
   * «Exacto» en efectivo significa «lo que falta después de las otras formas de
   * pago», no el total: si el cliente paga $50 con tarjeta, el efectivo exacto
   * son los $80 restantes de una cuenta de $130.
   */
  function fijarEfectivoExacto(): void {
    setPagosUI((actual) => {
      const indice = indiceUltimoEfectivo(actual);
      if (indice < 0) return actual;
      const otros = actual.reduce((suma, pago, i) => {
        if (i === indice) return suma;
        return suma + (intentarCentavos(pago.monto === '' ? '0' : pago.monto) ?? 0n);
      }, 0n);
      const exacto = total > otros ? total - otros : 0n;
      return actual.map((pago, i) =>
        i === indice ? { ...pago, monto: pesosParaEditar(exacto) } : pago,
      );
    });
  }

  async function cobrar(imprimir: boolean): Promise<void> {
    if (turno === null || turno === undefined) return;
    if (lineas.length === 0) return;

    setErrorCobro(null);

    if (motivoObligatorio && motivoDescuento.trim() === '') {
      setErrorCobro(
        'Este descuento necesita un motivo: escríbelo antes de cobrar para que quede en la auditoría.',
      );
      return;
    }
    if (totalPagado < total) {
      setErrorCobro(`Falta cobrar ${pesos(falta)}.`);
      return;
    }
    if (pagadoSinEfectivo > total) {
      setErrorCobro('Los pagos con tarjeta o transferencia no pueden pasar del total.');
      return;
    }
    if (cambio > 0n && efectivoDisponible < cambio) {
      setErrorCobro('El cambio sólo puede salir del efectivo recibido.');
      return;
    }

    const pagos = pagosMinor
      .filter((pago) => pago.montoMinor > 0n)
      .map((pago) => ({ metodo: pago.metodo, montoMinor: pago.montoMinor }));
    if (pagos.length === 0) {
      setErrorCobro('Escribe cuánto se pagó.');
      return;
    }

    setCobrando(true);
    try {
      const descuentosLinea = repartirDescuento(lineas, descuento);
      const registrada = await registrarVenta(
        comoClienteTransaccional(base),
        {
          turnoId: turno.id,
          lineas: lineas.map((linea, indice) => {
            const descuentoLinea = descuentosLinea[indice] ?? 0n;
            return {
              productoId: linea.productoId,
              presentacionId: linea.presentacionId,
              qty: linea.qty,
              ...(descuentoLinea > 0n ? { descuentoMinor: descuentoLinea } : {}),
              ...(linea.esLibre
                ? {
                    descripcion: linea.nombre,
                    precioUnitarioMinor: linea.precioMinor,
                    esVentaLibre: true,
                  }
                : {}),
            };
          }),
          pagos,
          ...(motivoDescuento.trim() === '' ? {} : { motivo: motivoDescuento.trim() }),
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
      setPagosUI([]);
      setDescuentoTexto('');
      setMotivoDescuento('');
      setBusqueda('');
      setResultados([]);
      setAviso(null);
      void cargarFavoritos();

      if (imprimir) {
        window.setTimeout(() => window.print(), 200);
      }
    } catch (causa) {
      if (
        pedirAutorizacion(causa, {
          permiso: 'ventas:crear',
          descripcion:
            descuento > 0n
              ? `Cobrar ${pesos(total)} con un descuento de ${pesos(descuento)} (${descuentoPct.toFixed(2)} %).`
              : `Cobrar ${pesos(total)} de esta venta.`,
          accion: () => cobrar(imprimir),
        })
      ) {
        return;
      }
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
    setVentasTurno([]);
    setCancelacion(null);
    try {
      const cliente = comoClienteTransaccional(base);
      const [foto, movs, ventas] = await Promise.all([
        resumenTurno(cliente, turno.id),
        movimientosDelTurno(cliente, turno.id),
        ventasDelTurno(cliente, turno.id),
      ]);
      setResumen(foto);
      setMovimientos(movs);
      setVentasTurno(ventas);
      setContado(pesosParaEditar(foto.esperadoEfectivoMinor));
      setNotasCierre('');
      setMovMonto('');
      setMovConcepto('');
    } catch (causa) {
      setErrorCierre(mensajeDe(causa));
    }
  }

  async function refrescarCierre(): Promise<void> {
    if (turno === null || turno === undefined) return;
    const cliente = comoClienteTransaccional(base);
    const [foto, movs, ventas] = await Promise.all([
      resumenTurno(cliente, turno.id),
      movimientosDelTurno(cliente, turno.id),
      ventasDelTurno(cliente, turno.id),
    ]);
    setResumen(foto);
    setMovimientos(movs);
    setVentasTurno(ventas);
  }

  async function cancelar(): Promise<void> {
    if (cancelacion === null || cancelando) return;

    const motivo = cancelacion.motivo.trim();
    if (motivo === '') {
      setErrorCancelacion('Escribe por qué se cancela. No se borra nada sin explicar.');
      return;
    }

    setErrorCancelacion(null);
    setCancelando(true);
    try {
      await cancelarVenta(
        comoClienteTransaccional(base),
        { ventaId: cancelacion.ventaId, motivo },
        contexto,
      );
      await base.sincronizar();
      setCancelacion(null);
      await refrescarCierre();
    } catch (causa) {
      if (
        pedirAutorizacion(causa, {
          permiso: 'ventas:cancelar',
          descripcion: `Cancelar el ticket ${cancelacion.folioLocal} por ${pesos(
            cancelacion.totalMinor,
          )}.`,
          entidadId: cancelacion.ventaId,
          accion: cancelar,
        })
      ) {
        return;
      }
      setErrorCancelacion(mensajeDe(causa));
    } finally {
      setCancelando(false);
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
      if (
        pedirAutorizacion(causa, {
          permiso: 'turnos:retiros',
          descripcion: `Registrar ${textoTipoMovimiento(movTipo).toLowerCase()} de ${pesos(monto)}.`,
          accion: registrarMovimiento,
        })
      ) {
        return;
      }
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
      if (
        pedirAutorizacion(causa, {
          permiso: 'turnos:cerrar',
          descripcion: `Cerrar el turno con ${pesos(monto)} contados.`,
          accion: cerrar,
        })
      ) {
        return;
      }
      setErrorCierre(mensajeDe(causa));
    } finally {
      setCerrando(false);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="pos-layout flex flex-col gap-3">
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
        <div className="pos-sale-grid grid min-h-0 flex-1 gap-5">
          <Buscador
            busqueda={busqueda}
            onBusqueda={setBusqueda}
            onBuscar={(evento) => void alBuscar(evento)}
            resultados={resultados}
            favoritos={favoritos}
            buscando={buscando}
            buscador={buscador}
            onAgregar={agregarFila}
            onVentaLibre={abrirVentaLibre}
            cola={cola}
            deviceId={sesion.dispositivo.id}
          />

          <Carrito
            lineas={lineas}
            subtotal={subtotal}
            descuento={descuento}
            descuentoPct={descuentoPct}
            descuentoTexto={descuentoTexto}
            motivo={motivoDescuento}
            motivoObligatorio={motivoObligatorio}
            total={total}
            onDescuento={setDescuentoTexto}
            onMotivo={setMotivoDescuento}
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
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-[var(--suave)]">
                    Formas de pago
                  </span>
                  <Boton
                    variante="secundario"
                    className="px-2.5 py-1.5 text-xs"
                    onClick={agregarPago}
                    disabled={cobrando}
                  >
                    + Agregar
                  </Boton>
                </div>

                {pagosUI.map((pago, indice) => (
                  <div key={pago.id} className="flex items-end gap-2">
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                      Método
                      <Seleccion
                        value={pago.metodo}
                        onChange={(evento) =>
                          cambiarPago(pago.id, {
                            metodo: evento.target.value as MetodoPago,
                          })
                        }
                        disabled={cobrando}
                      >
                        {METODOS.map((opcion) => (
                          <option key={opcion.valor} value={opcion.valor}>
                            {opcion.texto}
                          </option>
                        ))}
                      </Seleccion>
                    </label>
                    <label className="flex w-32 flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                      {pago.metodo === 'efectivo' ? 'Recibido' : 'Monto'}
                      <Entrada
                        autoFocus={indice === 0}
                        value={pago.monto}
                        onChange={(evento) => cambiarPago(pago.id, { monto: evento.target.value })}
                        placeholder="0.00"
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
                    <Boton
                      variante="secundario"
                      className="px-2.5 py-2"
                      aria-label="Quitar forma de pago"
                      onClick={() => quitarPago(pago.id)}
                      disabled={cobrando || pagosUI.length === 1}
                    >
                      ×
                    </Boton>
                  </div>
                ))}

                <div className="rounded-md border border-[var(--linea)] bg-[var(--fondo)] p-3">
                  {descuento > 0n ? (
                    <>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-[var(--suave)]">Importe</span>
                        <span>{pesos(subtotal)}</span>
                      </div>
                      <div className="flex items-baseline justify-between text-sm text-[var(--mal)]">
                        <span>Descuento ({descuentoPct.toFixed(2)} %)</span>
                        <span>− {pesos(descuento)}</span>
                      </div>
                    </>
                  ) : null}
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-[var(--suave)]">Total</span>
                    <strong className="text-base">{pesos(total)}</strong>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between text-sm">
                    <span className="text-[var(--suave)]">Pagado</span>
                    <span>{pesos(totalPagado)}</span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between border-t border-[var(--linea)] pt-1">
                    <span className="text-sm text-[var(--suave)]">
                      {cambio > 0n ? 'Cambio' : 'Falta'}
                    </span>
                    <strong className="text-xl">
                      {pesos(cambio > 0n ? cambio : falta)}
                    </strong>
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

                {pagosUI.some((pago) => pago.metodo === 'efectivo') ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Boton
                      variante="secundario"
                      className="px-2.5 py-1.5 text-xs"
                      onClick={fijarEfectivoExacto}
                      disabled={cobrando}
                    >
                      Exacto
                    </Boton>
                    {DENOMINACIONES.map((valor) => (
                      <Boton
                        key={String(valor)}
                        variante="secundario"
                        className="px-2.5 py-1.5 text-xs"
                        onClick={() => fijarEfectivo(valor)}
                        disabled={cobrando}
                      >
                        {pesos(valor)}
                      </Boton>
                    ))}
                  </div>
                ) : (
                  <Aviso tono="info">
                    El cambio sólo se puede dar en efectivo. Agrega una forma de pago en efectivo
                    si el cliente entrega de más.
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

      {libre ? (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-black/40 p-4">
          <Tarjeta className="mt-12 w-full max-w-md p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Venta libre</h2>
                <p className="text-sm text-[var(--suave)]">
                  Para copias, impresiones o servicios. No mueve inventario.
                </p>
              </div>
              <Boton
                variante="secundario"
                onClick={() => setLibre(false)}
              >
                Cerrar (Esc)
              </Boton>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={(evento) => {
                evento.preventDefault();
                agregarVentaLibre();
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                Qué se vendió
                <Entrada
                  autoFocus
                  value={libreDescripcion}
                  onChange={(evento) => setLibreDescripcion(evento.target.value)}
                  placeholder="Ej. 10 copias tamaño carta"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                  Precio por pieza o servicio
                  <Entrada
                    value={librePrecio}
                    onChange={(evento) => setLibrePrecio(evento.target.value)}
                    placeholder="2.50"
                    inputMode="decimal"
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                  Cantidad
                  <Entrada
                    value={libreCantidad}
                    onChange={(evento) => setLibreCantidad(evento.target.value)}
                    inputMode="numeric"
                  />
                </label>
              </div>

              {errorLibre === null ? null : <Aviso tono="mal">{errorLibre}</Aviso>}

              <Boton type="submit" className="mt-1">
                Agregar al carrito
              </Boton>
            </form>
          </Tarjeta>
        </div>
      ) : null}

      {cancelacion === null ? null : (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-black/50 p-4">
          <Tarjeta className="mt-16 w-full max-w-md p-5">
            <h2 className="text-lg font-semibold">Cancelar venta</h2>
            <p className="mt-1 text-sm text-[var(--suave)]">
              Ticket <strong className="font-mono text-[var(--texto)]">{cancelacion.folioLocal}</strong>{' '}
              por {pesos(cancelacion.totalMinor)}. El stock vuelve y la venta sale del arqueo.
            </p>

            <label className="mt-4 flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
              Motivo (obligatorio)
              <Entrada
                autoFocus
                value={cancelacion.motivo}
                onChange={(evento) =>
                  setCancelacion({ ...cancelacion, motivo: evento.target.value })
                }
                placeholder="Ej. se cobró dos veces"
              />
            </label>

            {errorCancelacion === null ? null : (
              <Aviso tono="mal" className="mt-3">
                {errorCancelacion}
              </Aviso>
            )}

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Boton
                variante="peligro"
                className="flex-1"
                onClick={() => void cancelar()}
                disabled={cancelando || cancelacion.motivo.trim() === ''}
              >
                {cancelando ? 'Cancelando…' : 'Cancelar la venta'}
              </Boton>
              <Boton
                variante="secundario"
                className="flex-1"
                onClick={() => setCancelacion(null)}
                disabled={cancelando}
              >
                Volver
              </Boton>
            </div>
          </Tarjeta>
        </div>
      )}

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
                <h3 className="text-sm font-semibold">Ventas del turno</h3>
                <p className="mb-2 text-xs text-[var(--suave)]">
                  Cancelar devuelve el stock y saca la venta del arqueo. Queda registrado quién
                  la canceló y por qué; no se borra.
                </p>
                {ventasTurno.length === 0 ? (
                  <p className="text-xs text-[var(--suave)]">Todavía no hay ventas en este turno.</p>
                ) : (
                  <ul className="divide-y divide-[var(--linea)] text-sm">
                    {ventasTurno.map((fila) => (
                      <li
                        key={fila.ventaId}
                        className="flex items-center justify-between gap-2 py-1.5"
                      >
                        <span className="min-w-0">
                          <span className="font-mono font-medium">{fila.folioLocal}</span>{' '}
                          <span className="text-[var(--suave)]">
                            {new Date(fila.ocurridoAt).toLocaleTimeString('es-MX', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono">{pesos(fila.totalMinor)}</span>
                          {fila.estado === 'completada' ? (
                            <Boton
                              variante="peligro"
                              className="px-2.5 py-1 text-xs"
                              onClick={() => {
                                setErrorCancelacion(null);
                                setCancelacion({
                                  ventaId: fila.ventaId,
                                  folioLocal: fila.folioLocal,
                                  totalMinor: fila.totalMinor,
                                  motivo: '',
                                });
                              }}
                            >
                              Cancelar
                            </Boton>
                          ) : (
                            <span className="text-xs text-[var(--mal)]">Cancelada</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

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

      {stepUp === null ? null : (
        <DialogoStepUp
          base={base}
          sesion={sesion}
          permiso={stepUp.permiso}
          descripcion={stepUp.descripcion}
          {...(stepUp.entidadId === undefined ? {} : { entidadId: stepUp.entidadId })}
          onCancelar={() => setStepUp(null)}
          onAutorizado={async () => {
            const accion = stepUp.accion;
            setStepUp(null);
            await accion();
          }}
        />
      )}
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
  favoritos,
  buscando,
  buscador,
  onAgregar,
  onVentaLibre,
  cola,
  deviceId,
}: {
  readonly busqueda: string;
  readonly onBusqueda: (valor: string) => void;
  readonly onBuscar: (evento: React.FormEvent) => void;
  readonly resultados: readonly FilaProducto[];
  readonly favoritos: readonly FilaProducto[];
  readonly buscando: boolean;
  readonly buscador: React.RefObject<HTMLInputElement | null>;
  readonly onAgregar: (fila: FilaProducto) => void;
  readonly onVentaLibre: () => void;
  readonly cola: ColaEscaneo;
  readonly deviceId: string;
}) {
  return (
    <Tarjeta className="flex min-h-[28rem] flex-col p-4 sm:p-5">
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Boton
          variante="secundario"
          className="px-2.5 py-1.5 text-xs"
          onClick={onVentaLibre}
        >
          Venta libre: copias o servicio (F4)
        </Boton>
      </div>
      <CamaraEscaner cola={cola} />
      <ConectorEscanerMovil cola={cola} deviceId={deviceId} />

      {busqueda.trim() === '' && favoritos.length > 0 ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--suave)]">
            Productos disponibles ({favoritos.length})
          </p>
          <div className="mt-2 grid min-h-0 grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {favoritos.map((fila) => (
              <button
                key={fila.id}
                type="button"
                onClick={() => onAgregar(fila)}
                className="flex min-h-28 flex-col items-start justify-between rounded-lg border border-[var(--linea)] bg-[var(--fondo)] p-3 text-left transition hover:border-[var(--acento)] hover:bg-[var(--tarjeta)] focus:outline-none focus:ring-2 focus:ring-[var(--acento)]"
              >
                <span className="w-full break-words text-sm font-semibold leading-tight">
                  {fila.nombre}
                </span>
                <span className="mt-2 w-full text-xs text-[var(--suave)]">
                  Stock: {fila.stock} {fila.unidadAbreviatura}
                </span>
                <span className="mt-1 font-mono text-base font-semibold">
                  {pesos(fila.precioMinor)}
                </span>
                <span className="mt-1 w-full truncate text-[11px] text-[var(--suave)]">
                  {fila.codigo ?? 'sin código'}
                </span>
                <span className="mt-2 w-full rounded-md bg-[var(--acento)] px-2 py-1.5 text-center text-xs font-semibold text-white">
                  Agregar
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {buscando ? (
        <p className="mt-3 text-xs text-[var(--suave)]">Buscando…</p>
      ) : resultados.length === 0 ? (
        busqueda.trim() === '' ? (
          <div className="mt-4 flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--linea)] p-8 text-center text-sm text-[var(--suave)]">
            El carrito está listo. Escanea el primer producto o búscalo por nombre.
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--suave)]">Sin coincidencias.</p>
        )
      ) : (
        <ul className="mt-3 grid max-h-[calc(100dvh-23rem)] flex-1 grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {resultados.map((fila) => (
            <li key={fila.id}>
              <button
                type="button"
                onClick={() => onAgregar(fila)}
                className="flex min-h-28 h-full w-full flex-col items-start justify-between rounded-lg border border-[var(--linea)] bg-[var(--fondo)] p-3 text-left transition hover:border-[var(--acento)] hover:bg-[var(--tarjeta)] focus:outline-none focus:ring-2 focus:ring-[var(--acento)]"
              >
                <span className="w-full break-words text-sm font-semibold leading-tight">{fila.nombre}</span>
                <span className="mt-2 text-xs text-[var(--suave)]">
                  Stock: {fila.stock} {fila.unidadAbreviatura}
                </span>
                <span className="mt-1 font-mono text-base font-semibold">{pesos(fila.precioMinor)}</span>
                <span className="mt-1 w-full truncate text-[11px] text-[var(--suave)]">
                  {fila.codigo ?? 'sin código'}
                </span>
                <span className="mt-2 w-full rounded-md bg-[var(--acento)] px-2 py-1.5 text-center text-xs font-semibold text-white">
                  Agregar
                </span>
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
  subtotal,
  descuento,
  descuentoPct,
  descuentoTexto,
  motivo,
  motivoObligatorio,
  total,
  onDescuento,
  onMotivo,
  onCantidad,
  onQuitar,
  onCobrar,
}: {
  readonly lineas: readonly LineaCarrito[];
  readonly subtotal: bigint;
  readonly descuento: bigint;
  readonly descuentoPct: number;
  readonly descuentoTexto: string;
  readonly motivo: string;
  readonly motivoObligatorio: boolean;
  readonly total: bigint;
  readonly onDescuento: (texto: string) => void;
  readonly onMotivo: (texto: string) => void;
  readonly onCantidad: (clave: string, qty: number) => void;
  readonly onQuitar: (clave: string) => void;
  readonly onCobrar: () => void;
}) {
  return (
    <Tarjeta className="pos-cart flex min-h-[24rem] flex-col p-4 sm:p-5">
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
        <ul className="mt-3 max-h-[19rem] flex-1 divide-y divide-[var(--linea)] overflow-y-auto pr-1 xl:max-h-none">
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

      <div className="mt-3 border-t border-[var(--linea)] bg-[var(--tarjeta)] pt-3">
        {lineas.length === 0 ? null : (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
              Descuento de la venta ($)
              <Entrada
                value={descuentoTexto}
                onChange={(evento) => onDescuento(evento.target.value)}
                placeholder="0.00"
                inputMode="decimal"
              />
            </label>
            {descuento > 0n ? (
              <>
                <div className="mt-2 flex items-baseline justify-between text-sm">
                  <span className="text-[var(--suave)]">Importe</span>
                  <span className="font-mono">{pesos(subtotal)}</span>
                </div>
                <div className="flex items-baseline justify-between text-sm text-[var(--mal)]">
                  <span>Descuento ({descuentoPct.toFixed(2)} %)</span>
                  <span className="font-mono">− {pesos(descuento)}</span>
                </div>
                <label className="mt-2 flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
                  Motivo del descuento{motivoObligatorio ? ' (obligatorio)' : ' (opcional)'}
                  <Entrada
                    value={motivo}
                    onChange={(evento) => onMotivo(evento.target.value)}
                    placeholder="Cliente frecuente, producto con detalle…"
                  />
                </label>
              </>
            ) : null}
          </>
        )}
        <div className="mt-3 flex items-baseline justify-between">
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

/**
 * Reparte un descuento de venta entre las líneas, sin pasarse del bruto de
 * ninguna. El redondeo se queda en las últimas líneas, no se pierde: la suma de
 * los descuentos de línea tiene que ser exactamente el descuento que vio el
 * cliente, porque de ahí sale el total del ticket y la regla P11.
 */
function repartirDescuento(
  lineas: readonly LineaCarrito[],
  descuento: bigint,
): bigint[] {
  const brutos = lineas.map((linea) => porCantidad(linea.precioMinor, linea.qty));
  const base = brutos.reduce((suma, bruto) => suma + bruto, 0n);
  const resultado = brutos.map(() => 0n);
  if (descuento <= 0n || base <= 0n) return resultado;

  let restante = descuento;
  for (let i = 0; i < lineas.length && restante > 0n; i++) {
    const bruto = brutos[i] ?? 0n;
    const capacidadRestante = brutos
      .slice(i + 1)
      .reduce((suma, valor) => suma + valor, 0n);
    const minimo = restante > capacidadRestante ? restante - capacidadRestante : 0n;
    const proporcional = (bruto * descuento) / base;
    const parte = minimo > proporcional ? minimo : proporcional;
    const acotada = parte > bruto ? bruto : parte > restante ? restante : parte;
    resultado[i] = acotada;
    restante -= acotada;
  }

  return resultado;
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
