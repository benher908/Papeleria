/**
 * La prueba que responde a "¿dos pestañas corrompen la base?".
 *
 * La idea
 * ───────
 * Cada transacción hace DOS cosas, siempre juntas:
 *
 *     INSERT INTO pruebas.marca  (quien, iteracion) VALUES (pestaña, i)
 *     UPDATE pruebas.contador    SET n = n + 1
 *
 * Por lo tanto, en cualquier instante —también a mitad de la prueba, y también si la
 * otra pestaña todavía está escribiendo— tiene que cumplirse:
 *
 *     contador.n  ==  count(* de pruebas.marca)
 *
 * No hace falta que las pestañas arranquen al mismo tiempo, ni esperar a que terminen,
 * ni sincronizar relojes: el invariante se sostiene solo. Si dos transacciones se
 * entrelazaran a mitad (`UPDATE` perdido), el contador quedaría por debajo del número
 * de marcas. Si la base se corrompiera, los dos números dejarían de tener sentido.
 *
 * Y como el `UPDATE` va sobre la MISMA fila, todas las transacciones se pelean por el
 * mismo cerrojo de fila: es la peor situación posible para perder una actualización.
 * Si la prueba pasa, no es por falta de concurrencia.
 *
 * Qué NO prueba esto: que la base sobreviva a dos escritores independientes. No lo
 * prueba porque PGliteWorker no los permite —ésa es toda la gracia—. Lo que se
 * comprueba es que la coordinación entre pestañas funciona.
 */

import type { BaseLocal } from '../db/baseLocal';

export type Veredicto = 'correcto' | 'sin-concurrencia' | 'perdidas';

export interface OpcionesPrueba {
  /** Cuánto escribe cada pestaña. Más tiempo, más ocasiones de pisarse. */
  duracionMs?: number;
}

export interface ResultadoPrueba {
  idPestana: string;
  iteraciones: number;
  duracionMs: number;
  /** Valor del contador compartido. */
  contador: number;
  /** Filas en la tabla de marcas. */
  marcas: number;
  /** Pestañas distintas que escribieron (según la base, no según el navegador). */
  pestanasDistintas: number;
  /** Filas de esta pestaña. */
  misMarcas: number;
  /** Filas de OTRAS pestañas que caen dentro de mi ventana de escritura. */
  ajenasEntrelazadas: number;
  diferencia: number;
  veredicto: Veredicto;
  /** Ventana en la que escribió esta pestaña. */
  desde: string | null;
  hasta: string | null;
}

/** Crea las tablas de la prueba si no existen. Es idempotente. */
export async function prepararEsquema(base: BaseLocal): Promise<void> {
  await base.lote(`
    CREATE SCHEMA IF NOT EXISTS pruebas;

    CREATE TABLE IF NOT EXISTS pruebas.contador (
      id integer PRIMARY KEY,
      n  bigint  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pruebas.marca (
      id        bigserial   PRIMARY KEY,
      quien     text        NOT NULL,
      iteracion integer     NOT NULL,
      cuando    timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    INSERT INTO pruebas.contador (id, n) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  `);
}

/** Borra las marcas y deja el contador en cero. No toca `public`. */
export async function reiniciar(base: BaseLocal): Promise<void> {
  await base.lote(`
    TRUNCATE pruebas.marca RESTART IDENTITY;
    UPDATE pruebas.contador SET n = 0 WHERE id = 1;
  `);
}

export async function ejecutarPrueba(
  base: BaseLocal,
  opciones: OpcionesPrueba = {},
): Promise<ResultadoPrueba> {
  const duracionObjetivo = opciones.duracionMs ?? 4000;
  const idPestana = crypto.randomUUID();

  await prepararEsquema(base);

  const inicio = performance.now();
  let iteraciones = 0;

  // Se escribe durante un rato en vez de un número fijo de veces: así, si abres la
  // segunda pestaña mientras la primera está en marcha, se solapan de verdad.
  while (performance.now() - inicio < duracionObjetivo) {
    const iteracion = iteraciones + 1;
    await base.enTransaccion(async (tx) => {
      await tx.ejecutar('INSERT INTO pruebas.marca (quien, iteracion) VALUES ($1, $2)', [
        idPestana,
        iteracion,
      ]);
      await tx.ejecutar('UPDATE pruebas.contador SET n = n + 1 WHERE id = 1');
    });
    iteraciones = iteracion;
  }

  const duracionMs = performance.now() - inicio;

  // Un respiro para que otra pestaña que venía escribiendo termine su última
  // transacción. No hace falta para el invariante, pero mejora la foto.
  await esperar(600);

  const resultado = await verificar(base, idPestana, iteraciones, duracionMs);
  return resultado;
}

async function verificar(
  base: BaseLocal,
  idPestana: string,
  iteraciones: number,
  duracionMs: number,
): Promise<ResultadoPrueba> {
  const contador = Number(
    (await base.consultarUno<{ n: string }>('SELECT n::text AS n FROM pruebas.contador WHERE id = 1'))
      ?.n ?? Number.NaN,
  );
  const marcas = await numero(base, 'SELECT count(*)::int AS n FROM pruebas.marca');
  const pestanasDistintas = await numero(
    base,
    'SELECT count(DISTINCT quien)::int AS n FROM pruebas.marca',
  );
  const misMarcas = await numero(
    base,
    'SELECT count(*)::int AS n FROM pruebas.marca WHERE quien = $1',
    [idPestana],
  );

  const ventana = await base.consultarUno<{ desde: string | null; hasta: string | null }>(
    `SELECT min(cuando)::text AS desde, max(cuando)::text AS hasta
       FROM pruebas.marca WHERE quien = $1`,
    [idPestana],
  );

  const ajenasEntrelazadas =
    ventana?.desde && ventana.hasta
      ? await numero(
          base,
          `SELECT count(*)::int AS n FROM pruebas.marca
            WHERE quien <> $1 AND cuando BETWEEN $2::timestamptz AND $3::timestamptz`,
          [idPestana, ventana.desde, ventana.hasta],
        )
      : 0;

  const diferencia = marcas - contador;

  // El orden importa: perder escrituras es grave; no haber tenido concurrencia es
  // sólo una prueba que no probó nada.
  const veredicto: Veredicto =
    contador !== marcas ? 'perdidas' : pestanasDistintas < 2 ? 'sin-concurrencia' : 'correcto';

  return {
    idPestana,
    iteraciones,
    duracionMs,
    contador,
    marcas,
    pestanasDistintas,
    misMarcas,
    ajenasEntrelazadas,
    diferencia,
    veredicto,
    desde: ventana?.desde ?? null,
    hasta: ventana?.hasta ?? null,
  };
}

async function numero(base: BaseLocal, sql: string, params?: unknown[]): Promise<number> {
  const fila = await base.consultarUno<{ n: number }>(sql, params);
  return fila?.n ?? -1;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, Math.max(0, ms)));
}
