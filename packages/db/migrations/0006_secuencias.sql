-- 0006 — la secuencia de códigos internos.
--
-- docs/03 §4. Un producto sin código de fábrica necesita uno propio: EAN-13 con el
-- prefijo 2, que ningún fabricante usa. Ese número NO se puede elegir en el navegador
-- ni con `Math.random()`: dos pestañas (o dos dispositivos) eligiendo a la vez acaban
-- con el mismo código, y el `UNIQUE` de `product_barcodes.codigo` rechaza el segundo.
-- El trabajo se pierde, y peor: se pierde **después** de haberlo hecho.
--
-- Por eso el número se reserva en la base con un `UPDATE ... RETURNING` atómico, dentro
-- de la misma transacción que crea el producto. Si el producto no entra, la transacción
-- se revierte y el número no se gasta.
--
-- La tabla es genérica por prefijo (no sólo '2') para el día que haya rangos por
-- presentación —paquete, caja—, pero hoy sólo existe el '2'. El prefijo tiene que
-- caber en un EAN-13: un solo dígito.
CREATE TABLE barcode_sequences (
  prefijo        text PRIMARY KEY,
  -- El siguiente número libre. Empieza en 1; el primer código usa el 1.
  siguiente      bigint NOT NULL DEFAULT 1,
  -- EAN-13 = 13. La columna existe para que el día que haya otro formato sea explícito.
  longitud_total int NOT NULL DEFAULT 13,
  checkpoint_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (prefijo ~ '^[0-9]$'),
  CHECK (siguiente >= 1),
  CHECK (longitud_total = 13)
);

-- El rango interno de la tienda. Un solo renglón: si falta, `generarCodigoInterno()`
-- falla con un mensaje claro en vez de inventarse un número.
INSERT INTO barcode_sequences (prefijo) VALUES ('2');
