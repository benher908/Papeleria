/**
 * CUÁNTO DURA UNA SESIÓN — las reglas, no el mecanismo.
 *
 * Puro y sin IO, como el resto del núcleo. Están aquí y no dentro de una consulta SQL
 * por una razón concreta: mañana esto corre también en el servidor (F4), y el servidor
 * tiene que dar por vencida una sesión **en el mismo instante** en que la da por vencida
 * el navegador. Si la regla viviera en dos sitios, un día dirían cosas distintas y el
 * servidor seguiría aceptando una sesión que la caja ya cerró.
 *
 * Los números son los de docs/07 §2.3, y se dejan como datos legibles — no como
 * constantes sueltas dentro de funciones — porque un umbral que se puede leer y discutir
 * es un umbral que se puede corregir.
 */

/** Dónde se está usando la sesión. Cada uno tiene su paciencia. */
export type ContextoSesion = 'caja' | 'admin' | 'escaner' | 'localApi';

export interface PoliticaSesion {
  /** Minutos que vive el token de acceso. Hoy sólo lo usa el servidor (F4). */
  readonly accessMin: number;
  /** Minutos de inactividad antes de bloquear la pantalla. */
  readonly idleMin: number;
  /** Tope duro en horas. Pasado esto hay que volver a entrar aunque se haya usado. */
  readonly absoluteH: number;
  /**
   * ¿El desbloqueo exige volver a autenticarse entero (passkey), en vez de un PIN?
   * En el panel de administración sí; en la caja no, porque bloquear la caja en plena
   * fila de clientes por un PIN es la forma más rápida de que el PIN se apunte en un
   * papel pegado al monitor.
   */
  readonly requiereReLogin: boolean;
}

export const POLITICAS_SESION: Readonly<Record<ContextoSesion, PoliticaSesion>> = {
  caja: { accessMin: 15, idleMin: 30, absoluteH: 12, requiereReLogin: false },
  admin: { accessMin: 15, idleMin: 15, absoluteH: 24 * 7, requiereReLogin: true },
  escaner: { accessMin: 60, idleMin: 60, absoluteH: 12, requiereReLogin: false },
  localApi: { accessMin: 5, idleMin: 5, absoluteH: 1, requiereReLogin: false },
};

const MS_POR_MINUTO = 60_000;
const MS_POR_HORA = 3_600_000;

/** Los dos vencimientos de una sesión recién creada, en milisegundos desde la época. */
export function vencimientosDeSesion(
  contexto: ContextoSesion,
  creadaEn: number,
): { readonly idle: number; readonly absoluto: number } {
  const politica = POLITICAS_SESION[contexto];
  return {
    idle: creadaEn + politica.idleMin * MS_POR_MINUTO,
    absoluto: creadaEn + politica.absoluteH * MS_POR_HORA,
  };
}

export type MotivoVencimiento = 'inactividad' | 'absoluta';

/**
 * ¿Esta sesión ya no vale? Devuelve el motivo, o `null` si sigue viva.
 *
 * Se comprueba primero el tope absoluto: si vencieron los dos, el motivo que importa
 * reportar es el duro, porque es el único que exige volver a entrar de verdad. Reportar
 * "inactividad" cuando en realidad se cumplió el día haría creer que basta con teclear
 * algo para seguir.
 */
export function motivoDeVencimiento(
  sesion: { readonly idle_expires_at: number; readonly absolute_expires_at: number },
  ahora: number,
): MotivoVencimiento | null {
  if (ahora >= sesion.absolute_expires_at) return 'absoluta';
  if (ahora >= sesion.idle_expires_at) return 'inactividad';
  return null;
}

/**
 * Hasta cuándo se corre la ventana de inactividad al usar la sesión.
 *
 * La ventana **no se recibe como contexto**: se deduce de la propia fila, porque
 * `idle_expires_at - last_used_at` es siempre, exactamente, el largo de la ventana. Pedir
 * el contexto otra vez sería un dato de más que puede contradecir a la fila — la sesión
 * se creó con una política, y quien la verifica después no debería poder cambiarle las
 * reglas. Con el contexto como parámetro, una pantalla que pasara `'admin'` al verificar
 * una sesión de caja le estiraría el bloqueo de 30 minutos a 15.
 *
 * El `min` contra el tope absoluto no es un detalle: sin él, usar la caja cada 29 minutos
 * mantendría la sesión viva para siempre y el límite de 12 horas sería decorativo. Un
 * tope que se puede posponer usando el sistema no es un tope.
 */
export function siguienteVencimientoPorInactividad(
  sesion: { readonly absolute_expires_at: number; readonly idle_ms: number },
  ahora: number,
): number {
  return Math.min(ahora + sesion.idle_ms, sesion.absolute_expires_at);
}
