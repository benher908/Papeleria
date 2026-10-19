/**
 * Instantánea del esquema e instrumento de comparación entre motores.
 *
 * La promesa del proyecto es que el MISMO juego de migraciones corre en PGlite
 * (navegador) y en PostgreSQL 16 (servidor). Esa promesa se rompe sola si nadie
 * la vigila: basta con que un día alguien use una función que PGlite no trae, y
 * el error aparece en el arranque de la app del mostrador, no en la integración
 * continua.
 *
 * Este módulo lee el catálogo de Postgres y devuelve una lista plana de hechos
 * ("existe esta tabla", "esta columna es bigint y no admite nulos", "este índice
 * es un GIN sobre esta expresión", "esta restricción dice esto"). Dos instantáneas
 * se comparan línea a línea, así que la diferencia se lee como un diff.
 */

import type { ClienteSql } from './runner';

export interface ColumnaEsquema {
  tabla: string;
  columna: string;
  tipo: string;
  nula: boolean;
  /** '' | 'identity: a' | 'identity: d' | 'generado: s' */
  generacion: string;
}

export interface RestriccionEsquema {
  tabla: string;
  nombre: string;
  /** c = check · p = llave primaria · u = único · f = llave foránea */
  tipo: string;
  definicion: string;
}

export interface DisparadorEsquema {
  nombre: string;
  tabla: string;
  definicion: string;
}

export interface InstantaneaEsquema {
  tablas: string[];
  columnas: ColumnaEsquema[];
  indices: string[];
  restricciones: RestriccionEsquema[];
  vistas: string[];
  funciones: string[];
  disparadores: DisparadorEsquema[];
}

// ─────────────────────────── Lectura del catálogo ───────────────────────────
//
// Todo se filtra por `schemaname = 'public'` para no comparar el catálogo interno
// de Postgres, que lógicamente difiere entre versiones.

const CONSULTAS = {
  tablas: `
    SELECT tablename AS v
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename`,

  columnas: `
    SELECT c.relname AS tabla,
           a.attname AS columna,
           format_type(a.atttypid, a.atttypmod) AS tipo,
           NOT a.attnotnull AS nula,
           -- ⚠️ Los ::text no son decorativos. attidentity y attgenerated son
           -- del tipo interno "char", y concatenar un literal con "char" es
           -- ambiguo para el planificador:
           --   ERROR: operator is not unique: unknown || "char"
           CASE
             WHEN a.attidentity <> '' THEN 'identity: ' || a.attidentity::text
             WHEN a.attgenerated <> '' THEN 'generado: ' || a.attgenerated::text
             ELSE ''
           END AS generacion
    FROM pg_attribute a
    JOIN pg_class      c ON c.oid = a.attrelid
    JOIN pg_namespace  n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`,

  indices: `
    SELECT indexname || ' :: ' || indexdef AS v
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY indexname`,

  // ⚠️ Sólo 'c','p','u','f'. En PostgreSQL 17 las restricciones NOT NULL pasaron a
  //    vivir aquí con el tipo 'n', y PGlite va varios pasos por delante o por
  //    detrás del servidor según la versión que traiga. Incluir 'n' haría que la
  //    comparación fallara por una diferencia de VERSIÓN, que no es lo que se
  //    quiere detectar. El NOT NULL se compara igual, columna por columna, en la
  //    consulta de arriba — donde no depende de la versión.
  restricciones: `
    SELECT c.relname AS tabla,
           con.conname AS nombre,
           con.contype::text AS tipo,
           pg_get_constraintdef(con.oid) AS definicion
    FROM pg_constraint con
    JOIN pg_class     c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND con.contype IN ('c', 'p', 'u', 'f')
    ORDER BY c.relname, con.conname`,

  vistas: `
    SELECT viewname AS v
    FROM pg_views
    WHERE schemaname = 'public'
    ORDER BY viewname`,

  funciones: `
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS v
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY 1`,

  disparadores: `
    SELECT t.tgname AS nombre,
           c.relname AS tabla,
           pg_get_triggerdef(t.oid) AS definicion
    FROM pg_trigger t
    JOIN pg_class     c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
    ORDER BY t.tgname`,
} as const;

/** Lee el esquema completo de la base a la que esté conectado `cliente`. */
export async function instantanea(cliente: ClienteSql): Promise<InstantaneaEsquema> {
  const tablas = await primeraColumna(cliente, CONSULTAS.tablas);
  const indices = await primeraColumna(cliente, CONSULTAS.indices);
  const vistas = await primeraColumna(cliente, CONSULTAS.vistas);
  const funciones = await primeraColumna(cliente, CONSULTAS.funciones);

  const columnas = (
    await cliente.query<Omit<ColumnaEsquema, never>>(CONSULTAS.columnas)
  ).rows;
  const restricciones = (
    await cliente.query<RestriccionEsquema>(CONSULTAS.restricciones)
  ).rows;
  const disparadores = (
    await cliente.query<DisparadorEsquema>(CONSULTAS.disparadores)
  ).rows;

  return { tablas, columnas, indices, restricciones, vistas, funciones, disparadores };
}

async function primeraColumna(cliente: ClienteSql, sql: string): Promise<string[]> {
  const { rows } = await cliente.query<{ v: string }>(sql);
  return rows.map((f) => f.v);
}

// ────────────────────────────── Comparación ──────────────────────────────

export interface DiferenciaEsquema {
  aspecto: 'tabla' | 'columna' | 'indice' | 'restriccion' | 'vista' | 'funcion' | 'disparador';
  valor: string;
  lado: 'solo en A' | 'solo en B';
}

/**
 * Convierte la instantánea en líneas comparables.
 *
 * Las columnas se resumen en una sola línea ("sales.folio bigint NOT NULL
 * identity: a") en lugar de una línea por atributo: si el tipo cambia, sale una
 * línea y no cinco, y el diff se lee de un golpe.
 */
export function lineasDe(
  s: InstantaneaEsquema,
): { aspecto: DiferenciaEsquema['aspecto']; valor: string }[] {
  const lineas: { aspecto: DiferenciaEsquema['aspecto']; valor: string }[] = [];

  for (const t of s.tablas) lineas.push({ aspecto: 'tabla', valor: t });
  for (const c of s.columnas) {
    const partes = [
      `${c.tabla}.${c.columna} ${c.tipo}`,
      c.nula ? 'NULL' : 'NOT NULL',
      c.generacion,
    ].filter((p) => p !== '');
    lineas.push({ aspecto: 'columna', valor: partes.join(' ') });
  }
  for (const i of s.indices) lineas.push({ aspecto: 'indice', valor: i });
  for (const r of s.restricciones) {
    lineas.push({ aspecto: 'restriccion', valor: `${r.tabla} ${r.nombre} ${r.definicion}` });
  }
  for (const v of s.vistas) lineas.push({ aspecto: 'vista', valor: v });
  for (const f of s.funciones) lineas.push({ aspecto: 'funcion', valor: f });
  for (const d of s.disparadores) {
    lineas.push({ aspecto: 'disparador', valor: `${d.tabla} ${d.nombre} ${d.definicion}` });
  }

  return lineas;
}

/**
 * Diferencias entre dos instantáneas. Lista vacía = esquemas equivalentes.
 *
 * `A` es el lado de referencia. En el test de compatibilidad, A es PGlite (el que
 * corre en cada commit) y B es el PostgreSQL real de la integración continua; por
 * eso las diferencias se etiquetan "solo en A" / "solo en B" y no "falta"/"sobra",
 * que obligaría a saber cuál es cuál al leer el resultado.
 */
export function compararEsquemas(
  a: InstantaneaEsquema,
  b: InstantaneaEsquema,
): DiferenciaEsquema[] {
  const enA = contar(lineasDe(a));
  const enB = contar(lineasDe(b));
  const diferencias: DiferenciaEsquema[] = [];

  for (const [clave, vecesA] of enA) {
    if ((enB.get(clave) ?? 0) !== vecesA) diferencias.push(desarmar(clave, 'solo en A'));
  }
  for (const [clave, vecesB] of enB) {
    if ((enA.get(clave) ?? 0) !== vecesB) diferencias.push(desarmar(clave, 'solo en B'));
  }

  return diferencias.sort(
    (x, y) => x.aspecto.localeCompare(y.aspecto) || x.valor.localeCompare(y.valor),
  );
}

function contar(
  lineas: { aspecto: DiferenciaEsquema['aspecto']; valor: string }[],
): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const l of lineas) {
    // Se cuenta en vez de usar un Set porque una misma línea puede repetirse
    // legítimamente (dos restricciones idénticas en tablas distintas, p. ej.).
    const clave = `${l.aspecto}\u0000${l.valor}`;
    mapa.set(clave, (mapa.get(clave) ?? 0) + 1);
  }
  return mapa;
}

function desarmar(clave: string, lado: DiferenciaEsquema['lado']): DiferenciaEsquema {
  const corte = clave.indexOf('\u0000');
  return {
    aspecto: clave.slice(0, corte) as DiferenciaEsquema['aspecto'],
    valor: clave.slice(corte + 1),
    lado,
  };
}

/** Mensaje legible para el fallo de un test. */
export function resumenDeDiferencias(diferencias: readonly DiferenciaEsquema[], limite = 40): string {
  if (diferencias.length === 0) return 'Los esquemas coinciden.';

  const mostradas = diferencias.slice(0, limite);
  const lineas = mostradas.map((d) => `  [${d.aspecto}] (${d.lado}) ${d.valor}`);
  const resto = diferencias.length - mostradas.length;

  return [
    `Los esquemas NO coinciden: ${diferencias.length} diferencia(s).`,
    ...lineas,
    ...(resto > 0 ? [`  … y ${resto} más.`] : []),
  ].join('\n');
}
