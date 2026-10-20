/**
 * EL ARRANQUE DE LA APP — qué se ve y en qué orden.
 *
 *   1. ¿Este navegador puede abrir la base? (contexto seguro, Web Locks, worker, IndexedDB)
 *   2. Abrir la base y aplicar lo que falte. Eso ya lo hace `baseLocal()`.
 *   3. ¿Hay una sesión guardada que siga valiendo? Entonces se entra sin preguntar.
 *   4. ¿Hay cuenta pero no sesión? Entrar. ¿No hay cuenta? Primer arranque.
 *
 * El paso 3 es la mitad del criterio de esta tarea: recargar la página no puede pedir la
 * contraseña otra vez mientras la sesión siga viva. La otra mitad es que deje de valer
 * cuando debe: al volver a la pestaña se comprueba, y si venció se vuelve a la entrada con
 * el motivo. Sin esa comprobación, una pestaña abierta toda la noche seguiría «dentro»
 * hasta que alguien la recargara, que es justo lo contrario de lo que sirve un bloqueo.
 *
 * Todas las escrituras de sesión van por `enTransaccionDuradera()`: una sesión que se abre
 * y no llega a disco es una sesión que desaparece al recargar.
 */

import { cerrarSesion, hayUsuarios, verificarSesion } from '@papeleria/db';
import type { Root } from 'react-dom/client';

import { montarEntrada, type SesionIniciada } from './auth/pantalla';
import {
  guardarDispositivo,
  leerToken,
  olvidarToken,
  type DispositivoGuardado,
} from './auth/almacen';
import { baseLocal, type BaseLocal } from './db/baseLocal';
import { comoClienteTransaccional, enTransaccionDuradera } from './db/cliente';
import { crearColaEscaneo } from './escaneo/cola';
import { instalarLectorHid } from './escaneo/hid';
import { montarProductos } from './productos/montar';
import { aviso, capasQueFaltan, crear, mensaje } from './ui';

export async function montarApp(raiz: HTMLElement): Promise<void> {
  raiz.replaceChildren();

  const faltan = capasQueFaltan();
  if (faltan.length > 0) {
    raiz.append(
      aviso('Este navegador no puede usar esta app', faltan, [
        'En el PC, abre la app en http://localhost (cuenta como contexto seguro).',
        'Desde el teléfono hace falta HTTPS de verdad: ver tools/prueba-camara.',
      ]),
    );
    return;
  }

  let base: BaseLocal;
  try {
    base = await baseLocal();
  } catch (causa) {
    raiz.append(
      aviso('No se pudo abrir la base local', [mensaje(causa)], [
        'Suele ser el worker o el almacenamiento. Abre las herramientas del navegador → Consola, donde el worker también escribe.',
      ]),
    );
    return;
  }

  // Se pregunta una sola vez: en esta pantalla no hay forma de que la cuenta aparezca o
  // desaparezca sin pasar por aquí.
  let hayCuenta = await hayUsuarios(comoClienteTransaccional(base));
  let sesion: SesionIniciada | null = null;

  /**
   * El lector HID sólo escucha mientras hay sesión abierta.
   *
   * En la pantalla de entrada, cada tecla es una contraseña y no hay nada que escanear;
   * dejar el lector puesto ahí sería, además, una forma de que el `preventDefault()` del
   * Enter se comiera el envío del formulario.
   */
  let desinstalarHid: (() => void) | null = null;

  /**
   * La raíz de React de la zona de trabajo.
   *
   * Se guarda para desmontarla al salir. No es cosmético: un árbol montado sobre un nodo
   * que ya se quitó del documento sigue vivo, con sus temporizadores y sus consultas, y
   * además se quedaría con el callback de una sesión que ya no existe.
   */
  let raizReact: Root | null = null;

  function mostrarCaja(actual: SesionIniciada): void {
    sesion = actual;
    raizReact?.unmount();
    raizReact = null;
    raiz.replaceChildren();

    desinstalarHid?.();
    const cola = crearColaEscaneo();
    desinstalarHid = instalarLectorHid(cola);

    const barra = crear('div', 'barra');
    barra.append(
      crear('strong', 'quien', actual.usuario.nombre),
      crear('span', 'donde', `caja ${actual.dispositivo.codigo}`),
      crear('span', 'crecer'),
      botonSalir(() => mostrarEntrada()),
    );
    raiz.append(barra);

    const contenedor = crear('div');
    raiz.append(contenedor);
    raizReact = montarProductos(contenedor, { base, sesion: actual, cola });
  }

  function mostrarEntrada(nota?: string): void {
    sesion = null;
    raizReact?.unmount();
    raizReact = null;
    desinstalarHid?.();
    desinstalarHid = null;
    montarEntrada(raiz, base, {
      hayCuenta,
      ...(nota === undefined ? {} : { nota }),
      alEntrar: (nueva) => {
        hayCuenta = true;
        mostrarCaja(nueva);
      },
    });
  }

  /** Reanudar la sesión guardada, si la hay. */
  const token = leerToken();
  if (token === null) {
    mostrarEntrada();
  } else {
    const activa = await revalidar(base, token);
    if (activa === null) {
      olvidarToken();
      mostrarEntrada('La sesión guardada ya no vale. Vuelve a entrar.');
    } else {
      const dispositivo = await dispositivoDeLaSesion(base, activa.dispositivoId);
      guardarDispositivo(dispositivo);
      mostrarCaja({
        usuario: activa.usuario,
        dispositivo,
        idle_expires_at: activa.idle_expires_at,
        absolute_expires_at: activa.absolute_expires_at,
      });
    }
  }

  // Al volver a la pestaña, la sesión se revisa. Es lo que convierte el bloqueo por
  // inactividad en algo que de verdad ocurre y no en una casilla de un documento.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || sesion === null) return;

    void (async () => {
      const guardado = leerToken();
      const sigue = guardado === null ? null : await revalidar(base, guardado);
      if (sigue === null) {
        olvidarToken();
        mostrarEntrada('La sesión venció. Vuelve a entrar.');
      }
    })();
  });

  /** `verificarSesion` sin que un fallo de la base tumbe la pantalla. */
  async function revalidar(actual: BaseLocal, cual: string) {
    return await enTransaccionDuradera(actual, (tx) => verificarSesion(tx, cual)).catch(
      () => null,
    );
  }

  /** El botón de salir: revoca la sesión en la base y olvida el token. */
  function botonSalir(alSalir: () => void): HTMLButtonElement {
    const boton = crear('button', 'boton secundario', 'Salir');
    boton.type = 'button';
    boton.addEventListener('click', () => {
      void (async () => {
        boton.disabled = true;
        const cual = leerToken();
        if (cual !== null) {
          // Si la base no contesta, se olvida el token igual: seguir «dentro» porque la
          // revocación falló sería peor que dejar una fila sin revocar.
          await enTransaccionDuradera(base, (tx) => cerrarSesion(tx, cual)).catch(() => null);
        }
        olvidarToken();
        alSalir();
      })();
    });
    return boton;
  }
}

/**
 * El dispositivo de la sesión, leído de la base.
 *
 * Se lee en vez de confiar en `localStorage` porque el token y el dispositivo viven en el
 * mismo sitio: si uno está, el otro también debería. Y si alguien borró sólo una clave,
 * esto lo arregla en vez de mostrar una caja llamada «—».
 */
async function dispositivoDeLaSesion(
  base: BaseLocal,
  dispositivoId: string,
): Promise<DispositivoGuardado> {
  const fila = await base.consultarUno<{ codigo: string | null }>(
    `SELECT codigo FROM devices WHERE id = $1`,
    [dispositivoId],
  );
  return { id: dispositivoId, codigo: fila?.codigo ?? '—' };
}
