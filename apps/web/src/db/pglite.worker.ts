/**
 * El obrero que es dueño de la base.
 *
 * Corre en un Web Worker por dos motivos que no son de estilo:
 *
 *  1. PGlite es un Postgres compilado a WASM y trabaja de forma **síncrona**. En el
 *     hilo principal, cada consulta congelaría la interfaz.
 *  2. Sólo así se pueden usar los manejadores de OPFS y, sobre todo, la elección de
 *     líder de `PGliteWorker`, que es lo que garantiza una sola instancia por origen.
 *
 * Este archivo NO se importa desde la página: se instancia con `new Worker(...)` desde
 * `baseLocal.ts`. Y `init` sólo lo ejecuta el obrero que ganó la elección, así que
 * las migraciones se aplican exactamente una vez aunque haya diez pestañas abiertas.
 */

import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
import { adaptarPglite, migrar } from '@papeleria/db';
import { migracionesDeFabrica } from './migraciones';

worker({
  async init(opciones) {
    const dataDir = opciones.dataDir;
    if (!dataDir) {
      // Preferible fallar aquí que abrir una base en memoria sin avisar: la app se
      // vería funcionar y perdería todo al recargar.
      throw new Error(
        'El obrero de la base necesita dataDir (por ejemplo idb://papeleria). ' +
          'Se pasa en las opciones de PGliteWorker.create().',
      );
    }

    const db = await PGlite.create({
      dataDir,

      // Restauración: el archivo llega desde `PGliteWorker.create({ loadDataDir })`.
      // Sin reenviarlo aquí, PGlite abriría un directorio vacío y la pantalla diría
      // que restauró bien mientras la papelería desaparece. Se descubrió probando
      // la restauración de punta a punta, no en las pruebas unitarias.
      ...(opciones.loadDataDir === undefined
        ? {}
        : { loadDataDir: opciones.loadDataDir as Blob | File }),

      // ── Por qué se renuncia a la durabilidad por defecto ─────────────────────
      // Sin esto, PGlite **espera el volcado a IndexedDB después de cada consulta**.
      // Medido en este equipo con una transacción de 4 sentencias:
      //
      //     por defecto            3 transacciones/s   (~300 ms cada una)
      //     relaxedDurability     64 transacciones/s   (~16 ms cada una)
      //
      // Veintiún veces. La diferencia entre una caja que tarda un segundo en cobrar
      // y una que cobra al instante.
      //
      // Lo que se pierde: la consulta puede volver antes de que el cambio esté en
      // disco. Si el navegador muere de golpe en esos milisegundos, se pierden las
      // últimas escrituras. Por eso el cliente expone `sincronizar()`, que fuerza el
      // volcado y espera: se llama en los momentos en que el dato tiene que estar a
      // salvo (cerrar una venta, por ejemplo), en vez de pagar el precio en cada
      // pulsación de tecla.
      relaxedDurability: true,
    });

    const resultado = await migrar(adaptarPglite(db), await migracionesDeFabrica());
    if (resultado.aplicadas.length > 0) {
      console.info('[pglite] migraciones aplicadas:', resultado.aplicadas);
    }

    return db;
  },
});
