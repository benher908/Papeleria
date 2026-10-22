import { useState } from 'react';
import { Aviso, Boton, Entrada, Tarjeta } from '../componentes/ui';
import { CamaraEscaner } from './CamaraEscaner';
import { enviarLecturaRemota } from './remoto';

export function PantallaEscanerMovil() {
  const [code, setCode] = useState(''); const [mensaje, setMensaje] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  async function enviar(barcode: string, symbology?: string): Promise<void> {
    if (!code.trim()) { setMensaje('Escribe el código que muestra la PC antes de escanear.'); return; }
    if (enviando) return;
    setEnviando(true);
    try { await enviarLecturaRemota(code.trim().toUpperCase(), barcode, symbology); setMensaje(`Enviado: ${barcode}`); }
    catch (e) { setMensaje(e instanceof Error ? e.message : 'No se pudo enviar la lectura.'); }
    finally { setEnviando(false); }
  }
  return <div className="mx-auto max-w-md px-5 py-6"><Tarjeta className="p-5"><h1 className="text-xl font-semibold">Escáner móvil</h1><p className="mt-1 text-sm text-[var(--suave)]">Este celular sólo escanea. La venta y el cobro se realizan en la PC.</p><label className="mt-4 block text-sm font-medium">Código que muestra la PC<Entrada value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Ej. A1B2C3D4E5" className="mt-1 font-mono tracking-widest" /></label><CamaraEscaner alCodigo={(barcode, symbology) => void enviar(barcode, symbology)} />{enviando && <p className="text-sm text-[var(--suave)]">Enviando lectura…</p>}{mensaje && <Aviso tono={mensaje.startsWith('Enviado') ? 'ok' : 'mal'} className="mt-3">{mensaje}</Aviso>}<Boton variante="secundario" className="mt-4 w-full" onClick={() => setMensaje(null)}>Limpiar mensaje</Boton></Tarjeta></div>;
}
