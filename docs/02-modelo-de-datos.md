# 02 — Modelo de datos

Esquema Postgres. **El mismo SQL corre en PGlite (navegador) y en PostgreSQL 16 (servidor)**: un solo juego de migraciones.

## 1. Convenciones

| Convención | Regla | Por qué |
|-----------|-------|---------|
| Nombres | `snake_case`, tablas en plural | Consistencia, sin comillas raras en SQL |
| Llaves primarias | `uuid` generado en el cliente (`uuidv7()`) | Un dispositivo offline puede crear filas sin pedir ID al servidor |
| Dinero | `bigint` en **centavos**, sufijo `_minor` | `$12.50` → `1250`. Sin `float`. Ver §2 |
| Tiempos | `timestamptz`, siempre UTC, sufijo `_at` | Un solo reloj. Los reportes convierten a local |
| Booleanos | prefijo `is_` / `tracks_` | Legibilidad |
| Borrado | `deleted_at timestamptz` (soft delete) | Un dispositivo offline puede re-crear algo que borraste; el soft delete resuelve la carrera |
| Tablas de eventos | sin `UPDATE` ni `DELETE` (solo `INSERT`) | Auditables y sincronizables |

## 2. Dinero: la regla que más bugs evita

```ts
// ❌ NUNCA
const total = 12.30 * 3;            // 36.899999999999995
const iva  = total * 0.16;          // y sigue arrastrando el error
if (total === 36.90) { ... }        // false. siempre false.

// ✅ SIEMPRE
type Minor = bigint;                 // centavos
const precio: Minor = 1230n;         // $12.30
const total: Minor = precio * 3n;    // 3690n → $36.90 exacto

// Presentación al usuario:
new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
  .format(Number(total) / 100);      // "$36.90"
```

Detalles que importan:

- **Precios con IVA incluido.** En una papelería el precio de lista *es* el precio final. Se guarda el importe que paga el cliente y el desglose del IVA se calcula **hacia atrás** solo para el ticket y la contabilidad: `base = round(total / (1 + tasa))`. Guarda `tax_included boolean` en la config y `tax_rate` por producto, y **nunca** sumes el IVA por línea y luego el total: redondea por línea, suma después, y ajusta la última línea por la diferencia de 1 centavo si hace falta.
- **Redondeo:** `Math.round` en JS usa "round half to even" en algunos casos y "half up" en otros; con `bigint` la división trunca. Escribe una función única `roundHalfUp(n, d)` y úsala **en todas partes**. Este bug, de un centavo por ticket, aparece a los 3 meses como un descuadre de caja inexplicable.
- **Descuentos:** guarda `descuento_minor` como importe en la línea, no como porcentaje. El porcentaje se recalcula mal cuando cambia el precio.
- **Costo histórico:** cada línea de venta guarda `costo_unitario_minor` *del momento de la venta*, no el actual. Si no, tu reporte de margen de octubre cambia cuando subes precios en noviembre.

## 3. Esquema — Núcleo

```sql
-- ⚠️ Corregido al implementar la migración 0001: aquí decía
-- `CREATE EXTENSION IF NOT EXISTS pgcrypto`. Ya no hace falta. Desde PostgreSQL 13
-- `gen_random_uuid()` es del núcleo, no de pgcrypto, y PGlite puede no traer la
-- extensión. Quitarlo es una dependencia menos y una incompatibilidad menos.

-- ───────────────────────── CATÁLOGO ─────────────────────────

CREATE TABLE categories (
  id          uuid PRIMARY KEY,
  parent_id   uuid REFERENCES categories(id),        -- jerarquía: Papelería > Escritura > Plumas
  nombre      text NOT NULL,
  path        text NOT NULL,                          -- 'papeleria/escritura/plumas' (búsqueda rápida)
  deleted_at  timestamptz
);

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY,
  nombre      text NOT NULL,
  telefono    text,
  notas       text,
  deleted_at  timestamptz
);

CREATE TABLE tax_rates (
  id          uuid PRIMARY KEY,
  nombre      text NOT NULL,      -- 'IVA 16%', 'Tasa 0%', 'Exento'
  tasa        numeric(6,4) NOT NULL,   -- 0.1600
  deleted_at  timestamptz
);

CREATE TABLE units (
  id          uuid PRIMARY KEY,
  nombre      text NOT NULL UNIQUE,    -- 'pieza', 'paquete', 'caja', 'hoja', 'metro', 'hora'
  abreviatura text NOT NULL            -- 'pza', 'paq', 'cja'
);

CREATE TABLE products (
  id                 uuid PRIMARY KEY,
  sku                text UNIQUE,          -- código propio legible: 'PAP-LAP-MIR-2'
  nombre             text NOT NULL,
  descripcion        text,
  category_id        uuid REFERENCES categories(id),
  supplier_id        uuid REFERENCES suppliers(id),
  unit_id            uuid NOT NULL REFERENCES units(id),   -- unidad base de inventario
  tax_rate_id        uuid REFERENCES tax_rates(id),

  precio_minor       bigint NOT NULL,      -- precio de venta al público
  costo_minor        bigint NOT NULL DEFAULT 0,
  costo_promedio_minor bigint NOT NULL DEFAULT 0,   -- ver §4 (PPA)

  tracks_stock       boolean NOT NULL DEFAULT true,  -- false = fotocopias, servicios
  stock_minimo       numeric(12,3) NOT NULL DEFAULT 0,
  stock_maximo       numeric(12,3),
  ubicacion          text,                 -- 'A-3-12' (anaquel/charola) → se imprime en la etiqueta

  permite_venta_fraccion boolean NOT NULL DEFAULT false,  -- ¿se vende media caja?
  is_activo          boolean NOT NULL DEFAULT true,
  imagen_url         text,
  notas              text,
  creado_at          timestamptz NOT NULL DEFAULT now(),
  actualizado_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CHECK (precio_minor >= 0),
  CHECK (costo_minor >= 0),
  CHECK (nombre <> '')
);

CREATE INDEX idx_products_categoria ON products(category_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_activo    ON products(is_activo)   WHERE deleted_at IS NULL;
-- Búsqueda por nombre sin acentos, rápida y offline-friendly:
CREATE INDEX idx_products_busqueda  ON products
  USING gin (to_tsvector('spanish', nombre || ' ' || coalesce(sku,'') || ' ' || coalesce(descripcion,'')));
```

### Cantidades: `numeric(12,3)`, no `integer`

Un papelería vende medio paquete, 0.5 m de papel, 250 hojas. **`numeric(12,3)`** permite fracciones con 3 decimales sin error de punto flotante (a diferencia de `real`/`double`). Si estás seguro de que todo se vende en piezas enteras puedes usar `integer`, pero cambiarlo después es una migración dolorosa. Empieza con `numeric`.

## 4. Ledger de movimientos (por qué NO se edita el stock)

Esta es la decisión más importante del modelo.

```sql
-- ❌ El enfoque que parece obvio y te va a arruinar:
-- UPDATE products SET stock = stock - 2 WHERE id = '...';
--   · No sabes QUIÉN lo hizo, CUÁNDO, NI POR QUÉ.
--   · Dos dispositivos offline restan 2 y el resultado depende del orden → conflicto.
--   · No puedes reconstruir el inventario de un día pasado.

-- ✅ El enfoque correcto: append-only.
CREATE TABLE stock_movements (
  id                uuid PRIMARY KEY,
  product_id        uuid NOT NULL REFERENCES products(id),
  presentacion_id   uuid REFERENCES product_presentations(id),  -- null = unidad base
  qty               numeric(12,3) NOT NULL,   -- + entrada, − salida. NUNCA 0
  qty_base          numeric(12,3) NOT NULL,   -- qty × factor de conversión, en unidad base

  motivo            text NOT NULL,            -- ver catálogo en §4.1
  ref_type          text,                     -- 'sale' | 'purchase' | 'count' | 'return' | 'loss'
  ref_id            uuid,                     -- id de la venta, compra, conteo...
  ubicacion_destino text,

  costo_unitario_minor bigint NOT NULL DEFAULT 0,   -- costo de ESTE movimiento
  notas             text,
  user_id           uuid NOT NULL REFERENCES users(id),
  device_id         uuid NOT NULL REFERENCES devices(id),
  ocurrido_at       timestamptz NOT NULL,     -- reloj del dispositivo (ver 08)
  registrado_at     timestamptz NOT NULL DEFAULT now(),  -- reloj del servidor

  CHECK (qty <> 0)
);

CREATE INDEX idx_mov_producto_fecha ON stock_movements(product_id, ocurrido_at DESC);
CREATE INDEX idx_mov_ref            ON stock_movements(ref_type, ref_id);
CREATE INDEX idx_mov_fecha          ON stock_movements(ocurrido_at DESC);
```

### 4.1 Catálogo de motivos

Usa valores **enumerados en código**, no texto libre. El texto libre hace inservibles los reportes.

| `motivo` | Signo | Origen |
|----------|-------|--------|
| `venta` | − | Venta cobrada |
| `devolucion_cliente` | + | Reingreso de una venta |
| `compra_recepcion` | + | Llegó mercancía del proveedor |
| `compra_cancelada` | − | Se devolvió al proveedor |
| `ajuste_manual` | ± | Corrección con motivo obligatorio |
| `merma` | − | Roto, manchado, caducado, robo/hurto |
| `conteo_fisico` | ± | Diferencia del inventario físico |
| `traspaso_salida` / `traspaso_entrada` | ∓ + | Entre ubicaciones |
| `consumo_interno` | − | Se usó para la propia papelería |
| `muestra_cortesia` | − | Se regaló |
| `error_captura` | ± | Se registró mal y se revierte (referencia el movimiento original) |

**Regla dura:** `motivo = 'ajuste_manual'` y `'merma'` **exigen** `notas` (mínimo 10 caracteres) y, por política ABAC, re-autenticación con PIN si el valor ajustado supera un umbral. Sin esto, "ajuste manual" se convierte en el agujero por donde se va el inventario y nadie sabe nada. Ver [06](06-authz-rbac-abac.md).

### 4.2 Saldo de stock: columna cacheada + trigger

Calcular `SUM(qty_base)` en cada consulta funciona con 5 000 movimientos y se muere con 500 000. Mantén una columna cacheada, pero **siempre derivada del ledger**:

```sql
CREATE TABLE stock_levels (
  product_id   uuid PRIMARY KEY REFERENCES products(id),
  qty_base     numeric(12,3) NOT NULL DEFAULT 0,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION aplicar_movimiento() RETURNS trigger AS $$
BEGIN
  INSERT INTO stock_levels (product_id, qty_base, actualizado_at)
  VALUES (NEW.product_id, NEW.qty_base, now())
  ON CONFLICT (product_id) DO UPDATE
    SET qty_base = stock_levels.qty_base + NEW.qty_base,
        actualizado_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_aplicar_movimiento
  AFTER INSERT ON stock_movements          -- ⚠️ sólo INSERT: el ledger es inmutable
  FOR EACH ROW EXECUTE FUNCTION aplicar_movimiento();
```

**Poder de reconciliación (lo que te salva):** en cualquier momento puedes ejecutar

```sql
SELECT m.product_id, SUM(m.qty_base) AS calculado, s.qty_base AS cacheado
FROM stock_movements m JOIN stock_levels s USING (product_id)
GROUP BY m.product_id, s.qty_base
HAVING SUM(m.qty_base) <> s.qty_base;
```

y **siempre debe devolver cero filas**. Si devuelve algo, hay un bug y lo detectas el mismo día en lugar de descubrirlo en el conteo anual. Esta consulta es tu test de integridad. Ponla en un chequeo nocturno que te avise.

### 4.3 Costo promedio ponderado (PPA)

```sql
-- Al recibir una compra de 100 pzas a $3.00 cuando ya tenías 50 a $2.80:
-- nuevo_costo = (50*280 + 100*300) / 150 = 293.33 → 293 centavos
```

Guarda `costo_promedio_minor` en `products` y recalcula **sólo con `motivo = 'compra_recepcion'`**. Es más simple que FIFO y suficiente para una papelería. El costo por movimiento queda registrado igual, así que si algún día quieres FIFO tienes los datos.

## 5. Presentaciones y unidades (cajas, paquetes, piezas)

Un problema real: el proveedor te vende **1 caja = 12 paquetes = 144 piezas**, tú vendes piezas sueltas a $6 y paquetes a $60. Necesitas un código de barras **distinto** para cada presentación.

```sql
CREATE TABLE units (         -- ya definida arriba
  id uuid PRIMARY KEY, nombre text, abreviatura text
);

CREATE TABLE product_presentations (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES products(id),
  unit_id       uuid NOT NULL REFERENCES units(id),   -- 'paquete', 'caja', 'pieza'
  nombre        text NOT NULL,          -- 'Paquete 12 pzas', 'Caja 144 pzas'
  factor        numeric(12,4) NOT NULL, -- cuántas unidades BASE contiene. pieza=1, paquete=12, caja=144
  precio_minor  bigint NOT NULL,        -- precio de ESTA presentación
  is_base       boolean NOT NULL DEFAULT false,  -- exactamente una por producto con factor = 1
  is_activo     boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, factor)
);

-- Un código de barras físico → una fila. Un producto puede tener varios
-- (código de fábrica, código propio pegado encima, etiqueta de anaquel, código de la caja).
CREATE TABLE product_barcodes (
  id              uuid PRIMARY KEY,
  product_id      uuid NOT NULL REFERENCES products(id),
  presentacion_id uuid REFERENCES product_presentations(id),  -- null = unidad base
  codigo          text NOT NULL,
  simbologia      text NOT NULL,   -- 'ean13' | 'code128' | 'qr' | 'itf14' | 'upc_a'
  es_primario     boolean NOT NULL DEFAULT false,
  es_interno      boolean NOT NULL DEFAULT false,  -- generado por nosotros (§03)
  notas           text,
  creado_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT uq_barcode UNIQUE (codigo)          -- ⭐ GLOBAL: un código = un producto, siempre
);

CREATE INDEX idx_barcode_lookup ON product_barcodes(codigo) WHERE deleted_at IS NULL;
```

`uq_barcode` global sobre `codigo` es una decisión deliberada y fuerte: **es lo que evita el bug más caro del POS** — escanear un código y que el sistema agregue el producto equivocado. Si dos productos comparten código (típico cuando alguien captura manualmente), la base lo rechaza al instante en lugar de vender mal durante meses.

Si un código cambia de producto, no lo edites: marca `deleted_at` y crea uno nuevo. Así el histórico de ventas sigue apuntando al producto correcto.

## 6. Usuarios, dispositivos, sesiones, permisos

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  nombre          text NOT NULL,
  email           text,
  password_hash   text,          -- argon2id; null si usa solo passkey
  pin_hash        text,          -- argon2id del PIN de 6 dígitos (paso 2 para acciones sensibles)
  totp_secret     text,          -- 2FA opcional
  is_activo       boolean NOT NULL DEFAULT true,
  ultimo_acceso_at timestamptz,
  creado_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE webauthn_credentials (     -- passkeys (§07)
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  credential_id  bytea NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  nombre         text,                  -- 'Celular del dueño', 'Windows Hello del mostrador'
  creado_at      timestamptz NOT NULL DEFAULT now(),
  ultimo_uso_at  timestamptz
);

CREATE TABLE devices (
  id             uuid PRIMARY KEY,
  user_id        uuid REFERENCES users(id),
  nombre         text NOT NULL,         -- 'PC caja 1', 'Celular Samsung A54'
  tipo           text NOT NULL,         -- 'terminal' | 'scanner' | 'server'
  codigo         text,                  -- 'C1': prefijo del folio. Nulo si no vende (0004)
  huella         text,                  -- hash del fingerprint (no es identidad, es contexto)
  is_trusted     boolean NOT NULL DEFAULT false,
  pairing_code   text,                  -- código de emparejamiento, uso único
  paired_at      timestamptz,
  ultimo_visto_at timestamptz,
  revoked_at     timestamptz,           -- ⭐ revocación inmediata si roban el celular
  creado_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id),
  device_id           uuid NOT NULL REFERENCES devices(id),
  refresh_token_hash  text NOT NULL,       -- SHA-256 del refresh; NUNCA el token en claro
  familia_id          uuid NOT NULL,       -- agrupa la cadena de rotaciones → detección de reuso
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,   -- p. ej. +30 min (caja), +30 días (panel admin)
  absolute_expires_at timestamptz NOT NULL,   -- tope duro: +12 h (caja), +90 días (admin)
  rotado_at           timestamptz,            -- cuándo se canjeó este refresh → detección de reuso (07 §2.2)
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent          text
);

CREATE INDEX idx_sessions_user   ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_family ON sessions(familia_id);
```

Detalle crítico de sesiones → [07](07-sesiones-y-seguridad.md). RBAC/ABAC → [06](06-authz-rbac-abac.md).

## 7. Ventas y pagos

```sql
CREATE TABLE cash_sessions (            -- "turno" de caja: apertura → cierre → arqueo
  id                  uuid PRIMARY KEY,
  terminal_id         uuid NOT NULL REFERENCES devices(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  abierta_at          timestamptz NOT NULL,
  cerrada_at          timestamptz,
  fondo_inicial_minor bigint NOT NULL DEFAULT 0,   -- el cambio con el que abre
  esperado_efectivo_minor  bigint,                 -- calculado al cerrar
  contado_efectivo_minor   bigint,                 -- lo que el dueño contó a mano
  diferencia_minor    bigint GENERATED ALWAYS AS
                        (coalesce(contado_efectivo_minor,0) - coalesce(esperado_efectivo_minor,0)) STORED,
  notas_cierre        text,
  CHECK (cerrada_at IS NULL OR cerrada_at > abierta_at)
);

CREATE TABLE sales (
  id                uuid PRIMARY KEY,
  folio             bigint GENERATED ALWAYS AS IDENTITY,   -- consecutivo GLOBAL, lo asigna el servidor al sincronizar
  folio_local       text NOT NULL,                         -- ⭐ folio visible al cliente, generado OFFLINE: 'C1-000123' (08 §6)
  cash_session_id   uuid NOT NULL REFERENCES cash_sessions(id),
  terminal_id       uuid NOT NULL REFERENCES devices(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  cliente_nombre    text,                    -- opcional, ventas a crédito o factura
  cliente_id        uuid,

  subtotal_minor    bigint NOT NULL,         -- suma de líneas sin descuentos globales
  descuento_minor   bigint NOT NULL DEFAULT 0,
  impuesto_minor    bigint NOT NULL DEFAULT 0,
  total_minor       bigint NOT NULL,

  estado            text NOT NULL,           -- 'completada' | 'cancelada' | 'devuelta_parcial' | 'devuelta_total'
  cancelada_at      timestamptz,
  cancelada_por     uuid REFERENCES users(id),
  motivo_cancelacion text,
  ticket_impreso    boolean NOT NULL DEFAULT false,

  idempotency_key   text NOT NULL UNIQUE,    -- ⭐ evita ventas duplicadas por reintento offline
  device_id         uuid NOT NULL REFERENCES devices(id),
  evento_id         text NOT NULL,           -- ULID del evento que la originó
  ocurrido_at       timestamptz NOT NULL,    -- reloj del dispositivo
  registrado_at     timestamptz NOT NULL DEFAULT now(),
  notas             text
);

CREATE INDEX idx_sales_fecha   ON sales(ocurrido_at DESC);
CREATE INDEX idx_sales_turno   ON sales(cash_session_id);
CREATE INDEX idx_sales_estado  ON sales(estado);

CREATE TABLE sale_lines (
  id                   uuid PRIMARY KEY,
  sale_id              uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  linea_no             int  NOT NULL,
  product_id           uuid NOT NULL REFERENCES products(id),
  presentacion_id      uuid REFERENCES product_presentations(id),
  descripcion          text NOT NULL,        -- snapshot: el nombre al momento de vender
  qty                  numeric(12,3) NOT NULL CHECK (qty > 0),
  qty_base             numeric(12,3) NOT NULL,
  precio_unitario_minor bigint NOT NULL,     -- snapshot
  descuento_minor      bigint NOT NULL DEFAULT 0,
  impuesto_minor       bigint NOT NULL DEFAULT 0,
  total_linea_minor    bigint NOT NULL,
  costo_unitario_minor bigint NOT NULL DEFAULT 0,   -- snapshot de costo → margen histórico correcto
  tax_rate_id          uuid REFERENCES tax_rates(id),
  es_venta_libre       boolean NOT NULL DEFAULT false,  -- fotocopias: descripción libre, sin producto
  UNIQUE (sale_id, linea_no)
);

CREATE TABLE payments (
  id             uuid PRIMARY KEY,
  sale_id        uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  metodo         text NOT NULL,     -- 'efectivo' | 'tarjeta_debito' | 'tarjeta_credito' | 'transferencia' | 'vale' | 'credito'
  monto_minor    bigint NOT NULL CHECK (monto_minor > 0),
  cambio_minor   bigint NOT NULL DEFAULT 0,   -- solo efectivo
  referencia     text,              -- últimos 4 dígitos, folio de transferencia, autorización
  ocurrido_at    timestamptz NOT NULL,
  -- ⚠️ NUNCA: numero_tarjeta, cvv, banda. Ver 07 §8 (PCI-DSS).
  CHECK (cambio_minor >= 0)
);
-- Venta mixta: $100 en efectivo + $50 con tarjeta → 2 filas en payments. Soportado por diseño.

CREATE TABLE returns (             -- devoluciones
  id                uuid PRIMARY KEY,
  sale_id           uuid NOT NULL REFERENCES sales(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  motivo            text NOT NULL,
  reingresa_stock   boolean NOT NULL DEFAULT true,
  total_devuelto_minor bigint NOT NULL,
  ocurrido_at       timestamptz NOT NULL,
  registrado_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_lines (
  id                uuid PRIMARY KEY,
  return_id         uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_line_id      uuid NOT NULL REFERENCES sale_lines(id),
  qty               numeric(12,3) NOT NULL CHECK (qty > 0),
  monto_devuelto_minor bigint NOT NULL
);
```

**Sobre `sale_lines.descripcion` y precios "snapshot":** se guardan a propósito aunque parezca redundante. Si mañana cambias el nombre o el precio de un producto, el ticket de ayer y el reporte de margen de ayer **no deben cambiar**. Copiar el dato es la única forma de lograrlo.

**Ventas canceladas:** nunca se borra una venta. `estado = 'cancelada'` + quien + cuándo + por qué, y se generan los movimientos inversos. Eso es lo que hace que un arqueo sea auditable.

## 8. Servicios sin stock (fotocopias, engargolados)

Un servicio **es** un producto con `tracks_stock = false` y sin `stock_movements`. Ventajas de reutilizar la misma tabla:

- Aparece en la búsqueda y en los reportes de venta como un solo sistema.
- Se le puede poner un botón grande en la pantalla del POS (favoritos).
- No hay que duplicar el flujo de cobro.

Para servicios con precio variable (por ejemplo, "impresión: $2 por hoja, 37 hojas = $74"), tienes dos caminos:

1. **Precio calculado en caja**: `es_venta_libre = true` en la línea, la cajera teclea cantidad y precio/detalle. Es lo que hacen las papelerías reales.
2. **Módulo de servicios**: plantillas con fórmula (`qty × precio`, escalones, doble cara, color). Es fase 3, no MVP.

```sql
INSERT INTO products (id, sku, nombre, unit_id, precio_minor, tracks_stock, is_activo)
VALUES
  -- ⚠️ Corregido: aquí decía `uuidv7()`, que NO EXISTE ni en PostgreSQL 16 (llegó
  -- en la 18) ni en PGlite. `gen_random_uuid()` sí está en el núcleo desde la 13.
  -- Un producto puede llevar un uuid generado así sin problema: son datos que crea
  -- el negocio, no catálogo compartido entre dispositivos.
  (gen_random_uuid(), 'SRV-FOTO-BN', 'Fotocopia blanco y negro (carta)', (SELECT id FROM units WHERE nombre='hoja'), 150, false, true),
  (gen_random_uuid(), 'SRV-IMPR-BN', 'Impresión blanco y negro (carta)',  (SELECT id FROM units WHERE nombre='hoja'), 200, false, true),
  (gen_random_uuid(), 'SRV-ENGARGO', 'Engargolado',                       (SELECT id FROM units WHERE nombre='pieza'), 3500, false, true);
```

Como **no** generan `stock_movements`, no ensucian el inventario ni el costo promedio. Si algún día quieres saber cuánto papel consumes, se modela como insumo aparte (`producto consumible` que sí controla stock) — pero eso es un problema de contabilidad de insumos, no del POS.

## 9. Conteo físico (toma de inventario)

```sql
CREATE TABLE inventory_counts (
  id           uuid PRIMARY KEY,
  nombre       text NOT NULL,           -- 'Conteo octubre 2026'
  estado       text NOT NULL,           -- 'abierto' | 'cerrado' | 'aplicado'
  alcance      text NOT NULL,           -- 'total' | 'categoria' | 'anaquel'
  filtro       jsonb,                   -- { categoria_id: '...' } o { ubicacion: 'A-3' }
  iniciado_por uuid NOT NULL REFERENCES users(id),
  iniciado_at  timestamptz NOT NULL,
  cerrado_at   timestamptz,
  aplicado_at  timestamptz
);

CREATE TABLE inventory_count_lines (
  id             uuid PRIMARY KEY,
  count_id       uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id),
  qty_sistema    numeric(12,3) NOT NULL,   -- foto del stock al abrir el conteo
  qty_contada    numeric(12,3),            -- lo que se contó físicamente (null = sin contar)
  diferencia     numeric(12,3) GENERATED ALWAYS AS (qty_contada - qty_sistema) STORED,
  contada_at     timestamptz,
  contada_por    uuid REFERENCES users(id),
  notas          text,
  UNIQUE (count_id, product_id)
);
```

Al **aplicar** el conteo se genera **un movimiento por diferencia** con `motivo = 'conteo_fisico'`, `ref_type='count'`, `ref_id = count_id`. Nunca un `UPDATE` directo: así el conteo queda en el histórico como cualquier otro movimiento y puedes explicar cualquier diferencia en el futuro.

**Flujo operativo que esto habilita (el bueno):** el dueño recorre el anaquel con el celular en modo conteo, escanea cada etiqueta, teclea la cantidad y sigue. La PC muestra el avance en vivo. Al cerrar, ve la lista de diferencias ordenada por **valor en dinero** (no por unidades) y decide. Detalle en [04 §7](04-escaneo-movil.md#7-la-misma-app-tres-modos-de-operación).

## 10. Sincronización y auditoría

```sql
CREATE TABLE event_log (
  server_seq   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ⭐ cursor global de lectura
  event_id     text NOT NULL UNIQUE,        -- ULID generado por el dispositivo
  device_id    uuid NOT NULL,
  device_seq   bigint NOT NULL,
  user_id      uuid REFERENCES users(id),
  type         text NOT NULL,               -- 'sale.created', 'product.updated', 'stock.adjusted'...
  payload      jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL,        -- reloj del dispositivo
  received_at  timestamptz NOT NULL DEFAULT now(),
  hlc          text NOT NULL,               -- reloj lógico híbrido (08 §5)
  schema_version int NOT NULL DEFAULT 1,
  UNIQUE (device_id, device_seq)
);

CREATE INDEX idx_event_seq ON event_log(server_seq);
CREATE INDEX idx_event_tipo ON event_log(type, received_at DESC);

CREATE TABLE sync_cursors (           -- qué ha visto cada dispositivo
  device_id      uuid PRIMARY KEY,
  last_pull_seq  bigint NOT NULL DEFAULT 0,
  last_push_at   timestamptz,
  ultimo_error   text
);

-- Las dos de la migración 0004. Igual que outbox y sync_cursors, son estado LOCAL del
-- dispositivo: no se sincronizan. Guardan lo que tiene que ser monótono y sin huecos.
-- (Se añadieron en la fase 0.5: el diseño las citaba pero no existían en el esquema.)
CREATE TABLE device_counters (        -- en el DISPOSITIVO
  device_id      uuid PRIMARY KEY REFERENCES devices(id),
  ultimo_seq     bigint NOT NULL DEFAULT 0,  -- último device_seq entregado
  ultimo_hlc     text,                       -- último reloj lógico emitido
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ultimo_seq >= 0)
);

CREATE TABLE folio_counters (         -- en el DISPOSITIVO
  device_id      uuid PRIMARY KEY REFERENCES devices(id),
  ultimo_folio   bigint NOT NULL DEFAULT 0,  -- último folio visible entregado
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ultimo_folio >= 0)
);

CREATE TABLE outbox (                 -- en el DISPOSITIVO, no en el servidor
  id           uuid PRIMARY KEY,
  event_id     text NOT NULL UNIQUE,
  payload      jsonb NOT NULL,
  intentos     int NOT NULL DEFAULT 0,
  ultimo_intento_at timestamptz,
  ultimo_error text,
  creado_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (              -- quién hizo qué, independiente de la sincronización
  id           uuid PRIMARY KEY,
  user_id      uuid REFERENCES users(id),
  device_id    uuid REFERENCES devices(id),
  accion       text NOT NULL,        -- 'precio.cambiado', 'sesion.step_up', 'ajuste.manual'
  entidad      text,                 -- 'products'
  entidad_id   uuid,
  antes        jsonb,
  despues      jsonb,
  ip           inet,
  ocurrido_at  timestamptz NOT NULL
);

CREATE TABLE settings (               -- configuración de la papelería
  clave        text PRIMARY KEY,
  valor        jsonb NOT NULL,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);
-- Semillas: nombre_negocio, rfc, direccion, telefono, moneda='MXN',
--          iva_por_defecto=0.16, precio_incluye_iva=true,
--          prefijo_folio='PAP' ⚠️ SIN USO: ver docs/08 §6, el prefijo vigente es
--          devices.codigo (por terminal, es el único que evita folios repetidos),
--          ancho_ticket_mm=58,
--          prefijo_codigo_interno='200', dias_para_devolucion=7
```

`event_log` y `audit_log` parecen duplicados pero no lo son: `event_log` es **mecánica de sincronización** (se puede purgar después de X tiempo si compactas), `audit_log` es **cumplimiento e historia del negocio** (se conserva para siempre y nunca se sincroniza entre dispositivos).

## 11. Vistas y consultas que vas a querer desde el día 1

```sql
-- Ventas del día por método de pago (debe cuadrar con la caja)
CREATE VIEW v_ventas_por_metodo AS
SELECT date_trunc('day', s.ocurrido_at) AS dia, p.metodo,
       count(DISTINCT s.id) AS tickets, sum(p.monto_minor) AS monto_minor
FROM sales s JOIN payments p ON p.sale_id = s.id
WHERE s.estado = 'completada'
GROUP BY 1, 2;

-- Productos que más se venden (para la pantalla de favoritos y para comprar mejor)
CREATE VIEW v_top_productos AS
SELECT sl.product_id, p.nombre,
       sum(sl.qty) AS unidades_vendidas,
       sum(sl.total_linea_minor) AS ingresos_minor,
       sum(sl.total_linea_minor - sl.costo_unitario_minor * sl.qty) AS margen_minor
FROM sale_lines sl
JOIN sales s ON s.id = sl.sale_id AND s.estado = 'completada'
JOIN products p ON p.id = sl.product_id
GROUP BY 1, 2 ORDER BY ingresos_minor DESC;

-- Bajo stock, con urgencia ponderada por venta (no todo lo que baja es urgente)
CREATE VIEW v_bajo_stock AS
SELECT p.id, p.nombre, p.ubicacion, p.stock_minimo,
       coalesce(sl.qty_base, 0) AS stock_actual,
       p.stock_minimo - coalesce(sl.qty_base, 0) AS faltante
FROM products p
LEFT JOIN stock_levels sl ON sl.product_id = p.id
WHERE p.tracks_stock AND p.is_activo AND p.deleted_at IS NULL
  AND coalesce(sl.qty_base, 0) <= p.stock_minimo;

-- Margen por fecha (usa el costo HISTÓRICO de la línea, no el actual → correcto)
CREATE VIEW v_margen_diario AS
SELECT date_trunc('day', s.ocurrido_at) AS dia,
       sum(sl.total_linea_minor) AS ingresos_minor,
       sum(sl.costo_unitario_minor * sl.qty) AS costo_minor,
       sum(sl.total_linea_minor) - sum(sl.costo_unitario_minor * sl.qty) AS margen_minor,
       CASE WHEN sum(sl.total_linea_minor) > 0
            THEN round(100.0 * (sum(sl.total_linea_minor) - sum(sl.costo_unitario_minor * sl.qty))
                       / sum(sl.total_linea_minor), 2)
            ELSE 0 END AS margen_pct
FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id AND s.estado = 'completada'
GROUP BY 1 ORDER BY 1 DESC;
```

## 12. Migraciones iguales en los dos motores

```text
packages/db/migrations/
  0001_init.sql
  0002_rbac_abac.sql          -- roles, permissions, policies
  0003_seed_catalogos.sql     -- unidades, tasas de impuesto, categorías base
  0004_eventos.sql            -- device_counters, folio_counters, devices.codigo (doc 08)
  0005_politicas.sql          -- las 30 reglas de autorización, como datos (doc 06)
  0006_secuencias.sql         -- barcode_sequences: el código interno, reservado en la base (doc 03 §4)
  0007_precios.sql            -- PENDIENTE: margin_rules + precio_fijo/margen_override (doc 12)
```

**Estado:** `0001`–`0006` implementadas y probadas (`packages/db`, 150 pruebas en verde,
148 de ellas sin necesidad de un motor externo). Los números no salieron como este plan: al
llegar la fase F0 entraron antes los **eventos** (`0004`, doc 08) y las **políticas**
(`0005`, doc 06) que las vistas de reportes o la búsqueda full-text, que siguen pendientes.
El generador de códigos internos (`0006`) se adelantó a los precios porque F1 lo necesita
antes que F2; `0007` queda reservada para `margin_rules` (doc 12).

Al escribirlas aparecieron cinco cosas que este documento decía mal y que quedan
corregidas en los archivos. Ninguna era teórica: las cinco rompían la migración.

| Documento decía | Realidad | Corrección |
|-----------------|----------|------------|
| `CREATE EXTENSION pgcrypto` (§3) | Desde PostgreSQL 13 `gen_random_uuid()` es del núcleo; PGlite puede no traer la extensión | Se quitó |
| Orden narrativo de las tablas (§3→§5→§6) | `stock_movements` (§4) referencia `product_presentations` (§5), `users` y `devices` (§6), que se definen después. Postgres exige que la tabla referenciada exista antes | `0001` las ordena por dependencia |
| `uuidv7()` en las semillas (§8 y doc 06 §3.4) | No existe en PostgreSQL 16 ni en PGlite. Y en datos de referencia era además un error de diseño: cada dispositivo habría creado el mismo rol con otro uuid | UUID literales y fijos |
| `CREATE INDEX … WHERE expira_at > now()` (doc 06 §6) | Los predicados de índice exigen funciones `IMMUTABLE` y `now()` es `STABLE`: el motor lo rechaza | Índice sobre `(user_id, expira_at)` |
| El catálogo de motivos y la regla de las notas (§4.1) estaban en prosa | Escrito solo en la interfaz, cualquier script lo viola | `CHECK` de catálogo cerrado + notas obligatorias de 10 caracteres en `ajuste_manual` y `merma` |

Reglas para que PGlite y Postgres acepten **el mismo archivo**:

| Permitido | Prohibido | Por qué |
|-----------|-----------|---------|
| `CREATE TABLE`, índices, `CHECK`, `GENERATED ... STORED` | `pg_cron`, `pg_partman`, `dblink` | No existen en WASM |
| `plpgsql` simple (triggers, funciones) | Reglas con `SECURITY DEFINER` + roles de BD | PGlite corre sin roles |
| `jsonb`, `text[]`, `numeric`, `uuid` | Tipos custom (`CREATE TYPE ... AS`) con mucha lógica | Con `text` + `CHECK` es equivalente y portable |
| `to_tsvector('spanish', ...)` | Extensiones no incluidas | En PGlite hay que cargarla explícitamente |
| `CREATE VIEW` | `CREATE MATERIALIZED VIEW` con refresh concurrente | Sin `REFRESH ... CONCURRENTLY` en PGlite |
| `GENERATED ALWAYS AS IDENTITY` | `serial` con `sequence` compartida | Identidad funciona igual en ambos |

**Prueba obligatoria en CI:** aplicar todas las migraciones sobre un PGlite limpio **y** sobre un Postgres limpio, en cada commit. Es 20 líneas de script y es la única forma de detectar el día que introduces incompatibilidad, en lugar de descubrirlo con el cliente esperando.

```ts
// test/migraciones.test.ts
test('las migraciones corren en PGlite y el esquema coincide', async () => {
  const db = new PGlite();
  for (const f of ordenados('packages/db/migrations')) await db.exec(read(f));
  const pgliteTablas = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`);
  // comparar contra Postgres real → si difieren, el test falla
});
```
