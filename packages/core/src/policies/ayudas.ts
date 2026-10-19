/**
 * Ayudas para las pruebas de autorización.
 *
 * Montar un `ContextoPolitica` completo a mano en cada caso son 20 líneas que esconden lo
 * único que la prueba quiere decir. Aquí se rellena lo demás con valores neutros y cada
 * prueba escribe sólo lo que le importa.
 *
 * No se exporta desde `index.ts`: es andamio de pruebas, no API del paquete.
 */

import type {
  AtributosAccion,
  AtributosEntorno,
  AtributosRecurso,
  AtributosSujeto,
  ContextoPolitica,
  Politica,
} from './tipos';

export function contexto(opciones: {
  permiso: string;
  sujeto?: Partial<AtributosSujeto>;
  recurso?: Partial<AtributosRecurso>;
  accion?: Partial<AtributosAccion>;
  entorno?: Partial<AtributosEntorno>;
}): ContextoPolitica {
  return {
    sujeto: {
      user_id: '0a000001-0000-7000-8000-000000000001',
      roles: [],
      permisos: [],
      tiene_step_up_reciente: false,
      step_up_hace_segundos: null,
      dispositivo_confiable: true,
      dispositivo_id: '0d000001-0000-7000-8000-000000000001',
      ...opciones.sujeto,
    },
    recurso: { tipo: 'venta', ...opciones.recurso },
    accion: { permiso: opciones.permiso, ...opciones.accion },
    entorno: {
      hora_local: 12,
      dia_semana: 3,
      en_temporada_escolar: false,
      terminal_id: '0d000001-0000-7000-8000-000000000001',
      es_offline: false,
      ...opciones.entorno,
    },
  };
}

export function politica(opciones: Partial<Politica> & { id: string }): Politica {
  return {
    version: 1,
    prioridad: 100,
    efecto: 'permitir',
    aplica_a: {},
    condicion: { op: 'siempre' },
    obligaciones: [],
    motivo: `motivo de ${opciones.id}`,
    activa: true,
    ...opciones,
  };
}

/** Un contexto que trae todo lo que las 31 reglas pueden preguntar. Para las pruebas de validación. */
export function contextoCompleto(permiso: string): ContextoPolitica {
  return contexto({
    permiso,
    recurso: {
      tipo: 'producto',
      id: '0b000001-0000-7000-8000-000000000001',
      precio_actual_minor: 5000,
      precio_nuevo_minor: 6000,
      costo_minor: 3000,
      monto_minor: 1000,
      descuento_pct: 0,
      descuento_minor: 0,
      valor_stock_afectado_minor: 0,
      producto_tiene_stock: true,
      es_venta_ya_cerrada: false,
      tiene_ticket: true,
      impresion_numero: 1,
      diferencia_pct: 0,
      diferencia_minor: 0,
      conteo_ya_aplicado: false,
      retiros_en_turno: 0,
    },
    accion: { productos_afectados: 1 },
  });
}
