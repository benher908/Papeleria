/**
 * La ventana de autorización para acciones sensibles.
 *
 * F6 pedirá un PIN de seis dígitos. Mientras tanto, la cuenta ya tiene una
 * contraseña argon2id y volver a pedirla es una re-autenticación de verdad:
 * `concederStepUp()` la verifica y escribe un `step_up_grants` de cinco minutos,
 * acotado al permiso que disparó la acción.
 *
 * La pantalla no decide si la operación se permite. Sólo consigue la
 * autorización y vuelve a intentar la acción original; la política se evalúa de
 * nuevo, dentro de la transacción, como siempre.
 */

import { useEffect, useRef, useState } from 'react';

import { concederStepUp } from '@papeleria/db';

import type { SesionIniciada } from '../auth/pantalla';
import type { BaseLocal } from '../db/baseLocal';
import { comoClienteTransaccional } from '../db/cliente';
import { Aviso, Boton, Entrada, Tarjeta } from './ui';

export interface PropsStepUp {
  readonly base: BaseLocal;
  readonly sesion: SesionIniciada;
  /** El permiso que se autoriza: `'ventas:cancelar'`, `'turnos:retiros'`… */
  readonly permiso: string;
  /** Texto para la persona: «Cancelar el ticket C1-000002». */
  readonly descripcion: string;
  readonly entidadId?: string;
  /** Se llama sólo si la autorización se guardó. Debe reintentar la acción. */
  readonly onAutorizado: () => void | Promise<void>;
  readonly onCancelar: () => void;
}

export function DialogoStepUp({
  base,
  sesion,
  permiso,
  descripcion,
  entidadId,
  onAutorizado,
  onCancelar,
}: PropsStepUp) {
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autorizando, setAutorizando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const temporizador = window.setTimeout(() => campo.current?.focus(), 50);
    return () => window.clearTimeout(temporizador);
  }, []);

  async function autorizar(): Promise<void> {
    if (autorizando || contrasena === '') return;

    setAutorizando(true);
    setError(null);
    try {
      await concederStepUp(comoClienteTransaccional(base), {
        usuarioId: sesion.usuario.id,
        sesionId: sesion.sesionId,
        contrasena,
        motivo: permiso,
        ...(entidadId === undefined ? {} : { entidadId }),
      });
      await base.sincronizar();
      setContrasena('');
      await onAutorizado();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setAutorizando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4">
      <Tarjeta className="mt-16 w-full max-w-md p-5">
        <h2 className="text-lg font-semibold">Autorización del dueño</h2>
        <p className="mt-1 text-sm text-[var(--suave)]">{descripcion}</p>
        <p className="mt-2 text-xs text-[var(--suave)]">
          Escribe la contraseña de la cuenta. La autorización vale cinco minutos para esta
          acción.
        </p>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(evento) => {
            evento.preventDefault();
            void autorizar();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--suave)]">
            Contraseña
            <Entrada
              ref={campo}
              type="password"
              value={contrasena}
              onChange={(evento) => setContrasena(evento.target.value)}
              autoComplete="current-password"
              disabled={autorizando}
            />
          </label>

          {error === null ? null : <Aviso tono="mal">{error}</Aviso>}

          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <Boton type="submit" className="flex-1" disabled={autorizando || contrasena === ''}>
              {autorizando ? 'Autorizando…' : 'Autorizar y continuar'}
            </Boton>
            <Boton
              variante="secundario"
              className="flex-1"
              onClick={onCancelar}
              disabled={autorizando}
            >
              Cancelar
            </Boton>
          </div>
        </form>
      </Tarjeta>
    </div>
  );
}
