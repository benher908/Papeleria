/**
 * Los cuatro o cinco componentes que toda pantalla necesita.
 *
 * Es el estilo de shadcn/ui —clases de Tailwind, sin librería de componentes— pero
 * escrito a mano en vez de generado por el CLI. Se hace así por dos razones:
 *
 *  1. shadcn genera un archivo por componente y arrastra Radix para los que tienen
 *     comportamiento (diálogos, menús). Hoy no hay ninguno de ésos: son cajas, botones
 *     y campos. Cuando llegue el primer diálogo de verdad se instala Radix y se copia
 *     el componente del catálogo, sin reescribir nada de esto.
 *  2. Los colores salen de las variables de `estilos.css`, no de la paleta de Tailwind.
 *     Así el modo claro/oscuro sigue siendo el de toda la app y no hay dos temas.
 */

import { forwardRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export function cx(...partes: Array<string | false | null | undefined>): string {
  return partes.filter(Boolean).join(' ');
}

type Variante = 'primario' | 'secundario' | 'peligro';

const VARIANTES: Record<Variante, string> = {
  primario: 'border-[var(--acento)] bg-[var(--acento)] text-white hover:opacity-90',
  secundario:
    'border-[var(--linea)] bg-[var(--tarjeta)] text-[var(--texto)] hover:border-[var(--suave)]',
  peligro: 'border-[var(--mal)] bg-[var(--mal)] text-white hover:opacity-90',
};

export interface PropsBoton extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variante?: Variante;
}

export function Boton({ variante = 'primario', className, type = 'button', ...resto }: PropsBoton) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTES[variante],
        className,
      )}
      {...resto}
    />
  );
}

export const Entrada = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Entrada({ className, ...resto }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'w-full rounded-md border border-[var(--linea)] bg-[var(--fondo)] px-2.5 py-2 text-sm',
          'text-[var(--texto)] outline-none placeholder:text-[var(--suave)]',
          'focus:border-[var(--acento)] focus:ring-2 focus:ring-[var(--acento)]',
          className,
        )}
        {...resto}
      />
    );
  },
);

export function Seleccion({ className, ...resto }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'w-full rounded-md border border-[var(--linea)] bg-[var(--fondo)] px-2.5 py-2 text-sm',
        'text-[var(--texto)] outline-none',
        'focus:border-[var(--acento)] focus:ring-2 focus:ring-[var(--acento)]',
        className,
      )}
      {...resto}
    />
  );
}

export interface PropsCampo {
  readonly etiqueta: string;
  /** `id` del control, para que la etiqueta lo enfoque al hacer clic. */
  readonly para?: string;
  readonly ayuda?: ReactNode;
  readonly error?: string | null;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Campo({ etiqueta, para, ayuda, error, className, children }: PropsCampo) {
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={para} className="text-xs font-medium text-[var(--suave)]">
        {etiqueta}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-[var(--mal)]">{error}</p>
      ) : ayuda ? (
        <p className="text-xs text-[var(--suave)]">{ayuda}</p>
      ) : null}
    </div>
  );
}

export interface PropsTarjeta {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Tarjeta({ children, className }: PropsTarjeta) {
  return (
    <div
      className={cx(
        'rounded-xl border border-[var(--linea)] bg-[var(--tarjeta)] shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

type Tono = 'ok' | 'mal' | 'aviso' | 'info';

const TONOS: Record<Tono, string> = {
  ok: 'border-[var(--ok)] bg-[var(--ok-fondo)] text-[var(--ok)]',
  mal: 'border-[var(--mal)] bg-[var(--mal-fondo)] text-[var(--mal)]',
  aviso: 'border-[var(--aviso)] bg-[var(--aviso-fondo)] text-[var(--aviso)]',
  info: 'border-[var(--linea)] bg-[var(--fondo)] text-[var(--suave)]',
};

export function Aviso({
  tono = 'info',
  children,
  className,
}: {
  readonly tono?: Tono;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role={tono === 'mal' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm', TONOS[tono], className)}
    >
      {children}
    </div>
  );
}
