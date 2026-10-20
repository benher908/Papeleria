# `apps/web` — la aplicación del navegador

La base local del sistema: **PGlite** (Postgres real en WebAssembly) dentro del
navegador, con una sola instancia por origen, funcionando sin internet.

Es una **PWA instalable**: se abre como app desde el escritorio o el celular y sigue
funcionando sin red (ver [La app instalable](#la-app-instalable-pwa)). Hoy tiene la
entrada, el **POS y la caja** (F2) y el **catálogo de productos** (alta, listado y
edición, F1.1), además del panel de diagnóstico. El escaneo con el celular y las
etiquetas llegan después; el diagnóstico vive aparte en `src/diagnostico/` para no
mezclarlo con la interfaz de negocio.

Al abrir por primera vez, la app pide **crear la cuenta de la dueña** (no hay servidor
del que traerla) y después ya sólo pide la contraseña cuando la sesión de verdad venció.
Detalle abajo, en [La entrada](#la-entrada-el-login-local-que-no-depende-de-un-servidor).

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

## La entrada: el login local, que no depende de un servidor

El requisito que manda aquí es **vender sin internet**. Un bloqueo de sesión que necesitara
preguntarle a un servidor dejaría el PC inservible justo el día que se cae el router, así
que la autenticación vive **en la misma base local**: la cuenta, el dispositivo y las
sesiones son filas de PGlite, y la comprobación de la contraseña se hace contra el hash
guardado en el navegador. Ver el porqué completo en
[docs/07 §2.4](../docs/07-sesiones-y-seguridad.md).

```text
Primer arranque  →  se crea la cuenta de la dueña (nombre, usuario, contraseña)
Entrar           →  en cualquier arranque posterior
Dentro           →  barra «Benedicta · caja C1 · Salir» y, debajo, el panel
```

El criterio de la tarea 0.7, y cómo se comprueba:

| Criterio | Cómo se fija |
|---|---|
| Entras con la contraseña correcta | `entrar()` verifica con Argon2id y abre una fila en `sessions` |
| La sesión **persiste** al recargar | Se guarda el token y, al volver, `verificarSesion()` lo acepta: **no vuelve a pedir la contraseña** |
| Deja de valer cuando debe | Vencida (30 min inactivo / 12 h absoluto) la fila se revoca; al volver a la pestaña se comprueba y se vuelve a la entrada **con el motivo** |
| `logout` funciona | `Salir` revoca la sesión en la base, olvida el token y **recuerda el dispositivo** (`C1`), que no hay que volver a crear |
| Una contraseña mala no entra ni deja rastro | No se crea ninguna fila en `sessions`, el campo se limpia y el usuario no existe / la contraseña no cuadra dan **el mismo mensaje** |

**La contraseña sólo está en pantalla, nunca en la base.** Lo que se guarda es el
resultado de Argon2id, y del token de sesión se guarda **su SHA-256**: comprobado en la
base real, el token en claro no aparece por ninguna parte (`count = 0`).

### Lo que no se hace todavía, y se dice

- **El token vive en `localStorage`, que [docs/07 §3](../docs/07-sesiones-y-seguridad.md)
  llama una trampa, y lo es.** Una cookie `httpOnly` la pone un servidor; no hay servidor
  todavía, y el navegador no puede escribir su propia cookie protegida. Es un **apaño con
  fecha de caducidad** (F4, cuando exista `apps/api`), y está marcado así en
  `src/auth/almacen.ts`.
- **Sin servidor no hay «olvidé mi contraseña».** No hay con quién verificarse. La
  pantalla de primer arranque lo avisa. El remedio del diseño son las **passkeys**
  (F6); hasta entonces, perder la contraseña es volver a crear la cuenta. La base no se
  pierde, pero el acceso sí.
- **Nada de rotación de refresh tokens, ni PIN, ni step-up.** Eso es F6. Lo que sí queda
  es lo que protege el mostrador hoy: el bloqueo por inactividad, el tope absoluto de 12 h,
  una espera creciente tras varios intentos fallidos y la comprobación con tiempo constante
  (un hash señuelo cuando el usuario no existe) para no delatar quién está dado de alta.

---

## La app instalable (PWA)

El requisito no es «una web que se pueda abrir», es **la app de la papelería en la
computadora de la papelería, sin depender de internet**. Eso son tres piezas:

| Pieza | Archivo | Qué hace |
|---|---|---|
| Manifiesto | `public/manifest.webmanifest` | nombre, íconos, colores y `display: standalone`, que es lo que permite instalarla |
| Service worker | `sw/plantilla.js` → `dist/sw.js` | guarda **todo** el build y responde sin red |
| Aviso de versión | `src/pwa.ts` | cuando entra una versión nueva, avisa y **no recarga sola** |

El service worker no se escribe a mano en `dist`: es una plantilla que `vite.config.ts`
compila en cada build con la **lista exacta de archivos** (incluidos
`pglite.wasm` y `pglite.data`, ~17 MB) y una versión que cambia cuando cambia algo.
Así la instalación deja la app completa en caché desde la primera visita, en vez de
depender de que la dueña entre dos veces antes de irse sin internet.

### Cómo se comporta

- **Abrir la app**: primero la caché. No espera a la red, porque es una caja.
- **Archivos**: caché primero; si falta, red y se guarda. Cada nombre lleva el hash de
  su contenido, así que un archivo cacheado nunca queda viejo.
- **Sin red**: abre, entra con la sesión guardada y la base local sigue ahí.
- **Versión nueva**: el navegador instala la nueva en segundo plano y aparece abajo
  «Hay una versión nueva de la app · Recargar». **No se recarga sola**: una recarga a
  media venta es una venta perdida.

El `ignoreVary` del service worker no es un descuido: el servidor manda
`Vary: Origin` y los `<script type="module">` van con `Origin`, mientras que la
descarga de la instalación no la lleva. Sin eso, la caché «tiene» el archivo pero la
comparación dice que no y la app se cae a la red justo cuando no hay red. Es seguro
ignorarla porque cada archivo lleva su hash en el nombre.

### Probarlo como lo va a vivir la dueña

El service worker **sólo se registra en producción** (en desarrollo se comería el HMR):

```powershell
pnpm web build
pnpm web preview -- --port 4173
```

1. Abre `http://localhost:4173` y espera unos segundos (la primera vez descarga ~20 MB).
2. Comprueba en DevTools → *Application* → *Service Workers* que está **activated**.
3. **Para el servidor** (`Ctrl+C`) y recarga: la app tiene que abrir igual, con los
   productos y la sesión.
4. Instálala: icono de instalar en la barra de direcciones (Chrome/Edge), menú →
   *Instalar app* (Android) o *Compartir* → *Añadir a pantalla de inicio* (iOS).

Comprobado en Chromium con el servidor apagado: 18 archivos en caché, la app abrió, la
sesión se reanudó y el producto siguió en la lista. Sin errores en consola.

### ⚠️ Dónde viven los datos (esto importa al entregarla)

La base **no viaja con la app**. Vive en el `IndexedDB` de ese navegador, en ese
origen, en esa computadora. Consecuencias, dichas sin adornos:

- Instalarla en el celular **no** comparte los datos del PC: es otra base vacía. La
  sincronización entre dispositivos es F4.
- **Borrar «datos del sitio» borra la papelería entera.** Igual que usar una ventana de
  incógnito o cambiar de navegador/perfil: son orígenes distintos.
- Cambiar de puerto cambia el origen. `localhost:5173` y `localhost:4173` son dos bases
  distintas; por eso el servidor de producción debe quedarse en **un solo origen fijo**.
- **No hay respaldo automático todavía.** Si se muere el disco del PC, se pierde todo.
  Hasta F4 hay que exportar la base a un archivo de vez en cuando; está en la lista de
  pendientes antes de entregar. No es un detalle: es la diferencia entre un susto y
  perder el inventario.

Instalar la app **no** exime de HTTPS: `getUserMedia`, `crypto.subtle` y los service
workers lo exigen igual (docs/04 §2).

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
paga**: `relaxedDurability: true` para todo lo interactivo, y `sincronizar()` —que es
`syncToFs()`— después de una escritura que no se puede perder.

#### ⚠️ Lo que `sincronizar()` **no** hace, y por qué está escrito aquí

Leído en la fuente de PGlite al escribir la tarea 0.7, `syncToFs()` hace esto:

```js
async syncToFs() {
  if (this.#syncing) return;                              // ← si ya hay uno, lo DESCARTA
  this.#syncing = true;
  const volcar = async () => { /* … */ };
  this.#relaxedDurability ? volcar() : await volcar();    // ← en modo relajado NO espera
}
```

Dos consecuencias, y ninguna es lo que este README decía antes:

1. **No espera.** En modo relajado lanza el volcado y vuelve. `await sincronizar()` no
   significa «ya está en disco»: significa «ya se pidió».
2. **Se puede descartar.** Si ya hay un volcado en marcha, la petición nueva se ignora.
   El siguiente volcado la recupera, pero no en el momento.

O sea: `sincronizar()` **reduce** la ventana en la que un `COMMIT` confirmado todavía no
está en IndexedDB, pero **no la cierra**. Lo vimos en un navegador real: sin el volcado,
crear la cuenta y recargar devolvía la pantalla de entrada; con el volcado, deja de pasar.

**Es deuda, y es del sistema entero, no del login.** Le pasa igual a una venta cobrada: el
`COMMIT` puede estar confirmado y no en disco durante esos milisegundos. El remedio es una
línea en `src/db/pglite.worker.ts` (`relaxedDurability: false`), que devuelve `syncToFs()`
a «volcar y esperar» de verdad — a cambio del ritmo de 3/s de la tabla de arriba. Antes de
decidirlo hay que **volver a medir con el POS real**: 3 transacciones por segundo puede
hacer inservible el cobro, y una ventana de milisegundos puede ser irrelevante frente a
que se corte la luz justo ahí. Lo que no se hace es dejarlo apuntado al revés.

---

## El lector de códigos (HID)

Un lector de $25 no necesita driver: se presenta como **teclado** y "teclea" el código a
velocidad de máquina, cerrado con `Enter`. Lo único que lo distingue de una persona es la
velocidad, y de ahí sale toda la heurística (docs/04 §6.1):

- una persona no sostiene **menos de 50 ms por carácter**;
- si un carácter llega más lento, el buffer **se corta** y empieza de cero;
- por eso, cuando el `Enter` cierra con al menos `largoMinimo` caracteres, esos caracteres
  llegaron en ráfaga. No hay que medir la media.

La máquina es pura (`packages/core/src/escaneo/lectorHid.ts`): recibe `(tecla, ahora)` y
no toca el DOM, así que una ráfaga de 13 caracteres se prueba en Node sin esperar 130 ms.
El adaptador (`src/escaneo/hid.ts`) escucha en **captura** —antes que el campo enfocado—,
consume el `Enter` del lector y publica en la cola.

### Cómo probarlo sin lector

Sección **5 · Lector de códigos (HID)** del panel, con dos botones:

| Botón | Qué hace | Qué debe pasar |
|---|---|---|
| Simular un lector (10 ms/carácter) | Dispara las teclas **de verdad**, por el mismo `keydown` que un lector | El código aparece en la tabla y en la consola (`[hid] 7501234567893 · 10 ms/carácter`) |
| Simular una persona (250 ms/carácter) | Lo mismo, más lento | **No** aparece nada: es una persona, y el lector no debe dispararse |

Los dos pasan por el camino real (captura, heurística, `preventDefault` del Enter y cola).
Si la simulación llamara a la cola directamente no probaría nada de eso.

### Dos decisiones que conviene no deshacer

1. **El `Enter` se consume siempre que cierre un código, también dentro de un campo.** Si
   no, el lector enviaría el formulario abierto y "cobraría" una venta sin querer. Es el
   bug clásico del POS y la razón de escuchar en captura.
2. **No hay antirrebote.** Escanear dos veces el mismo producto son **dos piezas**, y un
   antirrebote rompería esa operación. El antirrebote de 800 ms del diseño es para la
   **cámara**, que ve el mismo código en muchos fotogramas; un láser dispara una vez por
   pulsación.
3. **Con el foco en un campo de texto, los caracteres sí llegan al campo**; sólo se consume
   el `Enter`. Es inevitable: hasta el cuarto carácter no se puede saber que es un lector,
   y consumir desde el primero rompería a una persona escribiendo. Con el foco fuera de
   cualquier campo, en cambio, la ráfaga no llega al DOM (evita "búsquedas fantasma"). En
   el POS el buscador **sí** recibe los caracteres, y además la cola entrega el código
   completo: `agregarPorCodigo()` resuelve y limpia el campo. Es la decisión que F2 dejó
   escrita: el campo se usa para teclear, la cola para vender.

---

## Vender y cerrar la caja (F2)

La primera pestaña es **Vender**. El POS se queda montado al cambiar de pestaña: un
carrito a medio armar y el turno abierto no se pierden por mirar el catálogo.

1. **Abrir turno** con el fondo con el que arranca el cajón (no es una venta: es dinero
   que ya estaba ahí).
2. **Escanear** con el lector HID o **buscar** por nombre o código. Escanear dos veces el
   mismo código suma dos piezas. `F2` enfoca el buscador; `F1` cobra; `Escape` vuelve.
3. **Cobrar**: efectivo (con denominaciones y cambio sugerido), tarjeta o transferencia.
   El cambio se calcula con lo recibido; el ticket muestra subtotal, IVA incluido y total.
4. **Cerrar turno**: el sistema calcula el esperado (`fondo + efectivo − cambio −
   retiros − gastos + ingresos + devoluciones`), se teclea lo contado y, si la diferencia
   pasa de $50, la nota es obligatoria. Al cerrar queda el **corte Z** listo para imprimir.

El esperado **nunca** se toma de la pantalla: se vuelve a calcular dentro de la
transacción de cierre. Así, una pestaña vieja o un retiro recién registrado no pueden
hacer que el arqueo diga otra cosa.

Tampoco **bloquea vender sin stock**: el sistema no tiene todavía recepciones de
mercancía (F3), así que el primer producto vendido queda en negativo. No es un error de
la venta: es el ledger diciendo la verdad de que nunca se registró la entrada. En la
pantalla de productos el stock se ve en negativo hasta que F3 exista.

Lo que el POS **todavía no** hace, y se nota: favoritos y venta libre (2.9), devoluciones
y cancelación con interfaz (2.10; la capa de datos ya las tiene), pago mixto en la
pantalla y el PIN de step-up (F6). Sin PIN, las políticas que lo piden —descuento de más
del 10 %, venta de más de $5 000, venta de más de $1 000 después de las 20:00— se
rechazan con un mensaje claro en vez de pedir autorización. Está a propósito: es mejor
que la regla se cumpla de más a que se apague sin que nadie lo note.

---

## Piezas

| Archivo | Qué es |
|---|---|
| `src/main.ts` | Monta la app en el `#app` del HTML y registra el service worker (sólo en producción). |
| `src/app.ts` | El arranque: comprueba las capas, abre la base, **reanuda la sesión** si la hay y deja al usuario dentro o en la entrada. Al volver a la pestaña, revisa que la sesión siga viva. |
| `src/auth/pantalla.ts` | La entrada: primer arranque (crear la cuenta) o login. No hashea ni compara nada; llama a `@papeleria/db` y muestra lo que le contesten. |
| `src/auth/almacen.ts` | El token y el dispositivo en `localStorage`. El comentario de arriba explica por qué es un **apaño temporal** hasta la cookie `httpOnly` de F4. |
| `src/ui.ts` | Los ayudantes de interfaz compartidos (`crear`, `mensaje`, `esperar`, `aviso`, `capasQueFaltan`). |
| `src/escaneo/cola.ts` | **La cola de escaneo**: el único punto por el que entra un código, venga del lector HID o (en F5) del celular. |
| `src/escaneo/hid.ts` | El adaptador del lector HID: escucha en captura, **se come el Enter del lector** para que no envíe el formulario abierto y publica en la cola. La lógica de velocidad vive en `@papeleria/core`. |
| `src/db/pglite.worker.ts` | El obrero que **es dueño** de la base. Sólo lo ejecuta la pestaña líder; ahí corren las migraciones, una sola vez por origen. |
| `src/db/baseLocal.ts` | El cliente tipado. Nadie más toca PGlite: la app usa `consultar`, `ejecutar`, `enTransaccion`, `sincronizar`. |
| `src/db/cliente.ts` | Traduce ese cliente al contrato `query`/`exec`/`transaction` que espera `@papeleria/db`, y expone `enTransaccionDuradera()`: la transacción **más** el volcado, para las escrituras que no se pueden perder (ver *Lo que `sincronizar()` no hace*, más arriba). |
| `src/db/migraciones.ts` | Los `.sql` de `packages/db` incrustados en el bundle por Vite. |
| `src/diagnostico/` | El panel: capas, migraciones, semillas, la prueba de dos pestañas y la de la transacción. Es una herramienta de desarrollo y sólo se llega a ella **con la sesión iniciada**. |
| `src/diagnostico/outbox.ts` | La venta de prueba de la sección 4: la emite, la revienta y borra lo que dejó. |
| `src/productos/` | El catálogo (F1.1): lista con búsqueda, alta y edición. `Formulario.tsx` y `Lista.tsx` son las dos vistas; `App.tsx` es el armazón de pestañas que monta el POS, el catálogo y el diagnóstico. |
| `src/pos/PantallaVenta.tsx` | El POS (F2): turno, buscador/escáner, carrito, cobro, arqueo, movimientos de cajón y corte Z. Se monta oculto al cambiar de pestaña para no perder el carrito. |
| `src/pos/Ticket.tsx` | El ticket de 58 mm y el corte Z, más el CSS de impresión que oculta el resto de la app al llamar a `window.print()`. |
| `src/componentes/ui.tsx` | Los componentes base, al estilo shadcn/ui pero escritos a mano: botón, campo, entrada, selección, tarjeta y aviso. Sin Radix mientras no haya diálogos. |
| `src/pwa.ts` | Registra el service worker y muestra el aviso de versión nueva. |
| `sw/plantilla.js` | El service worker: precarga el build entero y sirve caché primero. `vite.config.ts` le inyecta la lista de archivos y la versión. |
| `public/manifest.webmanifest` + `public/icons/` | Lo que hace instalable a la app y cómo se ve el ícono. |
| `src/estilos.css` | Los estilos que ya existían (entrada y sesión) + Tailwind para las pantallas nuevas. No se importa el `preflight` de Tailwind para no moverle el suelo a la entrada. |

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

Son ~17 MB **la primera vez**. El service worker los precarga durante la instalación y
después se sirven de la caché, sin red. Es el precio de tener un Postgres entero que no
depende de la red.

---

## Requisitos del navegador

La base local necesita **contexto seguro**: `https://` o `localhost`. No es un capricho
configurable — `navigator.locks` (la elección de líder), `crypto.subtle` y
`crypto.randomUUID` sólo existen ahí. El panel comprueba las capas una por una y dice cuál
falta, en lugar de fallar en silencio.

Instalar la app como PWA **no** exime de esto. Es el mismo malentendido que con la cámara.
