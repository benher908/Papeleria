import { createServer } from 'node:http';
import { Pool } from 'pg';

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Falta DATABASE_URL.');
const pool = new Pool({ connectionString: databaseUrl, max: 5, ssl: { rejectUnauthorized: false } });

async function jsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  let texto = '';
  for await (const parte of request) texto += parte;
  return texto === '' ? null : JSON.parse(texto);
}
function responder(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return responder(response, 204, null);
    if (request.method === 'GET' && request.url === '/health') return responder(response, 200, { ok: true, service: 'papeleria-api' });
    if (request.method === 'POST' && request.url === '/sync/push') {
      const body = await jsonBody(request) as { events?: Array<{ event_id?: string; device_id?: string; device_seq?: number; payload?: unknown }> } | null;
      const events = body?.events ?? [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const evento of events) {
          if (!evento.event_id || !evento.device_id || evento.device_seq === undefined) throw new Error('Evento incompleto.');
          await client.query(`INSERT INTO server_events (event_id, device_id, device_seq, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`, [evento.event_id, evento.device_id, evento.device_seq, JSON.stringify(evento.payload ?? evento)]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return responder(response, 202, { accepted: events.length });
    }
    responder(response, 404, { error: 'Ruta no encontrada.' });
  } catch (error) { responder(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Papeleria API escuchando en ${port}`));
