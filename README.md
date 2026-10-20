# Papelería — inventario, códigos de barras y punto de venta

Sistema para **una sola persona**: la que atiende y maneja la papelería.
Funciona sin internet, genera sus propios códigos de barras y los escanea con el
celular. También es el punto de venta.

> Aquí está **cómo arrancar**. El diseño completo (el *por qué* de cada decisión)
> vive en [`docs/`](docs/README.md). Empieza por ahí si vas a modificar algo
> estructural; si solo quieres correrlo, sigue leyendo.

---

## Estado actual

| Parte | Estado |
|---|---|
| Diseño completo (12 documentos) | ✅ terminado — [`docs/`](docs/README.md) |
| Núcleo: dinero, códigos de barras, precios, totales, autorización, contraseñas | ✅ **escrito y con 195 pruebas en verde** |
| Probador de cámara y códigos (`tools/prueba-camara`) | ✅ **listo — falta probarlo en tu celular** |
| Base de datos: esquema y migraciones (`packages/db`) | ✅ **escrito y con 173 pruebas en verde** — las mismas contra PGlite y contra PostgreSQL 16, con el mismo esquema línea por línea |
| Motor de ventas: `emitirEvento()` + `outbox` | ✅ **estado, evento y auditoría en una sola transacción** — ni una venta a medias, ni un folio gastado |
| Autorización: `evaluar()` + las 30 reglas sembradas | ✅ **la tabla de casos del doc 06 §9 en verde, contra las reglas reales** |
| Base local en el navegador (`apps/web`) | ✅ **funcionando** — PGlite en un Web Worker, verificado con **dos pestañas abiertas** |
| Entrada: crear la cuenta y entrar (`0.7`) | ✅ **funcionando sin servidor** — la sesión persiste al recargar, el `logout` funciona, y verificado en un navegador real |
| Lector de códigos de barras HID (`0.8`) | ✅ **funcionando** — un lector de $25 se presenta como teclado; el panel lo simula y distingue a una persona de una máquina |
| App instalable y sin internet (`0.10`) | ✅ **PWA**: se instala como app y abre con el servidor apagado — verificado en un navegador real |
| Catálogo de productos (`1.1`) | 🟨 **en curso** — alta, listado con búsqueda y edición funcionan de punta a punta; faltan categorías, unidades y proveedores |
| POS y caja (`F2`) | 🟨 **en curso y usable** — abrir turno, vender con escáner o búsqueda, cambio sugerido, ticket de 58 mm, movimientos de cajón, arqueo y corte Z. Faltan favoritos, venta libre, devoluciones con interfaz y step-up con PIN |
| Etiquetas, API y respaldos | ⬜ no empezado (el diseño está listo; el respaldo es F4) |

Lo que ya funciona hoy, en `packages/core`: aritmética de dinero en centavos
(`bigint`, sin errores de punto flotante), dígito verificador EAN-13, generación
de códigos internos, motor de precios con IVA y margen, y totales de venta con
desglose de impuestos y sugerencia de cambio.

Y en `packages/db`: el esquema completo (catálogo, ledger de inventario, ventas,
caja, sincronización, auditoría), los roles y permisos del día 1, las semillas de
unidades, tasas y categorías — con un runner que se niega a aplicar una migración
que ya corrió si alguien la editó después — y **`emitirEvento()`**, el único camino
por el que se puede cambiar el negocio.

La propiedad que sostiene todo lo demás: **una venta escribe su estado, su evento y su
auditoría en una sola transacción**. O entra todo, o no entra nada. Si se corta la luz a
mitad de una venta, no queda una venta guardada que nunca llegue al servidor, ni un
número de ticket quemado que deje la sincronización atascada. Está verificado forzando
el fallo a propósito, y el panel lo deja ver: pulsa *Vender y fallar a mitad* y compara
la cuenta antes y después.

Y en `apps/web`: **la base local ya vive en el navegador y tiene entrada**. Un Postgres
entero (WASM) dentro de un Web Worker, con una sola instancia por navegador elegida entre
pestañas, aplicando las mismas migraciones que el servidor. La primera vez la app pide
**crear la cuenta de la dueña** —no hay servidor del que traerla— y después se entra con
contraseña: al recargar no la vuelve a pedir mientras la sesión siga viva, y deja de valer
cuando toca (30 min sin usarla, 12 h en total). Todo eso sin internet y sin que la
contraseña salga del equipo. `pnpm web dev` y ábrela en dos pestañas: el panel —al que sólo
se llega con la sesión iniciada— te dice cuál es la dueña de la base, comprueba que dos
pestañas escribiendo a la vez no pierden ni una fila, y te deja vender una venta de prueba
y romperla a mitad para ver que no queda nada a medias.

---

## Requisitos

- **Node 22+** — ya lo tienes (v22.13.1)
- **pnpm** — ya instalado (v12)
- Git — ya instalado

```powershell
node --version    # v22 o superior
pnpm --version
```

---

## Comandos

```powershell
pnpm install              # instalar dependencias (una vez, y cuando cambie package.json)

pnpm test                 # correr TODAS las pruebas del repositorio
pnpm typecheck            # verificar tipos en todo el repositorio

pnpm core test            # solo el núcleo
pnpm core test:watch      # modo reloj: re-corre al guardar (úsalo mientras programas)
pnpm core typecheck       # tipos solo del núcleo

pnpm db test              # solo la base de datos: migraciones, esquema y semillas
pnpm db test:watch        # modo reloj para las migraciones
pnpm db typecheck         # tipos solo de la base de datos

pnpm web dev              # levanta la app en http://localhost:5173 (ábrela en 2 pestañas)
pnpm web test             # pruebas de la app: que el bundle vea las mismas migraciones
pnpm web build            # build de producción (genera apps/web/dist, con su service worker)
pnpm web preview          # sirve ese build en http://localhost:4173 — así se prueba el modo sin red
pnpm web typecheck        # tipos solo de la app

pnpm certificado          # ⚠️ PRIMERO: crea el certificado para probar la cámara del celular
pnpm camara               # levanta el probador y te dice qué abrir en el celular
```

Ejecuta `pnpm test` y `pnpm typecheck` **antes de cada commit**. Si están en
verde, no rompiste nada.

---

## Estructura

```text
Papeleria/
├── docs/                        el diseño: léelo antes de tocar la arquitectura
│   ├── README.md                índice + las 6 decisiones clave
│   ├── 01-arquitectura.md       por qué PGlite + PostgreSQL, y qué NO hacer
│   ├── 02-modelo-de-datos.md    el esquema SQL completo
│   ├── 03-codigos-de-barras.md  EAN-13, prefijo interno 2, etiquetas
│   ├── 04-escaneo-movil.md      emparejar el celular y el detalle de HTTPS
│   ├── 05-pos-y-caja.md         flujo de venta, arqueo, ticket
│   ├── 06-authz-rbac-abac.md    permisos y políticas
│   ├── 07-sesiones-y-seguridad.md
│   ├── 08-sincronizacion-offline.md
│   ├── 09-despliegue-y-costos.md
│   ├── 10-roadmap.md            las fases, en orden
│   ├── 11-despliegue-gratuito.md  probar todo sin pagar nada
│   └── 12-precios-y-margenes.md   markup vs margen, IVA, recálculos
│
├── packages/
│   ├── core/                    ⭐ el núcleo: sin dependencias de plataforma
│   │   ├── src/dinero.ts        centavos, redondeo, IVA, formato, parseo
│   │   ├── src/auth/            reglas de contraseña y tiempos de sesión (puras)
│   │   ├── src/escaneo/         el lector HID: la máquina que distingue a una persona
│   │   ├── src/codigos-barras/ean13.ts
│   │   ├── src/precios/calcularPrecio.ts
│   │   └── src/ventas/totales.ts
│   └── db/                      el esquema: un solo .sql para los dos motores
│       ├── migrations/          0001_init · 0002_rbac_abac · 0003_seed_catalogos
│       │                        0004_eventos · 0005_politicas · 0006_secuencias
│       └── src/                 runner · eventos · autorizacion · auth · secuencias
│
├── tools/
│   └── prueba-camara/           probador de la tarea 0.9 (se puede borrar cuando ya no haga falta)
│       ├── preparar-certificado.mjs   `pnpm certificado`
│       ├── servidor.mjs               `pnpm camara`
│       └── public/                    la página de diagnóstico
│
├── apps/
│   └── web/                     la app del navegador
│       ├── src/app.ts                arranque: capas, base, sesión reanudada o entrada
│       ├── src/auth/                 la entrada: crear la cuenta o entrar, y dónde se guarda el token
│       ├── src/escaneo/              la cola de escaneo y el adaptador del lector HID
│       ├── src/db/pglite.worker.ts   el Web Worker dueño de la base
│       ├── src/db/baseLocal.ts       el cliente tipado (consultar, ejecutar, transacción)
│       ├── src/db/migraciones.ts     los .sql de packages/db, incrustados por Vite
│       └── src/diagnostico/          el panel: capas, migraciones, semillas, 2 pestañas
│
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

**La regla de oro:** `packages/core` no sabe que existe un navegador ni un
servidor. Corre idéntico en la caja, en el celular y en el VPS. Es lo que permite
que el precio, el IVA y los permisos se calculen igual en los tres lados, con o
sin internet.

---

## Cómo seguir, en este orden

El orden importa: primero lo que puede invalidar el proyecto, luego lo demás.

### 1. ⚠️ Valida la cámara del celular sobre HTTPS (medio día)

Es **el único riesgo que puede tirar el requisito principal**. `getUserMedia`
exige HTTPS; instalar la app como PWA **no** lo evita (es el mito más común).
Hay un probador ya hecho para esto:

```powershell
pnpm certificado    # una vez: crea la autoridad certificadora y el certificado
                    # con la IP actual de tu red. Pide permiso de administrador.
pnpm camara         # levanta el probador y te dice la dirección exacta
                    # que debes abrir en el celular
```

Después, **en el celular**, en este orden: abre la dirección `http://…:8080` que
imprime el comando (si esto no abre, el problema es la red o el firewall, **no** el
certificado), descarga e instala el certificado, y pasa a `https://…:8443`. Ahí
verás el diagnóstico completo y podrás leer códigos de verdad con la cámara.

El probador **separa las cuatro capas** que se confunden en una sola queja
(«no lee»): red → certificado → permiso → decodificador. Cuando algo falla, te dice
cuál. Detalle en [`tools/prueba-camara/README.md`](tools/prueba-camara/README.md).

Si eso funciona, el riesgo desaparece y se puede construir. Receta manual (sin la
herramienta) en [`docs/11 §1`](docs/11-despliegue-gratuito.md) y
[`docs/04`](docs/04-escaneo-movil.md).

### 2. Base de datos: esquema y migraciones — ✅ hecho

`packages/db` ya tiene las migraciones `0001`–`0008` y 173 pruebas en verde. El
esquema está descrito en `docs/02` y `docs/06`, y la regla que lo sostiene todo es
una: **el mismo archivo .sql corre en PGlite (el navegador) y en PostgreSQL 16 (el
servidor)**. No es una aspiración: hay una prueba que aplica las migraciones a los
dos motores y compara los catálogos línea a línea. Corre contra un PostgreSQL 16.14
real y los esquemas salen idénticos.

Para repetirla hace falta un Postgres desechable (destruye su esquema `public`):

```powershell
docker run --rm -d --name papeleria-pruebas-pg -p 55432:5432 `
  -e POSTGRES_PASSWORD=pruebas -e POSTGRES_DB=papeleria_pruebas postgres:16-alpine

$env:DATABASE_URL_PRUEBAS = 'postgres://postgres:pruebas@localhost:55432/papeleria_pruebas'
pnpm db test
docker stop papeleria-pruebas-pg     # al terminar (con --rm, se borra solo)
```

Al escribirlas aparecieron **cinco errores en los documentos**: una extensión que ya
no hace falta, `uuidv7()` que no existe en ninguna de las dos versiones, un orden
de tablas que no compila, un índice con un predicado que el motor rechaza, y reglas
de negocio (el catálogo de motivos, las notas obligatorias del ajuste manual)
escritas solo en prosa. Las cinco quedaron corregidas; el detalle está en
`docs/02 §12`.

Lo que sigue, en orden ([`docs/10`](docs/10-roadmap.md), fase F0):

- **0.4 — PGlite en un Web Worker.** ✅ **Hecho**: la base local vive en el navegador,
  una sola instancia elegida entre pestañas, y está verificado con dos pestañas abiertas
  escribiendo a la vez. El detalle está en [`apps/web/README.md`](apps/web/README.md).
- **0.5 — `emitirEvento()` + `outbox`.** ✅ **Hecho**: una venta escribe su estado, su
  evento y su auditoría en una sola transacción. Forzando un fallo después de escribir el
  estado, la base queda idéntica, contadores incluidos. Verificado en PGlite, contra un
  PostgreSQL 16.14 real y a mano en el navegador (sección 4 del panel).
- **0.6 — `evaluar()` (RBAC + ABAC).** ✅ **Hecho**: `evaluar()` decide sin IO (el mismo
  código en la caja, el celular y el servidor) y `packages/db/src/autorizacion.ts` carga
  los permisos, las políticas y el step-up dentro de la transacción del evento. Las 30
  reglas del `docs/06 §5` están sembradas como datos en `0005_politicas.sql`, y la tabla
  de casos del `docs/06 §9` corre **contra esas reglas y contra el reparto real de
  permisos**. De paso: el lado derecho de una comparación puede ser otro campo (sin eso
  la regla P1 no se puede escribir), y un contexto incompleto **lanza** en vez de dejar
  una regla apagada en silencio.
- **0.7 — Login mínimo.** ✅ **Hecho y verificado en un navegador real.** El primer
  arranque crea la cuenta de la dueña (no hay servidor del que traerla) y a partir de ahí
  se entra con contraseña. Recargar **no** vuelve a pedirla mientras la sesión siga viva;
  vencer (30 min inactivo / 12 h) devuelve a la entrada con el motivo; `Salir` revoca la
  sesión y recuerda el dispositivo. En la base sólo queda el Argon2id y el SHA-256 del
  token. **La cookie `httpOnly` no se hizo a propósito**: la pone un servidor y todavía no
  hay servidor, así que el token vive en `localStorage` como apaño temporal y marcado como
  tal; `apps/api` (F4) lo sustituye. Sin servidor tampoco hay «olvidé mi contraseña» —lo
  resuelven las passkeys de F6, y la pantalla lo avisa. Ver [`docs/07 §2.4`](docs/07-sesiones-y-seguridad.md).
- **0.8 — Lector HID.** ✅ **Hecho y verificado en un navegador real.** Un lector de
  códigos de $25 se conecta por USB o Bluetooth y el sistema operativo lo ve como un
  **teclado**: no hay driver que instalar. Lo único que lo distingue de una persona es que
  teclea a menos de 50 ms por carácter y cierra con Enter; esa máquina está en `core`,
  pura y probada con tiempos inyectados. El adaptador escucha en captura, **se come el
  Enter del lector** —para que no envíe el formulario abierto— y publica en la **cola de
  escaneo**, el mismo punto por el que entrará el celular. Se prueba sin lector en la
  sección 5 del panel: simula un escaneo rápido y uno humano lento, y el lento no dispara.
- **0.10 — App instalable y sin internet (PWA).** ✅ **Hecho y verificado en un navegador
  real.** El service worker se genera en cada build con la lista exacta de archivos del
  bundle y precarga **todo**, incluidos los 17 MB del motor de base de datos. Con el
  servidor apagado la app abrió, reanudó la sesión y los productos siguieron en la lista.
  Instalarla **no** exime de HTTPS, y los datos viven en el navegador y el origen de ese
  PC: borrar «datos del sitio» borra la papelería. El respaldo automático es F4 y es el
  pendiente que más importa antes de entregarla. Ver
  [`docs/11 §2`](docs/11-despliegue-gratuito.md) y [`apps/web/README.md`](apps/web/README.md).
- **1.1 — Catálogo de productos.** 🟨 **En curso y usable**: dar de alta, buscar y editar
  funciona de punta a punta en un navegador real, con la autorización **dentro** de la
  transacción (un precio por debajo del costo se rechaza con la política P1). Faltan los
  CRUD de categorías, unidades y proveedores. La pantalla destapó un fallo que las
  pruebas no veían: al editar cualquier otra cosa, el «stock mínimo» se iba a 0, porque
  la lista no traía ese dato y el formulario arrancaba en cero. Corregido y con prueba.
- **F2 — POS y caja.** 🟨 **En curso y usable**, verificado en un navegador real:
  abrir turno con fondo, escanear o buscar, juntar cantidades, cobrar en efectivo con
  cambio sugerido, imprimir el ticket de 58 mm con folio y IVA incluido, registrar un
  retiro, arquear y cerrar con el corte Z. La venta escribe venta, líneas, pagos,
  movimiento de stock, evento y auditoría en **una sola transacción**, y el esperado del
  cajón se calcula con `monto − cambio` **dentro** del cierre, nunca con lo que diga la
  pantalla. El ledger dejó el stock en negativo en la primera venta de prueba: eso es
  correcto —no había recepción de mercancía— y es la deuda visible que resuelve F3.
  Faltan favoritos y venta libre (2.9), devoluciones con interfaz (2.10), el resto de
  atajos (2.7) y el PIN de step-up (F6): hoy una venta de más de $1 000 después de las
  20:00 o un descuento de más del 10 % se rechazan con un mensaje claro en vez de pedir
  autorización. Ver [`docs/05`](docs/05-pos-y-caja.md) y [`README` de la web](apps/web/README.md).

Quedan la prueba de cámara (0.9), que necesita tu celular, y los pendientes de F2
anotados arriba.

### 3. La caja (POS) primero, el inventario después

Vender es lo urgente; acomodar el catálogo puede esperar. Empieza por
`docs/05`: buscar producto, escanear, cobrar, imprimir ticket, corte de caja.

### 4. Escaneo con el celular

Ya validado en el paso 1, aquí solo se conecta: el PC abre un WebSocket, el
celular se empareja con un código QR y manda los lecturas. El PC es el **único**
que escribe ventas (`docs/01 §4` y `docs/04`).

### 5. Despliegue

`docs/11-despliegue-gratuito.md` para probar sin pagar; `docs/09` para el
montaje definitivo. La app se entrega **compilada** (`pnpm web build`) a un
origen HTTPS fijo y se instala como PWA en el PC de la tienda: ahí nace su base
de datos. La del PC donde se programa no viaja con la app.

---

## Tres cosas que te van a morder si las olvidas

1. **`getUserMedia` necesita HTTPS.** Certificado válido, no una excepción del
   navegador. Instalar la PWA no cambia eso.
2. **El arqueo de caja es `monto − cambio`, nunca `monto + cambio`.** Está
   escrito en `docs/05`, y aun así se equivoca.
3. **"40 % de ganancia" son dos números distintos.** $140 o $166.67 netos sobre
   un costo de $100. Por eso `baseMargen` es obligatorio y no tiene valor por
   defecto. Ver [`docs/12`](docs/12-precios-y-margenes.md).

---

## Licencia

Uso privado.
