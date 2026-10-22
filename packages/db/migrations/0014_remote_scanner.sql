CREATE TABLE remote_scanner_sessions (
  code text PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remote_scanner_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_code text NOT NULL REFERENCES remote_scanner_sessions(code) ON DELETE CASCADE,
  barcode text NOT NULL,
  symbology text,
  scanned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_remote_scanner_events_session ON remote_scanner_events(session_code, id);
