import { describe, expect, test } from 'vitest';

import { analizarCsv, importeAMinor, parsearCsv } from './csv';

describe('lector de CSV', () => {
  test('acepta punto y coma y comillas con comas adentro', () => {
    const filas = parsearCsv(
      'nombre;precio;costo\n"Cuaderno, profesional";25,50;15,00\nLápiz;7;4\n',
    );

    expect(filas).toHaveLength(3);
    expect(filas[1]?.celdas).toEqual(['Cuaderno, profesional', '25,50', '15,00']);
  });

  test('respeta saltos de línea dentro de comillas y conserva la línea física', () => {
    const filas = parsearCsv('nombre,precio\n"Cuaderno\nprofesional",25\nLápiz,7\n');

    expect(filas).toHaveLength(3);
    expect(filas[1]?.celdas[0]).toBe('Cuaderno\nprofesional');
    expect(filas[2]?.linea).toBe(4);
  });

  test('quita el BOM que Excel pone al guardar', () => {
    const filas = parsearCsv('\uFEFFnombre,precio\nLápiz,7\n');
    expect(filas[0]?.celdas[0]).toBe('nombre');
  });
});

describe('importes del CSV', () => {
  const casos: ReadonlyArray<readonly [string, bigint | null]> = [
    ['12.50', 1250n],
    ['$12.50', 1250n],
    ['12,50', 1250n],
    ['1,234.50', 123450n],
    ['1.234,50', 123450n],
    ['12', 1200n],
    ['12.5', 1250n],
    ['0.005', 1n],
    ['', null],
    ['abc', null],
    ['-3.00', null],
  ];

  test.each(casos)('%s → %s', (texto, esperado) => {
    expect(importeAMinor(texto)).toBe(esperado);
  });
});

describe('análisis del catálogo', () => {
  test('convierte encabezados y filas a datos listos para la base', () => {
    const analisis = analizarCsv(
      [
        'Producto;Precio;Costo;Código;Categoría;Unidad;SKU;Stock mínimo;Ubicación',
        'Cuaderno profesional;25,50;15,00;;Escolar;pieza;CUA-PROF;5;A-3-12',
        'Lápiz Mirado;7.00;4.00;7501234567893;Escritura;pieza;LAP-MIR;12;A-2-01',
      ].join('\n'),
    );

    expect(analisis.problemas).toEqual([]);
    expect(analisis.filas).toHaveLength(2);
    expect(analisis.filas[0]).toMatchObject({
      nombre: 'Cuaderno profesional',
      precioMinor: 2550n,
      costoMinor: 1500n,
      codigo: null,
      categoria: 'Escolar',
      unidad: 'pieza',
      sku: 'CUA-PROF',
      stockMinimo: 5,
      ubicacion: 'A-3-12',
    });
    expect(analisis.filas[1]?.codigo).toBe('7501234567893');
  });

  test('reporta un EAN-13 con verificador malo', () => {
    const analisis = analizarCsv('nombre,precio,codigo\nCuaderno,25,7501234567891\n');

    expect(analisis.filas).toHaveLength(0);
    expect(analisis.problemas[0]?.mensaje).toContain('dígito verificador');
  });

  test('reporta un código repetido con la línea donde apareció', () => {
    const analisis = analizarCsv(
      'nombre,precio,codigo\nCuaderno,25,2000000000015\nLápiz,7,2000000000015\n',
    );

    expect(analisis.filas).toHaveLength(1);
    expect(analisis.problemas.some((problema) => problema.mensaje.includes('línea 2'))).toBe(
      true,
    );
  });

  test('no importa una fila sin precio válido', () => {
    const analisis = analizarCsv('nombre,precio\nCuaderno,abc\nLápiz,7\n');

    expect(analisis.filas).toHaveLength(1);
    expect(analisis.problemas[0]?.linea).toBe(2);
    expect(analisis.problemas[0]?.mensaje).toContain('precio');
  });

  test('exige las columnas nombre y precio', () => {
    const analisis = analizarCsv('producto,costo\nCuaderno,15\n');

    expect(analisis.filas).toHaveLength(0);
    expect(analisis.problemas[0]?.mensaje).toContain('precio');
  });
});
