-- ═══════════════════════════════════════════════════════════════════════════
--  0002_rbac_abac.sql — Roles, permisos y políticas (doc 06)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Estructura de autorización. Igual en PGlite y en PostgreSQL 16.
--
--  ─── DOS BUGS DEL DOCUMENTO 06 QUE ESTA MIGRACIÓN DESTAPA ──────────────────
--
--  1. `CREATE INDEX ... WHERE expira_at > now()` (doc 06 §6, línea 451) es
--     SQL INVÁLIDO en Postgres y en PGlite. Los predicados de un índice parcial
--     exigen funciones IMMUTABLE, y `now()` es STABLE (cambia en cada
--     transacción). El motor lo rechaza con:
--         ERROR: functions in index predicate must be marked IMMUTABLE
--     Se corrige aquí sin perder el propósito: el índice sirve para responder
--     "¿tiene step-up vigente este usuario?" y eso se resuelve con
--     (user_id, expira_at), que sí es indexable. La comparación contra el reloj
--     ocurre en la consulta, no en el índice.
--
--  2. Los roles se siembran con `uuidv7()` (doc 06 §3.4, líneas 167-170).
--     `uuidv7()` NO EXISTE: ni en PostgreSQL 16 (llegó en la 18) ni en PGlite.
--     Pero aquí el problema no es que falte esa función, sino que usarla sería
--     un ERROR DE DISEÑO aunque existiera:
--
--       Los roles, unidades, tasas de impuesto y categorías son DATOS DE
--       REFERENCIA COMPARTIDOS. Si cada dispositivo genera sus propios IDs
--       aleatorios al crear su base local, el mismo concepto ('dueno', 'pieza',
--       'IVA 16%') termina con un UUID distinto en el PC y en el celular. Al
--       sincronizar, el servidor ve dos filas que no puede reconciliar: dos
--       roles 'dueno', dos unidades 'pieza'. El conflicto es invisible hasta que
--       los reportes se parten en dos.
--
--     Por eso los datos de referencia llevan UUID FIJO Y LITERAL en la migración.
--     El UUID de 'dueno' es el mismo en todos los dispositivos, siempre. Esto no
--     contradice la convención "el cliente genera los UUID": esa convención es
--     para los datos que el negocio crea (ventas, productos), no para el catálogo
--     que el sistema define.
--
--     Los literales siguen un patrón legible:
--        01900000-0000-7000-<familia>-<consecutivo>
--     donde el 4.º grupo dice de qué tabla es el dato:
--        8000 roles · 8001 permisos · 8002 unidades · 8003 tasas · 8004 categorías
--     Es un UUID v7 válido (versión 7, variante RFC 4122) y se lee de un vistazo.
--
--  ─── UNA DECISIÓN DE ALCANCE, EXPLÍCITA ────────────────────────────────────
--
--  Esta migración crea la tabla `policies` pero NO siembra las 31 reglas del
--  doc 06 §5. La razón: la gramática de `condicion` que esas reglas necesitan NO
--  está especificada en los documentos. El doc 06 §4 solo muestra tres formas
--  (`and`, `gt`, `eq`) y todas comparan un campo del contexto contra un valor
--  literal; pero la primera regla de la lista, P1 ("precio nuevo menor al
--  costo"), necesita comparar DOS CAMPOS del contexto entre sí
--  (`recurso.precio_nuevo_minor` < `recurso.costo_minor`) y eso la gramática
--  publicada no lo cubre. Lo mismo pasa con P7, P13, P15 y P19.
--
--  Definir esa gramática dentro de una migración significaría diseñar la interfaz
--  del evaluador desde el SQL, y sin el evaluador no habría forma de probar que
--  las 31 reglas hacen lo que dicen. Sembrar reglas de SEGURIDAD que nadie puede
--  verificar es peor que no sembrarlas: da la falsa impresión de que el sistema
--  está configurado. Se siembran en la tarea 0.6, junto con `evaluar()` y la
--  tabla de tests del doc 06 §9, que es la que prueba regla por regla.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────── RBAC: TABLAS ────────────────────────────

CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  clave       text NOT NULL UNIQUE,      -- 'dueno' | 'cajero' | 'bodega' | 'auditor'
  nombre      text NOT NULL,             -- 'Dueño', 'Cajero', 'Bodega', 'Auditor'
  descripcion text,
  is_sistema  boolean NOT NULL DEFAULT false,   -- los de sistema no se pueden borrar
  nivel       int NOT NULL DEFAULT 0,           -- mayor = más privilegios
  deleted_at  timestamptz,
  CHECK (clave <> ''),
  CHECK (nombre <> '')
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY,
  clave       text NOT NULL UNIQUE,      -- 'ventas:crear', 'precios:editar', ...
  recurso     text NOT NULL,             -- 'ventas'
  accion      text NOT NULL,             -- 'crear' | 'leer' | 'editar' | 'borrar' | 'exportar'
  descripcion text,
  es_sensible boolean NOT NULL DEFAULT false,   -- ⭐ requiere step-up por defecto
  -- La clave SIEMPRE es `recurso:accion`. Se hace cumplir en la base para que
  -- nadie cree un permiso 'puedeEditarPrecios' que rompa el mapeo automático a
  -- endpoints y pantallas (doc 06 §3.2 y §8).
  CONSTRAINT ck_permiso_formato CHECK (clave = recurso || ':' || accion),
  CHECK (recurso <> ''),
  CHECK (accion <> '')
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  asignado_por uuid REFERENCES users(id),
  asignado_at  timestamptz NOT NULL DEFAULT now(),
  expira_at    timestamptz,               -- ⭐ rol temporal: empleado de temporada
  PRIMARY KEY (user_id, role_id)
);

-- `expira_at` resuelve la temporada escolar: rol 'cajero' con expira_at del 31 de
-- agosto y se revoca solo. No dependes de acordarte de quitárselo.
CREATE INDEX idx_user_roles_vigentes ON user_roles(user_id, expira_at);

-- ──────────────────── ABAC: POLÍTICAS COMO DATOS ────────────────────
--
-- RBAC dice "el cajero puede vender". ABAC dice bajo qué condiciones. Las
-- políticas viven en la base LOCAL de cada dispositivo y se evalúan allí, porque
-- offline no hay servidor a quien preguntar (doc 06 §5.4). Son datos puros,
-- versionados y firmados, nunca if/else en el código.

CREATE TABLE policies (
  -- ⭐ El id es un SLUG de texto, no un uuid: 'P10-descuento-alto'.
  --    Es una desviación deliberada de la convención de uuids, y coincide con el
  --    tipo `Politica` del doc 06 §5. Las políticas se citan en el audit_log
  --    ("política P10") y en las discusiones de negocio; un uuid ahí es
  --    ilegible. Además son pocas, estables y las escribe una sola persona.
  id            text PRIMARY KEY,
  version       int NOT NULL DEFAULT 1,
  prioridad     int NOT NULL DEFAULT 100,   -- menor = se evalúa primero
  efecto        text NOT NULL,              -- 'permitir' | 'denegar'
  aplica_a      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "permiso": "ventas:crear" }
  condicion     jsonb NOT NULL,             -- árbol serializable (doc 06 §4)
  obligaciones  text[] NOT NULL DEFAULT '{}'::text[],
  motivo        text NOT NULL,              -- explicación legible, se muestra al usuario
  activa        boolean NOT NULL DEFAULT true,
  es_sistema    boolean NOT NULL DEFAULT false,
  creado_at     timestamptz NOT NULL DEFAULT now(),
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,

  CHECK (efecto IN ('permitir', 'denegar')),
  CHECK (version >= 1),
  CHECK (motivo <> ''),
  CHECK (id <> ''),
  -- La condición es un objeto con un `op`. Valida la forma gruesa; la semántica
  -- de cada operador la define el evaluador (tarea 0.6) y la prueban sus tests.
  CHECK (jsonb_typeof(condicion) = 'object' AND condicion ? 'op'),
  -- Catálogo cerrado de obligaciones. Si alguien escribe 'stepup' en vez de
  -- 'step_up', la obligación no se cumple NUNCA y la regla deja de proteger en
  -- silencio. Mejor que la base lo rechace.
  CONSTRAINT ck_obligaciones_conocidas CHECK (
    obligaciones <@ ARRAY['step_up', 'motivo_obligatorio',
                          'notificar_dueno', 'marcar_para_revision']::text[]
  )
);

CREATE INDEX idx_policies_aplicables ON policies(prioridad)
  WHERE activa AND deleted_at IS NULL;

-- Sincronización firmada de políticas (doc 06 §7).
--
-- Las políticas se replican con el resto del catálogo, pero por una vía distinta:
-- cada conjunto se publica como un PAQUETE firmado con la clave privada del
-- servidor, y el cliente verifica la firma con la pública. Esto cierra el ataque
-- más insidioso del modelo local-first: la base local del PC es un archivo en
-- disco, y sin firma basta con editarla para subir el límite de descuento.
--
-- Si la firma no verifica, el cliente NO degrada a "permitir todo": sigue usando
-- la última versión válida y marca el sistema para revisión (doc 06 §7).
CREATE TABLE policy_bundles (
  version     int PRIMARY KEY,             -- monótona creciente
  emitido_at  timestamptz NOT NULL,
  firmado_por text NOT NULL,               -- huella de la clave pública que firmó
  firma       text NOT NULL,               -- Ed25519 sobre el JSON canónico
  contenido   jsonb NOT NULL,              -- el paquete completo, con su hash
  aplicado_at timestamptz,                 -- cuándo lo adoptó este dispositivo
  CHECK (version >= 1),
  CHECK (firma <> '')
);

-- ─────────────────────── STEP-UP AUTHENTICATION ───────────────────────
--
-- Sin esto, ABAC se vuelve "pide la contraseña cada 30 segundos" y se desactiva
-- el primer día (doc 06 §6). El step-up es una autorización acotada: atada a la
-- acción y al objeto, válida 5 minutos.

CREATE TABLE step_up_grants (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  session_id        uuid NOT NULL REFERENCES sessions(id),
  metodo            text NOT NULL,        -- 'pin' | 'passkey' | 'totp'
  motivo            text NOT NULL,        -- qué acción lo disparó: 'ventas:cancelar'
  entidad_id        uuid,                 -- la venta/producto concreto
  otorgado_at       timestamptz NOT NULL DEFAULT now(),
  expira_at         timestamptz NOT NULL, -- +5 minutos
  intentos_fallidos int NOT NULL DEFAULT 0,
  ip                inet,
  device_id         uuid REFERENCES devices(id),
  CHECK (metodo IN ('pin', 'passkey', 'totp')),
  CHECK (motivo <> ''),
  CHECK (expira_at > otorgado_at),
  CHECK (intentos_fallidos >= 0)
);

-- ⚠️ Corregido respecto del doc 06 §6 (línea 451): el predicado original era
--    `WHERE expira_at > now()`, que Postgres RECHAZA porque now() no es IMMUTABLE.
--    Aquí el índice sirve igual: la consulta pide por (user_id, expira_at) y
--    compara contra el reloj en el WHERE.
CREATE INDEX idx_stepup_vigente ON step_up_grants(user_id, expira_at DESC);
CREATE INDEX idx_stepup_sesion  ON step_up_grants(session_id);

-- ═════════════════════════ SEEDS ═════════════════════════
-- UUIDs fijos y literales. Ver el encabezado: el mismo 'dueno' en todos los
-- dispositivos es lo que evita que la sincronización duplique el catálogo.

-- ── Los 4 roles, sembrados desde el día 1 (doc 06 §3.4) ──
-- Hoy solo se usa uno. Un rol sin usuarios no cuesta nada y estar listo en julio
-- vale todo.
INSERT INTO roles (id, clave, nombre, descripcion, is_sistema, nivel) VALUES
  ('01900000-0000-7000-8000-000000000001', 'dueno',   'Dueño',   'Acceso total. Único rol que edita políticas y usuarios.', true, 100),
  ('01900000-0000-7000-8000-000000000002', 'cajero',  'Cajero',  'Vende y cobra. No ve costos ni márgenes.',                 true, 20),
  ('01900000-0000-7000-8000-000000000003', 'bodega',  'Bodega',  'Inventario, conteos, etiquetas. No vende ni ve precios.',   true, 20),
  ('01900000-0000-7000-8000-000000000004', 'auditor', 'Auditor', 'Solo lectura de reportes y auditoría.',                     true, 10);

-- ── El catálogo de permisos (doc 06 §3.3) ──
-- `es_sensible = true` significa "exige step-up por defecto". Se marca donde el
-- doc 06 §5 exige step-up, y NO se marca donde la regla dice que no debe pedirse
-- (P22: revocar un dispositivo siempre se permite — cortar acceso en una
-- emergencia no puede depender de un PIN).
INSERT INTO permissions (id, clave, recurso, accion, descripcion, es_sensible) VALUES
  -- ventas
  ('01900000-0000-7000-8001-000000000001', 'ventas:crear',         'ventas', 'crear',         'Cobrar una venta',                          false),
  ('01900000-0000-7000-8001-000000000002', 'ventas:leer',          'ventas', 'leer',          'Consultar ventas',                          false),
  ('01900000-0000-7000-8001-000000000003', 'ventas:cancelar',      'ventas', 'cancelar',      'Cancelar una venta ya cobrada (P8)',        true),
  ('01900000-0000-7000-8001-000000000004', 'ventas:devolver',      'ventas', 'devolver',      'Devolver una venta, con o sin ticket (P9)', true),
  -- turnos
  ('01900000-0000-7000-8001-000000000005', 'turnos:abrir',         'turnos', 'abrir',         'Abrir caja con fondo inicial',              false),
  ('01900000-0000-7000-8001-000000000006', 'turnos:cerrar',        'turnos', 'cerrar',        'Cerrar caja y registrar el arqueo (P17)',   false),
  ('01900000-0000-7000-8001-000000000007', 'turnos:leer',          'turnos', 'leer',          'Consultar turnos y arqueos',                false),
  ('01900000-0000-7000-8001-000000000008', 'turnos:retiros',       'turnos', 'retiros',       'Sacar efectivo del cajón (P14, P15)',        true),
  -- productos
  ('01900000-0000-7000-8001-000000000009', 'productos:crear',      'productos', 'crear',      'Dar de alta un producto',                   false),
  ('01900000-0000-7000-8001-000000000010', 'productos:leer',       'productos', 'leer',       'Consultar el catálogo',                     false),
  ('01900000-0000-7000-8001-000000000011', 'productos:editar',     'productos', 'editar',     'Editar un producto',                        false),
  ('01900000-0000-7000-8001-000000000012', 'productos:borrar',     'productos', 'borrar',     'Dar de baja un producto (soft delete)',     false),
  -- precios
  ('01900000-0000-7000-8001-000000000013', 'precios:editar',       'precios', 'editar',        'Cambiar precios de venta (P1–P4, P29)',   true),
  ('01900000-0000-7000-8001-000000000014', 'precios:ver_costos',   'precios', 'ver_costos',    'Ver costo y margen. El cajero NO lo tiene', false),
  ('01900000-0000-7000-8001-000000000015', 'precios:aplicar_masivo','precios','aplicar_masivo','Cambiar el precio de muchos productos (P4)', true),
  -- stock
  ('01900000-0000-7000-8001-000000000016', 'stock:leer',           'stock', 'leer',          'Consultar existencias',                     false),
  ('01900000-0000-7000-8001-000000000017', 'stock:ajustar',        'stock', 'ajustar',       'Ajustar stock a mano (P5, P6)',              true),
  ('01900000-0000-7000-8001-000000000018', 'stock:conteo',         'stock', 'conteo',        'Hacer un conteo físico (P7)',                true),
  ('01900000-0000-7000-8001-000000000019', 'stock:traspaso',       'stock', 'traspaso',      'Mover stock entre ubicaciones',             false),
  -- etiquetas
  ('01900000-0000-7000-8001-000000000020', 'etiquetas:generar',    'etiquetas', 'generar',   'Generar códigos de barras internos',        false),
  ('01900000-0000-7000-8001-000000000021', 'etiquetas:imprimir',   'etiquetas', 'imprimir',  'Imprimir etiquetas y tickets',              false),
  ('01900000-0000-7000-8001-000000000022', 'etiquetas:calibrar',   'etiquetas', 'calibrar',  'Calibrar la impresora de etiquetas',        false),
  -- catalogos
  ('01900000-0000-7000-8001-000000000023', 'catalogos:leer',       'catalogos', 'leer',        'Consultar categorías, proveedores, unidades e impuestos', false),
  ('01900000-0000-7000-8001-000000000024', 'catalogos:categorias', 'catalogos', 'categorias',  'Crear y editar categorías',                 false),
  ('01900000-0000-7000-8001-000000000025', 'catalogos:proveedores','catalogos', 'proveedores', 'Crear y editar proveedores',                false),
  ('01900000-0000-7000-8001-000000000026', 'catalogos:unidades',   'catalogos', 'unidades',    'Crear y editar unidades de medida',         false),
  ('01900000-0000-7000-8001-000000000027', 'catalogos:impuestos',  'catalogos', 'impuestos',   'Crear y editar tasas de impuesto',          false),
  -- reportes
  ('01900000-0000-7000-8001-000000000028', 'reportes:ventas',      'reportes', 'ventas',       'Reporte de ventas del negocio',            false),
  ('01900000-0000-7000-8001-000000000029', 'reportes:margen',      'reportes', 'margen',       'Reporte de margen y utilidad',             false),
  ('01900000-0000-7000-8001-000000000030', 'reportes:inventario',  'reportes', 'inventario',   'Reporte de inventario y valoración',       false),
  ('01900000-0000-7000-8001-000000000031', 'reportes:exportar',    'reportes', 'exportar',     'Exportar catálogo o ventas (P18)',           true),
  -- usuarios
  ('01900000-0000-7000-8001-000000000032', 'usuarios:crear',       'usuarios', 'crear',        'Crear usuarios (P21)',                       true),
  ('01900000-0000-7000-8001-000000000033', 'usuarios:editar',      'usuarios', 'editar',       'Editar usuarios (P21)',                      true),
  ('01900000-0000-7000-8001-000000000034', 'usuarios:roles',       'usuarios', 'roles',        'Asignar y quitar roles (P21)',               true),
  ('01900000-0000-7000-8001-000000000035', 'usuarios:revocar',     'usuarios', 'revocar',      'Revocar el acceso de un usuario',            true),
  -- policies
  ('01900000-0000-7000-8001-000000000036', 'policies:leer',        'policies', 'leer',         'Consultar las políticas vigentes',          false),
  ('01900000-0000-7000-8001-000000000037', 'policies:editar',      'policies', 'editar',       'Editar las reglas. Solo el dueño (P21)',     true),
  ('01900000-0000-7000-8001-000000000038', 'policies:publicar',    'policies', 'publicar',     'Publicar un paquete de políticas firmado',   true),
  -- dispositivos
  ('01900000-0000-7000-8001-000000000039', 'dispositivos:emparejar','dispositivos', 'emparejar','Emparejar un celular o escáner (P19)',       true),
  ('01900000-0000-7000-8001-000000000040', 'dispositivos:revocar', 'dispositivos', 'revocar',  'Revocar un dispositivo. NUNCA pide PIN (P22)', false),
  -- config
  ('01900000-0000-7000-8001-000000000041', 'config:leer',          'config', 'leer',           'Consultar la configuración del negocio',    false),
  ('01900000-0000-7000-8001-000000000042', 'config:editar',        'config', 'editar',         'Editar la configuración del negocio',        true),
  ('01900000-0000-7000-8001-000000000043', 'config:respaldos',     'config', 'respaldos',      'Crear, restaurar y exportar respaldos',      true),
  -- auditoria
  ('01900000-0000-7000-8001-000000000044', 'auditoria:leer',       'auditoria', 'leer',        'Consultar el registro de auditoría (P23)',  false);

-- ── Qué puede cada rol (doc 06 §3.3) ──
--
-- Se mapea por `clave`, no por uuid: es legible y no se rompe si algún día cambia
-- un id. El JOIN descarta en silencio cualquier permiso mal escrito, así que el
-- test de la migración COMPRUEBA el conteo exacto de filas insertadas.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  -- Dueño: los 44 permisos. Se expresa como "todo" y no como una lista de 44
  -- líneas que alguien va a olvidar actualizar cuando agregue un permiso nuevo.
  ('dueno', '*'),

  -- Cajero: vende y cobra. No ve costos (precios:ver_costos), ni reportes del
  -- negocio, ni usuarios, ni políticas, ni configuración. Cancelar y devolver
  -- vienen con step-up obligatorio (P8, P9).
  ('cajero', 'ventas:crear'), ('cajero', 'ventas:leer'),
  ('cajero', 'ventas:cancelar'), ('cajero', 'ventas:devolver'),
  ('cajero', 'turnos:abrir'), ('cajero', 'turnos:cerrar'),
  ('cajero', 'turnos:leer'), ('cajero', 'turnos:retiros'),
  ('cajero', 'productos:leer'),
  ('cajero', 'stock:leer'),
  ('cajero', 'etiquetas:imprimir'),
  ('cajero', 'catalogos:leer'),
  ('cajero', 'dispositivos:emparejar'),
  -- P22: revocar SIEMPRE se permite, incluso al cajero. En una emergencia hay que
  -- poder cortar el acceso de un celular robado sin depender de que el dueño esté.
  ('cajero', 'dispositivos:revocar'),

  -- Bodega: inventario, conteos, etiquetas. No vende ni ve precios de venta.
  ('bodega', 'productos:leer'), ('bodega', 'productos:editar'),
  ('bodega', 'stock:leer'), ('bodega', 'stock:ajustar'),
  ('bodega', 'stock:conteo'), ('bodega', 'stock:traspaso'),
  ('bodega', 'etiquetas:generar'), ('bodega', 'etiquetas:imprimir'),
  ('bodega', 'etiquetas:calibrar'),
  ('bodega', 'catalogos:leer'),
  ('bodega', 'reportes:inventario'),

  -- Auditor: solo lectura, pero SÍ ve costos (para poder auditar márgenes).
  ('auditor', 'ventas:leer'),
  ('auditor', 'turnos:leer'),
  ('auditor', 'productos:leer'),
  ('auditor', 'precios:ver_costos'),
  ('auditor', 'stock:leer'),
  ('auditor', 'catalogos:leer'),
  ('auditor', 'reportes:ventas'), ('auditor', 'reportes:margen'),
  ('auditor', 'reportes:inventario'), ('auditor', 'reportes:exportar'),
  ('auditor', 'policies:leer'),
  ('auditor', 'auditoria:leer')
) AS m(rol, permiso)
JOIN roles r ON r.clave = m.rol
-- El comodín '*' del dueño se expande a todos los permisos aquí.
JOIN permissions p ON (m.permiso = '*' OR p.clave = m.permiso);
