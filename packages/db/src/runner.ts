/**
 * Runner de migraciones.
 *
 * Aplica los archivos .sql en orden y lleva la cuenta en `schema_migrations`.
 * Es deliberadamente SIN dependencias y sin imports de Node: este módulo corre
 * igual en Node (tests, servidor) y en el navegador (PGlite), que es justo lo que
 * el proyecto necesita — un solo juego de migraciones para los dos motores.
 *
 * La lectura de los .sql desde disco vive aparte, en `archivos.ts`, porque eso sí
 * es cosa de Node y no debe arrastrarse al paquete del navegador.
 */

/** Lo mínimo que el runner necesita de una conexión. PGlite y `pg` lo cumplen. */
export interface ClienteSql {
  /** Ejecuta una o más sentencias SQL. Sin parámetros. */
  exec(sql: string): Promise<unknown>;
  /** Ejecuta una consulta y devuelve las filas. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Un cliente que además sabe abrir un bloque atómico.
 *
 * Va aparte de `ClienteSql` en vez de dentro, por dos razones: el runner de
 * migraciones no necesita transacciones (las escribe él mismo con BEGIN/COMMIT en
 * una sola llamada) y el contrato mínimo es más fácil de implementar en cualquier
 * motor. `emitirEvento()` sí lo necesita, y lo pide explícitamente.
 *
 * La transacción se **cierra sola**: si el callback lanza, se revierte y el error
 * original se propaga. `tx` es el mismo cliente: dentro del callback todo lo que se
 * escriba cae en la misma transacción.
 */
export interface ClienteTransaccional extends ClienteSql {
  transaction<T>(fn: (tx: ClienteSql) => Promise<T>): Promise<T>;
}

/** Una migración ya cargada en memoria, lista para aplicarse. */
export interface Migracion {
  /** Nombre del archivo: `0001_init.sql`. Es el identificador en la tabla. */
  nombre: string;
  /** El SQL completo del archivo. */
  sql: string;
  /** SHA-256 del contenido. Detecta que un archivo ya aplicado cambió. */
  hash: string;
}

export interface EstadoMigracion {
  nombre: string;
  hash: string;
  aplicado_at: Date;
  duracion_ms: number | null;
}

export interface ResultadoMigracion {
  /** Se aplicaron en esta llamada. */
  aplicadas: string[];
  /** Ya estaban aplicadas: no se volvieron a tocar. */
  yaAplicadas: string[];
  /**
   * Filas de `schema_migrations` cuyo archivo .sql ya no existe. No es un error
   * por sí mismo, pero se reporta: casi siempre significa que alguien borró una
   * migración que ya corrió, y el esquema de este dispositivo quedó con tablas
   * que ningún archivo puede volver a crear.
   */
  huerfanas: string[];
  estado: EstadoMigracion[];
}

/**
 * El archivo de una migración YA APLICADA cambió.
 *
 * Esto es más grave de lo que parece y por eso es un error duro: si `0001_init.sql`
 * se aplicó ayer en el PC y hoy se le agrega una columna, el PC y el celular
 * quedan con esquemas distintos sin que nada lo avise. La migración que ya corrió
 * es historia congelada; para cambiarla se escribe una migración nueva.
 */
export class ErrorMigracionDivergente extends Error {
  readonly nombre: string;
  readonly hashRegistrado: string;
  readonly hashActual: string;

  constructor(nombre: string, hashRegistrado: string, hashActual: string) {
    super(
      `La migración ${nombre} ya estaba aplicada, pero su archivo cambió después.\n` +
        `  hash cuando se aplicó : ${hashRegistrado}\n` +
        `  hash del archivo ahora: ${hashActual}\n` +
        `Una migración aplicada es historia congelada: los dispositivos que ya la corrieron\n` +
        `tienen un esquema y los que corran la versión nueva van a tener otro.\n` +
        `Revierte el archivo a su contenido original y escribe una migración NUEVA con el cambio.`,
    );
    this.name = 'ErrorMigracionDivergente';
    this.nombre = nombre;
    this.hashRegistrado = hashRegistrado;
    this.hashActual = hashActual;
  }
}

const SQL_TABLA_MIGRACIONES = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  nombre      text PRIMARY KEY,
  hash        text NOT NULL,
  aplicado_at timestamptz NOT NULL DEFAULT now(),
  duracion_ms integer
);`;

/**
 * Aplica las migraciones que falten. Idempotente: llamarlo dos veces es seguro.
 *
 * Las migraciones deben venir en orden; el runner no las ordena porque el orden
 * lo determina quien las carga (nombres 0001, 0002, …).
 */
export async function migrar(
  cliente: ClienteSql,
  migraciones: readonly Migracion[],
): Promise<ResultadoMigracion> {
  await cliente.exec(SQL_TABLA_MIGRACIONES);

  const registradas = await leerEstado(cliente);
  const porNombre = new Map(registradas.map((m) => [m.nombre, m]));

  // 1. Antes de tocar nada: ¿alguna migración aplicada cambió de contenido?
  //    Se comprueban TODAS primero para no dejar el esquema a medio aplicar.
  for (const m of migraciones) {
    const registrada = porNombre.get(m.nombre);
    if (registrada !== undefined && registrada.hash !== m.hash) {
      throw new ErrorMigracionDivergente(m.nombre, registrada.hash, m.hash);
    }
  }

  // 2. Migraciones que ya corrieron y cuyo archivo ya no está.
  const nombresPresentes = new Set(migraciones.map((m) => m.nombre));
  const huerfanas = registradas
    .filter((m) => !nombresPresentes.has(m.nombre))
    .map((m) => m.nombre);

  const yaAplicadas: string[] = [];
  const pendientes: Migracion[] = [];
  for (const m of migraciones) {
    if (porNombre.has(m.nombre)) {
      yaAplicadas.push(m.nombre);
    } else {
      pendientes.push(m);
    }
  }

  // 3. Aplicar lo pendiente, una por una y cada una en su propia transacción.
  //    Si la 0003 falla, la 0001 y la 0002 quedan aplicadas y registradas: no hay
  //    que repetir trabajo, y el error dice exactamente en qué archivo fue.
  const aplicadas: string[] = [];
  for (const m of pendientes) {
    await aplicarUna(cliente, m);
    aplicadas.push(m.nombre);
  }

  return { aplicadas, yaAplicadas, huerfanas, estado: await leerEstado(cliente) };
}

async function aplicarUna(cliente: ClienteSql, migracion: Migracion): Promise<void> {
  const inicio = performance.now();
  try {
    // El archivo y su registro van en la MISMA transacción: o quedan los dos, o
    // no queda ninguno. Si el proceso muere a media migración, la siguiente
    // ejecución no encuentra un esquema a medias sin registro (ni al revés).
    await cliente.exec(unirEnTransaccion(migracion));
  } catch (causa) {
    throw new Error(
      `Falló la migración ${migracion.nombre}. La transacción se revirtió: la base quedó como estaba.\n\n` +
        `${mensajeDe(causa)}`,
      { cause: causa },
    );
  }

  // La duración se mide desde fuera, así que se guarda después. No es crítica:
  // sirve para detectar el día que una migración empieza a tardar de más.
  const duracion = Math.round(performance.now() - inicio);
  await cliente.query('UPDATE schema_migrations SET duracion_ms = $1 WHERE nombre = $2', [
    duracion,
    migracion.nombre,
  ]);
}

function unirEnTransaccion(migracion: Migracion): string {
  return [
    'BEGIN;',
    migracion.sql,
    `INSERT INTO schema_migrations (nombre, hash) VALUES (${literal(migracion.nombre)}, ${literal(migracion.hash)});`,
    'COMMIT;',
  ].join('\n');
}

/** Escapa un texto para incrustarlo como literal SQL de forma segura. */
function literal(valor: string): string {
  return `'${valor.replaceAll("'", "''")}'`;
}

function mensajeDe(causa: unknown): string {
  if (causa instanceof Error) return causa.message;
  return String(causa);
}

async function leerEstado(cliente: ClienteSql): Promise<EstadoMigracion[]> {
  const { rows } = await cliente.query<EstadoMigracion>(
    'SELECT nombre, hash, aplicado_at, duracion_ms FROM schema_migrations ORDER BY nombre',
  );
  return rows;
}
