# @papeleria/db

El esquema y las migraciones. **Un solo juego de archivos .sql corre en PGlite
(navegador, offline) y en PostgreSQL 16 (servidor)**: ahí está la promesa, y este
paquete existe para que se pueda comprobar.

```text
migrations/
  0001_init.sql             esquema núcleo: catálogo, ledger, ventas, sync, auditoría
  0002_rbac_abac.sql        roles, permisos, políticas, step-up + semillas de RBAC
  0003_seed_catalogos.sql   unidades, tasas de impuesto, categorías, configuración
src/
  runner.ts                 aplica las migraciones y detecta divergencias
  archivos.ts               lee los .sql desde disco (sólo Node)
  esquema.ts                lee el catálogo y compara motor contra motor
  adaptadores.ts            envuelve PGlite o pg en la interfaz que el runner espera
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
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pruebas -e POSTGRES_DB=papeleria_pruebas postgres:16-alpine
DATABASE_URL_PRUEBAS=postgres://postgres:pruebas@localhost:5432/papeleria_pruebas pnpm test
```

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

- **Las 31 políticas del doc 06 §5 no se siembran todavía.** La gramática de
  `condicion` que necesitan no está especificada en los documentos: P1 ("precio
  nuevo menor al costo") necesita comparar dos campos del contexto entre sí y las
  formas publicadas sólo comparan un campo contra un valor. Definir esa gramática
  dentro de una migración sería diseñar la interfaz del evaluador desde el SQL, y
  sin evaluador no habría forma de probar que las reglas hacen lo que dicen.
  Llegan en la tarea 0.6, junto con `evaluar()` y la tabla de tests del doc 06 §9.
- **`margin_rules`** (doc 12) es la migración `0006_precios.sql`, no una de estas
  tres.
