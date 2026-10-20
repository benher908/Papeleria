import { montarApp } from './app';
import { registrarServiceWorker } from './pwa';
import './estilos.css';

const raiz = document.querySelector<HTMLDivElement>('#app');
if (!raiz) {
  throw new Error('Falta el contenedor #app en index.html');
}

registrarServiceWorker();
void montarApp(raiz);
