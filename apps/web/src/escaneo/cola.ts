/**
 * La cola de escaneo: **un solo punto de entrada** para todo código que se lea.
 *
 * Da igual de dónde venga —un lector HID, el celular por WebSocket, el teclado o la
 * búsqueda—: todo pasa por aquí y llega a la pantalla con el mismo formato. Es lo que
 * hace que cambiar de lector a celular no obligue a tocar la caja (docs/04 §6), y lo que
 * evitará que el POS tenga cuatro caminos distintos de "llegó un código".
 *
 * Hoy sólo hay un emisor, el lector HID (`hid.ts`). El celular llega en F5 y la búsqueda
 * manual con el carrito en F2; ninguno necesita cambiar esto.
 *
 * `origen` no es decorativo: la caja necesita saberlo para decidir. Un escaneo del
 * celular puede llegar duplicado por reconexión; uno del HID, no. Y el modo conteo
 * quiere distinguir lo que contó una persona de lo que leyó una máquina.
 */

export type OrigenEscaneo = 'hid' | 'celular' | 'manual' | 'busqueda' | 'conteo';

export interface EventoEscaneo {
  readonly codigo: string;
  readonly origen: OrigenEscaneo;
  /** ISO 8601, en el reloj del dispositivo. */
  readonly leido_at: string;
  /** Si el lector lo dijo (Code 128, EAN-13…). El HID no lo sabe: es un teclado. */
  readonly symbology?: string;
  /** Sólo el HID: milisegundos por carácter de la ráfaga. Sirve para diagnosticar. */
  readonly ms_por_caracter?: number;
}

export type OyenteEscaneo = (evento: EventoEscaneo) => void;

export interface ColaEscaneo {
  /** Publica un escaneo. Lo llaman los adaptadores (HID ahora; celular en F5). */
  emitir(evento: EventoEscaneo): void;
  /** Se suscribe a los escaneos. Devuelve cómo darse de baja. */
  alEscanear(oyente: OyenteEscaneo): () => void;
}

/**
 * Una cola, con sus oyentes.
 *
 * Es una fábrica y no un módulo con estado global para que cada sesión tenga la suya:
 * al salir se tira la cola y con ella sus suscripciones, en vez de dejar oyentes vivos
 * apuntando a una pantalla que ya no existe.
 */
export function crearColaEscaneo(): ColaEscaneo {
  const oyentes = new Set<OyenteEscaneo>();

  return {
    emitir(evento) {
      for (const oyente of oyentes) {
        // Un oyente que revienta no puede tumbar el escaneo ni a los demás.
        try {
          oyente(evento);
        } catch (causa) {
          console.error('[escaneo] un oyente falló; el escaneo sigue', causa);
        }
      }
    },

    alEscanear(oyente) {
      oyentes.add(oyente);
      return () => {
        oyentes.delete(oyente);
      };
    },
  };
}
