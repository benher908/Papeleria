# @papeleria/db

El esquema y las migraciones. **Un solo juego de archivos .sql corre en PGlite
(navegador, offline) y en PostgreSQL 16 (servidor)**: ahí está la promesa, y este
paquete existe para que se pueda comprobar.

```text
migrations/
  0001_init.sql             esquema núcleo: catálogo, ledger, ventas, sync, auditoría
  0002_rbac_abac.sql        roles, permisos, políticas, step-up + semillas de RBAC
  0003_seed_catalogos.sql   unidades, tasas de impuesto, categorías, configuración
  0004_eventos.sql          device_counters, folio_counters y devices.codigo
  0005_politicas.sql        las 30 reglas de autorización, como datos
src/
  runner.ts                 aplica las migraciones y detecta divergencias
  archivos.ts               lee los .sql desde disco (sólo Node)
  esquema.ts                lee el catálogo y compara motor contra motor
  adaptadores.ts            envuelve PGlite o pg en la interfaz que el runner espera
  contadores.ts             device_seq, HLC y folio local: sin huecos y sin repetir
  eventos.ts                emitirEvento(): estado + evento + auditoría en una transacción
  autorizacion.ts           carga permisos, políticas y step-up, y llama a evaluar()
```

## Uso

En el servidor (Node):

```ts
import { Client } from 'pg';
import { adaptarPg, migrar } from '@papeleria/db';
import { cargarMigraciones } from '@papeleria/db/node';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
await migrar(adaptarPg(pg), await cargarMigraciones('./migrations'));
```

En el navegador (PGlite): se importan los `.sql` como texto con Vite, se arma la
misma lista `Migracion[]` y se llama al mismo `migrar()`. Por eso `runner.ts` no
importa nada de Node.

## `emitirEvento()`: el único camino de mutación

Cualquier cambio del negocio —una venta, un ajuste de stock, un cambio de precio— pasa
por aquí. Escribe **estado + evento + auditoría en una sola transacción**: o entra todo,
o no entra nada. Es lo que impide el fallo clásico de «se guardó la venta y se cortó la
luz antes de encolarla», que en un sistema offline significa una venta que nunca llega
al servidor.

```ts
import { autorizar, emitirEvento, siguienteFolioLocal } from '@papeleria/db';

const evento = await emitirEvento<'sale.created', PayloadVenta>(cliente, {
  tipo: 'sale.created',
  dispositivoId: ID_TERMINAL,
  usuarioId: ID_USUARIO,

  // Obligatorio y sin valor por defecto: no hay ningún «permitir todo» escondido en
  // la biblioteca. `autorizar()` carga permisos, políticas y step-up DENTRO de la
  // transacción (por eso recibe el `tx`), y si al contexto le falta un dato que una
  // regla vigente necesita, lanza en vez de decidir a ciegas.
  autorizar: (evento, tx) =>
    autorizar(tx, {
      usuarioId: ID_USUARIO,
      dispositivoId: ID_TERMINAL,
      permiso: 'ventas:crear',
      recurso: { tipo: 'venta', monto_minor: 4500, descuento_pct: 0, descuento_minor: 0 },
    }),

  // Se ejecuta DENTRO de la transacción. Por eso el folio se asigna aquí y no antes:
  // si el resto fallara, el número de ticket se revierte con todo lo demás y no queda
  // un hueco que parece una venta borrada.
  payload: async (tx, datos) => ({
    venta_id: uuidV7(),
    folio_local: await siguienteFolioLocal(tx, datos.device_id),
    total_minor: 4500,
  }),

  aplicarEstado: async (tx, evento) => {
    await tx.query(
      `INSERT INTO sales (id, folio_local, …, device_id, evento_id, ocurrido_at)
       VALUES ($1, $2, …, $3, $4, $5)`,
      [
        evento.payload.venta_id,
        evento.payload.folio_local,
        evento.device_id,
        // ⭐ La venta queda atada a su evento. Por esto `aplicarEstado` recibe el
        // evento completo y no va sin argumentos.
        evento.event_id,
        evento.occurred_at,
      ],
    );
  },
});
```

Qué garantiza, y cómo se comprueba (`src/eventos.test.ts`, 10 pruebas):

| Propiedad | Cómo se fija |
|-----------|--------------|
| Estado y evento entran juntos | La venta de prueba escribe venta, líneas, movimiento de stock, `outbox` y `audit_log`; se comprueba que `sales.evento_id == outbox.event_id` |
| Si el estado falla, no queda nada | Se revienta a propósito después de escribir; ni una fila, y los contadores **ni siquiera existen** (el `INSERT` que los crea también se revirtió) |
| Ni un `device_seq` ni un folio gastado | Tras un fallo, el siguiente evento usa el número que le tocaba, no el siguiente |
| El HLC nunca retrocede | Con el reloj inyectado saltando a 2010, los HLC siguen creciendo |
| Un evento denegado no escribe nada | `autorizar` devuelve `permitido: false` y el error lleva el motivo |

Los números los lleva `contadores.ts`: `siguienteSeqYHlc()` (el `device_seq` y el último
HLC, en la misma fila y con cerrojo) y `siguienteFolioLocal()` (el folio visible de la
terminal). Los tres viven en `device_counters` / `folio_counters`, que son estado **local
del dispositivo** — igual que `outbox` y `sync_cursors`, no se sincronizan.

## `autorizar()`: quién puede hacer qué

`@papeleria/core` decide (`evaluar()`, puro, sin IO); este paquete es quien junta los
datos. `autorizar(tx, entrada)` hace, dentro de la transacción del evento:

1. **RBAC.** Los permisos del usuario salen de `user_roles` → `role_permissions`,
   filtrando `expira_at`. Un rol de temporada se revoca solo el día que vence.
2. **ABAC.** Las reglas de `policies` (las 30 de `0005_politicas.sql`), validadas al
   cargarlas: un campo mal escrito lanza **nombrando el campo**, en vez de apagar una
   regla de seguridad en silencio.
3. **Step-up.** `step_up_grants`, acotado a la acción (`motivo`) y, si se pasa
   `entidadId`, al objeto concreto. Autorizar una cancelación no autoriza un retiro.
4. **Completitud del contexto.** `camposFaltantes()` saca los campos que necesitan las
   reglas aplicables; si falta alguno, lanza `ErrorContextoIncompleto`. Sin eso,
   olvidar `recurso.descuento_pct` dejaría pasar un descuento del 40 % sin pedir la
   autorización del dueño, y nadie se enteraría.
5. **La decisión.** `evaluar()` con deny-overrides: una sola regla que deniegue gana, y
   las obligaciones de las demás se acumulan.

| Propiedad | Cómo se fija |
|-----------|--------------|
| La tabla del doc 06 §9 pasa entera | `autorizacion.test.ts` corre sus 10 casos contra las **reglas y los permisos reales**, no contra fixtures |
| Deny-overrides | "cajero NO ve costos" y "precio bajo el costo" se deniegan aunque el rol tenga el permiso |
| Las obligaciones se acumulan | Descuento del 40 % → `step_up` + `motivo_obligatorio` + `notificar_dueno` |
| El step-up satisfecho deja de pedirse, y lo demás se queda | Se inserta un `step_up_grants` vigente y se comprueba que desaparece `step_up` pero no el motivo |
| Un permiso sensible pide autorización aunque no tenga regla | `config:editar` (`es_sensible`) devuelve `step_up`; `dispositivos:revocar` (P22) no |
| Un contexto incompleto es un error, no un agujero | `autorizar()` con una venta sin `descuento_pct` lanza nombrándolo |

## Lo que el runner garantiza

| Garantía | Por qué importa |
|----------|-----------------|
| Cada archivo va en **una transacción** junto con su registro | Si el proceso muere a media migración, no queda un esquema a medias sin constancia |
| **Idempotente** | Llamarlo en cada arranque es seguro: lo ya aplicado no se repite |
| **Detecta divergencias** | Si un archivo ya aplicado cambió, lanza `ErrorMigracionDivergente`. Sin esto, el PC y el celular quedan con esquemas distintos y nadie se entera |
| **Reporta huérfanas** | Filas aplicadas cuyo archivo ya no existe: casi siempre es una migración borrada por error |
| **Nombra el archivo que falló** | El error del motor se envuelve con el nombre de la migración |

## La prueba de compatibilidad

```bash
pnpm test                 # PGlite, sin dependencias externas
```

Para incluir el PostgreSQL real (destruye el esquema `public` de esa base):

```bash
docker run --rm -d --name papeleria-pruebas-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=pruebas -e POSTGRES_DB=papeleria_pruebas postgres:16-alpine
DATABASE_URL_PRUEBAS=postgres://postgres:pruebas@localhost:55432/papeleria_pruebas pnpm test
docker rm -f papeleria-pruebas-pg
```

> Se usa el **55432** y no el 5432 a propósito: en esta máquina hay un PostgreSQL
> nativo escuchando en el 5432, y el test **borra** el esquema `public` de la base a
> la que se conecta. Con el puerto cambiado, es imposible que le pegue al de verdad.

Sin `DATABASE_URL_PRUEBAS` las dos pruebas que necesitan el motor real se **saltan**
(aparecen como `skipped`); el resto corre igual contra PGlite. Son 90 pruebas contra
PostgreSQL y 88 + 2 saltadas con sólo PGlite.

El test levanta un PGlite limpio, aplica las migraciones, hace lo mismo en el
Postgres, y compara los dos catálogos línea a línea (tablas, columnas con su tipo
y su `NOT NULL`, índices, restricciones, funciones y disparadores). Si difieren,
falla con un listado legible de las diferencias.

### Detalles de la comparación

- **Se ignoran las restricciones `NOT NULL` de `pg_constraint`.** PostgreSQL 17 las
  movió ahí con el tipo `n`, y PGlite puede traer otra versión que el servidor.
  Compararlas daría falsos positivos por diferencia de versión. El `NOT NULL` se
  compara igual, pero columna por columna, donde no depende de la versión.
- **Todo se filtra por `schemaname = 'public'`** para no comparar el catálogo
  interno de Postgres, que cambia entre versiones por diseño.

### Qué destapó al correrla de verdad

La promesa de compatibilidad no se puede comprobar sin los dos motores, y por eso
esta prueba se salta sola cuando no hay Postgres — lo cual tiene una trampa: un
error dentro de la propia consulta de introspección no se nota hasta que alguien
la corre en serio. La primera ejecución real (PostgreSQL 16.14 en Docker) encontró
exactamente eso:

1. `'identity: ' || attidentity` no compila. `attidentity` y `attgenerated` son del
   tipo interno `"char"`, y concatenar un literal con `"char"` es ambiguo para el
   planificador: *operator is not unique: unknown || "char"*. Va con `::text`.
2. Lo mismo con `con.contype` al devolverlo como columna.

Con eso corregido, los dos catálogos coinciden **en todo**: tablas, columnas con su
tipo y su `NOT NULL`, índices (incluido el GIN sobre `to_tsvector('spanish', …)`),
restricciones, funciones y disparadores.

## Reglas para que un solo archivo sirva en los dos motores

| Permitido | Prohibido | Por qué |
|-----------|-----------|---------|
| `CREATE TABLE`, índices, `CHECK`, `GENERATED ... STORED` | `pg_cron`, `pg_partman`, `dblink` | No existen en WASM |
| `plpgsql` simple (triggers, funciones) | `SECURITY DEFINER` + roles de base | PGlite corre sin roles |
| `jsonb`, `text[]`, `numeric`, `uuid`, `inet`, `bytea` | `CREATE TYPE ... AS ENUM` con mucha lógica | Con `text` + `CHECK` es equivalente y portable |
| `to_tsvector('spanish', ...)` | Extensiones que hay que cargar aparte | PGlite no las trae todas |
| `CREATE VIEW` | `CREATE MATERIALIZED VIEW` con refresco concurrente | No existe en PGlite |
| `GENERATED ALWAYS AS IDENTITY` | `serial` con secuencia compartida | La identidad funciona igual en los dos |

## Datos de referencia con UUID fijo

`0002` y `0003` siembran roles, permisos, unidades, tasas, categorías y
configuración con **UUID literales**, no aleatorios. Es una decisión, no una
comodidad: son datos que el sistema define y que todos los dispositivos deben
compartir. Si 'pieza' o 'dueno' tuvieran un uuid distinto en el PC y en el
celular, al sincronizar el servidor vería dos filas irreconciliables y el catálogo
se partiría en dos sin que nada fallara de inmediato.

Los literales siguen el patrón `01900000-0000-7000-<familia>-<consecutivo>`, donde
la familia dice de qué tabla es el dato: `8000` roles, `8001` permisos, `8002`
unidades, `8003` tasas de impuesto, `8004` categorías.

## Qué falta aquí a propósito

- **`autorizar` no tiene implementación por defecto, ni siquiera una que permita
  todo.** `emitirEvento()` la exige en cada llamada y no la trae puesta: la pone el
  llamador, normalmente con `autorizar(tx, …)`. Es incómodo a propósito. La
  alternativa —traer una política de cortesía que devuelva `permitido: true`— es la
  que se olvida de borrar y acaba en producción. En `eventos.test.ts` la que permite
  todo se declara dentro del archivo de prueba, con su comentario, y no se exporta.
- **P28 está incompleta y se dice.** La regla del doc 06 §5 pide que, sin red, el
  descuento "se limite al 5 %". Eso no es una decisión binaria con obligaciones: es
  **modificar un valor**, y el lenguaje de políticas (`permitir` / `denegar` /
  obligaciones) no puede reescribir el dato. La fila siembra la mitad que sí se puede
  (`marcar_para_revision`) y el tope queda pendiente de una capacidad que hoy no
  existe. Está anotado en el `motivo` de la propia política, en
  `0005_politicas.sql` y en docs/06 §5: abierto, no escondido.
- **`margin_rules`** (doc 12) es la migración `0006_precios.sql`, no una de estas
  cuatro.
