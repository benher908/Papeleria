/**
 * DÓNDE VIVE LA SESIÓN — y por qué aquí, sabiendo que `docs/07 §3` dice que no.
 *
 * El documento es tajante: el refresh token va en una cookie `httpOnly`, nunca en
 * `localStorage`, porque `localStorage` lo lee cualquier script de la página. Ese sigue
 * siendo el destino final y no se discute.
 *
 * Pero hoy no hay servidor: la autenticación es local (no existe `apps/api`, y la única
 * cuenta vive en el PGlite de este navegador). Una cookie `httpOnly` la pone **un
 * servidor** con una cabecera HTTP; `document.cookie` no puede marcar `httpOnly`. Sin
 * servidor, la elección no es «cookie `httpOnly` o `localStorage`»: es «`localStorage` o
 * que la sesión no sobreviva a recargar la página» — y lo segundo rompe justamente el
 * criterio de esta tarea («la sesión persiste»).
 *
 * Se usa `localStorage`, con tres cosas dichas en voz alta:
 *
 *   1. En la base el token queda **hasheado** (`sessions.refresh_token_hash`). Quien lea
 *      la base no puede reutilizar ninguna sesión. Lo de aquí es el original, y es
 *      exactamente lo que hay que dejar de guardar.
 *   2. Esta página no carga scripts de terceros, así que hoy no hay un XSS que pueda
 *      leerlo. El día que haya contenido de terceros, esto se cae — y por eso el punto 3.
 *   3. Cuando exista `apps/api`, este módulo se **borra** y el token se va a una cookie
 *      `httpOnly`. No se «adapta»: se borra, y con él el uso de `localStorage`.
 *
 * El id del dispositivo no es un secreto (es una fila de `devices`) y se guarda al lado
 * para que este navegador sepa cuál de las cajas es, en vez de registrarse de nuevo en
 * cada arranque.
 */

const CLAVE_SESION = 'papeleria.sesion';
const CLAVE_DISPOSITIVO = 'papeleria.dispositivo';

export interface DispositivoGuardado {
  readonly id: string;
  readonly codigo: string;
}

/** El token de la sesión, o `null` si este navegador no tiene ninguna. */
export function leerToken(): string | null {
  return leerTexto(CLAVE_SESION);
}

export function guardarToken(token: string): void {
  localStorage.setItem(CLAVE_SESION, token);
}

export function olvidarToken(): void {
  localStorage.removeItem(CLAVE_SESION);
}

export function leerDispositivo(): DispositivoGuardado | null {
  const crudo = leerTexto(CLAVE_DISPOSITIVO);
  if (crudo === null) return null;

  try {
    const dato: unknown = JSON.parse(crudo);
    if (
      typeof dato === 'object' &&
      dato !== null &&
      typeof (dato as DispositivoGuardado).id === 'string' &&
      typeof (dato as DispositivoGuardado).codigo === 'string'
    ) {
      return dato as DispositivoGuardado;
    }
  } catch {
    // Lo que haya ahí no lo escribió esta app. Se ignora y se registra una caja nueva:
    // un valor ilegible no puede dejar la pantalla en blanco.
  }
  return null;
}

export function guardarDispositivo(dispositivo: DispositivoGuardado): void {
  localStorage.setItem(CLAVE_DISPOSITIVO, JSON.stringify(dispositivo));
}

function leerTexto(clave: string): string | null {
  try {
    const valor = localStorage.getItem(clave);
    return valor === null || valor === '' ? null : valor;
  } catch {
    // En modo privado algunos navegadores lanzan al tocar `localStorage`. No poder
    // recordar la sesión es una molestia; reventar aquí sería una pantalla en blanco.
    return null;
  }
}
