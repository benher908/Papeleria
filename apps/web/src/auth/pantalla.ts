/**
 * LA PANTALLA DE ENTRADA — dos modos en el mismo sitio.
 *
 * Si la base no tiene ninguna cuenta, lo que toca no es «entrar» sino **crear la cuenta
 * de la dueña**: no hay servidor del que traerla, así que el primer arranque es también
 * el registro. Si ya hay cuenta, es el formulario de siempre.
 *
 * Todo pasa por `@papeleria/db`: la pantalla no hashea nada, no compara nada y no decide
 * nada. Recoge dos cadenas, llama a `crearUsuario()` o a `entrar()`, y muestra lo que le
 * contesten.
 *
 * Recibe la `BaseLocal` (y no un cliente ya envuelto) por un motivo concreto: las
 * escrituras de la autenticación son las que crean o destruyen acceso, y van por
 * `enTransaccionDuradera()`, que pide el volcado a disco antes de dar por hecha la
 * operación. (`syncToFs()` no lo espera en modo relajado; el detalle y su deuda están
 * anotados en `apps/web/README.md`.)
 */
import { LARGO_MINIMO_CONTRASENA, retrasoTrasFallos, revisarContrasena } from '@papeleria/core';
import {
  ErrorContrasenaDebil,
  ErrorUsuarioYaExiste,
  crearUsuario,
  entrar,
  hashearContrasena,
  registrarDispositivo,
  siguienteCodigoLibre,
  type ContextoSesion,
  type ResultadoEntrada,
  type UsuarioPublico,
} from '@papeleria/db';

import { enTransaccionDuradera } from '../db/cliente';
import type { BaseLocal } from '../db/baseLocal';
import { emparejarDispositivo } from '../sync/cliente';
import { estaSupabaseConfigurado, iniciarSesionSupabase, leerPerfilSupabase, solicitarRecuperacion } from './supabase';
import { aviso, crear, esperar, mensaje } from '../ui';
import {
  guardarDispositivo,
  guardarToken,
  leerDispositivo,
  type DispositivoGuardado,
} from './almacen';

/** El contexto con el que se abre la sesión desde esta pantalla: el PC del mostrador. */
const CONTEXTO: ContextoSesion = 'caja';

/** Palabras que no pueden ser la contraseña entera. */
const PROHIBIDAS = ['papeleria', 'papelería', 'caja', 'duena', 'dueña'];

export interface SesionIniciada {
  readonly sesionId: string;
  readonly usuario: UsuarioPublico;
  readonly dispositivo: DispositivoGuardado;
  readonly idle_expires_at: number;
  readonly absolute_expires_at: number;
}

export interface OpcionesEntrada {
  /** ¿Ya existe una cuenta? Decide entre «entrar» y «primer arranque». */
  readonly hayCuenta: boolean;
  readonly alEntrar: (sesion: SesionIniciada) => void;
  /** Mensaje que se muestra arriba (por ejemplo, «la sesión venció»). */
  readonly nota?: string;
}

export function montarEntrada(
  raiz: HTMLElement,
  base: BaseLocal,
  opciones: OpcionesEntrada,
): void {
  raiz.replaceChildren();

  const caja = crear('section', 'entrada');
  const titulo = crear('h1', undefined, opciones.hayCuenta ? 'Entrar' : 'Primer arranque');
  const descripcion = crear(
    'p',
    'descripcion',
    opciones.hayCuenta
      ? 'La base se guarda en este equipo. Si lo vinculas, los cambios se comparten con tus otros dispositivos.'
      : 'La cuenta inicial y los datos se guardan en este navegador. Puedes vincular este equipo para compartir cambios.',
  );
  caja.append(titulo, descripcion);

  if (opciones.nota !== undefined) {
    caja.append(crear('p', 'nota', opciones.nota));
  }

  const formulario = crear('form');
  formulario.noValidate = true;

  const campoNombre = opciones.hayCuenta
    ? undefined
    : campo('Nombre', 'nombre', 'text', 'name');
  const campoUsuario = campo(estaSupabaseConfigurado ? 'Correo electrónico' : 'Usuario', 'usuario', estaSupabaseConfigurado ? 'email' : 'text', estaSupabaseConfigurado ? 'email' : 'username');
  const campoContrasena = campo(
    'Contraseña',
    'contrasena',
    'password',
    opciones.hayCuenta ? 'current-password' : 'new-password',
  );
  const campoRepeticion = opciones.hayCuenta
    ? undefined
    : campo('Repite la contraseña', 'repeticion', 'password', 'new-password');
  const campoCodigoSync = campo('Código para vincular otro dispositivo (opcional)', 'codigo_sync', 'password', 'new-password');

  if (campoNombre) formulario.append(campoNombre.etiqueta);
  formulario.append(campoUsuario.etiqueta, campoContrasena.etiqueta);
  if (campoRepeticion) formulario.append(campoRepeticion.etiqueta);
  formulario.append(campoCodigoSync.etiqueta);
  formulario.append(crear('p', 'nota', 'Para sincronizar, pega el código de vinculación que configuraste en Render. Si lo dejas vacío, este equipo funciona de forma local.'));

  // Ayuda en vivo sólo al crear: al entrar, decir «te faltan caracteres» no ayuda a nadie.
  const ayuda = crear('ul', 'problemas');
  if (!opciones.hayCuenta) formulario.append(ayuda);

  const boton = crear(
    'button',
    'boton',
    opciones.hayCuenta ? 'Entrar' : 'Crear la cuenta y entrar',
  );
  boton.type = 'submit';
  formulario.append(boton);

  if (opciones.hayCuenta && estaSupabaseConfigurado) {
    const recuperar = crear('button', 'enlace', 'Olvidé mi contraseña');
    recuperar.type = 'button';
    recuperar.addEventListener('click', () => void solicitarRecuperacion(campoUsuario.entrada.value.trim()).then(
      () => errores.replaceChildren(aviso('Revisa tu correo', ['Te enviamos un enlace para cambiar la contraseña.'])),
      (causa) => errores.replaceChildren(aviso('No se pudo enviar el enlace', [mensaje(causa)])),
    ));
    formulario.append(recuperar);
  }

  const errores = crear('div');
  caja.append(formulario, errores);
  raiz.append(caja);

  if (!opciones.hayCuenta) {
    formulario.append(
      crear(
        'p',
        'nota',
        `Mínimo ${LARGO_MINIMO_CONTRASENA} caracteres, sin símbolos obligatorios. Apúntala: no hay «olvidé mi contraseña» porque no hay servidor que la recupere.`,
      ),
    );

    const revisar = (): void => {
      const problemas = revisarContrasena(campoContrasena.entrada.value, [
        ...PROHIBIDAS,
        campoUsuario.entrada.value,
      ]);
      ayuda.replaceChildren(...problemas.map((problema) => crear('li', undefined, problema)));
    };
    campoContrasena.entrada.addEventListener('input', revisar);
    campoUsuario.entrada.addEventListener('input', revisar);
  }

  /** Guarda el token y avisa a quien montó la pantalla. */
  function recordarSesion(
    resultado: Extract<ResultadoEntrada, { ok: true }>,
    dispositivo: DispositivoGuardado,
  ): void {
    guardarToken(resultado.sesion.token);
    guardarDispositivo(dispositivo);
    opciones.alEntrar({
      sesionId: resultado.sesion.sesionId,
      usuario: resultado.usuario,
      dispositivo,
      idle_expires_at: resultado.sesion.idle_expires_at,
      absolute_expires_at: resultado.sesion.absolute_expires_at,
    });
  }

  /** Se muestra cuando el fallo no son las credenciales sino algo del sistema. */
  function mostrarCausa(tituloAviso: string, causa: unknown): void {
    if (causa instanceof ErrorContrasenaDebil) {
      errores.append(aviso('Esa contraseña no vale todavía', causa.problemas));
    } else if (causa instanceof ErrorUsuarioYaExiste) {
      errores.append(aviso('Ese usuario ya existe', [causa.message, 'Elige otro nombre.']));
    } else {
      errores.append(aviso(tituloAviso, [mensaje(causa)]));
    }
  }

  let trabajando = false;
  let fallos = 0;

  formulario.addEventListener('submit', (evento) => {
    evento.preventDefault();
    if (trabajando) return;

    void (async () => {
      trabajando = true;
      boton.disabled = true;
      errores.replaceChildren();

      const usuario = campoUsuario.entrada.value.trim();
      const contrasena = campoContrasena.entrada.value;
      const codigoSync = campoCodigoSync.entrada.value.trim();

      try {
        if (!opciones.hayCuenta) return await primerArranque(usuario, contrasena, codigoSync);
        await iniciarSesion(usuario, contrasena, codigoSync);
      } catch (causa) {
        mostrarCausa('No se pudo completar', causa);
      } finally {
        trabajando = false;
        boton.disabled = false;
      }
    })();
  });

  /** Crear la cuenta y entrar, todo o nada. */
  async function primerArranque(usuario: string, contrasena: string, codigoSync: string): Promise<void> {
    if (contrasena !== campoRepeticion?.entrada.value) {
      errores.append(
        aviso('Las dos contraseñas no coinciden', ['Vuelve a escribirla en el segundo campo.']),
      );
      return;
    }

    const prohibidas = [...PROHIBIDAS, usuario];
    const problemas = revisarContrasena(contrasena, prohibidas);
    if (problemas.length > 0) {
      errores.append(aviso('Esa contraseña no vale todavía', problemas));
      return;
    }

    const dispositivo = await asegurarDispositivo(base);

    // Una sola transacción para las dos escrituras: si la sesión no llegara a abrirse, no
    // puede quedar una cuenta creada y un dueño fuera mirándola. Se vuelve a verificar la
    // contraseña que se acaba de escribir —cuesta cien milisegundos— porque así el camino
    // de la primera vez es exactamente el camino de todas las demás.
    const resultado = await enTransaccionDuradera(base, async (tx) => {
      await crearUsuario(tx, {
        username: usuario,
        nombre: campoNombre?.entrada.value ?? usuario,
        contrasena,
        prohibidas,
      });
      return await entrar(tx, {
        username: usuario,
        contrasena,
        dispositivoId: dispositivo.id,
        contexto: CONTEXTO,
        userAgent: navigator.userAgent,
      });
    });

    if (!resultado.ok) {
      errores.append(
        aviso('La cuenta se creó, pero no se pudo abrir la sesión', [
          'Vuelve a entrar con la contraseña que acabas de escribir.',
        ]),
      );
      return;
    }

    if (codigoSync) await emparejarDispositivo(dispositivo.id, codigoSync);
    recordarSesion(resultado, dispositivo);
  }

  async function iniciarSesion(usuario: string, contrasena: string, codigoSync: string): Promise<void> {
    if (fallos > 0) {
      // El retraso va aquí, ANTES de mirar la contraseña: si se aplicara sólo al fallar,
      // quien prueba contraseñas podría distinguir el acierto por lo que tarda.
      await esperar(retrasoTrasFallos(fallos));
    }

    let nombreCentral: string | undefined;
    if (estaSupabaseConfigurado) {
      const central = await iniciarSesionSupabase(usuario, contrasena);
      nombreCentral = (await leerPerfilSupabase(central.id)) ?? central.user_metadata?.nombre;
      await enTransaccionDuradera(base, async (tx) => {
        const existente = await tx.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [usuario]);
        if (existente.rows.length === 0) {
          await crearUsuario(tx, { username: usuario, nombre: nombreCentral ?? usuario, contrasena, prohibidas: [...PROHIBIDAS, usuario] });
        } else {
          await tx.query('UPDATE users SET password_hash = $1, nombre = $2, is_activo = TRUE WHERE username = $3', [await hashearContrasena(contrasena), nombreCentral ?? usuario, usuario]);
        }
      });
    }

    const dispositivo = await asegurarDispositivo(base);
    const resultado = await enTransaccionDuradera(base, (tx) =>
      entrar(tx, {
        username: usuario,
        contrasena,
        dispositivoId: dispositivo.id,
        contexto: CONTEXTO,
        userAgent: navigator.userAgent,
      }),
    );

    if (resultado.ok) {
      if (codigoSync) await emparejarDispositivo(dispositivo.id, codigoSync);
      recordarSesion(resultado, dispositivo);
      return;
    }

    if (resultado.motivo === 'inactivo') {
      errores.append(
        aviso('Esa cuenta está desactivada', ['Habla con quien administre el sistema.']),
      );
      return;
    }

    fallos += 1;
    errores.append(
      aviso('No se pudo entrar', [
        'Usuario o contraseña incorrectos.',
        ...(fallos >= 3
          ? [`Van ${fallos} intentos fallidos; la espera entre intentos va creciendo.`]
          : []),
      ]),
    );
    campoContrasena.entrada.value = '';
    campoContrasena.entrada.focus();
  }

  campoUsuario.entrada.focus();
}

/**
 * El dispositivo de este navegador, registrándolo si hace falta.
 *
 * Se comprueba que la fila siga existiendo: si alguien borró la base pero no el
 * almacenamiento del navegador, el id guardado apuntaría a una caja que ya no está y el
 * FOREIGN KEY de `sessions` lo rechazaría. Es más barato comprobarlo que explicar el error.
 */
async function asegurarDispositivo(base: BaseLocal): Promise<DispositivoGuardado> {
  const guardado = leerDispositivo();
  if (guardado !== null) {
    const fila = await base.consultarUno(
      `SELECT 1 FROM devices WHERE id = $1 AND revoked_at IS NULL`,
      [guardado.id],
    );
    if (fila !== undefined) return guardado;
  }

  const nuevo = await enTransaccionDuradera(base, async (tx) => {
    const codigo = await siguienteCodigoLibre(tx);
    const id = await registrarDispositivo(tx, { nombre: 'PC caja', codigo });
    return { id, codigo };
  });
  guardarDispositivo(nuevo);
  return nuevo;
}

interface Campo {
  readonly etiqueta: HTMLLabelElement;
  readonly entrada: HTMLInputElement;
}

function campo(
  texto: string,
  nombre: string,
  tipo: 'text' | 'email' | 'password',
  autocompletar: 'name' | 'email' | 'username' | 'current-password' | 'new-password',
): Campo {
  const etiqueta = crear('label', 'campo');
  etiqueta.append(crear('span', undefined, texto));

  const entrada = crear('input');
  entrada.type = tipo;
  entrada.name = nombre;
  entrada.autocomplete = autocompletar;
  entrada.required = true;
  etiqueta.append(entrada);

  return { etiqueta, entrada };
}
