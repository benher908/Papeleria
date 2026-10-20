/**
 * Alta y edición de un producto.
 *
 * Es el formulario que tiene que permitir dar de alta 20 productos en 15 minutos
 * (criterio de F1.1), así que el orden de los campos es el de la mano: nombre, precio
 * y ya. Lo demás —categoría, unidad, costo— tiene valor por defecto o se puede dejar
 * vacío. El código de barras, por defecto, lo genera la app.
 *
 * El formulario **no escribe en la base**: arma los datos, valida lo que se puede
 * validar sin consultar (texto vacío, precio cero) y se los pasa a la pantalla. Los
 * errores que sólo la base conoce —código repetido, precio bajo el costo— vuelven de
 * allá y se pintan aquí sin perder nada de lo tecleado.
 */

import { useId, useMemo, useState } from 'react';

import { Boton, Campo, Entrada, Seleccion } from '../componentes/ui';
import {
  cantidadParaEditar,
  intentarCentavos,
  margenSobreVenta,
  pesos,
  pesosParaEditar,
} from './formato';

export interface OpcionCatalogo {
  readonly id: string;
  readonly nombre: string;
  readonly abreviatura?: string;
}

export interface ValoresFormulario {
  readonly nombre: string;
  readonly sku: string;
  readonly categoryId: string | null;
  readonly unitId: string;
  readonly costoMinor: bigint;
  readonly precioMinor: bigint;
  readonly stockMinimo: number;
  readonly ubicacion: string | null;
  /** Sólo en el alta: `[]` deja que la base genere el código interno. */
  readonly codigos: readonly string[];
}

export interface ProductoParaEditar {
  readonly id: string;
  readonly nombre: string;
  readonly sku: string | null;
  readonly precioMinor: string;
  readonly costoMinor: string;
  readonly categoria: string | null;
  readonly ubicacion: string | null;
  readonly unidad: string;
  /** `numeric` de la base: `'24.000'`. Se convierte con `cantidadParaEditar()`. */
  readonly stockMinimo: string;
}

export interface PropsFormulario {
  readonly categorias: readonly OpcionCatalogo[];
  readonly unidades: readonly OpcionCatalogo[];
  readonly inicial?: ProductoParaEditar | undefined;
  readonly guardando: boolean;
  readonly error: string | null;
  readonly onGuardar: (valores: ValoresFormulario) => void;
  readonly onCancelar: () => void;
}

/** ¿Cuánto texto se acepta en una cantidad con tres decimales (`12.345`)? */
function comoCantidad(texto: string): number | null {
  const limpio = texto.trim().replace(',', '.');
  if (limpio === '') return 0;
  if (!/^\d+(\.\d{1,3})?$/.test(limpio)) return null;
  return Number(limpio);
}

export function Formulario({
  categorias,
  unidades,
  inicial,
  guardando,
  error,
  onGuardar,
  onCancelar,
}: PropsFormulario) {
  const id = useId();
  const editando = inicial !== undefined;

  const [nombre, setNombre] = useState(inicial?.nombre ?? '');
  const [sku, setSku] = useState(inicial?.sku ?? '');
  const [categoria, setCategoria] = useState(
    categorias.find((opcion) => opcion.nombre === inicial?.categoria)?.id ?? '',
  );
  const [unidad, setUnidad] = useState(
    inicial === undefined
      ? (unidades.find((opcion) => opcion.nombre === 'pieza')?.id ?? unidades[0]?.id ?? '')
      : (unidades.find((opcion) => opcion.nombre === inicial.unidad)?.id ?? ''),
  );
  const [costoTexto, setCostoTexto] = useState(
    inicial === undefined ? '' : pesosParaEditar(inicial.costoMinor),
  );
  const [precioTexto, setPrecioTexto] = useState(
    inicial === undefined ? '' : pesosParaEditar(inicial.precioMinor),
  );
  const [modo, setModo] = useState<'interno' | 'manual'>('interno');
  const [codigo, setCodigo] = useState('');
  // Se arranca con el valor que ya tenía el producto. Estuvo en '0' fijo, y eso
  // significaba que editar el nombre de un producto le borraba el punto de reposición.
  const [stockTexto, setStockTexto] = useState(
    inicial === undefined ? '0' : cantidadParaEditar(inicial.stockMinimo),
  );
  const [ubicacion, setUbicacion] = useState(inicial?.ubicacion ?? '');
  const [errores, setErrores] = useState<readonly string[]>([]);

  // Vista previa del margen: se recalcula al teclear, sin esperar al guardado.
  const costo = useMemo(() => intentarCentavos(costoTexto) ?? 0n, [costoTexto]);
  const precio = useMemo(() => intentarCentavos(precioTexto), [precioTexto]);
  const margen = precio === null ? null : margenSobreVenta(precio, costo);
  const bajoCosto = precio !== null && costo > 0n && precio < costo;

  function enviar(): void {
    const problemas: string[] = [];

    if (nombre.trim() === '') problemas.push('Falta el nombre.');
    if (unidad === '') problemas.push('Falta la unidad de medida.');

    const precioFinal = precio;
    if (precioFinal === null) {
      problemas.push('El precio no se entiende. Escríbelo como 12.50.');
    } else if (precioFinal <= 0n) {
      problemas.push('El precio tiene que ser mayor que cero.');
    }

    const costoFinal = costoTexto.trim() === '' ? 0n : intentarCentavos(costoTexto);
    if (costoFinal === null) problemas.push('El costo no se entiende. Escríbelo como 8.00.');

    const stock = comoCantidad(stockTexto);
    if (stock === null) problemas.push('El stock mínimo va con hasta tres decimales (12.5).');

    if (!editando && modo === 'manual' && codigo.trim() === '') {
      problemas.push('Elegiste capturar el código a mano, pero está vacío.');
    }

    if (problemas.length > 0 || precioFinal === null || costoFinal === null || stock === null) {
      setErrores(problemas);
      return;
    }

    setErrores([]);
    onGuardar({
      nombre: nombre.trim(),
      sku: sku.trim(),
      categoryId: categoria === '' ? null : categoria,
      unitId: unidad,
      costoMinor: costoFinal,
      precioMinor: precioFinal,
      stockMinimo: stock,
      ubicacion: ubicacion.trim() === '' ? null : ubicacion.trim(),
      codigos: editando || modo === 'interno' ? [] : [codigo.trim()],
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo etiqueta="Nombre" para={`${id}-nombre`} className="sm:col-span-2">
          <Entrada
            id={`${id}-nombre`}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Cuaderno profesional 100 hojas"
            autoFocus
            autoComplete="off"
          />
        </Campo>

        <Campo
          etiqueta="Categoría"
          para={`${id}-categoria`}
          ayuda="Sirve para los reportes y las reglas de margen."
        >
          <Seleccion
            id={`${id}-categoria`}
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
          >
            <option value="">Sin categoría</option>
            {categorias.map((opcion) => (
              <option key={opcion.id} value={opcion.id}>
                {opcion.nombre}
              </option>
            ))}
          </Seleccion>
        </Campo>

        <Campo etiqueta="Unidad" para={`${id}-unidad`}>
          <Seleccion
            id={`${id}-unidad`}
            value={unidad}
            onChange={(e) => setUnidad(e.target.value)}
          >
            {unidades.map((opcion) => (
              <option key={opcion.id} value={opcion.id}>
                {opcion.nombre}
                {opcion.abreviatura === undefined ? '' : ` (${opcion.abreviatura})`}
              </option>
            ))}
          </Seleccion>
        </Campo>

        <Campo
          etiqueta="Costo"
          para={`${id}-costo`}
          ayuda="Lo que te costó. No se muestra en el ticket."
        >
          <Entrada
            id={`${id}-costo`}
            value={costoTexto}
            onChange={(e) => setCostoTexto(e.target.value)}
            inputMode="decimal"
            placeholder="8.00"
            autoComplete="off"
          />
        </Campo>

        <Campo
          etiqueta="Precio de venta (IVA incluido)"
          para={`${id}-precio`}
          ayuda="El precio del anaquel: ya lleva la ganancia."
        >
          <Entrada
            id={`${id}-precio`}
            value={precioTexto}
            onChange={(e) => setPrecioTexto(e.target.value)}
            inputMode="decimal"
            placeholder="12.50"
            autoComplete="off"
          />
        </Campo>
      </div>

      <div className="rounded-lg border border-[var(--linea)] bg-[var(--fondo)] px-3.5 py-3">
        {precio === null ? (
          <p className="text-sm text-[var(--suave)]">
            Escribe el precio y aquí aparece la ganancia.
          </p>
        ) : (
          <p className="text-sm">
            <span className="text-[var(--suave)]">Ganancia </span>
            <strong
              className={precio - costo < 0n ? 'text-[var(--mal)]' : 'text-[var(--ok)]'}
            >
              {pesos(precio - costo)}
            </strong>
            <span className="text-[var(--suave)]">
              {' '}
              · margen {margen === null ? '—' : `${margen.toFixed(1)} %`} sobre el precio
            </span>
          </p>
        )}
        {bajoCosto ? (
          <p className="mt-1.5 text-sm text-[var(--aviso)]">
            El precio queda por debajo del costo: la regla P1 no va a dejar guardarlo.
          </p>
        ) : null}
      </div>

      {editando ? (
        <p className="text-sm text-[var(--suave)]">
          Los códigos de barras no se cambian desde aquí: cada producto conserva los que
          ya tiene.
        </p>
      ) : (
        <fieldset className="rounded-lg border border-[var(--linea)] px-3.5 py-3">
          <legend className="px-1 text-xs font-medium text-[var(--suave)]">
            Código de barras
          </legend>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-modo`}
                checked={modo === 'interno'}
                onChange={() => setModo('interno')}
              />
              Generarlo (EAN-13 interno)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-modo`}
                checked={modo === 'manual'}
                onChange={() => setModo('manual')}
              />
              Ya tiene uno
            </label>
          </div>

          {modo === 'interno' ? (
            <p className="mt-2 text-xs text-[var(--suave)]">
              La app reserva el siguiente número del rango interno. Se muestra al guardar,
              listo para imprimir la etiqueta.
            </p>
          ) : (
            <div className="mt-3">
              <Campo
                etiqueta="Código"
                para={`${id}-codigo`}
                ayuda="13 dígitos = EAN-13 (se revisa el verificador). Otro texto = Code 128: mayúsculas, números y guiones."
              >
                <Entrada
                  id={`${id}-codigo`}
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="7501234567893"
                  autoComplete="off"
                  className="font-mono"
                />
              </Campo>
            </div>
          )}
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Campo etiqueta="Stock mínimo" para={`${id}-stock`} ayuda="Para el aviso de reposición.">
          <Entrada
            id={`${id}-stock`}
            value={stockTexto}
            onChange={(e) => setStockTexto(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
          />
        </Campo>

        <Campo etiqueta="Ubicación" para={`${id}-ubicacion`} ayuda="Estante, cajón, caja.">
          <Entrada
            id={`${id}-ubicacion`}
            value={ubicacion}
            onChange={(e) => setUbicacion(e.target.value)}
            placeholder="Estante 3"
            autoComplete="off"
          />
        </Campo>

        <Campo etiqueta="SKU" para={`${id}-sku`} ayuda="Opcional: el código del proveedor.">
          <Entrada
            id={`${id}-sku`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            autoComplete="off"
          />
        </Campo>
      </div>

      {errores.length > 0 ? (
        <ul className="list-inside list-disc rounded-md border border-[var(--aviso)] bg-[var(--aviso-fondo)] px-3 py-2 text-sm text-[var(--aviso)]">
          {errores.map((problema) => (
            <li key={problema}>{problema}</li>
          ))}
        </ul>
      ) : null}

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-md border border-[var(--mal)] bg-[var(--mal-fondo)] px-3 py-2 text-sm text-[var(--mal)]"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--linea)] pt-4">
        <Boton type="submit" disabled={guardando}>
          {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Guardar producto'}
        </Boton>
        <Boton variante="secundario" onClick={onCancelar} disabled={guardando}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}
