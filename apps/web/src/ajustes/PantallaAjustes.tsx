/**
 * Ajustes del negocio (nombre, RFC, dirección, teléfono).
 *
 * La tabla `settings` guarda los valores como jsonb. Para texto se guarda con
 * comillas (como lo hicieron las migraciones): `"Mi Papelería"`. Aquí se
 * maneja eso transparentemente para el dueño.
 *
 * Los cambios van directamente a la tabla — settings no tiene emitirEvento
 * porque no es un evento de negocio, es configuración del sistema, igual
 * que las unidades y las categorías en las semillas.
 */

import { useEffect, useState } from 'react';

import { Aviso, Boton, Campo, Entrada, Tarjeta } from '../componentes/ui';
import type { BaseLocal } from '../db/baseLocal';

export interface PropsAjustes {
  readonly base: BaseLocal;
}

interface Ajustes {
  nombre_negocio: string;
  rfc: string;
  direccion: string;
  telefono: string;
}

const CLAVES: ReadonlyArray<keyof Ajustes> = ['nombre_negocio', 'rfc', 'direccion', 'telefono'];

const ETIQUETAS: Record<keyof Ajustes, string> = {
  nombre_negocio: 'Nombre del negocio',
  rfc: 'RFC',
  direccion: 'Dirección',
  telefono: 'Teléfono',
};

const PLACEHOLDERS: Record<keyof Ajustes, string> = {
  nombre_negocio: 'Mi Papelería',
  rfc: 'XAXX010101000',
  direccion: 'Calle, número, colonia, ciudad',
  telefono: '55 1234 5678',
};

function leerValor(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  const s = String(valor);
  // La semilla guarda texto como '"Mi Papelería"' (jsonb con comillas)
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

export function PantallaAjustes({ base }: PropsAjustes) {
  const [valores, setValores] = useState<Ajustes>({ nombre_negocio: '', rfc: '', direccion: '', telefono: '' });
  const [guardando, setGuardando] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const filas = await base.consultar<{ clave: string; valor: unknown }>(
          `SELECT clave, valor #>> '{}' AS valor FROM settings WHERE clave = ANY($1)`,
          [CLAVES],
        );
        const mapa: Partial<Ajustes> = {};
        for (const fila of filas) {
          const clave = fila.clave as keyof Ajustes;
          if (CLAVES.includes(clave)) {
            mapa[clave] = leerValor(fila.valor);
          }
        }
        setValores({
          nombre_negocio: mapa.nombre_negocio ?? '',
          rfc: mapa.rfc ?? '',
          direccion: mapa.direccion ?? '',
          telefono: mapa.telefono ?? '',
        });
      } catch (causa) {
        setError(causa instanceof Error ? causa.message : String(causa));
      } finally {
        setCargando(false);
      }
    })();
  }, [base]);

  async function guardar(): Promise<void> {
    setGuardando(true);
    setError(null);
    setExito(null);
    try {
      // Una sola sentencia: si una clave falla, no queda media configuración
      // guardada mientras las otras tres siguen con el valor viejo.
      const parametros: unknown[] = [];
      for (const clave of CLAVES) {
        parametros.push(clave, JSON.stringify(valores[clave].trim()));
      }
      await base.ejecutar(
        `INSERT INTO settings (clave, valor) VALUES
           ($1, $2::jsonb), ($3, $4::jsonb), ($5, $6::jsonb), ($7, $8::jsonb)
         ON CONFLICT (clave) DO UPDATE
           SET valor = EXCLUDED.valor, actualizado_at = now()`,
        parametros,
      );
      await base.sincronizar();
      // El POS se queda montado en otra pestaña de la app; este aviso hace que
      // recargue el encabezado sin obligar a reiniciar el navegador.
      window.dispatchEvent(new Event('papeleria:ajustes'));
      setExito('Ajustes guardados.');
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setGuardando(false);
    }
  }

  if (cargando) {
    return <p className="text-sm text-[var(--suave)]">Cargando ajustes…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta className="p-5">
        <h2 className="text-lg font-semibold">Datos del negocio</h2>
        <p className="mt-1 text-sm text-[var(--suave)]">
          Aparecen en el ticket de venta y en el corte de caja.
        </p>

        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => { e.preventDefault(); void guardar(); }}
        >
          {CLAVES.map((clave) => (
            <Campo key={clave} etiqueta={ETIQUETAS[clave]} para={clave}>
              <Entrada
                id={clave}
                value={valores[clave]}
                onChange={(e) => setValores((prev) => ({ ...prev, [clave]: e.target.value }))}
                placeholder={PLACEHOLDERS[clave]}
                autoComplete="off"
                disabled={guardando}
              />
            </Campo>
          ))}

          {error && <Aviso tono="mal">{error}</Aviso>}
          {exito && <Aviso tono="ok">{exito}</Aviso>}

          <div>
            <Boton type="submit" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar ajustes'}
            </Boton>
          </div>
        </form>
      </Tarjeta>

      <Tarjeta className="p-5">
        <h2 className="text-base font-semibold">Vista previa del encabezado del ticket</h2>
        <div className="mt-3 rounded-md border border-[var(--linea)] bg-white p-4 font-mono text-xs text-black">
          <p className="text-center font-bold">{valores.nombre_negocio || 'Mi Papelería'}</p>
          {valores.rfc && <p className="text-center">RFC: {valores.rfc}</p>}
          {valores.direccion && <p className="text-center">{valores.direccion}</p>}
          {valores.telefono && <p className="text-center">Tel: {valores.telefono}</p>}
          <p className="mt-2 text-center">────────────────</p>
        </div>
      </Tarjeta>
    </div>
  );
}
