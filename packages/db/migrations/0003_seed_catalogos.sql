-- ═══════════════════════════════════════════════════════════════════════════
--  0003_seed_catalogos.sql — Unidades, tasas de impuesto, categorías, config
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Datos de referencia que existen desde el primer arranque, sin que nadie los
--  capture a mano.
--
--  ─── POR QUÉ LOS UUID VAN ESCRITOS A MANO ──────────────────────────────────
--
--  El doc 02 §1 dice que los `id` los genera el cliente con uuidv7, y esta
--  migración parece contradecirlo. No lo hace: la regla es para los datos que el
--  NEGOCIO crea (ventas, productos, movimientos), que se inventan cuando no hay
--  red y no pueden esperar a que el servidor reparta identificadores.
--
--  Estos, en cambio, son datos que el SISTEMA define. Y ahí un uuid aleatorio no
--  es una comodidad perdida: es un bug de sincronización.
--
--  Piénsalo: si 'pieza' recibe un uuid distinto en el PC y otro en el celular, al
--  sincronizar el servidor ve dos filas que no puede reconciliar — dos unidades
--  'pieza', dos categorías 'Escolar', dos roles 'dueno'. Nada falla de inmediato,
--  y por eso es peligroso: los reportes se parten en dos silenciosamente y el
--  problema aparece meses después, cuando ya hay ventas apuntando a las dos.
--
--  Con un literal fijo, 'pieza' tiene el MISMO uuid en todos los dispositivos,
--  siempre, y la sincronización las reconoce como la misma fila. Los literales
--  siguen el patrón 01900000-0000-7000-<familia>-<consecutivo>:
--      8002 unidades · 8003 tasas de impuesto · 8004 categorías
--
--  Estas filas son el punto de partida, no una jaula: el dueño puede agregar
--  unidades, renombrar categorías y editar la configuración. Lo que no debe hacer
--  es BORRAR una de estas, porque los productos que la referencian quedarían
--  huérfanos; para eso está la baja lógica del resto del esquema.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── UNIDADES ───────────────────────────
-- Las seis que un papelería usa de verdad. `abreviatura` es lo que se imprime en
-- la etiqueta de anaquel y en el ticket, donde el ancho es oro.
INSERT INTO units (id, nombre, abreviatura) VALUES
  ('01900000-0000-7000-8002-000000000001', 'pieza',   'pza'),
  ('01900000-0000-7000-8002-000000000002', 'paquete', 'paq'),
  ('01900000-0000-7000-8002-000000000003', 'caja',    'cja'),
  ('01900000-0000-7000-8002-000000000004', 'hoja',    'hoja'),
  ('01900000-0000-7000-8002-000000000005', 'metro',   'm'),
  ('01900000-0000-7000-8002-000000000006', 'hora',    'h');

-- ────────────────────── TASAS DE IMPUESTO ──────────────────────
-- 'Tasa 0%' y 'Exento' son la misma aritmética y NO son lo mismo ante el SAT:
-- tasa 0 lleva IVA a 0 % en la factura; exento no lleva el concepto. Por eso son
-- dos filas y no una. Confundirlas es un error que se corrige con el contador.
INSERT INTO tax_rates (id, nombre, tasa) VALUES
  ('01900000-0000-7000-8003-000000000001', 'IVA 16%',   0.1600),
  ('01900000-0000-7000-8003-000000000002', 'Tasa 0%',   0.0000),
  ('01900000-0000-7000-8003-000000000003', 'Exento',    0.0000);

-- ────────────────────────── CATEGORÍAS ──────────────────────────
-- Árbol mínimo para poder empezar hoy. Las categorías importan más de lo que
-- parecen: de ellas cuelgan las reglas de margen (doc 12), los reportes de
-- utilidad y los conteos por área.
--
-- El orden importa: `parent_id` referencia la propia tabla, así que el padre debe
-- existir antes que el hijo.
--
-- `path` es la ruta con '/' para poder consultar un subárbol completo con un
-- prefijo ('papeleria/%') sin recorrer la jerarquía fila por fila.
INSERT INTO categories (id, parent_id, nombre, path) VALUES
  ('01900000-0000-7000-8004-000000000001', NULL, 'Papelería',          'papeleria'),
  ('01900000-0000-7000-8004-000000000002', '01900000-0000-7000-8004-000000000001', 'Escolar',  'papeleria/escolar'),
  ('01900000-0000-7000-8004-000000000003', '01900000-0000-7000-8004-000000000001', 'Escritura','papeleria/escritura'),
  ('01900000-0000-7000-8004-000000000004', '01900000-0000-7000-8004-000000000001', 'Oficina',  'papeleria/oficina'),
  ('01900000-0000-7000-8004-000000000005', '01900000-0000-7000-8004-000000000001', 'Papel',    'papeleria/papel'),
  ('01900000-0000-7000-8004-000000000006', '01900000-0000-7000-8004-000000000001', 'Arte',     'papeleria/arte'),
  ('01900000-0000-7000-8004-000000000007', NULL, 'Servicios',          'servicios'),
  -- Los servicios (copias, engargolados) viven aparte a propósito: no tienen
  -- stock ni costo de mercancía, y mezclarlos con el catálogo ensucia los
  -- reportes de margen.
  ('01900000-0000-7000-8004-000000000008', '01900000-0000-7000-8004-000000000007', 'Copias e impresión', 'servicios/copias');

-- ──────────────────────── CONFIGURACIÓN ────────────────────────
-- `settings.valor` es jsonb, así que cada fila guarda el valor tal cual: texto
-- entre comillas, números y booleanos sin comillas.
--
-- Los cuatro primeros son datos del negocio y vienen vacíos o genéricos: son para
-- que el dueño los llene, no para que el sistema adivine su RFC.
INSERT INTO settings (clave, valor) VALUES
  ('nombre_negocio',         '"Mi Papelería"'),
  ('rfc',                    '""'),
  ('direccion',              '""'),
  ('telefono',               '""'),

  ('moneda',                 '"MXN"'),
  -- Zona horaria para los reportes. En la base TODO se guarda en UTC; "las ventas
  -- de hoy" es una pregunta que solo tiene respuesta con esta clave.
  ('zona_horaria',           '"America/Mexico_City"'),

  -- Los precios que se capturan YA incluyen IVA (es lo que ve el cliente en el
  -- anaquel). El impuesto se desglosa hacia atrás al facturar, nunca se suma
  -- encima. Ver packages/core/src/precios y el doc 12.
  ('iva_por_defecto',        '0.16'),
  ('precio_incluye_iva',     'true'),

  ('prefijo_folio',          '"PAP"'),      -- 'PAP-000123'
  ('ancho_ticket_mm',        '58'),         -- impresora térmica de 58 mm
  -- Prefijo EAN-13 de circulación restringida (doc 03): los códigos que genera la
  -- papelería empiezan con 2 y nunca chocan con un producto de fábrica.
  ('prefijo_codigo_interno', '"200"'),
  ('dias_para_devolucion',   '7');
