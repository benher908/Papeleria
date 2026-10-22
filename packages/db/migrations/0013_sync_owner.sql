ALTER TABLE device_sync_tokens
  ADD COLUMN IF NOT EXISTS owner_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_device_sync_tokens_owner
  ON device_sync_tokens(owner_user_id);
