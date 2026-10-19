# 08 — Sincronización offline

Este documento explica cómo dos o tres dispositivos que pierden la conexión siguen funcionando y vuelven a converger sin perder una sola venta. Es la parte del sistema con más reputación de difícil — y con este diseño es una de las más simples, porque **elegimos no tener conflictos**.

## 1. Qué se sincroniza y qué no

| Dato | ¿Se sincroniza? | Dirección | Estrategia |
|------|:---:|-----------|-----------|
| `sales`, `sale_lines`, `payments` | ✅ | PC → servidor | **Nunca hay conflicto**: son hechos que ya pasaron |
| `stock_movements` | ✅ | PC → servidor | **Aditivo**: sumar es conmutativo, el orden no importa |
| `cash_sessions`, `cash_movements` | ✅ | PC → servidor | Inmutable una vez cerrado |
| `products`, `precios`, `categorías` | ✅ | **bidireccional** | LWW por `server_seq` (raro que dos escriban a la vez) |
| `product_barcodes` | ✅ | bidireccional | El **`UNIQUE` global resuelve**: el servidor rechaza el duplicado |
| `policies`, `settings` | ✅ | Servidor → dispositivos | El servidor publica; los clientes **solo leen** |
| `users`, `roles`, `permissions` | ✅ | Servidor → dispositivos | Solo el admin (en el servidor) los edita |
| `audit_log` | ❌ | — | Local al dispositivo que lo generó; se sube como evento informativo |
| `outbox`, `sync_cursors`, `step_up_grants` | ❌ | — | Son estado **por dispositivo**, no se replican |
| `stock_levels` | ❌ | — | **Derivado** de los movimientos; se recalcula localmente |
| Catálogo ligero para el celular | ✅ | Servidor/PC → celular | Solo `{id, barcode, nombre, precio, ubicacion}`, para modo conteo/consulta |

**La tabla de arriba es el 90 % de la explicación.** Si un dato no está en ella, la respuesta por defecto es "no se sincroniza, se deriva".

## 2. El patrón que resuelve todo: *outbox* transaccional

Un error frecuente: emitir el evento y guardarlo como dos operaciones separadas.

```ts
// ❌ MAL: dos operaciones independientes
await db.query('INSERT INTO sales (...) VALUES (...)');           // 1. se guarda la venta
await db.query('INSERT INTO outbox (...) VALUES (...)');          // 2. se encola el evento
// ⚠️ Si el proceso muere entre 1 y 2 (corte de luz, cierre del navegador),
//    la venta existe y NUNCA se sincroniza. Se pierde en silencio.

// ✅ BIEN: una sola transacción
await db.transaction(async (tx) => {
  await tx.query('INSERT INTO sales (...) VALUES (...)');
  await tx.query('INSERT INTO sale_lines (...) VALUES (...)');
  await tx.query('INSERT INTO stock_movements (...) VALUES (...)');
  await tx.query("INSERT INTO outbox (id, event_id, payload) VALUES ($1, $2, $3)",
                 [uuidv7(), eventoId, JSON.stringify(payload)]);
  // ⭐ O entra todo, o no entra nada. Es la propiedad más importante del sistema.
});
```

**Esto es el *outbox pattern* y es lo que garantiza que ninguna venta se pierda.** PGlite corre transacciones reales de Postgres en el navegador, así que funciona idéntico en el PC y en el servidor.

### 2.1 La regla del único camino

> **Estado:** implementado en la fase 0.5, en
> [`packages/db/src/eventos.ts`](../packages/db/src/eventos.ts). Lo que sigue es el
> código real, no el boceto.

Toda mutación pasa por **un solo** eje:

```ts
export async function emitirEvento<Tipo extends string, Payload>(
  cliente: ClienteTransaccional,          // abre él mismo la transacción
  entrada: EntradaEmision<Tipo, Payload>,
): Promise<EventoEmitido<Tipo, Payload>>
```

Y por dentro, en este orden:

```ts
return cliente.transaction(async (tx) => {
  // 1. Contadores: device_seq y HLC, en la misma fila y dentro de la transacción.
  //    Si algo falla después, el `device_seq` se revierte con todo lo demás y no
  //    queda un hueco que el servidor reclamaría para siempre (§3.1).
  const { seq, hlc } = await siguienteSeqYHlc(tx, entrada.dispositivoId, ahora());

  const datos = {
    event_id: ulid(ahora()),              // globalmente único y ordenable
    device_id: entrada.dispositivoId,
    device_seq: seq,
    user_id: entrada.usuarioId,
    occurred_at: new Date(ahora()).toISOString(),
    hlc,
    schema_version: entrada.schemaVersion ?? 1,
  };

  // 2. El payload se construye AQUÍ dentro: necesita el `event_id` (porque
  //    `sales.evento_id` lo copia) y el `tx` (porque el folio de la venta se
  //    asigna en la misma transacción que la venta).
  const payload = await entrada.payload(tx, datos);
  const evento = { ...datos, type: entrada.tipo, payload };

  // 3. Autorización, ANTES de tocar el estado y DENTRO de la transacción (doc 06).
  //    El `tx` va en la llamada para que quien decide lea permisos y políticas con
  //    el mismo bloque atómico que verá el COMMIT.
  const decision = await entrada.autorizar(evento, tx);
  if (!decision.permitido) throw new ErrorNoAutorizado(entrada.tipo, decision.motivo);

  // 4. El estado. Si esto lanza, se revierte TODO: evento, contadores y auditoría.
  await entrada.aplicarEstado(tx, evento);

  // 5. La cola.
  await tx.query('INSERT INTO outbox (id, event_id, payload) VALUES ($1,$2,$3)',
                 [uuidV7(), evento.event_id, JSON.stringify(evento)]);

  // 6. La auditoría.
  await tx.query('INSERT INTO audit_log (...) VALUES (...)', [...]);
});
```

**Beneficios de tener un único eje:**

- La autorización **no se puede olvidar**: `autorizar` es un campo obligatorio y **sin
  valor por defecto**. No hay ningún «permitir todo» escondido en la biblioteca; lo pone
  el llamador, normalmente con `autorizar(tx, …)` de `@papeleria/db`, que carga permisos,
  políticas y step-up dentro de la misma transacción. Si no se pone, no se puede emitir.
- La auditoría **no se puede olvidar**: igual.
- El `event_id`, el `device_seq`, el HLC y el **folio local** se asignan en un solo lugar:
  sin huecos ni duplicados.
- Si mañana quieres añadir algo a cada mutación (telemetría, notificación), es un solo archivo.

**Tres correcciones al boceto, encontradas al implementarlo:**

1. **`aplicarEstado` tiene que recibir el evento.** El boceto la llama sin argumentos,
   pero `sales.evento_id` es `NOT NULL` y tiene que coincidir con el `event_id` del
   `outbox`. Sin pasárselo, esa columna es imposible de escribir.
2. **El payload se construye dentro de la transacción.** El `folio_local` se asigna ahí:
   si se asignara antes, un fallo quemaría un número de ticket y el hueco parecería una
   venta borrada — la primera pregunta de cualquier auditoría. Como el payload tiene que
   llevar ese folio, el payload va dentro también.
3. **La autorización se evalúa dentro de la transacción**, no antes del `BEGIN` como decía
   el boceto: así las políticas que deciden son las mismas que verá el commit.

**Y dos ajustes de fondo:**

- **Dónde vive.** El boceto lo ponía en `packages/core/src/usecases/`. Vive en
  `@papeleria/db` porque es SQL contra este esquema: conoce `outbox`, `audit_log` y
  `device_counters`. `core` es el núcleo *sin* conocimiento de tablas; lo puro que hace
  falta —ULID y HLC— sí está allí (`core/src/ids/`, `core/src/sync/hlc.ts`).
- **El almacenamiento que faltaba.** `siguienteDeviceSeq()` y el folio local se citaban
  como si sus tablas existieran, y no existían. La migración
  [`0004_eventos.sql`](../packages/db/migrations/0004_eventos.sql) crea `device_counters`
  (el `device_seq` y el último HLC, juntos a propósito) y `folio_counters`, y añade
  `devices.codigo`, que es de dónde sale el prefijo `C1` del folio.

## 3. El protocolo: push y pull

```mermaid
sequenceDiagram
    participant PC as PC (cliente)
    participant API as API (servidor)
    participant DB as Postgres

    Note over PC: Sin internet. La caja sigue vendiendo.<br/>Cada venta entra en `outbox` con su event_id.

    Note over PC: Vuelve la conexión. Se dispara el ciclo.
    PC->>PC: Leer outbox (máx 200 eventos, en orden de device_seq)
    PC->>API: POST /sync/push { device_id, events: [...] }
    API->>API: Autenticar + verificar firma + re-evaluar políticas
    API->>DB: BEGIN; INSERT INTO event_log ... ON CONFLICT (event_id) DO NOTHING; COMMIT
    API-->>PC: { accepted: [...], rejected: [...], next_pull_cursor: 90817 }
    PC->>PC: Borrar del outbox los aceptados
    PC->>PC: Los rechazados → cola local `eventos_rechazados` (nunca se borran)

    PC->>API: GET /sync/pull?since=90412&limit=500
    API->>DB: SELECT * FROM event_log WHERE server_seq > 90412 ORDER BY server_seq LIMIT 500
    API-->>PC: { events: [...], next_cursor: 90817, has_more: false }
    PC->>PC: Aplicar en orden de server_seq (idempotente)
    PC->>PC: UPDATE sync_cursors SET last_pull_seq = 90817
    PC->>PC: Recalcular proyecciones (stock_levels, v_top_productos, ...)
```

### 3.1 `/sync/push` en detalle

```ts
// apps/api/src/routes/sync.ts
app.post('/sync/push', async (req, reply) => {
  const { device_id, events } = req.body as PushBody;
  const user = await autenticar(req);

  // 1. ¿El dispositivo sigue autorizado? (puede haber sido revocado hace 1 minuto)
  const device = await db.query('SELECT * FROM devices WHERE id=$1', [device_id]);
  if (!device || device.revoked_at) return reply.code(403).send({ error: 'DISPOSITIVO_REVOCADO' });

  // 2. Límite duro: nunca aceptes un lote de 100 000 eventos
  if (events.length > 500) return reply.code(413).send({ error: 'LOTE_DEMASIADO_GRANDE' });

  // 3. Verificar continuidad: device_seq debe ser consecutivo desde el último visto.
  //    Un hueco significa que se perdió un evento → pedirlo explícitamente.
  const { last_device_seq } = await leerCursor(device_id);
  const esperado = Number(last_device_seq) + 1;
  const ordenados = [...events].sort((a, b) => a.device_seq - b.device_seq);
  const faltantes: number[] = [];
  let cursor = esperado;
  for (const e of ordenados) {
    if (e.device_seq < esperado) continue;              // ya lo tengo (reintento)
    if (e.device_seq > cursor) faltantes.push(cursor);  // hay un hueco
    cursor = Math.max(cursor, e.device_seq + 1);
  }
  // Si hay huecos, aceptamos lo que llegó pero pedimos los faltantes en la respuesta.

  const accepted: string[] = [];
  const rejected: { event_id: string; motivo: string }[] = [];

  for (const evento of ordenados) {
    await db.transaction(async (tx) => {
      // 4. ⭐ IDEMPOTENCIA: si el event_id ya existe, no se aplica dos veces.
      //    Esto resuelve el caso "el servidor lo procesó pero se perdió la respuesta".
      const ya = await tx.query('SELECT 1 FROM event_log WHERE event_id=$1', [evento.event_id]);
      if (ya.rowCount) { accepted.push(evento.event_id); return; }

      // 5. ⭐ El servidor NO confía en el cliente: RE-VALIDA las políticas.
      //    Un cliente manipulado no puede inyectar una venta con 90% de descuento.
      const decision = evaluar(await construirContextoServidor(evento, device, tx), await politicasDe(tx), await permisosDe(tx, user.id));
      if (!decision.permitido) {
        rejected.push({ event_id: evento.event_id, motivo: decision.motivo });
        return;   // ⚠️ NO se aplica. Queda registrado para revisión del dueño.
      }

      // 6. Aplicar como PROYECCIÓN (no como estado autoritativo del cliente)
      await proyectarEvento(tx, evento, { servidor: true, decision });

      await tx.query(
        `INSERT INTO event_log (event_id, device_id, device_seq, user_id, type, payload,
                                occurred_at, hlc, schema_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [evento.event_id, device_id, evento.device_seq, user.id, evento.type,
         JSON.stringify(evento.payload), evento.occurred_at, evento.hlc, evento.schema_version],
      );

      if (decision.obligaciones.includes('marcar_para_revision')) {
        await marcarParaRevision(tx, evento, decision);
      }
      accepted.push(evento.event_id);
    });
  }

  await guardarCursor(device_id, cursor - 1);

  const { next_pull_seq } = await leerCursor(device_id);
  return {
    accepted,
    rejected,                                    // el cliente los mueve a una cola visible
    faltantes,                                   // números de device_seq que el cliente debe reenviar
    next_pull_cursor: Number(next_pull_seq),
  };
});
```

**Los tres detalles que hacen que esto sea robusto:**

1. **Idempotencia por `event_id`.** El caso real: el servidor procesa el lote, se cae justo antes de responder, el cliente reintenta. Sin idempotencia, la venta se aplica dos veces → stock bajado al doble, reporte inflado. Con `event_id UNIQUE`, el reintento no hace nada y responde igual. **Esto solo se detecta en producción si no lo implementas desde el inicio.**
2. **Re-validación en el servidor.** El cliente es un dispositivo físico en un local. No es de fiar. El mismo evento puede haber sido aceptado localmente por una política vieja.
3. **Detección de huecos por `device_seq`.** Si el PC escribió eventos 400, 401, 402 y solo llegan 400 y 402, el servidor lo detecta y pide el 401. Es un `CHECK` de integridad de la transmisión, no del negocio.

### 3.2 `/sync/pull` en detalle

```sql
-- La consulta completa del pull. Nada más y nada menos.
SELECT server_seq, event_id, device_id, type, payload, occurred_at, hlc, schema_version
FROM event_log
WHERE server_seq > $1                    -- el cursor del dispositivo
ORDER BY server_seq                      -- ⭐ ORDEN GLOBAL, no el del reloj local
LIMIT $2;
```

**¿Por qué ordenar por `server_seq` y no por `occurred_at`?** Porque el reloj de un dispositivo puede estar mal (ver §5) y entonces el orden por `occurred_at` cambia según quién mira. `server_seq` es un orden **total y único** asignado por el servidor: todas las réplicas aplican los eventos en el **mismo orden** y llegan al **mismo estado**. Esa propiedad se llama convergencia, y es todo el objetivo de este sistema.

**Aplicación en el cliente (idempotente por diseño):**

```ts
export async function aplicarPull(eventos: EventoRemoto[]) {
  await db.transaction(async (tx) => {
    for (const e of eventos) {
      // Idempotencia también en el cliente: si el mismo evento llegó dos veces
      // (porque el cursor se retrocedió), no se aplica dos veces.
      const ya = await tx.query('SELECT 1 FROM eventos_aplicados WHERE event_id=$1', [e.event_id]);
      if (ya.rowCount) continue;

      await proyectarEvento(tx, e, { servidor: false });
      await tx.query('INSERT INTO eventos_aplicados (event_id, aplicado_at) VALUES ($1, now())', [e.event_id]);
    }
    // Recalcular proyecciones derivadas UNA vez al final del lote, no por evento
    await tx.query('REFRESH MATERIALIZED VIEW ...');   // o el recálculo que uses
  });
}
```

## 4. Conflictos: los cinco casos y su respuesta

| Tipo de dato | Ejemplo | Estrategia | ¿Puede perder datos? |
|--------------|---------|-----------|----------------------|
| **Acontecimiento inmutable** | Una venta, una devolución, un cierre de turno | **No hay conflicto**: dos hechos distintos no chocan | No |
| **Aditivo** | Movimientos de stock | **Sumar.** Conmutativo y asociativo: el orden no importa | No |
| **Metadato con LWW** | El nombre de un producto | Última escritura gana, **según `server_seq`** | Sí, y es aceptable |
| **Restricción única** | Mismo código de barras en dos productos | El servidor **rechaza el segundo** | Sí, con aviso explícito |
| **Contador** | Folio de venta | **Prefijo por dispositivo** (§6) | No |

### 4.1 El conflicto de verdad: editar el mismo producto en dos dispositivos

Escenario real: en el PC cambias el precio de "Cuaderno Scribe" a $40 mientras en el celular (que no edita precios, por política P29) alguien pone $38. Al sincronizar:

```text
PC    → product.updated { id: X, precio: 4000, hlc: '...008' }
CEL   → product.updated { id: X, precio: 3800, hlc: '...009' }

Servidor: aplica por server_seq. El último en llegar gana: $38.00.
```

**Con LWW simple, esto puede dar un resultado "incorrecto"** (el precio "más nuevo" según el reloj puede llegar antes). Mitigaciones, en orden de simplicidad:

1. **Política P29: los precios no se editan offline.** Con un solo dispositivo que edita precios (el PC), el conflicto es imposible. **Adóptalo.** Es la solución más simple y no pierdes nada real.
2. **Si algún día hay dos editores:** LWW por `hlc` (reloj lógico, §5) **y** un reporte de cambios sobreescritos: *"El precio de Cuaderno Scribe pasó de $40 a $38 en el celular, sobreescribiendo un cambio del PC 8 segundos antes"*. El dueño decide. Nunca apliques LWW en silencio sobre datos de dinero.
3. **Si el dato fuera crítico de verdad** (no lo es aquí): bloqueo optimista con `version` por fila — escribir solo si la versión que tienes es la vigente, y si no, pedir resolución. Es la solución correcta y la más cara. **No la necesitas.**

## 5. Relojes: por qué un `timestamptz` no basta

**El problema real:** el PC de la caja es un equipo de escritorio. Se va la luz, la batería de la placa madre está muerta (tiene 8 años) y al arrancar el reloj dice **1 de enero de 2010**. O el dueño cambió la fecha para algo y se le olvidó. Ahora todas tus ventas tienen `ocurrido_at` en 2010 y:

- El reporte del día aparece vacío.
- La sincronización ordena esas ventas antes que todo.
- El cierre de turno no cuadra.

**La solución: un reloj lógico híbrido (HLC).** Combina el reloj de pared (para tener fechas útiles) con un contador lógico (para garantizar el orden):

```ts
// packages/core/src/sync/hlc.ts
// Formato: '<milisegundos en base36 con padding>-<contador en base36>-<device corto>'
// Ejemplo: '00a1b2c3d4e-0000-a3f9'
// Propiedades: monótono (nunca retrocede), comparable como texto, ordenable,
// y sigue siendo aproximadamente igual al reloj de pared.

type HLC = { ts: number; contador: number; device: string };

export function hlcAhora(anterior: HLC | null, device: string): HLC {
  const fisico = Date.now();

  if (!anterior) return { ts: fisico, contador: 0, device };

  // Si el reloj retrocedió (o es el mismo milisegundo), NO retrocedemos:
  // mantenemos el ts anterior e incrementamos el contador.
  if (fisico <= anterior.ts) {
    return { ts: anterior.ts, contador: anterior.contador + 1, device };
  }
  return { ts: fisico, contador: 0, device };
}

// Al recibir un HLC de otro dispositivo (en el pull) hay que "absorberlo"
// para que nuestro próximo HLC sea mayor que todo lo visto. Así el orden
// es consistente entre réplicas aunque los relojes estén desfasados.
export function hlcRecibir(local: HLC, remoto: HLC, device: string): HLC {
  const ts = Math.max(local.ts, remoto.ts, Date.now());
  if (ts === local.ts && ts === remoto.ts) return { ts, contador: Math.max(local.contador, remoto.contador) + 1, device };
  if (ts === local.ts) return { ts, contador: local.contador + 1, device };
  if (ts === remoto.ts) return { ts, contador: remoto.contador + 1, device };
  return { ts, contador: 0, device };
}

export const hlcSerializar = (h: HLC) =>
  `${h.ts.toString(36).padStart(12, '0')}-${h.contador.toString(36).padStart(4, '0')}-${h.device.slice(0, 8)}`;

export function hlcDeserializar(s: string): HLC {
  const [ts, contador, device] = s.split('-');
  return { ts: parseInt(ts, 36), contador: parseInt(contador, 36), device };
}
```

**Lo que esto te da:**

| Sin HLC | Con HLC |
|---------|---------|
| Reloj del PC en 2010 → reportes vacíos | El HLC nunca retrocede; los eventos se ordenan correctamente |
| Dos eventos en el mismo milisegundo → orden indefinido | El `contador` desempata de forma determinista |
| Cada réplica puede ordenar distinto → estados divergentes | Orden total consistente → convergencia garantizada |

**Y por si acaso, dos redes de seguridad:**

1. **Comprobar el reloj al arrancar.** Si `Date.now()` difiere de la fecha del último evento por más de 1 hora, avisa: *"El reloj de la computadora parece estar mal (fecha detectada: 1/1/2010). Corrígelo o las ventas tendrán fecha incorrecta."* Y bloquea solo el campo `occurred_at` mostrado, no la operación.
2. **Nunca uses `ocurrido_at` para ordenar la lógica de negocio con efectos** (por ejemplo, calcular el stock). Para eso está el orden de `server_seq` y el ledger. `ocurrido_at` es para **reportes y para que el humano entienda**, no para decidir.

## 6. Folios: el detalle que rompe el offline si no lo piensas

```sql
folio bigint GENERATED ALWAYS AS IDENTITY   -- ⚠️ requiere el servidor
```

**Offline no puedes pedirle el folio al servidor.** Y el cliente necesita un número de ticket en el momento. Solución: **el folio visible lo genera el dispositivo, con prefijo propio.**

```text
Terminal C1 (PC caja 1)  → folios  C1-000001, C1-000002, C1-000003...
Terminal MB (celular)    → folios  MB-000001, MB-000002...   (no aplica: no vende)
Terminal C2 (2.ª caja)   → folios  C2-000001, C2-000002...
```

```ts
export async function siguienteFolioLocal(cliente: ClienteSql, dispositivoId: string): Promise<string> {
  // El INSERT ... ON CONFLICT DO UPDATE es atómico: dos transacciones simultáneas no
  // pueden obtener el mismo número. Es lo mismo que hace `device_seq`.
  const { rows } = await cliente.query<{ numero: unknown; codigo: string | null }>(
    `WITH contador AS (
       INSERT INTO folio_counters (device_id, ultimo_folio) VALUES ($1, 1)
       ON CONFLICT (device_id) DO UPDATE
         SET ultimo_folio = folio_counters.ultimo_folio + 1, actualizado_at = now()
       RETURNING ultimo_folio
     )
     SELECT contador.ultimo_folio AS numero, devices.codigo
       FROM contador JOIN devices ON devices.id = $1`,
    [dispositivoId],
  );
  // …y si el dispositivo no existe o no tiene `codigo`, se lanza. Un prefijo vacío
  // produciría folios «-000123» en silencio, que es peor que un error.
  return `${rows[0].codigo}-${String(rows[0].numero).padStart(6, '0')}`;
}
```

> **Dos desvíos del boceto de arriba, al implementarlo (fase 0.5):**
>
> 1. **El contador se ancla al `device_id`, no al texto del prefijo.** El boceto usa
>    `folio_counters(terminal text PRIMARY KEY)`. Anclarlo al `device_id` da una clave
>    foránea de verdad (un dedazo al escribir el código no arranca un contador paralelo
>    desde cero) y el contador sobrevive a que alguien corrija el prefijo. El prefijo
>    sale de `devices.codigo`, que es único por índice parcial.
> 2. **`sales.folio_local` sigue siendo el número visible**; el prefijo ya no se guarda
>    aparte, se reconstruye.

**¿Por qué el prefijo y no un número global?** Porque un consecutivo global requiere coordinación (o el servidor). El prefijo hace que dos dispositivos no puedan generar el mismo folio **nunca**, sin coordinación, y además te dice de qué terminal salió la venta solo con mirarlo. `folio` (el `IDENTITY`) se sigue asignando en el servidor y sirve de orden interno y para reportes consolidados.

> ⚠️ **Inconsistencia pendiente de decidir.** `0003_seed_catalogos.sql` siembra un ajuste
> `prefijo_folio = "PAP"` («PAP-000123»), que contradice el diseño de esta sección: un
> prefijo **único** para todo el negocio no impide que dos cajas generen el mismo
> `PAP-000001`. La implementación usa el prefijo por terminal (`devices.codigo`), porque
> es el que da la garantía. El ajuste quedó sin uso; hay que borrarlo o darle otro papel.

**Nota fiscal:** si algún día facturas (CFDI), el folio fiscal lo asigna el PAC y ese sí exige conexión. Es una razón más para tratar la facturación como un módulo aparte que **no** vive en el camino de la venta.

## 7. El celular no necesita el catálogo completo

El celular en modo escáner **no consulta nada**: solo manda códigos y la PC resuelve. Eso hace que el emparejamiento sea instantáneo y que el celular funcione con 0 MB de datos sincronizados.

Solo en modo **conteo** y **consulta** necesita datos, y entonces se sincroniza una **vista ligera**:

```sql
CREATE VIEW v_catalogo_ligero AS
SELECT p.id,
       b.codigo AS barcode,
       p.nombre,
       p.precio_minor,
       p.ubicacion,
       c.path AS categoria_path,
       coalesce(sl.qty_base, 0) AS stock,
       p.tracks_stock
FROM products p
LEFT JOIN stock_levels sl ON sl.product_id = p.id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN product_barcodes b ON b.product_id = p.id AND b.es_primario AND b.deleted_at IS NULL
WHERE p.is_activo AND p.deleted_at IS NULL;
```

```ts
// Snapshots versionados: el celular descarga un delta, no todo.
GET /catalog/snapshot?since_version=4821

→ {
    version: 4903,                                      // versión del catálogo
    changed: [ { ...,  "_op": "upsert" }, ... ],        // solo lo que cambió
    deleted: [ "uuid-a", ... ],
    full_sync_required: false
  }
```

Regla: si el celular lleva más de 20 versiones atrasado (o más de 7 días sin conectar), se sincroniza completo. Es más barato que aplicar 4 000 deltas.

## 8. Reintentos: backoff con *jitter*

```ts
export async function conReintentos<T>(fn: () => Promise<T>, intento = 0): Promise<T> {
  const MAX = 8;
  try {
    return await fn();
  } catch (e) {
    if (intento >= MAX) throw e;
    if (esErrorPermanente(e)) {          // 401, 403, 413, 422 → no reintentar
      await moverARechazados(e);
      throw e;
    }
    // Backoff exponencial CON JITTER.
    // ⭐ Sin jitter, varios dispositivos reintentan en el mismo instante y
    //    sincronizan su "marea" (thundering herd) contra el servidor.
    const base = Math.min(60_000, 500 * 2 ** intento);
    const jitter = Math.random() * base * 0.3;
    await esperar(base + jitter);
    return conReintentos(fn, intento + 1);
  }
}

// Distinguir permanente de transitorio es clave: reintentar un 403 para siempre
// llena el disco de basura. Es un error frecuente y caro.
const esErrorPermanente = (e: any) =>
  [400, 401, 403, 404, 413, 422].includes(e?.status);
```

## 9. Cuándo sincronizar (disparadores)

| Disparador | Cuándo | Motivo |
|-----------|--------|--------|
| **Después de cada evento** | Inmediatamente, *fire and forget* | Sincronización casi en tiempo real cuando hay red |
| **Periódico** | Cada 60 s si hay red y hay outbox pendiente | Cubre los intentos fallidos |
| **Al volver la red** | `window.addEventListener('online')` | Lo obvio |
| **Al recuperar el foco** | `visibilitychange` | El PC que estuvo suspendido |
| **Al cerrar turno** | **Obligatorio antes de cerrar** | El cierre de turno debe llegar al servidor (o quedar encolado con aviso) |
| **Al arrancar la app** | Siempre | Poner al día lo que se acumuló |
| **Manual** | Botón "Sincronizar ahora" con indicador | El dueño necesita poder forzarlo y ver el resultado |

```text
┌─────────────────────────────────────────────────────────────┐
│  🔵 Sincronizado   ·   2 min                                 │
│                                                             │
│  🟡 4 pendientes   ·   reintentando      [ Sincronizar ]     │
│                                                             │
│  🔴 Sin conexión   ·   3 pendientes                          │
│     Las ventas se guardan localmente. No se pierde nada.     │
│                                                             │
│  🔴 2 rechazados   ·   ⚠️ REQUIERE TU REVISIÓN               │
└─────────────────────────────────────────────────────────────┘
```

**El indicador de estado debe ser visible siempre.** "3 pendientes" no es un error, es información. Y "2 rechazados" es una **alerta**, no un mensaje escondido: significa que algo que registraste no se aplicó.

## 10. Errores permanentes y dead letter

```sql
CREATE TABLE eventos_rechazados (
  id           uuid PRIMARY KEY,
  event_id     text NOT NULL,
  payload      jsonb NOT NULL,
  motivo       text NOT NULL,
  politica_id  text,
  intentos     int NOT NULL DEFAULT 0,
  resuelto_at  timestamptz,
  resolucion   text,                 -- 'aplicado_manual' | 'descartado' | 'corregido_y_reenviado'
  creado_at    timestamptz NOT NULL DEFAULT now()
);
```

**Regla de oro: un evento rechazado NUNCA se descarta en silencio.** Si el servidor rechazó una venta de $3 000 porque la política offline la marcó para revisión, el dueño tiene que ver:

```text
┌────────────────────────────────────────────────────────────────────┐
│ ⚠️ 2 OPERACIONES REQUIEREN TU REVISIÓN                            │
├────────────────────────────────────────────────────────────────────┤
│ Venta C1-000847      $3,240.00    18/10 20:14                     │
│ Motivo: venta offline mayor a $2,000 sin autorización             │
│ [ Ver detalle ]  [ Aprobar y aplicar ]  [ Anular venta ]          │
│                                                                    │
│ Descuento 20% en Lápiz Mirado                        $  0.60      │
│ Motivo: la política cambió después (v.12 → v.14)                  │
│ [ Ver detalle ]  [ Aprobar y aplicar ]  [ Rechazar ]              │
└────────────────────────────────────────────────────────────────────┘
```

[`Aprobar y aplicar`] reenvía el evento con un `grant` de autorización explícito del dueño, que se registra en `audit_log`. `Anular venta` genera el evento de anulación (una venta cancelada, no un borrado). **Nunca hay un "descartar" silencioso.**

## 11. Chequeo de integridad (tu red de seguridad nocturna)

Cada noche (o cada mañana al abrir, que es más útil porque lo ves) corre estas tres comprobaciones. Si alguna falla, avisa:

```sql
-- 1. El stock cacheado debe ser exactamente la suma del ledger. (doc 02 §4.2)
--    Debe devolver CERO filas.
SELECT product_id, stock_levels.qty_base AS cacheado, sum(stock_movements.qty_base) AS real
FROM stock_levels JOIN stock_movements USING (product_id)
GROUP BY 1, 2 HAVING stock_levels.qty_base <> sum(stock_movements.qty_base);

-- 2. No debe haber huecos en la secuencia de eventos por dispositivo.
SELECT device_id, max(device_seq), count(*) FROM event_log GROUP BY device_id
HAVING max(device_seq) <> count(*);
--    ⚠️ Puede haber falsos positivos si un dispositivo generó eventos y todavía
--       no los subió. Compara contra sync_cursors y solo alerta si el device
--       está al día.

-- 3. Ventas sin movimientos de stock (no debería existir si tracks_stock = true).
SELECT s.id, s.folio_local FROM sales s
WHERE s.estado = 'completada'
  AND EXISTS (SELECT 1 FROM sale_lines sl JOIN products p ON p.id = sl.product_id
              WHERE sl.sale_id = s.id AND p.tracks_stock)
  AND NOT EXISTS (SELECT 1 FROM stock_movements m
                  WHERE m.ref_type = 'sale' AND m.ref_id = s.id);
```

**Por qué esto importa más de lo que parece:** estos chequeos son lo que convierte "creo que el sistema funciona" en "sé que el sistema funciona". Sin ellos, un bug de sincronización se descubre como un descuadre de inventario 6 meses después, cuando ya no puedes reconstruir qué pasó.

## 12. Si algún día hay dos PCs vendiendo a la vez

Casi seguro no lo necesitas. Pero si vas a abrir una segunda caja, el camino recomendado **no** es permitir dos escritores:

1. **Mejor: separa por responsabilidad.** La caja 1 vende; la caja 2 es para fotocopias e impresión con su propio turno, y **no** comparte stock crítico. Cada una es autoridad de sus ventas. Funciona perfecto porque el stock que se comparte es "de cantidad alta" (hojas, tóner) y las diferencias se cuadran en el conteo.
2. **Alternativa: hacer el servidor el único escritor.** El PC local pasa a ser un *cliente con caché de solo lectura + cola de escritura* y quien decide el stock es el servidor. **Esto rompe el requisito de "vender sin internet"**, así que solo sirve si la segunda caja siempre tiene red.
3. **Lo que NO se debe hacer:** dos dispositivos vendiendo el mismo producto en paralelo y "arreglar" el stock después. En una papelería con 5 000 SKU, el stock de los productos de baja rotación nunca se cuadra, y el de los de alta rotación (hojas, lápices) te da diferencias que no puedes explicar.

## 13. Checklist de este módulo

**Diseño**
- [ ] `outbox` **transaccional**: estado + evento en la misma transacción
- [ ] **Un solo** camino de mutación (`emitirEvento`) que incluya autorización + auditoría
- [ ] `device_seq` por dispositivo + `server_seq` global como único cursor de lectura
- [ ] `event_id` **ULID** con `UNIQUE` en ambos extremos → idempotencia real
- [ ] HLC (reloj lógico híbrido) para ordenar, con absorción de HLC remotos
- [ ] Aviso al arrancar si el reloj del sistema parece incorrecto
- [ ] **Folios con prefijo por terminal** (`C1-000123`), nunca consecutivo global offline
- [ ] Políticas que evitan conflictos: precios **no** se editan offline (P29)

**Protocolo**
- [ ] `POST /sync/push` con: verificación de dispositivo, límite de lote, detección de huecos, idempotencia, **re-validación de políticas**
- [ ] `GET /sync/pull` ordenando por `server_seq`, con `limit` y `has_more`
- [ ] Aplicación idempotente en el cliente (`eventos_aplicados`) y recálculo de proyecciones al final del lote
- [ ] Backoff exponencial **con jitter** y distinción entre errores transitorios y permanentes
- [ ] Disparadores: por evento, periódico, al volver la red, al recuperar foco, al cerrar turno, al arrancar, manual

**Robustez**
- [ ] `eventos_rechazados` (dead letter) **visible al dueño** con acciones `Aprobar` / `Anular`
- [ ] Nunca se descarta un evento en silencio
- [ ] Indicador de estado siempre visible (sincronizado / pendientes / sin conexión / rechazados)
- [ ] Chequeo nocturno de las **3 consultas de integridad** con aviso
- [ ] `stock_levels` siempre reconciliable contra `stock_movements`

**Pruebas (las que de verdad importan)**
- [ ] Apagar el WiFi a media venta → la venta se completa y se sincroniza al volver
- [ ] Sincronizar el mismo lote dos veces → no hay duplicados
- [ ] Cambiar la fecha del PC a 2010 → los eventos siguen ordenándose bien
- [ ] 200 ventas offline → se suben en ≤ 10 lotes, sin pérdidas ni duplicados
- [ ] Rechazar un evento por política → aparece en la cola de revisión del dueño
