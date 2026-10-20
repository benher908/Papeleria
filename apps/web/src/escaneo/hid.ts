/**
 * El adaptador del lector HID al navegador.
 *
 * La lógica de "esto es una máquina o una persona" vive en `@papeleria/core`
 * (`LectorHid`), pura y probada en Node. Aquí sólo queda lo que necesita el DOM:
 * escuchar en fase de **captura** (antes de que el campo enfocado vea la tecla),
 * decidir si hay que impedir que llegue, y publicar el código en la cola.
 *
 * Escucha en `window` y no en un `<input>` a propósito: un lector HID no tiene por qué
 * saber dónde está el foco. Ésa es toda su gracia y todo su peligro —el `Enter` del
 * lector puede enviar el formulario abierto y "cobrar" una venta sin querer—, y por eso
 * el `preventDefault()` del cierre es la parte que no se puede olvidar.
 */

import { LectorHid, type OpcionesLectorHid } from '@papeleria/core';

import type { ColaEscaneo } from './cola';

export interface OpcionesInstalarHid extends OpcionesLectorHid {
  /** Dónde escuchar. Por defecto `window`. */
  readonly objetivo?: EventTarget;

  /** El reloj. Inyectable para probarlo sin esperar. Por defecto `performance.now()`. */
  readonly ahora?: () => number;
}

/**
 * Instala el lector y devuelve cómo desinstalarlo.
 *
 * Desinstalar importa: la entrada (el login) no debe tener el lector puesto, porque ahí
 * todo lo que se teclea es una contraseña.
 */
export function instalarLectorHid(
  cola: ColaEscaneo,
  opciones: OpcionesInstalarHid = {},
): () => void {
  const { objetivo = window, ahora = () => performance.now(), ...opcionesLector } = opciones;
  const lector = new LectorHid(opcionesLector);

  const alTeclear = (evento: Event): void => {
    const tecla = evento as KeyboardEvent;
    const lectura = lector.alimentar(tecla.key, ahora());
    const enCampo = esCampoDeTexto(tecla.target);

    // Se consume lo que ya es claramente un escaneo. La excepción es el cierre: el
    // Enter de un código se consume SIEMPRE, también dentro de un campo, porque si no
    // enviaría el formulario abierto (el bug clásico del POS).
    if (lectura.consumir && (!enCampo || lectura.codigo !== undefined)) {
      tecla.preventDefault();
      tecla.stopPropagation();
    }

    if (lectura.codigo === undefined) return;

    console.log(`[hid] ${lectura.codigo} · ${lectura.msPorCaracter} ms/carácter`);
    cola.emitir({
      codigo: lectura.codigo,
      origen: 'hid',
      leido_at: new Date().toISOString(),
      ms_por_caracter: lectura.msPorCaracter,
    });
  };

  objetivo.addEventListener('keydown', alTeclear, true);
  return () => {
    objetivo.removeEventListener('keydown', alTeclear, true);
  };
}

/** ¿El foco está en un sitio donde una persona escribe? */
function esCampoDeTexto(objetivo: EventTarget | null): boolean {
  if (!(objetivo instanceof HTMLElement)) return false;
  if (objetivo.isContentEditable) return true;
  return (
    objetivo.tagName === 'INPUT' || objetivo.tagName === 'TEXTAREA' || objetivo.tagName === 'SELECT'
  );
}
