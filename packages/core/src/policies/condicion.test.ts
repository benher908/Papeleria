/**
 * La gramática de condiciones: operadores, indeterminación y validación.
 *
 * Lo que estas pruebas fijan, además del "funciona":
 *
 *   · que un campo ausente da **indeterminado** y no `false` (ver condicion.ts: si diera
 *     `false`, olvidar rellenar un campo desactivaría una regla de seguridad en silencio);
 *   · que la indeterminación **se propaga** con la lógica correcta;
 *   · que comparar cosas de tipos distintos no es "distinto", es indeterminado;
 *   · que la validación rechaza el campo mal escrito **con el nombre a la vista**.
 */

import { describe, expect, test } from 'vitest';
import { contexto } from './ayudas';
import { evaluarCondicion, validarCondicion } from './condicion';
import type { Condicion } from './tipos';

const ctx = contexto({
  permiso: 'ventas:crear',
  recurso: { tipo: 'venta', monto_minor: 13000, descuento_pct: 15, precio_nuevo_minor: 400, costo_minor: 500 },
  entorno: { hora_local: 21, es_offline: true },
});

describe('operadores', () => {
  test('siempre es cierto sin mirar el contexto', () => {
    expect(evaluarCondicion({ op: 'siempre' }, ctx)).toBe(true);
  });

  test('las comparaciones numéricas comparan números, no texto', () => {
    expect(evaluarCondicion({ op: 'gt', campo: 'recurso.monto_minor', valor: 12000 }, ctx)).toBe(true);
    expect(evaluarCondicion({ op: 'gte', campo: 'recurso.monto_minor', valor: 13000 }, ctx)).toBe(true);
    expect(evaluarCondicion({ op: 'lt', campo: 'recurso.monto_minor', valor: 13000 }, ctx)).toBe(false);
    expect(evaluarCondicion({ op: 'lte', campo: 'recurso.monto_minor', valor: 13000 }, ctx)).toBe(true);
    expect(evaluarCondicion({ op: 'eq', campo: 'recurso.monto_minor', valor: 13000 }, ctx)).toBe(true);
    expect(evaluarCondicion({ op: 'ne', campo: 'recurso.monto_minor', valor: 13000 }, ctx)).toBe(false);
  });

  test('eq y ne sirven para texto y para booleanos', () => {
    expect(evaluarCondicion({ op: 'eq', campo: 'sujeto.user_id', valor: 'otro' }, ctx)).toBe(false);
    expect(evaluarCondicion({ op: 'eq', campo: 'entorno.es_offline', valor: true }, ctx)).toBe(true);
  });

  test('campo contra campo: la forma que P1 necesitaba', () => {
    // P1: "precio nuevo MENOR AL COSTO". 400 < 500.
    expect(
      evaluarCondicion({ op: 'lt', campo: 'recurso.precio_nuevo_minor', campo2: 'recurso.costo_minor' }, ctx),
    ).toBe(true);

    // P3: "precio nuevo IGUAL al costo" con estos números no se cumple.
    expect(
      evaluarCondicion({ op: 'eq', campo: 'recurso.precio_nuevo_minor', campo2: 'recurso.costo_minor' }, ctx),
    ).toBe(false);
  });

  test('gt_abs mira el valor absoluto, así que el faltante cuenta igual que el sobrante', () => {
    const faltante = contexto({ permiso: 'turnos:cerrar', recurso: { tipo: 'turno', diferencia_minor: -7000 } });
    const sobrante = contexto({ permiso: 'turnos:cerrar', recurso: { tipo: 'turno', diferencia_minor: 7000 } });

    // Un `gt` normal no vería el faltante: -7000 no es mayor que 5000.
    expect(evaluarCondicion({ op: 'gt', campo: 'recurso.diferencia_minor', valor: 5000 }, faltante)).toBe(false);
    expect(evaluarCondicion({ op: 'gt_abs', campo: 'recurso.diferencia_minor', valor: 5000 }, faltante)).toBe(true);
    expect(evaluarCondicion({ op: 'gt_abs', campo: 'recurso.diferencia_minor', valor: 5000 }, sobrante)).toBe(true);
  });

  test('en, para los campos de lista corta', () => {
    expect(evaluarCondicion({ op: 'en', campo: 'recurso.tipo', valores: ['venta', 'turno'] }, ctx)).toBe(true);
    expect(evaluarCondicion({ op: 'en', campo: 'recurso.tipo', valores: ['producto'] }, ctx)).toBe(false);
  });

  test('and, or y not', () => {
    const esOfflineYCaro: Condicion = {
      op: 'and',
      args: [
        { op: 'eq', campo: 'entorno.es_offline', valor: true },
        { op: 'gt', campo: 'recurso.monto_minor', valor: 200000 },
      ],
    };
    expect(evaluarCondicion(esOfflineYCaro, ctx)).toBe(false);

    expect(
      evaluarCondicion(
        { op: 'or', args: [{ op: 'gt', campo: 'recurso.monto_minor', valor: 99999 }, { op: 'eq', campo: 'entorno.hora_local', valor: 21 }] },
        ctx,
      ),
    ).toBe(true);

    expect(evaluarCondicion({ op: 'not', arg: { op: 'eq', campo: 'entorno.es_offline', valor: true } }, ctx)).toBe(false);
  });
});

describe('indeterminado cuando al contexto le falta un campo', () => {
  const sinMonto = contexto({ permiso: 'ventas:crear' });
  const pregunta: Condicion = { op: 'gt', campo: 'recurso.monto_minor', valor: 500 };

  test('un campo que no viene da indeterminado, no `false`', () => {
    // Si esto diera `false`, una política que deniega por monto se apagaría sola en cuanto
    // alguien olvidara rellenar el campo, y nadie se enteraría. `evaluar()` resuelve el
    // indeterminado según el efecto; aquí sólo se fija que la condición no miente.
    expect(evaluarCondicion(pregunta, sinMonto)).toBeNull();
  });

  test('`and` es falso si algún argumento es falso, aunque otro sea indeterminado', () => {
    expect(
      evaluarCondicion(
        { op: 'and', args: [{ op: 'eq', campo: 'entorno.es_offline', valor: false }, pregunta] },
        contexto({ permiso: 'ventas:crear', entorno: { es_offline: true } }),
      ),
    ).toBe(false);
  });

  test('`and` es indeterminado si nada es falso ni todo cierto', () => {
    expect(
      evaluarCondicion(
        { op: 'and', args: [{ op: 'eq', campo: 'entorno.es_offline', valor: false }, pregunta] },
        sinMonto,
      ),
    ).toBeNull();
  });

  test('`or` es cierto si algún argumento lo es, aunque otro sea indeterminado', () => {
    expect(
      evaluarCondicion(
        { op: 'or', args: [{ op: 'eq', campo: 'entorno.es_offline', valor: false }, pregunta] },
        sinMonto,
      ),
    ).toBe(true);
  });

  test('`or` es indeterminado si nada es cierto ni todo falso', () => {
    expect(
      evaluarCondicion(
        { op: 'or', args: [{ op: 'eq', campo: 'entorno.es_offline', valor: true }, pregunta] },
        sinMonto,
      ),
    ).toBeNull();
  });

  test('`not` de indeterminado sigue siendo indeterminado', () => {
    expect(evaluarCondicion({ op: 'not', arg: pregunta }, sinMonto)).toBeNull();
  });

  test('comparar tipos distintos no es "distinto": es indeterminado', () => {
    // `5` y `'5'` no son iguales ni desiguales. Responder `false` a un `eq` aquí sería
    // decir "no son iguales" cuando la verdad es que la política está mal escrita.
    expect(evaluarCondicion({ op: 'eq', campo: 'recurso.monto_minor', valor: '500' }, { ...sinMonto, recurso: { tipo: 'venta', monto_minor: 500 } })).toBeNull();
    expect(evaluarCondicion({ op: 'gt', campo: 'recurso.monto_minor', valor: 5 }, { ...sinMonto, recurso: { tipo: 'venta', monto_minor: 500 } })).toBe(true);
  });

  test('un `>` sobre texto no significa nada, y no se finge que sí', () => {
    expect(evaluarCondicion({ op: 'gt', campo: 'sujeto.user_id', valor: 'a' }, ctx)).toBeNull();
  });

  test('los campos de lista no se comparan desde una política', () => {
    // No es una limitación técnica: docs/06 §8 prohíbe las condiciones de rol en el código,
    // y una política que pregunte por `sujeto.roles` es exactamente eso con otra sintaxis.
    expect(evaluarCondicion({ op: 'eq', campo: 'sujeto.roles', valor: 'dueno' }, ctx)).toBeNull();
  });
});

describe('validación', () => {
  test('una condición correcta no tiene problemas', () => {
    expect(validarCondicion({ op: 'lt', campo: 'recurso.precio_nuevo_minor', campo2: 'recurso.costo_minor' })).toEqual([]);
    expect(validarCondicion({ op: 'siempre' })).toEqual([]);
    expect(
      validarCondicion({
        op: 'and',
        args: [
          { op: 'eq', campo: 'entorno.es_offline', valor: true },
          { op: 'gt', campo: 'recurso.monto_minor', valor: 200000 },
        ],
      }),
    ).toEqual([]);
  });

  test('un campo que no existe se rechaza nombrando el campo y sugiriendo el bueno', () => {
    const problemas = validarCondicion({ op: 'gt', campo: 'recurso.monto', valor: 100 });
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('recurso.monto');
    expect(problemas[0]).toContain('recurso.monto_minor');
  });

  test('un operador que no existe se rechaza listando los que hay', () => {
    const problemas = validarCondicion({ op: 'mas_o_menos', campo: 'recurso.monto_minor', valor: 1 });
    expect(problemas[0]).toContain('no existe');
    expect(problemas[0]).toContain('gt_abs');
  });

  test('un operador numérico sobre texto se rechaza', () => {
    const problemas = validarCondicion({ op: 'gt', campo: 'sujeto.user_id', valor: 'a' });
    expect(problemas[0]).toContain('no se puede usar sobre');
  });

  test('hace falta exactamente uno de valor o campo2', () => {
    expect(validarCondicion({ op: 'gt', campo: 'recurso.monto_minor' })).toHaveLength(1);
    expect(
      validarCondicion({ op: 'gt', campo: 'recurso.monto_minor', valor: 1, campo2: 'recurso.costo_minor' }),
    ).toHaveLength(1);
  });

  test('comparar campos de tipo distinto se rechaza', () => {
    const problemas = validarCondicion({ op: 'eq', campo: 'recurso.monto_minor', campo2: 'sujeto.user_id' });
    expect(problemas[0]).toContain('no se pueden comparar');
  });

  test('el tipo del literal tiene que coincidir con el del campo', () => {
    const problemas = validarCondicion({ op: 'eq', campo: 'recurso.monto_minor', valor: 'mucho' });
    expect(problemas[0]).toContain('es numérico');
  });

  test('and/or con la lista vacía no dicen nada, y se rechazan', () => {
    expect(validarCondicion({ op: 'and', args: [] })[0]).toContain('vacía');
    expect(validarCondicion({ op: 'or', args: [] })[0]).toContain('vacía');
  });

  test('en con la lista vacía nunca se cumpliría: se rechaza', () => {
    expect(validarCondicion({ op: 'en', campo: 'recurso.tipo', valores: [] })[0]).toContain('vacía');
  });

  test('el camino del error dice dónde está el problema', () => {
    const problemas = validarCondicion(
      { op: 'and', args: [{ op: 'gt', campo: 'recurso.nope', valor: 1 }] },
      'P9.condicion',
    );
    expect(problemas[0]).toContain('P9.condicion.and[0]');
  });

  test('una condición que no es un objeto se rechaza sin explotar', () => {
    expect(validarCondicion(null)).toEqual(['condicion: tiene que ser un objeto con `op`']);
    expect(validarCondicion('gt')).toEqual(['condicion: tiene que ser un objeto con `op`']);
    expect(validarCondicion([])).toEqual(['condicion: tiene que ser un objeto con `op`']);
  });
});
