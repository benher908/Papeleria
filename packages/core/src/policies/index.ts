/**
 * Autorización: RBAC + ABAC (docs/06).
 *
 * `evaluar()` es puro y sin IO a propósito: corre idéntico en las tres capas de docs/06
 * §7 —el caso de uso, el celular sin internet y el servidor, que no se fía del cliente—
 * con las **mismas** políticas, que son datos y no código desplegado.
 *
 *   evaluar(ctx, politicas, permisos)  →  { permitido, motivo, obligaciones, politica_id }
 *
 * Las políticas viven en la tabla `policies`; quien las lee y las valida es
 * `@papeleria/db`, que sí conoce el esquema.
 */

export * from './tipos';
export * from './campos';
export * from './condicion';
export * from './evaluar';
