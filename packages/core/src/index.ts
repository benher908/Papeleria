/**
 * @papeleria/core — el núcleo del sistema.
 *
 * Regla de oro (docs/01 §3): este paquete NO depende de la plataforma.
 * Corre idéntico en el navegador (caja y celular), en el servidor local y en el VPS.
 * Es lo que permite que la autorización y el cálculo de dinero sean los mismos
 * en los tres lados, con o sin internet.
 *
 * Sin dependencias de runtime. Solo TypeScript puro y `bigint`.
 */

export * from './dinero';
export * from './codigos-barras/ean13';
export * from './precios/calcularPrecio';
export * from './ventas/totales';
export * from './ids/azar';
export * from './ids/ulid';
export * from './ids/uuidv7';
export * from './sync/hlc';
