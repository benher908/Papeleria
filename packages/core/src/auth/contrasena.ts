/**
 * LA REGLA DE LA CONTRASEÑA — lo que se exige, y sobre todo lo que NO se exige.
 *
 * `docs/07 §1.2` es explícito: mínimo 12 caracteres y **nada** de símbolos obligatorios.
 * Las reglas de composición forzada ("una mayúscula, un número, un símbolo") producen
 * exactamente lo que se quiere evitar: `Papeleria1!`, que es corta, predecible y está en
 * todas las listas. Un mínimo de largo alto hace más trabajo real que cualquier exigencia
 * de caracteres raros.
 *
 * Aquí sólo viven las comprobaciones que se pueden hacer sin red y sin tabla de
 * contraseñas filtradas: largo, repetición, escaleras y paseos por el teclado. Un
 * diccionario de las 10 000 peores contraseñas sería mejor, pero sería un archivo de
 * datos más grande que el resto de este módulo, y su sitio natural es el servidor.
 */

export const LARGO_MINIMO_CONTRASENA = 12;

/**
 * Revisa una contraseña y devuelve la lista de problemas. Lista vacía = aceptable.
 *
 * `prohibidas` son las palabras que no pueden ser la contraseña entera (el nombre de
 * usuario, el nombre de la tienda). No se prohíbe que las *contengan*: `soy-duena-de-
 * papeleria-2026` es una contraseña buena y contiene 'papeleria'. Prohibirlas como
 * subcadena empujaría a la gente a contraseñas peores para cumplir la regla.
 */
export function revisarContrasena(
  contrasena: string,
  prohibidas: readonly string[] = [],
): readonly string[] {
  const problemas: string[] = [];

  if (contrasena.length < LARGO_MINIMO_CONTRASENA) {
    problemas.push(
      `Necesita al menos ${LARGO_MINIMO_CONTRASENA} caracteres (tiene ${contrasena.length}).`,
    );
  }

  if (contrasena.length > 0 && esUnSoloCaracterRepetido(contrasena)) {
    problemas.push('Es el mismo carácter repetido.');
  }

  if (esUnaEscalera(contrasena)) {
    problemas.push('Es una escalera (1234…, abcd…). Se adivina al primer intento.');
  }

  if (esUnPaseoPorElTeclado(contrasena)) {
    problemas.push('Es un paseo por el teclado (qwerty…). Se adivina al primer intento.');
  }

  const normalizada = contrasena.trim().toLowerCase();
  for (const palabra of prohibidas) {
    if (palabra.trim().length > 0 && normalizada === palabra.trim().toLowerCase()) {
      problemas.push(`No puede ser «${palabra}» y nada más.`);
    }
  }

  return problemas;
}

function esUnSoloCaracterRepetido(texto: string): boolean {
  const primero = texto[0];
  for (const caracter of texto) {
    if (caracter !== primero) return false;
  }
  return true;
}

/**
 * ¿Es una escalera: `abcdefghijkl`, `zyxwvutsrqpo`, `123456789012`?
 *
 * Los dígitos van en módulo 10 y las letras en módulo 26, y eso no es un adorno: sin el
 * módulo, `123456789012` **no** sería una escalera, porque al llegar a `9` el carácter
 * vuelve a `0` y el salto cambia de signo. Y `123456789012` es justo la contraseña que
 * hay que rechazar. Las letras sí son consecutivas en el alfabeto, así que ahí el módulo
 * sólo sirve para el caso `…xyzabc…`.
 *
 * Se comparan códigos de carácter y no posiciones en un alfabeto a propósito: así entran
 * también cosas como `ABCDEFGHIJKL` sin escribir una tabla de alfabetos.
 */
function esUnaEscalera(texto: string): boolean {
  if (texto.length < 4) return false;

  const plano = texto.toLowerCase();
  const sonDigitos = /^[0-9]+$/.test(plano);
  const sonLetras = /^[a-z]+$/.test(plano);

  // Los dígitos dan la vuelta al llegar a 9 y las letras al llegar a z. Los demás
  // caracteres se comparan por código, tal cual, sin dar la vuelta.
  const base = sonDigitos ? 10 : sonLetras ? 26 : 0;
  const origen = sonDigitos ? '0'.charCodeAt(0) : sonLetras ? 'a'.charCodeAt(0) : 0;

  let salto: number | null = null;
  for (let i = 1; i < plano.length; i++) {
    const anterior = plano.charCodeAt(i - 1) - origen;
    const actual = plano.charCodeAt(i) - origen;
    const crudo = actual - anterior;
    const diferencia = base === 0 ? crudo : (((crudo % base) + base) % base);

    if (salto === null) {
      salto = diferencia;
    } else if (salto !== diferencia) {
      return false;
    }
  }

  if (salto === null) return false;
  if (salto === 1 || salto === -1) return true;
  // Hacia atrás dando la vuelta: 'zyx…' es 25 en módulo 26 y '987…' es 9 en módulo 10.
  return base > 0 && salto === base - 1;
}

/** Las tres filas del teclado QWERTY, de izquierda a derecha. */
const FILAS_DEL_TECLADO = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const;

/**
 * ¿Contiene una fila entera del teclado?
 *
 * Se busca la fila completa y no dos o tres letras: `asdf` aparece en contraseñas
 * legítimas, `asdfghjkl` no. Así la comprobación no empuja a nadie a peor.
 */
function esUnPaseoPorElTeclado(texto: string): boolean {
  const plano = texto.toLowerCase();
  return FILAS_DEL_TECLADO.some((fila) => plano.includes(fila));
}

/**
 * Cuánto hacer esperar antes de contestar a un intento fallido, según cuántos van.
 *
 * No es la defensa de verdad — quien tenga el PC delante puede copiar la base y probar
 * contraseñas a su ritmo, sin pasar por esta pantalla. Lo que hace es quitarle sentido a
 * probar a mano veinte contraseñas mientras nadie mira. La defensa real es el largo
 * mínimo de arriba y el tope absoluto de la sesión.
 *
 * Crece al doble y se queda en 30 s: suficiente para que sea aburrido, y no tanto como
 * para que el dueño que se equivocó tres veces se quede fuera de su propia tienda.
 */
export function retrasoTrasFallos(intentos: number): number {
  if (intentos < 3) return 0;
  return Math.min(2000 * 2 ** (intentos - 3), 30_000);
}
