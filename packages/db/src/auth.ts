/**
 * AUTENTICACIÓN CONTRA LA BASE — la contraseña, el dispositivo y la sesión.
 *
 * Aquí es donde la regla pura de `@papeleria/core` (`auth/`) se encuentra con la fila.
 * El reparto es el mismo que en el resto del proyecto: el núcleo dice **cuándo vence una
 * sesión y qué se le exige a una contraseña**; este archivo la hashea, la compara, y
 * escribe las filas.
 *
 * ─── TRES DECISIONES QUE NO SON OBVIAS ─────────────────────────────────────
 *
 * 1. ARGON2ID CON `hash-wasm`, NO CON `argon2` DE NODE.
 *    `hash-wasm` es WebAssembly puro: no necesita compilador de C, no necesita binarios
 *    por plataforma, y produce el MISMO string `$argon2id$…` en el navegador y en Node.
 *    Eso importa porque hoy hashea el navegador (no hay servidor) y mañana verificará el
 *    servidor: si cada lado usara su librería, un día un hash escrito por uno no lo
 *    entendería el otro. Es la misma razón por la que `hashDe` usa WebCrypto.
 *
 * 2. SI EL USUARIO NO EXISTE, SE VERIFICA IGUAL.
 *    Contra un hash señuelo. Si no, "usuario no existe" contesta en 1 ms y "contraseña
 *    mal" en 100 ms, y esa diferencia de tiempo le dice a quien pregunte qué nombres de
 *    usuario existen. Cuesta cien milisegundos y quita el canal entero.
 *
 * 3. EL TOKEN SE GUARDA HASHEADO, NUNCA EN CLARO.
 *    La tabla `sessions` sólo ve el SHA-256. Quien lea la base —que en este proyecto es
 *    cualquiera con el PC delante, porque la base está en su navegador— no puede
 *    reutilizar ninguna sesión con lo que lea. Ese es exactamente el diseño que pide
 *    docs/07 §2.1, y no depende de que exista un servidor.
 */

import { argon2Verify, argon2id } from 'hash-wasm';

import {
  type ContextoSesion,
  type MotivoVencimiento,
  motivoDeVencimiento,
  revisarContrasena,
  siguienteVencimientoPorInactividad,
  uuidV7,
  vencimientosDeSesion,
} from '@papeleria/core';

import { hashDe } from './hash';
import type { ClienteSql } from './runner';

/**
 * Los parámetros de Argon2id: los mismos que fija docs/07 §1.2 (19 MiB, 2 pasadas).
 *
 * Son constantes exportadas, no números sueltos, porque hay que poder **citarlos en una
 * prueba** y porque el día que se suban (hardware nuevo) hay que poder comprobar que un
 * hash viejo sigue verificando: los parámetros van dentro del propio string PHC.
 */
export const PARAMETROS_ARGON2 = {
  iterations: 2,
  memorySize: 19456, // 19 MiB en kibibytes
  parallelism: 1,
  hashLength: 32,
} as const;

const BYTES_DE_SAL = 16;
const BYTES_DE_TOKEN = 32;

// ─────────────────────────── contraseñas ───────────────────────────

/** Hashea una contraseña y devuelve el string PHC (`$argon2id$v=19$m=…`). */
export async function hashearContrasena(contrasena: string, sal?: Uint8Array): Promise<string> {
  return await argon2id({
    password: contrasena,
    salt: sal ?? bytesAleatorios(BYTES_DE_SAL),
    ...PARAMETROS_ARGON2,
    outputType: 'encoded',
  });
}

/**
 * ¿La contraseña corresponde a este hash?
 *
 * Un hash corrupto o de otro formato devuelve `false` en vez de reventar: en la pantalla
 * de entrada, un error de formato y una contraseña equivocada se comportan igual, y
 * dejar que la excepción suba convertiría una fila rota en una pantalla en blanco.
 */
export async function verificarContrasena(contrasena: string, phc: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: contrasena, hash: phc });
  } catch {
    return false;
  }
}

/**
 * Un hash de mentira, para gastar el mismo tiempo cuando el usuario no existe.
 *
 * Se calcula una sola vez y se recuerda: el señuelo no protege nada, sólo tiene que
 * costar lo mismo que un hash real.
 */
let senuelo: Promise<string> | undefined;
function hashSenuelo(): Promise<string> {
  senuelo ??= hashearContrasena('senuelo: existe para que el tiempo no delate a nadie');
  return senuelo;
}

// ─────────────────────────── tokens ───────────────────────────

const ALFABETO_BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes del generador criptográfico del sistema. No `Math.random`, nunca. */
export function bytesAleatorios(cuantos: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(cuantos));
}

/**
 * Base64url sin relleno (`=`), escrito a mano.
 *
 * Se escribe aquí en vez de usar `btoa` por una razón concreta: `btoa` es de navegador y
 * en Node existe de prestado. Una función de tres líneas que se comporta igual en los dos
 * lados vale menos que una dependencia de plataforma en el camino de la autenticación.
 */
export function aBase64Url(bytes: Uint8Array): string {
  let salida = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    salida += ALFABETO_BASE64URL.charAt(a >> 2);
    salida += ALFABETO_BASE64URL.charAt(((a & 0x03) << 4) | ((b ?? 0) >> 4));
    if (b !== undefined) {
      salida += ALFABETO_BASE64URL.charAt(((b & 0x0f) << 2) | ((c ?? 0) >> 6));
    }
    if (c !== undefined) {
      salida += ALFABETO_BASE64URL.charAt(c & 0x3f);
    }
  }
  return salida;
}

/** Un token de sesión nuevo: 256 bits de azar, aptos para una URL. */
export function generarToken(): string {
  return aBase64Url(bytesAleatorios(BYTES_DE_TOKEN));
}

/** Lo que se guarda en `sessions.refresh_token_hash`. Nunca el token en claro. */
export function hashDeToken(token: string): Promise<string> {
  return hashDe(token);
}

// ─────────────────────────── usuarios ───────────────────────────

export interface UsuarioPublico {
  readonly id: string;
  readonly username: string;
  readonly nombre: string;
}

/** Error de la contraseña en el momento de crearla, con los motivos que da el núcleo. */
export class ErrorContrasenaDebil extends Error {
  readonly problemas: readonly string[];

  constructor(problemas: readonly string[]) {
    super(`La contraseña no cumple: ${problemas.join(' ')}`);
    this.name = 'ErrorContrasenaDebil';
    this.problemas = problemas;
  }
}

export class ErrorUsuarioYaExiste extends Error {
  constructor(username: string) {
    super(`Ya existe un usuario «${username}».`);
    this.name = 'ErrorUsuarioYaExiste';
  }
}

/**
 * El nombre de usuario con el que se busca: sin espacios sobrantes y en minúsculas.
 *
 * Se normaliza en un solo sitio y se guarda ya normalizado, para que `«DUEÑA»` y
 * `«dueña»` no puedan ser dos usuarios distintos con dos contraseñas distintas. El
 * nombre que se muestra es `nombre`, no `username`.
 */
export function normalizarUsuario(username: string): string {
  return username.trim().toLowerCase();
}

/** ¿Hay alguna cuenta creada? Si no, toca la pantalla de primer arranque. */
export async function hayUsuarios(cliente: ClienteSql): Promise<boolean> {
  const { rows } = await cliente.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

export interface DatosNuevoUsuario {
  readonly username: string;
  readonly nombre: string;
  readonly contrasena: string;
  /** Palabras que no pueden ser la contraseña entera (el usuario, la tienda). */
  readonly prohibidas?: readonly string[];
}

/**
 * Crea la cuenta. Devuelve el id.
 *
 * La contraseña se revisa **aquí además de en la pantalla**, y no es duplicar por gusto:
 * la pantalla da la respuesta rápida mientras se teclea, y esto es lo que garantiza que
 * ninguna otra ruta de código pueda guardar una contraseña de cuatro letras.
 */
export async function crearUsuario(
  cliente: ClienteSql,
  datos: DatosNuevoUsuario,
): Promise<string> {
  const username = normalizarUsuario(datos.username);
  const nombre = datos.nombre.trim();

  if (username === '') throw new Error('El nombre de usuario no puede estar vacío.');
  if (nombre === '') throw new Error('El nombre no puede estar vacío.');

  const problemas = revisarContrasena(datos.contrasena, datos.prohibidas ?? []);
  if (problemas.length > 0) throw new ErrorContrasenaDebil(problemas);

  const id = uuidV7();
  try {
    await cliente.query(
      `INSERT INTO users (id, username, nombre, password_hash) VALUES ($1, $2, $3, $4)`,
      [id, username, nombre, await hashearContrasena(datos.contrasena)],
    );
  } catch (error) {
    if (esViolacionDeUnicidad(error)) throw new ErrorUsuarioYaExiste(username);
    throw error;
  }
  return id;
}

// ─────────────────────────── dispositivos ───────────────────────────

export type TipoDispositivo = 'terminal' | 'scanner' | 'server';

export interface DatosDispositivo {
  readonly nombre: string;
  readonly codigo: string;
  readonly tipo?: TipoDispositivo;
}

/**
 * Registra este navegador como dispositivo.
 *
 * El `codigo` (`C1`, `C2`…) no es decorativo: es el prefijo del folio local (docs/08 §6),
 * y el índice único parcial de `devices.codigo` es lo que impide que dos cajas produzcan
 * el mismo folio. Por eso el código lo elige el llamador y no se inventa aquí.
 */
export async function registrarDispositivo(
  cliente: ClienteSql,
  datos: DatosDispositivo,
): Promise<string> {
  const id = uuidV7();
  await cliente.query(
    `INSERT INTO devices (id, nombre, tipo, codigo) VALUES ($1, $2, $3, $4)`,
    [id, datos.nombre.trim(), datos.tipo ?? 'terminal', datos.codigo],
  );
  return id;
}

/**
 * El primer código libre de la serie `C1`, `C2`, `C3`…
 *
 * Hace falta porque el identificador del dispositivo vive en el navegador y se puede
 * perder (borrar datos del sitio, otro navegador). En ese caso hay que registrar uno
 * nuevo sin pisar el código de la caja que ya existe: dos cajas con el prefijo `C1`
 * producirían folios idénticos.
 */
export async function siguienteCodigoLibre(cliente: ClienteSql, base = 'C'): Promise<string> {
  const { rows } = await cliente.query<{ codigo: string }>(
    `SELECT codigo FROM devices WHERE codigo LIKE $1`,
    [`${base}%`],
  );
  const usados = new Set(rows.map((fila) => fila.codigo));

  for (let n = 1; n < 10_000; n++) {
    const candidato = `${base}${n}`;
    if (!usados.has(candidato)) return candidato;
  }
  throw new Error(`No queda ningún código libre en la serie «${base}n».`);
}

// ─────────────────────────── sesiones ───────────────────────────

export interface SesionCreada {
  readonly sesionId: string;
  /** El token en claro. Sólo se ve aquí: en la base queda su SHA-256. */
  readonly token: string;
  readonly idle_expires_at: number;
  readonly absolute_expires_at: number;
}

export interface OpcionesSesion {
  readonly usuarioId: string;
  readonly dispositivoId: string;
  readonly contexto: ContextoSesion;
  readonly ahora?: number;
  readonly userAgent?: string;
}

/** Crea una sesión y devuelve el token en claro, que no se puede recuperar después. */
export async function crearSesion(
  cliente: ClienteSql,
  opciones: OpcionesSesion,
): Promise<SesionCreada> {
  const ahora = opciones.ahora ?? Date.now();
  const vencimientos = vencimientosDeSesion(opciones.contexto, ahora);
  const token = generarToken();
  const sesionId = uuidV7();

  await cliente.query(
    `INSERT INTO sessions
       (id, user_id, device_id, refresh_token_hash, familia_id,
        created_at, last_used_at, idle_expires_at, absolute_expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      sesionId,
      opciones.usuarioId,
      opciones.dispositivoId,
      await hashDeToken(token),
      uuidV7(), // familia nueva: la cadena de rotaciones de ESTE inicio de sesión
      aIso(ahora),
      aIso(vencimientos.idle),
      aIso(vencimientos.absoluto),
      opciones.userAgent ?? null,
    ],
  );

  return {
    sesionId,
    token,
    idle_expires_at: vencimientos.idle,
    absolute_expires_at: vencimientos.absoluto,
  };
}

export interface SesionActiva {
  readonly sesionId: string;
  readonly dispositivoId: string;
  readonly usuario: UsuarioPublico;
  readonly idle_expires_at: number;
  readonly absolute_expires_at: number;
}

interface FilaSesion {
  sesion_id: string;
  device_id: string;
  user_id: string;
  username: string;
  nombre: string;
  idle_ms: number;
  absoluto_ms: number;
  usado_ms: number;
}

/**
 * ¿Este token vale? Si vale, además corre la ventana de inactividad.
 *
 * Devuelve `null` —sin distinguir por qué— en los cuatro casos en que no vale: no existe,
 * está revocada, venció por inactividad, o se cumplió el tope absoluto. La pantalla no
 * necesita saber cuál, y decirlo daría información de gratis.
 *
 * Se llama **dentro de una transacción**: entre el SELECT y el UPDATE no puede colarse
 * otra pestaña, o dos pestañas podrían correr la ventana a la vez y una pisaría a la otra.
 *
 * Nota de rendimiento, dicha en voz alta: se busca por `refresh_token_hash` sin índice.
 * Con las pocas sesiones que va a haber (una por dispositivo) una lectura secuencial es
 * más rápida que el índice; el día que haya cientos, se agrega.
 */
export async function verificarSesion(
  cliente: ClienteSql,
  token: string,
  opciones: { readonly ahora?: number } = {},
): Promise<SesionActiva | null> {
  const ahora = opciones.ahora ?? Date.now();

  const { rows } = await cliente.query<FilaSesion>(
    `SELECT s.id                                                  AS sesion_id,
            s.device_id                                           AS device_id,
            s.user_id                                             AS user_id,
            u.username                                            AS username,
            u.nombre                                              AS nombre,
            (EXTRACT(EPOCH FROM s.idle_expires_at) * 1000)::float8      AS idle_ms,
            (EXTRACT(EPOCH FROM s.absolute_expires_at) * 1000)::float8  AS absoluto_ms,
            (EXTRACT(EPOCH FROM s.last_used_at) * 1000)::float8         AS usado_ms
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1
        AND s.revoked_at IS NULL
        AND u.deleted_at IS NULL
        AND u.is_activo
      LIMIT 1`,
    [await hashDeToken(token)],
  );

  const fila = rows[0];
  if (fila === undefined) return null;

  const motivo = motivoDeVencimiento(
    { idle_expires_at: fila.idle_ms, absolute_expires_at: fila.absoluto_ms },
    ahora,
  );
  if (motivo !== null) {
    // Se deja escrito POR QUÉ murió. Una sesión que desaparece sin motivo convierte
    // cualquier investigación futura en una adivinanza.
    await revocar(cliente, fila.sesion_id, `expirada por ${motivo}`);
    return null;
  }

  const siguienteIdle = siguienteVencimientoPorInactividad(
    // El largo de la ventana sale de la fila: `idle - ultimo uso` es, siempre, la
    // política con la que se creó. Así verificar no puede "reinterpretar" la sesión.
    { absolute_expires_at: fila.absoluto_ms, idle_ms: fila.idle_ms - fila.usado_ms },
    ahora,
  );
  await cliente.query(
    `UPDATE sessions
        SET last_used_at = $2::timestamptz, idle_expires_at = $3::timestamptz
      WHERE id = $1`,
    [fila.sesion_id, aIso(ahora), aIso(siguienteIdle)],
  );
  // El dispositivo también deja constancia de que está vivo: es lo que permitirá ver en
  // el panel qué cajas siguen conectadas y cuáles hace meses que no.
  await cliente.query(`UPDATE devices SET ultimo_visto_at = $2::timestamptz WHERE id = $1`, [
    fila.device_id,
    aIso(ahora),
  ]);

  return {
    sesionId: fila.sesion_id,
    dispositivoId: fila.device_id,
    usuario: { id: fila.user_id, username: fila.username, nombre: fila.nombre },
    idle_expires_at: siguienteIdle,
    absolute_expires_at: fila.absoluto_ms,
  };
}

/** Cierra la sesión de este token. Devuelve `false` si ya no había nada que cerrar. */
export async function cerrarSesion(
  cliente: ClienteSql,
  token: string,
  motivo = 'logout',
): Promise<boolean> {
  const { rows } = await cliente.query<{ id: string }>(
    `UPDATE sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL
      RETURNING id`,
    [await hashDeToken(token), motivo],
  );
  return rows.length > 0;
}

/** Cierra todas las sesiones de un usuario. El botón de «salir en todos los dispositivos». */
export async function cerrarSesionesDeUsuario(
  cliente: ClienteSql,
  usuarioId: string,
  motivo = 'logout de todas',
): Promise<number> {
  const { rows } = await cliente.query<{ id: string }>(
    `UPDATE sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [usuarioId, motivo],
  );
  return rows.length;
}

async function revocar(cliente: ClienteSql, sesionId: string, motivo: string): Promise<void> {
  await cliente.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sesionId, motivo],
  );
}

// ─────────────────────────── entrar ───────────────────────────

export type MotivoNoEntrar = 'credenciales' | 'inactivo';

export type ResultadoEntrada =
  | { readonly ok: true; readonly sesion: SesionCreada; readonly usuario: UsuarioPublico }
  | { readonly ok: false; readonly motivo: MotivoNoEntrar };

export interface DatosEntrada {
  readonly username: string;
  readonly contrasena: string;
  readonly dispositivoId: string;
  readonly contexto: ContextoSesion;
  readonly ahora?: number;
  readonly userAgent?: string;
}

/**
 * Verifica la contraseña y abre la sesión, todo en una transacción.
 *
 * Que sea una transacción no es ceremonia: si la sesión se creara y el `UPDATE` del
 * dispositivo fallara, quedaría una sesión válida de un dispositivo que no consta. O
 * entra todo, o no entra nada — la misma regla que en `emitirEvento()`.
 */
export async function entrar(
  cliente: ClienteSql,
  datos: DatosEntrada,
): Promise<ResultadoEntrada> {
  const ahora = datos.ahora ?? Date.now();

  const { rows } = await cliente.query<{
    id: string;
    username: string;
    nombre: string;
    password_hash: string | null;
    is_activo: boolean;
  }>(
    `SELECT id, username, nombre, password_hash, is_activo
       FROM users
      WHERE username = $1 AND deleted_at IS NULL`,
    [normalizarUsuario(datos.username)],
  );

  const fila = rows[0];
  // Contra el señuelo cuando no existe: el tiempo no puede delatar qué usuarios hay.
  const phc = fila?.password_hash ?? (await hashSenuelo());
  const coincide = await verificarContrasena(datos.contrasena, phc);

  if (fila === undefined || fila.password_hash === null || !coincide) {
    return { ok: false, motivo: 'credenciales' };
  }
  if (!fila.is_activo) {
    return { ok: false, motivo: 'inactivo' };
  }

  const sesion = await crearSesion(cliente, {
    usuarioId: fila.id,
    dispositivoId: datos.dispositivoId,
    contexto: datos.contexto,
    ahora,
    userAgent: datos.userAgent,
  });

  await cliente.query(`UPDATE users SET ultimo_acceso_at = $2::timestamptz WHERE id = $1`, [
    fila.id,
    aIso(ahora),
  ]);

  // Entrar desde una terminal la empareja y la marca de confianza: docs/07 §4. En F0 el
  // único dispositivo es este navegador, pero el dato queda escrito desde el principio
  // para que el panel de dispositivos tenga algo real que mostrar en cuanto exista.
  await cliente.query(
    `UPDATE devices
        SET user_id = $2, paired_at = COALESCE(paired_at, $3::timestamptz), is_trusted = true
      WHERE id = $1`,
    [datos.dispositivoId, fila.id, aIso(ahora)],
  );

  return {
    ok: true,
    sesion,
    usuario: { id: fila.id, username: fila.username, nombre: fila.nombre },
  };
}

// ─────────────────────────── ayudas ───────────────────────────

function aIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** ¿El motor se quejó de un índice único? `23505` es el código estándar de PostgreSQL. */
function esViolacionDeUnicidad(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Reexportado para que la pantalla pueda nombrar el motivo sin importar dos paquetes. */
export type { ContextoSesion, MotivoVencimiento };
