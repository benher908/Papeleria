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
| Núcleo: dinero, códigos de barras, precios, totales | ✅ **escrito y con 68 pruebas en verde** |
| Probador de cámara y códigos (`tools/prueba-camara`) | ✅ **listo — falta probarlo en tu celular** |
| Base de datos: esquema y migraciones (`packages/db`) | ✅ **escrito y con 36 pruebas en verde** — el mismo SQL en PGlite y en Postgres 16 |
| API, interfaz web | ⬜ no empezado (el diseño está listo) |

Lo que ya funciona hoy, en `packages/core`: aritmética de dinero en centavos
(`bigint`, sin errores de punto flotante), dígito verificador EAN-13, generación
de códigos internos, motor de precios con IVA y margen, y totales de venta con
desglose de impuestos y sugerencia de cambio.

Y en `packages/db`: el esquema completo (catálogo, ledger de inventario, ventas,
caja, sincronización, auditoría), los roles y permisos del día 1, y las semillas de
unidades, tasas y categorías — con un runner que se niega a aplicar una migración
que ya corrió si alguien la editó después.

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
│   │   ├── src/codigos-barras/ean13.ts
│   │   ├── src/precios/calcularPrecio.ts
│   │   └── src/ventas/totales.ts
│   └── db/                      el esquema: un solo .sql para los dos motores
│       ├── migrations/          0001_init · 0002_rbac_abac · 0003_seed_catalogos
│       └── src/runner.ts        aplica las migraciones y detecta divergencias
│
├── tools/
│   └── prueba-camara/           probador de la tarea 0.9 (se puede borrar cuando ya no haga falta)
│       ├── preparar-certificado.mjs   `pnpm certificado`
│       ├── servidor.mjs               `pnpm camara`
│       └── public/                    la página de diagnóstico
│
├── apps/                        (vacío por ahora: web y api)
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

`packages/db` ya tiene las migraciones `0001`–`0003` y 36 pruebas en verde. El
esquema está descrito en `docs/02` y `docs/06`, y la regla que lo sostiene todo es
una: **el mismo archivo .sql corre en PGlite (el navegador) y en PostgreSQL 16 (el
servidor)**. Si una migración funcionara solo en uno de los dos, hay un test que lo
dice.

Al escribirlas aparecieron **cinco errores en los documentos**: una extensión que ya
no hace falta, `uuidv7()` que no existe en ninguna de las dos versiones, un orden
de tablas que no compila, un índice con un predicado que el motor rechaza, y reglas
de negocio (el catálogo de motivos, las notas obligatorias del ajuste manual)
escritas solo en prosa. Las cinco quedaron corregidas; el detalle está en
`docs/02 §12`.

Lo que sigue, en orden ([`docs/10`](docs/10-roadmap.md), fase F0):

- **0.4 — PGlite en un Web Worker.** Sin esto, dos pestañas abiertas pueden
  corromper la base: es el riesgo que el propio diseño señala.
- **0.5 — `emitirEvento()` + `outbox`.** Que una venta escriba su estado y su
  evento en una sola transacción.
- **0.6 — `evaluar()` (RBAC + ABAC)** con la tabla de tests de políticas de
  `docs/06 §9`.

### 3. La caja (POS) primero, el inventario después

Vender es lo urgente; acomodar el catálogo puede esperar. Empieza por
`docs/05`: buscar producto, escanear, cobrar, imprimir ticket, corte de caja.

### 4. Escaneo con el celular

Ya validado en el paso 1, aquí solo se conecta: el PC abre un WebSocket, el
celular se empareja con un código QR y manda los lecturas. El PC es el **único**
que escribe ventas (`docs/01 §4` y `docs/04`).

### 5. Despliegue

`docs/11-despliegue-gratuito.md` para probar sin pagar; `docs/09` para el
montaje definitivo.

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
