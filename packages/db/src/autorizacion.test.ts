/**
 * LA TABLA DE CASOS DE docs/06 §9, ejecutada contra las reglas REALES.
 *
 * El doc 06 §9 la ubica en `packages/core/src/policies/__tests__/evaluar.test.ts`, con
 * `politicasSeed` y `permisosDeRol(rol)` como fixtures. Aquí es donde rinde más: corre
 * contra las 30 filas que de verdad siembra `0005_politicas.sql` y contra el reparto de
 * `role_permissions` que de verdad existe. Una tabla con fixtures demuestra que `evaluar()`
 * funciona con datos inventados; ésta demuestra que **el sistema** hace lo que el documento
 * dice. Si alguien edita una regla y "el cajero NO ve costos" deja de estar denegado, la
 * prueba lo dice.
 *
 * Lo que sí vive en el núcleo (`policies/condicion.test.ts`, `policies/evaluar.test.ts`) es
 * la gramática —operadores, tipos, indeterminación, deny-overrides—, que no depende de la
 * base de datos y se prueba con los casos mínimos que la aíslan.
 *
 * Y por qué esta tabla llama a `evaluar()` directamente en vez de pasar por `autorizar()`:
 * los casos de §9 traen contextos **parciales** a propósito (el de "dueño vende normal" sólo
 * tiene `monto_minor`). `autorizar()` exige todos los campos que las políticas vigentes
 * necesitan —es su trabajo, ver `autorizacion.ts`—, así que reventaría con el primero. La
 * tabla del documento evalúa la decisión; el contexto completo se prueba aparte, más abajo.
 */

import { PGlite } from '@electric-sql/pglite';
import {
  evaluar,
  type ContextoPolitica,
  type Obligacion,
  type Politica,
} from '@papeleria/core';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { adaptarPglite } from './adaptadores';
import { cargarMigraciones } from './archivos';
import {
  autorizar,
  cargarPermisos,
  cargarPoliticas,
  cargarRoles,
  ErrorContextoIncompleto,
  ErrorPoliticasInvalidas,
  stepUpVigente,
} from './autorizacion';
import { migrar, type ClienteTransaccional } from './runner';

const DIR_MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));

// ─────────────────────────── datos de enganche ───────────────────────────

const ROL_DUENO = '01900000-0000-7000-8000-000000000001';
const ROL_CAJERO = '01900000-0000-7000-8000-000000000002';
const ROL_BODEGA = '01900000-0000-7000-8000-000000000003';
const ROL_AUDITOR = '01900000-0000-7000-8000-000000000004';

const USUARIO_DUENO = '0a000001-0000-4000-8000-000000000001';
const USUARIO_CAJERO = '0a000002-0000-4000-8000-000000000002';
const USUARIO_BODEGA = '0a000003-0000-4000-8000-000000000003';
const USUARIO_AUDITOR = '0a000004-0000-4000-8000-000000000004';
const USUARIO_TEMPORAL = '0a000005-0000-4000-8000-000000000005';

const ID_TERMINAL = '0d000001-0000-4000-8000-000000000001';
const ID_SESION = '05000001-0000-4000-8000-000000000001';
const ID_GRANT = '07000001-0000-4000-8000-000000000001';

/** Cuántos permisos tiene cada rol en el reparto sembrado (docs/06 §3.3). */
const PERMISOS_POR_ROL = { dueno: 44, cajero: 14, bodega: 11, auditor: 12 } as const;

/** Cuántas filas siembra 0005_politicas.sql. Ver la cuenta en su encabezado. */
const POLITICAS_SEMBRADAS = 30;

// ─────────────────────────── montaje ───────────────────────────

let db: PGlite;
let cliente: ClienteTransaccional;
let politicas: readonly Politica[];

/** Un usuario por rol, para poder preguntar por los permisos de un rol concreto. */
const usuariosPorRol: Record<keyof typeof PERMISOS_POR_ROL, string> = {
  dueno: USUARIO_DUENO,
  cajero: USUARIO_CAJERO,
  bodega: USUARIO_BODEGA,
  auditor: USUARIO_AUDITOR,
};

async function asignarRol(usuarioId: string, rolId: string, expira?: string): Promise<void> {
  await cliente.query(
    `INSERT INTO user_roles (user_id, role_id, expira_at)
     VALUES ($1, $2, ${expira === undefined ? 'NULL' : '$3'})`,
    expira === undefined ? [usuarioId, rolId] : [usuarioId, rolId, expira],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  cliente = adaptarPglite(db);
  await migrar(cliente, await cargarMigraciones(DIR_MIGRACIONES));

  for (const [id, nombre] of [
    [USUARIO_DUENO, 'Dueña'],
    [USUARIO_CAJERO, 'Cajero'],
    [USUARIO_BODEGA, 'Bodega'],
    [USUARIO_AUDITOR, 'Auditor'],
    [USUARIO_TEMPORAL, 'Temporada'],
  ] as const) {
    await cliente.query(`INSERT INTO users (id, username, nombre) VALUES ($1, $2, $3)`, [
      id,
      `u-${id.slice(0, 8)}`,
      nombre,
    ]);
  }

  await asignarRol(USUARIO_DUENO, ROL_DUENO);
  await asignarRol(USUARIO_CAJERO, ROL_CAJERO);
  await asignarRol(USUARIO_BODEGA, ROL_BODEGA);
  await asignarRol(USUARIO_AUDITOR, ROL_AUDITOR);
  // El rol de temporada: ya venció. No debe contar.
  await asignarRol(USUARIO_TEMPORAL, ROL_CAJERO, '2020-01-01T00:00:00Z');

  await cliente.query(
    `INSERT INTO devices (id, user_id, nombre, tipo, codigo)
     VALUES ($1, $2, 'PC caja 1', 'terminal', 'C1')`,
    [ID_TERMINAL, USUARIO_DUENO],
  );
  await cliente.query(
    `INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, familia_id,
                           idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, 'hash-de-prueba', $1, now() + interval '30 min', now() + interval '12 h')`,
    [ID_SESION, USUARIO_DUENO, ID_TERMINAL],
  );

  politicas = await cargarPoliticas(cliente);
});

beforeEach(async () => {
  // Sólo lo que las pruebas añaden. Las políticas sembradas no se tocan aquí.
  await cliente.exec(`DELETE FROM policies WHERE id LIKE 'TEST-%'`);
  await cliente.exec(`DELETE FROM step_up_grants`);
});

afterAll(async () => {
  await db.close();
});

/** El `armarCtx(c)` del pseudocódigo de §9: rellena lo que el caso no dice. */
function armarCtx(
  permiso: string,
  partes: {
    recurso?: Partial<ContextoPolitica['recurso']>;
    sujeto?: Partial<ContextoPolitica['sujeto']>;
    entorno?: Partial<ContextoPolitica['entorno']>;
    accion?: Partial<ContextoPolitica['accion']>;
  } = {},
): ContextoPolitica {
  return {
    sujeto: {
      user_id: USUARIO_DUENO,
      roles: [],
      permisos: [],
      tiene_step_up_reciente: false,
      step_up_hace_segundos: null,
      dispositivo_confiable: true,
      dispositivo_id: ID_TERMINAL,
      ...partes.sujeto,
    },
    recurso: { tipo: 'venta', ...partes.recurso },
    accion: { permiso, ...partes.accion },
    entorno: {
      hora_local: 12,
      dia_semana: 3,
      en_temporada_escolar: false,
      terminal_id: ID_TERMINAL,
      es_offline: false,
      ...partes.entorno,
    },
  };
}

// ─────────────────────────── §9: la tabla ───────────────────────────

interface Caso {
  nombre: string;
  rol: keyof typeof PERMISOS_POR_ROL;
  permiso: string;
  contexto?: Parameters<typeof armarCtx>[1];
  permitido: boolean;
  obligaciones?: Obligacion[];
}

/**
 * Literal del doc 06 §9. El `rol` se resuelve contra `role_permissions` de verdad, no
 * contra una lista escrita a mano aquí: si el reparto cambia, la tabla lo nota.
 */
const casos: Caso[] = [
  {
    nombre: 'dueño vende normal',
    rol: 'dueno',
    permiso: 'ventas:crear',
    contexto: { recurso: { monto_minor: 13_000 } },
    permitido: true,
    obligaciones: [],
  },
  {
    nombre: 'cajero NO cambia precios',
    rol: 'cajero',
    permiso: 'precios:editar',
    permitido: false,
  },
  {
    nombre: 'dueño pone precio bajo el costo → DENEGADO',
    rol: 'dueno',
    permiso: 'precios:editar',
    contexto: { recurso: { precio_nuevo_minor: 400, costo_minor: 500 } },
    permitido: false,
  },
  {
    nombre: 'descuento 15% sin step-up → exige step_up',
    rol: 'dueno',
    permiso: 'ventas:crear',
    contexto: { recurso: { descuento_pct: 15 }, sujeto: { tiene_step_up_reciente: false } },
    permitido: true,
    obligaciones: ['step_up'],
  },
  {
    nombre: 'descuento 5% sin step-up → pasa limpio',
    rol: 'dueno',
    permiso: 'ventas:crear',
    contexto: { recurso: { descuento_pct: 5 } },
    permitido: true,
    obligaciones: [],
  },
  {
    nombre: 'venta offline de $3,000 → step_up + revisión',
    rol: 'dueno',
    permiso: 'ventas:crear',
    contexto: { recurso: { monto_minor: 300_000 }, entorno: { es_offline: true } },
    permitido: true,
    obligaciones: ['step_up', 'marcar_para_revision'],
  },
  {
    nombre: 'cambio de precio offline → DENEGADO',
    rol: 'dueno',
    permiso: 'precios:editar',
    contexto: { entorno: { es_offline: true } },
    permitido: false,
  },
  {
    nombre: 'deny-overrides: una denegación gana sobre dos permisos',
    rol: 'dueno',
    permiso: 'precios:editar',
    contexto: { recurso: { precio_nuevo_minor: 0 } },
    permitido: false,
  },
  {
    nombre: 'cajero NO ve costos',
    rol: 'cajero',
    permiso: 'precios:ver_costos',
    permitido: false,
  },
  {
    nombre: 'cualquiera puede revocar un dispositivo',
    rol: 'cajero',
    permiso: 'dispositivos:revocar',
    permitido: true,
    obligaciones: [],
  },
];

describe('docs/06 §9 — tabla de casos de políticas', () => {
  const permisosPorRol = new Map<keyof typeof PERMISOS_POR_ROL, string[]>();

  beforeAll(async () => {
    for (const rol of Object.keys(PERMISOS_POR_ROL) as (keyof typeof PERMISOS_POR_ROL)[]) {
      permisosPorRol.set(rol, await cargarPermisos(cliente, usuariosPorRol[rol]));
    }
  });

  for (const caso of casos) {
    test(caso.nombre, () => {
      const permisos = permisosPorRol.get(caso.rol);
      if (permisos === undefined) throw new Error(`Rol desconocido en la tabla: ${caso.rol}`);

      const decision = evaluar(armarCtx(caso.permiso, caso.contexto), politicas, permisos);

      expect(decision.permitido, decision.motivo).toBe(caso.permitido);
      if (caso.obligaciones !== undefined) {
        expect(new Set(decision.obligaciones)).toEqual(new Set(caso.obligaciones));
      }
    });
  }
});

// ─────────────────────────── el cargador ───────────────────────────

describe('cargarPermisos y cargarRoles', () => {
  test('cada rol trae exactamente los permisos del reparto sembrado', async () => {
    for (const [rol, esperados] of Object.entries(PERMISOS_POR_ROL)) {
      const usuarioId = usuariosPorRol[rol as keyof typeof PERMISOS_POR_ROL];
      expect(await cargarPermisos(cliente, usuarioId), rol).toHaveLength(esperados);
    }
  });

  test('el dueño ve los 44 permisos uno por uno, no un comodín', async () => {
    // El '*' de la siembra se expande al sembrar. Que el comodín no llegue a
    // `evaluar()` importa: una política que pregunte "¿tiene el permiso X?" siempre
    // tendría que responder que sí para el dueño, y así se ve cuáles tiene de verdad.
    const permisos = await cargarPermisos(cliente, USUARIO_DUENO);
    expect(permisos).not.toContain('*');
    expect(permisos).toContain('precios:ver_costos');
  });

  test('un rol de temporada vencido deja de contar solo', async () => {
    // Sin `expira_at`, el usuario temporal tendría los 14 del cajero. El rol venció en
    // 2020: no debe quedar ninguno (docs/06 §3.1, "se revoca solo").
    expect(await cargarPermisos(cliente, USUARIO_TEMPORAL)).toEqual([]);
    expect(await cargarRoles(cliente, USUARIO_TEMPORAL)).toEqual([]);
  });

  test('cargarRoles devuelve la clave del rol, que es lo que va a la auditoría', async () => {
    expect(await cargarRoles(cliente, USUARIO_CAJERO)).toEqual(['cajero']);
  });
});

describe('cargarPoliticas', () => {
  test('trae las 30 reglas sembradas y todas pasan la validación', () => {
    expect(politicas).toHaveLength(POLITICAS_SEMBRADAS);
    expect(politicas.every((p) => p.activa)).toBe(true);
  });

  test('los ids citan el número de la regla del documento', () => {
    // El id aparece en el `audit_log` ("política P10"). Si deja de citar el número del
    // doc 06 §5, la conversación con el dueño deja de poder hacerse señalando el papel.
    for (const politica of politicas) {
      expect(politica.id, politica.id).toMatch(/^P\d+[a-z]?-/);
    }
  });

  test('una política rota LANCE al cargarla, con el nombre del campo mal escrito', async () => {
    // El caso real: alguien escribe `recurso.monto` en vez de `recurso.monto_minor`. En
    // Postgres las dos son válidas (van dentro de un jsonb), pero la segunda no se cumple
    // NUNCA. Una regla de seguridad apagada en silencio es peor que un error de arranque.
    await cliente.query(
      `INSERT INTO policies (id, prioridad, efecto, aplica_a, condicion, obligaciones, motivo)
       VALUES ('TEST-typo', 500, 'denegar', '{"permiso":"ventas:crear"}'::jsonb,
               '{"op":"gt","campo":"recurso.monto","valor":100}'::jsonb,
               ARRAY[]::text[], 'prueba')`,
    );

    const error = await cargarPoliticas(cliente).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorPoliticasInvalidas);
    expect(String(error)).toContain('recurso.monto');
    expect(String(error)).toContain('recurso.monto_minor'); // la sugerencia
  });

  test('una política inactiva no se carga', async () => {
    await cliente.query(
      `INSERT INTO policies (id, prioridad, efecto, aplica_a, condicion, obligaciones, motivo, activa)
       VALUES ('TEST-apagada', 500, 'denegar', '{}'::jsonb, '{"op":"siempre"}'::jsonb,
               ARRAY[]::text[], 'prueba', false)`,
    );
    expect((await cargarPoliticas(cliente)).some((p) => p.id === 'TEST-apagada')).toBe(false);
  });
});

// ─────────────────────────── step-up ───────────────────────────

describe('stepUpVigente', () => {
  /**
   * Un otorgamiento. `otorgadoHaceMin` separa el momento del otorgamiento del de la
   * consulta: el CHECK `expira_at > otorgado_at` de 0002 prohíbe crear un otorgamiento que
   * ya nació vencido, así que para probar el vencimiento hay que retroceder los dos.
   */
  async function otorgar(
    motivo: string,
    vigenciaMin: number,
    opciones: { entidadId?: string; otorgadoHaceMin?: number } = {},
  ): Promise<void> {
    await cliente.query(
      `INSERT INTO step_up_grants (id, user_id, session_id, metodo, motivo, entidad_id,
                                   otorgado_at, expira_at)
       VALUES (gen_random_uuid(), $1, $2, 'pin', $3, $4,
               now() - ($5::text || ' minutes')::interval,
               now() - ($5::text || ' minutes')::interval + ($6::text || ' minutes')::interval)`,
      [
        USUARIO_DUENO,
        ID_SESION,
        motivo,
        opciones.entidadId ?? null,
        String(opciones.otorgadoHaceMin ?? 0),
        String(vigenciaMin),
      ],
    );
  }

  test('sin autorización no hay nada vigente', async () => {
    const grant = await stepUpVigente(cliente, {
      usuarioId: USUARIO_DUENO,
      permiso: 'ventas:cancelar',
    });
    expect(grant).toBeNull();
  });

  test('una autorización vigente se ve, y sabemos hace cuánto fue', async () => {
    await otorgar('ventas:cancelar', 5);
    const grant = await stepUpVigente(cliente, {
      usuarioId: USUARIO_DUENO,
      permiso: 'ventas:cancelar',
    });
    expect(grant).not.toBeNull();
    expect(grant?.haceSegundos).toBeGreaterThanOrEqual(0);
    expect(grant?.haceSegundos).toBeLessThan(5);
  });

  test('una autorización vencida no cuenta', async () => {
    // Se otorgó hace 10 minutos con 5 de vigencia: venció hace 5.
    await otorgar('ventas:cancelar', 5, { otorgadoHaceMin: 10 });
    expect(
      await stepUpVigente(cliente, { usuarioId: USUARIO_DUENO, permiso: 'ventas:cancelar' }),
    ).toBeNull();
  });

  test('autorizar una acción NO autoriza otra', async () => {
    // Ésta es la propiedad que evita el "autorizado para todo durante 5 minutos"
    // (docs/06 §6). El vencimiento es de la acción, no de la sesión.
    await otorgar('ventas:cancelar', 5);
    expect(await stepUpVigente(cliente, { usuarioId: USUARIO_DUENO, permiso: 'turnos:retiros' })).toBeNull();
  });

  test('con entidad, la autorización se acota al objeto concreto', async () => {
    const venta = '09000001-0000-4000-8000-000000000001';
    await otorgar('ventas:cancelar', 5, { entidadId: venta });

    expect(
      await stepUpVigente(cliente, { usuarioId: USUARIO_DUENO, permiso: 'ventas:cancelar', entidadId: venta }),
    ).not.toBeNull();

    // Otra venta no queda cubierta por la autorización de la primera.
    expect(
      await stepUpVigente(cliente, {
        usuarioId: USUARIO_DUENO,
        permiso: 'ventas:cancelar',
        entidadId: '09000002-0000-4000-8000-000000000002',
      }),
    ).toBeNull();
  });
});

// ─────────────────────────── autorizar() contra la base ───────────────────────────

describe('autorizar()', () => {
  /**
   * Mediodía local de hoy.
   *
   * `autorizar()` sin `ahora` usa el reloj de verdad, y eso hacía que esta batería
   * dependiera de la hora: P13 (venta nocturna) pide step-up a partir de las 20:00,
   * así que las ventas de $3,000 pasaban a la mañana y fallaban a las 20:07. Lo
   * encontró una corrida real, no una revisión. Se fija la hora y se acabó.
   *
   * Las pruebas de la política nocturna en sí viven en `evaluar()` con su contexto
   * explícito; aquí lo que se prueba es el camino contra la base.
   */
  function mediodia(): number {
    const fecha = new Date();
    fecha.setHours(12, 0, 0, 0);
    return fecha.getTime();
  }

  const entradaVenta = {
    usuarioId: USUARIO_DUENO,
    dispositivoId: ID_TERMINAL,
    permiso: 'ventas:crear',
    recurso: { tipo: 'venta' as const },
    ahora: mediodia(),
  };

  test('una venta normal pasa, sin obligaciones', async () => {
    const decision = await autorizar(cliente, {
      ...entradaVenta,
      recurso: { tipo: 'venta', monto_minor: 13_000, descuento_pct: 0, descuento_minor: 0 },
    });
    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual([]);
  });

  test('si al contexto le falta un dato que una política necesita, LANCE nombrándolo', async () => {
    // Sin esto, olvidar `descuento_pct` dejaría pasar un descuento del 40 % sin pedir la
    // autorización del dueño, y nadie se enteraría. Es la única forma de que "un campo
    // olvidado" sea un error y no un agujero.
    const error = await autorizar(cliente, entradaVenta).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorContextoIncompleto);
    expect((error as ErrorContextoIncompleto).campos).toEqual([
      'recurso.descuento_minor',
      'recurso.descuento_pct',
      'recurso.monto_minor',
    ]);
    expect(String(error)).toContain('ventas:crear');
  });

  test('con todos los datos, el descuento del 40 % pide autorización', async () => {
    const decision = await autorizar(cliente, {
      ...entradaVenta,
      recurso: { tipo: 'venta', monto_minor: 13_000, descuento_pct: 40, descuento_minor: 5_000 },
    });
    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual(['step_up', 'motivo_obligatorio', 'notificar_dueno']);
    expect(decision.politica_id).toBe('P11-descuento-muy-alto');
  });

  test('con step-up vigente, la obligación de step_up desaparece y el motivo se queda', async () => {
    await cliente.query(
      `INSERT INTO step_up_grants (id, user_id, session_id, metodo, motivo, expira_at)
       VALUES ($1, $2, $3, 'pin', 'ventas:crear', now() + interval '5 min')`,
      [ID_GRANT, USUARIO_DUENO, ID_SESION],
    );

    const decision = await autorizar(cliente, {
      ...entradaVenta,
      recurso: { tipo: 'venta', monto_minor: 13_000, descuento_pct: 40, descuento_minor: 5_000 },
    });

    expect(decision.obligaciones).toEqual(['motivo_obligatorio', 'notificar_dueno']);
  });

  test('un permiso sensible pide step-up aunque no haya ninguna regla escrita para él', async () => {
    // `config:editar` está marcado `es_sensible` en 0002 y ninguna de las 30 reglas habla
    // de él. Si la columna no significara nada, el comentario del esquema estaría mintiendo.
    const decision = await autorizar(cliente, {
      usuarioId: USUARIO_DUENO,
      dispositivoId: ID_TERMINAL,
      permiso: 'config:editar',
      recurso: { tipo: 'config' },
      entorno: { es_offline: false },
    });

    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual(['step_up']);
    expect(decision.politica_id).toBe('SENSIBLE:config:editar');
  });

  test('revocar un dispositivo NO pide step-up, y no es un olvido', async () => {
    // P22 y `es_sensible = false`: en una emergencia hay que poder cortar el acceso de un
    // celular robado sin depender de que el dueño esté delante.
    const decision = await autorizar(cliente, {
      usuarioId: USUARIO_CAJERO,
      dispositivoId: ID_TERMINAL,
      permiso: 'dispositivos:revocar',
      recurso: { tipo: 'dispositivo' },
    });

    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual([]);
  });

  test('el RBAC corta antes: el cajero no cambia precios ni con todos los datos', async () => {
    const decision = await autorizar(cliente, {
      usuarioId: USUARIO_CAJERO,
      dispositivoId: ID_TERMINAL,
      permiso: 'precios:editar',
      recurso: { tipo: 'precio', precio_nuevo_minor: 6000, costo_minor: 3000 },
    });

    expect(decision.permitido).toBe(false);
    expect(decision.motivo).toBe('El rol no incluye precios:editar');
  });

  test('offline de $3,000 en una venta real: paso a paso hasta la decisión', async () => {
    const decision = await autorizar(cliente, {
      ...entradaVenta,
      recurso: { tipo: 'venta', monto_minor: 300_000, descuento_pct: 0, descuento_minor: 0 },
      entorno: { es_offline: true },
    });

    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual(['step_up', 'marcar_para_revision']);
    expect(decision.politica_id).toBe('P27-venta-offline-grande');
  });

  test('una venta de $3,000 CON red no pide nada, y eso también es una decisión', async () => {
    const decision = await autorizar(cliente, {
      ...entradaVenta,
      recurso: { tipo: 'venta', monto_minor: 300_000, descuento_pct: 0, descuento_minor: 0 },
    });

    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual([]);
  });
});
