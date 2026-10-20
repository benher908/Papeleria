-- ═══════════════════════════════════════════════════════════════════════════
--  0010_venta_libre.sql — el producto de servicios para fotocopias
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Una venta libre (copias, engargolados, impresiones) no tiene un producto de
--  inventario detrás. `sale_lines.product_id` es NOT NULL a propósito —cada
--  renglón del ticket debe poder rastrearse a algo—, así que la solución no es
--  un `if` en la caja: es una fila de servicios con `tracks_stock = false`.
--
--  Su precio es 0 porque cada venta libre manda el suyo en la línea. El POS la
--  esconde del catálogo (por el SKU) y la usa sólo cuando alguien elige «Venta
--  libre». No tiene código de barras: no se escanea, se cobra.
--
--  El UUID es fijo por la misma razón que las unidades y categorías: el día que
--  exista el servidor, los dos lados tienen que reconocer la misma fila.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO products
  (id, sku, nombre, descripcion, category_id, unit_id, tax_rate_id,
   precio_minor, costo_minor, tracks_stock, stock_minimo, is_activo, notas)
VALUES (
  '01900000-0000-7000-8100-000000000001',
  'VENTA-LIBRE',
  'Venta libre',
  'Fotocopias, impresiones y servicios que no llevan inventario; el precio se escribe en cada venta.',
  '01900000-0000-7000-8004-000000000007',
  '01900000-0000-7000-8002-000000000001',
  '01900000-0000-7000-8003-000000000001',
  0,
  0,
  false,
  0,
  true,
  'Producto de sistema para venta libre. No borrar: la caja lo usa para las líneas de servicios.'
)
ON CONFLICT (id) DO NOTHING;
