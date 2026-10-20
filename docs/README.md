# Sistema de Inventario + Punto de Venta para Papelería

Documentación de diseño. Un solo desarrollador, un solo usuario (el dueño), crece después sin rehacer nada.

> **Estado:** el diseño está completo. Además del núcleo, ya están escritos el esquema y
> las migraciones ([`packages/db`](../packages/db)), la base local en el navegador, su
> entrada y el lector HID ([`apps/web`](../apps/web)). `pnpm test` corre **317 pruebas**
> sobre dinero, códigos de barras, precios, totales, migraciones, la transacción que ata
> cada cambio a su evento, las políticas de autorización, el login local y el lector de
> códigos.
> **Cómo arrancar:** [`README.md`](../README.md) de la raíz.

---

## 1. Resumen ejecutivo

Lo que pides son en realidad **cuatro problemas distintos** que se suelen confundir en uno:

| # | Problema | Documento |
|---|----------|-----------|
| 1 | Inventario que cuadre (entradas, salidas, mermas, conteos) | [02](02-modelo-de-datos.md) |
| 2 | Vender rápido y cobrar bien (caja, tickets, arqueo) | [01](01-arquitectura.md) · [05](05-pos-y-caja.md) |
| 3 | Generar tus **propios** códigos de barras para lo que no trae código | [03](03-codigos-de-barras.md) |
| 4 | Escanear con el celular dentro de la misma app | [04](04-escaneo-movil.md) |

Más lo que nadie pide al inicio y siempre hace falta después: permisos ([06](06-authz-rbac-abac.md)), sesiones y seguridad ([07](07-sesiones-y-seguridad.md)), funcionar sin internet ([08](08-sincronizacion-offline.md)), despliegue y costos ([09](09-despliegue-y-costos.md)), y un plan de trabajo realista ([10](10-roadmap.md)).

### Las 6 decisiones que definen todo lo demás

1. **Local-first (offline obligatorio).** La base de datos vive *también* en cada dispositivo. El internet es una conveniencia, no un requisito. Una papelería cierra ventas a las 8 pm con el router caído. Ya lo confirmaste como indispensable y es la decisión correcta.
2. **La PC de la caja es el escritor único de ventas.** El celular es un **escáner tonto**, no un segundo punto de venta. Esto elimina ~90 % de los conflictos de sincronización y no te cuesta nada en funcionalidad. Detalle en [04](04-escaneo-movil.md).
3. **Eventos, no estados.** El stock no es un número que se edita: es el resultado de sumar movimientos inmutables. Un número que se edita no se puede auditar, no se puede sincronizar sin conflictos y no te dice por qué bajó. Detalle en [02](02-modelo-de-datos.md#4-ledger-de-movimientos-por-qué-no-se-edita-el-stock).
4. **Nada de `float` para dinero.** Enteros en centavos. Siempre.
5. **El cliente no decide permisos, solo los muestra.** RBAC + ABAC se evalúan en el servidor *y* en local (porque hay que vender offline), pero la UI solo oculta botones; nunca es la fuente de verdad. Detalle en [06](06-authz-rbac-abac.md).
6. **"Ganarle 40 %" son dos números distintos.** 40 % *sobre el costo* da $140 con un costo de $100; 40 % *de margen* da $166.67. Es una diferencia del 19 % en el precio y del 67 % en la ganancia. El sistema lo hace explícito y muestra siempre las dos cifras. Detalle en [12](12-precios-y-margenes.md).

### Stack recomendado

Un solo lenguaje (TypeScript) para todo: web de caja, app del celular, generación de códigos, impresión y API.

| Capa | Elección | Por qué |
|------|----------|---------|
| App (caja + celular) | **React 19 + Vite + TypeScript** | Un solo código. La caja es una ruta, el escáner es otra ruta de la misma app. |
| Instalación en celular | **PWA** (manifest + service worker) | Se instala desde el navegador, sin Play Store, sin APK, sin compilar. |
| UI | **Tailwind + shadcn/ui** | Botones grandes táctiles sin escribir CSS a mano. |
| Estado servidor | **TanStack Query** | Reintentos, caché y `offlineFirst` ya resueltos. |
| Base de datos local | **PGlite** (Postgres real compilado a WASM, persistido en IndexedDB) | *El mismo motor y el mismo SQL* que el servidor. Un esquema, una migración, cero traducción mental. |
| Base de datos servidor | **PostgreSQL 16+** | Copia de seguridad, reportes, consultas remotas. |
| API | **Node + Fastify + TypeScript** (tRPC opcional) | Tipado compartido con el front. |
| Tiempo real (escáner) | **WebSocket (`ws`)** | Bidireccional, ~40 líneas de código. |
| Códigos de barras | **bwip-js** | EAN-13, Code 128, QR. Genera en canvas, funciona offline. |
| Impresión de etiquetas | **PDF (`pdf-lib`) o CSS `@media print`** | Etiquetas en hoja A4 o en térmica. Sin drivers. |
| Autorización | **Motor propio de políticas** (puro y sin IO: gramática de condiciones, catálogo cerrado de campos, evaluador con deny-overrides) con roles/permisos/políticas en tablas; **Casbin** es alternativa válida | Un usuario hoy, N empleados mañana, sin reescribir. Detalle en [06](06-authz-rbac-abac.md) |
| Servidor | **VPS pequeño + Caddy** (HTTPS automático) o el **propio PC** en la red local | Detalle de costo/beneficio en [09](09-despliegue-y-costos.md). |

**Por qué web/PWA y no app nativa (Expo/React Native):**

- El escáner, el catálogo, el POS y el panel de administración son **el mismo producto**. Con PWA escribes una vez; con nativo escribes una app *y* una web.
- `getUserMedia` (la cámara) y acceso a barcodes vía `BarcodeDetector` (con ponyfill `zxing-wasm`) funcionan perfecto en el navegador moderno de Android y iOS. Ya no hay ventaja real del nativo para *leer* códigos.
- Publicar una PWA es hacer `git push`. Publicar en Play Store es firmar, revisar, esperar y pagar $25 + cuenta.
- **El único caso que justifica nativo** es si necesitas Bluetooth clásico SPP hacia una impresora térmica o lector. Si llegas a necesitarlo, la salida es un *wrapper* nativo mínimo, no reescribir todo.

---

## 2. Documentos

| Documento | Contenido |
|-----------|-----------|
| [01 — Arquitectura](01-arquitectura.md) | Vista general, por qué local-first, capas, componentes, estructura de carpetas, superficie de API |
| [02 — Modelo de datos](02-modelo-de-datos.md) | Esquema SQL completo, dinero en centavos, ledger de movimientos, presentaciones/unidades |
| [03 — Códigos de barras](03-codigos-de-barras.md) | EAN-13 prefijo 2 vs Code 128 vs QR, cómo generar, cómo imprimir, etiquetas de anaquel |
| [04 — Escaneo móvil](04-escaneo-movil.md) | Emparejamiento por QR, WebSocket, el *gotcha* de HTTPS y la cámara, fallback USB/Bluetooth |
| [05 — POS y caja](05-pos-y-caja.md) | Flujo de venta, cobro, tickets, arqueo de caja, devoluciones |
| [06 — RBAC y ABAC](06-authz-rbac-abac.md) | Permisos, roles, políticas por atributos, step-up auth, por qué un usuario igual las necesita |
| [07 — Sesiones y seguridad](07-sesiones-y-seguridad.md) | Modelo de sesión, dispositivos, tokens, passkeys, modelo de amenaza, respaldos, qué NO hacer |
| [08 — Sincronización offline](08-sincronizacion-offline.md) | Outbox, push/pull, idempotencia, resolución de conflictos, reloj lógico |
| [09 — Despliegue y costos](09-despliegue-y-costos.md) | Topologías (PC solo / VPS / híbrido), Docker, HTTPS en LAN, impresoras, costos reales, comprar vs construir |
| [10 — Roadmap](10-roadmap.md) | Fases con criterios de "terminado", qué NO construir todavía, errores caros de evitar |
| [11 — Despliegue gratuito](11-despliegue-gratuito.md) | Probar **todo** el sistema con $0: mkcert, Cloudflare Tunnel, VPS gratis, respaldos gratis |
| [12 — Precios y márgenes](12-precios-y-margenes.md) | Markup vs margen, IVA, motor de precios, márgenes por categoría, recálculo masivo |

---

## 3. Las 3 verdades incómodas de este proyecto

Las pongo al inicio porque son lo que más tiempo y dinero ahorran.

### 3.1 Un lector de códigos Bluetooth de $25 USD es mejor que el celular

Esto es incómodo porque ya decidiste querer el celular. Pero un lector láser Bluetooth que se presenta como **teclado (HID)**:

- No requiere **ningún** código: el sistema operativo lo ve como un teclado, el código "se teclea" solo en el buscador de tu POS.
- Es manos libres (lo dejas apoyado y pasas el producto), escanea en ~200 ms e **infalible**.
- No depende de batería del celular, ni de wifi, ni de HTTPS, ni de desbloquear una pantalla.
- Funciona incluso si tu app está en mantenimiento.

**Recomendación:** diseña la entrada de escaneo como una **cola unificada** (`scanSource: 'hid' | 'phone' | 'manual' | 'search'`). Con eso, un lector HID funciona *el primer día* sin escribir código de integración, y la app del celular es el complemento que ya querías. Detalles en [04](04-escaneo-movil.md#6-entrada-unificada-de-escaneo).

### 3.2 En una papelería no etiquetas el producto, etiquetas el anaquel

Un lápiz de $6 MXN no lleva etiqueta. El **cajón o el exhibidor** sí. Escaneas la etiqueta del anaquel (`PRODUCTO: Lápiz Mirado #2 / ANAQUEL: A-3-12`), eliges cantidad y vendes. Lo mismo con hojas, sobres, clips.

Consecuencias de diseño:

- Necesitas **dos tipos de código**: el del producto (cuando trae código de fábrica) y el **local/organizacional** (sku de anaquel, ubicación, caja de empaque).
- Debe existir **"venta libre"**: productos sin stock controlado (fotocopias, engargolados, impresiones, tiempo de cómputo). Se modelan como producto con `tracks_stock = false`. Detalle en [02](02-modelo-de-datos.md#8-servicios-sin-stock-fotocopias-engargolados).
- La búsqueda por nombre, categoría y "favoritos" importa más que el código en sí. Muchas ventas se harán **tecleando**, no escaneando.

### 3.3 "Comprar" es una opción legítima que debes evaluar antes de construir

Antes de escribir la primera línea, compara costos realistas:

| Opción | Costo | Se adapta a ti si… |
|--------|-------|--------------------|
| **Excel/Google Sheets** (lo que probablemente haces hoy) | $0 | Tienes <300 SKU y no necesitas auditoría ni multi-dispositivo. Honestamente: quizá te alcance por un tiempo más. |
| **Odoo Community** (POS + Inventario + Códigos) | $0 software, ~$6–12 USD/mes VPS | Valoras no mantener código. *Pero* generar códigos internos propios y escanear con el celular son incómodos (módulos custom en Python). |
| **Sistema comercial de papelerías local** | $100–400 USD/mes, a veces perpetuo | No tienes tiempo y quieres soporte telefónico. Pregunta si permite código interno propio y multi-dispositivo offline. |
| **A la medida (este documento)** | ~$6 USD/mes + tu tiempo | Quieres tus propias reglas: códigos propios, celular como escáner, control de mermas, escalabilidad a empleados. |

Si eliges construir, el resto de esta documentación es el plano. Si eliges comprar, los documentos [02](02-modelo-de-datos.md) y [03](03-codigos-de-barras.md) igual te sirven como **checklist de preguntas** para no comprar algo que no hace lo que necesitas.

---

## 4. Cómo leer esto si tienes prisa

1. Lee esta página completa (5 min).
2. Lee [01 — Arquitectura](01-arquitectura.md) para entender la forma general.
3. Lee [04 — Escaneo móvil](04-escaneo-movil.md) y [03 — Códigos de barras](03-codigos-de-barras.md): es lo que pediste explícitamente y lo más novedoso de tu caso.
4. [06 — RBAC/ABAC](06-authz-rbac-abac.md) y [07 — Sesiones](07-sesiones-y-seguridad.md) explican por qué, siendo un solo usuario, **igual** conviene la estructura.
5. [10 — Roadmap](10-roadmap.md) para saber por dónde empezar mañana.
