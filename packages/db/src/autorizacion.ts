/**
 * AUTORIZACIÓN CONTRA LA BASE — el puente entre `policies` y `evaluar()`.
 *
 * `evaluar()` es puro: recibe un contexto, las políticas y los permisos. Este archivo es
 * quien los junta, en este orden:
 *
 *   1. ¿Qué permisos tiene este usuario AHORA? (`user_roles` con `expira_at` filtrado, y
 *      `role_permissions`). Los roles de temporada se revocan solos: el día que expiran,
 *      dejan de contar sin que nadie se acuerde de quitarlos.
 *   2. ¿Qué políticas están vigentes? (`policies` activas), validadas al cargarlas.
 *   3. ¿Hay autorización reciente para ESTA acción y ESTE objeto? (`step_up_grants`).
 *   4. ¿Le falta algún dato al contexto para poder decidir? Y si le falta, se lanza.
 *   5. `evaluar(...)`.
 *
 * Y todo dentro de la transacción del evento, que es la parte que importa:
 * `emitirEvento()` lo llama entre el `BEGIN` y el `COMMIT`, así que las políticas y los
 * permisos que deciden son los mismos que verá el commit. Fuera de la transacción, entre
 * decidir y escribir cabe un cambio de rol.
 *
 * ─── DOS COSAS QUE NO SON OBVIAS ───────────────────────────────────────────
 *
 * **Los permisos sensibles se materializan como una política.** `permissions.es_sensible`
 * significa "exige step-up por defecto", y `evaluar()` recibe sólo una lista de claves de
 * permiso: no hay dónde meter ese "por defecto" sin cambiarle la firma, que es la que fija
 * el doc 06 §9. Así que aquí se convierte en una política sintética para el permiso
 * concreto (`SENSIBLE:<clave>`, prioridad 900). Se hace así, y no ignorando la columna,
 * porque el comentario de 0002 dice que esa columna significa algo; si no significara nada,
 * `config:editar` no pediría autorización y el esquema estaría mintiendo.
 *
 * **El contexto tiene que traer lo que las políticas preguntan.** `camposFaltantes()` saca
 * la lista de campos que necesitan las políticas aplicables, y si falta alguno se lanza un
 * error que los nombra. Sin esto, olvidar `recurso.descuento_pct` en una venta apagaría
 * P10 en silencio: la venta pasaría sin pedir la autorización del dueño y nadie se
 * enteraría. Es la única forma de que "un campo olvidado" sea un error y no un agujero.
 */

import {
  camposFaltantes,
  evaluar,
  type AtributosAccion,
  type AtributosEntorno,
  type AtributosRecurso,
  type AtributosSujeto,
  type ContextoPolitica,
  type Decision,
  type Politica,
  type TipoRecurso,
} from '@papeleria/core';
import { validarPolitica } from '@papeleria/core';
import type { ClienteSql } from './runner';

/** Una política de `policies` que no pasa la validación. */
export class ErrorPoliticasInvalidas extends Error {
  readonly problemas: readonly string[];

  constructor(problemas: readonly string[]) {
    super(
      `Hay ${problemas.length} problema(s) en la tabla \`policies\`:\n  ` +
        problemas.join('\n  '),
    );
    this.name = 'ErrorPoliticasInvalidas';
    this.problemas = problemas;
  }
}

/** Al contexto le faltan datos que las políticas vigentes necesitan para decidir. */
export class ErrorContextoIncompleto extends Error {
  readonly campos: readonly string[];

  constructor(campos: readonly string[], permiso: string) {
    super(
      `Para autorizar "${permiso}" faltan datos en el contexto: ${campos.join(', ')}. ` +
        `Sin ellos no se puede decidir, y decidir sin ellos apagaría una regla en silencio.`,
    );
    this.name = 'ErrorContextoIncompleto';
    this.campos = campos;
  }
}

// ─────────────────────────────── CARGA ───────────────────────────────

interface FilaPolitica {
  id: string;
  version: number;
  prioridad: number;
  efecto: string;
  aplica_a: unknown;
  condicion: unknown;
  obligaciones: unknown;
  motivo: string;
  activa: boolean;
}

/**
 * Las políticas vigentes, validadas.
 *
 * Valida en cada carga y no sólo una vez al arrancar. El coste es despreciable (30 árboles
 * pequeños) y la alternativa —una caché que hay que invalidar cuando alguien edita las
 * reglas— es una forma conocida de acabar evaluando con reglas viejas, que es justo el
 * error que el doc 06 §8 llama clásico.
 *
 * Un problema de validación **lanza**, no se salta la fila: una política que no se puede
 * evaluar es una política que no protege, y seguir adelante con las demás daría un sistema
 * que parece configurado y no lo está.
 */
export async function cargarPoliticas(cliente: ClienteSql): Promise<Politica[]> {
  const { rows } = await cliente.query<FilaPolitica>(
    `SELECT id, version, prioridad, efecto, aplica_a, condicion, obligaciones, motivo, activa
       FROM policies
      WHERE activa AND deleted_at IS NULL
      ORDER BY prioridad, id`,
  );

  const problemas = rows.flatMap((fila) => validarPolitica(fila));
  if (problemas.length > 0) throw new ErrorPoliticasInvalidas(problemas);

  // Ya validado: cada fila tiene la forma de `Politica`. El orden viene de la consulta,
  // pero `evaluar()` vuelve a ordenar por prioridad, porque no depende de que la consulta
  // lo haga bien.
  return rows as unknown as Politica[];
}

/**
 * Las claves de permiso vigentes del usuario.
 *
 * `expira_at` se filtra aquí y no al asignar el rol: así el rol de temporada se revoca solo
 * el día que toca, sin depender de que alguien se acuerde (doc 06 §3.1).
 */
export async function cargarPermisos(
  cliente: ClienteSql,
  usuarioId: string,
): Promise<string[]> {
  const { rows } = await cliente.query<{ clave: string }>(
    `SELECT DISTINCT p.clave
       FROM user_roles ur
       JOIN roles r             ON r.id  = ur.role_id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p       ON p.id  = rp.permission_id
      WHERE ur.user_id = $1
        AND (ur.expira_at IS NULL OR ur.expira_at > now())
        AND r.deleted_at IS NULL
      ORDER BY p.clave`,
    [usuarioId],
  );

  return rows.map((fila) => fila.clave);
}

/** Las claves de los roles vigentes. No decide nada: es para el contexto y la auditoría. */
export async function cargarRoles(cliente: ClienteSql, usuarioId: string): Promise<string[]> {
  const { rows } = await cliente.query<{ clave: string }>(
    `SELECT r.clave
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND (ur.expira_at IS NULL OR ur.expira_at > now())
        AND r.deleted_at IS NULL
      ORDER BY r.clave`,
    [usuarioId],
  );

  return rows.map((fila) => fila.clave);
}

/**
 * ¿Hay autorización reciente para esta acción sobre este objeto?
 *
 * El `motivo` de `step_up_grants` guarda el permiso que la disparó, y `entidad_id` el
 * objeto. Eso es lo que hace que autorizar una cancelación **no** autorice "cualquier cosa
 * durante 5 minutos" (doc 06 §6): sin `entidadId`, el otorgamiento cubriría la acción
 * entera, que es una decisión deliberada de quien llama.
 *
 * Devuelve `null` si no hay ninguna vigente.
 */
export async function stepUpVigente(
  cliente: ClienteSql,
  opciones: { usuarioId: string; permiso: string; entidadId?: string },
): Promise<{ haceSegundos: number } | null> {
  const filtroEntidad = opciones.entidadId === undefined ? '' : 'AND entidad_id = $3';
  const parametros: unknown[] = [opciones.usuarioId, opciones.permiso];
  if (opciones.entidadId !== undefined) parametros.push(opciones.entidadId);

  // El tiempo lo calcula la base y no el dispositivo: `expira_at > now()` y "hace cuántos
  // segundos" tienen que salir del mismo reloj, o un dispositivo con el reloj adelantado
  // se autorizaría a sí mismo.
  const { rows } = await cliente.query<{ hace_segundos: number }>(
    `SELECT EXTRACT(EPOCH FROM (now() - otorgado_at))::int AS hace_segundos
       FROM step_up_grants
      WHERE user_id = $1
        AND motivo  = $2
        AND expira_at > now()
        ${filtroEntidad}
      ORDER BY otorgado_at DESC
      LIMIT 1`,
    parametros,
  );

  const fila = rows[0];
  return fila === undefined ? null : { haceSegundos: fila.hace_segundos };
}

/** ¿El dispositivo está emparejado y en confianza? */
export async function dispositivoConfiable(
  cliente: ClienteSql,
  dispositivoId: string,
): Promise<boolean> {
  const { rows } = await cliente.query<{ is_trusted: boolean }>(
    `SELECT is_trusted FROM devices WHERE id = $1 AND revoked_at IS NULL`,
    [dispositivoId],
  );
  return rows[0]?.is_trusted ?? false;
}

// ─────────────────────────────── DECIDIR ───────────────────────────────

/** Lo que hay que saber para autorizar una acción concreta. */
export interface EntradaAutorizacion {
  usuarioId: string;
  dispositivoId: string;
  /** El permiso que se ejerce: `'ventas:crear'`. Es `accion.permiso`. */
  permiso: string;
  /** Sobre qué se actúa. `tipo` es obligatorio: es lo que distingue una venta de un ajuste. */
  recurso: { tipo: TipoRecurso } & Partial<AtributosRecurso>;
  accion?: Partial<AtributosAccion>;
  entorno?: Partial<AtributosEntorno>;
  /** El objeto concreto, para acotar el step-up. Sin él, el step-up cubre la acción entera. */
  entidadId?: string;
  /** Reloj inyectable, en milisegundos. Sólo se usa para la hora local y el día. */
  ahora?: number;
}

/**
 * La decisión, con todo cargado de la base.
 *
 * Tiene que correr **dentro** de la transacción del evento (recibe un `ClienteSql`, que es
 * el `tx`), no antes: si se decidiera antes del `BEGIN`, entre decidir y escribir cabría un
 * cambio de rol o de política.
 */
export async function autorizar(
  tx: ClienteSql,
  entrada: EntradaAutorizacion,
): Promise<Decision> {
  const ahora = entrada.ahora ?? Date.now();

  const [permisos, roles, politicas, stepUp, confiable] = await Promise.all([
    cargarPermisos(tx, entrada.usuarioId),
    cargarRoles(tx, entrada.usuarioId),
    cargarPoliticas(tx),
    stepUpVigente(tx, {
      usuarioId: entrada.usuarioId,
      permiso: entrada.permiso,
      ...(entrada.entidadId === undefined ? {} : { entidadId: entrada.entidadId }),
    }),
    dispositivoConfiable(tx, entrada.dispositivoId),
  ]);

  const contexto = construirContexto({
    entrada,
    ahora,
    permisos,
    roles,
    tieneStepUp: stepUp !== null,
    stepUpHaceSegundos: stepUp?.haceSegundos ?? null,
    confiable,
  });

  const efectivas = [...politicas];
  if (await esPermisoSensible(tx, entrada.permiso)) {
    efectivas.push(politicaSensible(entrada.permiso));
  }

  const faltan = camposFaltantes(efectivas, contexto);
  if (faltan.length > 0) throw new ErrorContextoIncompleto(faltan, entrada.permiso);

  return evaluar(contexto, efectivas, permisos);
}

function construirContexto(datos: {
  entrada: EntradaAutorizacion;
  ahora: number;
  permisos: readonly string[];
  roles: readonly string[];
  tieneStepUp: boolean;
  stepUpHaceSegundos: number | null;
  confiable: boolean;
}): ContextoPolitica {
  const { entrada, ahora, permisos, roles } = datos;
  const reloj = new Date(ahora);

  const sujeto: AtributosSujeto = {
    user_id: entrada.usuarioId,
    roles,
    permisos,
    tiene_step_up_reciente: datos.tieneStepUp,
    step_up_hace_segundos: datos.stepUpHaceSegundos,
    dispositivo_confiable: datos.confiable,
    dispositivo_id: entrada.dispositivoId,
  };

  const entorno: AtributosEntorno = {
    // La hora del dispositivo, no UTC: "después de las 20:00" quiere decir en el mostrador.
    hora_local: reloj.getHours(),
    dia_semana: reloj.getDay(),
    // ⚠️ No hay ninguna definición de "temporada escolar" en los documentos (¿junio–agosto?
    //    ¿el calendario de la SEP?). Se deja en `false` y ninguna de las 30 políticas
    //    sembradas lo consulta: inventar aquí los meses sería meter una regla de negocio en
    //    el código, que es exactamente lo que este módulo evita.
    en_temporada_escolar: false,
    terminal_id: entrada.dispositivoId,
    es_offline: false,
    ...entrada.entorno,
  };

  return {
    sujeto,
    recurso: entrada.recurso as AtributosRecurso,
    accion: { permiso: entrada.permiso, ...entrada.accion },
    entorno,
  };
}

async function esPermisoSensible(cliente: ClienteSql, permiso: string): Promise<boolean> {
  const { rows } = await cliente.query<{ es_sensible: boolean }>(
    `SELECT es_sensible FROM permissions WHERE clave = $1`,
    [permiso],
  );
  return rows[0]?.es_sensible ?? false;
}

/**
 * El "step-up por defecto" de un permiso sensible, como política sintética.
 *
 * El id lleva el prefijo `SENSIBLE:` para que se reconozca como lo que es en el
 * `audit_log` y nunca se confunda con una fila de `policies`.
 */
function politicaSensible(permiso: string): Politica {
  return {
    id: `SENSIBLE:${permiso}`,
    version: 1,
    // Al final de la tabla: si hay una regla escrita para este permiso, su motivo es el que
    // explica la decisión; ésta sólo añade el step-up que el permiso ya pedía de por sí.
    prioridad: 900,
    efecto: 'permitir',
    aplica_a: { permiso },
    condicion: { op: 'siempre' },
    obligaciones: ['step_up'],
    motivo: `${permiso} es un permiso sensible: requiere autorización reciente.`,
    activa: true,
  };
}
