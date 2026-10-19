# 12 — Precios y márgenes ("quiero ganarle 30 o 40 %")

Pides que el precio de venta ya traiga la ganancia: pones el costo, y el sistema te dice a cuánto vender con tu 30 o 40 %. Es exactamente lo que hay que automatizar. Pero antes, **la trampa** — es la parte más valiosa de este documento.

## 1. "Ganarle 40 %" son dos números distintos (diferencia del 19 %)

La frase es ambigua y la diferencia cuesta dinero real:

```text
Costo: $100 (sin IVA)

┌─ Interpretación A: 40 % SOBRE EL COSTO (markup) ──────────────────┐
│  precio = costo × 1.40 = $140                                     │
│  ganancia = $40                                                   │
│  pero el margen sobre lo que VENDISTE es 40/140 = 28.6 %          │
└───────────────────────────────────────────────────────────────────┘

┌─ Interpretación B: 40 % DE MARGEN SOBRE LA VENTA ─────────────────┐
│  precio = costo / (1 − 0.40) = 100 / 0.60 = $166.67               │
│  ganancia = $66.67                                                │
│  margen sobre la venta = 66.67/166.67 = 40 %   ✔                 │
└───────────────────────────────────────────────────────────────────┘

Diferencia de precio: $140 vs $166.67  → 19 % más caro.
Diferencia de ganancia por pieza: $40 vs $66.67  → 67 % más.
```

Ambas son correctas; son **definiciones distintas**. El problema es no saber cuál estás usando: si esperas B y aplicas A, pierdes 12 puntos de margen en cada venta, en cada producto, todos los días.

**Qué usa cada quien en la práctica:**

| Formulación | Significado coloquial | Fórmula |
|-------------|----------------------|---------|
| "Le gano 40 %" | Casi siempre **A** (sobre el costo) | `costo × 1.40` |
| "Mi margen es 40 %" | Casi siempre **B** (sobre la venta) | `costo / 0.60` |
| El proveedor dice "40 % de descuento" | Ni A ni B: es sobre el precio de lista *de ellos* | — |

**Mi recomendación para tu caso:** configura **40 % sobre el costo (markup)** como valor por defecto, porque es lo que querrás decir cuando teclees el costo, **pero el sistema debe mostrarte siempre las dos columnas** ("ganancia $40 · margen 28.6 %"). Así dejas de pensar en porcentajes y decides con pesos, que es como se decide de verdad en el mostrador.

## 2. El IVA en medio (y por qué el costo que importa es el neto)

En tu papelería **el precio de lista ya incluye IVA** ([02 §2](02-modelo-de-datos.md#2-dinero-la-regla-más-bugs-evita)): el cliente paga $6.00 por el lápiz y no hay sorpresas. Y el proveedor te factura con IVA, pero **ese IVA es acreditable: no es un costo tuyo**. Entonces:

```text
Costo de factura (con IVA):     $116.00
Costo NETO (acreditable):       $100.00   ← ESTE es el que define tu ganancia
Margen deseado (markup):         40 %
Precio NETO de venta:           $140.00
Precio de LISTA (con IVA 16 %): $162.40   ← ESTE es el que ve el cliente

El cliente paga:                $162.40
   de los cuales IVA trasladado: $22.40  → no es tuyo, se entera al SAT
   ingreso neto:                 $140.00
   menos costo neto:            −$100.00
   ─────────────────────────────
   GANANCIA REAL:                $ 40.00   ✔  28.6 % de margen
```

**Reglas para no equivocarte nunca:**

1. **El costo se guarda NETO (sin IVA).** Si capturas la factura con IVA incluido, el sistema divide: `neto = total / 1.16`.
2. **El precio se guarda con IVA incluido** (es lo que paga el cliente y lo que va en la etiqueta).
3. **Nunca sumes el IVA a la ganancia.** El día que lo hagas, vas a creer que ganas 45 % cuando ganas 40 %, y el SAT te va a cobrar la diferencia.
4. Si un producto es **tasa 0 % o exento** (algunos medicamentos, alimentos, servicios educativos), el IVA desaparece de la fórmula. Por eso `tax_rate_id` existe por producto ([02](02-modelo-de-datos.md#3-esquema--núcleo)).

## 3. El motor de precios

### 3.1 Migración `0006_precios.sql`

```sql
-- ───────────────────────── REGLAS DE PRECIO ─────────────────────────
-- Una regla por categoría. La regla global (category_id IS NULL) es el default.
CREATE TABLE margin_rules (
  id                  uuid PRIMARY KEY,
  category_id         uuid REFERENCES categories(id),   -- NULL = regla global
  nombre              text NOT NULL,                    -- 'Papelería escolar 40%'

  base_margen         text NOT NULL CHECK (base_margen IN ('costo', 'venta')),
  margen_pct          numeric(6,3) NOT NULL CHECK (margen_pct >= 0),
  margen_minimo_pct   numeric(6,3),                     -- ⭐ alerta si el precio cae por debajo

  redondeo_a_minor    bigint NOT NULL DEFAULT 50,       -- 50 = redondear a $0.50
  redondeo_modo       text NOT NULL DEFAULT 'arriba' CHECK (redondeo_modo IN ('arriba','cercano')),

  costo_incluye_iva   boolean NOT NULL DEFAULT true,     -- ¿el costo capturado trae IVA?
  is_default          boolean NOT NULL DEFAULT false,
  is_activo           boolean NOT NULL DEFAULT true,
  actualizado_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_id),
  CHECK (base_margen <> 'venta' OR margen_pct < 100)     -- margen sobre venta ≥ 100 % no existe
);

-- ───────────────────────── AJUSTES AL PRODUCTO ─────────────────────────
ALTER TABLE products
  ADD COLUMN precio_fijo        boolean NOT NULL DEFAULT false,   -- ⭐ precio impreso por el fabricante
  ADD COLUMN margen_override_pct numeric(6,3),                    -- excepción puntual al catálogo
  ADD COLUMN costo_ultima_compra_minor bigint;                    -- referencia (el PPA sigue mandando)

-- Los productos con precio fijo se EXCLUYEN de cualquier recálculo masivo.
CREATE INDEX idx_products_recalkeo ON products(category_id)
  WHERE is_activo AND deleted_at IS NULL AND NOT precio_fijo;

-- ───────────────────────── SEMILLAS ─────────────────────────
INSERT INTO margin_rules (id, category_id, nombre, base_margen, margen_pct,
                          margen_minimo_pct, redondeo_a_minor, costo_incluye_iva, is_default)
VALUES (uuidv7(), NULL, 'Regla general 40 % sobre costo', 'costo', 40.000, 25.000, 50, true, true);
```

### 3.2 La función (una sola, con tests)

```ts
// packages/core/src/precios/calcularPrecio.ts  ← el código real, ya escrito y probado

export type BaseMargen = 'costo' | 'venta';

export type ReglaPrecio = {
  baseMargen: BaseMargen;               // 'costo' = markup · 'venta' = margen sobre el precio
  margenPct: number;                    // 40 = 40 %
  margenMinimoPct?: number;             // si el resultado baja de aquí → estado 'bajo_minimo'
  redondeoAMinor?: Centavos;            // 50n = $0.50  (por defecto 1n)
  redondeoModo?: 'arriba' | 'cercano';  // por defecto 'arriba'
  tasaIva: number;                      // 0.16
  costoIncluyeIva: boolean;             // true si el costo capturado trae IVA (factura)
};

export type EstadoPrecio = 'ok' | 'bajo_costo' | 'bajo_minimo';

export type ResultadoPrecio = {
  costoNeto: Centavos;        // costo sin IVA: la base real de la ganancia
  precioNeto: Centavos;       // lo que queda después de separar el IVA
  iva: Centavos;              // IVA trasladado (no es tuyo)
  lista: Centavos;            // ⭐ el precio que va en la etiqueta
  ganancia: Centavos;         // precioNeto − costoNeto
  markupPct: number;          // ganancia / costo       → "le gano 40 %"
  margenVentaPct: number;     // ganancia / precioNeto  → el número que de verdad importa
  estado: EstadoPrecio;       // alimenta el semáforo de la pantalla de producto
};

// Tres funciones, en este orden de uso:
//   calcularPrecio(costo, regla)         → precio sugerido + desglose completo
//   analizarPrecio(costo, lista, regla)  → analiza un precio YA escrito a mano (semáforo)
//   costoNetoDe(costo, regla)            → normaliza el costo capturado a neto
//
// Todas comparten el mismo redondeo (`redondearMitadArriba`) y el mismo desglose
// de IVA hacia atrás (`desglosarIvaIncluido`): una sola verdad, en `dinero.ts`.
```

> **El código de esta sección ya no vive aquí, vive en `packages/core`.** Este
> documento explica el *por qué*; el archivo y sus pruebas son el *qué*. Si los
> dos se contradicen, mandan las pruebas.

```ts
// packages/core/src/precios/calcularPrecio.test.ts — parte de las 68 pruebas en verde.
// ⚠️ Estos valores NO están calculados a mano: los imprime el propio código.
//    (La primera versión de este documento los tenía mal y las pruebas lo delataron.)

test('markup 40 % sobre costo $100 sin IVA', () => {
  const r = calcularPrecio(10000n, { baseMargen: 'costo', margenPct: 40,
    tasaIva: 0.16, costoIncluyeIva: false, redondeoAMinor: 1n });
  expect(r.costoNeto).toBe(10000n);       // $100.00
  expect(r.precioNeto).toBe(14000n);      // $140.00 neto
  expect(r.lista).toBe(16240n);           // $162.40 lo que paga el cliente
  expect(r.iva).toBe(2240n);              // $22.40 que NO son tuyos
  expect(r.ganancia).toBe(4000n);         // $40.00
  expect(r.markupPct).toBeCloseTo(40, 1);
  expect(r.margenVentaPct).toBeCloseTo(28.57, 1);   // ⭐ NO es 40 %
});

test('costo capturado CON IVA ($116) da EXACTAMENTE el mismo precio', () => {
  const r = calcularPrecio(11600n, { baseMargen: 'costo', margenPct: 40,
    tasaIva: 0.16, costoIncluyeIva: true });
  expect(r.costoNeto).toBe(10000n);       // el IVA del proveedor es acreditable
  expect(r.lista).toBe(16240n);           // $162.40, igual que con costo sin IVA
  expect(r.ganancia).toBe(4000n);
});

test('margen 40 % SOBRE VENTA, mismo costo $100', () => {
  const r = calcularPrecio(10000n, { baseMargen: 'venta', margenPct: 40,
    tasaIva: 0.16, costoIncluyeIva: false });
  expect(r.precioNeto).toBe(16667n);      // $166.67 neto  ← $26.67 más que arriba
  expect(r.lista).toBe(19334n);           // $193.34 con IVA ← $30.94 más
  expect(r.ganancia).toBe(6667n);         // $66.67        ← 67 % más de ganancia
  expect(r.margenVentaPct).toBeCloseTo(40, 1);
  expect(r.markupPct).toBeCloseTo(66.67, 1);
});

test('margen sobre venta >= 100 % es un error de configuración', () => {
  expect(() => calcularPrecio(10000n, { baseMargen: 'venta', margenPct: 100,
    tasaIva: 0.16, costoIncluyeIva: false })).toThrow(ErrorPrecio);
});
```

**La misma frase, dos precios distintos:**

| Lo que dice el dueño | `baseMargen` | Precio neto | Precio de lista | Ganancia |
|---|---|---|---|---|
| "le gano 40 % al costo" | `'costo'` | $140.00 | $162.40 | $40.00 |
| "mi margen es 40 %" | `'venta'` | $166.67 | $193.34 | $66.67 |

Un 19 % más de precio y un 67 % más de ganancia con la misma frase de "40 %".
Por eso `baseMargen` **no tiene valor por defecto**: se elige una vez, al crear
la regla de la categoría, y se ve en la pantalla (`docs/12 §1`).

### 3.3 Redondeo comercial: cómo elegirlo

El redondeo no es cosmético; es **margen que ganas o pierdes en cada venta**, y es lo que hace que el ticket se vea limpio y el cambio sea rápido en efectivo.

| Rango de precio | Redondeo sugerido | Por qué |
|-----------------|-------------------|---------|
| < $20 | a **$0.50** hacia arriba | $6.00, $7.50, $12.50. Da cambio limpio con monedas |
| $20 – $100 | a **$1** hacia arriba | Evitas los centavos en el ticket |
| $100 – $500 | a **$5** hacia arriba | $135, $240. Precios que se ven "de verdad" |
| > $500 | a **$10** hacia arriba | $1 250, $1 890 |
| Golosinas, dulces | al **$0.50** más cercano | Precio psicológico; aquí sí el cliente compara centavos |

```ts
// El redondeo se aplica al precio CON IVA (el que ve el cliente), no al neto.
// Y siempre 'arriba': en una papelería nadie devuelve 30 centavos, pero 100
// ventas al día redondeadas hacia abajo sí son dinero.
```

## 4. Márgenes por categoría: un solo 40 % para todo está mal

Este es el punto que más dinero te va a dar. Un mismo porcentaje para toda la papelería hace que:

- **pierdas** en lo que el cliente compara con Amazon (calculadoras, USB),
- **y dejes dinero en la mesa** en lo que nadie compara (golosinas, engargolados, un clips que cuesta 20 centavos).

Márgenes realistas para una papelería en México:

| Categoría | Base | Markup sugerido | Por qué |
|-----------|------|:---:|---------|
| **Golosinas y dulces** | costo | **50–80 %** | Compra por impulso, ticket chico, competencia por surtido y no por precio |
| **Artículos de escritorio sueltos** (plumas, lápices, borradores, clips) | costo | **45–60 %** | Precios de $5–$30, el cliente no compara, alto volumen |
| **Papelería escolar** (cuadernos, colores, reglas) | costo | **35–45 %** | Alta rotación, el cliente sí compara y hay "costo de la lista escolar" |
| **Oficina / archivo** (folders, engrapadoras, tóner) | costo | **40–55 %** | Compra de reposición, poca elasticidad |
| **Arte y manualidades** (pinturas, pinceles, foamy) | costo | **45–65 %** | Poca competencia local, el padre compra lo que le piden |
| **Mochilas, loncheras, temporada** | costo | **30–40 %** | Precio muy sensible; se vende por temporada y con promoción |
| **Tecnología** (calculadoras, USB, audífonos, mouse) | costo | **15–25 %** | ⭐ El cliente lo compara con Amazon y Mercado Libre. Aquí **no** puedes poner 40 % |
| **Servicios** (fotocopia, impresión, engargolado, laminado) | — | **precio de mercado, no %** | Vale $2 la hoja porque el de la esquina cobra $2. El margen real es 80 %+ porque tu costo es papel y tóner. Se fija por **precio**, no por margen |
| **Productos con precio impreso (PSP)** | — | **precio fijo** | Cuadernos Scribe, plumas de marca: el fabricante imprime el precio. Marca `precio_fijo = true` |

**Ejemplo del daño de usar un solo 40 %:**

```text
Calculadora científica  costo $210   → markup 40 % → $294
   Pero en Amazon está a $249. El cliente la compra allá. Vendiste 0.
   Con markup 18 % → $248 → ganas $38 y VENDES.

Dulce "cajeta"          costo $2.50  → markup 40 % → $3.50
   El de la esquina la vende a $5 y se vende igual.
   Con markup 80 % → $5.00 → ganas $2.50. NO perdiste ninguna venta.
```

**Un solo ajuste de reglas por categoría te puede cambiar el margen del mes más que cualquier optimización de software.**

## 5. La pantalla de alta de producto (donde esto se usa)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  NUEVO PRODUCTO                                    [ Guardar ]  [ Cancelar]│
├──────────────────────────────────────────────────────────────────────────┤
│  Nombre:      [ Cuaderno profesional 100 hojas                    ]      │
│  Categoría:   [ Papelería escolar ▾ ]              (regla: 40 % sobre costo)│
│  Unidad:      [ pieza ▾ ]        Proveedor: [ Scribe ▾ ]                 │
│  Ubicación:   [ A-3-12 ]         ☐ Precio fijo (lo imprime el fabricante)│
├──────────────────────────────────────────────────────────────────────────┤
│  COSTO                                                                   │
│    Capturar como:  (●) con IVA   ( ) sin IVA       ← coincide con tu factura│
│    Costo:          [ $ 23.00 ]      → neto: $19.83                       │
├──────────────────────────────────────────────────────────────────────────┤
│  PRECIO                                       ⭐ esto se calcula solo     │
│    Base:        [ 40 % sobre el costo ▾ ]                                │
│    Margen:      [ 40.0 ] %   Margen mínimo: [ 25 ] %                     │
│    Redondeo:    [ $0.50 hacia arriba ▾ ]                                 │
│                                                                          │
│    Precio sugerido:        $ 27.50                                       │
│    ┌──────────────────────────────────────────────────────────────┐      │
│    │  Peso desglosado                                            │      │
│    │  IVA 16 % incluido        $ 3.79                            │      │
│    │  Ingreso neto             $ 23.71                            │      │
│    │  − Costo neto            −$ 19.83                            │      │
│    │  ──────────────────────────────────────                      │      │
│    │  GANANCIA                 $  3.88     ✅ 19.6 %              │      │
│    │  Markup real                          19.6 % ⚠️ por debajo   │      │
│    │                                       del mínimo (25 %)     │      │
│    └──────────────────────────────────────────────────────────────┘      │
│                                                                          │
│    Precio final de lista:  [ $ 27.50 ]   ← puedes sobrescribirlo         │
│    ( ) Usar el sugerido    ( ) Fijar manualmente                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ☑ Generar código interno EAN-13   ☑ Imprimir etiqueta ahora            │
└──────────────────────────────────────────────────────────────────────────┘
```

Tres detalles de esta pantalla que valen oro:

1. **El indicador de margen en vivo, mientras tecleas el precio.** Verde si supera el mínimo de la categoría, ámbar si está por debajo, rojo si el precio queda bajo el costo. Es el control de calidad del precio y no cuesta nada.
2. **El costo se captura como viene en la factura** (con IVA) y el sistema hace la conversión. Pedirle al dueño que divida entre 1.16 a mano es pedirle que se equivoque.
3. **El precio sugerido se puede sobrescribir**, pero cuando se sobrescribe **hacia abajo** entra la política P3 del documento [06](06-authz-rbac-abac.md#5-políticas-concretas-para-tu-papelería) (step-up + motivo). Es la red de seguridad contra el error del cero.

## 6. Recálculo masivo cuando suben los costos

Lo que pasa cada vez que el proveedor sube precios. Sin esto, actualizas 800 precios a mano y nunca lo haces.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  RECALCULAR PRECIOS                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Origen de la subida                                                      │
│     (●) El proveedor subió sus precios → [ Aplicar +10 % a los costos ]      │
│     ( ) Ya actualicé los costos uno por uno                                  │
│                                                                             │
│  2. A qué productos                    3. Nueva regla                        │
│     Categoría: [ Papelería escolar ▾ ]     Base:   [ 42 % sobre costo ▾ ]    │
│     Proveedor: [ Todos ▾ ]                 Mínimo: [ 25 ] %                  │
│     ☐ Incluir los de precio mínimo         Redondeo: [ $1 hacia arriba ▾ ]   │
│     ☑ Excluir precio fijo (PSP)  ← 12 excluidos automáticamente              │
├─────────────────────────────────────────────────────────────────────────────┤
│  VISTA PREVIA (184 productos)                                                │
│  ┌───────────────────────┬─────────┬─────────┬────────┬────────┬─────────┐  │
│  │ Producto              │ Costo   │ Actual  │ Nuevo  │ Var.   │ Margen  │  │
│  ├───────────────────────┼─────────┼─────────┼────────┼────────┼─────────┤  │
│  │ Cuaderno Scribe 100h  │ $19.83  │ $27.50  │ $29.00 │ +5.5 % │ 19.6→25.7│ │
│  │ Cuaderno Cosido 200h  │ $31.03  │ $45.00  │ $46.00 │ +2.2 % │ 31.0→32.6│ │
│  │ Lápiz Mirado #2       │  $3.45  │  $6.00  │  $7.00 │+16.7 % │ 42.5→50.7│ │
│  │ ⚠️ Goma Pelikan blanca │  $8.62  │ $14.00  │ $13.00 │ −7.1 % │ 38.4→33.7│ │
│  │ ⏭️ Cuaderno Scribe 50h │  $12.07 │ $18.00  │  —     │  —     │ precio  │ │
│  │                       │         │         │        │        │ fijo 🔒 │ │
│  └───────────────────────┴─────────┴─────────┴────────┴────────┴─────────┘  │
│  Resumen: 184 cambian · 12 se saltan (precio fijo) · ⚠️ 3 BAJAN de precio    │
│                                                                             │
│  ☑ Generar reporte de etiquetas a reimprimir (12 etiquetas de anaquel)      │
│  Motivo: [ Subida de Scribe 10 % en la lista de octubre        ] ← obligatorio│
│                                                                             │
│  [ Revisar los 3 que bajan ]     [ Aplicar 184 cambios ]  ← pide PIN (P4)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Por qué la vista previa es obligatoria y no un lujo:**

- Los **3 productos que BAJAN de precio** son casi siempre un error (un producto con precio de oferta, uno que ya estaba mal capturado, o un costo que no debía subir). Aplicarlo a ciegas baja precios en silencio.
- Los **productos con precio fijo** deben saltarse solos. Si no, vas a "actualizar" el precio de un cuaderno que tiene el precio impreso por el fabricante y vas a quedar mal con el cliente.
- El **reporte de etiquetas** cierra el círculo con el documento [03 §6](03-codigos-de-barras.md#6-detalle-de-oro-la-etiqueta-impresa-miente-cuando-cambias-el-precio): cambias precios, el sistema te dice qué etiquetas de anaquel quedaron mintiendo, y reimprimes solo esas.

**Y el flujo de paso a paso (el que realmente usarás):**

```text
1. El proveedor te manda la lista nueva (más cara).
2. En el sistema: "Aplicar +10 % a los costos del proveedor Scribe".
   → los costos PPA se actualizan SOLO para los productos que compraste de él.
3. Automáticamente: "23 productos de Scribe quedaron con margen bajo el mínimo".
4. Le das [ Recalcular ] con la vista previa.
5. Aplicas → 23 precios nuevos + reporte de 9 etiquetas a reimprimir.
6. Reimprimas esas 9 etiquetas y las pegas.

Total: 15 minutos. Antes: nunca lo hacías, o lo hacías una vez al año perdiendo margen todo el tiempo.
```

## 7. Márgenes, mermas y el número que de verdad importa

El markup que configuras **no es** la utilidad que te queda. Es un error común creer que "gano 40 %". La cadena real:

```text
Costo $100 → lista $166.67 (margen 40 % sobre venta)

− Merma / faltante de inventario (1–3 % de la venta en papelería)   −$ 3.00
− Comisión de tarjeta (2–3 % de lo que se paga con tarjeta)          −$ 1.50
− Descuentos que das en el mostrador (1–2 %)                        −$ 1.20
− Muestras, promociones, producto dañado                            −$ 1.00
──────────────────────────────────────────────────────────────────────────
Margen real antes de gastos fijos                                    $59.97
− Renta, luz, internet, tu tiempo…                                  −$ …
──────────────────────────────────────────────────────────────────────────
Utilidad                                                             $ …
```

**Consecuencias prácticas:**

1. **El markup del 30 % es peligroso.** Con mermas y comisiones, un markup de 30 % (23 % de margen bruto) se vuelve ~18 % real. Antes de gastos fijos. En papelería, **40 % de markup es el piso**, 50 % es cómodo.
2. **La merma es tu enemigo silencioso**, no el precio. Por eso el ledger ([02](02-modelo-de-datos.md#4-ledger-de-movimientos-por-qué-no-se-edita-el-stock)) y el conteo ([05](05-pos-y-caja.md#6-turno-de-caja-y-arqueo)) importan más que exprimir un punto de margen. Un sistema que sube precios 5 % y tiene 4 % de merma está peor que uno con precios correctos y 1 % de merma.
3. **Mide el margen por producto, cada mes** ([02 §11](02-modelo-de-datos.md#11-vistas-y-consultas-que-vas-a-querer-desde-el-día-1)). Vas a descubrir que el 20 % de tus productos te da el 80 % de la ganancia y que algunos te están costando dinero.

```sql
-- Vista de márgenes, la que abrirás cada mes
CREATE VIEW v_margenes AS
SELECT p.id, p.nombre, c.nombre AS categoria,
       p.costo_promedio_minor,
       p.precio_minor,
       round((p.precio_minor / 1.16))::bigint                        AS precio_neto_minor,
       round((p.precio_minor / 1.16))::bigint - p.costo_promedio_minor AS ganancia_minor,
       round(100.0 * (round((p.precio_minor / 1.16)) - p.costo_promedio_minor)
             / nullif(round((p.precio_minor / 1.16)), 0), 1)         AS margen_pct,
       coalesce(mr.margen_minimo_pct, 25)                            AS minimo_pct,
       p.precio_fijo
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN margin_rules mr ON mr.category_id = p.category_id
WHERE p.is_activo AND p.deleted_at IS NULL AND p.costo_promedio_minor > 0;

-- ⚠️ Los que hay que revisar hoy:
SELECT * FROM v_margenes
WHERE NOT precio_fijo AND margen_pct < minimo_pct
ORDER BY (minimo_pct - margen_pct) * ganancia_minor DESC;   -- por dinero que dejas, no por %
```

> **El orden por "dinero que dejas" y no por porcentaje** es deliberado: un producto con 5 % de margen que vendes 2 al año no importa. Uno con 22 % de margen que vendes 40 veces al mes sí. El porcentaje engaña; los pesos no.

## 8. Los 6 errores de precio que este diseño evita

| Error | Cómo lo evita |
|-------|---------------|
| Confundir markup con margen (−12 puntos de ganancia) | `base_margen` explícito, y **las dos cifras siempre visibles** |
| Sumar el IVA a la ganancia | El IVA se despeja hacia atrás (`lista / 1.16`), nunca se suma a la utilidad |
| Usar un solo margen para toda la papelería | `margin_rules` por categoría |
| Redondear hacia abajo y regalar margen | `redondeo_modo = 'arriba'` por defecto |
| Cambiar precios a productos con precio impreso | `precio_fijo` los excluye del recálculo |
| Bajar precios por accidente en un recálculo masivo | Vista previa + los que bajan se revisan aparte + step-up |
| Subir costos y no tocar precios hasta el año siguiente | Flujo de recálculo de 15 minutos + reporte de margen bajo |

## 9. Checklist de este módulo

- [ ] `margin_rules` con `base_margen` explícito (`costo` / `venta`) — **nunca** un `0.4` ambiguo
- [ ] `base_margen = 'venta'` con `margen_pct >= 100` rechazado por `CHECK`
- [ ] `calcularPrecio()` pura en `packages/core`, con tests escritos a mano (markup 40 %, margen 40 %, costo con y sin IVA)
- [ ] Costo guardado **neto**; `costo_incluye_iva` convierte al capturar
- [ ] Precio guardado **con IVA incluido** (es lo que paga el cliente)
- [ ] `redondeo_a_minor` + `redondeo_modo = 'arriba'` (nunca hacia abajo por defecto)
- [ ] Reglas por categoría configuradas con márgenes realistas (sección §4)
- [ ] `products.precio_fijo` para PSP, **excluido** de los recálculos masivos
- [ ] `products.margen_override_pct` para excepciones puntuales
- [ ] Margen **en vivo** en la pantalla del producto (verde / ámbar / rojo contra el mínimo)
- [ ] Recálculo masivo: **vista previa obligatoria** + los que bajan, revisados aparte
- [ ] Recálculo masivo pide **step-up + motivo** (política P4)
- [ ] El recálculo dispara el **reporte de etiquetas desactualizadas** ([03 §6](03-codigos-de-barras.md#6-detalle-de-oro-la-etiqueta-impresa-miente-cuando-cambias-el-precio))
- [ ] `v_margenes` ordenada por **dinero que dejas**, no por porcentaje
- [ ] Precio final < costo → **denegado** por política (P1), sin posibilidad de forzarlo
