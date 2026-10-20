-- ═══════════════════════════════════════════════════════════════════════════
--  0009_step_up_password.sql — autorización puntual con la contraseña
-- ═══════════════════════════════════════════════════════════════════════════
--
--  El diseño original de F6 pide un PIN de 6 dígitos para las acciones
--  sensibles. Mientras esa pantalla no exista, la dueña ya tiene algo que sólo
--  ella sabe —la contraseña de la cuenta— y no hace falta inventar un segundo
--  secreto a medias.
--
--  `step_up_grants.metodo` sólo admitía 'pin', 'passkey' y 'totp'. Se agrega
--  'password' para que el otorgamiento diga la verdad de cómo se autorizó: si
--  mañana se audita quién aprobó un retiro, el método importa.
--
--  La vigencia sigue siendo de 5 minutos y la otorga `concederStepUp()` en
--  `auth.ts`, que verifica el hash argon2id de la contraseña. No se relaja
--  ninguna otra condición de la tabla.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE step_up_grants DROP CONSTRAINT IF EXISTS step_up_grants_metodo_check;

ALTER TABLE step_up_grants
  ADD CONSTRAINT step_up_grants_metodo_check
  CHECK (metodo IN ('pin', 'passkey', 'totp', 'password'));

COMMENT ON COLUMN step_up_grants.metodo IS
  'Cómo se autorizó: pin, passkey, totp o password (mientras F6 no tenga PIN).';
