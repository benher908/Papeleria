/**
 * @papeleria/db — esquema, migraciones y compatibilidad entre motores.
 *
 * Un solo juego de migraciones corre en PGlite (navegador, offline) y en
 * PostgreSQL 16 (servidor). Este paquete es el que lo sostiene:
 *
 *   `runner`      aplica las migraciones y detecta que un archivo ya aplicado cambió
 *   `esquema`     lee el catálogo y compara PGlite contra Postgres línea a línea
 *   `adaptadores` envuelve PGlite o `pg` en la interfaz mínima que el runner espera
 *
 * `archivos` (leer los .sql desde disco) NO se exporta aquí a propósito: usa
 * `node:fs`. Quien lo necesite lo importa de `@papeleria/db/node`.
 */

export * from './runner';
export * from './esquema';
export * from './adaptadores';
