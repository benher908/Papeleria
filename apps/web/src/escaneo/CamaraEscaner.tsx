import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import type { ColaEscaneo } from './cola';
import { Boton, Aviso } from '../componentes/ui';

export function CamaraEscaner({ cola, alCodigo }: { readonly cola?: ColaEscaneo; readonly alCodigo?: (codigo: string, symbology?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const controles = useRef<IScannerControls | null>(null);
  const [abierta, setAbierta] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controles.current?.stop(), []);

  async function alternar(): Promise<void> {
    if (abierta) { controles.current?.stop(); controles.current = null; setAbierta(false); return; }
    setError(null);
    setAbierta(true);
    try {
      // Da a React un ciclo de render para montar el <video> antes de usarlo.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const lector = new BrowserMultiFormatReader();
      if (!video.current) throw new Error('No se pudo preparar la vista de cámara.');
      // En Android algunos navegadores no enumeran cámaras hasta que se solicita
      // getUserMedia. Pedir la trasera directamente hace aparecer el permiso.
      controles.current = await lector.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video.current, (resultado) => {
        const codigo = resultado?.getText().trim();
        if (!codigo) return;
        const symbology = resultado!.getBarcodeFormat().toString();
        if (alCodigo) alCodigo(codigo, symbology);
        else cola?.emitir({ codigo, origen: 'celular', leido_at: new Date().toISOString(), symbology });
      });
      setAbierta(true);
    } catch (causa) {
      setAbierta(false);
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
