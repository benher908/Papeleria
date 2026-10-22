import { tokenSupabase } from '../auth/supabase';
import { API_SYNC } from '../sync/cliente';

async function encabezados(): Promise<HeadersInit> {
  const jwt = await tokenSupabase();
  if (!jwt) throw new Error('Tu sesión venció. Vuelve a entrar.');
  return { 'content-type': 'application/json', 'x-supabase-token': jwt };
}

async function respuesta(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'No se pudo conectar el escáner.');
  return body;
}

export async function abrirSesionEscaner(deviceId: string, tokenDispositivo: string): Promise<string> {
  const response = await fetch(`${API_SYNC}/scanner/session`, {
    method: 'POST', headers: { ...(await encabezados()), authorization: `Bearer ${tokenDispositivo}` },
    body: JSON.stringify({ device_id: deviceId }),
  });
  const body = await respuesta(response);
  if (typeof body.code !== 'string') throw new Error('La API no devolvió el código de conexión.');
  return body.code;
}

export async function enviarLecturaRemota(code: string, barcode: string, symbology?: string): Promise<void> {
  const response = await fetch(`${API_SYNC}/scanner/scan`, {
    method: 'POST', headers: await encabezados(), body: JSON.stringify({ code, barcode, symbology }),
  });
  await respuesta(response);
}

export async function recibirLecturasRemotas(code: string, deviceId: string, tokenDispositivo: string): Promise<string[]> {
  const response = await fetch(`${API_SYNC}/scanner/pull?code=${encodeURIComponent(code)}&device_id=${encodeURIComponent(deviceId)}`, {
    headers: { ...(await encabezados()), authorization: `Bearer ${tokenDispositivo}` },
  });
  const body = await respuesta(response);
  return Array.isArray(body.barcodes) ? body.barcodes.filter((x): x is string => typeof x === 'string') : [];
}
