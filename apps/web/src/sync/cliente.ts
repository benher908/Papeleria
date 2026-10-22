import { aplicarEventoRemoto, type EventoRemoto } from '@papeleria/db';
import type { BaseLocal } from '../db/baseLocal';
import { tokenSupabase } from '../auth/supabase';

export const API_SYNC = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '')
  || 'https://papeleria-plw6.onrender.com';
const TOKEN_KEY = 'papeleria.sync.token';
const DEVICE_KEY = 'papeleria.sync.device';

export async function emparejarDispositivo(deviceId: string, codigo: string): Promise<void> {
  const jwt = await tokenSupabase();
  const response = await fetch(`${API_SYNC}/sync/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-supabase-token': jwt ?? '' },
    body: JSON.stringify({ device_id: deviceId, pairing_code: codigo.trim() }),
  });
  const body = await response.json() as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error ?? 'No se pudo emparejar el dispositivo.');
  localStorage.setItem(TOKEN_KEY, body.token);
  localStorage.setItem(DEVICE_KEY, deviceId);
}

export function estaEmparejado(deviceId: string): boolean {
  return localStorage.getItem(DEVICE_KEY) === deviceId && localStorage.getItem(TOKEN_KEY) !== null;
}

/** Fuerza un ciclo completo de subida y descarga desde la interfaz. */
export async function sincronizarAhora(base: BaseLocal, deviceId: string): Promise<void> {
  if (!navigator.onLine) throw new Error('No hay conexión a internet.');
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || localStorage.getItem(DEVICE_KEY) !== deviceId) {
    throw new Error('Este dispositivo todavía no está vinculado.');
  }
  await sincronizarUnaVez(base, deviceId, token);
}

export function iniciarSincronizacion(
  base: BaseLocal,
  deviceId: string,
  alEstado: (texto: string) => void,
): () => void {
  if (!estaEmparejado(deviceId)) { alEstado('Sin vincular (usa código al entrar)'); return () => undefined; }
  let detenido = false;
  let trabajando = false;
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const token = localStorage.getItem(TOKEN_KEY)!;

  const ciclo = async (): Promise<void> => {
    if (detenido || trabajando || !navigator.onLine) {
      if (!detenido) alEstado(navigator.onLine ? 'Sincronizado' : 'Sin conexión');
      programar(15_000); return;
    }
    trabajando = true;
    alEstado('Sincronizando…');
    try {
      await sincronizarUnaVez(base, deviceId, token);
      alEstado('Sincronizado');
      programar(20_000);
    } catch (error) {
      console.warn('[sincronización]', error);
      alEstado('Pendiente de conexión');
      programar(30_000);
    } finally { trabajando = false; }
  };
  const programar = (ms: number): void => {
    if (!detenido) temporizador = setTimeout(() => void ciclo(), ms);
  };
  const alVolver = (): void => { if (temporizador) clearTimeout(temporizador); void ciclo(); };
  window.addEventListener('online', alVolver);
  void ciclo();
  return () => {
    detenido = true;
    if (temporizador) clearTimeout(temporizador);
    window.removeEventListener('online', alVolver);
  };
}

async function sincronizarUnaVez(base: BaseLocal, deviceId: string, token: string): Promise<void> {
  const pendientes = await base.consultar<{ event_id: string; payload: EventoRemoto }>(
    "SELECT event_id,payload FROM outbox ORDER BY (payload->>'device_seq')::bigint LIMIT 200",
  );
  if (pendientes.length) {
    const jwt = await tokenSupabase();
    const response = await fetch(`${API_SYNC}/sync/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-supabase-token': jwt ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ events: pendientes.map((fila) => fila.payload) }),
    });
    const body = await response.json() as { accepted?: string[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Error al enviar cambios (${response.status}).`);
    if (body.accepted?.length) {
      await base.ejecutar('DELETE FROM outbox WHERE event_id = ANY($1)', [body.accepted]);
    }
  }

  const fila = await base.consultarUno<{ last_pull_seq: string }>(
    'SELECT last_pull_seq::text FROM sync_cursors WHERE device_id=$1', [deviceId],
  );
  let cursor = Number(fila?.last_pull_seq ?? 0);
  for (let pagina = 0; pagina < 10; pagina++) {
    const response = await fetch(`${API_SYNC}/sync/pull?since=${cursor}&limit=200`, {
      headers: { authorization: `Bearer ${token}`, 'x-supabase-token': (await tokenSupabase()) ?? '' },
    });
    const body = await response.json() as {
      events?: Array<{ server_seq: number; device_id: string; payload: EventoRemoto }>;
      next_cursor?: number; has_more?: boolean; error?: string;
    };
    if (!response.ok || !body.events || typeof body.next_cursor !== 'number') {
      throw new Error(body.error ?? `Error al recibir cambios (${response.status}).`);
    }
    if (body.events.length) {
      await base.enTransaccion(async (tx) => {
        for (const remoto of body.events!) {
          const ya = await tx.consultarUno('SELECT 1 FROM sync_applied_events WHERE event_id=$1', [remoto.payload.event_id]);
          if (!ya && remoto.device_id !== deviceId) await aplicarEventoRemoto({
            exec: (sql) => tx.lote(sql),
            query: async <T>(sql: string, params?: unknown[]) => ({
              rows: await tx.consultar<T>(sql, params),
            }),
          }, remoto.payload);
          await tx.ejecutar(
            `INSERT INTO sync_applied_events (event_id,server_seq) VALUES ($1,$2)
             ON CONFLICT (event_id) DO UPDATE SET server_seq=GREATEST(sync_applied_events.server_seq,EXCLUDED.server_seq)`,
            [remoto.payload.event_id,remoto.server_seq],
          );
        }
      });
    }
    cursor = body.next_cursor;
    await base.ejecutar(
      `INSERT INTO sync_cursors (device_id,last_pull_seq) VALUES ($1,$2)
       ON CONFLICT (device_id) DO UPDATE SET last_pull_seq=GREATEST(sync_cursors.last_pull_seq,EXCLUDED.last_pull_seq)`,
      [deviceId,cursor],
    );
    if (!body.has_more || body.events.length === 0) break;
  }
  await base.sincronizar();
}
