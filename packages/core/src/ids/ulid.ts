/**
 * ULID — el identificador de los eventos (docs/01 §4, docs/08 §2).
 *
 * Por qué no un UUID cualquiera ni un consecutivo:
 *
 *   · **UUID v4** sería único, pero no ordenable: los eventos quedarían en orden
 *     aleatorio y `event_id` no diría nada sobre cuándo ocurrió.
 *   · **Un consecutivo** requiere coordinación entre dispositivos. Es justo lo que
 *     no se puede tener sin internet.
 *   · **ULID** es único sin coordinarse **y** ordenable por tiempo: 48 bits de
 *     milisegundos + 80 bits de azar, en 26 caracteres. El orden lexicográfico de
 *     dos ULID coincide con el orden temporal de su creación.
 *
 * Esas dos propiedades son las que hacen la idempotencia gratis en el servidor: la
 * misma venta reintentada trae el **mismo** `event_id` (lo generó el dispositivo una
 * sola vez), así que `INSERT ... ON CONFLICT (event_id) DO NOTHING` la aplica una vez.
 *
 * El azar entra inyectado para poder probar el orden y la unicidad sin depender del
 * reloj ni del generador real.
 */

import { bytesAleatorios } from './azar';

/** Crockford base32: 0-9 y las letras, sin `I`, `L`, `O` ni `U` (se confunden con 1, 1, 0). */
export const ALFABETO_ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 caracteres de tiempo + 16 de azar. */
export const LARGO_ULID = 26;
const LARGO_TIEMPO = 10;
const LARGO_AZAR = 16;

/** 48 bits de milisegundos: alcanza hasta el año 10889. */
const MAXIMO_TIEMPO = 2 ** 48 - 1;

export class ErrorULID extends Error {}

/**
 * Un ULID nuevo. `ahora` es el reloj de pared en milisegundos y `azar` son los 10
 * bytes aleatorios; ambos se inyectan en las pruebas.
 */
export function ulid(ahora: number = Date.now(), azar: Uint8Array = bytesAleatorios(10)): string {
  if (!Number.isInteger(ahora) || ahora < 0 || ahora > MAXIMO_TIEMPO) {
    throw new ErrorULID(`Instante fuera de rango para un ULID: ${ahora}`);
  }
  if (azar.length !== 10) {
    throw new ErrorULID(`El azar de un ULID son 10 bytes exactos (recibidos: ${azar.length})`);
  }
  return codificarTiempo(ahora) + codificarAzar(azar);
}

/**
 * Los 48 bits del instante en 10 caracteres base32 (10 × 5 = 50 bits, así que el
 * primero sólo llega a 3). Se rellenan por la izquierda para que el largo sea
 * siempre 10: sin eso, el orden lexicográfico dejaría de coincidir con el temporal.
 */
function codificarTiempo(ahora: number): string {
  return codificarBase32(BigInt(ahora), LARGO_TIEMPO);
}

/** Los 80 bits de azar en 16 caracteres base32 (16 × 5 = 80 bits exactos). */
function codificarAzar(azar: Uint8Array): string {
  let salida = '';
  let acumulador = 0;
  let bits = 0;

  for (const byte of azar) {
    acumulador = (acumulador << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      salida += digitoBase32((acumulador >>> bits) & 31);
    }
  }

  if (salida.length !== LARGO_AZAR) {
    // 80 bits son exactamente 16 grupos de 5: si no cuadra, hay un error de cálculo
    // aquí dentro y conviene saberlo ahora, no con identificadores mal formados.
    throw new ErrorULID(`El azar debería dar ${LARGO_AZAR} caracteres y dio ${salida.length}`);
  }
  return salida;
}

function codificarBase32(valor: bigint, largo: number): string {
  const caracteres: string[] = new Array<string>(largo);
  let resto = valor;
  for (let i = largo - 1; i >= 0; i--) {
    caracteres[i] = digitoBase32(Number(resto % 32n));
    resto /= 32n;
  }
  return caracteres.join('');
}

function digitoBase32(indice: number): string {
  const caracter = ALFABETO_ULID[indice];
  if (caracter === undefined) throw new ErrorULID(`Índice fuera del alfabeto base32: ${indice}`);
  return caracter;
}

/**
 * El instante que un ULID codifica. Sirve para ordenar sin base de datos y para
 * depurar; para decidir cualquier cosa del negocio se usa el ledger, no esto.
 */
export function instanteDeULID(id: string): number {
  if (id.length !== LARGO_ULID) {
    throw new ErrorULID(`Un ULID tiene ${LARGO_ULID} caracteres (recibidos: ${id.length})`);
  }

  // Se valida el identificador ENTERO, no sólo la parte del tiempo: un carácter
  // inválido en el azar significa que esto no es un ULID, y aceptarlo a medias
  // devolvería un instante de algo que no lo es.
  for (const caracter of id) {
    if (!ALFABETO_ULID.includes(caracter)) {
      throw new ErrorULID(`Carácter fuera del alfabeto base32: "${caracter}"`);
    }
  }

  let valor = 0;
  for (const caracter of id.slice(0, LARGO_TIEMPO)) {
    valor = valor * 32 + ALFABETO_ULID.indexOf(caracter);
  }
  return valor;
}
