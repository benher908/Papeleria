-- ═══════════════════════════════════════════════════════════════════════════
--  0005_politicas.sql — Las reglas de autorización, como datos (doc 06 §5)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  0002 creó la tabla `policies` y NO sembró ninguna regla, a propósito. El
--  encabezado de aquella migración decía por qué:
--
--    "La gramática de `condicion` que esas reglas necesitan NO está especificada en
--     los documentos. [...] P1 necesita comparar DOS CAMPOS del contexto entre sí y
--     eso la gramática publicada no lo cubre. [...] Sembrar reglas de SEGURIDAD que
--     nadie puede verificar es peor que no sembrarlas: da la falsa impresión de que
--     el sistema está configurado."
--
--  Esta migración es el otro lado de esa frase. La gramática ya está definida y
--  probada en `packages/core/src/policies/`:
--
--    · El lado derecho de una comparación es `valor` (literal) o `campo2` (otro
--      campo), exactamente uno. `campo2` es lo que desbloquea P1, P3 y P7.
--    · Operadores: eq, ne, gt, gte, lt, lte, gt_abs, en, and, or, not, siempre.
--      `gt_abs` existe para P17: la diferencia de un arqueo puede ser faltante o
--      sobrante, y con `lt` habría que escribir el umbral dos veces.
--    · El catálogo de campos consultables está en `policies/campos.ts`, y está
--      tipado sobre `ContextoPolitica`: si alguien añade un campo al contexto y no
--      lo describe ahí, no compila.
--
--  Y `evaluar.test.ts` (24 pruebas) más la tabla del doc 06 §9, que se ejecuta en
--  `packages/db` contra ESTAS filas, prueban regla por regla que hacen lo que dicen.
--
--  ─── CUENTA DE LAS 31 REGLAS DEL DOC 06 §5 ────────────────────────────────
--
--  Aquí van 30 filas. Las 31 reglas del documento se reparten así:
--
--    · P1–P19 y P24–P31 ............................ 27 filas, una por regla
--    · P21 (políticas Y usuarios) ...................  2 filas: son dos permisos
--                                                      distintos con la misma decisión
--    · P22 (revocar un dispositivo) .................  1 fila
--    · P20 (ver costos) y P23 (consultar auditoría) .  0 filas, y NO es un olvido:
--                                                      son puro RBAC. El permiso
--                                                      `precios:ver_costos` no lo tiene
--                                                      el cajero y punto; no hay ninguna
--                                                      condición de atributo que
--                                                      evaluar. Una fila que dijera
--                                                      "denegar si falta el permiso"
--                                                      sería el RBAC escrito dos veces.
--
--  ─── DOS CORRECCIONES AL DOC 06 §5, Y UNA COSA QUE NO SE PUEDE ESCRIBIR ───
--
--  1. NINGUNA de estas condiciones menciona el step-up. El boceto del doc 06 §5 pone
--     en P10 la cláusula `tiene_step_up_reciente == false` junto a la del descuento.
--     Para P10 funciona (sólo pide `step_up`), pero hunde a P11 ("descuento > 30 % o
--     mayor a $200"), que pide además motivo y aviso: al teclear el PIN la cláusula
--     deja de cumplirse, la regla deja de aplicar y las otras dos obligaciones se van
--     con ella. El dueño autoriza y la venta se registra sin motivo y sin aviso.
--
--     La obligación de step-up la quita `evaluar()` cuando ya está satisfecha. Ver el
--     encabezado de `packages/core/src/policies/evaluar.ts` y la prueba
--     "el step_up ya satisfecho deja de pedirse, y las otras obligaciones se quedan".
--
--  2. Los umbrales están ESCRITOS AQUÍ, en la condición, no precalculados en código.
--     El doc 06 §4 proponía `entorno.rango_diferencia_conteo` ('bajo' | 'medio' |
--     'alto') para P7 y `accion.es_masiva` para P4. Los dos esconden el umbral en el
--     código que los calcula, y el doc 06 §10 pide justo lo contrario: "cambiar un
--     umbral debe ser una edición de datos, no un despliegue". Por eso van los números
--     crudos (`recurso.diferencia_pct` > 10, `accion.productos_afectados` > 5): así el
--     dueño puede cambiarlos desde la pantalla de umbrales.
--
--  3. **P28 tiene una parte que este lenguaje NO PUEDE escribir.** La regla dice
--     "el descuento se limita a 5 %", y eso no es una decisión binaria con obligaciones:
--     es **modificar un valor**. `policies` puede permitir, denegar y exigir cosas; no
--     puede reescribir el dato. La fila de P28 exige `marcar_para_revision` —que es la
--     mitad que sí se puede— y el tope del 5 % queda pendiente de una capacidad que hoy
--     no existe (efectos sobre el valor, no sobre la decisión). Está anotado en el
--     `motivo` para que se vea en la pantalla de políticas y en docs/06 §5. Queda
--     abierto, no escondido.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────── 5.1 PROTECCIÓN CONTRA EL ERROR ───────────────────
--
-- Estas protegen al dueño de sí mismo, que es el 90 % de los problemas reales (doc 06
-- §2.1): el precio en centavos, el ajuste al producto equivocado, el cero de menos.

INSERT INTO policies (id, version, prioridad, efecto, aplica_a, condicion, obligaciones, motivo, es_sistema) VALUES

-- P1 ⭐ La regla que obligó a que existiera `campo2`: compara dos campos entre sí.
('P1-precio-bajo-costo', 1, 10, 'denegar',
 $j${"permiso":"precios:editar"}$j$::jsonb,
 $j${"op":"lt","campo":"recurso.precio_nuevo_minor","campo2":"recurso.costo_minor"}$j$::jsonb,
 ARRAY[]::text[],
 'El precio nuevo queda por debajo del costo: vender así pierde dinero. Ni con autorización.',
 true),

-- P2
('P2-precio-cero-o-negativo', 1, 20, 'denegar',
 $j${"permiso":"precios:editar"}$j$::jsonb,
 $j${"op":"lte","campo":"recurso.precio_nuevo_minor","valor":0}$j$::jsonb,
 ARRAY[]::text[],
 'Un precio de cero o negativo es un error de captura. No se guarda.',
 true),

-- P3
('P3-precio-igual-al-costo', 1, 200, 'permitir',
 $j${"permiso":"precios:editar"}$j$::jsonb,
 $j${"op":"eq","campo":"recurso.precio_nuevo_minor","campo2":"recurso.costo_minor"}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio']::text[],
 'El precio queda igual al costo: margen cero. Puede ser una promoción, pero que sea a propósito.',
 true),

-- P4
('P4-cambio-masivo', 1, 210, 'permitir',
 $j${"permiso":"precios:aplicar_masivo"}$j$::jsonb,
 $j${"op":"gt","campo":"accion.productos_afectados","valor":5}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','notificar_dueno']::text[],
 'Cambio de precio a más de 5 productos: aquí vive el error de multiplicar por 100.',
 true),

-- P5
('P5-ajuste-stock-sensible', 1, 110, 'permitir',
 $j${"permiso":"stock:ajustar"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.valor_stock_afectado_minor","valor":50000}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio']::text[],
 'Ajuste de stock por más de $500: es el agujero por donde se va el inventario.',
 true),

-- P6
('P6-ajuste-stock-grande', 1, 120, 'permitir',
 $j${"permiso":"stock:ajustar"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.valor_stock_afectado_minor","valor":200000}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','notificar_dueno','marcar_para_revision']::text[],
 'Ajuste de stock por más de $2,000: queda marcado para revisión además de autorizado.',
 true),

-- P7 ⭐ Otro umbral que el doc 06 §4 quería precalculado en un enum.
('P7-conteo-con-diferencia-grande', 1, 130, 'permitir',
 $j${"permiso":"stock:conteo"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.diferencia_pct","valor":10}$j$::jsonb,
 ARRAY['motivo_obligatorio']::text[],
 'El conteo físico difiere más del 10 % del valor: hay que explicar qué se encontró.',
 true),

-- ─────────────────── 5.2 PROTECCIÓN CONTRA EL ROBO ───────────────────

-- P8
('P8-cancelar-venta-cobrada', 1, 220, 'permitir',
 $j${"permiso":"ventas:cancelar"}$j$::jsonb,
 $j${"op":"eq","campo":"recurso.es_venta_ya_cerrada","valor":true}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio']::text[],
 'Cancelar una venta ya cobrada: es el fraude número uno en caja.',
 true),

-- P9
('P9-devolucion-sin-ticket', 1, 230, 'permitir',
 $j${"permiso":"ventas:devolver"}$j$::jsonb,
 $j${"op":"eq","campo":"recurso.tiene_ticket","valor":false}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','notificar_dueno']::text[],
 'Devolución sin ticket: no hay prueba de la compra.',
 true),

-- P10
-- La prioridad es MAYOR que la de P11 (230) a propósito: para un descuento del 40 %
-- aplican las dos, y `evaluar()` reporta el motivo de la primera. Que el usuario lea
-- "descuento mayor al 30 %, hace falta motivo y se avisa al dueño" explica mejor la
-- situación que "descuento mayor al 10 %". La decisión y las obligaciones son las mismas
-- en cualquier orden —deny-overrides y obligaciones acumuladas—, pero el texto que ve la
-- cajera no.
('P10-descuento-alto', 1, 240, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.descuento_pct","valor":10}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Descuento mayor al 10 %: se requiere autorización del dueño.',
 true),

-- P11
('P11-descuento-muy-alto', 1, 230, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"or","args":[{"op":"gt","campo":"recurso.descuento_pct","valor":30},{"op":"gt","campo":"recurso.descuento_minor","valor":20000}]}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','notificar_dueno']::text[],
 'Descuento mayor al 30 % o de más de $200: autorización, motivo y aviso al dueño.',
 true),

-- P12
('P12-venta-grande', 1, 170, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.monto_minor","valor":500000}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Venta por más de $5,000: no se bloquea, pero queda registrado quién y a qué hora.',
 true),

-- P13
('P13-venta-nocturna', 1, 180, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"gt","campo":"recurso.monto_minor","valor":100000},{"op":"gte","campo":"entorno.hora_local","valor":20}]}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Venta por más de $1,000 después de las 20:00: de noche la regla es más estricta.',
 true),

-- P14
('P14-retiro-sensible', 1, 140, 'permitir',
 $j${"permiso":"turnos:retiros"}$j$::jsonb,
 $j${"op":"gt","campo":"recurso.monto_minor","valor":50000}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio']::text[],
 'Retiro de cajón por más de $500: sale efectivo sin venta que lo respalde.',
 true),

-- P15
('P15-retiro-grande-o-repetido', 1, 150, 'permitir',
 $j${"permiso":"turnos:retiros"}$j$::jsonb,
 $j${"op":"or","args":[{"op":"gt","campo":"recurso.monto_minor","valor":100000},{"op":"gt","campo":"recurso.retiros_en_turno","valor":3}]}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','notificar_dueno']::text[],
 'Retiro de más de $1,000, o más de 3 retiros en el mismo turno: patrón de vaciado gradual.',
 true),

-- P16
('P16-reimpresion-de-ticket', 1, 190, 'permitir',
 $j${"permiso":"etiquetas:imprimir"}$j$::jsonb,
 $j${"op":"gte","campo":"recurso.impresion_numero","valor":2}$j$::jsonb,
 ARRAY['marcar_para_revision']::text[],
 'Reimpresión de un ticket ya impreso: se permite, pero queda marcado. Es un patrón de fraude conocido.',
 true),

-- P17 ⭐ Necesita `gt_abs`: la diferencia puede ser faltante o sobrante.
('P17-cierre-con-diferencia', 1, 160, 'permitir',
 $j${"permiso":"turnos:cerrar"}$j$::jsonb,
 $j${"op":"gt_abs","campo":"recurso.diferencia_minor","valor":5000}$j$::jsonb,
 ARRAY['motivo_obligatorio','notificar_dueno']::text[],
 'El arqueo difiere más de $50 del esperado, en más o en menos: que se explique solo.',
 true),

-- ─────────────────────────── 5.3 CONTROL DE ACCESO ───────────────────────────

-- P18
-- El doc 06 §5.3 pide aquí "notificar_dueno, registrar en auditoría". Lo segundo no es
-- una obligación de esta lista porque no hace falta pedirlo: TODA emisión pasa por
-- `emitirEvento()`, que escribe la auditoría (docs/08 §2.1). Si fuera una obligación,
-- habría una forma de cumplirla mal y otra de olvidarla.
('P18-exportar-catalogo', 1, 260, 'permitir',
 $j${"permiso":"reportes:exportar"}$j$::jsonb,
 $j${"op":"siempre"}$j$::jsonb,
 ARRAY['notificar_dueno']::text[],
 'Exportar el catálogo o las ventas: se avisa al dueño. Es la base del negocio saliendo por la puerta.',
 true),

-- P19
('P19-emparejar-escaner', 1, 270, 'permitir',
 $j${"permiso":"dispositivos:emparejar"}$j$::jsonb,
 $j${"op":"siempre"}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Emparejar un dispositivo nuevo: la sesión de caja tiene que tener autorización reciente.',
 true),

-- P20 es RBAC puro: el permiso `precios:ver_costos` no lo tiene el cajero, y no hay
-- ninguna condición de atributo que evaluar. Ver la cuenta en el encabezado.

-- P21
('P21a-usuarios', 1, 280, 'permitir',
 $j${"permiso":"usuarios:*"}$j$::jsonb,
 $j${"op":"siempre"}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Crear, editar o dar de baja usuarios: siempre con autorización.',
 true),

('P21b-politicas', 1, 290, 'permitir',
 $j${"permiso":"policies:editar"}$j$::jsonb,
 $j${"op":"siempre"}$j$::jsonb,
 ARRAY['step_up']::text[],
 'Editar las reglas de autorización: siempre con autorización.',
 true),

-- P22 ⭐ La única que existe para NO pedir nada, y el motivo importa.
--
-- El permiso `dispositivos:revocar` está marcado `es_sensible = false` en 0002 (y el
-- cajero lo tiene). Si algún día alguien lo marca sensible "por seguridad", esta regla
-- no puede deshacerlo: las obligaciones se suman, y con deny-overrides nada las quita.
-- Lo que impide el estrangulamiento es el `es_sensible = false`, no esta fila. La fila
-- está para que la decisión quede escrita en el mismo sitio que las demás, y para que
-- la pantalla de políticas la muestre.
('P22-revocar-dispositivo', 1, 300, 'permitir',
 $j${"permiso":"dispositivos:revocar"}$j$::jsonb,
 $j${"op":"siempre"}$j$::jsonb,
 ARRAY[]::text[],
 'Revocar un dispositivo no pide autorización: en una emergencia hay que poder cortar el acceso ya.',
 true),

-- P23 es RBAC puro: `auditoria:leer` lo tienen el dueño y el auditor.

-- P24
('P24-conteo-ya-aplicado', 1, 30, 'denegar',
 $j${"permiso":"stock:conteo"}$j$::jsonb,
 $j${"op":"eq","campo":"recurso.conteo_ya_aplicado","valor":true}$j$::jsonb,
 ARRAY[]::text[],
 'Un conteo ya aplicado no se modifica: se corrige con un movimiento nuevo, que deja rastro.',
 true),

-- ──────────────── 5.4 MODO OFFLINE (cuando no hay servidor a quien preguntar) ────────────────
--
-- Sin red, estas reglas son la ÚNICA defensa (doc 06 §7, capa 2): no hay servidor que
-- revalide. Por eso son más estrictas que las de arriba, y por eso viven en la base
-- local y viajan firmadas con el catálogo.

-- P25
('P25-venta-offline-pequena', 1, 60, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"eq","campo":"entorno.es_offline","valor":true},{"op":"lte","campo":"recurso.monto_minor","valor":50000}]}$j$::jsonb,
 ARRAY[]::text[],
 'Venta sin red por $500 o menos: el caso normal. No estorba.',
 true),

-- P26
('P26-venta-offline-media', 1, 70, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"eq","campo":"entorno.es_offline","valor":true},{"op":"gt","campo":"recurso.monto_minor","valor":50000},{"op":"lte","campo":"recurso.monto_minor","valor":200000}]}$j$::jsonb,
 ARRAY['marcar_para_revision']::text[],
 'Venta sin red de más de $500: se acepta para no frenar el negocio y se revisa al volver la red.',
 true),

-- P27
('P27-venta-offline-grande', 1, 80, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"eq","campo":"entorno.es_offline","valor":true},{"op":"gt","campo":"recurso.monto_minor","valor":200000}]}$j$::jsonb,
 ARRAY['step_up','marcar_para_revision']::text[],
 'Venta sin red por más de $2,000: freno razonable sin bloquear la venta.',
 true),

-- P28 ⚠️ Incompleta a propósito: falta el tope del 5 %. Ver el punto 3 del encabezado.
('P28-descuento-offline', 1, 90, 'permitir',
 $j${"permiso":"ventas:crear"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"eq","campo":"entorno.es_offline","valor":true},{"op":"gt","campo":"recurso.descuento_pct","valor":0}]}$j$::jsonb,
 ARRAY['marcar_para_revision']::text[],
 'Descuento sin red: queda marcado para revisión. (Sin red no hay forma de autorizarlo en línea, y es el escenario ideal para el abuso. Falta aplicar el tope del 5 %: el lenguaje de políticas todavía no puede limitar valores.)',
 true),

-- P29
('P29-precio-offline', 1, 40, 'denegar',
 $j${"permiso":"precios:editar"}$j$::jsonb,
 $j${"op":"eq","campo":"entorno.es_offline","valor":true}$j$::jsonb,
 ARRAY[]::text[],
 'Los precios se cambian con red. Sin red, no: evita que dos dispositivos queden con catálogos distintos.',
 true),

-- P30
('P30-retiro-offline', 1, 50, 'denegar',
 $j${"permiso":"turnos:retiros"}$j$::jsonb,
 $j${"op":"and","args":[{"op":"eq","campo":"entorno.es_offline","valor":true},{"op":"gt","campo":"recurso.monto_minor","valor":30000}]}$j$::jsonb,
 ARRAY[]::text[],
 'Retiro de cajón sin red por más de $300: sin red no hay forma de avisarle a nadie.',
 true),

-- P31
('P31-reversion-offline', 1, 100, 'permitir',
 $j${"permiso":"ventas:cancelar"}$j$::jsonb,
 $j${"op":"eq","campo":"entorno.es_offline","valor":true}$j$::jsonb,
 ARRAY['step_up','motivo_obligatorio','marcar_para_revision']::text[],
 'Revertir una venta sin red: autorización, motivo y marca para revisión.',
 true);
