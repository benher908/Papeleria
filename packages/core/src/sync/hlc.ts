/**
 * RELOJ LÓGICO HÍBRIDO (HLC) — docs/08 §5.
 *
 * El problema que resuelve, con el caso real: al PC de la caja se le muere la
 * batería de la placa y al arrancar cree que es **1 de enero de 2010**. Un
 * `timestamptz` normal entonces miente: los reportes del día salen vacíos, las
 * ventas se ordenan antes que todo y el cierre de turno no cuadra.
 *
 * Un HLC combina dos cosas:
 *
 *   · el reloj de pared (`ts`, milisegundos) — para que las fechas sigan siendo
 *     útiles y legibles;
 *   · un contador lógico (`contador`) — para que el orden **nunca** retroceda,
 *     aunque el reloj sí lo haga.
 *
 * Propiedades que este módulo garantiza y que las pruebas fijan:
 *
 *   1. **Monótono por dispositivo.** Ningún HLC es menor que el anterior, pase lo
 *      que pase con `Date.now()`.
 *   2. **Total y consistente.** Al absorber el HLC de otro dispositivo
 *      (`hlcRecibir`), el siguiente HLC propio es mayor que todo lo visto. Así dos
 *      réplicas ordenan igual y llegan al mismo estado.
 *   3. **Ordenable como texto.** La forma serializada se compara con `<` y da el
 *      mismo resultado que comparar `(ts, contador, device)`. Eso permite guardarla
 *      en una columna `text` y usarla en `ORDER BY` sin conversiones.
 *
 * Lo que **no** es: una fuente de verdad. Para decidir cualquier cosa con efectos
 * (el stock, por ejemplo) se usa el orden del servidor (`server_seq`) y el ledger.
 * El HLC es para ordenar y para que un humano entienda qué pasó y cuándo.
 */

export interface HLC {
  /** Milisegundos del reloj de pared. Puede quedarse atrás si el reloj se atrasa. */
  ts: number;
  /** Desempate lógico dentro del mismo milisegundo. Nunca retrocede. */
  contador: number;
  /** Identificador corto del dispositivo. Sólo desempata; no es identidad. */
  device: string;
}

/**
 * Ancho fijo de cada campo al serializar. Es lo que hace que comparar texto
 * equivalga a comparar números: sin el relleno, `'z' < '10'`.
 */
export const LARGO_TS = 12;
export const LARGO_CONTADOR = 4;
export const LARGO_DEVICE = 8;

/** 4 dígitos base36: el contador válido más alto es 36⁴ − 1 = 1 679 615. */
const LIMITE_CONTADOR = 36 ** LARGO_CONTADOR;

/**
 * 12 dígitos base36. `Date.now()` ronda 1,7×10¹²: sobra por seis órdenes de magnitud.
 *
 * Se compara con `>=` contra el límite y no con `>` contra `límite − 1` por una razón
 * concreta: 36¹² = 4 738 381 338 321 616 896 supera `Number.MAX_SAFE_INTEGER`, así que
 * `36 ** 12 - 1` **se redondea a** `36 ** 12` y la comparación anterior nunca habría
 * detectado el desbordamiento.
 */
const LIMITE_TS = 36 ** LARGO_TS;

export class ErrorHLC extends Error {}

/**
 * El identificador de dispositivo que cabe en un HLC: sus primeros 8 caracteres.
 *
 * Se normaliza **al construir** el HLC y no sólo al serializarlo. Si se dejara el
 * uuid completo en memoria y se recortara al guardarlo, `compararHLC` ordenaría por
 * el uuid entero mientras el texto guardado empata en los 8 caracteres: dos formas
 * distintas de ordenar lo mismo. La forma canónica es una sola.
 */
export function deviceCorto(id: string): string {
  return id.slice(0, LARGO_DEVICE);
}

/**
 * El siguiente HLC de este dispositivo, a partir del último emitido.
 *
 * Si el reloj de pared avanzó, se usa tal cual y el contador vuelve a 0. Si no
 * avanzó (mismo milisegundo) o **retrocedió**, se conserva el `ts` anterior y se
 * incrementa el contador: el tiempo lógico nunca da marcha atrás.
 */
export function hlcAhora(anterior: HLC | null, device: string, ahora: number = Date.now()): HLC {
  const d = deviceCorto(device);
  if (anterior === null) return { ts: ahora, contador: 0, device: d };

  if (ahora <= anterior.ts) {
    const contador = anterior.contador + 1;
    if (contador >= LIMITE_CONTADOR) {
      // Hacen falta millones de eventos en el mismo milisegundo para llegar aquí.
      // Antes que bloquear una venta, se adelanta el reloj lógico 1 ms: se pierde
      // la fidelidad al reloj de pared, no la monotonía, que es lo único esencial.
      return { ts: anterior.ts + 1, contador: 0, device: d };
    }
    return { ts: anterior.ts, contador, device: d };
  }

  return { ts: ahora, contador: 0, device: d };
}

/**
 * Absorbe el HLC de otro dispositivo. Tras esto, el próximo HLC propio será mayor
 * que el local y que el remoto — y también que el reloj de pared, si éste va atrasado.
 *
 * Sin este paso, dos dispositivos podrían emitir eventos con el mismo `ts` y el
 * orden entre ellos dependería de quién mira.
 */
export function hlcRecibir(
  local: HLC | null,
  remoto: HLC,
  device: string,
  ahora: number = Date.now(),
): HLC {
  const d = deviceCorto(device);
  if (local === null) return hlcAhora(remoto, d, ahora);

  const ts = Math.max(local.ts, remoto.ts, ahora);

  let contador: number;
  if (ts === local.ts && ts === remoto.ts) {
    contador = Math.max(local.contador, remoto.contador) + 1;
  } else if (ts === local.ts) {
    contador = local.contador + 1;
  } else if (ts === remoto.ts) {
    contador = remoto.contador + 1;
  } else {
    contador = 0;
  }

  if (contador >= LIMITE_CONTADOR) return { ts: ts + 1, contador: 0, device: d };
  return { ts, contador, device: d };
}

/**
 * Forma canónica: `'00a1b2c3d4e-0000-a3f9'`.
 *
 * El identificador del dispositivo se recorta a 8 caracteres porque sólo desempata.
 * Eso tiene una consecuencia que conviene tener escrita: dos HLC deserializados
 * **no** recuperan el `device` completo. Si se necesita el dispositivo, está en
 * `event_log.device_id`.
 */
export function hlcSerializar(hlc: HLC): string {
  if (!Number.isInteger(hlc.ts) || hlc.ts < 0) {
    throw new ErrorHLC(`ts inválido: ${hlc.ts}`);
  }
  if (hlc.ts >= LIMITE_TS) {
    // Si el ts no cabe en 12 caracteres, el texto crece y deja de ordenarse solo.
    // Es mejor un error aquí que un HLC que ordena mal dentro de seis meses.
    throw new ErrorHLC(`ts fuera de rango para un HLC: ${hlc.ts}`);
  }
  if (!Number.isInteger(hlc.contador) || hlc.contador < 0 || hlc.contador >= LIMITE_CONTADOR) {
    throw new ErrorHLC(`contador inválido: ${hlc.contador}`);
  }
  if (hlc.device === '') throw new ErrorHLC('El dispositivo no puede ir vacío en un HLC');

  return [
    hlc.ts.toString(36).padStart(LARGO_TS, '0'),
    hlc.contador.toString(36).padStart(LARGO_CONTADOR, '0'),
    deviceCorto(hlc.device),
  ].join('-');
}

const FORMATO_SERIALIZADO = /^[0-9a-z]{12}-[0-9a-z]{4}-[0-9a-z]+$/;

/** El inverso de `hlcSerializar`, validando la forma. */
export function hlcDeserializar(texto: string): HLC {
  if (!FORMATO_SERIALIZADO.test(texto)) {
    throw new ErrorHLC(`HLC con formato inválido: "${texto}"`);
  }
  const [ts, contador, device] = texto.split('-');
  // El regex garantiza las tres partes, pero TypeScript no lo sabe.
  if (ts === undefined || contador === undefined || device === undefined) {
    throw new ErrorHLC(`HLC incompleto: "${texto}"`);
  }
  return {
    ts: parseInt(ts, 36),
    contador: parseInt(contador, 36),
    device,
  };
}

/**
 * Orden lógico. Devuelve negativo si `a` va antes que `b`.
 *
 * Nota deliberada: esto es lo mismo que comparar `hlcSerializar(a)` con
 * `hlcSerializar(b)`; hay una prueba que fija esa equivalencia. Se ofrece la
 * función para no obligar a cada llamador a recordar por qué el texto se ordena.
 */
export function compararHLC(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.contador !== b.contador) return a.contador < b.contador ? -1 : 1;
  const da = deviceCorto(a.device);
  const db = deviceCorto(b.device);
  if (da === db) return 0;
  return da < db ? -1 : 1;
}
