-- ═══════════════════════════════════════════════════════════════════════════
--  0007_caja.sql — Movimientos de cajón (F2.11)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  POR QUÉ VA EN UNA MIGRACIÓN NUEVA Y NO EN 0001
--
--  0001_init.sql ya corrió en el navegador del dueño. Una migración aplicada es
--  historia congelada: si se le agrega la tabla, el PC que ya la corrió y el que
--  la corra después quedan con esquemas distintos y nada lo avisa. El runner lo
--  rechaza (ErrorMigracionDivergente), así que la tabla nueva va aquí.
--
--  ─── QUÉ ES UN MOVIMIENTO DE CAJÓN ─────────────────────────────────────────
--
--  Dinero que entra o sale del cajón y NO es una venta:
--
--    · 'retiro'  — el dueño saca utilidad, o paga algo con el cambio.
--    · 'gasto'   — se compró algo de la caja chica (bolsas, café, luz).
--    · 'ingreso' — se repone cambio de la caja fuerte, o un abono.
--
--  Sin esta tabla el arqueo siempre da diferencia negativa "inexplicable" y el
--  cierre se vuelve inútil. Con ella, cada peso tiene una explicación escrita.
--
--  El fondo inicial NO entra aquí: no es un movimiento, es la declaración de lo
--  que ya estaba en el cajón al abrir. Vive en cash_sessions.fondo_inicial_minor
--  para que no se pueda confundir con una venta (docs/05 §6).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE cash_movements (
  id                uuid PRIMARY KEY,
  cash_session_id   uuid NOT NULL REFERENCES cash_sessions(id),
  tipo              text NOT NULL,
  monto_minor       bigint NOT NULL,
  concepto          text NOT NULL,
  autorizado_por    uuid REFERENCES users(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  ocurrido_at       timestamptz NOT NULL,
  registrado_at     timestamptz NOT NULL DEFAULT now(),

  -- Catálogo cerrado, por la misma razón que los motivos del ledger de stock:
  -- 'retiro ' con un espacio al final no es un motivo nuevo, es un reporte que
  -- deja de cuadrar. El CHECK lo impide en la base, no sólo en la interfaz.
  CHECK (tipo IN ('retiro', 'ingreso', 'gasto')),
  CHECK (monto_minor > 0),
  CHECK (btrim(concepto) <> '')
);

CREATE INDEX idx_cash_mov_turno ON cash_movements(cash_session_id, ocurrido_at DESC);

-- Un solo turno abierto por terminal. Es la regla de docs/05 §2 escrita donde no
-- se puede olvidar: si la interfaz fallara y dejara abrir dos, el segundo INSERT
-- choca contra este índice y la venta no puede quedar en un turno ambiguo.
CREATE UNIQUE INDEX uq_cash_abierta_por_terminal
  ON cash_sessions(terminal_id)
  WHERE cerrada_at IS NULL;
