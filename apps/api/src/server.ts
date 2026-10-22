import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cargarMigraciones } from '@papeleria/db/node';
import { adaptarPg, aplicarEventoRemoto, migrar } from '@papeleria/db';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Falta DATABASE_URL.');
const pairingCode = process.env.SYNC_PAIRING_CODE;
const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) throw new Error('Falta SUPABASE_URL.');
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'https://papeleria-plw6.onrender.com';
const supabaseKeys = createRemoteJWKSet(new URL(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`));
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

function responder(response: ServerResponse, status: number, body: unknown, origin = allowedOrigin): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, authorization, x-supabase-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

const intentos = new Map<string, { cuenta: number; hasta: number }>();
function limitado(request: IncomingMessage): boolean {
  const ip = request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown';
  const ahora = Date.now();
  const previo = intentos.get(ip);
  if (!previo || ahora >= previo.hasta) { intentos.set(ip, { cuenta: 1, hasta: ahora + 60_000 }); return false; }
  previo.cuenta += 1;
  return previo.cuenta > 360;
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

async function dispositivoAutenticadoDeUsuario(request: IncomingMessage, userId: string): Promise<string | null> {
  const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/)?.[1];
  if (!token) return null;
  const resultado = await pool.query<{ device_id: string }>(
    'SELECT device_id FROM device_sync_tokens WHERE token_hash = $1 AND owner_user_id = $2 AND revoked_at IS NULL',
    [sha256(token), userId],
  );
  return resultado.rows[0]?.device_id ?? null;
}

async function usuarioAutenticado(request: IncomingMessage): Promise<string | null> {
  const header = request.headers['x-supabase-token'];
  const token = (typeof header === 'string' ? header : undefined) ?? request.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, supabaseKeys, { issuer: `${supabaseUrl!.replace(/\/$/, '')}/auth/v1`, audience: 'authenticated' });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch { return null; }
}

const server = createServer(async (request, response) => {
  try {
    if (limitado(request)) return responder(response, 429, { error: 'Demasiadas solicitudes; espera un minuto.' });
    if (request.method === 'OPTIONS') return responder(response, 204, null);
    if (request.method === 'GET' && request.url === '/health') {
      return responder(response, 200, { ok: true, service: 'papeleria-api' });
    }

    if (request.method === 'POST' && request.url === '/sync/pair') {
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const body = await jsonBody(request);
      if (!esObjeto(body) || typeof body.device_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.device_id) ||
          !codigoValido(body.pairing_code)) {
        return responder(response, 401, { error: 'Código de emparejamiento inválido.' });
      }
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO device_sync_tokens (device_id, token_hash, owner_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
           owner_user_id = EXCLUDED.owner_user_id, created_at = now(), revoked_at = NULL`,
        [body.device_id, sha256(token), userId],
      );
      return responder(response, 200, { token, device_id: body.device_id });
    }

    if (request.method === 'POST' && request.url === '/scanner/session') {
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const body = await jsonBody(request);
      if (!esObjeto(body) || typeof body.device_id !== 'string') return responder(response, 400, { error: 'Dispositivo inválido.' });
      const deviceId = await dispositivoAutenticadoDeUsuario(request, userId);
      if (deviceId !== body.device_id) return responder(response, 401, { error: 'La caja no está vinculada a esta cuenta.' });
      const code = randomBytes(5).toString('hex').toUpperCase();
      await pool.query(
        `INSERT INTO remote_scanner_sessions (code,owner_user_id,device_id,expires_at)
         VALUES ($1,$2,$3,now() + interval '8 hours')`, [code, userId, deviceId],
      );
      return responder(response, 201, { code, expires_in_minutes: 480 });
    }

    if (request.method === 'POST' && request.url === '/scanner/scan') {
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const body = await jsonBody(request);
      if (!esObjeto(body) || typeof body.code !== 'string' || typeof body.barcode !== 'string' || body.barcode.trim().length === 0 || body.barcode.length > 200) {
        return responder(response, 400, { error: 'Lectura inválida.' });
      }
      const session = await pool.query<{ code: string }>(
        `SELECT code FROM remote_scanner_sessions
          WHERE code=$1 AND owner_user_id=$2 AND closed_at IS NULL AND expires_at > now()`, [body.code, userId],
      );
      if (!session.rows[0]) return responder(response, 404, { error: 'La sesión de escáner ya no está disponible.' });
      await pool.query(
        'INSERT INTO remote_scanner_events (session_code,barcode,symbology) VALUES ($1,$2,$3)',
        [body.code, body.barcode.trim(), typeof body.symbology === 'string' ? body.symbology.slice(0, 60) : null],
      );
      return responder(response, 202, { ok: true });
    }

    if (request.method === 'GET' && request.url?.startsWith('/scanner/pull')) {
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const url = new URL(request.url, 'http://localhost');
      const code = url.searchParams.get('code'); const requestedDevice = url.searchParams.get('device_id');
      const deviceId = await dispositivoAutenticadoDeUsuario(request, userId);
      if (!code || !deviceId || deviceId !== requestedDevice) return responder(response, 401, { error: 'Caja no autorizada.' });
      const session = await pool.query<{ code: string }>(
        `SELECT code FROM remote_scanner_sessions WHERE code=$1 AND owner_user_id=$2 AND device_id=$3 AND closed_at IS NULL AND expires_at > now()`,
        [code, userId, deviceId],
      );
      if (!session.rows[0]) return responder(response, 404, { error: 'La sesión de escáner ya no está disponible.' });
      const events = await pool.query<{ id: string; barcode: string }>('SELECT id,barcode FROM remote_scanner_events WHERE session_code=$1 ORDER BY id LIMIT 40', [code]);
      if (events.rows.length) await pool.query('DELETE FROM remote_scanner_events WHERE id = ANY($1)', [events.rows.map((r) => r.id)]);
      return responder(response, 200, { barcodes: events.rows.map((r) => r.barcode) });
    }

    if (request.method === 'POST' && request.url === '/sync/push') {
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const deviceId = await dispositivoAutenticadoDeUsuario(request, userId);
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
      const userId = await usuarioAutenticado(request);
      if (!userId) return responder(response, 401, { error: 'Sesión de Supabase inválida.' });
      const deviceId = await dispositivoAutenticadoDeUsuario(request, userId);
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
