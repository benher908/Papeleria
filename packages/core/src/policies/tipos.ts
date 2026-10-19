/**
 * TIPOS DE LA AUTORIZACIÓN: RBAC + ABAC (docs/06 §4).
 *
 * RBAC es grueso y estático ("el cajero no edita precios"). ABAC es fino y dinámico
 * ("...salvo con autorización del dueño y descuento menor a $50"). Hacen falta los dos,
 * y el resultado **no es un booleano**: es una decisión con obligaciones.
 *
 *   { permitido: true, obligaciones: ['step_up'] }   → "sí, pero pide el PIN"
 *
 * Esa parte es la que hace usable el sistema. Un motor solo-allow/deny obliga a elegir
 * entre bloquear al empleado o darle vía libre; con obligaciones se puede decir "sí,
 * pero con autorización", que es como funciona una papelería de verdad.
 *
 * ── Qué se desvía de docs/06 §4, y por qué ─────────────────────────────────
 *
 * `entorno.rango_diferencia_conteo` ('bajo' | 'medio' | 'alto') y `accion.es_masiva`
 * desaparecen. Los dos son **umbrales precalculados en código**: el primero esconde el
 * "10 % del valor" de P7 y el segundo el "más de 5 productos" de P4. Pero docs/06 §10
 * pide lo contrario — que cambiar un umbral sea editar un dato, no desplegar. Con el
 * enum, el umbral vive en el código que lo calcula y la pantalla de umbrales no puede
 * tocarlo. En su lugar van los números crudos: `recurso.diferencia_pct` y
 * `accion.productos_afectados`, y la política compara contra ellos.
 *
 * Y `aplica_a.permiso` admite comodín final (`'usuarios:*'`), que es lo que P21 necesita
 * para cubrir los cuatro permisos de `usuarios` sin sembrar cuatro reglas.
 */

/** El catálogo cerrado de obligaciones. Debe coincidir con el CHECK de 0002_rbac_abac.sql. */
export const OBLIGACIONES = [
  /** Pedir PIN o passkey ahora. La única que depende del estado del sujeto (ver `evaluar`). */
  'step_up',
  /** Exigir una nota de al menos 10 caracteres. */
  'motivo_obligatorio',
  /** Mandar aviso al dueño aunque se permita. */
  'notificar_dueno',
  /** Se permite, pero queda marcado para revisarlo después. */
  'marcar_para_revision',
] as const;

export type Obligacion = (typeof OBLIGACIONES)[number];

/** El tipo de cosa sobre la que se actúa. Es el vocabulario del dominio, no el del módulo. */
export const TIPOS_RECURSO = [
  'venta',
  'producto',
  'movimiento',
  'turno',
  'conteo',
  'precio',
  'usuario',
  'politica',
  'dispositivo',
  'config',
] as const;

export type TipoRecurso = (typeof TIPOS_RECURSO)[number];

// ───────────────────────────── CUÁNDO SE APLICA UNA REGLA ─────────────────────────────

/**
 * A qué apunta una política. `{}` (todo vacío) significa "a todo".
 *
 * `permiso` admite `'ventas:*'` y `'*'`. `recurso` se compara contra `recurso.tipo`, que
 * es el vocabulario del **dominio**: ojo, no es el mismo que el `recurso` de un permiso
 * (`precios:editar` tiene recurso 'precios', pero actúa sobre un `recurso.tipo` 'producto').
 * Son dos ejes distintos a propósito: uno es el módulo, el otro es la cosa.
 */
export interface AplicaA {
  readonly permiso?: string;
  readonly recurso?: TipoRecurso;
}

// ───────────────────────────── OPERADORES DE CONDICIÓN ─────────────────────────────

/**
 * Operadores que comparan un campo del contexto contra algo.
 *
 * `gt_abs` compara contra el valor absoluto del campo, y existe por una razón concreta:
 * P17 habla de la "diferencia" de un conteo, que puede ser sobrante o faltante. Con `lt`
 * habría que escribir el umbral dos veces (una positiva y otra negativa), y dos copias de
 * un umbral es la forma segura de que un día digan cosas distintas.
 */
export const OPERADORES_COMPARACION = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'gt_abs',
] as const;

export type OperadorComparacion = (typeof OPERADORES_COMPARACION)[number];

/**
 * La comparación contra un literal, o contra **otro campo**.
 *
 * El lado derecho es `valor` o `campo2`, exactamente uno de los dos. `campo2` es la
 * extensión que docs/06 §4 no tenía y que bloqueaba las políticas más importantes: P1
 * ("precio nuevo menor al costo") compara dos campos del contexto entre sí, y con sólo
 * `campo` + `valor` era imposible de escribir. Por eso las 31 reglas no se pudieron
 * sembrar en 0002.
 */
export interface CondicionComparacion {
  readonly op: OperadorComparacion;
  /** Nombre del campo en el contexto: `'recurso.monto_minor'`. */
  readonly campo: string;
  /** El otro lado: un literal. */
  readonly valor?: number | string | boolean;
  /** El otro lado: otro campo del contexto. */
  readonly campo2?: string;
}

/** Pertenencia: el valor del campo está en la lista. */
export interface CondicionEn {
  readonly op: 'en';
  readonly campo: string;
  readonly valores: readonly (number | string)[];
}

export interface CondicionLogica {
  readonly op: 'and' | 'or';
  readonly args: readonly Condicion[];
}

export interface CondicionNo {
  readonly op: 'not';
  readonly arg: Condicion;
}

/** Sin condiciones: la política se aplica siempre que `aplica_a` coincida. */
export interface CondicionSiempre {
  readonly op: 'siempre';
}

/**
 * El árbol de condición, serializable a JSON. Es el campo `condicion` de la tabla
 * `policies`, y vive ahí —no en el código— porque offline no hay servidor a quien
 * preguntar: las reglas viajan con el catálogo (docs/06 §5.4).
 */
export type Condicion =
  | CondicionSiempre
  | CondicionLogica
  | CondicionNo
  | CondicionComparacion
  | CondicionEn;

// ───────────────────────────── LA POLÍTICA Y SU CONTEXTO ─────────────────────────────

/** Una fila de `policies`. */
export interface Politica {
  /** Slug de texto, no uuid: 'P10-descuento-alto'. Aparece en la auditoría. */
  readonly id: string;
  readonly version: number;
  /** Menor = se evalúa primero. Con deny-overrides sólo cambia cuál motivo se muestra. */
  readonly prioridad: number;
  readonly efecto: 'permitir' | 'denegar';
  readonly aplica_a: AplicaA;
  readonly condicion: Condicion;
  readonly obligaciones: readonly Obligacion[];
  readonly motivo: string;
  readonly activa: boolean;
}

export interface AtributosSujeto {
  readonly user_id: string;
  readonly roles: readonly string[];
  readonly permisos: readonly string[];
  /**
   * Si hay un step-up que cubre **esta acción y este objeto**, vigente. No es "hizo
   * step-up alguna vez hoy": el otorgamiento está acotado a la acción y al objeto
   * (docs/06 §6), y quien construye el contexto es quien consulta `step_up_grants`.
   */
  readonly tiene_step_up_reciente: boolean;
  readonly step_up_hace_segundos: number | null;
  readonly dispositivo_confiable: boolean;
  readonly dispositivo_id: string;
}

export interface AtributosRecurso {
  readonly tipo: TipoRecurso;
  readonly id?: string;
  // Precios
  readonly precio_actual_minor?: number;
  readonly precio_nuevo_minor?: number;
  readonly costo_minor?: number;
  // Dinero
  readonly monto_minor?: number;
  readonly descuento_pct?: number;
  readonly descuento_minor?: number;
  // Stock
  readonly valor_stock_afectado_minor?: number;
  readonly producto_tiene_stock?: boolean;
  // Ventas
  readonly es_venta_ya_cerrada?: boolean;
  readonly tiene_ticket?: boolean;
  /** 1 = primera impresión, 2 = primera reimpresión (P16). */
  readonly impresion_numero?: number;
  // Conteos
  readonly diferencia_pct?: number;
  readonly diferencia_minor?: number;
  readonly conteo_ya_aplicado?: boolean;
  // Caja
  readonly retiros_en_turno?: number;
}

export interface AtributosAccion {
  /** El permiso que se está ejerciendo: `'ventas:crear'`. */
  readonly permiso: string;
  /** Cuántos productos afecta la acción. P4 se dispara arriba de 5. */
  readonly productos_afectados?: number;
}

export interface AtributosEntorno {
  /** 0–23. P13 se vuelve más estricta después de las 20:00. */
  readonly hora_local: number;
  /** 0 = domingo. */
  readonly dia_semana: number;
  readonly en_temporada_escolar: boolean;
  readonly terminal_id: string;
  /** Sin red. P25–P31 cambian por completo lo que se permite. */
  readonly es_offline: boolean;
}

export interface ContextoPolitica {
  readonly sujeto: AtributosSujeto;
  readonly recurso: AtributosRecurso;
  readonly accion: AtributosAccion;
  readonly entorno: AtributosEntorno;
}

/** Lo que devuelve `evaluar()`. */
export interface Decision {
  readonly permitido: boolean;
  /** Siempre explicable: 'descuento 15% > 10% sin step-up'. Nunca vacío. */
  readonly motivo: string;
  readonly obligaciones: readonly Obligacion[];
  /** Qué regla decidió. Queda en el `audit_log`. */
  readonly politica_id?: string;
  /**
   * `true` cuando una política **denegar** se aplicó sin poder evaluar su condición,
   * porque el contexto no traía algún campo que necesita. Se deniega igual (fallar
   * cerrado), pero el motivo lo dice: es un error de quien construyó el contexto, no
   * una decisión de negocio. Sin esta marca, un campo con el nombre mal escrito
   * apagaría una regla de seguridad en silencio.
   */
  readonly porContextoIncompleto?: boolean;
}
