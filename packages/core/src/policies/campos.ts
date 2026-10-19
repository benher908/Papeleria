/**
 * EL CATÁLOGO DE CAMPOS QUE UNA POLÍTICA PUEDE CONSULTAR.
 *
 * Existe por una razón que el esquema ya aplica en otro sitio. `0002_rbac_abac.sql`
 * tiene un CHECK sobre `obligaciones` con este comentario:
 *
 *   "Si alguien escribe 'stepup' en vez de 'step_up', la obligación no se cumple NUNCA
 *    y la regla deja de proteger en silencio. Mejor que la base lo rechace."
 *
 * Con los nombres de campo pasa lo mismo, pero peor, porque la base no puede validarlos:
 * van dentro de un JSON. Una política que consulta `recurso.monto_minor` y una que
 * consulta `recurso.monto` (sin `_minor`) son indistinguibles para Postgres, y la segunda
 * **nunca** se cumple. Si esa política deniega, el agujero es silencioso.
 *
 * Por eso este catálogo es la lista cerrada de lo que se puede nombrar, y por eso
 * `validarCondicion()` lo usa para rechazar un campo desconocido **al cargar la política**,
 * con el nombre mal escrito en el mensaje, en vez de dejar que falle callado en cada
 * venta. `evaluar()` además falla cerrado por su cuenta (ver `evaluar.ts`), porque una
 * política cargada por otra vía siempre puede llegar sin validar.
 *
 * ── La garantía estructural ───────────────────────────────────────────────
 *
 * `CAMPOS` está tipado como un mapa sobre `ContextoPolitica`. Si mañana alguien añade un
 * campo al contexto y no lo describe aquí, **no compila**. Sin eso, el catálogo y el tipo
 * se separan en la primera semana y el catálogo se vuelve mentira.
 */

import type { ContextoPolitica } from './tipos';

export const GRUPOS = ['sujeto', 'recurso', 'accion', 'entorno'] as const;
export type Grupo = (typeof GRUPOS)[number];

export type TipoCampo =
  | 'numero'
  | 'texto'
  | 'booleano'
  /** Lista de textos. **No** se puede consultar desde una política; ver abajo. */
  | 'lista_de_texto';

export interface DescriptorCampo {
  readonly tipo: TipoCampo;
  /** Para el mensaje de error y para la pantalla de umbrales (docs/06 §10). */
  readonly descripcion: string;
}

type CatalogoDe<C> = {
  readonly [G in keyof C]: { readonly [K in keyof C[G]]: DescriptorCampo };
};

export const CAMPOS: CatalogoDe<ContextoPolitica> = {
  sujeto: {
    user_id: { tipo: 'texto', descripcion: 'Usuario que actúa' },
    roles: {
      tipo: 'lista_de_texto',
      descripcion: 'Roles vigentes. NO se consulta desde una política: el RBAC ya decidió',
    },
    permisos: {
      tipo: 'lista_de_texto',
      descripcion: 'Permisos vigentes. NO se consulta desde una política: el RBAC ya decidió',
    },
    tiene_step_up_reciente: {
      tipo: 'booleano',
      descripcion: 'Hay autorización reciente para esta acción y este objeto',
    },
    step_up_hace_segundos: {
      tipo: 'numero',
      descripcion: 'Hace cuántos segundos se autorizó. Nulo si no hay autorización',
    },
    dispositivo_confiable: { tipo: 'booleano', descripcion: 'El dispositivo está emparejado' },
    dispositivo_id: { tipo: 'texto', descripcion: 'Dispositivo desde el que se actúa' },
  },

  recurso: {
    tipo: { tipo: 'texto', descripcion: 'Qué se está tocando: venta, producto, turno…' },
    id: { tipo: 'texto', descripcion: 'Identificador del objeto concreto' },
    precio_actual_minor: { tipo: 'numero', descripcion: 'Precio de venta antes del cambio' },
    precio_nuevo_minor: { tipo: 'numero', descripcion: 'Precio de venta propuesto' },
    costo_minor: { tipo: 'numero', descripcion: 'Lo que costó. Es el margen' },
    monto_minor: { tipo: 'numero', descripcion: 'Total de la venta, del retiro o del ajuste' },
    descuento_pct: { tipo: 'numero', descripcion: 'Descuento en porcentaje' },
    descuento_minor: { tipo: 'numero', descripcion: 'Descuento en pesos' },
    valor_stock_afectado_minor: {
      tipo: 'numero',
      descripcion: 'Valor al costo de lo que mueve un ajuste de stock',
    },
    producto_tiene_stock: { tipo: 'booleano', descripcion: 'El producto tiene existencia' },
    es_venta_ya_cerrada: { tipo: 'booleano', descripcion: 'La venta ya fue cobrada' },
    tiene_ticket: { tipo: 'booleano', descripcion: 'La devolución trae ticket' },
    impresion_numero: {
      tipo: 'numero',
      descripcion: '1 = primera impresión, 2 = primera reimpresión (P16)',
    },
    diferencia_pct: { tipo: 'numero', descripcion: 'Diferencia del conteo, en porcentaje del valor' },
    diferencia_minor: {
      tipo: 'numero',
      descripcion: 'Diferencia del arqueo, en pesos. Positiva = sobrante, negativa = faltante',
    },
    conteo_ya_aplicado: { tipo: 'booleano', descripcion: 'El conteo ya se aplicó (P24)' },
    retiros_en_turno: { tipo: 'numero', descripcion: 'Cuántos retiros de cajón lleva el turno' },
  },

  accion: {
    permiso: { tipo: 'texto', descripcion: 'Permiso que se está ejerciendo' },
    productos_afectados: { tipo: 'numero', descripcion: 'Cuántos productos toca la acción (P4: más de 5)' },
  },

  entorno: {
    hora_local: { tipo: 'numero', descripcion: 'Hora local, 0–23' },
    dia_semana: { tipo: 'numero', descripcion: '0 = domingo' },
    en_temporada_escolar: { tipo: 'booleano', descripcion: 'Estamos en junio–agosto' },
    terminal_id: { tipo: 'texto', descripcion: 'La caja desde la que se opera' },
    es_offline: { tipo: 'booleano', descripcion: 'No hay red. Las reglas P25–P31 cambian' },
  },
};

/** El prefijo de los campos de un grupo, o `undefined` si el grupo no existe. */
function partirCampo(campo: string): { grupo: Grupo; nombre: string } | undefined {
  const punto = campo.indexOf('.');
  if (punto <= 0 || punto === campo.length - 1) return undefined;

  const grupo = campo.slice(0, punto);
  if (!(GRUPOS as readonly string[]).includes(grupo)) return undefined;

  // Sólo un nivel: el contexto es plano dentro de cada grupo, a propósito. Un camino
  // arbitrario ('recurso.lineas.0.precio') convertiría el catálogo en un adivino.
  const nombre = campo.slice(punto + 1);
  if (nombre.includes('.')) return undefined;

  return { grupo: grupo as Grupo, nombre };
}

/** Cómo es el campo, o `undefined` si no existe. */
export function descriptorDe(campo: string): DescriptorCampo | undefined {
  const partes = partirCampo(campo);
  if (partes === undefined) return undefined;

  const delGrupo = CAMPOS[partes.grupo] as Record<string, DescriptorCampo | undefined>;
  return delGrupo[partes.nombre];
}

/** El valor del campo en este contexto, o `undefined` si no viene. */
export function leerCampo(ctx: ContextoPolitica, campo: string): unknown {
  const partes = partirCampo(campo);
  if (partes === undefined) return undefined;

  const delGrupo = ctx[partes.grupo] as unknown as Record<string, unknown>;
  return delGrupo[partes.nombre];
}
