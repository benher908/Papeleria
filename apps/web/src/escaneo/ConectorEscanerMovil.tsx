import { useEffect, useState } from 'react';
import type { ColaEscaneo } from './cola';
import { abrirSesionEscaner, recibirLecturasRemotas } from './remoto';
import { Boton } from '../componentes/ui';

const TOKEN_KEY = 'papeleria.sync.token';
export function ConectorEscanerMovil({ cola, deviceId }: { readonly cola: ColaEscaneo; readonly deviceId: string }) {
  const [code, setCode] = useState<string | null>(null); const [mensaje, setMensaje] = useState<string | null>(null);
  useEffect(() => {
    if (!code) return;
    const token = localStorage.getItem(TOKEN_KEY); if (!token) return;
    const timer = window.setInterval(() => void recibirLecturasRemotas(code, deviceId, token).then((barcodes) => {
      for (const barcode of barcodes) cola.emitir({ codigo: barcode, origen: 'celular', leido_at: new Date().toISOString() });
      if (barcodes.length) setMensaje(`${barcodes.length} lectura${barcodes.length === 1 ? '' : 's'} recibida${barcodes.length === 1 ? '' : 's'}`);
    }).catch((e) => setMensaje(e instanceof Error ? e.message : 'No se pudo recibir la lectura.')), 800);
    return () => window.clearInterval(timer);
  }, [code, cola, deviceId]);
  async function conectar(): Promise<void> {
    const token = localStorage.getItem(TOKEN_KEY); if (!token) { setMensaje('Vincula esta PC con el código de Render antes de conectar el celular.'); return; }
    try { setCode(await abrirSesionEscaner(deviceId, token)); setMensaje('Comparte este código con el celular.'); }
    catch (e) { setMensaje(e instanceof Error ? e.message : 'No se pudo abrir el escáner móvil.'); }
  }
  return <div className="mt-3 rounded-lg border border-[var(--linea)] bg-[var(--fondo)] p-3"><Boton variante="secundario" className="w-full" onClick={() => void conectar()}>{code ? 'Generar nuevo código' : 'Conectar escáner móvil'}</Boton>{code && <p className="mt-2 text-center"><span className="text-xs text-[var(--suave)]">Código para el celular</span><strong className="block font-mono text-2xl tracking-[0.2em]">{code}</strong></p>}{mensaje && <p className="mt-2 text-xs text-[var(--suave)]">{mensaje}</p>}</div>;
}
