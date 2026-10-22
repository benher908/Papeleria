import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import type { ColaEscaneo } from './cola';
import { Boton, Aviso } from '../componentes/ui';

export function CamaraEscaner({ cola }: { readonly cola: ColaEscaneo }) {
  const video = useRef<HTMLVideoElement>(null);
  const controles = useRef<IScannerControls | null>(null);
  const [abierta, setAbierta] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controles.current?.stop(), []);

  async function alternar(): Promise<void> {
    if (abierta) { controles.current?.stop(); controles.current = null; setAbierta(false); return; }
    setError(null);
    try {
      const lector = new BrowserMultiFormatReader();
      const dispositivos = await BrowserMultiFormatReader.listVideoInputDevices();
      const preferida = dispositivos.find((d) => /back|trasera|environment/i.test(d.label)) ?? dispositivos[0];
      if (!preferida || !video.current) throw new Error('No se encontró una cámara disponible.');
      controles.current = await lector.decodeFromVideoDevice(preferida.deviceId, video.current, (resultado) => {
        const codigo = resultado?.getText().trim();
        if (!codigo) return;
        cola.emitir({ codigo, origen: 'celular', leido_at: new Date().toISOString(), symbology: resultado!.getBarcodeFormat().toString() });
      });
      setAbierta(true);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : 'No se pudo abrir la cámara.');
    }
  }

  return <div className="mt-3 flex flex-col gap-2">
    <Boton variante="secundario" type="button" onClick={() => void alternar()}>
      {abierta ? 'Cerrar cámara' : 'Escanear con cámara'}
    </Boton>
    {abierta && <video ref={video} className="aspect-video w-full rounded-lg bg-black object-cover" muted playsInline />}
    {abierta && <p className="text-xs text-[var(--suave)]">Apunta al código de barras. Se agregará al carrito automáticamente.</p>}
    {error && <Aviso tono="mal">{error} Usa HTTPS y permite el acceso a la cámara.</Aviso>}
  </div>;
}
