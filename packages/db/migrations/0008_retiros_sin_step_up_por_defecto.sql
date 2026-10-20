-- ═══════════════════════════════════════════════════════════════════════════
--  0008_retiros_sin_step_up_por_defecto.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
--  `turnos:retiros` nació marcado `es_sensible = true` en 0002, lo que significa
--  "exige step-up SIEMPRE". En la práctica eso pedía un PIN para sacar $50 para
--  bolsas, y las reglas P14 y P15 ya dicen exactamente cuándo hace falta:
--
--    · P14: retiro de más de $500          → step_up + motivo
--    · P15: más de $1,000 o más de 3 en el turno → step_up + motivo + aviso
--
--  Tener las dos cosas era redundante para los retiros grandes y un obstáculo
--  para los normales. Además, F2.11 tiene que poder cerrar un turno con un retiro
--  de $200, y todavía no existe la pantalla de PIN (F6). Se deja la decisión en
--  las políticas, que es donde el dueño puede ajustar el umbral sin tocar código.
--
--  NO se toca `ventas:cancelar` ni `ventas:devolver`: esos siguen siendo
--  sensibles por defecto, y P8/P9 agregan el motivo. Cancelar una venta cobrada
--  es el fraude número uno en caja y merece el PIN en todos los casos.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE permissions
   SET es_sensible = false
 WHERE clave = 'turnos:retiros';
