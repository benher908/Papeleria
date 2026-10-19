# `apps/web` — la aplicación del navegador

La base local del sistema: **PGlite** (Postgres real en WebAssembly) dentro del
navegador, con una sola instancia por origen, funcionando sin internet.

Por ahora esta app es **la capa de datos y su panel de diagnóstico**. La interfaz de
producto (POS, escaneo, etiquetas) llega después; está deliberadamente separada en
`src/diagnostico/` para no mezclarla con `src/db/`.

```powershell
pnpm web dev          # levanta la app en http://localhost:5173
pnpm web test         # pruebas (Node)
pnpm web build        # build de producción
pnpm web typecheck
```

---

## Qué garantiza, y por qué hay que verlo con dos pestañas

PGlite admite **una sola conexión**. Si dos pestañas abrieran cada una su instancia
contra el mismo directorio de IndexedDB, las dos escribirían los mismos archivos y la
base quedaría corrupta **sin error visible**: los datos empiezan a faltar días después.

La solución es una **elección de líder**:

1. Cada pestaña levanta su propio Web Worker.
2. Los workers compiten por un **Web Lock** con nombre (`navigator.locks.request`).
3. **Sólo el que gana** llama a `init()` y abre PGlite. Las demás pestañas le mandan sus
   consultas por `BroadcastChannel`.
4. Si la pestaña dueña se cierra, el navegador libera el cerrojo, otra gana, y su worker
   abre la base. El relevo no se nota.

Lo importante de esto no es que sea una buena idea nuestra: es que **la exclusión la
impone el navegador**. `navigator.locks` no permite dos dueños del mismo cerrojo, ni
siquiera queriendo. Y hay una segunda capa: en PGlite, `query`, `exec` y `transaction`
corren todos dentro de un cerrojo exclusivo del líder (verificado en su fuente), así que
tampoco dos pestañas pueden entrelazarse a mitad de una transacción.

> Consecuencia para el diseño: la regla de "**el PC es el único que escribe ventas**"
> ([docs/01 §4](../docs/01-arquitectura.md)) deja de ser una disciplina que hay que
> recordar. Dentro de un mismo navegador, el sistema no *puede* tener dos escritores.

### Cómo comprobarlo tú mismo

El panel de la app está construido para responder a esa pregunta y decir en qué capa
falla si falla algo:

```powershell
pnpm web dev
```

Abre `http://localhost:5173` **en dos pestañas**. Verás:

- La insignia: una pestaña es *líder · dueña de la base* y la otra es *seguidora · le
  pide todo al líder*. Una sola dueña, siempre.
- La sección **3 · Dos pestañas a la vez** escribe durante unos segundos en las mismas
  dos tablas. Cada transacción hace **dos cosas juntas**: inserta una marca y suma 1 al
  contador. Por eso, en cualquier instante, tiene que cumplirse `contador == marcas`.
- Veredicto esperado: **«Sin pérdidas»** con 2 o más pestañas distintas y filas de la
  otra pestaña dentro de la propia ventana de escritura.
- La sección **4 · Estado y evento, en una sola transacción** escribe una venta de verdad
  (venta, líneas, movimiento de stock, evento en la cola y auditoría). Tiene tres botones:
  *Vender*, *Vender y fallar a mitad* y *Borrar datos de prueba*. El segundo escribe el
  estado completo y **revienta a propósito justo después**; la foto antes/después tiene que
  salir idéntica, contadores incluidos. Ver [abajo](#lo-que-demuestra-la-sección-4).

El `UPDATE` va sobre **la misma fila** en todas las transacciones: es el peor caso
posible para perder una actualización. Si la prueba pasa, no es por falta de
concurrencia.

#### Lo que la prueba NO demuestra

No demuestra que la base sobreviva a dos escritores independientes. No lo demuestra
porque PGliteWorker **no los permite** — ésa es toda la gracia. Lo que se comprueba es
que la coordinación entre pestañas funciona.

#### Detalle que hace válida la prueba

El invariante `contador == marcas` vale **en cualquier instante**, también a mitad de la
prueba y también mientras la otra pestaña sigue escribiendo: las dos escrituras se
confirman juntas o no se confirman. Por eso **no hace falta** que las pestañas arranquen
a la vez, ni esperar a que terminen, ni sincronizar relojes. Una prueba que dependiera de
que dos pestañas arrancan en el mismo milisegundo sería una prueba que falla sola.

### Lo que demuestra la sección 4

La sección 3 comprueba que **dos pestañas** no se pisan. La 4 comprueba algo distinto y
más importante para el negocio: que **una venta no se puede guardar a medias**.

Una venta toca cinco sitios: `sales`, `sale_lines`, `stock_movements`, `outbox` y
`audit_log`, además de los contadores (`device_seq` y el folio de la terminal). Todo eso
pasa por `emitirEvento()`, que abre **una sola transacción**. El botón *Vender y fallar a
mitad* explota deliberadamente **después** de escribir el estado, que es el peor momento
posible: es donde un `try/catch` mal puesto dejaría la venta guardada, el evento sin
encolar y esa venta sin llegar nunca al servidor.

Y la venta pasa por la **autorización real** (tarea 0.6), no por un «permitir todo»:
`emitirEvento()` llama a `autorizar()` **dentro de la misma transacción**, que carga el rol
del usuario, las **30 reglas** sembradas y el step-up vigente, y decide con `evaluar()`. El
usuario de prueba es la dueña (rol `dueno`, los 44 permisos). Si se le quita el rol —o se le
vence el `expira_at`, que es como se prueba— el botón de vender deja de funcionar, con el
motivo exacto y sin escribir nada:

```text
No autorizado para emitir "sale.created": El rol no incluye ventas:crear
```

Comprobado en un navegador real: rol vencido → la venta rebota y la foto no cambia ni una
fila. Es la misma decisión que fija `packages/db/src/autorizacion.test.ts`, pero pasando por
PGlite, por el `IndexedDB` y por el Web Worker de verdad.

Cada pulsación imprime la cuenta antes y después; con el fallo provocado sale:

```text
ventas                1 → 1
líneas de venta       1 → 1
movimientos de stock  1 → 1
eventos en la cola    1 → 1
entradas de auditoría 1 → 1
device_seq            1 → 1
último folio local    C1-000001 → C1-000001
```

Ni un folio gastado, ni un hueco en `device_seq`. **El hueco en `device_seq` es el que
importa de verdad**: el servidor reclama a partir del último `device_seq` que vio, así que
un número quemado sin evento sería un evento que el servidor esperaría para siempre y la
sincronización se quedaría atascada en ese punto.

> El botón *Borrar datos de prueba* deja la base como recién migrada, así que la prueba se
> puede pulsar cien veces y el folio vuelve a empezar en `C1-000001`. Sólo borra las filas
> de cuatro ids literales del andamio; no puede alcanzar un dato real.

---

## Rendimiento: la decisión que más se nota

PGlite, por defecto, **espera el volcado a IndexedDB después de cada consulta**. Medido
en este equipo, con una transacción de cuatro sentencias:

| modo | ritmo | por transacción |
|---|---|---|
| por defecto (`relaxedDurability: false`) | 3 /s | ~300 ms |
| `relaxedDurability: true` | 64 /s | ~16 ms |

**Veintiún veces.** Es la diferencia entre una caja que tarda un segundo en cobrar y una
que cobra al instante.

`relaxedDurability` significa que la consulta puede volver **antes** de que el cambio
esté en disco. Si el navegador muere de golpe en esos milisegundos, se pierden las
últimas escrituras. La decisión, entonces, no es «¿durabilidad sí o no?», sino **dónde se
paga**:

- `relaxedDurability: true` para todo lo interactivo.
- `sincronizar()` — que es `syncToFs()`, fuerza el volcado **y espera** — en los
  momentos en que el dato tiene que estar a salvo: **al cerrar una venta**, al emitir un
  evento del `outbox`, al cerrar caja.

Así no hay ninguna escritura importante que quede sin confirmar, y no se paga el precio
en cada pulsación de tecla.

> Si algún día alguien prefiere durabilidad total a velocidad, es cambiar una línea en
> `src/db/pglite.worker.ts`. Pero conviene volver a medir antes: 3 transacciones por
> segundo hace inservible el POS.

---

## Piezas

| Archivo | Qué es |
|---|---|
| `src/db/pglite.worker.ts` | El obrero que **es dueño** de la base. Sólo lo ejecuta la pestaña líder; ahí corren las migraciones, una sola vez por origen. |
| `src/db/baseLocal.ts` | El cliente tipado. Nadie más toca PGlite: la app usa `consultar`, `ejecutar`, `enTransaccion`, `sincronizar`. |
| `src/db/cliente.ts` | Traduce ese cliente al contrato `query`/`exec`/`transaction` que espera `@papeleria/db`. |
| `src/db/migraciones.ts` | Los `.sql` de `packages/db` incrustados en el bundle por Vite. |
| `src/diagnostico/` | El panel: capas, migraciones, semillas, la prueba de dos pestañas y la de la transacción. |
| `src/diagnostico/outbox.ts` | La venta de prueba de la sección 4: la emite, la revienta y borra lo que dejó. |
| `src/estilos.css` | Estilos propios. Tailwind y shadcn/ui llegan con la interfaz de producto, no antes. |

### Las migraciones: un solo origen para dos caminos

El servidor las lee del disco (`packages/db/node`); el navegador las recibe incrustadas
por `import.meta.glob` de Vite. Los dos caminos desembocan en la **misma** función
(`armarMigraciones`), y hay dos pruebas que lo fijan: una compara el bundle contra el
disco (nombres, orden y hashes), y el hash se contrasta contra los vectores publicados de
SHA-256 y contra `node:crypto`.

Esto no es paranoia: al escribirlo, la ruta del glob estaba mal y Vite **no protesta
cuando un glob no encaja con ningún archivo** — devuelve una lista vacía. La app habría
arrancado sin ninguna tabla. La prueba del bundle lo detectó, y desde entonces
`migracionesDeFabrica()` también **falla gritando** si el bundle se queda sin migraciones.

### El hash es el mismo en los dos lados

`hashDe` usa WebCrypto (`crypto.subtle`), no `node:crypto`, porque el hash de una
migración va a `schema_migrations` y tiene que ser idéntico en el servidor y en el
navegador. Si cada lado calculara el suyo, dos dispositivos con el mismo archivo
registrarían hashes distintos y el detector de divergencias del runner empezaría a dar
falsos positivos. `crypto.subtle` es global en Node desde la 19, así que es **una sola
implementación** para los dos lados.

---

## Coste de carga

El bundle de producción incluye el motor completo, porque el requisito es **funcionar sin
internet**:

| pieza | tamaño |
|---|---|
| `pglite.wasm` | 10,5 MB (3,7 MB comprimido) |
| `pglite.data` | 6,2 MB |
| worker + app | ~1,7 MB |

Son ~17 MB **la primera vez**. Después queda en caché (y el service worker lo pre-cachea
cuando llegue la PWA). Es el precio de tener un Postgres entero que no depende de la red.

---

## Requisitos del navegador

La base local necesita **contexto seguro**: `https://` o `localhost`. No es un capricho
configurable — `navigator.locks` (la elección de líder), `crypto.subtle` y
`crypto.randomUUID` sólo existen ahí. El panel comprueba las capas una por una y dice cuál
falta, en lugar de fallar en silencio.

Instalar la app como PWA **no** exime de esto. Es el mismo malentendido que con la cámara.
