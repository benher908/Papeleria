import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import {
  aBase64Url,
  asignarRol,
  cerrarSesion,
  cerrarSesionesDeUsuario,
  concederStepUp,
  crearSesion,
  crearUsuario,
  entrar,
  ErrorContrasenaDebil,
  ErrorUsuarioYaExiste,
  generarToken,
  hashearContrasena,
  hashDeToken,
  hayUsuarios,
  normalizarUsuario,
  registrarDispositivo,
  siguienteCodigoLibre,
  verificarContrasena,
  verificarSesion,
} from './auth';
import { hashDe } from './hash';
import { migrar, type ClienteTransaccional } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

const CONTRASENA = 'la-duena-de-la-papeleria';
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const MINUTO = 60_000;
const HORA = 3_600_000;

/**
 * Un hash generado el 19 de octubre de 2026 con los parámetros de docs/07 §1.2.
 *
 * Está aquí clavado a propósito. Si mañana alguien sube las pasadas de Argon2 (porque el
 * hardware ya lo aguanta) y alguien más cambia el formato, esta prueba falla **antes** de
 * que un dueño descubra que su contraseña ya no sirve. Un parámetro de hash es un
 * compromiso de por vida con los hashes ya escritos: esto es lo que lo recuerda.
 */
const VECTOR_FIJO = '$argon2id$v=19$m=19456,t=2,p=1$dW5hLXNhbC1maWphLTAx$puUl64E7xtcEaNd9tYWGfLLK2B003zkqwFNGDu0nW6s';

let db: PGlite;
let cliente: ClienteTransaccional;

interface Montaje {
  usuarioId: string;
  dispositivoId: string;
}

/** Un usuario con su contraseña y una terminal recién registrada. */
async function montar(username = 'duena', contrasena = CONTRASENA): Promise<Montaje> {
  const usuarioId = await crearUsuario(cliente, {
    username,
    nombre: 'Dueña',
    contrasena,
    // Igual que hace la pantalla: el nombre de la tienda no puede ser la contraseña.
    prohibidas: ['papeleria'],
  });
  const dispositivoId = await registrarDispositivo(cliente, {
    nombre: 'PC caja 1',
    codigo: await siguienteCodigoLibre(cliente),
  });
  return { usuarioId, dispositivoId };
}

async function motivoDe(sesionId: string): Promise<string | null> {
  const { rows } = await cliente.query<{ revoked_reason: string | null }>(
    `SELECT revoked_reason FROM sessions WHERE id = $1`,
    [sesionId],
  );
  return rows[0]?.revoked_reason ?? null;
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // De hijos a padres: `step_up_grants` apunta a `sessions`; `devices` a `users`.
  await cliente.exec('DELETE FROM step_up_grants');
  await cliente.exec('DELETE FROM sessions');
  await cliente.exec('DELETE FROM devices');
  await cliente.exec('DELETE FROM users');
});

// ─────────────────────────── contraseñas ───────────────────────────

describe('argon2id', () => {
  test('los parámetros son los de docs/07 §1.2, escritos en el propio hash', async () => {
    const phc = await hashearContrasena('una contraseña cualquiera');
    // 19 MiB, 2 pasadas, 1 hilo. Va dentro del string PHC, así que un hash viejo se
    // puede verificar aunque los parámetros por defecto cambien: eso es el formato PHC.
    expect(phc.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  test('verifica la correcta y rechaza la equivocada', async () => {
    const phc = await hashearContrasena(CONTRASENA);
    expect(await verificarContrasena(CONTRASENA, phc)).toBe(true);
    expect(await verificarContrasena('otra cosa distinta', phc)).toBe(false);
  });

  test('dos hashes de la misma contraseña son distintos: cada uno lleva su sal', async () => {
    const uno = await hashearContrasena(CONTRASENA);
    const otro = await hashearContrasena(CONTRASENA);
    expect(uno).not.toBe(otro);
    expect(await verificarContrasena(CONTRASENA, otro)).toBe(true);
  });

  test('un hash corrupto devuelve false en vez de reventar', async () => {
    // En la pantalla de entrada, una fila rota y una contraseña mal se comportan igual.
    for (const basura of ['', 'no-es-un-hash', '$argon2id$v=19$m=19456,t=2,p=1$roto$roto']) {
      expect(await verificarContrasena(CONTRASENA, basura)).toBe(false);
    }
  });

  test('el vector fijo de octubre de 2026 sigue verificando', async () => {
    expect(await verificarContrasena('vector-de-prueba', VECTOR_FIJO)).toBe(true);
    expect(await verificarContrasena('vector-de-prueba2', VECTOR_FIJO)).toBe(false);
  });
});

// ─────────────────────────── tokens ───────────────────────────

describe('tokens', () => {
  test('base64url sin relleno, contra vectores calculados a mano', () => {
    // 0x00 0x00 0x00 → AAAA;  0xFF 0xFF 0xFF → ____;  0xFB 0xFF → -_8
    expect(aBase64Url(Uint8Array.from([0, 0, 0]))).toBe('AAAA');
    expect(aBase64Url(Uint8Array.from([0xff, 0xff, 0xff]))).toBe('____');
    expect(aBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
  });

  test('32 bytes dan 43 caracteres, todos del alfabeto, sin «+» ni «/» ni «=»', () => {
    for (let i = 0; i < 20; i++) {
      const token = generarToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test('dos tokens seguidos no se parecen en nada', () => {
    const vistos = new Set(Array.from({ length: 100 }, () => generarToken()));
    expect(vistos.size).toBe(100);
  });

  test('lo que se guarda es el SHA-256, no el token', async () => {
    const token = generarToken();
    const guardado = await hashDeToken(token);
    expect(guardado).not.toBe(token);
    expect(guardado).toHaveLength(64);
    // Se compara contra `hashDe` directamente para que la prueba no sea una tautología.
    expect(guardado).toBe(await hashDe(token));
  });
});

// ─────────────────────────── usuarios ───────────────────────────

describe('usuarios', () => {
  test('sin ninguna cuenta, la pantalla es la de primer arranque', async () => {
    expect(await hayUsuarios(cliente)).toBe(false);
    await montar();
    expect(await hayUsuarios(cliente)).toBe(true);
  });

  test('el primer usuario queda con el rol de dueño', async () => {
    // Sin rol no hay permisos, y sin permisos la dueña no puede ni dar de alta un
    // producto. Esto se descubrió con la primera autorización real de F1.1.
    const { usuarioId } = await montar();

    const { rows } = await cliente.query<{ clave: string }>(
      `SELECT r.clave FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [usuarioId],
    );
    expect(rows.map((fila) => fila.clave)).toEqual(['dueno']);
  });

  test('el segundo usuario no hereda el rol de dueño', async () => {
    await montar('duena');
    const segundo = await crearUsuario(cliente, {
      username: 'empleado',
      nombre: 'Empleado',
      contrasena: CONTRASENA,
      prohibidas: ['papeleria'],
    });

    const { rows } = await cliente.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1`,
      [segundo],
    );
    expect(rows).toHaveLength(0);
  });

  test('asignarRol da el rol pedido, es idempotente y avisa si no existe', async () => {
    const { usuarioId } = await montar('duena');
    const segundo = await crearUsuario(cliente, {
      username: 'cajero',
      nombre: 'Cajero',
      contrasena: CONTRASENA,
      prohibidas: ['papeleria'],
    });

    await asignarRol(cliente, segundo, 'cajero');
    await asignarRol(cliente, segundo, 'cajero');

    const { rows } = await cliente.query<{ clave: string }>(
      `SELECT r.clave FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [segundo],
    );
    expect(rows.map((fila) => fila.clave)).toEqual(['cajero']);

    await expect(asignarRol(cliente, usuarioId, 'inventado')).rejects.toThrow(/«inventado»/);
  });

  test('el nombre de usuario se guarda normalizado', async () => {
    await montar('  Dueña  ');
    const { rows } = await cliente.query<{ username: string }>(`SELECT username FROM users`);
    expect(rows[0]?.username).toBe('dueña');
    expect(normalizarUsuario('  Dueña  ')).toBe('dueña');
  });

  test('dos cuentas con el mismo nombre chocan, y el error lo dice en claro', async () => {
    await montar('duena');
    await expect(montar('DUENA')).rejects.toBeInstanceOf(ErrorUsuarioYaExiste);
  });

  test('una contraseña débil no se guarda, y se explica por qué', async () => {
    const intento = crearUsuario(cliente, {
      username: 'duena',
      nombre: 'Dueña',
      contrasena: 'Papeleria1!',
    });
    await expect(intento).rejects.toBeInstanceOf(ErrorContrasenaDebil);
    // El error lleva los motivos del núcleo, no un mensaje genérico: la pantalla los
    // muestra tal cual, y así no hay dos redacciones distintas de la misma regla.
    await intento.catch((error: ErrorContrasenaDebil) => {
      expect(error.problemas[0]).toContain('12 caracteres');
    });
  });

  test('la contraseña no puede ser el nombre de la tienda, pero sí contenerlo', async () => {
    await expect(
      crearUsuario(cliente, {
        username: 'duena',
        nombre: 'Dueña',
        contrasena: 'papeleria',
        prohibidas: ['papeleria'],
      }),
    ).rejects.toBeInstanceOf(ErrorContrasenaDebil);

    // Contenerla está bien: es lo que evita que la gente escriba cosas peores.
    await expect(
      crearUsuario(cliente, {
        username: 'duena2',
        nombre: 'Dueña',
        contrasena: CONTRASENA,
        prohibidas: ['papeleria'],
      }),
    ).resolves.toBeTypeOf('string');
  });
});

// ─────────────────────────── dispositivos ───────────────────────────

describe('dispositivos', () => {
  test('los códigos de terminal se reparten solos: C1, C2, C3', async () => {
    for (const esperado of ['C1', 'C2', 'C3']) {
      expect(await siguienteCodigoLibre(cliente)).toBe(esperado);
      await registrarDispositivo(cliente, { nombre: `Caja ${esperado}`, codigo: esperado });
    }
  });

  test('un código ya usado no se reparte: dos cajas con C1 darían el mismo folio', async () => {
    await registrarDispositivo(cliente, { nombre: 'PC caja 1', codigo: 'C1' });
    await registrarDispositivo(cliente, { nombre: 'PC caja 2', codigo: 'C3' });
    expect(await siguienteCodigoLibre(cliente)).toBe('C2');
  });

  test('un dispositivo recién registrado no pertenece a nadie todavía', async () => {
    const dispositivoId = await registrarDispositivo(cliente, { nombre: 'PC caja 1', codigo: 'C1' });
    const { rows } = await cliente.query<{ user_id: string | null; is_trusted: boolean }>(
      `SELECT user_id, is_trusted FROM devices WHERE id = $1`,
      [dispositivoId],
    );
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.is_trusted).toBe(false);
  });
});

// ─────────────────────────── sesiones ───────────────────────────

describe('sesiones', () => {
  test('crear y verificar: la sesión devuelve su dueño', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, {
      usuarioId,
      dispositivoId,
      contexto: 'caja',
      ahora: T0,
    });

    const activa = await verificarSesion(cliente, sesion.token, { ahora: T0 + MINUTO });
    expect(activa?.usuario.username).toBe('duena');
    expect(activa?.sesionId).toBe(sesion.sesionId);
    expect(activa?.dispositivoId).toBe(dispositivoId);
  });

  test('en la tabla sólo queda el hash del token', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });

    const { rows } = await cliente.query<{ refresh_token_hash: string }>(
      `SELECT refresh_token_hash FROM sessions WHERE id = $1`,
      [sesion.sesionId],
    );
    expect(rows[0]?.refresh_token_hash).toBe(await hashDe(sesion.token));
    // Y buscar el token en claro no encuentra nada: no está guardado en ninguna parte.
    const { rows: crudo } = await cliente.query(
      `SELECT 1 FROM sessions WHERE refresh_token_hash = $1`,
      [sesion.token],
    );
    expect(crudo).toHaveLength(0);
  });

  test('un token que nadie emitió no vale', async () => {
    await montar();
    expect(await verificarSesion(cliente, generarToken())).toBeNull();
  });

  test('cerrar sesión la revoca, y cerrar dos veces no miente', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });

    expect(await cerrarSesion(cliente, sesion.token)).toBe(true);
    expect(await verificarSesion(cliente, sesion.token)).toBeNull();
    expect(await motivoDe(sesion.sesionId)).toBe('logout');
    // La segunda vez no había nada que cerrar, y eso se dice: `true` siempre sería una
    // respuesta que no distingue "cerré tu sesión" de "ya no había nada".
    expect(await cerrarSesion(cliente, sesion.token)).toBe(false);
  });

  test('salir de todos los dispositivos cierra todas las sesiones del usuario', async () => {
    const { usuarioId, dispositivoId } = await montar();
    for (let i = 0; i < 3; i++) {
      await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });
    }
    expect(await cerrarSesionesDeUsuario(cliente, usuarioId)).toBe(3);
    const { rows } = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  test('la ventana de inactividad se corre al usar la sesión', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, {
      usuarioId,
      dispositivoId,
      contexto: 'caja',
      ahora: T0,
    });

    // A los 20 minutos se usa: la ventana de 30 min se corre hasta T0+50min.
    const aLos20 = await verificarSesion(cliente, sesion.token, { ahora: T0 + 20 * MINUTO });
    expect(aLos20?.idle_expires_at).toBe(T0 + 50 * MINUTO);

    // A los 40 minutos —cuando la ventana original ya habría muerto— sigue viva.
    const aLos40 = await verificarSesion(cliente, sesion.token, { ahora: T0 + 40 * MINUTO });
    expect(aLos40).not.toBeNull();
  });

  test('pasada la ventana sin usarla, hay que volver a entrar', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, {
      usuarioId,
      dispositivoId,
      contexto: 'caja',
      ahora: T0,
    });

    expect(sesion.idle_expires_at).toBe(T0 + 30 * MINUTO);
    expect(await verificarSesion(cliente, sesion.token, { ahora: T0 + 30 * MINUTO + 1 })).toBeNull();
    // Y queda escrito POR QUÉ: sin motivo, investigar después es adivinar.
    expect(await motivoDe(sesion.sesionId)).toBe('expirada por inactividad');
  });

  test('el tope duro no se puede posponer usándola', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, {
      usuarioId,
      dispositivoId,
      contexto: 'caja',
      ahora: T0,
    });

    // Se usa la caja cada 29 minutos, que es menos que la ventana de 30: así la sesión
    // NUNCA vence por inactividad y sólo puede morir por el tope. Ése es el punto de la
    // prueba: el tope es lo único que no se puede esquivar usándola.
    let ultimoIdle = sesion.idle_expires_at;
    for (let minuto = 29; minuto <= 11 * 60 + 40; minuto += 29) {
      const activa = await verificarSesion(cliente, sesion.token, { ahora: T0 + minuto * MINUTO });
      expect(activa).not.toBeNull();
      if (activa === null) return;
      ultimoIdle = activa.idle_expires_at;
    }
    expect(ultimoIdle).toBe(T0 + 12 * HORA);

    // Un minuto después del tope, muerta —aunque se la usó hace veinte minutos—.
    expect(await verificarSesion(cliente, sesion.token, { ahora: T0 + 12 * HORA + MINUTO })).toBeNull();
    expect(await motivoDe(sesion.sesionId)).toBe('expirada por absoluta');
  });

  test('una sesión de otro contexto dura lo que dice su propia política', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const admin = await crearSesion(cliente, {
      usuarioId,
      dispositivoId,
      contexto: 'admin',
      ahora: T0,
    });
    expect(admin.idle_expires_at).toBe(T0 + 15 * MINUTO);
    expect(admin.absolute_expires_at).toBe(T0 + 7 * 24 * HORA);

    // Al verificarla, la ventana que se corre es la SUYA (15 min), no la de la caja.
    const activa = await verificarSesion(cliente, admin.token, { ahora: T0 + 10 * MINUTO });
    expect(activa?.idle_expires_at).toBe(T0 + 25 * MINUTO);
  });
});

// ─────────────────────────── entrar ───────────────────────────

describe('entrar', () => {
  test('con la contraseña correcta entra y deja el dispositivo emparejado', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const resultado = await entrar(cliente, {
      username: 'duena',
      contrasena: CONTRASENA,
      dispositivoId,
      contexto: 'caja',
      ahora: T0,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.usuario.id).toBe(usuarioId);

    const { rows } = await cliente.query<{
      user_id: string | null;
      is_trusted: boolean;
      paired_at: Date | null;
    }>(`SELECT user_id, is_trusted, paired_at FROM devices WHERE id = $1`, [dispositivoId]);
    expect(rows[0]?.user_id).toBe(usuarioId);
    expect(rows[0]?.is_trusted).toBe(true);
    expect(rows[0]?.paired_at).not.toBeNull();

    const activa = await verificarSesion(cliente, resultado.sesion.token, { ahora: T0 + MINUTO });
    expect(activa?.usuario.id).toBe(usuarioId);
  });

  test('el nombre de usuario no distingue mayúsculas ni espacios', async () => {
    const { dispositivoId } = await montar('duena');
    const resultado = await entrar(cliente, {
      username: '  DUENA ',
      contrasena: CONTRASENA,
      dispositivoId,
      contexto: 'caja',
    });
    expect(resultado.ok).toBe(true);
  });

  test('contraseña equivocada y usuario inexistente dan la MISMA respuesta', async () => {
    const { dispositivoId } = await montar();

    const malaContrasena = await entrar(cliente, {
      username: 'duena',
      contrasena: 'esta-no-es',
      dispositivoId,
      contexto: 'caja',
    });
    const noExiste = await entrar(cliente, {
      username: 'fulano',
      contrasena: 'esta-no-es',
      dispositivoId,
      contexto: 'caja',
    });

    expect(malaContrasena).toEqual({ ok: false, motivo: 'credenciales' });
    // Idénticas: si difirieran, la pantalla de entrada diría qué usuarios existen.
    expect(noExiste).toEqual(malaContrasena);
  });

  test('no se abre sesión cuando las credenciales fallan', async () => {
    const { dispositivoId } = await montar();
    await entrar(cliente, {
      username: 'duena',
      contrasena: 'no-es-la-buena',
      dispositivoId,
      contexto: 'caja',
    });
    const { rows } = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  test('una cuenta desactivada no entra, y se dice que es eso', async () => {
    const { usuarioId, dispositivoId } = await montar();
    await cliente.query(`UPDATE users SET is_activo = false WHERE id = $1`, [usuarioId]);

    const resultado = await entrar(cliente, {
      username: 'duena',
      contrasena: CONTRASENA,
      dispositivoId,
      contexto: 'caja',
    });
    expect(resultado).toEqual({ ok: false, motivo: 'inactivo' });
  });

  test('desactivar una cuenta invalida las sesiones que ya tenía abiertas', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });
    expect(await verificarSesion(cliente, sesion.token)).not.toBeNull();

    await cliente.query(`UPDATE users SET is_activo = false WHERE id = $1`, [usuarioId]);
    expect(await verificarSesion(cliente, sesion.token)).toBeNull();
  });
});

describe('step-up con contraseña', () => {
  test('la contraseña correcta otorga el permiso y deja el método escrito', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });
    const entidad = '01900000-0000-7000-9001-000000000001';

    const otorgado = await concederStepUp(cliente, {
      usuarioId,
      sesionId: sesion.sesionId,
      contrasena: CONTRASENA,
      motivo: 'ventas:cancelar',
      entidadId: entidad,
    });

    const { rows } = await cliente.query<{
      metodo: string;
      motivo: string;
      entidad_id: string | null;
      vigente: boolean;
    }>(
      `SELECT metodo, motivo, entidad_id, expira_at > now() AS vigente
         FROM step_up_grants WHERE id = $1`,
      [otorgado.id],
    );

    expect(rows[0]).toMatchObject({
      metodo: 'password',
      motivo: 'ventas:cancelar',
      entidad_id: entidad,
      vigente: true,
    });
    expect(new Date(otorgado.expiraAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('una contraseña equivocada no otorga nada', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });

    await expect(
      concederStepUp(cliente, {
        usuarioId,
        sesionId: sesion.sesionId,
        contrasena: 'no-es-la-buena',
        motivo: 'turnos:retiros',
      }),
    ).rejects.toThrow('La contraseña no es correcta.');

    const { rows } = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM step_up_grants`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  test('una sesión revocada no puede autorizar, aunque la contraseña sea correcta', async () => {
    const { usuarioId, dispositivoId } = await montar();
    const sesion = await crearSesion(cliente, { usuarioId, dispositivoId, contexto: 'caja' });
    await cerrarSesion(cliente, sesion.token);

    await expect(
      concederStepUp(cliente, {
        usuarioId,
        sesionId: sesion.sesionId,
        contrasena: CONTRASENA,
        motivo: 'turnos:cerrar',
      }),
    ).rejects.toThrow('La sesión ya no vale.');
  });
});
