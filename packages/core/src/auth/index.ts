/**
 * AUTENTICACIÓN — las reglas puras.
 *
 * Aquí no hay criptografía ni base de datos: la contraseña se *revisa* (largo,
 * seguidillas) y la sesión se *calcula* (vencimientos), pero no se guarda ni se firma
 * nada. Eso vive en `@papeleria/db` (`auth.ts`), que es donde la regla se encuentra con
 * la fila.
 */

export * from './contrasena';
export * from './politicas';
