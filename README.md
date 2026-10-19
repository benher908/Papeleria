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
| Base de datos, API, interfaz web | ⬜ no empezado (el diseño está listo) |
| Validar la cámara del celular sobre HTTPS | ⬜ **el riesgo #1, hazlo primero** |

Lo que ya funciona hoy, en `packages/core`: aritmética de dinero en centavos
(`bigint`, sin errores de punto flotante), dígito verificador EAN-13, generación
de códigos internos, motor de precios con IVA y margen, y totales de venta con
desglose de impuestos y sugerencia de cambio.

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
│   └── core/                    ⭐ el núcleo: sin dependencias de plataforma
│       ├── src/dinero.ts        centavos, redondeo, IVA, formato, parseo
│       ├── src/codigos-barras/ean13.ts
│       ├── src/precios/calcularPrecio.ts
│       └── src/ventas/totales.ts
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
Antes de escribir la interfaz, confirma que el navegador del celular lee un
código de barras sobre tu red local con certificado válido. Receta en
[`docs/11 §1`](docs/11-despliegue-gratuito.md) (mkcert) y
[`docs/04`](docs/04-escaneo-movil.md).

```powershell
# resumen de lo que vas a probar
#  1. mkcert -install  y generar el certificado para la IP de tu PC
#  2. servir una página de prueba con HTTPS (Caddy o vite --https)
#  3. abrirla desde el celular e instalar el certificado raíz
#  4. leer un código de barras con la cámara
```

### 2. Base de datos: esquema y migraciones

`docs/02-modelo-de-datos.md` tiene el SQL. Se crea como migraciones numeradas
(`0001_esquema.sql` … `0006_precios.sql`) y corre **igual** en PGlite (en el
navegador) y en PostgreSQL 16 (en el servidor). Si una migración solo funciona en
uno de los dos, está mal.

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
