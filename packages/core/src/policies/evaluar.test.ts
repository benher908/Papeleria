/**
 * El motor de decisión: puerta RBAC, deny-overrides, obligaciones acumuladas y las dos
 * correcciones al boceto de docs/06 §5 (el step-up resuelto en un solo lugar, y el motivo
 * que se devuelve).
 */

import { describe, expect, test } from 'vitest';
import { contexto, politica } from './ayudas';
import { coincideAplica, coincidePermiso, evaluar, validarPolitica } from './evaluar';
import type { Politica } from './tipos';

const PERMISOS_DUENO = ['*'];
const PERMISOS_CAJERO = ['ventas:crear', 'ventas:leer', 'productos:leer', 'dispositivos:revocar'];

const ventaDe13000 = contexto({ permiso: 'ventas:crear', recurso: { tipo: 'venta', monto_minor: 13000 } });

describe('la puerta gruesa (RBAC)', () => {
  test('sin el permiso no se pasa, y no se miran las políticas', () => {
    const decision = evaluar(contexto({ permiso: 'precios:editar' }), [], PERMISOS_CAJERO);
    expect(decision.permitido).toBe(false);
    expect(decision.motivo).toBe('El rol no incluye precios:editar');
    expect(decision.obligaciones).toEqual([]);
  });

  test('con el permiso se pasa', () => {
    expect(evaluar(ventaDe13000, [], PERMISOS_CAJERO).permitido).toBe(true);
  });

  test('el comodín del dueño abre todo', () => {
    const decision = evaluar(contexto({ permiso: 'policies:editar' }), [], PERMISOS_DUENO);
    expect(decision.permitido).toBe(true);
    expect(decision.motivo).toBe('Sin restricciones adicionales');
    expect(decision.politica_id).toBeUndefined();
  });
});

describe('deny-overrides', () => {
  test('una denegación gana sobre dos permisos, sin importar el orden', () => {
    const permisos: Politica[] = [
      politica({ id: 'A', prioridad: 1, efecto: 'permitir', obligaciones: ['notificar_dueno'] }),
      politica({ id: 'B', prioridad: 2, efecto: 'permitir', obligaciones: ['marcar_para_revision'] }),
      politica({ id: 'C', prioridad: 3, efecto: 'denegar', motivo: 'porque no' }),
    ];

    const decision = evaluar(ventaDe13000, permisos, PERMISOS_CAJERO);

    expect(decision.permitido).toBe(false);
    expect(decision.motivo).toBe('porque no');
    expect(decision.politica_id).toBe('C');
    // Y las obligaciones de las otras dos no sobreviven: no hay nada que cumplir si la
    // acción no se va a hacer.
    expect(decision.obligaciones).toEqual([]);
  });

  test('añadir una regla sólo puede restringir', () => {
    const permisos: Politica[] = [politica({ id: 'A', efecto: 'permitir' })];
    expect(evaluar(ventaDe13000, permisos, PERMISOS_CAJERO).permitido).toBe(true);

    const conDenegacion = [...permisos, politica({ id: 'B', efecto: 'denegar' })];
    expect(evaluar(ventaDe13000, conDenegacion, PERMISOS_CAJERO).permitido).toBe(false);
  });

  test('la denegación que se reporta es la de menor prioridad (la más específica)', () => {
    const permisos: Politica[] = [
      politica({ id: 'general', prioridad: 900, efecto: 'denegar', motivo: 'general' }),
      politica({ id: 'especifica', prioridad: 10, efecto: 'denegar', motivo: 'específica' }),
    ];
    expect(evaluar(ventaDe13000, permisos, PERMISOS_CAJERO).motivo).toBe('específica');
  });
});

describe('obligaciones', () => {
  test('se acumulan, sin repetirse', () => {
    const permisos: Politica[] = [
      politica({ id: 'A', obligaciones: ['step_up'] }),
      politica({ id: 'B', obligaciones: ['step_up', 'motivo_obligatorio'] }),
      politica({ id: 'C', obligaciones: ['notificar_dueno'] }),
    ];

    expect(evaluar(ventaDe13000, permisos, PERMISOS_CAJERO).obligaciones).toEqual([
      'step_up',
      'motivo_obligatorio',
      'notificar_dueno',
    ]);
  });

  test('vuelven en el orden del catálogo, no en el orden en que aparecieron las reglas', () => {
    const alReves: Politica[] = [
      politica({ id: 'A', obligaciones: ['notificar_dueno', 'marcar_para_revision'] }),
    ];
    const derechas: Politica[] = [
      politica({ id: 'A', obligaciones: ['marcar_para_revision', 'notificar_dueno'] }),
    ];

    // Un registro de auditoría que cambia de orden porque alguien reordenó las
    // obligaciones dentro de una regla es un registro que no se puede comparar consigo
    // mismo de un mes a otro.
    const a = evaluar(ventaDe13000, alReves, PERMISOS_CAJERO).obligaciones;
    const b = evaluar(ventaDe13000, derechas, PERMISOS_CAJERO).obligaciones;
    expect(a).toEqual(b);
    expect(a).toEqual(['notificar_dueno', 'marcar_para_revision']);
  });

  test('el step_up ya satisfecho deja de pedirse, y las otras obligaciones se quedan', () => {
    // Ésta es la corrección al boceto, y la prueba que la justifica. El boceto ponía la
    // cláusula `tiene_step_up_reciente == false` DENTRO de la condición de la regla. Con
    // eso, al teclear el PIN la regla deja de aplicar y se lleva consigo las obligaciones
    // que no eran el step-up: P11 ("descuento > 30 %") dejaría de exigir el motivo y de
    // avisar al dueño justo en el momento de autorizarla.
    const p11 = politica({
      id: 'P11',
      obligaciones: ['step_up', 'motivo_obligatorio', 'notificar_dueno'],
    });

    const antes = contexto({
      permiso: 'ventas:crear',
      recurso: { tipo: 'venta', descuento_pct: 40 },
      sujeto: { tiene_step_up_reciente: false },
    });
    const despues = contexto({
      permiso: 'ventas:crear',
      recurso: { tipo: 'venta', descuento_pct: 40 },
      sujeto: { tiene_step_up_reciente: true, step_up_hace_segundos: 10 },
    });

    expect(evaluar(antes, [p11], PERMISOS_CAJERO).obligaciones).toEqual([
      'step_up',
      'motivo_obligatorio',
      'notificar_dueno',
    ]);
    expect(evaluar(despues, [p11], PERMISOS_CAJERO).obligaciones).toEqual([
      'motivo_obligatorio',
      'notificar_dueno',
    ]);
  });
});

describe('condición indeterminada: fallar cerrado', () => {
  const denegarPorMonto = politica({
    id: 'P-DENIEGA',
    efecto: 'denegar',
    prioridad: 10,
    motivo: 'monto demasiado alto',
    condicion: { op: 'gt', campo: 'recurso.monto_minor', valor: 100 },
  });

  test('una denegación se aplica aunque no se pueda evaluar su condición', () => {
    // El contexto NO trae `monto_minor`. Si esto se resolviera como "condición no
    // cumplida", bastaría con que un llamador olvidara rellenar el campo para desactivar
    // la regla, sin que nada avise.
    const sinMonto = contexto({ permiso: 'ventas:crear', recurso: { tipo: 'venta' } });
    const decision = evaluar(sinMonto, [denegarPorMonto], PERMISOS_CAJERO);

    expect(decision.permitido).toBe(false);
    expect(decision.porContextoIncompleto).toBe(true);
    expect(decision.motivo).toContain('monto demasiado alto');
    expect(decision.motivo).toContain('le falta algún dato');
  });

  test('y cuando sí se puede evaluar, se evalúa', () => {
    const decision = evaluar(ventaDe13000, [denegarPorMonto], PERMISOS_CAJERO);
    expect(decision.permitido).toBe(false);
    expect(decision.porContextoIncompleto).toBeUndefined();
  });

  test('una regla que permite no se aplica si no se puede evaluar su condición', () => {
    // Lo contrario: ante la duda no se conceden obligaciones que nadie pidió… ni se
    // concede nada. La venta pasa, pero sin la marca de "revisar", y eso es lo conservador
    // en el otro sentido.
    const permitir = politica({
      id: 'P-PERMITE',
      condicion: { op: 'gt', campo: 'recurso.monto_minor', valor: 100 },
      obligaciones: ['marcar_para_revision'],
    });

    const sinMonto = contexto({ permiso: 'ventas:crear', recurso: { tipo: 'venta' } });
    const decision = evaluar(sinMonto, [permitir], PERMISOS_CAJERO);

    expect(decision.permitido).toBe(true);
    expect(decision.obligaciones).toEqual([]);
    expect(decision.politica_id).toBeUndefined();
  });
});

describe('a qué aplica cada política', () => {
  test('coincidePermiso entiende el comodín final', () => {
    expect(coincidePermiso('ventas:crear', 'ventas:crear')).toBe(true);
    expect(coincidePermiso('ventas:crear', 'ventas:leer')).toBe(false);
    expect(coincidePermiso('ventas:*', 'ventas:crear')).toBe(true);
    expect(coincidePermiso('ventas:*', 'turnos:crear')).toBe(false);
    expect(coincidePermiso('*', 'lo:que:sea')).toBe(true);
    // Un `*` que no sea el último trozo NO es un comodín: el evaluador acepta exactamente
    // las tres formas que valida `validarPolitica`, ni una más. Si aquí hubiera una
    // coincidencia por prefijo, `'ventas:cre'` (un permiso truncado) cubriría
    // `ventas:crear` y la revisión no lo vería.
    expect(coincidePermiso('ventas:cre*', 'ventas:crear')).toBe(false);
    expect(coincidePermiso('ventas:cre', 'ventas:crear')).toBe(false);
  });

  test('aplica_a vacío es "de todo"', () => {
    expect(coincideAplica({}, ventaDe13000)).toBe(true);
  });

  test('aplica_a.recurso filtra por el tipo de la cosa, no por el módulo del permiso', () => {
    const sobreVentas = politica({ id: 'X', aplica_a: { recurso: 'venta' } });
    const sobreProductos = politica({ id: 'Y', aplica_a: { recurso: 'producto' } });

    expect(evaluar(ventaDe13000, [sobreVentas], PERMISOS_CAJERO).politica_id).toBe('X');
    expect(evaluar(ventaDe13000, [sobreProductos], PERMISOS_CAJERO).politica_id).toBeUndefined();
  });

  test('una política inactiva no se aplica', () => {
    const apagada = politica({ id: 'Z', efecto: 'denegar', activa: false });
    expect(evaluar(ventaDe13000, [apagada], PERMISOS_CAJERO).permitido).toBe(true);
  });

  test('el motivo y la política que se reportan son los de la primera por prioridad', () => {
    const permisos: Politica[] = [
      politica({ id: 'especifica', prioridad: 20, motivo: 'descuento autorizado por el dueño' }),
      politica({ id: 'general', prioridad: 900, motivo: 'venta normal' }),
    ];

    const decision = evaluar(ventaDe13000, permisos, PERMISOS_CAJERO);
    expect(decision.motivo).toBe('descuento autorizado por el dueño');
    expect(decision.politica_id).toBe('especifica');
  });
});

describe('validarPolitica', () => {
  const buena = politica({ id: 'P10-descuento-alto', obligaciones: ['step_up'] });

  test('una política bien formada no tiene problemas', () => {
    expect(validarPolitica(buena)).toEqual([]);
    expect(
      validarPolitica({
        ...buena,
        aplica_a: { permiso: 'usuarios:*' },
        condicion: { op: 'lt', campo: 'recurso.precio_nuevo_minor', campo2: 'recurso.costo_minor' },
      }),
    ).toEqual([]);
  });

  test('las obligaciones tienen que ser del catálogo y no repetirse', () => {
    const conTypo = validarPolitica({ ...buena, obligaciones: ['stepup'] });
    expect(conTypo[0]).toContain('stepup');
    expect(conTypo[0]).toContain('step_up');

    const repetida = validarPolitica({ ...buena, obligaciones: ['step_up', 'step_up'] });
    expect(repetida[0]).toContain('dos veces');
  });

  test('el motivo no puede estar vacío: es lo que ve el usuario', () => {
    expect(validarPolitica({ ...buena, motivo: '' })[0]).toContain('motivo');
  });

  test('el patrón de permiso tiene que ser recurso:acción, recurso:* o *', () => {
    expect(validarPolitica({ ...buena, aplica_a: { permiso: 'puedeEditarPrecios' } })).toHaveLength(1);
    expect(validarPolitica({ ...buena, aplica_a: { permiso: 'ventas:crear' } })).toEqual([]);
    expect(validarPolitica({ ...buena, aplica_a: { permiso: '*' } })).toEqual([]);
  });

  test('el tipo de recurso tiene que existir', () => {
    expect(validarPolitica({ ...buena, aplica_a: { recurso: 'ventas' } })[0]).toContain('venta');
    expect(validarPolitica({ ...buena, aplica_a: { recurso: 'venta' } })).toEqual([]);
  });

  test('los problemas llevan el id de la política delante', () => {
    expect(validarPolitica({ ...buena, efecto: 'quizá' })[0]).toMatch(/^P10-descuento-alto: /);
  });

  test('una política que no es un objeto se rechaza sin explotar', () => {
    expect(validarPolitica(null)).toEqual(['la política tiene que ser un objeto']);
  });
});
