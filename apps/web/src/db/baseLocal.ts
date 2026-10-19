/**
 * La base local del navegador: un solo PGlite por origen, elegido entre pestañas.
 *
 * El problema que resuelve este archivo
 * ─────────────────────────────────────
 * PGlite admite **una sola conexión**. Si dos pestañas abrieran cada una su instancia
 * contra el mismo directorio de IndexedDB, las dos escribirían los mismos archivos y la
 * base terminaría corrupta, sin error visible: la corrupción aparece días después, como
 * datos que faltan.
 *
 * `PGliteWorker` lo evita con una elección de líder: cada pestaña levanta su worker,
 * los workers compiten por un **Web Lock** con nombre (`navigator.locks`), y sólo el
 * que lo obtiene llama a `init()` y abre PGlite. Las demás pestañas le mandan sus
 * consultas por `BroadcastChannel`. Si el líder cierra la pestaña, el navegador libera
 * el lock, otra gana y su worker abre la base.
 *
 * No es una convención nuestra ni un "ojalá": la exclusión la impone el navegador, y
 * PGlite además serializa `query`, `exec` y `transaction` a través de un cerrojo
 * exclusivo del líder, de modo que dos pestañas tampoco se entrelazan a mitad de una
 * transacción. El detalle está verificado en el fuente de PGlite y hay una prueba
 * manual reproducible en `/` (ver el panel de diagnóstico).
 *
 * Por eso `id` (el grupo de elección) tiene que ser una constante: dos pestañas con
 * ids distintos competirían en elecciones distintas, ganarían las dos, y abrirían dos
 * PGlite sobre el mismo directorio. Ésa es exactamente la forma de corromper la base.
 */

import { LeaderChangedError, PGliteWorker } from '@electric-sql/pglite/worker';

export { LeaderChangedError };

/** Consultas contra la base, fuera o dentro de una transacción. */
export interface Consultas {
  /** Filas del `SELECT`. */
  consultar<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Primera fila, o `undefined` si no hay ninguna. */
  consultarUno<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
  /** Filas afectadas por un `INSERT`/`UPDATE`/`DELETE`. */
  ejecutar(sql: string, params?: unknown[]): Promise<number>;
  /** Varias sentencias de una vez. Sin parámetros. */
  lote(sql: string): Promise<void>;
}

export interface BaseLocal extends Consultas {
  /**
   * Ejecuta `cuerpo` dentro de una transacción: o se confirma todo, o nada.
   *
   * El cerrojo lo toma el líder, así que ninguna otra pestaña puede colarse entre el
   * `BEGIN` y el `COMMIT`. Es lo que hace segura la regla de la venta: el descuento de
   * stock y la venta se escriben juntos o no se escriben.
   */
  enTransaccion<T>(cuerpo: (tx: Consultas) => Promise<T>): Promise<T>;

  /** `true` si esta pestaña es la dueña de la base. Informativo, no una condición. */
  readonly esLider: boolean;

  /** Avisa cuando cambia el líder. Devuelve la función para desuscribirse. */
  alCambiarLider(escucha: () => void): () => void;

  /**
   * Fuerza el volcado a IndexedDB y **espera** a que termine.
   *
   * La base arranca con `relaxedDurability` (ver `pglite.worker.ts`): las consultas
   * vuelven sin esperar al disco, 21 veces más rápido. Eso significa que, durante unos
   * milisegundos, un cambio confirmado puede no estar todavía en disco.
   *
   * Este método cierra esa ventana. Se llama cuando el dato tiene que estar a salvo de
   * verdad — al cerrar una venta, al emitir un evento del `outbox`— y no en cada
   * consulta, que es justo lo que hacía lento el modo por defecto.
   */
  sincronizar(): Promise<void>;

  cerrar(): Promise<void>;
}

/** Dónde vive la base. `idb://` persiste en IndexedDB. */
export const DIRECTORIO_POR_DEFECTO = 'idb://papeleria';

/** Grupo de elección de líder. Constante: ver la nota de arriba. */
export const GRUPO_POR_DEFECTO = 'papeleria';

export interface OpcionesBaseLocal {
  /** Cambia el directorio (útil para pruebas aisladas). */
  dataDir?: string;
  /** Cambia el grupo de elección (útil para pruebas aisladas). */
  grupo?: string;
}

let pendiente: Promise<BaseLocal> | undefined;

/**
 * La base de este origen, abierta una sola vez y compartida por toda la app.
 *
 * Se cachea la promesa, no el resultado: dos llamadas simultáneas durante el arranque
 * comparten la misma apertura en vez de crear dos workers.
 */
export function baseLocal(): Promise<BaseLocal> {
  pendiente ??= abrirBaseLocal();
  return pendiente;
}

/** Abre la base. Normalmente se usa `baseLocal()`; esto existe para aislar pruebas. */
export async function abrirBaseLocal(opciones: OpcionesBaseLocal = {}): Promise<BaseLocal> {
  const obrero = new Worker(new URL('./pglite.worker.ts', import.meta.url), { type: 'module' });

  const pg = await PGliteWorker.create(obrero, {
    dataDir: opciones.dataDir ?? DIRECTORIO_POR_DEFECTO,
    id: opciones.grupo ?? GRUPO_POR_DEFECTO,
  });

  return envolver(pg);
}

/** Lo mínimo que se necesita de un cliente para envolverlo. PGlite y su transacción cumplen. */
interface ClienteCrudo {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

function consultasDe(cliente: ClienteCrudo): Consultas {
  return {
    async consultar<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const { rows } = await cliente.query<T>(sql, params);
      return rows;
    },

    async consultarUno<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      const { rows } = await cliente.query<T>(sql, params);
      return rows[0];
    },

    async ejecutar(sql: string, params?: unknown[]): Promise<number> {
      const { affectedRows } = await cliente.query(sql, params);
      return affectedRows ?? 0;
    },

    async lote(sql: string): Promise<void> {
      await cliente.exec(sql);
    },
  };
}

function envolver(pg: PGliteWorker): BaseLocal {
  return {
    ...consultasDe(pg),

    enTransaccion: (cuerpo) => pg.transaction((tx) => cuerpo(consultasDe(tx))),

    get esLider(): boolean {
      return pg.isLeader;
    },

    alCambiarLider(escucha: () => void): () => void {
      return pg.onLeaderChange(escucha);
    },

    sincronizar: () => pg.syncToFs(),

    cerrar: () => pg.close(),
  };
}
