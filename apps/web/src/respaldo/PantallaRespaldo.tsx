/**
 * Respaldo y restauración de la base local.
 *
 * No hay servidor y no hay copia automática: este botón es la única forma de
 * sacar la papelería del navegador. El volcado es el directorio de datos completo
 * de PGlite (esquema, migraciones, ventas, usuarios y hashes), no un CSV.
 *
 * Restaurar reemplaza TODO. Por eso se pide confirmación explícita y se toma un
 * volcado de seguridad antes de tocar IndexedDB; si el archivo elegido no sirve,
 * la base anterior vuelve a abrirse.
 */

import { useRef, useState } from 'react';

import { Aviso, Boton, Tarjeta } from '../componentes/ui';
import { restaurarBaseLocal, type BaseLocal } from '../db/baseLocal';

const CLAVE_ULTIMO = 'papeleria.ultimoRespaldo';

export interface PropsRespaldo {
  readonly base: BaseLocal;
}

export function PantallaRespaldo({ base }: PropsRespaldo) {
  const [descargando, setDescargando] = useState(false);
  const [errorDescarga, setErrorDescarga] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState<string | null>(() => leerUltimo());

  const [archivo, setArchivo] = useState<File | null>(null);
  const [confirmado, setConfirmado] = useState(false);
  const [restaurando, setRestaurando] = useState(false);
  const [errorRestaurar, setErrorRestaurar] = useState<string | null>(null);
  const selector = useRef<HTMLInputElement>(null);

  async function descargar(): Promise<void> {
    setDescargando(true);
    setErrorDescarga(null);
    try {
      // El volcado se toma con la base abierta y sincronizada: así incluye la
      // última venta y no una versión de hace dos transacciones.
      await base.sincronizar();
      const volcado = await base.respaldar();
      const nombre = `papeleria-${fechaParaArchivo(new Date())}.tgz`;
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(volcado);
      enlace.download = nombre;
      enlace.rel = 'noopener';
      document.body.append(enlace);
      enlace.click();
      enlace.remove();
      window.setTimeout(() => URL.revokeObjectURL(enlace.href), 30_000);

      const ahora = new Date().toISOString();
      localStorage.setItem(CLAVE_ULTIMO, ahora);
      setUltimo(ahora);
    } catch (causa) {
      setErrorDescarga(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setDescargando(false);
    }
  }

  async function restaurar(): Promise<void> {
    if (archivo === null || !confirmado || restaurando) return;

    setRestaurando(true);
    setErrorRestaurar(null);
    try {
      await restaurarBaseLocal(archivo);
      // Los componentes montados siguen apuntando a la conexión anterior. La
      // recarga es parte de la restauración, no un extra.
      window.location.reload();
    } catch (causa) {
      setErrorRestaurar(causa instanceof Error ? causa.message : String(causa));
      setRestaurando(false);
      // La base anterior se volvió a abrir, pero esta pestaña ya tenía objetos
      // apuntando a la conexión cerrada. Recargar deja todo coherente.
      window.setTimeout(() => window.location.reload(), 8_000);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta className="p-5">
        <h2 className="text-lg font-semibold">Respaldo</h2>
        <p className="mt-1 text-sm text-[var(--suave)]">
          Todo vive en este navegador. Descarga una copia con frecuencia y guárdala fuera del
          equipo: si alguien borra los datos del sitio, sin este archivo no hay forma de
          recuperar las ventas.
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Boton onClick={() => void descargar()} disabled={descargando}>
            {descargando ? 'Preparando el volcado…' : 'Descargar respaldo ahora'}
          </Boton>
          <span className="text-xs text-[var(--suave)]">
            {ultimo === null
              ? 'Todavía no se ha descargado ningún respaldo.'
              : `Último respaldo: ${new Date(ultimo).toLocaleString('es-MX')}`}
          </span>
        </div>

        {errorDescarga === null ? null : (
          <Aviso tono="mal" className="mt-3">
            {errorDescarga}
          </Aviso>
        )}

        <div className="mt-4 rounded-md border border-[var(--linea)] bg-[var(--fondo)] p-3 text-xs text-[var(--suave)]">
          El archivo contiene la base completa, incluida la contraseña hasheada de la cuenta.
          No lo compartas. Para restaurarlo necesitas esta misma pantalla y la contraseña de la
          cuenta, porque después de restaurar se cierra la sesión.
        </div>
      </Tarjeta>

      <Tarjeta className="p-5">
        <h2 className="text-lg font-semibold">Restaurar un respaldo</h2>
        <p className="mt-1 text-sm text-[var(--suave)]">
          Reemplaza los productos, las ventas, los turnos y la cuenta por los del archivo. Antes
          de tocar nada se guarda un volcado de la base actual; si el archivo no es válido, se
          vuelve a abrir la que ya tenías.
        </p>

        <input
          ref={selector}
          type="file"
          accept=".tgz,.tar.gz,.tar,application/gzip,application/x-gzip"
          className="mt-4 block w-full text-sm text-[var(--suave)] file:mr-3 file:rounded-md file:border file:border-[var(--linea)] file:bg-[var(--tarjeta)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--texto)]"
          onChange={(evento) => {
            setArchivo(evento.target.files?.[0] ?? null);
            setConfirmado(false);
            setErrorRestaurar(null);
          }}
          disabled={restaurando}
        />

        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmado}
            onChange={(evento) => setConfirmado(evento.target.checked)}
            disabled={archivo === null || restaurando}
            className="mt-1"
          />
          <span>
            Entiendo que esto reemplaza <strong>todo</strong> lo que hay hoy en este navegador.
          </span>
        </label>

        {errorRestaurar === null ? null : (
          <Aviso tono="mal" className="mt-3">
            {errorRestaurar} La página se recargará en unos segundos para dejar la base anterior
            en uso.
          </Aviso>
        )}

        <Boton
          variante="peligro"
          className="mt-4"
          onClick={() => void restaurar()}
          disabled={archivo === null || !confirmado || restaurando}
        >
          {restaurando ? 'Restaurando…' : 'Restaurar y reemplazar todo'}
        </Boton>
      </Tarjeta>
    </div>
  );
}

function leerUltimo(): string | null {
  try {
    return localStorage.getItem(CLAVE_ULTIMO);
  } catch {
    return null;
  }
}

function fechaParaArchivo(fecha: Date): string {
  const dos = (n: number): string => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}-${dos(
    fecha.getHours(),
  )}${dos(fecha.getMinutes())}`;
}
