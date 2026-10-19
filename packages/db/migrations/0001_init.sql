-- ═══════════════════════════════════════════════════════════════════════════
--  0001_init.sql — Esquema núcleo
-- ═══════════════════════════════════════════════════════════════════════════
--
--  EL MISMO ARCHIVO CORRE EN PGlite (navegador) Y EN POSTGRESQL 16 (servidor).
--  Un solo juego de migraciones. Reglas que hay que respetar para que eso siga
--  siendo cierto (doc 02 §12):
--
--    ✅ Permitido                                ❌ Prohibido
--    CREATE TABLE / índice / CHECK               pg_cron, pg_partman, dblink
--    GENERATED ... STORED, IDENTITY              serial con secuencia compartida
--    plpgsql simple (triggers, funciones)        SECURITY DEFINER + roles de BD
--    jsonb, text[], numeric, uuid, inet, bytea   CREATE TYPE ... AS ENUM
--    to_tsvector('spanish', ...)                 extensiones no incluidas
--    CREATE VIEW                                 MATERIALIZED VIEW + CONCURRENTLY
--
--  ─── Dos correcciones respecto del documento 02, y por qué ─────────────────
--
--  1. ORDEN DE LAS TABLAS. El doc 02 las presenta en orden narrativo (primero el
--     núcleo, luego el ledger, luego las presentaciones). Ese orden NO compila:
--     `stock_movements` (§4) referencia `product_presentations` (§5), `users` y
--     `devices` (§6), que se definen después. Postgres exige que la tabla
--     referenciada exista antes. Aquí van ordenadas por dependencia.
--
--  2. SIN `CREATE EXTENSION pgcrypto`. El doc 02 §3 lo pide "para
--     gen_random_uuid()". Ya no hace falta: desde Postgres 13 esa función es del
--     núcleo, no de pgcrypto, y PGlite puede no traer la extensión. Quitarlo
--     elimina una dependencia y una incompatibilidad potencial.
--
--  3. CHECKs QUE EL DOCUMENTO ENUNCIA EN PROSA Y NO EN SQL. El doc 02 §4.1 pide
--     "usa valores enumerados, no texto libre, porque el texto libre hace
--     inservibles los reportes" y llama "regla dura" a que 'ajuste_manual' y
--     'merma' exijan notas. Escrito solo en la interfaz, un script o una pluma de
--     más lo viola sin que nadie lo vea; escrito como CHECK, la base lo rechaza
--     en el acto. Se agregan: catálogo cerrado de motivos y de ref_type, notas
--     obligatorias en ajuste_manual/merma (mínimo 10 caracteres), datos completos
--     en una venta cancelada, simbología conocida en los códigos de barras, y
--     montos y cantidades no negativos. Los CHECKs son la razón por la que el
--     ledger del inventario se puede auditar.
--
--  ─── Convenciones (doc 02 §1) ──────────────────────────────────────────────
--    · snake_case, tablas en plural
--    · id uuid generado en el CLIENTE (uuidv7) → un dispositivo offline puede
--      crear filas sin pedirle IDs al servidor. Por eso las tablas no traen
--      DEFAULT en el id.
--    · Dinero en bigint de CENTAVOS, sufijo _minor. Nunca float.
--    · Cantidades en numeric(12,3) → permite media caja o 0,5 m sin error de
--      punto flotante.
--    · Tiempos timestamptz en UTC, sufijo _at.
--    · Borrado por `deleted_at` (soft delete).
--    · Las tablas de eventos no admiten UPDATE ni DELETE.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────── CATÁLOGO ─────────────────────────────

CREATE TABLE categories (
  id          uuid PRIMARY KEY,
  parent_id   uuid REFERENCES categories(id),      -- Papelería > Escritura > Plumas
  nombre      text NOT NULL,
  path        text NOT NULL,                       -- 'papeleria/escritura/plumas'
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
  nombre      text NOT NULL,        -- 'IVA 16%', 'Tasa 0%', 'Exento'
  tasa        numeric(6,4) NOT NULL,-- 0.1600
  deleted_at  timestamptz,
  CHECK (tasa >= 0 AND tasa <= 1)
);

CREATE TABLE units (
  id          uuid PRIMARY KEY,
  nombre      text NOT NULL UNIQUE,  -- 'pieza', 'paquete', 'caja', 'hoja', 'metro', 'hora'
  abreviatura text NOT NULL          -- 'pza', 'paq', 'cja'
);

CREATE TABLE products (
  id                 uuid PRIMARY KEY,
  sku                text UNIQUE,             -- código propio legible: 'PAP-LAP-MIR-2'
  nombre             text NOT NULL,
  descripcion        text,
  category_id        uuid REFERENCES categories(id),
  supplier_id        uuid REFERENCES suppliers(id),
  unit_id            uuid NOT NULL REFERENCES units(id),   -- unidad base de inventario
  tax_rate_id        uuid REFERENCES tax_rates(id),

  precio_minor       bigint NOT NULL,         -- precio de venta al público (IVA incluido)
  costo_minor        bigint NOT NULL DEFAULT 0,
  costo_promedio_minor bigint NOT NULL DEFAULT 0,          -- ver el trigger de PPA

  tracks_stock       boolean NOT NULL DEFAULT true,        -- false = fotocopias, servicios
  stock_minimo       numeric(12,3) NOT NULL DEFAULT 0,
  stock_maximo       numeric(12,3),
  ubicacion          text,                    -- 'A-3-12' (anaquel/charola) → va en la etiqueta

  permite_venta_fraccion boolean NOT NULL DEFAULT false,   -- ¿se vende media caja?
  is_activo          boolean NOT NULL DEFAULT true,
  imagen_url         text,
  notas              text,
  creado_at          timestamptz NOT NULL DEFAULT now(),
  actualizado_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CHECK (precio_minor >= 0),
  CHECK (costo_minor >= 0),
  CHECK (costo_promedio_minor >= 0),
  CHECK (nombre <> ''),
  CHECK (stock_minimo >= 0),
  CHECK (stock_maximo IS NULL OR stock_maximo >= stock_minimo)
);

CREATE INDEX idx_products_categoria ON products(category_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_activo    ON products(is_activo)   WHERE deleted_at IS NULL;
CREATE INDEX idx_products_ubicacion ON products(ubicacion)   WHERE deleted_at IS NULL;

-- Búsqueda por nombre sin depender de acentos, rápida y offline-friendly.
-- Se define aquí (no en 0005) a propósito: así esta tarea COMPRUEBA hoy que
-- to_tsvector('spanish') + GIN funcionan igual en PGlite y en Postgres. Si se
-- dejara para 0005, la incompatibilidad aparecería en la fase siguiente.
CREATE INDEX idx_products_busqueda ON products
  USING gin (to_tsvector('spanish', nombre || ' ' || coalesce(sku, '') || ' ' || coalesce(descripcion, '')));

-- ────────────────── PRESENTACIONES Y CÓDIGOS DE BARRAS ──────────────────
-- Un proveedor vende 1 caja = 12 paquetes = 144 piezas y el mostrador vende
-- piezas sueltas. Cada presentación necesita su propio código de barras.

CREATE TABLE product_presentations (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES products(id),
  unit_id       uuid NOT NULL REFERENCES units(id),   -- 'paquete', 'caja', 'pieza'
  nombre        text NOT NULL,          -- 'Paquete 12 pzas', 'Caja 144 pzas'
  factor        numeric(12,4) NOT NULL, -- unidades BASE que contiene: pieza=1, paquete=12, caja=144
  precio_minor  bigint NOT NULL,        -- precio de ESTA presentación
  is_base       boolean NOT NULL DEFAULT false,   -- exactamente una por producto, con factor = 1
  is_activo     boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, factor),
  CHECK (factor > 0),
  CHECK (precio_minor >= 0),
  CHECK (nombre <> '')
);

-- Un código de barras físico → una fila. Un producto puede tener varios: el de
-- fábrica, el propio pegado encima, la etiqueta de anaquel, el de la caja.
CREATE TABLE product_barcodes (
  id              uuid PRIMARY KEY,
  product_id      uuid NOT NULL REFERENCES products(id),
  presentacion_id uuid REFERENCES product_presentations(id),   -- null = unidad base
  codigo          text NOT NULL,
  simbologia      text NOT NULL,     -- 'ean13' | 'code128' | 'qr' | 'itf14' | 'upc_a'
  es_primario     boolean NOT NULL DEFAULT false,
  es_interno      boolean NOT NULL DEFAULT false,   -- generado por nosotros (doc 03)
  notas           text,
  creado_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT uq_barcode UNIQUE (codigo),   -- ⭐ GLOBAL: un código = un producto, siempre
  CHECK (codigo <> ''),
  CHECK (simbologia IN ('ean13', 'code128', 'qr', 'itf14', 'upc_a'))
);

CREATE INDEX idx_barcode_lookup ON product_barcodes(codigo) WHERE deleted_at IS NULL;
CREATE INDEX idx_barcode_producto ON product_barcodes(product_id) WHERE deleted_at IS NULL;

-- ───────────────── USUARIOS, DISPOSITIVOS Y SESIONES ─────────────────

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  nombre           text NOT NULL,
  email            text,
  password_hash    text,          -- argon2id; null si usa solo passkey
  pin_hash         text,          -- argon2id del PIN de 6 dígitos (paso 2 para acciones sensibles)
  totp_secret      text,          -- 2FA opcional
  is_activo        boolean NOT NULL DEFAULT true,
  ultimo_acceso_at timestamptz,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK (username <> '')
);

CREATE TABLE webauthn_credentials (      -- passkeys (doc 07)
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  nombre        text,                    -- 'Celular del dueño', 'Windows Hello del mostrador'
  creado_at     timestamptz NOT NULL DEFAULT now(),
  ultimo_uso_at timestamptz
);

CREATE TABLE devices (
  id              uuid PRIMARY KEY,
  user_id         uuid REFERENCES users(id),
  nombre          text NOT NULL,     -- 'PC caja 1', 'Celular Samsung A54'
  tipo            text NOT NULL,     -- 'terminal' | 'scanner' | 'server'
  huella          text,              -- hash del fingerprint (contexto, no identidad)
  is_trusted      boolean NOT NULL DEFAULT false,
  pairing_code    text,              -- código de emparejamiento, uso único
  paired_at       timestamptz,
  ultimo_visto_at timestamptz,
  revoked_at      timestamptz,       -- ⭐ revocación inmediata si roban el celular
  creado_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo IN ('terminal', 'scanner', 'server')),
  CHECK (nombre <> '')
);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id),
  device_id           uuid NOT NULL REFERENCES devices(id),
  refresh_token_hash  text NOT NULL,   -- SHA-256 del refresh. NUNCA el token en claro
  familia_id          uuid NOT NULL,   -- agrupa la cadena de rotaciones → detecta reuso
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,   -- p. ej. +30 min (caja), +30 días (panel)
  absolute_expires_at timestamptz NOT NULL,   -- tope duro: +12 h (caja), +90 días (admin)
  rotado_at           timestamptz,            -- cuándo se canjeó este refresh (doc 07 §2.2)
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent          text,
  CHECK (absolute_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX idx_sessions_user   ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_family ON sessions(familia_id);

-- ──────────────── LEDGER DE MOVIMIENTOS (el corazón del modelo) ────────────────
--
-- El stock NO se edita. Cada cambio es una fila inmutable. Eso responde quién,
-- cuándo y por qué; evita los conflictos entre dispositivos offline (dos restas
-- simultáneas no dependen del orden); y permite reconstruir el inventario de un
-- día pasado. El saldo vive en stock_levels, siempre DERIVADO de aquí.

CREATE TABLE stock_movements (
  id                   uuid PRIMARY KEY,
  product_id           uuid NOT NULL REFERENCES products(id),
  presentacion_id      uuid REFERENCES product_presentations(id),  -- null = unidad base
  qty                  numeric(12,3) NOT NULL,   -- + entrada, − salida. NUNCA 0
  qty_base             numeric(12,3) NOT NULL,   -- qty × factor, en unidad base

  motivo               text NOT NULL,            -- catálogo cerrado, ver CHECK
  ref_type             text,                     -- 'sale' | 'purchase' | 'count' | 'return' | 'loss'
  ref_id               uuid,                     -- id de la venta, compra, conteo…
  ubicacion_destino    text,

  costo_unitario_minor bigint NOT NULL DEFAULT 0,  -- costo de ESTE movimiento
  notas                text,
  user_id              uuid NOT NULL REFERENCES users(id),
  device_id            uuid NOT NULL REFERENCES devices(id),
  ocurrido_at          timestamptz NOT NULL,       -- reloj del dispositivo (doc 08)
  registrado_at        timestamptz NOT NULL DEFAULT now(),  -- reloj del servidor

  CHECK (qty <> 0),
  CHECK (costo_unitario_minor >= 0),

  -- Catálogo cerrado de motivos (doc 02 §4.1). Con texto libre, "venta " con un
  -- espacio al final se convierte en un motivo nuevo y los reportes dejan de
  -- cuadrar sin que nadie lo note. La base lo rechaza al instante.
  CHECK (motivo IN (
    'venta', 'devolucion_cliente', 'compra_recepcion', 'compra_cancelada',
    'ajuste_manual', 'merma', 'conteo_fisico',
    'traspaso_salida', 'traspaso_entrada',
    'consumo_interno', 'muestra_cortesia', 'error_captura'
  )),

  CHECK (ref_type IS NULL OR ref_type IN ('sale', 'purchase', 'count', 'return', 'loss')),

  -- ⭐ REGLA DURA del doc 02 §4.1: 'ajuste_manual' y 'merma' EXIGEN notas de al
  --    menos 10 caracteres. Sin esto, "ajuste manual" es el agujero por donde se
  --    va el inventario y nadie se entera. Es una regla de negocio real, así que
  --    se hace cumplir en la base y no solo en la interfaz.
  CONSTRAINT ck_ajuste_exige_motivo CHECK (
    motivo NOT IN ('ajuste_manual', 'merma')
    OR (notas IS NOT NULL AND length(btrim(notas)) >= 10)
  )
);

CREATE INDEX idx_mov_producto_fecha ON stock_movements(product_id, ocurrido_at DESC);
CREATE INDEX idx_mov_ref            ON stock_movements(ref_type, ref_id);
CREATE INDEX idx_mov_fecha          ON stock_movements(ocurrido_at DESC);
CREATE INDEX idx_mov_motivo         ON stock_movements(motivo, ocurrido_at DESC);

CREATE TABLE stock_levels (
  product_id      uuid PRIMARY KEY REFERENCES products(id),
  qty_base        numeric(12,3) NOT NULL DEFAULT 0,
  actualizado_at  timestamptz NOT NULL DEFAULT now()
);

-- Saldo cacheado, siempre derivado del ledger. Un SUM() sobre 5 000 movimientos
-- funciona; sobre 500 000 se muere. La caché lo resuelve sin perder la facultad
-- de reconciliar: ver la consulta de integridad en el doc 02 §4.2.
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

-- ⚠️ Sólo INSERT: el ledger es inmutable. No se pone trigger de UPDATE ni DELETE
--    porque esos casos no deben existir.
CREATE TRIGGER trg_aplicar_movimiento
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION aplicar_movimiento();

-- ─────────────────────────── VENTAS Y PAGOS ───────────────────────────

CREATE TABLE cash_sessions (            -- "turno" de caja: apertura → cierre → arqueo
  id                       uuid PRIMARY KEY,
  terminal_id              uuid NOT NULL REFERENCES devices(id),
  user_id                  uuid NOT NULL REFERENCES users(id),
  abierta_at               timestamptz NOT NULL,
  cerrada_at               timestamptz,
  fondo_inicial_minor      bigint NOT NULL DEFAULT 0,  -- el cambio con el que abre
  esperado_efectivo_minor  bigint,                     -- calculado al cerrar
  contado_efectivo_minor   bigint,                     -- lo que el dueño contó a mano
  diferencia_minor         bigint GENERATED ALWAYS AS
                             (coalesce(contado_efectivo_minor, 0)
                              - coalesce(esperado_efectivo_minor, 0)) STORED,
  notas_cierre             text,
  CHECK (cerrada_at IS NULL OR cerrada_at > abierta_at),
  CHECK (fondo_inicial_minor >= 0)
);

CREATE INDEX idx_cash_abierta ON cash_sessions(abierta_at DESC);
CREATE INDEX idx_cash_terminal ON cash_sessions(terminal_id, abierta_at DESC);

CREATE TABLE sales (
  id                 uuid PRIMARY KEY,
  -- Consecutivo GLOBAL. Lo asigna el SERVIDOR: un dispositivo offline no puede
  -- generarlo sin coordinarse con los demás. Para el cliente, el folio visible es
  -- folio_local (doc 08 §6).
  folio              bigint GENERATED ALWAYS AS IDENTITY,
  folio_local        text NOT NULL,     -- 'C1-000123', generado OFFLINE por terminal
  cash_session_id    uuid NOT NULL REFERENCES cash_sessions(id),
  terminal_id        uuid NOT NULL REFERENCES devices(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  cliente_nombre     text,              -- opcional: ventas a crédito o factura
  cliente_id         uuid,

  subtotal_minor     bigint NOT NULL,   -- suma de líneas, antes de descuentos globales
  descuento_minor    bigint NOT NULL DEFAULT 0,
  impuesto_minor     bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL,

  estado             text NOT NULL,     -- ver CHECK
  cancelada_at       timestamptz,
  cancelada_por      uuid REFERENCES users(id),
  motivo_cancelacion text,
  ticket_impreso     boolean NOT NULL DEFAULT false,

  idempotency_key    text NOT NULL UNIQUE,  -- ⭐ evita ventas duplicadas al reintentar
  device_id          uuid NOT NULL REFERENCES devices(id),
  evento_id          text NOT NULL,         -- ULID del evento que la originó
  ocurrido_at        timestamptz NOT NULL,  -- reloj del dispositivo
  registrado_at      timestamptz NOT NULL DEFAULT now(),
  notas              text,

  UNIQUE (terminal_id, folio_local),        -- un folio local no se repite en su terminal

  CHECK (estado IN ('completada', 'cancelada', 'devuelta_parcial', 'devuelta_total')),
  CHECK (total_minor >= 0),
  CHECK (subtotal_minor >= 0),
  CHECK (descuento_minor >= 0),
  CHECK (impuesto_minor >= 0),
  -- Una venta cancelada tiene que decir cuándo, quién y por qué. Nunca se borra
  -- una venta: se cancela, y eso es lo que hace auditable un arqueo.
  CONSTRAINT ck_cancelada_completa CHECK (
    estado <> 'cancelada'
    OR (cancelada_at IS NOT NULL AND cancelada_por IS NOT NULL
        AND motivo_cancelacion IS NOT NULL AND btrim(motivo_cancelacion) <> '')
  )
);

CREATE INDEX idx_sales_fecha  ON sales(ocurrido_at DESC);
CREATE INDEX idx_sales_turno  ON sales(cash_session_id);
CREATE INDEX idx_sales_estado ON sales(estado);

CREATE TABLE sale_lines (
  id                   uuid PRIMARY KEY,
  sale_id              uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  linea_no             int  NOT NULL,
  product_id           uuid NOT NULL REFERENCES products(id),
  presentacion_id      uuid REFERENCES product_presentations(id),
  -- Snapshots deliberados: si mañana cambias el nombre o el precio, el ticket de
  -- ayer y el margen de ayer NO deben cambiar. Copiar el dato es la única forma.
  descripcion          text NOT NULL,
  qty                  numeric(12,3) NOT NULL,
  qty_base             numeric(12,3) NOT NULL,
  precio_unitario_minor bigint NOT NULL,
  descuento_minor      bigint NOT NULL DEFAULT 0,
  impuesto_minor       bigint NOT NULL DEFAULT 0,
  total_linea_minor    bigint NOT NULL,
  costo_unitario_minor bigint NOT NULL DEFAULT 0,   -- costo del momento de la venta
  tax_rate_id          uuid REFERENCES tax_rates(id),
  es_venta_libre       boolean NOT NULL DEFAULT false,  -- fotocopias: texto libre, sin producto
  UNIQUE (sale_id, linea_no),
  CHECK (qty > 0),
  CHECK (linea_no > 0),
  CHECK (precio_unitario_minor >= 0),
  CHECK (descuento_minor >= 0),
  CHECK (total_linea_minor >= 0),
  CHECK (descripcion <> '')
);

CREATE INDEX idx_lineas_venta     ON sale_lines(sale_id);
CREATE INDEX idx_lineas_producto  ON sale_lines(product_id);

CREATE TABLE payments (
  id             uuid PRIMARY KEY,
  sale_id        uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  metodo         text NOT NULL,
  monto_minor    bigint NOT NULL,
  cambio_minor   bigint NOT NULL DEFAULT 0,   -- sólo efectivo
  referencia     text,    -- últimos 4 dígitos, folio de transferencia, autorización
  ocurrido_at    timestamptz NOT NULL,
  -- ⚠️ NUNCA: numero_tarjeta, cvv, banda. Fuera de alcance PCI (doc 07 §8).
  CHECK (metodo IN ('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'vale', 'credito')),
  CHECK (monto_minor > 0),
  CHECK (cambio_minor >= 0)
);
-- Venta mixta ($100 efectivo + $50 tarjeta) → 2 filas. Soportado por diseño.
CREATE INDEX idx_payments_venta ON payments(sale_id);
CREATE INDEX idx_payments_metodo ON payments(metodo, ocurrido_at DESC);

CREATE TABLE returns (             -- devoluciones
  id                   uuid PRIMARY KEY,
  sale_id              uuid NOT NULL REFERENCES sales(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  motivo               text NOT NULL,
  reingresa_stock      boolean NOT NULL DEFAULT true,
  total_devuelto_minor bigint NOT NULL,
  ocurrido_at          timestamptz NOT NULL,
  registrado_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (total_devuelto_minor >= 0),
  CHECK (btrim(motivo) <> '')
);

CREATE TABLE return_lines (
  id                   uuid PRIMARY KEY,
  return_id            uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_line_id         uuid NOT NULL REFERENCES sale_lines(id),
  qty                  numeric(12,3) NOT NULL,
  monto_devuelto_minor bigint NOT NULL,
  CHECK (qty > 0),
  CHECK (monto_devuelto_minor >= 0)
);

CREATE INDEX idx_return_lines_devolucion ON return_lines(return_id);

-- ────────────────────── CONTEO FÍSICO (INVENTARIO) ──────────────────────

CREATE TABLE inventory_counts (
  id           uuid PRIMARY KEY,
  nombre       text NOT NULL,        -- 'Conteo octubre 2026'
  estado       text NOT NULL,
  alcance      text NOT NULL,
  filtro       jsonb,                -- { "categoria_id": "..." } o { "ubicacion": "A-3" }
  iniciado_por uuid NOT NULL REFERENCES users(id),
  iniciado_at  timestamptz NOT NULL,
  cerrado_at   timestamptz,
  aplicado_at  timestamptz,
  CHECK (estado IN ('abierto', 'cerrado', 'aplicado')),
  CHECK (alcance IN ('total', 'categoria', 'anaquel')),
  CHECK (cerrado_at IS NULL OR cerrado_at >= iniciado_at),
  CHECK (aplicado_at IS NULL OR aplicado_at >= iniciado_at)
);

CREATE TABLE inventory_count_lines (
  id           uuid PRIMARY KEY,
  count_id     uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  qty_sistema  numeric(12,3) NOT NULL,   -- foto del stock al abrir el conteo
  qty_contada  numeric(12,3),            -- null = todavía sin contar
  diferencia   numeric(12,3) GENERATED ALWAYS AS (qty_contada - qty_sistema) STORED,
  contada_at   timestamptz,
  contada_por  uuid REFERENCES users(id),
  notas        text,
  UNIQUE (count_id, product_id),
  CHECK (qty_sistema >= 0),
  CHECK (qty_contada IS NULL OR qty_contada >= 0)
);

-- ────────────────────── SINCRONIZACIÓN Y AUDITORÍA ──────────────────────

CREATE TABLE event_log (
  server_seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ⭐ cursor global de lectura
  event_id       text NOT NULL UNIQUE,       -- ULID generado por el dispositivo
  device_id      uuid NOT NULL,
  device_seq     bigint NOT NULL,
  user_id        uuid REFERENCES users(id),
  type           text NOT NULL,              -- 'sale.created', 'product.updated', ...
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL,       -- reloj del dispositivo
  received_at    timestamptz NOT NULL DEFAULT now(),
  hlc            text NOT NULL,              -- reloj lógico híbrido (doc 08 §5)
  schema_version int NOT NULL DEFAULT 1,
  UNIQUE (device_id, device_seq)
);

CREATE INDEX idx_event_seq  ON event_log(server_seq);
CREATE INDEX idx_event_tipo ON event_log(type, received_at DESC);

CREATE TABLE sync_cursors (              -- qué ha visto cada dispositivo
  device_id      uuid PRIMARY KEY,
  last_pull_seq  bigint NOT NULL DEFAULT 0,
  last_push_at   timestamptz,
  ultimo_error   text,
  CHECK (last_pull_seq >= 0)
);

-- El outbox vive en el DISPOSITIVO, no en el servidor: es la cola de eventos
-- pendientes de enviar. La misma migración sirve para los dos.
CREATE TABLE outbox (
  id                uuid PRIMARY KEY,
  event_id          text NOT NULL UNIQUE,
  payload           jsonb NOT NULL,
  intentos          int NOT NULL DEFAULT 0,
  ultimo_intento_at timestamptz,
  ultimo_error      text,
  creado_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (intentos >= 0)
);

-- audit_log y event_log parecen duplicados y no lo son: event_log es mecánica de
-- sincronización (se puede purgar al compactar); audit_log es historia del
-- negocio, se conserva siempre y nunca se sincroniza entre dispositivos.
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY,
  user_id     uuid REFERENCES users(id),
  device_id   uuid REFERENCES devices(id),
  accion      text NOT NULL,     -- 'precio.cambiado', 'sesion.step_up', 'ajuste.manual'
  entidad     text,              -- 'products'
  entidad_id  uuid,
  antes       jsonb,
  despues     jsonb,
  ip          inet,
  ocurrido_at timestamptz NOT NULL,
  CHECK (accion <> '')
);

CREATE INDEX idx_audit_fecha   ON audit_log(ocurrido_at DESC);
CREATE INDEX idx_audit_entidad ON audit_log(entidad, entidad_id);

-- ─────────────────────────── CONFIGURACIÓN ───────────────────────────

CREATE TABLE settings (
  clave          text PRIMARY KEY,
  valor          jsonb NOT NULL,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CHECK (clave <> '')
);
