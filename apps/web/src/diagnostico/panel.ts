/**
 * El panel de diagnóstico de la capa local.
 *
 * No es una pantalla de producto: es una herramienta que tiene que decir, sin
 * ambigüedad, en qué capa está el problema cuando algo va mal. La misma idea que el
 * probador de cámara de `tools/prueba-camara`: contexto seguro, Web Locks, worker,
 * migraciones, semillas, y por último la prueba de dos pestañas. Si falla algo, se ve
 * cuál de todas falló.
 */

import { DIRECTORIO_POR_DEFECTO, baseLocal, type BaseLocal } from '../db/baseLocal';
import { comprobarCatalogo } from './catalogo';
import { ejecutarPrueba, reiniciar, type ResultadoPrueba } from './multipestana';

type Celda = string | Node;

export async function montarPanel(raiz: HTMLElement): Promise<void> {
  raiz.replaceChildren();
  const panel = crear('div', 'panel');
  raiz.append(panel);

  const insignia = crear('span', 'insignia');
  const titulo = crear('div', 'titulo');
  titulo.append(crear('h1', undefined, 'Papelería · base local'));
  titulo.append(crear('p', 'subtitulo', `Diagnóstico de PGlite en el navegador · ${DIRECTORIO_POR_DEFECTO}`));
  panel.append(insignia, titulo);

  // ── capa 0: ¿el navegador reúne lo necesario? ──────────────────────────────
  const faltan = capasQueFaltan();
  if (faltan.length > 0) {
    panel.append(
      aviso('Este navegador no puede usar la base local', faltan, [
        'En el PC, abre la app en http://localhost (cuenta como contexto seguro).',
        'Desde el teléfono hace falta HTTPS de verdad: ver tools/prueba-camara.',
      ]),
    );
    return;
  }

  // ── capa 1: abrir la base (y con ella, el worker y las migraciones) ────────
  let base: BaseLocal;
  try {
    base = await baseLocal();
  } catch (causa) {
    panel.append(
      aviso('No se pudo abrir la base local', [mensaje(causa)], [
        'Suele ser el worker o el almacenamiento. Abre las herramientas del navegador → Consola, donde el worker también escribe.',
      ]),
    );
    return;
  }

  const pintarInsignia = (): void => {
    insignia.textContent = base.esLider ? 'líder · dueña de la base' : 'seguidora · le pide todo al líder';
    insignia.classList.toggle('lider', base.esLider);
  };
  pintarInsignia();
  base.alCambiarLider(() => {
    pintarInsignia();
    void refrescarVersion();
  });
  panel.append(seccionMigraciones());
  panel.append(seccionEsquema());
  panel.append(seccionDosPestanas());

  const cuerpoVersion = crear('p', 'nota');
  panel.append(cuerpoVersion);

  // La consulta se reintenta: cuando el líder cierra su pestaña hay un instante en el
  // que la base todavía no tiene dueño, y una consulta lanzada justo ahí falla. Sin
  // reintento, cerrar una pestaña cualquiera haría parpadear un error en las demás, que
  // es justo lo contrario de lo que pasa de verdad: el relevo no se nota.
  async function refrescarVersion(): Promise<void> {
    for (let intento = 1; intento <= 4; intento++) {
      try {
        const fila = await base.consultarUno<{ v: string }>('SELECT version() AS v');
        cuerpoVersion.textContent = fila?.v ?? '';
        return;
      } catch (causa) {
        if (intento === 4) {
          cuerpoVersion.textContent = `(la base no responde: ${mensaje(causa)})`;
          return;
        }
        await esperar(300);
      }
    }
  }
  void refrescarVersion();

  // ── sección 1: migraciones ────────────────────────────────────────────────
  function seccionMigraciones(): HTMLElement {
    const { seccion, cuerpo } = tarjeta(
      '1 · Migraciones aplicadas',
      'Las mismas que aplica el servidor. Se aplican una sola vez, en el líder, y quedan registradas con su hash.',
    );

    void (async () => {
      try {
        const filas = await base.consultar<{
          nombre: string;
          aplicada: string;
          duracion_ms: number | null;
        }>(
          `SELECT nombre,
                  to_char(aplicado_at, 'YYYY-MM-DD HH24:MI:SS') AS aplicada,
                  duracion_ms
             FROM schema_migrations
            ORDER BY nombre`,
        );

        cuerpo.append(
          tabla(
            ['archivo', 'aplicada', 'duración'],
            filas.map((f) => [
              f.nombre,
              f.aplicada,
              f.duracion_ms === null ? '—' : `${f.duracion_ms} ms`,
            ]),
          ),
        );

        const huerfanas = await base.consultar<{ nombre: string }>(
          `SELECT nombre FROM schema_migrations
            WHERE nombre NOT IN ('0001_init.sql', '0002_rbac_abac.sql', '0003_seed_catalogos.sql')`,
        );
        if (huerfanas.length > 0) {
          cuerpo.append(
            aviso('Hay migraciones registradas que el bundle no conoce', [
              huerfanas.map((h) => h.nombre).join(', '),
            ]),
          );
        }
      } catch (causa) {
        cuerpo.append(aviso('No se pudo leer schema_migrations', [mensaje(causa)]));
      }
    })();

    return seccion;
  }

  // ── sección 2: esquema y semillas ─────────────────────────────────────────
  function seccionEsquema(): HTMLElement {
    const { seccion, cuerpo } = tarjeta(
      '2 · Esquema y semillas',
      'Lo que llegó al navegador, comparado con lo que fijan las pruebas de packages/db.',
    );

    void (async () => {
      try {
        const resultados = await comprobarCatalogo(base);
        cuerpo.append(
          tabla(
            ['qué', 'esperado', 'encontrado', ''],
            resultados.map((r) => [
              r.que,
              String(r.esperado),
              String(r.encontrado),
              marca(r.encontrado === r.esperado),
            ]),
          ),
        );

        const mal = resultados.filter((r) => r.encontrado !== r.esperado);
        if (mal.length > 0) {
          cuerpo.append(
            aviso(
              'El esquema no coincide con lo esperado',
              mal.map((r) => `${r.que}: esperado ${r.esperado}, encontrado ${r.encontrado}`),
            ),
          );
        }
      } catch (causa) {
        cuerpo.append(aviso('No se pudo comprobar el esquema', [mensaje(causa)]));
      }
    })();

    return seccion;
  }

  // ── sección 3: dos pestañas ───────────────────────────────────────────────
  function seccionDosPestanas(): HTMLElement {
    const { seccion, cuerpo } = tarjeta(
      '3 · Dos pestañas a la vez',
      'Cada pestaña escribe durante unos segundos en las mismas dos tablas. El contador y el número de marcas tienen que cuadrar SIEMPRE, porque cada transacción toca los dos.',
    );

    cuerpo.append(
      crear(
        'p',
        'explicacion',
        'Abre esta misma página en otra pestaña mientras la prueba escribe (o pulsa Repetir en las dos). Lo que importa no es que arranquen a la vez: el invariante se cumple en cualquier instante.',
      ),
    );

    const caja = crear('div', 'prueba');
    cuerpo.append(caja);

    const botones = crear('div', 'botones');
    const repetir = crear('button', 'boton', 'Repetir prueba');
    const limpiar = crear('button', 'boton secundario', 'Borrar datos de prueba');
    botones.append(repetir, limpiar);
    cuerpo.append(botones);

    let corriendo = false;

    async function correr(): Promise<void> {
      if (corriendo) return;
      corriendo = true;
      repetir.disabled = true;
      caja.replaceChildren(
        crear('p', 'trabajando', 'Escribiendo… si vas a abrir otra pestaña, es ahora.'),
      );

      try {
        const resultado = await ejecutarPrueba(base);
        caja.replaceChildren(informe(resultado));
      } catch (causa) {
        caja.replaceChildren(aviso('La prueba falló', [mensaje(causa)]));
      } finally {
        corriendo = false;
        repetir.disabled = false;
      }
    }

    repetir.addEventListener('click', () => void correr());

    limpiar.addEventListener('click', () => {
      void (async () => {
        try {
          await reiniciar(base);
          caja.replaceChildren(crear('p', 'nota', 'Datos de prueba borrados. El esquema sigue intacto.'));
        } catch (causa) {
          caja.replaceChildren(aviso('No se pudieron borrar los datos de prueba', [mensaje(causa)]));
        }
      })();
    });

    void correr();
    return seccion;
  }
}

// ─────────────────────────────── piezas ───────────────────────────────

function informe(resultado: ResultadoPrueba): HTMLElement {
  const caja = crear('div', 'resultado');

  const textos: Record<ResultadoPrueba['veredicto'], [string, string]> = {
    correcto: [
      'correcto',
      'Sin pérdidas: hubo varias pestañas escribiendo y el contador cuadra con las marcas.',
    ],
    'sin-concurrencia': [
      'aviso',
      'Cuadra, pero sólo escribió esta pestaña. Abre la página en otra pestaña y pulsa Repetir.',
    ],
    perdidas: [
      'fallo',
      'Se perdieron escrituras: el contador no cuadra con las marcas. No uses esta base.',
    ],
  };
  const [clase, texto] = textos[resultado.veredicto];
  const veredicto = crear('div', `veredicto ${clase}`);
  veredicto.append(crear('strong', undefined, texto));
  caja.append(veredicto);

  const porSegundo =
    resultado.duracionMs > 0 ? (resultado.iteraciones / (resultado.duracionMs / 1000)).toFixed(0) : '—';

  caja.append(
    tabla(
      ['medida', 'valor'],
      [
        ['contador compartido', String(resultado.contador)],
        ['filas en pruebas.marca', String(resultado.marcas)],
        ['diferencia (marcas − contador)', String(resultado.diferencia)],
        ['pestañas distintas que escribieron', String(resultado.pestanasDistintas)],
        ['transacciones de esta pestaña', String(resultado.iteraciones)],
        ['…y sus filas encontradas', String(resultado.misMarcas)],
        ['filas de otras pestañas dentro de mi ventana', String(resultado.ajenasEntrelazadas)],
        ['ritmo', `${porSegundo} transacciones/s`],
        ['mi ventana', `${resultado.desde ?? '—'} → ${resultado.hasta ?? '—'}`],
      ],
    ),
  );

  if (resultado.veredicto === 'correcto' && resultado.ajenasEntrelazadas === 0) {
    caja.append(
      crear(
        'p',
        'nota',
        'Ojo: cuadra, pero las filas de la otra pestaña no cayeron dentro de mi ventana. Hubo dos pestañas, aunque quizá no se pisaron de verdad. Pulsa Repetir en las dos a la vez para forzarlo.',
      ),
    );
  }

  return caja;
}

function capasQueFaltan(): string[] {
  const faltan: string[] = [];

  if (!window.isSecureContext) {
    faltan.push(
      'Esta página no es un contexto seguro. Web Locks (navigator.locks) y crypto.subtle sólo existen en https:// o en localhost; sin ellos PGlite no puede elegir un líder.',
    );
  }
  if (typeof navigator.locks?.request !== 'function') {
    faltan.push('El navegador no expone la API Web Locks, que es la que garantiza un solo dueño de la base.');
  }
  if (typeof Worker === 'undefined') {
    faltan.push('El navegador no tiene Web Workers, y PGlite tiene que correr en uno.');
  }
  if (typeof indexedDB === 'undefined') {
    faltan.push('El navegador no tiene IndexedDB, que es donde se guarda la base.');
  }

  return faltan;
}

function tarjeta(titulo: string, descripcion: string): { seccion: HTMLElement; cuerpo: HTMLElement } {
  const seccion = crear('section', 'tarjeta');
  seccion.append(crear('h2', undefined, titulo));
  seccion.append(crear('p', 'descripcion', descripcion));
  const cuerpo = crear('div');
  seccion.append(cuerpo);
  return { seccion, cuerpo };
}

function aviso(titulo: string, lineas: readonly string[], siguientes: readonly string[] = []): HTMLElement {
  const caja = crear('div', 'aviso');
  caja.append(crear('strong', undefined, titulo));
  for (const linea of lineas) caja.append(crear('p', undefined, linea));
  if (siguientes.length > 0) {
    const lista = crear('ul');
    for (const siguiente of siguientes) lista.append(crear('li', undefined, siguiente));
    caja.append(lista);
  }
  return caja;
}

function tabla(cabeceras: readonly string[], filas: readonly (readonly Celda[])[]): HTMLTableElement {
  const t = crear('table');

  const thead = crear('thead');
  const filaCabecera = crear('tr');
  for (const cabecera of cabeceras) filaCabecera.append(crear('th', undefined, cabecera));
  thead.append(filaCabecera);
  t.append(thead);

  const tbody = crear('tbody');
  for (const fila of filas) {
    const tr = crear('tr');
    for (const celda of fila) {
      const td = crear('td');
      if (typeof celda === 'string') td.textContent = celda;
      else td.append(celda);
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(tbody);

  return t;
}

function marca(bien: boolean): HTMLElement {
  const span = crear('span', bien ? 'ok' : 'mal', bien ? '✓' : '✗');
  return span;
}

function mensaje(causa: unknown): string {
  if (causa instanceof Error) return causa.message;
  return String(causa);
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

function crear<K extends keyof HTMLElementTagNameMap>(
  etiqueta: K,
  clase?: string,
  texto?: string,
): HTMLElementTagNameMap[K] {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}
