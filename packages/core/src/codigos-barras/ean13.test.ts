import { describe, expect, test } from 'vitest';
import {
  ErrorCodigo,
  construirCodigoUbicacion,
  construirEAN13Interno,
  digitoVerificadorEAN13,
  ean13Completo,
  esPrefijoInterno,
  normalizarCodigo,
  validaEAN13,
  validaCode128,
} from './ean13';

describe('dígito verificador EAN-13', () => {
  test('coincide con códigos reales de fabricante (verificados a mano)', () => {
    // 4006381333931 es un EAN-13 real: si el algoritmo estuviera mal, esto falla.
    expect(ean13Completo('400638133393')).toBe('4006381333931');
    expect(digitoVerificadorEAN13('400638133393')).toBe(1);
  });

  test('prefijo México (750)', () => {
    expect(ean13Completo('750123456789')).toBe('7501234567893');
  });

  test('prefijo interno 2 (circulación restringida de GS1)', () => {
    expect(ean13Completo('200000000001')).toBe('2000000000015');
    expect(ean13Completo('200000000000')).toBe('2000000000008');
  });

  test('valida códigos correctos y rechaza dígitos alterados', () => {
    expect(validaEAN13('4006381333931')).toBe(true);
    expect(validaEAN13('4006381333930')).toBe(false); // último dígito cambiado
    expect(validaEAN13('400638133399')).toBe(false); // longitud incorrecta
    expect(validaEAN13('400638133393X')).toBe(false); // no numérico
  });

  test('valida todos los dígitos verificadores posibles (0–9)', () => {
    // 10 códigos base que cubren los 10 dígitos verificadores.
    for (let dv = 0; dv < 10; dv++) {
      const base = '20000000000' + dv; // 12 dígitos con distintos finales
      const completo = ean13Completo(base);
      expect(validaEAN13(completo)).toBe(true);
      expect(completo).toHaveLength(13);
    }
  });

  test('lanza error con entradas mal formadas', () => {
    expect(() => digitoVerificadorEAN13('123')).toThrow(ErrorCodigo);
    expect(() => digitoVerificadorEAN13('12345678901X')).toThrow(ErrorCodigo);
  });
});

describe('generador de códigos internos', () => {
  test('siempre produce un EAN-13 válido con prefijo interno', () => {
    for (const n of [0, 1, 2, 9, 10, 99, 100, 12_345, 999_999, 5_000_000_000]) {
      const codigo = construirEAN13Interno(n);
      expect(codigo).toHaveLength(13);
      expect(validaEAN13(codigo)).toBe(true);
      expect(esPrefijoInterno(codigo)).toBe(true);
    }
  });

  test('los primeros 1000 códigos son únicos (no se repiten)', () => {
    const vistos = new Set<string>();
    for (let n = 0; n < 1000; n++) vistos.add(construirEAN13Interno(n));
    expect(vistos.size).toBe(1000);
  });

  test('nunca colisiona con el prefijo de fabricante de México (750)', () => {
    for (let n = 0; n < 500; n++) {
      expect(construirEAN13Interno(n).startsWith('750')).toBe(false);
    }
  });

  test('secuencia 1 da exactamente el código esperado', () => {
    expect(construirEAN13Interno(1)).toBe('2000000000015');
  });

  test('rechaza secuenciales fuera de rango', () => {
    expect(() => construirEAN13Interno(-1)).toThrow(ErrorCodigo);
    expect(() => construirEAN13Interno(100_000_000_000n)).toThrow(ErrorCodigo);
    expect(() => construirEAN13Interno(1, '27')).toThrow(ErrorCodigo);
  });
});

describe('normalización y Code 128', () => {
  test('normaliza a una sola forma canónica (mayúsculas, sin espacios)', () => {
    expect(normalizarCodigo('  pap-lap-mir-2  ')).toBe('PAP-LAP-MIR-2');
    expect(normalizarCodigo('AnaQ-A-3-12')).toBe('ANAQ-A-3-12');
    expect(normalizarCodigo('anaq a 3 12')).toBe('ANAQA312');
    // El mismo código escrito de tres formas distintas da SIEMPRE el mismo valor.
    expect(normalizarCodigo(' pap-lap-mir-2 ')).toBe(normalizarCodigo('PAP-LAP-MIR-2'));
  });

  test('acepta códigos propios razonables', () => {
    expect(validaCode128('PAP-LAP-MIR-2')).toBe(true);
    expect(validaCode128('ANAQ-A-3-12')).toBe(true);
    expect(validaCode128('LIB.2026/001')).toBe(true);
  });

  test('rechaza códigos que no se deben usar', () => {
    expect(validaCode128('a')).toBe(false); // demasiado corto
    expect(validaCode128('-EMPIEZA-MAL')).toBe(false); // debe empezar alfanumérico
    expect(validaCode128('###')).toBe(false); // sin caracteres útiles
    expect(validaCode128('x'.repeat(30))).toBe(false); // demasiado largo para una etiqueta chica
    // ⚠️ Los espacios NO se rechazan: se normalizan. 'CON ESPACIOS' se guarda
    //    como 'CONESPACIOS'. Lo importante es que solo exista UNA forma canónica.
    expect(validaCode128('CON ESPACIOS')).toBe(true);
    expect(normalizarCodigo('CON ESPACIOS')).toBe('CONESPACIOS');
  });

  test('construye códigos de ubicación', () => {
    expect(construirCodigoUbicacion('a-3-12')).toBe('ANAQ-A-3-12');
    expect(construirCodigoUbicacion('a 3 12')).toBe('ANAQ-A-3-12');
    expect(construirCodigoUbicacion(' A-3-12 ')).toBe('ANAQ-A-3-12');
    expect(construirCodigoUbicacion('R2-E4', 'BOD')).toBe('BOD-R2-E4');
    expect(() => construirCodigoUbicacion('   ')).toThrow(ErrorCodigo);
    expect(() => construirCodigoUbicacion('###')).toThrow(ErrorCodigo);
  });
});
