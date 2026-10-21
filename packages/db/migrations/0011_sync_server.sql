-- Cola idempotente del servidor. El evento completo sigue siendo la fuente de verdad;
-- esta tabla evita recibir dos veces el mismo evento offline.
CREATE TABLE server_events (
  event_id text PRIMARY KEY,
  device_id uuid NOT NULL,
  device_seq bigint NOT NULL,
  payload jsonb NOT NULL,
  recibido_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_server_events_device_seq ON server_events(device_id, device_seq);
