/**
 * `evaluar()` — EL ÚNICO PUNTO DE ENFORCEMENT (docs/06 §5 y §7).
 *
 * Un rol entra. Una decisión con obligaciones sale. Sin IO, sin reloj propio, sin base de
 * datos: es una función pura de `(contexto, políticas, permisos)`. Por eso el **mismo**
 * archivo corre en el PC de la caja, en el celular y en el servidor, y por eso sirve de
 * defensa en las tres capas de docs/06 §7 — en la capa del caso de uso (que es la única
 * defensa cuando no hay internet) y otra vez en el servidor, que no se fía del cliente.
 *
 * Cero condiciones de rol en el código (`if (rol === 'dueno')` está prohibido, docs/06 §8).
 * Lo que puede hacer cada rol está en `role_permissions`; aquí sólo se pregunta si el
 * permiso está.
 *
 * ── DENY-OVERRIDES ────────────────────────────────────────────────────────
 *
 * Si **alguna** política aplicable deniega, se deniega. Sin excepciones y sin importar el
 * orden. Es la decisión por defecto correcta en seguridad: con "el último gana" o "el más
 * específico gana", tarde o temprano una regla nueva abre un hueco que otra ya había
 * cerrado, y no te enteras. Con deny-overrides, añadir reglas **sólo puede restringir**.
 *
 * Las obligaciones, en cambio, se **acumulan** (si una pide PIN y otra pide motivo, se
 * piden las dos). Con deny-overrides eso es seguro: no hay nada que "quite" una obligación.
 *
 * ── DOS CORRECCIONES AL BOCETO DE docs/06 §5 ──────────────────────────────
 *
 * 1. **El `step_up` se resuelve en un solo lugar, no en la condición de cada regla.**
 *    El boceto escribe en P10 la cláusula `tiene_step_up_reciente == false` junto a la
 *    del descuento. Funciona para P10, que sólo pide `step_up`... pero rompe P11, cuyo
 *    caso es "descuento > 30 % o mayor a $200" y que pide además `motivo_obligatorio` y
 *    `notificar_dueno`: al teclear el PIN, la cláusula deja de cumplirse, la política
 *    deja de aplicar y **las otras dos obligaciones desaparecen con ella**. El dueño
 *    autoriza y la venta se registra sin motivo y sin aviso.
 *
 *    Aquí la política no menciona el step-up y el evaluador quita la obligación cuando
 *    ya está satisfecha (una línea, más abajo). Cada regla se ocupa de lo suyo y P11 hace
 *    lo que dice. Encaja además con cómo está definido el step-up en docs/06 §6: vale 5
 *    minutos y usos ilimitados dentro de la ventana, o sea que **está pensado para
 *    satisfacerse y dejar de pedirse**; el acotado a la acción y al objeto lo hace quien
 *    construye el contexto, que es quien consulta `step_up_grants`.
 *
 * 2. **El motivo que se devuelve es el de la primera política aplicable**, no el de la
 *    última (`aplicables.at(-1)`). Con deny-overrides el orden no cambia la decisión, sólo
 *    cuál de los motivos se muestra; y el que explica algo es el más específico —el que
 *    se evalúa primero—, no el más general, que es el que el boceto elegía.
 */

import { camposDeLaCondicion, evaluarCondicion, validarCondicion } from './condicion';
import { leerCampo } from './campos';
import {
  OBLIGACIONES,
  OPERADORES_COMPARACION,
  TIPOS_RECURSO,
  type AplicaA,
  type ContextoPolitica,
  type Decision,
  type Obligacion,
  type Politica,
} from './tipos';

/** ¿Este patrón de permiso cubre este permiso? `'ventas:*'` cubre `'ventas:crear'`. */
export function coincidePermiso(patron: string, permiso: string): boolean {
  if (patron === '*') return true;

  // Tres formas, y sólo tres: `*`, `recurso:*` y `recurso:accion`. Es la misma lista que
  // acepta `validarPolitica`. Tener aquí una coincidencia por prefijo más permisiva que la
  // validación sería una puerta trasera silenciosa: `'ventas:cre'` (un permiso truncado)
  // cubriría `ventas:crear` y la revisión no lo vería.
  const corte = patron.indexOf(':');
  if (corte === -1) return patron === permiso;

  const accion = patron.slice(corte + 1);
  if (accion !== '*') return patron === permiso;

  const corteDelPermiso = permiso.indexOf(':');
  return corteDelPermiso !== -1 && permiso.slice(0, corteDelPermiso) === patron.slice(0, corte);
}

/** ¿Esta política habla de esta acción? `aplica_a` vacío significa "de todo". */
export function coincideAplica(aplicaA: AplicaA, ctx: ContextoPolitica): boolean {
  if (aplicaA.permiso !== undefined && !coincidePermiso(aplicaA.permiso, ctx.accion.permiso)) {
    return false;
  }
  if (aplicaA.recurso !== undefined && aplicaA.recurso !== ctx.recurso.tipo) {
    return false;
  }
  return true;
}

/**
 * La decisión. Ver el encabezado para las reglas y las dos correcciones al boceto.
 *
 * `permisosDelRol` viene de `role_permissions` (con `user_roles.expira_at` ya filtrado):
 * los roles de temporada se revocan solos y no llegan aquí.
 */
export function evaluar(
  ctx: ContextoPolitica,
  politicas: readonly Politica[],
  permisosDelRol: readonly string[],
): Decision {
  const permiso = ctx.accion.permiso;

  // 1. LA PUERTA GRUESA (RBAC). Sin permiso no hay nada más que hablar: ni las políticas
  //    se miran. Es lo que impide que una regla ABAC "conceda" de más.
  if (!permisosDelRol.includes(permiso) && !permisosDelRol.includes('*')) {
    return { permitido: false, motivo: `El rol no incluye ${permiso}`, obligaciones: [] };
  }

  // 2. LAS REGLAS FINAS (ABAC). La condición indeterminada (`null`) se resuelve por
  //    efecto: deja pasar la denegación (fallar cerrado) y no deja pasar el permiso.
  //    Ver `condicion.ts`.
  const aplicables = politicas
    .filter((politica) => politica.activa && coincideAplica(politica.aplica_a, ctx))
    .map((politica) => ({ politica, resultado: evaluarCondicion(politica.condicion, ctx) }))
    .filter(
      ({ politica, resultado }) =>
        resultado === true || (resultado === null && politica.efecto === 'denegar'),
    )
    .sort((a, b) => a.politica.prioridad - b.politica.prioridad);

  // 3. DENY-OVERRIDES: una sola denegación basta, y gana sobre cualquier permiso.
  const denegacion = aplicables.find(({ politica }) => politica.efecto === 'denegar');
  if (denegacion !== undefined) {
    const incompleto = denegacion.resultado === null;
    return {
      permitido: false,
      motivo: incompleto
        ? `${denegacion.politica.motivo} (se aplicó sin poder evaluar su condición: al contexto le falta algún dato)`
        : denegacion.politica.motivo,
      obligaciones: [],
      politica_id: denegacion.politica.id,
      porContextoIncompleto: incompleto || undefined,
    };
  }

  // 4. Las obligaciones de TODAS las aplicables, acumuladas y sin repetir. Se devuelven en
  //    el orden del catálogo y no en el que salgan las políticas: un registro de auditoría
  //    que cambia de orden porque alguien reordenó prioridades es un registro que no se
  //    puede comparar consigo mismo.
  const acumuladas = new Set<Obligacion>();
  for (const { politica } of aplicables) {
    for (const obligacion of politica.obligaciones) acumuladas.add(obligacion);
  }

  // El step-up ya satisfecho deja de pedirse (corrección 1 del encabezado). Las demás
  // obligaciones no se tocan: escribir el motivo y avisar al dueño sigue haciendo falta.
  if (ctx.sujeto.tiene_step_up_reciente) acumuladas.delete('step_up');

  const principal = aplicables[0];
  return {
    permitido: true,
    motivo: principal?.politica.motivo ?? 'Sin restricciones adicionales',
    obligaciones: OBLIGACIONES.filter((obligacion) => acumuladas.has(obligacion)),
    politica_id: principal?.politica.id,
  };
}

/**
 * Los campos que faltan en el contexto para poder decidir con todas las políticas que
 * podrían aplicar a esta acción y este recurso.
 *
 * Existe por una razón que apareció escribiendo las pruebas de las 31 reglas: la política
 * P10 ("descuento mayor al 10 %") pregunta por `recurso.descuento_pct`. Si quien llama
 * olvida ponerlo, `evaluarCondicion` responde "indeterminado", y una política que PERMITE
 * con condición indeterminada **no se aplica**: la venta pasa sin pedir el PIN. Correcto
 * por lo conservador —ante la duda no se concede nada nuevo— pero el efecto neto es que un
 * campo olvidado apaga la protección antirrobo, en silencio.
 *
 * `evaluar()` no puede arreglarlo solo, porque "el campo no viene" y "el campo vale 0" son
 * indistinguibles desde dentro. Quien sí lo sabe es quien construye el contexto. Por eso
 * esta función: el cargador de `@papeleria/db` la usa para exigir los campos que las
 * políticas vigentes necesitan, y revienta nombrando los que faltan.
 *
 * Sólo mira las políticas que **podrían** aplicar (activas y con `aplica_a` coincidente):
 * que una regla de conteos pida `recurso.diferencia_pct` no significa que una venta tenga
 * que traerlo.
 */
export function camposFaltantes(
  politicas: readonly Politica[],
  ctx: ContextoPolitica,
): string[] {
  const requeridos = new Set<string>();

  for (const politica of politicas) {
    if (!politica.activa || !coincideAplica(politica.aplica_a, ctx)) continue;
    for (const campo of camposDeLaCondicion(politica.condicion)) requeridos.add(campo);
  }

  return [...requeridos].filter((campo) => leerCampo(ctx, campo) === undefined).sort();
}

// ───────────────────────────────── VALIDAR ─────────────────────────────────

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

const PATRON_PERMISO = /^(\*|[a-z_]+:(\*|[a-z_]+))$/;

/**
 * Revisa una política cruda (la que viene de `policies.condicion`, que es `unknown`).
 *
 * Devuelve los problemas, no lanza: el cargador de `@papeleria/db` los junta todos y
 * lanza una vez, con la lista completa. Verlos de uno en uno cuando acabas de escribir
 * cinco reglas es una tortura, y un cargador que falla al azar invita a desactivarlo.
 */
export function validarPolitica(politica: unknown): string[] {
  if (!esObjeto(politica)) return ['la política tiene que ser un objeto'];

  const id = typeof politica['id'] === 'string' && politica['id'] !== '' ? politica['id'] : '?';
  const problemas: string[] = [];
  const mal = (texto: string): void => {
    problemas.push(`${id}: ${texto}`);
  };

  if (id === '?') mal('le falta `id` (o está vacío)');

  const version = politica['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    mal('`version` tiene que ser un entero ≥ 1');
  }

  const prioridad = politica['prioridad'];
  if (typeof prioridad !== 'number' || !Number.isInteger(prioridad)) {
    mal('`prioridad` tiene que ser un entero');
  }

  const efecto = politica['efecto'];
  if (efecto !== 'permitir' && efecto !== 'denegar') {
    mal("`efecto` tiene que ser 'permitir' o 'denegar'");
  }

  const motivo = politica['motivo'];
  if (typeof motivo !== 'string' || motivo === '') {
    mal('`motivo` no puede estar vacío: es lo que se le muestra al usuario y lo que va a la auditoría');
  }

  if (typeof politica['activa'] !== 'boolean') mal('`activa` tiene que ser booleano');

  problemas.push(...validarObligaciones(politica['obligaciones'], id));
  problemas.push(...validarAplicaA(politica['aplica_a'], id));

  for (const problema of validarCondicion(politica['condicion'], `${id}.condicion`)) {
    problemas.push(problema);
  }

  return problemas;
}

function validarObligaciones(obligaciones: unknown, id: string): string[] {
  if (!Array.isArray(obligaciones)) {
    return [`${id}: \`obligaciones\` tiene que ser una lista (puede estar vacía)`];
  }

  const problemas: string[] = [];
  const vistas = new Set<string>();

  for (const obligacion of obligaciones) {
    if (typeof obligacion !== 'string' || !(OBLIGACIONES as readonly string[]).includes(obligacion)) {
      problemas.push(
        `${id}: la obligación \`${String(obligacion)}\` no existe. ` +
          `Las que hay: ${OBLIGACIONES.join(', ')}`,
      );
      continue;
    }
    if (vistas.has(obligacion)) problemas.push(`${id}: la obligación \`${obligacion}\` está dos veces`);
    vistas.add(obligacion);
  }

  return problemas;
}

function validarAplicaA(aplicaA: unknown, id: string): string[] {
  if (!esObjeto(aplicaA)) return [`${id}: \`aplica_a\` tiene que ser un objeto`];

  const problemas: string[] = [];

  const permiso = aplicaA['permiso'];
  if (permiso !== undefined) {
    if (typeof permiso !== 'string' || !PATRON_PERMISO.test(permiso)) {
      problemas.push(
        `${id}: \`aplica_a.permiso\` = ${JSON.stringify(permiso)} no es un permiso ni un patrón. ` +
          `Se espera recurso:acción, recurso:* o *`,
      );
    }
  }

  const recurso = aplicaA['recurso'];
  if (recurso !== undefined) {
    if (typeof recurso !== 'string' || !(TIPOS_RECURSO as readonly string[]).includes(recurso)) {
      problemas.push(
        `${id}: \`aplica_a.recurso\` = ${JSON.stringify(recurso)} no es un tipo de recurso. ` +
          `Los que hay: ${TIPOS_RECURSO.join(', ')}`,
      );
    }
  }

  return problemas;
}

/** Los operadores que existen, para los mensajes de error y la pantalla de administración. */
export const OPERADORES_CONOCIDOS: readonly string[] = [
  ...OPERADORES_COMPARACION,
  'en',
  'and',
  'or',
  'not',
  'siempre',
];
