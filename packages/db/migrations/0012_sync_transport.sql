-- Transporte autenticado para el registro de eventos entre dispositivos.
ALTER TABLE server_events
  ADD COLUMN server_seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX uq_server_events_server_seq ON server_events(server_seq);
CREATE INDEX idx_server_events_pull ON server_events(server_seq);

CREATE TABLE device_sync_tokens (
  device_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE sync_applied_events (
  event_id text PRIMARY KEY,
  server_seq bigint NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
