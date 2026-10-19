/**
 * `emitirEvento()` — EL ÚNICO CAMINO DE MUTACIÓN (docs/08 §2.1).
 *
 * Toda escritura del negocio pasa por aquí. Una venta, un ajuste de stock, un cambio
 * de precio: estado + evento, en **una sola transacción**. Si algo se puede escribir
 * sin pasar por aquí, la sincronización tiene un agujero, porque el cambio existe en
 * el dispositivo y nadie se enteró de que había que contarlo.
 *
 * El patrón se llama *outbox* transaccional y resuelve un fallo muy concreto:
 *
 *   ❌ await insertarVenta();          // 1. el estado quedó guardado
 *      await encolarEvento();          // 2. ⚠️ si aquí se corta la luz,
 *                                     //    la venta existe y NUNCA se sincroniza.
 *
 *   ✅ await emitirEvento(...);       // o entra todo, o no entra nada.
 *
 * Con PGlite en el navegador son transacciones de Postgres de verdad, así que el
 * comportamiento es idéntico al del servidor. No es una emulación.
 *
 * ── Por qué este archivo está en `@papeleria/db` y no en `@papeleria/core` ──
 *
 * docs/08 §2.1 lo ubica en `packages/core/src/usecases/`. Vive aquí porque es SQL
 * contra este esquema: conoce `outbox`, `audit_log`, `device_counters`. Ponerlo en
 * `core` obligaría al núcleo (que hoy no sabe de bases de datos) a conocer nombres de
 * tablas. Lo puro que necesita —ULID y HLC— sí está en `core`, que es donde debe.
 *
 * ── Dos correcciones al boceto de docs/08 §2.1 ──
 *
 * 1. El boceto llama a `aplicarEstado(tx)` sin argumentos, pero `sales.evento_id` es
 *    NOT NULL y tiene que coincidir con el `event_id` del outbox. Aquí el estado
 *    recibe el evento ya completo.
 * 2. El boceto evalúa las políticas ANTES del `BEGIN`. Aquí se evalúan dentro, para
 *    que las políticas que deciden sean las mismas que verá el commit: fuera, entre
 *    decidir y escribir cabe un cambio de política.
 */

import {
  hlcDeserializar,
  hlcRecibir,
  hlcSerializar,
  type HLC,
  ulid,
  uuidV7,
} from '@papeleria/core';
import { siguienteSeqYHlc } from './contadores';
import type { ClienteSql, ClienteTransaccional } from './runner';

/**
 * El evento tal como se guarda en `outbox.payload` y se envía en `POST /sync/push`.
 *
 * Los nombres de campo son los de la tabla y los del protocolo a propósito: traducir
 * `type` a `tipo` en el camino sólo añade un lugar donde equivocarse. La base y el
 * cable hablan igual; el español se queda en el código que no viaja.
 */
export interface EventoEmitido<Tipo extends string = string, Payload = unknown> {
  /** ULID: único sin coordinar y ordenable por tiempo. Es la idempotencia del envío. */
  event_id: string;
  device_id: string;
  /** Consecutivo local. El servidor detecta huecos con él (docs/08 §3.1). */
  device_seq: number;
  user_id: string;
  type: Tipo;
  payload: Payload;
  /** Reloj de pared del dispositivo, en ISO-8601. Para que un humano entienda. */
  occurred_at: string;
  /** Reloj lógico híbrido. Para ordenar aunque el reloj de pared mienta. */
  hlc: string;
  schema_version: number;
}

/** Los campos del evento que ya existen antes de construir el payload. */
export type DatosDelEvento = Omit<EventoEmitido<string, unknown>, 'type' | 'payload'>;

/**
 * Cómo se construye el payload: **dentro** de la transacción.
 *
 * No es un capricho. El `folio_local` de una venta se asigna dentro de la
 * transacción para que un rollback no queme un número de ticket (un hueco en los
 * folios parece una venta borrada, y la primera pregunta de cualquier auditoría es
 * esa). Como el payload tiene que llevar ese folio, el payload se construye ahí
 * mismo, con acceso al `event_id` y al `device_id` que acaban de asignarse.
 */
export type ConstructorPayload<Payload> = (
  tx: ClienteSql,
  datos: DatosDelEvento,
) => Payload | Promise<Payload>;

/** Lo que devuelve el evaluador de políticas (tarea 0.6). */
export interface DecisionAutorizacion {
  permitido: boolean;
  /** Explicación para el usuario y para la auditoría. Nunca vacía. */
  motivo: string;
  /** P. ej. `'marcar_para_revision'`. Vacío si no hay ninguna. */
  obligaciones: readonly string[];
}

/** El evento no se emitió porque una política lo prohibió. */
export class ErrorNoAutorizado extends Error {
  readonly motivo: string;

  constructor(tipo: string, motivo: string) {
    super(`No autorizado para emitir "${tipo}": ${motivo}`);
    this.name = 'ErrorNoAutorizado';
    this.motivo = motivo;
  }
}

/** Qué se apunta en `audit_log`. Si se omite, se apunta el propio evento. */
export interface AuditoriaEmision {
  /** Por defecto, el `type` del evento. */
  accion?: string;
  entidad?: string;
  entidadId?: string;
  antes?: unknown;
  despues?: unknown;
}

export interface EntradaEmision<Tipo extends string, Payload> {
  tipo: Tipo;
  payload: ConstructorPayload<Payload>;
  dispositivoId: string;
  usuarioId: string;

  /**
   * El cambio concreto en las tablas del negocio: la venta, el movimiento de stock…
   *
   * Se ejecuta DENTRO de la transacción: hay que usar el `tx` que llega, nunca el
   * cliente de fuera, o el cambio quedaría fuera del bloque atómico.
   */
  aplicarEstado: (tx: ClienteSql, evento: EventoEmitido<Tipo, Payload>) => Promise<void>;

  /**
   * Autorización. Obligatoria, no opcional y sin valor por defecto: mientras no
   * exista `evaluar()` (tarea 0.6) el sistema no puede emitir eventos, y eso es
   * correcto — un "permitir todo" escondido en la biblioteca es exactamente la clase
   * de agujero que este diseño intenta no tener.
   */
  autorizar: (evento: EventoEmitido<Tipo, Payload>) => Promise<DecisionAutorizacion>;

  auditoria?: AuditoriaEmision;

  /** Reloj inyectable para las pruebas y para el aviso de reloj incorrecto. */
  ahora?: () => number;

  /** Versión del esquema del payload. Un evento viejo no se lee con reglas nuevas. */
  schemaVersion?: number;
}

/**
 * Emite un evento y aplica su efecto en el estado, atómicamente.
 *
 * Devuelve el evento completo: es lo que se acaba de encolar y lo que el
 * sincronizador enviará cuando haya red.
 */
export async function emitirEvento<Tipo extends string, Payload>(
  cliente: ClienteTransaccional,
  entrada: EntradaEmision<Tipo, Payload>,
): Promise<EventoEmitido<Tipo, Payload>> {
  const ahora = entrada.ahora ?? Date.now;

  return cliente.transaction(async (tx) => {
    // 1. Contadores. Van dentro de la transacción: si algo falla después, el
    //    `device_seq` se revierte con todo lo demás y no queda un hueco que el
    //    servidor reclamaría para siempre.
    const { seq, hlc } = await siguienteSeqYHlc(tx, entrada.dispositivoId, ahora());

    const datos: DatosDelEvento = {
      event_id: ulid(ahora()),
      device_id: entrada.dispositivoId,
      device_seq: seq,
      user_id: entrada.usuarioId,
      occurred_at: new Date(ahora()).toISOString(),
      hlc,
      schema_version: entrada.schemaVersion ?? 1,
    };

    // 2. El payload, ya con el `event_id` a la vista (lo necesita `sales.evento_id`)
    //    y con el mismo `tx` (lo necesita `siguienteFolioLocal`).
    const payload = await entrada.payload(tx, datos);
    const evento: EventoEmitido<Tipo, Payload> = { ...datos, type: entrada.tipo, payload };

    // 3. Autorización, ANTES de tocar el estado y dentro de la transacción.
    const decision = await entrada.autorizar(evento);
    if (!decision.permitido) {
      throw new ErrorNoAutorizado(entrada.tipo, decision.motivo);
    }

    // 4. El estado. Si esto lanza, se revierte todo: evento, contadores y auditoría.
    await entrada.aplicarEstado(tx, evento);

    // 5. La cola. El payload completo incluye `device_seq`, que es el orden en que el
    //    sincronizador drena la cola.
    await tx.query('INSERT INTO outbox (id, event_id, payload) VALUES ($1, $2, $3)', [
      uuidV7(ahora()),
      evento.event_id,
      JSON.stringify(evento),
    ]);

    // 6. Auditoría. Va aquí y no en un paso aparte porque, si se pudiera olvidar, se
    //    olvidaría: es justo lo que pasa cuando auditar es responsabilidad del llamador.
    const auditoria = entrada.auditoria ?? { despues: payload };
    await tx.query(
      `INSERT INTO audit_log
         (id, user_id, device_id, accion, entidad, entidad_id, antes, despues, ocurrido_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidV7(ahora()),
        evento.user_id,
        evento.device_id,
        auditoria.accion ?? entrada.tipo,
        auditoria.entidad ?? null,
        auditoria.entidadId ?? null,
        auditoria.antes === undefined ? null : JSON.stringify(auditoria.antes),
        auditoria.despues === undefined ? null : JSON.stringify(auditoria.despues),
        evento.occurred_at,
      ],
    );

    return evento;
  });
}

/**
 * Guarda el HLC de un evento recibido para que el próximo evento propio sea mayor.
 *
 * Es la mitad de la convergencia que no se ve con un solo dispositivo: si al recibir
 * el pull no se absorbe el reloj remoto, dos réplicas pueden ordenar distinto y
 * terminar en estados distintos (docs/08 §5). La llama el sincronizador (fase F1);
 * vive aquí para que el contador tenga un solo dueño.
 */
export async function absorberHlc(
  cliente: ClienteSql,
  dispositivoId: string,
  remoto: HLC,
  ahora: number = Date.now(),
): Promise<HLC> {
  // Mismo truco de bloqueo que en `siguienteSeqYHlc`: leer y escribir el HLC tiene
  // que ser una sola operación respecto a las demás emisiones del dispositivo.
  const { rows } = await cliente.query<{ ultimo_hlc: unknown }>(
    `INSERT INTO device_counters (device_id) VALUES ($1)
     ON CONFLICT (device_id) DO UPDATE SET device_id = device_counters.device_id
     RETURNING ultimo_hlc`,
    [dispositivoId],
  );

  const fila = rows[0];
  if (fila === undefined) {
    throw new Error(`No se pudo leer el contador del dispositivo ${dispositivoId}`);
  }

  const local = typeof fila.ultimo_hlc === 'string' ? hlcDeserializar(fila.ultimo_hlc) : null;
  const absorbido = hlcRecibir(local, remoto, dispositivoId, ahora);

  await cliente.query(
    `UPDATE device_counters
        SET ultimo_hlc = $2, actualizado_at = now()
      WHERE device_id = $1`,
    [dispositivoId, hlcSerializar(absorbido)],
  );

  return absorbido;
}
