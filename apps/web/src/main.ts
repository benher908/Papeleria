import { montarApp } from './app';
import './estilos.css';

const raiz = document.querySelector<HTMLDivElement>('#app');
if (!raiz) {
  throw new Error('Falta el contenedor #app en index.html');
}

void montarApp(raiz);
