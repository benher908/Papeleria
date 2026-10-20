/**
 * El único punto donde el DOM a mano se encuentra con React.
 *
 * `app.ts` no sabe qué es un componente: pide montar la pantalla de productos y
 * recibe la raíz para poder desmontarla al cerrar sesión. Así el resto del archivo
 * sigue siendo el de siempre, y el día que toda la app sea React sólo cambia esto.
 */

import { createRoot, type Root } from 'react-dom/client';

import { AppProductos, type PropsApp } from './App';

export function montarProductos(nodo: HTMLElement, props: PropsApp): Root {
  const raiz = createRoot(nodo);
  raiz.render(<AppProductos {...props} />);
  return raiz;
}
