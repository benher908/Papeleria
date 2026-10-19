-- 0004 — el almacenamiento que `emitirEvento()` daba por hecho.
--
-- docs/08 §2 describe `siguienteDeviceSeq(tx, deviceId)` y §6 `siguienteFolioLocal`
-- como si sus tablas existieran. No existían: 0001..0003 crearon `event_log` y
-- `outbox` (la cola), pero ningún contador (de dónde sale el número).
--
-- Sin esto el mecanismo queda a medias de una forma silenciosa: `event_log` exige
-- `device_seq` y `sales.folio_local` es NOT NULL, así que la primera venta falla en
-- tiempo de ejecución con un "no sé de dónde sacar el número", en vez de fallar aquí.

-- ───────────── Contadores por dispositivo (estado LOCAL, no se sincroniza) ─────────────
--
-- Igual que `outbox` y `sync_cursors`, esta tabla vive en el dispositivo y no viaja:
-- son dos números que sólo tienen sentido en el aparato que los generó.
--
-- Guarda las dos cosas que deben ser monótonas dentro de un dispositivo:
--   · `ultimo_seq`  el último `device_seq` entregado → sin huecos ni repetidos
--   · `ultimo_hlc`  el último reloj lógico emitido  → el HLC nunca retrocede
--
-- Van juntas a propósito: las dos se leen y se escriben en la MISMA transacción que
-- el evento. Así, un rollback no deja el contador avanzado sin evento — lo que
-- produciría un hueco permanente que el servidor pediría reenviar para siempre.
CREATE TABLE device_counters (
  device_id      uuid PRIMARY KEY REFERENCES devices(id),
  ultimo_seq     bigint NOT NULL DEFAULT 0,
  ultimo_hlc     text,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ultimo_seq >= 0)
);

-- ───────────────────── Folios por terminal (estado LOCAL) ─────────────────────
--
-- El folio visible ('C1-000123') lo genera el dispositivo: offline no se puede pedir
-- al servidor. El prefijo por terminal hace imposible que dos cajas generen el mismo
-- folio sin coordinarse (docs/08 §6). `sales.folio`, el consecutivo GLOBAL, sigue
-- siendo IDENTITY y lo asigna el servidor; éste es sólo el número que se imprime.
--
-- Se ancla al `device_id` y no al texto del prefijo, a diferencia del boceto de
-- docs/08 §6, por dos razones: la clave foránea impide que un dedazo en el código cree
-- un contador paralelo, y el contador sobrevive a que alguien corrija el prefijo.
CREATE TABLE folio_counters (
  device_id      uuid PRIMARY KEY REFERENCES devices(id),
  ultimo_folio   bigint NOT NULL DEFAULT 0,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ultimo_folio >= 0)
);

-- El prefijo del folio es una propiedad del dispositivo que vende. Sin esta columna no
-- hay de dónde sacar el 'C1' de 'C1-000123'.
--
-- Nulo en los dispositivos que no venden (el celular que sólo escanea) y único cuando
-- existe: dos cajas con el mismo prefijo producirían dos folios idénticos, y el
-- índice único parcial es lo que lo impide.
ALTER TABLE devices ADD COLUMN codigo text;
CREATE UNIQUE INDEX uq_devices_codigo ON devices(codigo) WHERE codigo IS NOT NULL;
