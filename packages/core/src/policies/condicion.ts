/**
 * CÓMO SE EVALÚA UNA CONDICIÓN — la gramática que faltaba.
 *
 * docs/06 §4 publicó tres formas (`and`, `gt`, `eq`) y las tres comparan un campo del
 * contexto contra un literal. Con eso, P1 no se puede escribir:
 *
 *     P1: "precio nuevo MENOR AL COSTO"  →  recurso.precio_nuevo_minor < recurso.costo_minor
 *
 * Compara **dos campos entre sí**, y no hay literal que poner a la derecha. Es la razón
 * por la que las 31 políticas no se sembraron en 0002: sembrar reglas de seguridad que
 * nadie puede verificar da la falsa impresión de que el sistema está configurado.
 *
 * Aquí está la gramática completa: el lado derecho es `valor` (literal) o `campo2` (otro
 * campo), exactamente uno. Con eso P1 se escribe tal como se lee.
 *
 * ── LA DECISIÓN IMPORTANTE: qué pasa cuando falta un campo ────────────────────
 *
 * `evaluarCondicion` devuelve `true`, `false` o **`null` (indeterminado)**. El `null`
 * existe por el mismo motivo que el CHECK de `obligaciones` en 0002_rbac_abac.sql: una
 * regla mal escrita no puede apagarse en silencio.
 *
 * · Si el contexto no trae `recurso.monto_minor` y la política pregunta por él, la
 *   pregunta **no tiene respuesta**. Devolver `false` significaría "condición no
 *   cumplida", y para una política que deniega eso es un agujero: basta con que un
 *   llamador olvide rellenar un campo para desactivar una regla de seguridad, y no se
 *   nota nunca. Devolver `true` sería lo contrario: aplicar obligaciones que nadie pidió.
 *
 * · Por eso la indeterminación se propaga (`and` es indeterminado si algún argumento lo
 *   es y ninguno es falso; `or` al revés) y **`evaluar()` la resuelve según el efecto**:
 *
 *       · una política que DENIEGA con condición indeterminada → se aplica (fallar cerrado)
 *       · una política que PERMITE con condición indeterminada → no se aplica
 *
 *   Es lo conservador en los dos sentidos: ante la duda no se concede nada nuevo y no se
 *   levanta ninguna prohibición.
 *
 * `validarCondicion()` es la otra mitad, y la primera línea de defensa: rechaza el campo
 * desconocido **al cargar** la política, con el nombre mal escrito a la vista. Sin ella,
 * `recurso.monto` (sin `_minor`) daría `null` en cada venta en vez de un error legible.
 */

import { CAMPOS, descriptorDe, leerCampo, type TipoCampo } from './campos';
import {
  OPERADORES_COMPARACION,
  type Condicion,
  type CondicionComparacion,
  type CondicionEn,
  type ContextoPolitica,
  type OperadorComparacion,
} from './tipos';

/**
 * `true`, `false`, o `null` cuando el contexto no alcanza a responder.
 *
 * El `null` no es un error: es una respuesta. Ver el encabezado del archivo.
 */
export type ResultadoCondicion = boolean | null;

/** Qué operadores tienen sentido para cada tipo de campo. */
const OPERADORES_POR_TIPO: Record<TipoCampo, readonly OperadorComparacion[]> = {
  numero: OPERADORES_COMPARACION,
  texto: ['eq', 'ne'],
  booleano: ['eq', 'ne'],
  // Los roles y los permisos no se consultan desde una política. No es una limitación
  // técnica: docs/06 §8 prohíbe las condiciones de rol en el código ("`if (rol === ...)`
  // prohibido"), y permitirlas aquí sería exactamente eso, con otra sintaxis. El RBAC ya
  // las resolvió antes de llegar a este archivo.
  lista_de_texto: [],
};

// ───────────────────────────────── EVALUAR ─────────────────────────────────

export function evaluarCondicion(
  condicion: Condicion,
  ctx: ContextoPolitica,
): ResultadoCondicion {
  switch (condicion.op) {
    case 'siempre':
      return true;
    case 'and':
      return evaluarY(condicion.args, ctx);
    case 'or':
      return evaluarO(condicion.args, ctx);
    case 'not': {
      const dentro = evaluarCondicion(condicion.arg, ctx);
      return dentro === null ? null : !dentro;
    }
    case 'en':
      return evaluarEn(condicion, ctx);
    default:
      return evaluarComparacion(condicion, ctx);
  }
}

/**
 * Todos los campos que una condición necesita para poder responderse.
 *
 * Sirve para lo contrario de `evaluarCondicion`: en vez de preguntar "¿se cumple?", aquí
 * se pregunta "¿con qué datos?". Con la lista en la mano, quien construye el contexto puede
 * comprobar que no le falta ninguno **antes** de decidir, y fallar con un mensaje que diga
 * cuál. Es la diferencia entre un error de programación que se ve en la primera venta y una
 * regla de seguridad que no protege y nadie nota.
 */
export function camposDeLaCondicion(condicion: Condicion): string[] {
  switch (condicion.op) {
    case 'siempre':
      return [];
    case 'and':
    case 'or':
      return condicion.args.flatMap(camposDeLaCondicion);
    case 'not':
      return camposDeLaCondicion(condicion.arg);
    case 'en':
      return [condicion.campo];
    default:
      return condicion.campo2 === undefined
        ? [condicion.campo]
        : [condicion.campo, condicion.campo2];
  }
}

function evaluarY(args: readonly Condicion[], ctx: ContextoPolitica): ResultadoCondicion {
  let indeterminado = false;
  for (const arg of args) {
    const resultado = evaluarCondicion(arg, ctx);
    // Un `false` decide. Un `null` sólo decide si no aparece ningún `false`: si algo es
    // falso, el `and` es falso aunque otra rama no se pueda evaluar.
    if (resultado === false) return false;
    if (resultado === null) indeterminado = true;
  }
  return indeterminado ? null : true;
}

function evaluarO(args: readonly Condicion[], ctx: ContextoPolitica): ResultadoCondicion {
  let indeterminado = false;
  for (const arg of args) {
    const resultado = evaluarCondicion(arg, ctx);
    if (resultado === true) return true;
    if (resultado === null) indeterminado = true;
  }
  return indeterminado ? null : false;
}

function evaluarComparacion(
  condicion: CondicionComparacion,
  ctx: ContextoPolitica,
): ResultadoCondicion {
  const izquierda = leerCampo(ctx, condicion.campo);
  if (izquierda === undefined) return null;

  let derecha: unknown;
  if (condicion.campo2 !== undefined) {
    derecha = leerCampo(ctx, condicion.campo2);
    if (derecha === undefined) return null;
  } else if (condicion.valor !== undefined) {
    derecha = condicion.valor;
  } else {
    // Ni `valor` ni `campo2`: la política está mal escrita. `validarCondicion` lo rechaza
    // al cargarla; aquí se responde "no lo sé" en vez de inventar un resultado.
    return null;
  }

  return comparar(condicion.op, izquierda, derecha);
}

function evaluarEn(condicion: CondicionEn, ctx: ContextoPolitica): ResultadoCondicion {
  const valor = leerCampo(ctx, condicion.campo);
  if (valor === undefined) return null;

  // Sólo escalares. Comparar una lista contra una lista de valores sería otra pregunta
  // ("¿contiene alguno?") y no la que dice `en`.
  if (typeof valor !== 'number' && typeof valor !== 'string') return null;

  return condicion.valores.includes(valor);
}

function comparar(op: OperadorComparacion, a: unknown, b: unknown): ResultadoCondicion {
  if (op === 'eq') return iguales(a, b);
  if (op === 'ne') {
    const mismo = iguales(a, b);
    return mismo === null ? null : !mismo;
  }

  // El resto son numéricos. Un `>` sobre texto no significa nada: `'10' > '9'` es falso.
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const izquierda = op === 'gt_abs' ? Math.abs(a) : a;
  if (op === 'gt' || op === 'gt_abs') return izquierda > b;
  if (op === 'gte') return izquierda >= b;
  if (op === 'lt') return izquierda < b;
  return izquierda <= b;
}

function iguales(a: unknown, b: unknown): ResultadoCondicion {
  // Tipos distintos no son "distintos": son una política mal escrita. `5` y `'5'` no son
  // iguales ni desiguales, y responder `true` a un `ne` ahí sería conceder de más.
  if (typeof a !== typeof b) return null;
  // Estructuras (listas, objetos) no se comparan por valor en este lenguaje a propósito.
  if (typeof a === 'object') return null;
  if (typeof a === 'number' && !Number.isFinite(a)) return null;
  if (typeof b === 'number' && !Number.isFinite(b)) return null;

  return a === b;
}

// ───────────────────────────────── VALIDAR ─────────────────────────────────

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Revisa una condición (que viene de un JSON, así que es `unknown`) y devuelve la lista
 * de problemas legibles. Lista vacía = está bien.
 *
 * No lanza: quien la llama decide. El cargador de políticas lanza con todos los problemas
 * juntos, porque verlos de uno en uno cuando tienes cinco reglas nuevas es una tortura.
 */
export function validarCondicion(condicion: unknown, camino = 'condicion'): string[] {
  if (!esObjeto(condicion)) return [`${camino}: tiene que ser un objeto con \`op\``];

  const op = condicion['op'];
  if (typeof op !== 'string') return [`${camino}: falta \`op\``];

  switch (op) {
    case 'siempre':
      return [];

    case 'and':
    case 'or': {
      const args = condicion['args'];
      if (!Array.isArray(args)) return [`${camino}: \`${op}\` necesita \`args\` como lista`];
      if (args.length === 0) {
        return [`${camino}: \`${op}\` con la lista vacía no dice nada`];
      }
      return args.flatMap((arg, i) => validarCondicion(arg, `${camino}.${op}[${i}]`));
    }

    case 'not':
      if (!('arg' in condicion)) return [`${camino}: \`not\` necesita \`arg\``];
      return validarCondicion(condicion['arg'], `${camino}.not`);

    case 'en':
      return validarEn(condicion, camino);

    default:
      if (!(OPERADORES_COMPARACION as readonly string[]).includes(op)) {
        return [
          `${camino}: el operador \`${op}\` no existe. Los que hay: ` +
            `${[...OPERADORES_COMPARACION, 'en', 'and', 'or', 'not', 'siempre'].join(', ')}`,
        ];
      }
      return validarComparacion(condicion, op as OperadorComparacion, camino);
  }
}

function validarEn(condicion: Record<string, unknown>, camino: string): string[] {
  const problemas: string[] = [];

  const campo = condicion['campo'];
  if (typeof campo !== 'string') {
    return [`${camino}: \`en\` necesita \`campo\``];
  }

  const descriptor = descriptorDe(campo);
  if (descriptor === undefined) {
    return [`${camino}: no existe el campo \`${campo}\`. ${sugerencias(campo)}`];
  }
  if (descriptor.tipo !== 'texto' && descriptor.tipo !== 'numero') {
    problemas.push(`${camino}: \`en\` no se puede usar sobre un campo ${descriptor.tipo}`);
  }

  const valores = condicion['valores'];
  if (!Array.isArray(valores)) {
    problemas.push(`${camino}: \`en\` necesita \`valores\` como lista`);
  } else if (valores.length === 0) {
    problemas.push(`${camino}: \`en\` con la lista vacía nunca se cumple`);
  } else {
    for (const valor of valores) {
      if (typeof valor !== 'number' && typeof valor !== 'string') {
        problemas.push(`${camino}: \`en\` sólo compara números y textos`);
        break;
      }
    }
  }

  return problemas;
}

function validarComparacion(
  condicion: Record<string, unknown>,
  op: OperadorComparacion,
  camino: string,
): string[] {
  const problemas: string[] = [];

  const campo = condicion['campo'];
  if (typeof campo !== 'string') {
    return [`${camino}: \`${op}\` necesita \`campo\``];
  }

  const descriptorIzquierda = descriptorDe(campo);
  if (descriptorIzquierda === undefined) {
    return [`${camino}: no existe el campo \`${campo}\`. ${sugerencias(campo)}`];
  }

  if (!OPERADORES_POR_TIPO[descriptorIzquierda.tipo].includes(op)) {
    problemas.push(
      `${camino}: \`${op}\` no se puede usar sobre \`${campo}\` (es ${descriptorIzquierda.tipo}). ` +
        `Ahí valen: ${OPERADORES_POR_TIPO[descriptorIzquierda.tipo].join(', ') || 'ninguno'}`,
    );
  }

  const tieneValor = condicion['valor'] !== undefined;
  const tieneCampo2 = condicion['campo2'] !== undefined;

  if (tieneValor === tieneCampo2) {
    problemas.push(
      `${camino}: \`${op}\` necesita \`valor\` (un literal) o \`campo2\` (otro campo), ` +
        `exactamente uno de los dos`,
    );
    return problemas;
  }

  if (tieneCampo2) {
    const campo2 = condicion['campo2'];
    if (typeof campo2 !== 'string') {
      problemas.push(`${camino}: \`campo2\` tiene que ser el nombre de un campo`);
      return problemas;
    }
    const descriptorDerecha = descriptorDe(campo2);
    if (descriptorDerecha === undefined) {
      problemas.push(`${camino}: no existe el campo \`${campo2}\`. ${sugerencias(campo2)}`);
      return problemas;
    }
    if (descriptorDerecha.tipo !== descriptorIzquierda.tipo) {
      problemas.push(
        `${camino}: \`${campo}\` es ${descriptorIzquierda.tipo} y \`${campo2}\` es ` +
          `${descriptorDerecha.tipo}: no se pueden comparar`,
      );
    }
  } else {
    const esperado = descriptorIzquierda.tipo;
    const valor = condicion['valor'];
    const real = typeof valor;
    // `gt_abs` es la excepción que hace falta recordar: el lado derecho es el umbral, y
    // el izquierdo se toma en valor absoluto.
    if (esperado === 'numero' && real !== 'number') {
      problemas.push(`${camino}: \`${campo}\` es numérico, y el \`valor\` es ${real}`);
    } else if (esperado === 'texto' && real !== 'string') {
      problemas.push(`${camino}: \`${campo}\` es texto, y el \`valor\` es ${real}`);
    } else if (esperado === 'booleano' && real !== 'boolean') {
      problemas.push(`${camino}: \`${campo}\` es booleano, y el \`valor\` es ${real}`);
    }
  }

  return problemas;
}

/**
 * "¿Quisiste decir...?" — el campo más parecido.
 *
 * No es cortesía: este error lo va a cometer alguien escribiendo un JSON a mano, y la
 * diferencia entre `recurso.monto` y `recurso.monto_minor` no se ve leyendo.
 */
function sugerencias(campo: string): string {
  const buscado = campo.toLowerCase();

  const candidatos = CAMPOS_PLANOS.filter((c) => {
    const nombre = c.toLowerCase();
    const ultimo = nombre.split('.').pop() ?? '';
    return nombre.includes(buscado) || (ultimo !== '' && buscado.includes(ultimo));
  });

  if (candidatos.length === 0) return 'Revisa el catálogo de campos de `policies/campos.ts`.';
  return `¿Quisiste decir ${candidatos.slice(0, 3).map((c) => `\`${c}\``).join(' o ')}?`;
}

/** Todos los nombres de campo, aplanados. Para las sugerencias del error. */
const CAMPOS_PLANOS: readonly string[] = Object.entries(CAMPOS).flatMap(([grupo, campos]) =>
  Object.keys(campos).map((nombre) => `${grupo}.${nombre}`),
);
