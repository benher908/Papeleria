import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cargarMigraciones } from '@papeleria/db/node';
import { adaptarPg, aplicarEventoRemoto, migrar } from '@papeleria/db';

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Falta DATABASE_URL.');
const pairingCode = process.env.SYNC_PAIRING_CODE;
if (pairingCode && pairingCode.length < 32) {
  throw new Error('SYNC_PAIRING_CODE debe tener al menos 32 caracteres aleatorios.');
}
const pool = new Pool({ connectionString: databaseUrl, max: 5, ssl: { rejectUnauthorized: false } });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const TIPOS_EVENTO = new Set([
  'category.created','supplier.created','supplier.updated','unit.created','unit.updated',
  'product.created','product.updated','cash_session.opened','cash_session.closed',
  'cash_movement.created','stock.received','stock.adjusted','stock.counted',
  'sale.created','sale.cancelled',
]);

interface Evento {
  event_id: string;
  device_id: string;
  device_seq: number;
  type: string;
  payload: Record<string, unknown>;
}

async function aplicarMigraciones(): Promise<void> {
  const cliente = await pool.connect();
  try {
    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/migrations');
    const migraciones = await cargarMigraciones(raiz);
    await migrar(adaptarPg(cliente), migraciones);
    console.log(`Migraciones listas: ${migraciones.length}`);
  } finally { cliente.release(); }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let texto = '';
  for await (const parte of request) {
    texto += parte;
    if (texto.length > 1_000_000) throw new Error('La solicitud excede el tamaño permitido.');
  }
  return texto === '' ? null : JSON.parse(texto);
}

function responder(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function codigoValido(recibido: unknown): boolean {
  if (!pairingCode || typeof recibido !== 'string') return false;
  const esperado = Buffer.from(sha256(pairingCode), 'hex');
  const actual = Buffer.from(sha256(recibido), 'hex');
  return timingSafeEqual(esperado, actual);
}

async function dispositivoAutenticado(request: IncomingMessage): Promise<string | null> {
  const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/)?.[1];
  if (!token) return null;
  const resultado = await pool.query<{ device_id: string }>(
    'SELECT device_id FROM device_sync_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(token)],
  );
  return resultado.rows[0]?.device_id ?? null;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return responder(response, 204, null);
    if (request.method === 'GET' && request.url === '/health') {
      return responder(response, 200, { ok: true, service: 'papeleria-api' });
    }

    if (request.method === 'POST' && request.url === '/sync/pair') {
      const body = await jsonBody(request);
      if (!esObjeto(body) || typeof body.device_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.device_id) ||
          !codigoValido(body.pairing_code)) {
        return responder(response, 401, { error: 'Código de emparejamiento inválido.' });
      }
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO device_sync_tokens (device_id, token_hash)
         VALUES ($1, $2)
         ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
           created_at = now(), revoked_at = NULL`,
        [body.device_id, sha256(token)],
      );
      return responder(response, 200, { token, device_id: body.device_id });
    }

    if (request.method === 'POST' && request.url === '/sync/push') {
      const deviceId = await dispositivoAutenticado(request);
      if (!deviceId) return responder(response, 401, { error: 'Dispositivo no emparejado.' });
      const body = await jsonBody(request);
      if (!esObjeto(body) || !Array.isArray(body.events) || body.events.length > 200) {
        return responder(response, 400, { error: 'Lote de eventos inválido (máximo 200).'});
      }
      const events = body.events as Evento[];
      if (events.some((event) => !esObjeto(event) || typeof event.event_id !== 'string' ||
        event.device_id !== deviceId || !Number.isSafeInteger(event.device_seq) ||
        event.device_seq < 1 || typeof event.type !== 'string' ||
        !TIPOS_EVENTO.has(event.type) || !esObjeto(event.payload))) {
        return responder(response, 400, { error: 'El lote contiene un evento inválido.' });
      }
      const client = await pool.connect();
      try {
        // El registro de transporte y la proyección central tienen que entrar juntos.
        // Si una venta queda en server_events pero no llega a sales, un equipo nuevo
        // vería otra realidad que Supabase. Sólo se proyecta el INSERT que realmente
        // ganó la idempotencia; un reintento no duplica ni stock ni ventas.
        await adaptarPg(client).transaction(async (tx) => {
          for (const event of events) {
            const insertado = await tx.query<{ event_id: string }>(
              `INSERT INTO server_events (event_id, device_id, device_seq, payload)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (event_id) DO NOTHING
               RETURNING event_id`,
              [event.event_id, deviceId, event.device_seq, JSON.stringify(event)],
            );
            if (insertado.rows.length > 0) await aplicarEventoRemoto(tx, event);
          }
        });
      }
      finally { client.release(); }
      return responder(response, 202, { accepted: events.map((event) => event.event_id) });
    }

    if (request.method === 'GET' && request.url?.startsWith('/sync/pull')) {
      const deviceId = await dispositivoAutenticado(request);
      if (!deviceId) return responder(response, 401, { error: 'Dispositivo no emparejado.' });
      const url = new URL(request.url, 'http://localhost');
      const since = Number(url.searchParams.get('since') ?? '0');
      const limiteSolicitado = Number(url.searchParams.get('limit') ?? '200');
      if (!Number.isSafeInteger(since) || since < 0) return responder(response, 400, { error: 'Cursor inválido.' });
      if (!Number.isSafeInteger(limiteSolicitado) || limiteSolicitado < 1) return responder(response, 400, { error: 'Límite inválido.' });
      const limit = Math.min(limiteSolicitado, 500);
      const result = await pool.query<{ server_seq: string; device_id: string; payload: unknown }>(
        `SELECT server_seq, device_id, payload FROM server_events
          WHERE server_seq > $1 ORDER BY server_seq LIMIT $2`, [since, limit],
      );
      const events = result.rows.map((row) => ({
        server_seq: Number(row.server_seq), device_id: row.device_id, payload: row.payload,
      }));
      return responder(response, 200, {
        events,
        next_cursor: events.at(-1)?.server_seq ?? since,
        has_more: events.length === limit,
      });
    }

    responder(response, 404, { error: 'Ruta no encontrada.' });
  } catch (error) {
    console.error('Error de API:', error);
    responder(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

void aplicarMigraciones()
  .then(() => server.listen(port, '0.0.0.0', () => console.log(`Papeleria API escuchando en ${port}`)))
  .catch((error) => { console.error('No se pudieron aplicar las migraciones.', error); process.exitCode = 1; });
