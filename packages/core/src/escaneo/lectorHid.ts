/**
 * El lector HID: el teclado que no es una persona.
 *
 * Un lector de códigos barato (USB o Bluetooth) no necesita driver ni SDK: el
 * sistema operativo lo ve **como un teclado**. Al leer, "teclea" los caracteres a
 * velocidad de máquina —típicamente menos de 30 ms entre uno y otro— y termina con
 * `Enter`. El sistema no sabe que es un lector; el único rastro es la velocidad.
 *
 * De ahí sale toda la idea, y también todo su riesgo: hay que distinguir una ráfaga
 * de máquina del dueño tecleando. La heurística es simple y explícita:
 *
 *   Una persona no sostiene menos de 50 ms por carácter. Una máquina, sí.
 *
 * El buffer se **corta** en cuanto un carácter llega más lento que el umbral. Por eso,
 * cuando se cierra con `Enter`, que el buffer tenga `largoMinimo` caracteres ya es la
 * prueba de que esos caracteres llegaron en ráfaga: si alguno hubiera sido lento, habría
 * empezado de cero. No hace falta medir la velocidad media.
 *
 * Este archivo es **puro**: recibe la tecla y el instante, y devuelve qué hacer. No toca
 * el DOM, no lee el reloj y no imprime nada. Así se puede probar en Node, que es donde
 * se prueban las cosas que fallan por un milisegundo. El adaptador al navegador está en
 * `apps/web/src/escaneo/hid.ts`.
 *
 * Lo que este lector **no** hace, a propósito:
 *
 *   - **No descarta códigos repetidos.** Escanear el mismo producto dos veces es una
 *     operación legítima (sumar dos piezas), y un antirrebote la rompería. El antirrebote
 *     de 800 ms del diseño es para la **cámara**, que ve el mismo código en muchos
 *     fotogramas seguidos; un lector láser dispara una vez por pulsación. Mezclar las dos
 *     cosas convertiría "escanear 3 veces = 3 piezas" en "1 pieza".
 *   - **No decide si consumir la tecla.** Devuelve si parece un escaneo; quien decide si
 *     hay que impedir que llegue al DOM es el adaptador, que es el único que sabe dónde
 *     está el foco.
 *   - **No valida el código.** Que sea un EAN-13 con dígito verificador correcto lo
 *     decide `validaEAN13()`; aquí sólo se separa "lo tecleó una máquina" de "lo tecleó
 *     una persona".
 */

/** Qué hacer con una tecla. */
export interface Lectura {
  /**
   * ¿Esta tecla forma parte de una ráfaga de máquina? Desde `largoMinimo` caracteres
   * significa que ya no es una persona: el adaptador puede impedir que llegue al DOM
   * (salvo que haya un campo de texto enfocado, que es asunto suyo).
   */
  readonly consumir: boolean;

  /** Sólo en la tecla que cierra el código: el código completo, ya limpio. */
  readonly codigo?: string;

  /** Milisegundos por carácter de la ráfaga. Sirve para ver la diferencia en el panel. */
  readonly msPorCaracter?: number;

  /** Sólo si se cerró una ráfaga y no se emitió: por qué. */
  readonly descartado?: 'corto' | 'largo' | 'no_digito';
}

export interface OpcionesLectorHid {
  /** Longitud mínima para considerar que hay un código. Por defecto 4. */
  readonly largoMinimo?: number;

  /** Tope del buffer: más que esto no es un código y se descarta. Por defecto 64. */
  readonly largoMaximo?: number;

  /** Intervalo máximo entre teclas para seguir considerándolo máquina. Por defecto 50 ms. */
  readonly intervaloMaximoMs?: number;

  /** Teclas que cierran un código. Por defecto sólo `Enter`. */
  readonly terminadores?: readonly string[];

  /**
   * ¿El código debe ser sólo dígitos? Por defecto `false`.
   *
   * `true` para un EAN-13, que siempre es numérico. `false` para una etiqueta de anaquel
   * en Code 128 (`ANAQ-A-3-12`), que lleva letras y guiones.
   */
  readonly soloDigitos?: boolean;
}

const LARGO_MINIMO_POR_DEFECTO = 4;
const LARGO_MAXIMO_POR_DEFECTO = 64;
const INTERVALO_MAXIMO_POR_DEFECTO = 50;
const TERMINADORES_POR_DEFECTO: readonly string[] = ['Enter'];

const SOLO_DIGITOS = /^[0-9]+$/;

/**
 * La máquina. Se le da de comer teclas y escupe lecturas.
 *
 * Es un objeto con estado y no una función porque el estado *es* el lector: el buffer
 * de lo tecleado y cuándo llegó lo último. Se crea uno por lector instalado.
 */
export class LectorHid {
  readonly #largoMinimo: number;
  readonly #largoMaximo: number;
  readonly #intervaloMaximoMs: number;
  readonly #terminadores: ReadonlySet<string>;
  readonly #soloDigitos: boolean;

  #buffer = '';
  #ultimaTeclaAt: number | null = null;
  #inicioAt = 0;

  constructor(opciones: OpcionesLectorHid = {}) {
    this.#largoMinimo = opciones.largoMinimo ?? LARGO_MINIMO_POR_DEFECTO;
    this.#largoMaximo = opciones.largoMaximo ?? LARGO_MAXIMO_POR_DEFECTO;
    this.#intervaloMaximoMs = opciones.intervaloMaximoMs ?? INTERVALO_MAXIMO_POR_DEFECTO;
    this.#terminadores = new Set(opciones.terminadores ?? TERMINADORES_POR_DEFECTO);
    this.#soloDigitos = opciones.soloDigitos ?? false;

    if (!Number.isInteger(this.#largoMinimo) || this.#largoMinimo < 1) {
      throw new RangeError(`largoMinimo tiene que ser un entero >= 1; llegó ${this.#largoMinimo}`);
    }
    if (this.#largoMaximo < this.#largoMinimo) {
      throw new RangeError(
        `largoMaximo (${this.#largoMaximo}) no puede ser menor que largoMinimo (${this.#largoMinimo})`,
      );
    }
    if (!(this.#intervaloMaximoMs > 0)) {
      throw new RangeError(
        `intervaloMaximoMs tiene que ser > 0; llegó ${this.#intervaloMaximoMs}`,
      );
    }
  }

  /** Lo que se lleva tecleado y todavía no se ha cerrado. Para el panel. */
  get enCurso(): string {
    return this.#buffer;
  }

  /** Olvida lo tecleado. Útil al desmontar o al cambiar de campo. */
  reiniciar(): void {
    this.#buffer = '';
    this.#ultimaTeclaAt = null;
    this.#inicioAt = 0;
  }

  /**
   * Una tecla, con el instante en que llegó (milisegundos monótonos).
   *
   * `ahora` se pasa y no se lee del reloj a propósito: así la prueba puede fabricar una
   * ráfaga de 13 caracteres sin esperar 130 ms de verdad, y sin depender de la máquina.
   */
  alimentar(tecla: string, ahora: number): Lectura {
    // Una tecla que cierra el código.
    if (this.#terminadores.has(tecla)) {
      return this.#cerrar(ahora);
    }

    // Ni modificadores (Shift, Control…), ni flechas, ni F1: no son caracteres del
    // código y **no lo cortan**. Cortarlos con un Shift en medio rompería un código en
    // mayúsculas, y no actualizar el reloj evita que el hueco del modificador cuente
    // como una pausa humana.
    if (tecla.length !== 1) {
      return { consumir: false };
    }

    if (this.#ultimaTeclaAt !== null && ahora - this.#ultimaTeclaAt > this.#intervaloMaximoMs) {
      // Llegó tarde: era una persona. Lo anterior no era el principio de este código.
      this.#buffer = '';
    }

    if (this.#buffer.length === 0) {
      this.#inicioAt = ahora;
    }
    this.#buffer += tecla;
    this.#ultimaTeclaAt = ahora;

    if (this.#buffer.length > this.#largoMaximo) {
      this.reiniciar();
      return { consumir: false, descartado: 'largo' };
    }

    return { consumir: this.#buffer.length >= this.#largoMinimo };
  }

  #cerrar(ahora: number): Lectura {
    const codigo = this.#buffer;
    const inicio = this.#inicioAt;

    // El buffer se vacía siempre, se emita o no: dejarlo vivo haría que el Enter de un
    // formulario y el primer carácter del siguiente escaneo se mezclaran.
    this.reiniciar();

    if (codigo.length < this.#largoMinimo) {
      return { consumir: false, descartado: 'corto' };
    }
    if (this.#soloDigitos && !SOLO_DIGITOS.test(codigo)) {
      return { consumir: false, descartado: 'no_digito' };
    }

    return {
      consumir: true,
      codigo,
      msPorCaracter: Math.round((ahora - inicio) / codigo.length),
    };
  }
}
