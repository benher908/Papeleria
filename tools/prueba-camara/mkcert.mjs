/**
 * LOCALIZAR Y EJECUTAR mkcert — en un solo lugar.
 *
 * Existe por una razón concreta y muy común: `winget install` (y choco, y scoop)
 * agregan su carpeta al PATH, pero **las terminales que ya estaban abiertas no se
 * enteran**. Actualizan una variable de entorno que los procesos vivos tienen
 * copiada desde que arrancaron.
 *
 * El resultado es desconcertante: instalas mkcert, el instalador dice que todo
 * bien, y el comando sigue diciendo «no se encontró mkcert». La solución típica es
 * «cierra y abre la terminal», pero eso es pedirle al usuario que arregle un
 * detalle de implementación. Aquí se busca el ejecutable en las carpetas donde de
 * verdad lo deja cada instalador, y el problema desaparece.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ES_WINDOWS = process.platform === 'win32';

/** undefined = aún no se buscó · null = no está · string = ruta al ejecutable */
let memorizado;

/** Ruta al ejecutable de mkcert, o null. Se busca una sola vez por proceso. */
export function rutaDeMkcert() {
  if (memorizado !== undefined) return memorizado;

  // 1) Como lo resolvería la terminal. Es el caso normal y el preferido: si el
  //    PATH está al día, no hay nada que adivinar.
  memorizado = buscarEnPath() ?? (ES_WINDOWS ? buscarEnWindows() : null);
  return memorizado;
}

/** ¿mkcert está en el PATH, o solo lo encontramos por ruta absoluta? */
export function estaEnElPath() {
  return buscarEnPath() !== null;
}

function buscarEnPath() {
  try {
    execFileSync('mkcert', ['-version'], { encoding: 'utf8', stdio: 'pipe' });
    return 'mkcert';
  } catch {
    return null;
  }
}

/**
 * Rutas donde dejan mkcert los instaladores de Windows. El orden importa poco,
 * pero se revisa primero la carpeta exacta del paquete para no recorrer árboles
 * enteros sin necesidad.
 */
function buscarEnWindows() {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const carpetasDirectas = [
    join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin'),
    join(process.env.USERPROFILE ?? '', 'scoop', 'shims'),
    'C:\\Program Files\\mkcert',
  ];

  for (const carpeta of carpetasDirectas) {
    if (!carpeta) continue;
    const ejecutable = join(carpeta, 'mkcert.exe');
    if (existsSync(ejecutable)) return ejecutable;
  }

  // winget guarda cada paquete en una carpeta con su nombre y un hash detrás:
  //   Packages\FiloSottile.mkcert_Microsoft.Winget.Source_8wekyb3d8bbwe\mkcert.exe
  // El hash cambia, así que se busca la carpeta por nombre en lugar de fijarla.
  const paquetes = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(paquetes)) {
    try {
      for (const entrada of readdirSync(paquetes)) {
        if (!/mkcert/i.test(entrada)) continue;
        const ejecutable = join(paquetes, entrada, 'mkcert.exe');
        if (existsSync(ejecutable)) return ejecutable;
      }
    } catch {
      /* sin permiso para listar: se trata como no encontrado */
    }
  }

  return null;
}

/**
 * Ejecuta mkcert con los argumentos dados.
 *
 * `shell: false` a propósito: así los argumentos llegan literalmente, sin
 * comillas ni escapes que mkcert interpretaría como parte de la ruta. Importa
 * porque las carpetas de OneDrive llevan espacios.
 *
 * Lanza un error con `sinMkcert === true` si no está instalado, para que quien
 * llama pueda distinguir «no está instalado» de «lo ejecuté y falló».
 */
export function ejecutarMkcert(argumentos, { silencioso = false } = {}) {
  const ejecutable = rutaDeMkcert();

  if (!ejecutable) {
    const error = new Error('No se encontró mkcert');
    error.sinMkcert = true;
    throw error;
  }

  return execFileSync(ejecutable, argumentos, {
    encoding: 'utf8',
    stdio: silencioso ? 'pipe' : 'inherit',
  });
}
