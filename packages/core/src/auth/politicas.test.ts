import { describe, expect, test } from 'vitest';

import {
  motivoDeVencimiento,
  siguienteVencimientoPorInactividad,
  vencimientosDeSesion,
} from './politicas';

const MINUTO = 60_000;
const HORA = 3_600_000;
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);

describe('vencimientosDeSesion', () => {
  test('la caja aguanta 30 minutos parada y 12 horas en total', () => {
    const { idle, absoluto } = vencimientosDeSesion('caja', T0);
    expect(idle - T0).toBe(30 * MINUTO);
    expect(absoluto - T0).toBe(12 * HORA);
  });

  test('el panel de administración aguanta 7 días: es tu propio panel', () => {
    const { idle, absoluto } = vencimientosDeSesion('admin', T0);
    expect(idle - T0).toBe(15 * MINUTO);
    expect(absoluto - T0).toBe(7 * 24 * HORA);
  });

  test('la inactividad siempre cabe dentro del tope duro', () => {
    for (const contexto of ['caja', 'admin', 'escaner', 'localApi'] as const) {
      const { idle, absoluto } = vencimientosDeSesion(contexto, T0);
      // El CHECK de `sessions` exige exactamente esto; comprobarlo aquí evita que un
      // cambio de números produzca un INSERT que la base rechaza en tiempo de ejecución.
      expect(idle).toBeLessThanOrEqual(absoluto);
    }
  });
});

describe('motivoDeVencimiento', () => {
  const sesion = { idle_expires_at: T0 + 30 * MINUTO, absolute_expires_at: T0 + 12 * HORA };

  test('recién creada, viva', () => {
    expect(motivoDeVencimiento(sesion, T0)).toBeNull();
  });

  test('pasada la ventana de inactividad, bloqueada', () => {
    expect(motivoDeVencimiento(sesion, T0 + 30 * MINUTO + 1)).toBe('inactividad');
  });

  test('cumplido el tope duro, hay que volver a entrar', () => {
    expect(motivoDeVencimiento(sesion, T0 + 12 * HORA + 1)).toBe('absoluta');
  });

  test('el instante exacto ya está vencido, no es el último válido', () => {
    // Frontera a propósito: un `>` en vez de un `>=` deja una sesión viva durante un
    // milisegundo de más, y esa clase de detalle es la que se copia mal a otro archivo.
    expect(motivoDeVencimiento(sesion, T0 + 30 * MINUTO)).toBe('inactividad');
    expect(motivoDeVencimiento(sesion, T0 + 12 * HORA)).toBe('absoluta');
  });

  test('si venció por los dos lados, manda el tope duro', () => {
    // Reportar 'inactividad' haría creer que teclear algo la revive. No la revive.
    expect(motivoDeVencimiento(sesion, T0 + 13 * HORA)).toBe('absoluta');
  });
});

describe('siguienteVencimientoPorInactividad', () => {
  const sesion = { absolute_expires_at: T0 + 12 * HORA, idle_ms: 30 * MINUTO };

  test('usar la caja corre la ventana de inactividad', () => {
    const ahora = T0 + 20 * MINUTO;
    expect(siguienteVencimientoPorInactividad(sesion, ahora)).toBe(ahora + 30 * MINUTO);
  });

  test('pero nunca más allá del tope duro', () => {
    // A las 11 h 50 min, otros 30 min de inactividad pasarían de las 12 h. El tope
    // manda: si no, usar la caja cada 29 minutos la mantendría viva indefinidamente.
    const ahora = T0 + 11 * HORA + 50 * MINUTO;
    expect(siguienteVencimientoPorInactividad(sesion, ahora)).toBe(T0 + 12 * HORA);
  });

  test('la ventana es la que trae la fila, no una que decida quien verifica', () => {
    // Una sesión del panel: 15 min. Si esta función recibiera el contexto en vez del
    // largo, una pantalla que pasara 'caja' le estiraría el bloqueo a 30.
    const delPanel = { absolute_expires_at: T0 + 7 * 24 * HORA, idle_ms: 15 * MINUTO };
    const ahora = T0 + 5 * MINUTO;
    expect(siguienteVencimientoPorInactividad(delPanel, ahora)).toBe(ahora + 15 * MINUTO);
  });
});
